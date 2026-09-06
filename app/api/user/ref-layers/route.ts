import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { jsonPrivate } from '@/lib/api-json'

// Dev-Tier multi-layer reference canvases. The layer stack lives in
// UserReference.layers (TEXT, added via out-of-band DDL — add-ref-layers.js),
// so all reads/writes here are raw SQL: the generated prisma client predates
// the column and regenerating requires stopping the dev server.
//
// Stack shape: { enabled: boolean, layers: [{ id, url, name, visible, opacity, auto? }] }
//  - url: permanent https URL (R2) — data URLs are rejected to avoid DB bloat
//  - opacity: 0..1;  auto: true when appended by a finished generation

const MAX_LAYERS = 20

async function getAuthUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  return getUserFromSession(token)
}

// GET — all layer stacks for the user's active refs: { stacks: { [refId]: stack } }
export async function GET() {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const rows = await prisma.$queryRaw<{ id: number; layers: string | null }[]>`
      SELECT "id", "layers" FROM "UserReference"
      WHERE "userId" = ${user.id} AND "isCleared" = false AND "layers" IS NOT NULL`

    const stacks: Record<string, unknown> = {}
    for (const r of rows) {
      if (!r.layers) continue
      try { stacks[String(r.id)] = JSON.parse(r.layers) } catch {}
    }
    return jsonPrivate({ stacks })
  } catch (error) {
    console.error('ref-layers GET error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}

// POST — full-replace one ref's stack: { refId, stack: { enabled, layers } | null }
export async function POST(req: Request) {
  try {
    const user = await getAuthUser()
    if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => null)
    const refId = typeof body?.refId === 'number' ? body.refId : parseInt(body?.refId)
    if (!refId || isNaN(refId)) return jsonPrivate({ error: 'refId required' }, { status: 400 })

    let serialized: string | null = null
    if (body.stack !== null && body.stack !== undefined) {
      const enabled = body.stack.enabled === true
      const rawLayers: unknown[] = Array.isArray(body.stack.layers) ? body.stack.layers : []
      if (rawLayers.length > MAX_LAYERS) {
        return jsonPrivate({ error: `Max ${MAX_LAYERS} layers` }, { status: 400 })
      }
      let totalItems = 0
      const layers = []
      for (const l of rawLayers as any[]) {
        // Items: placed images on this (transparent) layer. Also accepts the
        // v1 shape where the layer itself carried a single url.
        const rawItems: any[] = Array.isArray(l?.items) ? l.items : (typeof l?.url === 'string' ? [{ url: l.url }] : [])
        const items = []
        for (const it of rawItems) {
          if (typeof it?.url !== 'string' || !it.url.startsWith('https://')) {
            return jsonPrivate({ error: 'Each layer image needs an https url' }, { status: 400 })
          }
          totalItems++
          const hasRect = [it.x, it.y, it.w, it.h].every((v: unknown) => typeof v === 'number' && isFinite(v as number))
          items.push({
            id: typeof it.id === 'string' ? it.id.slice(0, 40) : `it-${totalItems}`,
            url: it.url,
            ...(hasRect ? {
              x: Math.max(-2, Math.min(2, it.x)),
              y: Math.max(-2, Math.min(2, it.y)),
              w: Math.max(0.005, Math.min(4, it.w)),
              h: Math.max(0.005, Math.min(4, it.h)),
            } : {}),
            ...(typeof it.r === 'number' && isFinite(it.r)
              ? { r: Math.round((((it.r % 360) + 360) % 360) * 100) / 100 }
              : {}),
          })
        }
        layers.push({
          id: typeof l.id === 'string' ? l.id.slice(0, 40) : String(Date.now()),
          name: typeof l.name === 'string' ? l.name.slice(0, 60) : 'Layer',
          visible: l.visible !== false,
          opacity: Math.min(1, Math.max(0, typeof l.opacity === 'number' ? l.opacity : 1)),
          ...(l.auto === true ? { auto: true } : {}),
          items,
        })
      }
      if (totalItems > 60) {
        return jsonPrivate({ error: 'Max 60 layer images total' }, { status: 400 })
      }
      serialized = JSON.stringify({
        enabled,
        layers,
        ...(body.stack.baseInLayer === true ? { baseInLayer: true } : {}),
        ...(typeof body.stack.baseW === 'number' && isFinite(body.stack.baseW) ? { baseW: Math.round(Math.max(1, Math.min(8192, body.stack.baseW))) } : {}),
        ...(typeof body.stack.baseH === 'number' && isFinite(body.stack.baseH) ? { baseH: Math.round(Math.max(1, Math.min(8192, body.stack.baseH))) } : {}),
      })
      if (serialized.length > 100_000) {
        return jsonPrivate({ error: 'Layer stack too large' }, { status: 413 })
      }
    }

    const updated = await prisma.$executeRaw`
      UPDATE "UserReference" SET "layers" = ${serialized}, "updatedAt" = NOW()
      WHERE "id" = ${refId} AND "userId" = ${user.id} AND "isCleared" = false`
    if (updated === 0) return jsonPrivate({ error: 'Reference not found' }, { status: 404 })

    return jsonPrivate({ ok: true })
  } catch (error) {
    console.error('ref-layers POST error:', error)
    return jsonPrivate({ error: 'Server error' }, { status: 500 })
  }
}
