import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { localMediaDisabled, safeResolve, hhmmss, probeMovie, sdrChain } from '@/lib/local-media'

// GET /api/admin/movies/poster?path=<abs>&t=<sec>&w=<px>
// One JPEG frame from a local movie at time t. This is how the section picker
// scrubs a 2-hour MKV: browsers can't play Matroska at all, and even for MP4
// there is no reason to stream 40GB just to look at a timeline. Input-side
// -ss makes each grab a seek plus one frame decode, so it stays fast no matter
// how deep into the film the timestamp is.

export const runtime = 'nodejs'
export const maxDuration = 60
const exec = promisify(execFile)

// Grabs are cheap individually but a grid can ask for dozens at once, and each
// is a separate ffmpeg against a very large file. Queue them.
let running = 0
const waiting: (() => void)[] = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>(r => waiting.push(r))
  running++
  try { return await fn() } finally { running--; waiting.shift()?.() }
}

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
  const w = Math.min(1280, Math.max(80, parseInt(sp.get('w') || '320') || 320))

  let dir: string | null = null
  try {
    const file = safeResolve(sp.get('path') || '', { mustBeVideo: true })
    const work = await mkdtemp(path.join(tmpdir(), 'movie-poster-'))
    dir = work
    const out = path.join(work, 'f.jpg')
    const { hdr } = await probeMovie(file)
    await withSlot(() => exec(ffmpegPath as string, [
      '-hide_banner', '-y',
      '-ss', hhmmss(t),
      '-i', file,
      '-frames:v', '1',
      '-vf', sdrChain(hdr, `scale='trunc(min(${w},iw)/2)*2':-2`),
      '-q:v', '4',
      out,
    ], { timeout: 45_000 }))
    const jpg = await readFile(out)
    return new NextResponse(new Uint8Array(jpg), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(jpg.length),
        // Same file+timestamp always yields the same frame
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (e) {
    console.error('movie poster error:', e instanceof Error ? e.message : e)
    return new NextResponse('Poster failed', { status: 502 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
