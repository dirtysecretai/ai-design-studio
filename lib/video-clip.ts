import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

// Shared ffmpeg helpers for training-clip preparation (GIF→MP4 conversion,
// thumbnails, duration probing). Every route importing this must be listed in
// next.config.ts `outputFileTracingIncludes` or the ffmpeg binary won't ship
// to Vercel.

const exec = promisify(execFile)

export function ffmpegAvailable(): boolean {
  return !!ffmpegPath
}

function parseDurationSec(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr)
  if (!m) return null
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
}

export async function probeDuration(file: string): Promise<number | null> {
  try {
    await exec(ffmpegPath as string, ['-hide_banner', '-i', file], { timeout: 30_000 })
    return null // ffmpeg -i with no output always exits non-zero
  } catch (e) {
    const err = e as { stderr?: string }
    return err.stderr ? parseDurationSec(err.stderr) : null
  }
}

// GIF (or any input) → browser/trainer-friendly H.264 MP4. yuv420p because
// GIF palettes decode to formats many players reject; even-dimension scale
// because H.264 requires it.
export async function gifToMp4(inFile: string, outFile: string): Promise<void> {
  await exec(ffmpegPath as string, [
    '-hide_banner', '-y',
    '-i', inFile,
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-an',
    outFile,
  ], { timeout: 240_000 })
}

// Grab a single representative frame (mid-clip) as a JPEG thumbnail — used
// for feed tiles and as the AutoFill captioning input for video rows.
export async function extractThumbnail(inFile: string, outJpg: string): Promise<void> {
  const dur = await probeDuration(inFile)
  const at = dur && dur > 0.4 ? dur / 2 : 0
  await exec(ffmpegPath as string, [
    '-hide_banner', '-y',
    '-ss', at.toFixed(3),
    '-i', inFile,
    '-frames:v', '1',
    '-q:v', '3',
    outJpg,
  ], { timeout: 60_000 })
}

export function clipTempName(dir: string, base: string, ext: string): string {
  return path.join(dir, `${base}.${ext}`)
}
