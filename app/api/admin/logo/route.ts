import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { uploadToR2, uploadPublicAsset, deleteFromR2 } from '@/lib/r2'

// Site logo upload. ADMIN ONLY. The client frames the image in the crop modal,
// then POSTs a PNG data URL here (PNG keeps logo transparency). Stored on public
// R2 and saved to SystemState.logoUrl — every visitor's header reads it, but only
// admins can change it. Public read happens via /api/admin/config.

async function getAdminUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  const user = await getUserFromSession(token)
  if (!user) return null
  if (!(await checkIsAdmin(user.email))) return null
  return user
}

const MAX_BYTES = 8 * 1024 * 1024 // 8MB decoded

// POST { image: "data:image/png;base64,..." } → { logoUrl }
export async function POST(req: Request) {
  try {
    const admin = await getAdminUser()
    if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const body = await req.json().catch(() => null)
    const dataUrl: string = typeof body?.image === 'string' ? body.image : ''
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
    if (!match) return NextResponse.json({ error: 'Invalid image data' }, { status: 400 })

    const contentType = match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length === 0) return NextResponse.json({ error: 'Empty image' }, { status: 400 })
    if (buffer.length > MAX_BYTES) return NextResponse.json({ error: 'Image too large' }, { status: 413 })

    const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png'
    const key = `branding/logo-${randomUUID()}.${ext}`
    const logoUrl = await uploadPublicAsset(key, buffer, contentType)

    const existing = await prisma.systemState.findFirst()
    const prev = existing?.logoUrl ?? null
    if (existing) {
      await prisma.systemState.update({ where: { id: existing.id }, data: { logoUrl } })
    } else {
      await prisma.systemState.create({ data: { logoUrl } })
    }
    if (prev && prev !== logoUrl) deleteFromR2(prev).catch(() => {})

    return NextResponse.json({ logoUrl })
  } catch (error) {
    console.error('logo POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE — remove the site logo (admin only)
export async function DELETE() {
  try {
    const admin = await getAdminUser()
    if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const existing = await prisma.systemState.findFirst()
    if (existing?.logoUrl) {
      deleteFromR2(existing.logoUrl).catch(() => {})
      await prisma.systemState.update({ where: { id: existing.id }, data: { logoUrl: null } })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('logo DELETE error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
