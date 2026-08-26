import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadToR2 } from '@/lib/r2'
import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { probeDuration } from '@/lib/video-clip'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

export const maxDuration = 60
const execP = promisify(execFile)

// GET /api/admin/dataset/thumb/[id]
// Serves a 400px webp thumbnail for a dataset image.
// Public (no auth) — dataset images are on a public R2 bucket anyway.
// 7-day immutable browser cache so grid loads are instant on repeat visits.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const imageId = parseInt(id)
  if (isNaN(imageId)) return new NextResponse('Invalid id', { status: 400 })

  const image = await prisma.generatedImage.findFirst({
    where: { id: imageId, isDeleted: false },
    select: { imageUrl: true, videoMetadata: true, thumbnailUrl: true },
  })

  if (!image) return new NextResponse('Not found', { status: 404 })

  // A stored R2 thumb already exists → redirect straight to it. The browser
  // caches the redirect and fetches from R2/CDN — zero server work.
  if (image.thumbnailUrl && /^https?:\/\//.test(image.thumbnailUrl)) {
    return NextResponse.redirect(image.thumbnailUrl, {
      status: 302,
      headers: { 'Cache-Control': 'public, max-age=604800' },
    })
  }

  // Videos: serve the recorded poster thumbnail when one exists; when none
  // does (Slicing Studio uploads arrive posterless), GENERATE one — ffmpeg
  // reads the R2 URL directly with a fast seek, so no full download. The
  // write-behind below persists it, so this cost is paid once per video.
  let srcUrl = image.imageUrl
  if (/\.(mp4|webm|mov|avi|mkv)$/i.test(srcUrl)) {
    const poster = (image.videoMetadata as Record<string, unknown> | null)?.thumbnailUrl
    if (typeof poster === 'string' && /^https?:\/\//.test(poster)) {
      srcUrl = poster
    } else {
      let dir: string | null = null
      try {
        const dur = await probeDuration(srcUrl)
        const at = dur && dur > 0.4 ? dur / 2 : 0
        dir = await mkdtemp(path.join(tmpdir(), 'ds-thumb-'))
        const outJpg = path.join(dir, 'poster.jpg')
        await execP(ffmpegPath as string, [
          '-hide_banner', '-y',
          '-ss', at.toFixed(3),
          '-i', srcUrl,
          '-frames:v', '1',
          '-q:v', '3',
          outJpg,
        ], { timeout: 45_000 })
        const jpg = await readFile(outJpg)
        const thumb = await sharp(jpg)
          .resize({ width: 400, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer()
        after(async () => {
          try {
            const url = await uploadToR2(`thumbnails/dataset/${imageId}.webp`, thumb, 'image/webp')
            await prisma.generatedImage.update({ where: { id: imageId }, data: { thumbnailUrl: url } })
          } catch { /* best effort — next request regenerates */ }
        })
        return new NextResponse(new Uint8Array(thumb), {
          status: 200,
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable',
          },
        })
      } catch (err) {
        console.error('Dataset video-thumb error:', err instanceof Error ? err.message : err)
        return new NextResponse('Poster generation failed', { status: 502 })
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  try {
    const res = await fetch(srcUrl, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return new NextResponse('Image unavailable', { status: 502 })

    const buffer = Buffer.from(await res.arrayBuffer())
    const thumb = await sharp(buffer)
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()

    // Write-behind: persist the thumb to R2 + record thumbnailUrl, so the
    // fetch-original + resize cost is paid ONCE per image EVER. Every future
    // load (composer grids, feeds, this endpoint via the redirect above) then
    // hits R2 directly — this is what was saturating the dev server when a
    // hundred tiles requested thumbs at once.
    after(async () => {
      try {
        const url = await uploadToR2(`thumbnails/dataset/${imageId}.webp`, thumb, 'image/webp')
        await prisma.generatedImage.update({ where: { id: imageId }, data: { thumbnailUrl: url } })
      } catch { /* best effort — next request just regenerates */ }
    })

    return new NextResponse(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        // 7-day immutable cache — thumbnails never change for a given image ID.
        // s-maxage lets the Vercel edge cache serve them too, so only the FIRST
        // viewer ever pays the fetch+resize cost per image.
        'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable',
      },
    })
  } catch (err: any) {
    console.error('Dataset thumb error:', err.message)
    return new NextResponse('Server error', { status: 500 })
  }
}
