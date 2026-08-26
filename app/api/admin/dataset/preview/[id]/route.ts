import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadToR2 } from '@/lib/r2'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { probeDuration } from '@/lib/video-clip'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60
const execP = promisify(execFile)

// At most 3 ffmpeg jobs at a time per server process; the rest wait their turn.
// Also de-duplicates concurrent requests for the SAME id (a grid can easily ask
// twice before the first finishes).
let active = 0
const waiting: (() => void)[] = []
const inFlight = new Map<number, Promise<Buffer>>()

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>(r => waiting.push(r))
  active++
  try { return await fn() } finally {
    active--
    waiting.shift()?.()
  }
}

// GET /api/admin/dataset/preview/[id]
// A ~3s, 240px-wide, looping ANIMATED WEBP for grid tiles — for GIFs as well as
// videos, so one <img> code path covers both. Generated once with ffmpeg reading
// the R2 URL directly, cached in R2, then served by redirect.
//
// WebP rather than MP4 on purpose: iOS Safari caps how many <video> elements
// can decode simultaneously, and a dense grid blows straight past it — the
// extra tiles just show their poster. Animated images have no such ceiling.
//
// Public, like the sibling thumb route: the sources are already public.
// Where each segment starts, as a fraction of the source. Segments beyond 0
// only make sense once a source is long enough to have distinct moments.
const SEG_AT = [0.25, 0.5, 0.72]
const MULTI_SEG_MIN_SEC = 12

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const seg = Math.min(2, Math.max(0, parseInt(new URL(req.url).searchParams.get('seg') || '0') || 0))
  const imageId = parseInt(id)
  if (isNaN(imageId)) return new NextResponse('Invalid id', { status: 400 })

  const row = await prisma.generatedImage.findFirst({
    where: { id: imageId, isDeleted: false },
    select: { imageUrl: true, videoMetadata: true },
  })
  if (!row) return new NextResponse('Not found', { status: 404 })

  const meta = (row.videoMetadata as Record<string, unknown> | null) ?? {}
  // NOTE: distinct key from the earlier MP4 previews so stale ones are ignored
  const metaKey = seg === 0 ? 'previewAnimUrl' : `previewAnimUrl${seg}`
  const cached = meta[metaKey]
  if (typeof cached === 'string' && /^https?:\/\//.test(cached)) {
    return NextResponse.redirect(cached, {
      status: 302,
      headers: { 'Cache-Control': 'public, max-age=604800' },
    })
  }

  const src = row.imageUrl
  if (!/\.(mp4|webm|mov|avi|mkv|m4v|gif)$/i.test(src)) {
    return new NextResponse('Not a motion source', { status: 404 })
  }

  try {
    const flightKey = imageId * 10 + seg
    const existingSeg = inFlight.get(flightKey)
    const webp = existingSeg
      ? await existingSeg
      : await (() => {
          const job = withSlot(() => generatePreview(imageId, src, meta, seg, metaKey))
          inFlight.set(flightKey, job)
          return job.finally(() => inFlight.delete(flightKey))
        })()
    return new NextResponse(new Uint8Array(webp), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(webp.length),
        'Cache-Control': 'public, max-age=604800, immutable',
      },
    })
  } catch (err) {
    console.error('Dataset preview error:', err instanceof Error ? err.message : err)
    return new NextResponse('Preview generation failed', { status: 502 })
  }
}

async function generatePreview(
  imageId: number,
  src: string,
  meta: Record<string, unknown>,
  seg: number,
  metaKey: string,
): Promise<Buffer> {
  let dir: string | null = null
  try {
    const dur = await probeDuration(src)
    // Segment 0 starts a little in from the top (openings are often fades);
    // later segments sample deeper into a long source.
    const frac = SEG_AT[seg] ?? SEG_AT[0]
    const usable = dur && dur > 6
    const start = usable ? Math.max(0, Math.min(dur * frac, dur - 3)) : 0
    dir = await mkdtemp(path.join(tmpdir(), 'ds-preview-'))
    const out = path.join(dir, 'preview.webp')
    await execP(ffmpegPath as string, [
      '-hide_banner', '-y',
      '-ss', start.toFixed(3),
      '-t', '3',
      '-i', src,
      '-an',
      // trunc(../2)*2 on the WIDTH keeps odd-sized sources legal for any encoder
      '-vf', "scale='trunc(min(240,iw)/2)*2':-2,fps=10",
      '-c:v', 'libwebp', '-loop', '0', '-q:v', '45', '-compression_level', '5',
      out,
    ], { timeout: 55_000 })
    const webp = await readFile(out)

    after(async () => {
      try {
        const name = seg === 0 ? `${imageId}.webp` : `${imageId}-s${seg}.webp`
        const url = await uploadToR2(`thumbnails/preview/${name}`, webp, 'image/webp')
        // Re-read first: a sibling segment may have written since we started,
        // and a blind spread of the stale `meta` would drop its key.
        const fresh = await prisma.generatedImage.findUnique({
          where: { id: imageId }, select: { videoMetadata: true },
        })
        const base = (fresh?.videoMetadata as Record<string, unknown> | null) ?? meta
        await prisma.generatedImage.update({
          where: { id: imageId },
          data: {
            videoMetadata: {
              ...base,
              [metaKey]: url,
              // Duration rides along free — we already probed it, and the
              // library's length filters/sorts need it
              ...(typeof dur === 'number' && dur > 0 ? { durationSec: Math.round(dur * 10) / 10 } : {}),
              ...(usable && dur && dur >= MULTI_SEG_MIN_SEC ? { multiSeg: true } : {}),
            },
          },
        })
      } catch { /* best effort — next request regenerates */ }
    })

    return webp
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
