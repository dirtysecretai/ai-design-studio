import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import prisma from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import { uploadToR2 } from '@/lib/r2'
import { ffmpegAvailable, gifToMp4, extractThumbnail, probeDuration } from '@/lib/video-clip'

// POST /api/admin/dataset/convert-gif { imageIds: number[] }
//
// Converts GIF dataset rows into MP4 training clips. Each GIF gets a NEW
// sibling GeneratedImage row (the original is untouched) carrying the same
// prompt/caption/tags/sections/training flag, with videoMetadata linking back
// to the source. Bucket memberships are mirrored so the clip appears wherever
// the GIF did. Trainers (fal wan-22 / ltx2) only accept real video files, so
// GIFs must pass through here before joining a video training set.

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_PER_CALL = 10
const MAX_GIF_BYTES = 50 * 1024 * 1024

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ffmpegAvailable()) return NextResponse.json({ error: 'ffmpeg unavailable' }, { status: 500 })

  const body = await req.json().catch(() => ({})) as { imageIds?: unknown }
  const ids = Array.isArray(body.imageIds)
    ? body.imageIds.filter((n): n is number => Number.isInteger(n)).slice(0, MAX_PER_CALL)
    : []
  if (ids.length === 0) return NextResponse.json({ error: 'No imageIds' }, { status: 400 })

  const rows = await prisma.generatedImage.findMany({
    where: { id: { in: ids }, isDeleted: false },
    select: {
      id: true, userId: true, prompt: true, imageUrl: true, ticketCost: true,
      adminCaption: true, adminTags: true, captionSections: true,
      markedForTraining: true, referenceImageUrls: true,
      bucketImages: { select: { bucketId: true } },
    },
  })

  const results: { id: number; ok: boolean; clipId?: number; clipUrl?: string; error?: string }[] = []

  for (const row of rows) {
    if (!/\.gif(\?|#|$)/i.test(row.imageUrl)) {
      results.push({ id: row.id, ok: false, error: 'Not a GIF' })
      continue
    }
    // Idempotency: if a clip row already points back at this GIF, return it
    const existing = await prisma.generatedImage.findFirst({
      where: { isDeleted: false, videoMetadata: { path: ['sourceImageId'], equals: row.id } },
      select: { id: true, imageUrl: true },
    }).catch(() => null)
    if (existing) {
      results.push({ id: row.id, ok: true, clipId: existing.id, clipUrl: existing.imageUrl })
      continue
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'gifclip-'))
    try {
      const srcRes = await fetch(row.imageUrl)
      if (!srcRes.ok) throw new Error(`source fetch ${srcRes.status}`)
      const gifBytes = Buffer.from(await srcRes.arrayBuffer())
      if (gifBytes.length > MAX_GIF_BYTES) throw new Error('GIF larger than 50MB')
      const inFile = path.join(dir, 'in.gif')
      const outFile = path.join(dir, 'out.mp4')
      const thumbFile = path.join(dir, 'thumb.jpg')
      await writeFile(inFile, gifBytes)

      await gifToMp4(inFile, outFile)
      await extractThumbnail(outFile, thumbFile)
      const duration = await probeDuration(outFile)

      const uid = randomUUID().slice(0, 8)
      const clipUrl = await uploadToR2(`training/clips/${row.id}-${uid}.mp4`, await readFile(outFile), 'video/mp4')
      const thumbUrl = await uploadToR2(`training/clips/${row.id}-${uid}-thumb.jpg`, await readFile(thumbFile), 'image/jpeg')

      const clip = await prisma.generatedImage.create({
        data: {
          userId:             row.userId,
          prompt:             row.prompt,
          imageUrl:           clipUrl,
          thumbnailUrl:       thumbUrl,
          model:              'clip-from-gif',
          ticketCost:         0,
          adminCaption:       row.adminCaption,
          adminTags:          row.adminTags,
          captionSections:    row.captionSections ?? undefined,
          markedForTraining:  row.markedForTraining,
          referenceImageUrls: row.referenceImageUrls,
          expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          videoMetadata: {
            isVideo: true,
            thumbnailUrl: thumbUrl,
            sourceImageId: row.id,
            duration: duration ?? undefined,
          },
        },
        select: { id: true },
      })

      if (row.bucketImages.length > 0) {
        await prisma.datasetBucketImage.createMany({
          data: row.bucketImages.map(b => ({ bucketId: b.bucketId, imageId: clip.id })),
          skipDuplicates: true,
        })
      }

      results.push({ id: row.id, ok: true, clipId: clip.id, clipUrl })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'conversion failed'
      console.error(`convert-gif #${row.id}:`, e)
      results.push({ id: row.id, ok: false, error: msg })
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const missing = ids.filter(id => !rows.some(r => r.id === id))
  for (const id of missing) results.push({ id, ok: false, error: 'Not found' })

  return NextResponse.json({ success: true, results })
}
