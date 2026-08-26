import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { probeDuration } from '@/lib/video-clip'
import { uploadToR2, deleteFromR2, presignPutUrl } from '@/lib/r2'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import archiver from 'archiver'
import { mkdtemp, readFile, rm, writeFile, readdir, stat } from 'fs/promises'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'

// POST /api/admin/frames-clips — ADMIN ONLY
// Frame Extractor "clips" mode: slices an uploaded video into short MP4 clips
// (or GIFs) server-side with ffmpeg. Vercel caps request/response bodies at
// ~4.5MB, so the flow is R2-mediated end to end:
//   1. POST { presign: { mimeType } }  → { uploadUrl, publicUrl } — the client
//      PUTs the source video straight to R2 (frames-tmp/ namespace)
//   2. POST { sourceUrl, clipLen, every, format }  → slices, zips the clips,
//      uploads the zip to R2, deletes the source, returns { zipUrl, clips }
//   3. client fetches the zip, unpacks with JSZip, then DELETE ?url=<zipUrl>
// frames-tmp/ objects are transient working files, never referenced by rows.

export const runtime = 'nodejs'
export const maxDuration = 300

const exec = promisify(execFile)
// The portal popup enforces its own 2-minute TOTAL budget client-side; the
// admin Slicing Studio feeds stored dataset videos with no such budget —
// 15 min is the function-time ceiling for slicing in one request
const MAX_SOURCE_SEC = 900
const MAX_CLIPS = 40

async function authed(req: Request): Promise<boolean> {
  if (checkAuth(req as unknown as import('next/server').NextRequest)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

export async function POST(req: Request) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as {
    presign?: { mimeType?: string }
    sourceUrl?: string
    clipLen?: number
    every?: number
    format?: string
  }

  // ── Phase 1: presigned upload slot ──
  if (body.presign) {
    const mime = typeof body.presign.mimeType === 'string' && body.presign.mimeType.startsWith('video/')
      ? body.presign.mimeType : 'video/mp4'
    const ext = mime.includes('webm') ? 'webm' : mime.includes('quicktime') || mime.includes('mov') ? 'mov' : 'mp4'
    const key = `frames-tmp/src-${crypto.randomUUID()}.${ext}`
    const { uploadUrl, publicUrl } = await presignPutUrl(key, mime)
    return NextResponse.json({ uploadUrl, publicUrl })
  }

  // ── Phase 2: slice ──
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  const sourceUrl = String(body.sourceUrl ?? '')
  // frames-tmp/ uploads (the popup) or ANY object in our R2 bucket (the
  // Slicing Studio slices stored dataset videos in place)
  if (!publicBase || !sourceUrl.startsWith(`${publicBase}/`)) {
    return NextResponse.json({ error: 'sourceUrl must be an object in the site R2 bucket' }, { status: 400 })
  }
  const isTmpSource = sourceUrl.startsWith(`${publicBase}/frames-tmp/`)
  const clipLen = Math.min(10, Math.max(1, Number(body.clipLen) || 3))
  const every = Math.max(clipLen, Number(body.every) || clipLen)
  const format = body.format === 'gif' ? 'gif' : 'mp4'

  let dir: string | null = null
  try {
    const srcRes = await fetch(sourceUrl)
    if (!srcRes.ok) return NextResponse.json({ error: `Could not fetch the uploaded video (${srcRes.status})` }, { status: 400 })
    const srcBuf = Buffer.from(await srcRes.arrayBuffer())

    dir = await mkdtemp(path.join(tmpdir(), 'frames-clips-'))
    const inFile = path.join(dir, 'in.bin')
    await writeFile(inFile, srcBuf)

    const dur = await probeDuration(inFile)
    if (!dur || dur <= 0.2) return NextResponse.json({ error: 'Could not read the video duration' }, { status: 400 })
    if (dur > MAX_SOURCE_SEC + 2) return NextResponse.json({ error: `Video too long (${Math.round(dur)}s — max ${MAX_SOURCE_SEC}s)` }, { status: 400 })

    // Plan the cut points; a final partial clip shorter than 1s is dropped
    const starts: number[] = []
    for (let t = 0; t < dur - 0.9 && starts.length < MAX_CLIPS; t += every) starts.push(t)
    if (starts.length === 0) starts.push(0)

    const clips: { name: string; t: number; dur: number }[] = []
    for (let i = 0; i < starts.length; i++) {
      const t = starts[i]
      const len = Math.min(clipLen, dur - t)
      const name = `clip-${String(i + 1).padStart(2, '0')}-${t.toFixed(1)}s.${format}`
      const out = path.join(dir, name)
      if (format === 'gif') {
        // Two-pass palette GIF: 12fps, 480px wide — the classic quality recipe
        const palette = path.join(dir, `pal-${i}.png`)
        await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', t.toFixed(3), '-t', len.toFixed(3), '-i', inFile,
          '-vf', 'fps=12,scale=480:-1:flags=lanczos,palettegen', palette], { timeout: 120_000 })
        await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', t.toFixed(3), '-t', len.toFixed(3), '-i', inFile, '-i', palette,
          '-lavfi', 'fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse', out], { timeout: 120_000 })
      } else {
        // Exact-cut H.264 MP4, width capped at 1280 (plenty for refs/training)
        await exec(ffmpegPath as string, ['-hide_banner', '-y', '-ss', t.toFixed(3), '-t', len.toFixed(3), '-i', inFile,
          '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
          '-vf', "scale='min(1280,iw)':-2", out], { timeout: 120_000 })
      }
      const st = await stat(out).catch(() => null)
      if (st && st.size > 1000) clips.push({ name, t, dur: len })
    }
    if (clips.length === 0) return NextResponse.json({ error: 'Slicing produced no clips — the video may not decode' }, { status: 500 })

    // Zip the clips and host the zip (response bodies are size-capped on prod)
    const zipPath = path.join(dir, 'clips.zip')
    await new Promise<void>((res, rej) => {
      const output = createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 1 } }) // media doesn't compress — fast store
      output.on('close', () => res())
      archive.on('error', rej)
      archive.pipe(output)
      for (const c of clips) archive.file(path.join(dir!, c.name), { name: c.name })
      void archive.finalize()
    })
    const zipBuf = await readFile(zipPath)
    const zipUrl = await uploadToR2(`frames-tmp/clips-${crypto.randomUUID()}.zip`, zipBuf, 'application/zip')

    // Spent tmp uploads get cleaned up; permanent dataset objects stay
    if (isTmpSource) await deleteFromR2(sourceUrl).catch(() => {})

    return NextResponse.json({ zipUrl, clips })
  } catch (err) {
    console.error('frames-clips error:', err)
    return NextResponse.json({ error: 'Clip extraction failed — MP4 (H.264) sources are safest' }, { status: 500 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// DELETE ?url=<zipUrl> — client cleanup after unpacking (best-effort)
export async function DELETE(req: Request) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const url = new URL(req.url).searchParams.get('url') ?? ''
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (!publicBase || !url.startsWith(`${publicBase}/frames-tmp/`)) {
    return NextResponse.json({ error: 'Only frames-tmp objects can be deleted here' }, { status: 400 })
  }
  await deleteFromR2(url).catch(() => {})
  return NextResponse.json({ ok: true })
}
