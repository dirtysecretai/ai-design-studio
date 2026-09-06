import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { jsonPrivate } from '@/lib/api-json'

// Personal nested-folder tree for the account reference library.
// Deleting a folder re-parents its contents (refs + child folders) to the
// deleted folder's parent — nothing inside is ever lost.

async function getAuthUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  return getUserFromSession(token)
}

const MAX_DEPTH = 20

// Walk up from parentId; returns false if a cycle is found or depth exceeded
async function isValidParentChain(userId: number, startId: number | null, selfId?: number): Promise<boolean> {
  let cur = startId
  let depth = 0
  while (cur !== null && depth < MAX_DEPTH) {
    if (selfId !== undefined && cur === selfId) return false // cycle
    const f = await prisma.userRefFolder.findFirst({
      where: { id: cur, userId },
      select: { parentId: true },
    })
    if (!f) return false // not found / not owned
    cur = f.parentId
    depth++
  }
  return cur === null
}

// POST — create folder { name, parentId? }
export async function POST(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''
    if (!name) return jsonPrivate({ error: 'Name required' }, { status: 400 })
    const parentId = typeof body.parentId === 'number' ? body.parentId : null

    if (parentId !== null && !(await isValidParentChain(user.id, parentId))) {
      return jsonPrivate({ error: 'Invalid parent folder' }, { status: 400 })
    }

    const folder = await prisma.userRefFolder.create({
      data: { userId: user.id, name, parentId },
      select: { id: true, name: true, parentId: true },
    })
    return jsonPrivate({ folder })
  } catch (error) {
    console.error('reference-folders POST error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// PATCH — rename and/or move { id, name?, parentId? }
export async function PATCH(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const id = typeof body?.id === 'number' ? body.id : null
    if (id === null) return jsonPrivate({ error: 'id required' }, { status: 400 })

    const existing = await prisma.userRefFolder.findFirst({ where: { id, userId: user.id } })
    if (!existing) return jsonPrivate({ error: 'Not found' }, { status: 404 })

    const data: { name?: string; parentId?: number | null } = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 60)
    if ('parentId' in body) {
      const parentId = typeof body.parentId === 'number' ? body.parentId : null
      // Reject moving a folder into itself or its own subtree (cycle check)
      if (parentId !== null && !(await isValidParentChain(user.id, parentId, id))) {
        return jsonPrivate({ error: 'Invalid parent folder' }, { status: 400 })
      }
      data.parentId = parentId
    }
    if (Object.keys(data).length === 0) return jsonPrivate({ error: 'Nothing to update' }, { status: 400 })

    const folder = await prisma.userRefFolder.update({
      where: { id },
      data,
      select: { id: true, name: true, parentId: true },
    })
    return jsonPrivate({ folder })
  } catch (error) {
    console.error('reference-folders PATCH error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE ?id= — re-parent contents to the deleted folder's parent, then delete
export async function DELETE(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const id = parseInt(searchParams.get('id') || '')
    if (isNaN(id)) return jsonPrivate({ error: 'id required' }, { status: 400 })

    const folder = await prisma.userRefFolder.findFirst({ where: { id, userId: user.id } })
    if (!folder) return jsonPrivate({ error: 'Not found' }, { status: 404 })

    await prisma.$transaction([
      prisma.userReference.updateMany({
        where: { folderId: id, userId: user.id },
        data: { folderId: folder.parentId },
      }),
      prisma.userRefFolder.updateMany({
        where: { parentId: id, userId: user.id },
        data: { parentId: folder.parentId },
      }),
      prisma.userRefFolder.delete({ where: { id } }),
    ])
    return jsonPrivate({ ok: true })
  } catch (error) {
    console.error('reference-folders DELETE error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}
