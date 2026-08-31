import sharp from 'sharp'
import { uploadToR2 } from '@/lib/r2'

/**
 * Shrink reference images that a video model would reject outright.
 *
 * fal caps an input file at 10MB. A 2K NanoBanana PNG is routinely ~19MB and a
 * 4K one is far worse, so passing a freshly generated plate as a start frame
 * failed with:
 *
 *   422 "File size exceeds the maximum allowed size of 10485760 bytes"
 *
 * and — because fal reports the job COMPLETED and only throws when the result
 * is fetched — it read to every poller as a shot that was still rendering.
 * Three of four shots in a film died this way while the run waited on them.
 *
 * PNG is the wrong container for a photographic plate anyway: re-encoding to
 * high-quality JPEG loses nothing a video model can act on and typically costs
 * 80-90% of the bytes. Only oversized refs are touched, so an image that
 * already fits is passed through untouched and costs one HEAD request.
 */

/** fal's hard limit. */
const FAL_MAX_BYTES = 10 * 1024 * 1024
/** Leave headroom — the limit is on the upload, not on what we measured. */
const TARGET_BYTES = 8 * 1024 * 1024
/** Longest edge kept for a re-encode; 4K stays 4K, nothing is upscaled. */
const MAX_EDGE = 3840

async function byteSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    return len ? Number(len) || null : null
  } catch {
    return null
  }
}

/**
 * Returns a URL for the same picture that a video model will accept, or the
 * original when it already fits. Never throws: a ref that cannot be shrunk is
 * returned unchanged so the caller still gets the model's own error rather
 * than a failure inside this helper.
 */
export async function fitRefForVideo(url: string): Promise<string> {
  if (typeof url !== 'string' || !url.startsWith('https://')) return url

  const size = await byteSize(url)
  if (size !== null && size <= TARGET_BYTES) return url

  try {
    const res = await fetch(url)
    if (!res.ok) return url
    const input = Buffer.from(await res.arrayBuffer())
    // A HEAD without content-length (some CDNs) still lands here — check the
    // real bytes before spending CPU on a re-encode.
    if (input.byteLength <= TARGET_BYTES) return url

    const meta = await sharp(input).metadata()
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0)

    let out = await sharp(input)
      .resize(longest > MAX_EDGE ? { width: meta.width && meta.width >= (meta.height ?? 0) ? MAX_EDGE : undefined, height: meta.height && (meta.height > (meta.width ?? 0)) ? MAX_EDGE : undefined, fit: 'inside', withoutEnlargement: true } : undefined)
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer()

    // Still too big (very large or very noisy frames): step the quality down
    // rather than the resolution, which matters more to a video model.
    for (const q of [85, 78, 70]) {
      if (out.byteLength <= TARGET_BYTES) break
      out = await sharp(input)
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer()
    }
    if (out.byteLength > FAL_MAX_BYTES) return url

    const key = `video-refs/fit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    return await uploadToR2(key, out, 'image/jpeg')
  } catch {
    return url
  }
}

/** Fit a whole reference list, preserving order. */
export async function fitRefsForVideo(urls: string[]): Promise<string[]> {
  if (!Array.isArray(urls) || urls.length === 0) return []
  return Promise.all(urls.map(u => fitRefForVideo(u)))
}
