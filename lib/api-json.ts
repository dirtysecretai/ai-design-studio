import { NextResponse } from 'next/server'
import { signPayload } from './media-url'

/**
 * A JSON response with every private media URL signed.
 *
 * Use this instead of NextResponse.json in any route that returns a user's own
 * files. It walks the whole payload, so a media URL buried in a JSON metadata
 * column or a nested row is covered without anyone having to remember it is
 * there — which matters because forgetting is silent. The response still
 * carries a permanent-looking URL; it is just no longer one that works for
 * anybody but the person holding it, and not for long.
 *
 * Anything that is not on the private bucket is passed through untouched, so
 * it is always safe to reach for.
 */
export function jsonPrivate(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(signPayload(data), init)
}
