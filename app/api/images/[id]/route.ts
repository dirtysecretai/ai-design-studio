import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { uploadToR2 } from '@/lib/r2'
import { signMediaUrl } from '@/lib/media-url'
import sharp from 'sharp'


// Authenticated image proxy — serves a user's image by DB ID.
// The direct Vercel Blob URL is never exposed to the browser.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return new NextResponse('Unauthorized', { status: 401 })

    const user = await getUserFromSession(token)
    if (!user) return new NextResponse('Unauthorized', { status: 401 })

    const { id: idStr } = await params
    const id = parseInt(idStr)
    if (isNaN(id)) return new NextResponse('Invalid ID', { status: 400 })

    // Only serve images that belong to this user and are not deleted
    const image = await prisma.generatedImage.findFirst({
      where: { id, userId: user.id, isDeleted: false },
      select: { imageUrl: true, thumbnailUrl: true },
    })

    if (!image) return new NextResponse('Not found', { status: 404 })

    const searchParams = new URL(request.url).searchParams
    const isDownload = searchParams.get('download') === '1'
    const isThumb = searchParams.get('thumb') === '1'

    if (isThumb) {
      // Fast path: a thumbnail was already generated and stored on public R2 — the
      // feed normally uses that URL directly, but if this route is hit, redirect to it
      // (no full-image download, no resize).
      if (image.thumbnailUrl) {
        // Signed, not raw: the stored URL points at a bucket that no longer
        // answers to anonymous callers. Ownership was checked above.
        return NextResponse.redirect(signMediaUrl(image.thumbnailUrl), 302)
      }
      // First view of this image — generate the thumbnail once, store it on R2 so
      // every future request (this route or the direct URL) is a cheap CDN-served file.
      const blobRes = await fetch(image.imageUrl)
      if (!blobRes.ok) return new NextResponse('Image unavailable', { status: 404 })
      const buffer = Buffer.from(await blobRes.arrayBuffer())
      const thumb = await sharp(buffer)
        .resize({ width: 600, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer()
      // Persist for next time (best-effort — on failure we simply regenerate later)
      try {
        const thumbUrl = await uploadToR2(`thumb/${id}-${Date.now()}.webp`, Buffer.from(thumb), 'image/webp')
        await prisma.generatedImage.update({ where: { id }, data: { thumbnailUrl: thumbUrl } })
      } catch (storeErr) {
        console.error('Thumbnail store failed (non-fatal):', storeErr)
      }
      return new NextResponse(new Uint8Array(thumb), {
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, max-age=86400',
        },
      })
    }

    // Full image / download
    const blobRes = await fetch(image.imageUrl)
    if (!blobRes.ok) return new NextResponse('Image unavailable', { status: 404 })
    const contentType = blobRes.headers.get('content-type') || 'image/png'
    const ext = contentType.includes('jpeg') ? 'jpg'
              : contentType.includes('webp') ? 'webp'
              : contentType.includes('mp4')  ? 'mp4'
              : contentType.includes('webm') ? 'webm'
              : contentType.includes('video') ? 'mp4'
              : 'png'

    const headers: HeadersInit = {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
    }

    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="image-${id}.${ext}"`
    }

    return new NextResponse(blobRes.body, { status: 200, headers })
  } catch (error) {
    console.error('Image proxy error:', error)
    return new NextResponse('Server error', { status: 500 })
  }
}
