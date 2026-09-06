import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Signed URLs for private user media.
 *
 * Every generated image, video, 3D asset and reference used to live on a
 * world-readable R2 bucket. Anyone holding a URL could fetch it forever with
 * no session, and the thumbnail keys were the raw row id, so the whole library
 * was enumerable. Nothing about that was per-account.
 *
 * Now the bucket is private and the only way in is a URL this module signs.
 * Ownership is decided in Postgres, where it is actually known, at the moment
 * a URL is handed out; the edge only has to check that the signature is ours
 * and has not expired. That keeps the Worker stateless — no database, no KV,
 * nothing to fall out of sync — and it means none of the 86,000 objects
 * already in the bucket has to be moved or renamed for this to take effect.
 *
 * The signature covers the key AND the expiry, so neither can be edited: point
 * a signature at a different object, or push the expiry out, and it stops
 * matching.
 */

/** Where signed media is served from — the Cloudflare Worker in front of R2. */
export const MEDIA_HOST = (process.env.MEDIA_HOST || '').replace(/\/$/, '')

/**
 * The r2.dev prefix these objects were stored under while the bucket was
 * public. Still the shape held in the database, so it is how a stored value is
 * recognised as private media and turned into a key. Public access to it gets
 * switched off; nothing needs rewriting because the key is the part that
 * matters and it is unchanged.
 */
const LEGACY_PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

const SECRET = process.env.MEDIA_SIGNING_SECRET || ''

/** Browser-facing links. Long enough that a tab left open still works. */
export const BROWSER_TTL = 12 * 3600
/**
 * Links handed to fal. Short, because they leave our control entirely: they
 * end up in a third party's job record and logs. fal fetches inputs when the
 * job starts, so an hour is generous even for a ten-minute 3D render.
 */
export const FAL_TTL = 3600

/**
 * Expiries are rounded to the hour so the same object produces the SAME URL
 * for everyone for an hour at a time. Without this every request would mint a
 * unique URL, and a unique URL is a guaranteed cache miss in both the browser
 * and Cloudflare's edge — which would make private media dramatically slower
 * than the public bucket it replaced, on a feed that shows hundreds of tiles.
 */
function bucketedExpiry(ttlSeconds: number): number {
  const hour = 3600
  return (Math.floor(Date.now() / 1000 / hour) + Math.ceil(ttlSeconds / hour)) * hour
}

function sign(key: string, exp: number): string {
  return createHmac('sha256', SECRET).update(`${key}\n${exp}`).digest('base64url')
}

/** True for anything stored on the private bucket. */
export function isPrivateMedia(value: unknown): value is string {
  return typeof value === 'string' && !!LEGACY_PREFIX && value.startsWith(`${LEGACY_PREFIX}/`)
}

/** The R2 object key behind a stored URL, a signed URL, or a bare key. */
export function keyFromUrl(value: string): string {
  let v = value
  if (LEGACY_PREFIX && v.startsWith(`${LEGACY_PREFIX}/`)) v = v.slice(LEGACY_PREFIX.length + 1)
  else if (MEDIA_HOST && v.startsWith(`${MEDIA_HOST}/`)) v = v.slice(MEDIA_HOST.length + 1)
  else if (/^https?:\/\//i.test(v)) return v // not ours; hand it back untouched
  return v.split('?')[0].replace(/^\/+/, '')
}

/**
 * A signed, expiring URL for one object.
 *
 * Callers must have already established that the requester is allowed to see
 * it — this function does not and cannot know that. Anything not on the
 * private bucket (a fal.media result, a data URL, an already-signed link) is
 * returned untouched so it is always safe to run over a mixed list.
 */
export function signMediaUrl(stored: string, ttlSeconds = BROWSER_TTL): string {
  if (!stored || !MEDIA_HOST || !SECRET) return stored
  if (!isPrivateMedia(stored)) return stored
  const key = keyFromUrl(stored)
  const exp = bucketedExpiry(ttlSeconds)
  return `${MEDIA_HOST}/${key}?exp=${exp}&sig=${sign(key, exp)}`
}

/**
 * Sign every private URL inside an arbitrary API payload.
 *
 * Media URLs are scattered through nested rows, JSON metadata blobs and string
 * arrays across dozens of routes. Signing each field by hand would mean
 * finding all of them and never missing one again — and a miss is silent, it
 * just leaves a permanent public URL in a response. Walking the payload makes
 * the safe thing automatic.
 */
export function signPayload<T>(value: T, ttlSeconds = BROWSER_TTL): T {
  if (isPrivateMedia(value)) return signMediaUrl(value, ttlSeconds) as unknown as T
  if (Array.isArray(value)) return value.map(v => signPayload(v, ttlSeconds)) as unknown as T
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = signPayload(v, ttlSeconds)
    }
    return out as T
  }
  return value
}

/**
 * Verify a signature. Used by the Worker; exported here so the same code that
 * mints a URL is the code that checks it, and so it can be unit-tested without
 * deploying anything.
 */
export function verifyMediaSignature(key: string, exp: string | number, sig: string): boolean {
  if (!SECRET || !sig) return false
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false
  const expected = Buffer.from(sign(key, expNum))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * Turn a signed URL back into the canonical stored form.
 *
 * Signed URLs expire, so one must never reach the database — and they will try
 * to. The client is handed signed URLs to display, and it hands URLs back:
 * "use this generation as a reference for the next one", "save this frame to
 * my library". Persisting what came back would store a link that works for
 * twelve hours and is a dead string forever after.
 *
 * So every URL arriving from a client is put back into canonical form before
 * it is stored. Anything that is not one of ours is returned untouched.
 */
export function canonicalMediaUrl(value: string): string {
  if (!MEDIA_HOST || typeof value !== 'string') return value
  if (!value.startsWith(`${MEDIA_HOST}/`)) return value
  return `${LEGACY_PREFIX}/${keyFromUrl(value)}`
}

/** canonicalMediaUrl over a whole request payload. The mirror of signPayload. */
export function canonicalisePayload<T>(value: T): T {
  if (typeof value === 'string') return canonicalMediaUrl(value) as unknown as T
  if (Array.isArray(value)) return value.map(canonicalisePayload) as unknown as T
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = canonicalisePayload(v)
    return out as T
  }
  return value
}
