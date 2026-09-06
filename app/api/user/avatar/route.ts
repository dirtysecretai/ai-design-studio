import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { uploadToR2, deleteFromR2, userKey } from '@/lib/r2'
import { jsonPrivate } from '@/lib/api-json'

// Profile picture upload. The client crops the image to a square against the
// circular preview, then POSTs a JPEG data URL here. We decode it, store it on
// public R2, and save the URL on the user. Both profile circles read this URL.

async function getAuthUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  return getUserFromSession(token)
}

const MAX_BYTES = 6 * 1024 * 1024 // 6MB decoded — plenty for a 512px square JPEG

// POST { image: "data:image/jpeg;base64,..." } → { avatarUrl }
export async function POST(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => null)
    const dataUrl: string = typeof body?.image === 'string' ? body.image : ''
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/)
    if (!match) return jsonPrivate({ error: 'Invalid image data' }, { status: 400 })

    const contentType = match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length === 0) return jsonPrivate({ error: 'Empty image' }, { status: 400 })
    if (buffer.length > MAX_BYTES) return jsonPrivate({ error: 'Image too large' }, { status: 413 })

    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
    // Unguessable key (capability URL): the random token means the avatar can't be
    // enumerated by user id, so the URL is effectively private — only ever handed to
    // the owner's own session. The random segment also busts stale CDN edges.
    const key = `avatars/${user.id}/${randomUUID()}.${ext}`
    const avatarUrl = await uploadToR2(userKey(user.id, key), buffer, contentType)

    // Best-effort cleanup of the previous avatar (never blocks the response).
    const prev = (user as any).avatarUrl as string | null
    if (prev && prev !== avatarUrl) {
      deleteFromR2(prev).catch(() => {})
    }

    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl } })
    return jsonPrivate({ avatarUrl })
  } catch (error) {
    console.error('avatar POST error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE — remove the avatar
export async function DELETE() {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const prev = (user as any).avatarUrl as string | null
    if (prev) deleteFromR2(prev).catch(() => {})
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } })
    return jsonPrivate({ ok: true })
  } catch (error) {
    console.error('avatar DELETE error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}
