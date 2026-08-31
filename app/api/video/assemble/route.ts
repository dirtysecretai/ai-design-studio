import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { uploadToR2 } from '@/lib/r2'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'

// POST /api/video/assemble — ADMIN ONLY
//
// Post-production for generated shots. Three ops behind one route so only one
// function bundle has to carry the ffmpeg binary:
//
//   { op: 'frames', videoUrl, at: ['mid','last'] }
//     -> { frames: { mid, last } }   JPEGs on R2.
//     The agent cannot watch video, and frame-chaining needs the last frame of
//     shot N as the start image of shot N+1. Both problems, one extraction.
//
//   { op: 'stitch', clips: [{ url, trimStart?, trimEnd? }], aspect, fps, width }
//     -> { url, durationSec, clips }
//
//   { op: 'mux', videoUrl, music?: { url, gainDb, fadeOutSec }, voice?: [...] }
//     -> { url, durationSec }
//
//   { op: 'captions', videoUrl, captions: [{ text, startSec, endSec }], position }
//     -> { url, burned }
//     Burned in with drawtext, so they survive download and re-upload. Titles
//     that need real typography belong on a STILL via edit_image's text
//     overlay; this is for spoken lines and subtitles on the finished cut.
//
// Media is pulled server-side by URL and only the result URL is returned, so
// Vercel's ~4.5MB body cap never applies. Same shape as
// app/api/admin/frames-clips/route.ts, which is the working precedent for
// ffmpeg + R2 + tempdir here.

export const runtime = 'nodejs'
export const maxDuration = 300

const exec = promisify(execFile)

/** /tmp is 512MB on Vercel: 16 short clips plus the render fits, more does not. */
const MAX_CLIPS = 16
const MAX_TOTAL_SEC = 120

async function authed(req: NextRequest): Promise<boolean> {
  if (checkAuth(req)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

/** Only our own storage and fal's — never an arbitrary URL from a prompt. */
function allowedSource(url: string): boolean {
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (base && url.startsWith(`${base}/`)) return true
  return /^https:\/\/[a-z0-9.-]*\bfal\.(media|run)\//i.test(url)
}

async function fetchTo(file: string, url: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`Could not fetch ${url.slice(-40)} (${res.status})`)
  await writeFile(file, Buffer.from(await res.arrayBuffer()))
}

/** Duration, frame size, and whether the file carries an audio stream. */
async function probe(file: string): Promise<{ seconds: number; hasAudio: boolean; width: number; height: number }> {
  // ffprobe is not shipped with ffmpeg-static, so read ffmpeg's own report
  const { stderr } = await exec(ffmpegPath as string, ['-hide_banner', '-i', file])
    .catch((e: any) => ({ stderr: String(e?.stderr ?? '') }))
  const d = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr)
  const seconds = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0
  const v = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  return {
    seconds,
    hasAudio: /Stream #\d+:\d+.*: Audio:/i.test(stderr),
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
  }
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as Record<string, any>
  const op = String(body.op ?? '')
  let dir: string | null = null

  try {
    dir = await mkdtemp(path.join(tmpdir(), 'assemble-'))

    // ── frames ────────────────────────────────────────────────────────────
    if (op === 'frames') {
      const videoUrl = String(body.videoUrl ?? '')
      if (!allowedSource(videoUrl)) {
        return NextResponse.json({ error: 'videoUrl must be an R2 or fal URL' }, { status: 400 })
      }
      const at: string[] = Array.isArray(body.at) && body.at.length
        ? body.at.filter((a: unknown) => a === 'first' || a === 'mid' || a === 'last')
        : ['mid', 'last']

      const src = path.join(dir, 'src.mp4')
      await fetchTo(src, videoUrl)
      const { seconds } = await probe(src)

      const frames: Record<string, string> = {}
      for (const which of at) {
        // A seek exactly on the final timestamp lands past the last frame and
        // writes nothing — back off a frame's worth.
        const t = which === 'first' ? 0 : which === 'mid' ? seconds / 2 : Math.max(0, seconds - 0.05)
        const out = path.join(dir, `${which}.jpg`)
        await exec(ffmpegPath as string, [
          '-hide_banner', '-y', '-ss', String(t), '-i', src,
          '-frames:v', '1', '-q:v', '3', out,
        ])
        const buf = await readFile(out)
        frames[which] = await uploadToR2(`films/frame-${crypto.randomUUID()}.jpg`, buf, 'image/jpeg')
      }
      return NextResponse.json({ frames, durationSec: Math.round(seconds * 100) / 100 })
    }

    // ── stitch ────────────────────────────────────────────────────────────
    if (op === 'stitch') {
      const raw: any[] = Array.isArray(body.clips) ? body.clips : []
      const clips = raw
        .map(c => (typeof c === 'string' ? { url: c } : c))
        .filter(c => c && typeof c.url === 'string' && allowedSource(c.url))
        .slice(0, MAX_CLIPS)
      if (clips.length === 0) {
        return NextResponse.json({ error: 'clips must be R2 or fal video URLs' }, { status: 400 })
      }

      const fps = Math.min(60, Math.max(12, Number(body.fps) || 24))

      // Download and measure everything first: a clip with no audio stream is
      // the classic concat-filter failure, and we need a silent track for it.
      const files: { file: string; seconds: number; hasAudio: boolean; width: number; height: number; trimStart?: number; trimEnd?: number }[] = []
      let total = 0
      for (let i = 0; i < clips.length; i++) {
        const f = path.join(dir, `c${i}.mp4`)
        await fetchTo(f, clips[i].url)
        const meta = await probe(f)
        const trimStart = Number(clips[i].trimStart) || 0
        const trimEnd = Number(clips[i].trimEnd) || 0
        const used = Math.max(0.1, (trimEnd || meta.seconds) - trimStart)
        total += used
        files.push({ file: f, seconds: meta.seconds, hasAudio: meta.hasAudio, width: meta.width, height: meta.height, trimStart, trimEnd })
        if (total > MAX_TOTAL_SEC) {
          return NextResponse.json(
            { error: `Cut is longer than the ${MAX_TOTAL_SEC}s assembly limit — stitch it in sections.` },
            { status: 400 },
          )
        }
      }

      // OUTPUT SIZE FOLLOWS THE FOOTAGE. This used to be a hardcoded 1280x720
      // 16:9 box, which downscaled 1080p shots and letterboxed anything that
      // was not 16:9 — a vertical film became a narrow strip inside a wide
      // frame, which is why the result looked small played fullscreen.
      // The shape is whichever aspect most of the clips already are, and the
      // size is the largest of those clips (capped so /tmp and the encode stay
      // sane). An explicit aspect/width in the request still wins.
      const sized = files.filter(f => f.width > 0 && f.height > 0)
      const modalKey = (() => {
        const tally = new Map<string, number>()
        for (const f of sized) {
          const k = (f.width / f.height).toFixed(3)
          tally.set(k, (tally.get(k) ?? 0) + 1)
        }
        let best = '', n = -1
        for (const [k, c] of tally) if (c > n) { best = k; n = c }
        return best
      })()
      const modal = sized.filter(f => (f.width / f.height).toFixed(3) === modalKey)
      const biggest = modal.reduce<{ width: number; height: number }>(
        (a, f) => (f.width * f.height > a.width * a.height ? { width: f.width, height: f.height } : a),
        { width: 0, height: 0 },
      )

      let width: number
      let height: number
      if (body.aspect || body.width || biggest.width === 0) {
        const aspect = String(body.aspect ?? '16:9')
        const [aw, ah] = aspect.split(':').map(Number)
        width = Math.min(1920, Math.max(480, Number(body.width) || biggest.width || 1280))
        height = Math.round((width * (ah || 9)) / (aw || 16) / 2) * 2
      } else {
        const scale = Math.min(1, 1920 / Math.max(biggest.width, biggest.height))
        width = Math.round((biggest.width * scale) / 2) * 2
        height = Math.round((biggest.height * scale) / 2) * 2
      }

      const args: string[] = ['-hide_banner', '-y']
      for (const f of files) {
        if (f.trimStart) args.push('-ss', String(f.trimStart))
        if (f.trimEnd) args.push('-t', String(Math.max(0.1, f.trimEnd - (f.trimStart || 0))))
        args.push('-i', f.file)
      }
      // One silent source to borrow from for clips that have no audio track
      args.push('-f', 'lavfi', '-t', String(Math.ceil(total) + 1), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      const silentIdx = files.length

      const parts: string[] = []
      const labels: string[] = []
      files.forEach((f, i) => {
        // Shots come from different models: different sizes, fps and pixel
        // aspect. Normalise every one, or concat refuses / output stretches.
        parts.push(
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`
        )
        const dur = Math.max(0.1, (f.trimEnd || f.seconds) - (f.trimStart || 0))
        if (f.hasAudio) parts.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`)
        else parts.push(`[${silentIdx}:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
        labels.push(`[v${i}][a${i}]`)
      })
      parts.push(`${labels.join('')}concat=n=${files.length}:v=1:a=1[v][a]`)

      const out = path.join(dir, 'film.mp4')
      await exec(ffmpegPath as string, [
        ...args,
        '-filter_complex', parts.join(';'),
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', out,
      ], { maxBuffer: 1024 * 1024 * 32 })

      const buf = await readFile(out)
      const url = await uploadToR2(`films/film-${crypto.randomUUID()}.mp4`, buf, 'video/mp4')
      return NextResponse.json({
        url,
        clips: files.length,
        durationSec: Math.round(total * 100) / 100,
        width,
        height,
      })
    }

    // ── mux ───────────────────────────────────────────────────────────────
    if (op === 'mux') {
      const videoUrl = String(body.videoUrl ?? '')
      if (!allowedSource(videoUrl)) {
        return NextResponse.json({ error: 'videoUrl must be an R2 or fal URL' }, { status: 400 })
      }
      const music = body.music && typeof body.music.url === 'string' && allowedSource(body.music.url)
        ? body.music : null
      const voices: any[] = Array.isArray(body.voice)
        ? body.voice.filter((v: any) => v && typeof v.url === 'string' && allowedSource(v.url)).slice(0, 8)
        : []
      if (!music && voices.length === 0) {
        return NextResponse.json({ error: 'Nothing to mux — pass music and/or voice' }, { status: 400 })
      }

      const vid = path.join(dir, 'in.mp4')
      await fetchTo(vid, videoUrl)
      const { seconds, hasAudio } = await probe(vid)

      const inputs: string[] = ['-hide_banner', '-y', '-i', vid]
      const chains: string[] = []
      const mixLabels: string[] = []
      let idx = 1

      if (hasAudio) mixLabels.push('[0:a]')

      if (music) {
        const mf = path.join(dir, 'music.mp3')
        await fetchTo(mf, music.url)
        inputs.push('-i', mf)
        const gain = Number.isFinite(Number(music.gainDb)) ? Number(music.gainDb) : -14
        const fade = Math.max(0, Number(music.fadeOutSec) || 2)
        // Trimmed to picture and faded out, so the bed never outlives the cut
        chains.push(
          `[${idx}:a]atrim=0:${seconds.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain}dB,` +
          `afade=t=out:st=${Math.max(0, seconds - fade).toFixed(3)}:d=${fade}[music]`
        )
        mixLabels.push('[music]')
        idx++
      }

      for (let i = 0; i < voices.length; i++) {
        const vf = path.join(dir, `vo${i}.mp3`)
        await fetchTo(vf, voices[i].url)
        inputs.push('-i', vf)
        const at = Math.max(0, Number(voices[i].atSec) || 0)
        const gain = Number.isFinite(Number(voices[i].gainDb)) ? Number(voices[i].gainDb) : 0
        const delayMs = Math.round(at * 1000)
        chains.push(`[${idx}:a]adelay=${delayMs}|${delayMs},volume=${gain}dB[vo${i}]`)
        mixLabels.push(`[vo${i}]`)
        idx++
      }

      chains.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0[a]`)

      const out = path.join(dir, 'mixed.mp4')
      await exec(ffmpegPath as string, [
        ...inputs,
        '-filter_complex', chains.join(';'),
        // The picture is already correct — copying it avoids a second encode
        '-map', '0:v', '-c:v', 'copy',
        '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-shortest', '-movflags', '+faststart', out,
      ], { maxBuffer: 1024 * 1024 * 32 })

      const buf = await readFile(out)
      const url = await uploadToR2(`films/film-${crypto.randomUUID()}.mp4`, buf, 'video/mp4')
      return NextResponse.json({ url, durationSec: Math.round(seconds * 100) / 100 })
    }

    // ── captions ──────────────────────────────────────────────────────────
    if (op === 'captions') {
      const videoUrl = String(body.videoUrl ?? '')
      if (!allowedSource(videoUrl)) {
        return NextResponse.json({ error: 'videoUrl must be an R2 or fal URL' }, { status: 400 })
      }
      const raw: any[] = Array.isArray(body.captions) ? body.captions : []
      const caps = raw
        .filter(c => c && typeof c.text === 'string' && c.text.trim())
        .map(c => ({
          text: String(c.text).slice(0, 220),
          start: Math.max(0, Number(c.startSec) || 0),
          end: Math.max(0.1, Number(c.endSec) || (Number(c.startSec) || 0) + 3),
        }))
        .slice(0, 60)
      if (caps.length === 0) {
        return NextResponse.json({ error: 'captions must be [{ text, startSec, endSec }]' }, { status: 400 })
      }

      const src = path.join(dir, 'in.mp4')
      await fetchTo(src, videoUrl)
      const { seconds, height: vh } = await probe(src)
      // drawtext's size options take INTEGERS, not expressions like h/22, so
      // they are computed from the real frame height here.
      const H = vh > 0 ? vh : 720
      const fontSize = Math.max(14, Math.round(H / 22))
      const borderW = Math.max(1, Math.round(H / 500))
      const boxBorder = Math.max(4, Math.round(H / 90))

      // drawtext parses its own arg string, so anything with meaning inside it
      // has to be neutralised or the filter graph breaks on an apostrophe.
      const esc = (t: string) => t
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\u2019")
        .replace(/%/g, '\\%')
        .replace(/\r?\n/g, ' ')

      const pos = body.position === 'top' ? `${Math.round(H * 0.08)}` : `h-${Math.round(H * 0.12)}-text_h`
      const chain = caps.map(c =>
        `drawtext=text='${esc(c.text)}'`
        + `:fontcolor=white:fontsize=${fontSize}:borderw=${borderW}:bordercolor=black@0.9`
        + `:box=1:boxcolor=black@0.35:boxborderw=${boxBorder}`
        + `:x=(w-text_w)/2:y=${pos}`
        + `:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      ).join(',')

      const out = path.join(dir, 'captioned.mp4')
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y', '-i', src,
        '-vf', chain,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        // the audio is already right — never re-encode it for a text overlay
        '-c:a', 'copy', '-movflags', '+faststart', out,
      ], { maxBuffer: 1024 * 1024 * 32 })

      const buf = await readFile(out)
      const url = await uploadToR2(`films/film-${crypto.randomUUID()}.mp4`, buf, 'video/mp4')
      return NextResponse.json({ url, burned: caps.length, durationSec: Math.round(seconds * 100) / 100 })
    }

    return NextResponse.json({ error: `Unknown op "${op}" — expected frames, stitch, mux or captions` }, { status: 400 })
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err).slice(-600)
    console.error('[assemble] failed:', msg)
    return NextResponse.json({ error: `Assembly failed: ${msg}` }, { status: 500 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
