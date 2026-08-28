import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import archiver from 'archiver'
import { mkdtemp, readFile, rm, readdir, mkdir, stat, copyFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'
import { localMediaDisabled, safeResolve, probeMovie, hhmmss, sdrChain } from '@/lib/local-media'

// POST /api/admin/movies/extract — ADMIN ONLY, local server only
// Extracts frames and/or clips from ONE SECTION of a local movie.
//
// Why this exists alongside frames-clips: that route slices an R2-hosted file,
// so the source has to be uploaded first and the whole job is bounded by how
// much video can move over the network (hence its 15-minute ceiling). A movie
// on an attached drive never moves — ffmpeg reads it in place with an input
// seek, so cost scales with the SECTION you asked for, not the film's length.
// A 30-second section of a 2h14m 40GB remux costs the same as a 30-second clip.
//
// The zip is served straight off local disk (GET ?zip=<token>) rather than
// through R2: same machine, same network, no cloud round trip for what can
// easily be a couple hundred megabytes of PNG stills.

export const runtime = 'nodejs'
export const maxDuration = 300
const exec = promisify(execFile)

// Guard rails against a single request trying to do something absurd — these
// bound the work per request, not the movie
const zipDir = path.join(tmpdir(), 'movie-zips')
const ZIP_TTL_MS = 60 * 60 * 1000

// Drop anything left behind by an abandoned run
async function sweepZips() {
  try {
    const now = Date.now()
    for (const f of await readdir(zipDir)) {
      const full = path.join(zipDir, f)
      const st = await stat(full).catch(() => null)
      if (st && now - st.mtimeMs > ZIP_TTL_MS) await rm(full, { force: true }).catch(() => {})
    }
  } catch { /* nothing to sweep */ }
}

const MAX_SECTION_SEC = 3600        // one hour of source per run
const MAX_FRAMES = 1500
const MAX_CLIPS = 60

async function isAdmin(req: Request): Promise<boolean> {
  if (checkAuth(req as unknown as import('next/server').NextRequest)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const disabled = localMediaDisabled()
  if (disabled) return NextResponse.json({ error: disabled }, { status: 501 })

  const body = await req.json().catch(() => ({}))
  const {
    path: rawPath,
    start = 0,
    end,
    mode = 'frames',
    every = 1,
    format = 'png',
    clipLen = 3,
    clipEvery = 0,
    clipFormat = 'mp4',
    times,
  } = body as {
    path?: string; start?: number; end?: number
    mode?: 'frames' | 'clips' | 'both'
    every?: number; format?: 'png' | 'jpeg'
    clipLen?: number; clipEvery?: number; clipFormat?: 'mp4' | 'gif'
    /** Explicit timestamps — one still each. Used by auto mode. */
    times?: number[]
  }

  let dir: string | null = null
  try {
    const file = safeResolve(rawPath || '', { mustBeVideo: true })

    // ── Timestamp list: one frame per moment, all in one request ──
    if (Array.isArray(times) && times.length > 0) {
      const wanted = times
        .filter(t => typeof t === 'number' && isFinite(t) && t >= 0)
        .slice(0, 120)
      if (wanted.length === 0) return NextResponse.json({ error: 'No usable timestamps' }, { status: 400 })
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const { hdr } = await probeMovie(file)
      const work = await mkdtemp(path.join(tmpdir(), 'movie-stills-'))
      dir = work
      const frames: { name: string; t: number }[] = []
      for (const [i, t] of wanted.entries()) {
        const name = `frame_${String(i + 1).padStart(5, '0')}.${ext}`
        try {
          await exec(ffmpegPath as string, [
            '-hide_banner', '-y',
            '-ss', hhmmss(t),
            '-i', file,
            '-frames:v', '1',
            ...(hdr ? ['-vf', sdrChain(true, 'scale=iw:ih')] : []),
            ...(ext === 'jpg' ? ['-q:v', '2'] : []),
            path.join(work, name),
          ], { timeout: 60_000 })
          frames.push({ name, t })
        } catch { /* skip a frame that will not decode */ }
      }
      if (frames.length === 0) return NextResponse.json({ error: 'No frames could be read' }, { status: 500 })

      const zipPath = path.join(work, 'out.zip')
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(zipPath)
        const archive = archiver('zip', { zlib: { level: 1 } })
        out.on('close', () => resolve())
        archive.on('error', reject)
        archive.pipe(out)
        for (const f of frames) archive.file(path.join(work, f.name), { name: f.name })
        void archive.finalize()
      })
      void sweepZips()
      await mkdir(zipDir, { recursive: true })
      const token = crypto.randomUUID()
      await copyFile(zipPath, path.join(zipDir, `${token}.zip`))
      return NextResponse.json({
        zipToken: token,
        zipBytes: (await stat(zipPath)).size,
        frames,
        clips: [],
        source: { name: path.basename(file) },
      })
    }

    const info = await probeMovie(file)
    const from = Math.max(0, Number(start) || 0)
    const to = Math.min(
      info.duration > 0 ? info.duration : Number(end) || 0,
      Number.isFinite(Number(end)) && Number(end)! > 0 ? Number(end)! : info.duration,
    )
    const span = to - from
    if (!(span > 0)) return NextResponse.json({ error: 'Section is empty — check the start and end times' }, { status: 400 })
    if (span > MAX_SECTION_SEC) {
      return NextResponse.json({ error: `Section is ${Math.round(span / 60)} min — extract at most ${MAX_SECTION_SEC / 60} min per run` }, { status: 400 })
    }

    const everyS = Math.max(0.05, Number(every) || 1)
    const wantFrames = mode !== 'clips'
    const wantClips = mode !== 'frames'
    const frameCount = wantFrames ? Math.floor(span / everyS) : 0
    if (frameCount > MAX_FRAMES) {
      return NextResponse.json({
        error: `That section would produce ${frameCount} frames (max ${MAX_FRAMES}). Raise "frame every" or shorten the section.`,
      }, { status: 400 })
    }

    const work = await mkdtemp(path.join(tmpdir(), 'movie-extract-'))
    dir = work
    const frames: { name: string; t: number }[] = []
    const clips: { name: string; t: number; dur: number }[] = []

    if (wantFrames) {
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y',
        '-ss', hhmmss(from),          // input seek: fast even 2 hours in
        '-t', String(span),
        '-i', file,
        '-vf', info.hdr ? `fps=1/${everyS},${sdrChain(true, 'scale=iw:ih')}` : `fps=1/${everyS}`,
        ...(ext === 'jpg' ? ['-q:v', '2'] : []),
        path.join(work, `frame_%05d.${ext}`),
      ], { timeout: 280_000, maxBuffer: 8 << 20 })
      const made = (await readdir(work)).filter(f => f.startsWith('frame_')).sort()
      made.forEach((name, i) => frames.push({ name, t: from + i * everyS }))
    }

    if (wantClips) {
      const stride = Math.max(Number(clipLen) || 3, Number(clipEvery) || 0)
      const len = Math.max(0.5, Number(clipLen) || 3)
      const starts: number[] = []
      for (let t = from; t + len <= to && starts.length < MAX_CLIPS; t += stride) starts.push(t)
      for (const [i, t] of starts.entries()) {
        const name = clipFormat === 'gif'
          ? `clip_${String(i + 1).padStart(3, '0')}_${t.toFixed(1)}s.gif`
          : `clip_${String(i + 1).padStart(3, '0')}_${t.toFixed(1)}s.mp4`
        const out = path.join(work, name)
        if (clipFormat === 'gif') {
          const palette = path.join(work, `pal_${i}.png`)
          const gifPre = info.hdr ? `fps=12,${sdrChain(true, 'scale=480:-2:flags=lanczos')}` : 'fps=12,scale=480:-2:flags=lanczos'
          await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', hhmmss(t), '-t', String(len), '-i', file,
            '-vf', `${gifPre},palettegen`, palette], { timeout: 180_000 })
          await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', hhmmss(t), '-t', String(len), '-i', file, '-i', palette,
            '-lavfi', `${gifPre}[x];[x][1:v]paletteuse`, out], { timeout: 180_000 })
          await rm(palette, { force: true }).catch(() => {})
        } else {
          await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', hhmmss(t), '-t', String(len), '-i', file,
            '-an', '-movflags', '+faststart', '-preset', 'veryfast',
            // H.264 High + 8-bit 4:2:0 + BT.709 — what phones and tablets play
            '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
            '-vf', sdrChain(info.hdr, "scale='min(1280,iw)':-2"), out], { timeout: 180_000 })
        }
        clips.push({ name, t, dur: len })
      }
    }

    if (frames.length === 0 && clips.length === 0) {
      return NextResponse.json({ error: 'Nothing was produced for that section' }, { status: 400 })
    }

    // Zip the output and hand it over through R2, same as frames-clips
    const zipPath = path.join(work, 'out.zip')
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 1 } })   // media doesn't compress
      out.on('close', () => resolve())
      archive.on('error', reject)
      archive.pipe(out)
      for (const f of frames) archive.file(path.join(work, f.name), { name: f.name })
      for (const c of clips) archive.file(path.join(work, c.name), { name: c.name })
      void archive.finalize()
    })
    void sweepZips()
    await mkdir(zipDir, { recursive: true })
    const token = crypto.randomUUID()
    await copyFile(zipPath, path.join(zipDir, `${token}.zip`))
    const zipBytes = (await stat(zipPath)).size

    return NextResponse.json({
      zipToken: token,
      zipBytes,
      frames,
      clips,
      section: { start: from, end: to, span },
      source: { name: path.basename(file), duration: info.duration, width: info.width, height: info.height },
    })
  } catch (e) {
    console.error('movie extract error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Extraction failed' }, { status: 500 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// GET /api/admin/movies/extract?zip=<token> — stream the results over the LAN
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return new NextResponse('Admin only', { status: 403 })
  const disabled = localMediaDisabled()
  if (disabled) return new NextResponse(disabled, { status: 501 })
  const token = new URL(req.url).searchParams.get('zip') || ''
  if (!TOKEN_RE.test(token)) return new NextResponse('bad token', { status: 400 })
  const file = path.join(zipDir, `${token}.zip`)
  const st = await stat(file).catch(() => null)
  if (!st) return new NextResponse('expired', { status: 404 })
  // Streamed, never buffered — these can be hundreds of megabytes
  return new NextResponse(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(st.size),
      'Cache-Control': 'no-store',
    },
  })
}

// DELETE /api/admin/movies/extract?zip=<token> — drop it once unpacked
export async function DELETE(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const token = new URL(req.url).searchParams.get('zip') || ''
  if (!TOKEN_RE.test(token)) return NextResponse.json({ error: 'bad token' }, { status: 400 })
  await rm(path.join(zipDir, `${token}.zip`), { force: true }).catch(() => {})
  return NextResponse.json({ ok: true })
}
