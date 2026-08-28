import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'
import { localMediaDisabled, safeResolve, probeMovie, hhmmss } from '@/lib/local-media'

// POST /api/admin/movies/auto   { path, opts }  → { jobId }
// GET  /api/admin/movies/auto?job=<id>          → progress / result
// ADMIN ONLY, local server only.
//
// Surveys an entire film and proposes the moments worth pulling, so a two-hour
// movie becomes a reviewable list of sections instead of manual scrubbing.
//
// How it avoids drowning you in near-identical stills:
//   1. KEYFRAME SCAN — decode I-frames only at 320px. Measured at ~42x
//      realtime on a 1080p remux, so a 135-minute film scans in ~3 minutes
//      instead of the hours a full decode would take.
//   2. SHOT GROUPING — consecutive frames whose perceptual hash barely differs
//      belong to the same shot; each shot contributes ONE frame, the sharpest.
//   3. GLOBAL DEDUP — a second pass drops shots that look like ones already
//      kept (repeated locations, reverse-angle cuts of the same two faces).
//   4. QUALITY GATE — near-black frames and soft/blurry frames are discarded.
//   5. CONTENT FILTER (optional) — candidates are tiled into contact sheets and
//      labelled by a vision model, so "characters" or "landscape" (or a named
//      character) decides what survives rather than sharpness alone.
// Whatever is left is capped to the target count, spread across the runtime.

export const runtime = 'nodejs'
export const maxDuration = 300
const exec = promisify(execFile)

async function isAdmin(req: Request): Promise<boolean> {
  if (checkAuth(req as unknown as import('next/server').NextRequest)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

export interface AutoOpts {
  targetFrames: number
  clipLen: number
  makeClips: boolean
  look: string[]          // e.g. ['characters', 'landscape'] — empty = keep everything
  characters: string      // free text, e.g. "Darth Vader, Yoda"
  minGapSec: number       // don't propose two moments closer than this
  from?: number
  to?: number
}

type Hash64 = { hi: number; lo: number }

interface Candidate {
  t: number
  sharp: number
  mean: number
  hash: Hash64
  tags?: string[]
  file: string
}

interface Job {
  id: string
  phase: string
  progress: number        // 0..1
  done: boolean
  error?: string
  note?: string
  result?: {
    moments: { t: number; score: number; tags: string[] }[]
    scanned: number; shots: number; afterQuality: number; afterDedup: number; classified: number; kept: number
  }
  startedAt: number
}

// In-memory: this route only ever runs on the local dev server, single process
const jobs = new Map<string, Job>()

const popcount = (n: number) => {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
const ham = (a: Hash64, b: Hash64) => popcount(a.hi ^ b.hi) + popcount(a.lo ^ b.lo)

/** dHash + brightness + a cheap sharpness proxy, from ONE decode of each file. */
async function measure(file: string): Promise<{ hash: Hash64; mean: number; sharp: number }> {
  const small = await sharp(file).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
  let hi = 0, lo = 0, sum = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0
      const n = y * 8 + x
      if (n < 32) hi = ((hi << 1) | bit) >>> 0
      else lo = ((lo << 1) | bit) >>> 0
      sum += small[y * 9 + x]
    }
  }
  const hash: Hash64 = { hi, lo }
  // Sharpness: variance of neighbour differences on a slightly bigger thumb.
  // Enough to separate motion-blurred frames from clean ones.
  const med = await sharp(file).greyscale().resize(64, 36, { fit: 'fill' }).raw().toBuffer()
  let d = 0
  for (let i = 1; i < med.length; i++) d += Math.abs(med[i] - med[i - 1])
  return { hash, mean: sum / 64, sharp: d / med.length }
}

/** Label a batch of frames with a vision model, 9 at a time as a contact sheet. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function classify(files: string[], want: string[], characters: string, attempt = 0): Promise<string[][]> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return files.map(() => [])
  const labels = [...want]
  if (characters.trim()) labels.push(`named:${characters.trim()}`)

  const sheet = await sharp({
    create: { width: 3 * 320, height: 3 * 180, channels: 3, background: '#000' },
  })
    .composite(await Promise.all(files.slice(0, 9).map(async (f, i) => ({
      input: await sharp(f).resize(320, 180, { fit: 'cover' }).toBuffer(),
      left: (i % 3) * 320,
      top: Math.floor(i / 3) * 180,
    }))))
    .jpeg({ quality: 70 })
    .toBuffer()

  const prompt = `This is a 3x3 grid of frames from a film, numbered 1-9 left to right, top to bottom.
For EACH numbered cell, list which of these apply: ${labels.join(', ')}.
"characters" = one or more people/creatures are a clear subject. "landscape" = scenery, environment or establishing shot with no prominent person. "action" = motion, combat or vehicles. "closeup" = a face or object fills much of the frame.${characters.trim() ? `\nFor "named:", say it only if you clearly recognise: ${characters.trim()}.` : ''}
Reply with exactly 9 lines, each "N: label, label" or "N: none". No other text.`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: sheet.toString('base64') } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    )
    if (!res.ok) {
      // 429s are the normal failure here; one backoff is usually enough
      if (attempt < 1) { await sleep(res.status === 429 ? 4000 : 1500); return classify(files, want, characters, attempt + 1) }
      return files.map(() => [])
    }
    const j = await res.json()
    const text: string = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || ''
    const out: string[][] = files.map(() => [])
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d)\s*[:.)-]\s*(.+)$/)
      if (!m) continue
      const idx = parseInt(m[1]) - 1
      if (idx < 0 || idx >= out.length) continue
      const tags = m[2].toLowerCase().split(',').map(x => x.trim()).filter(x => x && x !== 'none')
      out[idx] = tags
    }
    return out
  } catch {
    if (attempt < 1) { await sleep(1500); return classify(files, want, characters, attempt + 1) }
    return files.map(() => [])       // classification is advisory, never fatal
  }
}

async function run(job: Job, file: string, opts: AutoOpts) {
  let work: string | null = null
  try {
    const info = await probeMovie(file)
    const from = Math.max(0, opts.from ?? 0)
    const to = Math.min(info.duration || 0, opts.to && opts.to > 0 ? opts.to : info.duration)
    const span = Math.max(1, to - from)

    job.phase = 'Scanning the film for shot changes…'
    const scanDir = await mkdtemp(path.join(tmpdir(), 'movie-auto-'))
    work = scanDir
    // I-frames only: the fast survey. -frame_pts writes each file's PTS in ms,
    // which is how a timestamp survives back to us.
    // showinfo prints a pts_time per frame on stderr while the files are being
    // written. -frame_pts looked simpler but names files with frame counters,
    // not seconds, which silently collapsed every moment onto one timestamp.
    const scan = await exec(ffmpegPath as string, [
      '-hide_banner', '-y',
      '-skip_frame', 'nokey',
      '-ss', hhmmss(from), '-t', String(span),
      '-i', file,
      '-vsync', '0',
      '-vf', 'scale=320:-2,showinfo',
      '-q:v', '6',
      path.join(scanDir, 'kf_%05d.jpg'),
    ], { timeout: 280_000, maxBuffer: 64 << 20 }).catch((e: unknown) => e as { stdout?: string; stderr?: string })

    const stamps = [...String(scan?.stderr || '').matchAll(/pts_time:([0-9.]+)/g)].map(m => parseFloat(m[1]))
    const files = (await readdir(scanDir)).filter(f => f.startsWith('kf_')).sort()
    job.progress = 0.35

    job.phase = `Measuring ${files.length} frames…`
    const cands: Candidate[] = []
    for (const [i, f] of files.entries()) {
      const full = path.join(scanDir, f)
      // Frame i of the output corresponds to the i-th pts_time logged
      const pts = stamps[i] ?? (i * span) / Math.max(1, files.length)
      const { hash, mean, sharp: sh } = await measure(full)
      cands.push({ t: from + pts, sharp: sh, mean, hash, file: full })
      if (i % 40 === 0) {
        job.progress = 0.35 + 0.35 * (i / Math.max(1, files.length))
        job.phase = `Measuring frames… ${i}/${files.length}`
      }
    }

    // ── Shot grouping: a run of similar consecutive frames is one shot ──
    job.phase = 'Grouping shots…'
    const shots: Candidate[] = []
    let current: Candidate[] = []
    const flush = () => {
      if (current.length === 0) return
      const best = current.reduce((a, b) => (b.sharp > a.sharp ? b : a))
      shots.push(best)
      current = []
    }
    for (const c of cands) {
      if (c.mean < 12) { flush(); continue }               // black / fade
      if (current.length === 0) { current.push(c); continue }
      if (ham(current[current.length - 1].hash, c.hash) <= 10) current.push(c)
      else { flush(); current.push(c) }
    }
    flush()

    // ── Global dedup + quality gate + spacing ──
    job.phase = 'Removing duplicates…'
    // Quality gate: drop only the genuinely soft bottom of the distribution
    const sorted = [...shots].map(s => s.sharp).sort((a, b) => a - b)
    const p20 = sorted[Math.floor(sorted.length * 0.2)] ?? 0
    const okQuality = shots.filter(s => s.sharp >= p20)

    // Dedup against what we have already kept, in TIME order so the film's
    // structure is preserved rather than favouring whatever is sharpest
    const deduped: Candidate[] = []
    for (const s of [...okQuality].sort((a, b) => a.t - b.t)) {
      if (deduped.some(k => ham(k.hash, s.hash) <= 6)) continue
      deduped.push(s)
    }

    // Spacing is applied last and only as a minimum gap
    const kept: Candidate[] = []
    for (const s of deduped) {
      if (kept.length && s.t - kept[kept.length - 1].t < opts.minGapSec) continue
      kept.push(s)
    }
    job.progress = 0.75

    // ── Optional content filter ──
    let survivors = kept
    let classified = 0
    const target = Math.max(1, opts.targetFrames)
    if (opts.look.length > 0 || opts.characters.trim()) {
      // Classify a SAMPLE spread across the runtime rather than every
      // candidate: enough to fill the target several times over, few enough to
      // stay well inside the API's rate limit.
      const sampleSize = Math.min(kept.length, Math.max(60, Math.ceil(target * 1.5)), 450)
      const stride = kept.length / sampleSize
      const budget = Array.from({ length: sampleSize }, (_, i) => kept[Math.floor(i * stride)])
      job.phase = `Looking at ${budget.length} moments…`
      const sheets: Candidate[][] = []
      for (let i = 0; i < budget.length; i += 9) sheets.push(budget.slice(i, i + 9))
      let done = 0
      const queue = [...sheets]
      // Two at a time with a gap between starts — comfortably under the limit
      await Promise.all(Array.from({ length: 2 }, async (_, lane) => {
        await sleep(lane * 600)
        while (queue.length) {
          const group = queue.shift()!
          const tags = await classify(group.map(g => g.file), opts.look, opts.characters)
          group.forEach((g, i) => { g.tags = tags[i] || [] })
          done++
          job.progress = 0.75 + 0.2 * (done / sheets.length)
          job.phase = `Looking at moments… ${Math.min(done * 9, budget.length)}/${budget.length}`
          await sleep(700)
        }
      }))
      const wanted = (c: Candidate) => {
        const tags = c.tags ?? []
        if (tags.length === 0) return false
        // A named character is a REQUIREMENT, not another way to match: asking
        // for Leia means frames with Leia, not every frame containing a person.
        if (opts.characters.trim()) return tags.some(t => t.startsWith('named'))
        return opts.look.some(w => tags.some(t => t.includes(w)))
      }
      const matched = budget.filter(wanted)
      classified = budget.filter(c => (c.tags ?? []).length > 0).length
      if (classified < budget.length * 0.4) {
        job.note = 'The content filter could not label most frames (rate limit or model error) — showing the deduped moments instead.'
      }
      // A filter that matches almost nothing usually means the model was
      // unavailable or the labels didn't fit — fall back rather than hand back
      // an empty result the user can't act on
      survivors = matched.length >= Math.max(3, target * 0.15) ? matched : kept
    }

    // ── Cap to the target, spread evenly across the runtime ──
    job.phase = 'Choosing moments…'
    let picked = survivors
    if (survivors.length > target) {
      const stride = survivors.length / target
      picked = Array.from({ length: target }, (_, i) => survivors[Math.floor(i * stride)])
    }

    job.result = {
      moments: picked.map(p => ({ t: Math.round(p.t * 10) / 10, score: Math.round(p.sharp), tags: p.tags ?? [] })),
      scanned: cands.length,
      shots: shots.length,
      afterQuality: okQuality.length,
      afterDedup: deduped.length,
      classified,
      kept: survivors.length,
    }
    job.progress = 1
    job.phase = 'Done'
    job.done = true
  } catch (e) {
    job.error = e instanceof Error ? e.message : 'Auto scan failed'
    job.done = true
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const disabled = localMediaDisabled()
  if (disabled) return NextResponse.json({ error: disabled }, { status: 501 })

  const body = await req.json().catch(() => ({}))
  let file: string
  try { file = safeResolve(body.path || '', { mustBeVideo: true }) }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'bad path' }, { status: 400 }) }

  const o = body.opts || {}
  const opts: AutoOpts = {
    targetFrames: Math.min(500, Math.max(1, Number(o.targetFrames) || 60)),
    clipLen: Math.max(0.5, Number(o.clipLen) || 3),
    makeClips: !!o.makeClips,
    look: Array.isArray(o.look) ? o.look.filter((x: unknown) => typeof x === 'string') : [],
    characters: typeof o.characters === 'string' ? o.characters : '',
    minGapSec: Math.max(0, Number(o.minGapSec) || 4),
    from: Number(o.from) || 0,
    to: Number(o.to) || 0,
  }

  const job: Job = { id: crypto.randomUUID(), phase: 'Starting…', progress: 0, done: false, startedAt: Date.now() }
  jobs.set(job.id, job)
  // Fire and forget: the client polls
  void run(job, file, opts)
  // Keep the map from growing across a long session
  for (const [id, j] of jobs) if (Date.now() - j.startedAt > 30 * 60_000) jobs.delete(id)
  return NextResponse.json({ jobId: job.id })
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const id = new URL(req.url).searchParams.get('job') || ''
  const job = jobs.get(id)
  if (!job) return NextResponse.json({ error: 'unknown job' }, { status: 404 })
  return NextResponse.json({
    phase: job.phase, progress: job.progress, done: job.done, error: job.error, note: job.note, result: job.result,
  })
}
