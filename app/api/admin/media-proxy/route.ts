import { NextResponse } from 'next/server'

// GET /api/admin/media-proxy?url=<our-r2-url>
// Streams media from our own storage through this origin, passing Range
// through so <video> can seek. Exists so frame/clip extraction works from a
// dev origin that R2's CORS allow-list doesn't cover — a same-origin response
// never taints a canvas. Serves only already-public storage URLs.
//
// No auth: <img>/<video> elements cannot send the admin header, and every
// byte here is already publicly readable at its R2 URL. The host allow-list
// is what matters — it prevents this from becoming an SSRF gadget.

export const runtime = 'nodejs'
export const maxDuration = 60

const ALLOWED_HOSTS = ['pub-de315f4652054008be5f90bf09919f80.r2.dev']

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get('url') || ''
  let parsed: URL
  try { parsed = new URL(url) } catch { return NextResponse.json({ error: 'Invalid url' }, { status: 400 }) }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    return NextResponse.json({ error: 'URL host not allowed' }, { status: 403 })
  }

  const range = req.headers.get('range')
  try {
    const upstream = await fetch(parsed.toString(), {
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 })
    }
    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    })
    for (const h of ['content-length', 'content-range', 'etag']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    // Stream — never buffer; these can be 15-minute videos
    return new NextResponse(upstream.body, { status: upstream.status, headers })
  } catch {
    return NextResponse.json({ error: 'Proxy error' }, { status: 502 })
  }
}
