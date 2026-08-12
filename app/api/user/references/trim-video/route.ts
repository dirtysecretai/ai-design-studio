import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { getUserFromSession } from '@/lib/auth'
import { uploadToR2 } from '@/lib/r2'

// POST /api/user/references/trim-video — cut a hosted reference video down to
// a model's allowed input window (SeeDance 2.0: 2-15s, Kling Motion: ≤30s).
//
// Stream copy (-c copy), NOT re-encode: sub-second work even for big files,
// zero quality loss. Copy trims snap the START to the nearest earlier
// keyframe, which can overshoot the requested length — pass 2 tightens the
// cut if the output ran long, so the result always fits the model's cap.

export const runtime = 'nodejs'
export const maxDuration = 120

const exec = promisify(execFile)

function parseDurationSec(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr)
  if (!m) return null
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
}

async function probeDuration(file: string): Promise<number | null> {
  try {
    await exec(ffmpegPath as string, ['-hide_banner', '-i', file], { timeout: 30_000 })
    return null // ffmpeg -i with no output always exits non-zero
  } catch (e) {
    const err = e as { stderr?: string }
    return err.stderr ? parseDurationSec(err.stderr) : null
  }
}

export async function POST(req: Request) {
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!ffmpegPath) return NextResponse.json({ error: 'Trimming unavailable' }, { status: 500 })

  const body = await req.json().catch(() => ({})) as { url?: string; startSec?: number; endSec?: number; maxSec?: number }
  const { url } = body
  const startSec = Number(body.startSec)
  const endSec = Number(body.endSec)
  const maxSec = Math.min(35, Math.max(1, Number(body.maxSec) || 35))

  // Only OUR hosted media — this endpoint must not be a proxy for arbitrary URLs
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  if (typeof url !== 'string' || !publicBase || !url.startsWith(`${publicBase}/`)) {
    return NextResponse.json({ error: 'Invalid source URL' }, { status: 400 })
  }
  if (!isFinite(startSec) || !isFinite(endSec) || startSec < 0 || endSec <= startSec || endSec - startSec > maxSec + 0.5) {
    return NextResponse.json({ error: 'Invalid trim range' }, { status: 400 })
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'reftrim-'))
  try {
    // Fetch the source
    const srcRes = await fetch(url)
    if (!srcRes.ok) return NextResponse.json({ error: `Source fetch failed (${srcRes.status})` }, { status: 502 })
    const srcBytes = Buffer.from(await srcRes.arrayBuffer())
    if (srcBytes.length > 150 * 1024 * 1024) return NextResponse.json({ error: 'Source too large' }, { status: 413 })
    const ext = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'mp4'
    const inFile = path.join(dir, `in.${ext}`)
    // webm stays webm; everything else normalizes to mp4 output
    const outExt = ext === 'webm' ? 'webm' : 'mp4'
    const outFile = path.join(dir, `out.${outExt}`)
    await writeFile(inFile, srcBytes)

    const wanted = endSec - startSec
    const cut = async (lenSec: number) => {
      await exec(ffmpegPath as string, [
        '-hide_banner', '-y',
        '-ss', startSec.toFixed(3),
        '-i', inFile,
        '-t', lenSec.toFixed(3),
        '-c', 'copy',
        ...(outExt === 'mp4' ? ['-movflags', '+faststart'] : []),
        outFile,
      ], { timeout: 90_000 })
    }
    await cut(wanted)
    // Keyframe snap can make the output longer than requested — tighten once
    let outDur = await probeDuration(outFile)
    if (outDur !== null && outDur > maxSec + 0.15) {
      await cut(Math.max(1, wanted - (outDur - maxSec) - 0.1))
      outDur = await probeDuration(outFile)
      if (outDur !== null && outDur > maxSec + 0.3) {
        // Copy can't cut tighter (sparse keyframes) — precise re-encode fallback
        await exec(ffmpegPath as string, [
          '-hide_banner', '-y',
          '-ss', startSec.toFixed(3),
          '-i', inFile,
          '-t', Math.min(wanted, maxSec).toFixed(3),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
          '-c:a', 'aac', '-movflags', '+faststart',
          path.join(dir, 'out.mp4'),
        ], { timeout: 110_000 })
        outDur = await probeDuration(path.join(dir, 'out.mp4'))
        const bytes = await readFile(path.join(dir, 'out.mp4'))
        const key = `references/trims/${user.id}-${randomUUID()}.mp4`
        const outUrl = await uploadToR2(key, bytes, 'video/mp4')
        return NextResponse.json({ url: outUrl, duration: outDur ?? Math.min(wanted, maxSec) })
      }
    }

    const bytes = await readFile(outFile)
    const key = `references/trims/${user.id}-${randomUUID()}.${outExt}`
    const outUrl = await uploadToR2(key, bytes, outExt === 'webm' ? 'video/webm' : 'video/mp4')
    return NextResponse.json({ url: outUrl, duration: outDur ?? wanted })
  } catch (err) {
    console.error('trim-video error:', err)
    return NextResponse.json({ error: 'Trim failed — the source format may not support stream cutting' }, { status: 500 })
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
