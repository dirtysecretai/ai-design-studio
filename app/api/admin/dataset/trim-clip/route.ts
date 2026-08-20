import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import prisma from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import { uploadToR2 } from '@/lib/r2'
import { extractThumbnail, probeDuration } from '@/lib/video-clip'

// POST /api/admin/dataset/trim-clip { imageId, startSec, endSec }
//
// Trims a video dataset row (training clip) to the given window and updates
// the row in place: new R2 file under training/clips/, refreshed thumbnail,
// updated videoMetadata.duration. Same stream-copy + keyframe-tighten +
// re-encode-fallback strategy as the user-facing reference trim route.

export const runtime = 'nodejs'
export const maxDuration = 300

const exec = promisify(execFile)
const MAX_CLIP_SEC = 120

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ffmpegPath) return NextResponse.json({ error: 'ffmpeg unavailable' }, { status: 500 })

  const body = await req.json().catch(() => ({})) as { imageId?: unknown; startSec?: unknown; endSec?: unknown }
  const imageId = Number(body.imageId)
  const startSec = Number(body.startSec)
  const endSec = Number(body.endSec)
  if (!Number.isInteger(imageId)) return NextResponse.json({ error: 'Invalid imageId' }, { status: 400 })
  if (!isFinite(startSec) || !isFinite(endSec) || startSec < 0 || endSec <= startSec || endSec - startSec > MAX_CLIP_SEC) {
    return NextResponse.json({ error: 'Invalid trim range' }, { status: 400 })
  }

  const row = await prisma.generatedImage.findFirst({
    where: { id: imageId, isDeleted: false },
    select: { id: true, imageUrl: true, videoMetadata: true },
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Only OUR hosted media — never proxy arbitrary URLs
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (!publicBase || !row.imageUrl.startsWith(`${publicBase}/`)) {
    return NextResponse.json({ error: 'Row media is not R2-hosted' }, { status: 400 })
  }
  if (!/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(row.imageUrl)) {
    return NextResponse.json({ error: 'Row is not a video' }, { status: 400 })
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'cliptrim-'))
  try {
    const srcRes = await fetch(row.imageUrl)
    if (!srcRes.ok) return NextResponse.json({ error: `Source fetch failed (${srcRes.status})` }, { status: 502 })
    const srcBytes = Buffer.from(await srcRes.arrayBuffer())
    if (srcBytes.length > 200 * 1024 * 1024) return NextResponse.json({ error: 'Source too large' }, { status: 413 })
    const ext = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.exec(row.imageUrl)?.[1]?.toLowerCase() ?? 'mp4'
    const inFile = path.join(dir, `in.${ext}`)
    const outFile = path.join(dir, 'out.mp4')
    await writeFile(inFile, srcBytes)

    const wanted = endSec - startSec
    const cut = async (lenSec: number) => {
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y',
        '-ss', startSec.toFixed(3),
        '-i', inFile,
        '-t', lenSec.toFixed(3),
        '-c', 'copy',
        '-movflags', '+faststart',
        outFile,
      ], { timeout: 120_000 })
    }
    let precise = false
    try {
      await cut(wanted)
      const outDur = await probeDuration(outFile)
      // Keyframe snap overshoot beyond half a second → precise re-encode
      if (outDur !== null && outDur > wanted + 0.5) precise = true
    } catch {
      precise = true // stream copy can fail outright on some containers
    }
    if (precise) {
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y',
        '-ss', startSec.toFixed(3),
        '-i', inFile,
        '-t', wanted.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
        outFile,
      ], { timeout: 240_000 })
    }

    const thumbFile = path.join(dir, 'thumb.jpg')
    await extractThumbnail(outFile, thumbFile)
    const duration = await probeDuration(outFile)

    const uid = randomUUID().slice(0, 8)
    const clipUrl = await uploadToR2(`training/clips/${imageId}-trim-${uid}.mp4`, await readFile(outFile), 'video/mp4')
    const thumbUrl = await uploadToR2(`training/clips/${imageId}-trim-${uid}-thumb.jpg`, await readFile(thumbFile), 'image/jpeg')

    const oldMeta = (row.videoMetadata && typeof row.videoMetadata === 'object' ? row.videoMetadata : {}) as Record<string, unknown>
    await prisma.generatedImage.update({
      where: { id: imageId },
      data: {
        imageUrl: clipUrl,
        thumbnailUrl: thumbUrl,
        videoMetadata: { ...oldMeta, isVideo: true, thumbnailUrl: thumbUrl, duration: duration ?? undefined },
      },
    })

    return NextResponse.json({ success: true, url: clipUrl, thumbnailUrl: thumbUrl, duration })
  } catch (err) {
    console.error('trim-clip error:', err)
    return NextResponse.json({ error: 'Trim failed' }, { status: 500 })
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
