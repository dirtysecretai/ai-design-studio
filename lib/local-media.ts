import path from 'path'
import { stat } from 'fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const exec = promisify(execFile)

// Shared guards for the Slicing Studio's "Movies" mode, which slices video
// files sitting on a drive attached to the machine running this server rather
// than anything uploaded to R2. A 40GB remux never has to move.
//
// This is deliberately a LOCAL-ONLY capability:
//   - it is refused outright on Vercel (no such drive exists there, and
//     filesystem reads driven by a request parameter have no business running
//     on a shared host)
//   - callers must already be admin-authenticated
//   - only known video extensions resolve
//   - MOVIE_ROOTS (comma-separated absolute paths) restricts which folders are
//     reachable; without it, any absolute path on this machine is allowed,
//     which is fine for a local dev tool but is why the Vercel check exists.

export const VIDEO_EXTS = ['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.webm', '.mpg', '.mpeg', '.ts', '.wmv', '.flv']

export function localMediaDisabled(): string | null {
  if (process.env.VERCEL) return 'Movie mode runs only on a local server with the drive attached'
  return null
}

function allowedRoots(): string[] {
  return (process.env.MOVIE_ROOTS || '')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => path.resolve(r))
}

/** Resolve a caller-supplied path, or throw with a safe message. */
export function safeResolve(input: string, opts: { mustBeVideo?: boolean } = {}): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path required')
  // NB: do NOT strip backslashes here — they are Windows path separators
  if (input.includes('\0')) throw new Error('invalid path')
  const resolved = path.resolve(input)
  const roots = allowedRoots()
  if (roots.length > 0 && !roots.some(r => resolved === r || resolved.startsWith(r + path.sep))) {
    throw new Error('path is outside MOVIE_ROOTS')
  }
  if (opts.mustBeVideo && !VIDEO_EXTS.includes(path.extname(resolved).toLowerCase())) {
    throw new Error('not a video file')
  }
  return resolved
}

export async function fileInfo(p: string): Promise<{ size: number; mtime: number } | null> {
  try {
    const st = await stat(p)
    if (!st.isFile()) return null
    return { size: st.size, mtime: st.mtimeMs }
  } catch { return null }
}

export interface MovieProbe {
  duration: number
  width: number
  height: number
  codec: string
  fps: number
  /** HDR source (PQ/HLG or BT.2020) — output needs tone-mapping to look right */
  hdr: boolean
  /** Whether a browser can play this container/codec directly in <video> */
  playable: boolean
}

/** ffmpeg -i parse. Cheap even on a 40GB file: it only reads the header. */
export async function probeMovie(file: string): Promise<MovieProbe> {
  let out = ''
  try {
    await exec(ffmpegPath as string, ['-hide_banner', '-i', file], { timeout: 30_000, maxBuffer: 8 << 20 })
  } catch (e) {
    // ffmpeg exits non-zero when given no output target — the info we want is
    // on stderr either way
    out = String((e as { stderr?: string }).stderr || '')
  }
  const dm = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0
  const vm = out.match(/Stream #\d+:\d+.*?: Video:\s*([a-zA-Z0-9_]+).*?,\s*(\d{2,5})x(\d{2,5})/)
  const fm = out.match(/,\s*([\d.]+)\s*fps/)
  const codec = vm?.[1] ?? 'unknown'
  const hdr = /smpte2084|arib-std-b67|bt2020/i.test(out)
  const ext = path.extname(file).toLowerCase()
  return {
    duration,
    width: vm ? parseInt(vm[2]) : 0,
    height: vm ? parseInt(vm[3]) : 0,
    codec,
    fps: fm ? parseFloat(fm[1]) : 0,
    hdr,
    // MKV never plays in Safari; h264/h265 in mp4/mov generally does
    playable: ['.mp4', '.m4v', '.mov', '.webm'].includes(ext) && ['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(codec),
  }
}

/**
 * Video filter chain for anything we hand back to a browser or save as a still.
 * For an HDR source this converts PQ/HLG BT.2020 down to BT.709 SDR properly
 * (linearise → tone-map → re-encode); simply tagging it bt709 would leave the
 * picture grey and lifeless. SDR sources just get the scale.
 */
export function sdrChain(hdr: boolean, scaleExpr: string): string {
  if (!hdr) return `${scaleExpr},format=yuv420p`
  return [
    scaleExpr,
    'zscale=t=linear:npl=100',
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
  ].join(',')
}

export const hhmmss = (sec: number): string => {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s - h * 3600 - m * 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${r.toFixed(3).padStart(6, '0')}`
}
