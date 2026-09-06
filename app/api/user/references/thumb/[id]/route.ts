import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { uploadToR2, objectExists } from '@/lib/r2'
import { signMediaUrl } from '@/lib/media-url'
import sharp from 'sharp'

/**
 * A reference's thumbnail — made once, then served by the CDN forever.
 *
 * Reference tiles used to point `/_next/image` at the original file. The
 * originals in this library average 5.8MB and run to 22MB, so opening the Refs
 * dropdown asked the optimizer to download and re-encode a few hundred
 * megabytes before the first tile appeared. That is the whole reason the grid
 * paints slowly, and it got worse with every upload.
 *
 * Generated images already solved this (`GeneratedImage.thumbnailUrl`), but
 * UserReference has no column to remember the result in and this machine
 * cannot run migrations. It does not need one: the key is derived from the
 * reference id, so the answer to "has this been made yet?" is just whether the
 * object exists. Once it does, the browser is redirected straight to R2 and
 * this route stops being involved.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const key = (id: number) => `ref-thumb/${id}.webp`
/** The stored-URL shape signMediaUrl recognises as private media. */
const PRIVATE_PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  if (!user) return new NextResponse('Unauthorized', { status: 401 })

  const id = parseInt((await params).id, 10)
  if (!Number.isFinite(id)) return new NextResponse('Invalid id', { status: 400 })

  const ref = await prisma.userReference.findFirst({
    where: { id, userId: user.id },
    select: { url: true },
  })
  if (!ref) return new NextResponse('Not found', { status: 404 })

  // Already made — send the browser to the media Worker with a signed link.
  // Ownership was just checked above; the signature is what carries that
  // decision to the edge, which has no way to look it up itself.
  try {
    if (await objectExists(key(id))) {
      return NextResponse.redirect(signMediaUrl(`${PRIVATE_PREFIX}/${key(id)}`), {
        status: 302,
        headers: { 'Cache-Control': 'private, max-age=3600' },
      })
    }
  } catch {
    // A slow or unreachable bucket is not a reason to fail the tile; fall
    // through and generate, which also repairs a half-written object.
  }

  let source: Response
  try {
    source = await fetch(ref.url, { signal: AbortSignal.timeout(25_000) })
  } catch {
    return new NextResponse('Source unreachable', { status: 502 })
  }
  // 404 here is the dead-reference case: twenty of these still point at a
  // Vercel Blob store that no longer exists. Saying so plainly lets the tile
  // show "unavailable" instead of a browser broken-image glyph.
  if (!source.ok) return new NextResponse('Source gone', { status: 410 })

  let thumb: Buffer
  try {
    thumb = await sharp(Buffer.from(await source.arrayBuffer()))
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
  } catch {
    return new NextResponse('Not an image', { status: 415 })
  }

  // Best effort: if the upload fails the tile still paints, and the next view
  // simply makes it again.
  try {
    await uploadToR2(key(id), thumb, 'image/webp')
  } catch (err) {
    console.error('[ref thumb] store failed', id, err)
  }

  return new NextResponse(new Uint8Array(thumb), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=86400',
    },
  })
}
