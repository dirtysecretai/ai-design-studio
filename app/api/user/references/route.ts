import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { getUserRefLimit } from '@/lib/ref-limits'
import { resolveRequestUser, requireScopes } from '@/lib/api-key-auth'
import { jsonPrivate } from '@/lib/api-json'
import { canonicalisePayload } from '@/lib/media-url'

// Account-scoped reference library (portal-v2 Refs dropdown).
// "Clear" is a soft delete (isCleared) — rows and R2 files are kept so
// admins can review everything ever uploaded (see /api/admin/references).

async function getAuthUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  return getUserFromSession(token)
}

// GET — full active library + folder tree + limit
export async function GET(req: Request) {
  try {
    const resolved = await resolveRequestUser(req)
    if ('error' in resolved) return resolved.error
    const { user, apiAuth } = resolved
    if (apiAuth) {
      const denied = requireScopes(apiAuth, 'references:read')
      if (denied) return denied
    }

    const [references, folders, limit] = await Promise.all([
      prisma.userReference.findMany({
        where: { userId: user.id, isCleared: false },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, url: true, folderId: true, createdAt: true },
      }),
      prisma.userRefFolder.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, parentId: true },
      }),
      getUserRefLimit(user.id, user.email),
    ])

    return jsonPrivate({ references, folders, limit, count: references.length })
  } catch (error) {
    console.error('references GET error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// POST — create rows for already-uploaded R2 URLs. Limit-checked atomically.
export async function POST(req: Request) {
  try {
    const resolved = await resolveRequestUser(req)
    if ('error' in resolved) return resolved.error
    const { user, apiAuth } = resolved
    if (apiAuth) {
      const denied = requireScopes(apiAuth, 'references:write')
      if (denied) return denied
    }

    const body = canonicalisePayload(await req.json())
    const items: { url?: unknown; folderId?: unknown }[] = Array.isArray(body?.items) ? body.items : []
    if (items.length === 0 || items.length > 100) {
      return jsonPrivate({ error: 'items must be 1-100 entries' }, { status: 400 })
    }

    // Only permanent https URLs — a base64 data URL here would recreate the
    // localStorage-bloat problem as DB bloat.
    const clean: { url: string; folderId: number | null }[] = []
    for (const it of items) {
      if (typeof it?.url !== 'string' || !it.url.startsWith('https://')) {
        return jsonPrivate({ error: 'Each item needs an https url' }, { status: 400 })
      }
      const folderId = typeof it.folderId === 'number' ? it.folderId : null
      clean.push({ url: it.url, folderId })
    }

    // Validate folder ownership for any referenced folders
    const folderIds = [...new Set(clean.map(c => c.folderId).filter((f): f is number => f !== null))]
    if (folderIds.length > 0) {
      const owned = await prisma.userRefFolder.count({ where: { id: { in: folderIds }, userId: user.id } })
      if (owned !== folderIds.length) {
        return jsonPrivate({ error: 'Invalid folder' }, { status: 400 })
      }
    }

    const limit = await getUserRefLimit(user.id, user.email)

    // Advisory lock serializes concurrent batches for the same user so two
    // simultaneous uploads can't both pass the count check and exceed the limit.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${user.id})`
      const count = await tx.userReference.count({ where: { userId: user.id, isCleared: false } })
      if (count + clean.length > limit) {
        throw Object.assign(new Error('limit'), { code: 'REF_LIMIT', count, limit })
      }
      const rows = []
      for (const c of clean) {
        rows.push(await tx.userReference.create({
          data: { userId: user.id, url: c.url, folderId: c.folderId },
          select: { id: true, url: true, folderId: true, createdAt: true },
        }))
      }
      return rows
    })

    return jsonPrivate({ references: created, limit })
  } catch (error: any) {
    if (error?.code === 'REF_LIMIT') {
      return jsonPrivate({ error: 'limit', limit: error.limit, count: error.count }, { status: 409 })
    }
    console.error('references POST error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// PATCH — move refs between folders
export async function PATCH(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const body = canonicalisePayload(await req.json())
    if (body?.action !== 'move') return jsonPrivate({ error: 'Unknown action' }, { status: 400 })
    const ids: number[] = Array.isArray(body.ids) ? body.ids.filter((n: unknown) => typeof n === 'number') : []
    if (ids.length === 0) return jsonPrivate({ error: 'ids required' }, { status: 400 })
    const folderId: number | null = typeof body.folderId === 'number' ? body.folderId : null

    if (folderId !== null) {
      const owned = await prisma.userRefFolder.count({ where: { id: folderId, userId: user.id } })
      if (owned === 0) return jsonPrivate({ error: 'Invalid folder' }, { status: 400 })
    }

    const result = await prisma.userReference.updateMany({
      where: { id: { in: ids }, userId: user.id, isCleared: false },
      data: { folderId },
    })
    return jsonPrivate({ moved: result.count })
  } catch (error) {
    console.error('references PATCH error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE — soft clear (?ids=1,2,3 or ?all=true). Never touches R2.
export async function DELETE(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const all = searchParams.get('all') === 'true'
    const ids = (searchParams.get('ids') || '')
      .split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n))

    if (!all && ids.length === 0) {
      return jsonPrivate({ error: 'ids or all=true required' }, { status: 400 })
    }

    const result = await prisma.userReference.updateMany({
      where: {
        userId: user.id,
        isCleared: false,
        ...(all ? {} : { id: { in: ids } }),
      },
      data: { isCleared: true, clearedAt: new Date() },
    })
    return jsonPrivate({ cleared: result.count })
  } catch (error) {
    console.error('references DELETE error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}
