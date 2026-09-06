/**
 * Server startup hooks.
 *
 * The one job here is teaching the server how to read its own private media.
 *
 * When the media bucket was public, ~140 server-side call sites could simply
 * `fetch(row.imageUrl)` — the thumbnailer, the video ref fitter, the ffmpeg
 * assembler, the chat image tools, every re-host path. The moment public
 * access is switched off, every one of those returns 401, and each would have
 * to be found and changed by hand. Missing one means a feature that silently
 * stops working in production.
 *
 * So instead of editing 140 call sites, the rewrite happens once, here. The
 * condition is deliberately as narrow as it can be: a URL is only touched if
 * it points at OUR private bucket, in which case it is signed exactly as it
 * would be for any other reader. Every other fetch in the process — fal,
 * Gemini, LemonSqueezy, R2's own S3 endpoint — is passed through untouched.
 */
export async function register() {
  // The edge runtime has its own module instance and none of these paths.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const g = globalThis as typeof globalThis & { __privateMediaFetchPatched?: boolean }
  if (g.__privateMediaFetchPatched) return
  g.__privateMediaFetchPatched = true

  const { isPrivateMedia, signMediaUrl, FAL_TTL } = await import('./lib/media-url')
  const original = globalThis.fetch

  globalThis.fetch = async function patchedFetch(input, init) {
    try {
      if (typeof input === 'string' && isPrivateMedia(input)) {
        input = signMediaUrl(input, FAL_TTL)
      } else if (input instanceof URL && isPrivateMedia(input.href)) {
        input = new URL(signMediaUrl(input.href, FAL_TTL))
      } else if (input instanceof Request && isPrivateMedia(input.url)) {
        input = new Request(signMediaUrl(input.url, FAL_TTL), input)
      }
    } catch {
      // Signing is an optimisation on the way to the same object; never let it
      // be the reason a request does not happen at all.
    }
    return original(input, init)
  }
}
