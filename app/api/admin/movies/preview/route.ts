import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'
import { localMediaDisabled, safeResolve, hhmmss, probeMovie, sdrChain } from '@/lib/local-media'

// GET /api/admin/movies/preview?path=<abs>&t=<sec>&len=<sec>&h=<px>
// A short, browser-playable MP4 window cut out of a local movie, so a phone or
// tablet on the dev server can actually WATCH the film while choosing sections.
//
// Direct streaming of the original is not an option for these files: Safari
// cannot demux Matroska at all, and even in an MP4 container a DTS-HD track is
// unplayable. Transcoding a ~20s window to H.264 + AAC sidesteps both, and an
// input-side seek keeps the cost flat no matter how deep the timestamp is.
// The window is 480p by default — it is for choosing moments, not for viewing
// quality; extraction always reads the untouched original.

export const runtime = 'nodejs'
export const maxDuration = 120
const exec = promisify(execFile)

const MAX_LEN = 60

// Windows are re-requested constantly while scrubbing, so keep the last few on
// disk. Same path+time+length+height → instant replay instead of a re-encode.
const cacheDir = path.join(tmpdir(), 'movie-preview-cache')
const CACHE_MAX = 40
const cacheKeys: string[] = []

export async function GET(req: Request) {
  let ok = checkAuth(req as unknown as import('next/server').NextRequest)
  if (!ok) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    ok = !!user && (await checkIsAdmin(user.email))
  }
  if (!ok) return new NextResponse('Admin only', { status: 403 })
  const disabled = localMediaDisabled()
  if (disabled) return new NextResponse(disabled, { status: 501 })

  const sp = new URL(req.url).searchParams
  const t = Math.max(0, parseFloat(sp.get('t') || '0') || 0)
  const len = Math.min(MAX_LEN, Math.max(2, parseFloat(sp.get('len') || '20') || 20))
  const h = Math.min(1080, Math.max(180, parseInt(sp.get('h') || '480') || 480))

  let work: string | null = null
  try {
    const file = safeResolve(sp.get('path') || '', { mustBeVideo: true })
    const key = crypto.createHash('sha1').update(`${file}|${t}|${len}|${h}`).digest('hex')
    const cached = path.join(cacheDir, `${key}.mp4`)

    let mp4: Buffer | null = null
    try {
      if ((await stat(cached)).size > 0) mp4 = await readFile(cached)
    } catch { /* not cached yet */ }

    if (!mp4) {
      work = await mkdtemp(path.join(tmpdir(), 'movie-preview-'))
      const out = path.join(work, 'w.mp4')
      const { hdr } = await probeMovie(file)
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y',
        '-ss', hhmmss(t),
        '-t', String(len),
        '-i', file,
        // First video + first audio track; many remuxes carry a dozen dubs
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', sdrChain(hdr, `scale=-2:'min(${h},ih)'`),
        '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        out,
      ], { timeout: 110_000, maxBuffer: 8 << 20 })
      mp4 = await readFile(out)
      // Best-effort cache write; a failure here only costs a re-encode later
      try {
        await mkdir(cacheDir, { recursive: true })
        await writeFile(cached, mp4)
        cacheKeys.push(cached)
        while (cacheKeys.length > CACHE_MAX) {
          const old = cacheKeys.shift()
          if (old) await rm(old, { force: true }).catch(() => {})
        }
      } catch { /* cache is an optimisation, never required */ }
    }

    return new NextResponse(new Uint8Array(mp4), {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(mp4.length),
        'Accept-Ranges': 'none',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (e) {
    console.error('movie preview error:', e instanceof Error ? e.message : e)
    return new NextResponse('Preview failed', { status: 502 })
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
