/**
 * media — the only way into the private R2 bucket.
 *
 * The app decides who may see what, because ownership lives in Postgres. This
 * Worker's whole job is to confirm that a URL was minted by the app and has
 * not expired, then hand back the bytes. It holds no state: no database, no
 * KV, nothing that can drift out of sync with the app, and nothing to migrate
 * the 86,000 objects already in the bucket for.
 *
 * The signature covers the key AND the expiry together, so a valid signature
 * cannot be moved to another object or given a later deadline.
 *
 * Deploy:  cd workers/media && npx wrangler deploy
 * Secret:  npx wrangler secret put MEDIA_SIGNING_SECRET   (same value as the app's)
 */

const encoder = new TextEncoder()

/** Constant-time compare — a fast reject would leak the signature a byte at a time. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function expectedSig(secret, key, exp) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`${key}\n${exp}`))
  // base64url, matching Node's digest('base64url') on the app side.
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const exp = url.searchParams.get('exp')
    const sig = url.searchParams.get('sig')

    if (!key || !exp || !sig) return new Response('Not found', { status: 404 })
    if (!env.MEDIA_SIGNING_SECRET) return new Response('Not configured', { status: 500 })

    // Expiry first: it is free, and it means an old link never reaches the
    // HMAC path at all.
    const expNum = Number(exp)
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) {
      return new Response('Link expired', { status: 403 })
    }
    if (!safeEqual(sig, await expectedSig(env.MEDIA_SIGNING_SECRET, key, expNum))) {
      return new Response('Bad signature', { status: 403 })
    }

    /*
     * Cache on the KEY ALONE, deliberately dropping exp and sig.
     *
     * Every visitor gets a different signature, so caching on the full URL
     * would never hit. Dropping them is safe because nothing reaches this line
     * without a valid signature — the cache is behind the check, not in front
     * of it. Without this, private media would be materially slower than the
     * public bucket it replaced, on feeds that render hundreds of tiles.
     */
    const cache = caches.default
    const cacheKey = new Request(`${url.origin}/${encodeURI(key)}`, { method: 'GET' })
    const hit = await cache.match(cacheKey)
    if (hit) return hit

    const range = request.headers.get('range')
    const object = await env.MEDIA_BUCKET.get(key, range ? { range: request.headers } : undefined)
    if (!object) return new Response('Not found', { status: 404 })

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('cache-control', 'private, max-age=3600')
    // The URL is the capability; nothing here should be embeddable elsewhere
    // just because it happens to be fetchable.
    headers.set('x-content-type-options', 'nosniff')
    headers.set('access-control-allow-origin', '*')

    // A ranged hit is a partial response and must not be stored as the whole
    // object — that is how a seeked video poisons the cache for everyone.
    if (object.range && range) {
      const size = object.size
      const start = object.range.offset ?? 0
      const end = start + (object.range.length ?? size) - 1
      headers.set('content-range', `bytes ${start}-${end}/${size}`)
      headers.set('accept-ranges', 'bytes')
      return new Response(object.body, { status: 206, headers })
    }

    headers.set('accept-ranges', 'bytes')
    const response = new Response(object.body, { status: 200, headers })
    ctx.waitUntil(cache.put(cacheKey, response.clone()))
    return response
  },
}
