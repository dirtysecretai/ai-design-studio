import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

// Failed generations are persistent, per-account feed tiles. The source of truth
// is the user's failed GenerationQueue rows; a tile only leaves the feed when the
// user dismisses it (dismissedAt).
//
// NOTE: dismissedAt was added out-of-band (prisma db push is broken on the dev
// machine), so the generated client doesn't know the column — all reads/writes
// touching it use raw SQL on purpose.

async function requireUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return user
}

// GET /api/user/failed-generations → the account's non-dismissed failures
export async function GET() {
  try {
    const user = await requireUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const rows = await prisma.$queryRaw<
      {
        id: number
        prompt: string
        modelId: string
        modelType: string
        errorMessage: string | null
        falRequestId: string | null
        parameters: any
        createdAt: Date
      }[]
    >`
      SELECT id, prompt, "modelId", "modelType", "errorMessage", "falRequestId", parameters, "createdAt"
      FROM "GenerationQueue"
      WHERE "userId" = ${user.id} AND status = 'failed' AND "dismissedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT 200`

    return NextResponse.json({
      success: true,
      fails: rows.map(r => ({
        id: r.id,
        prompt: r.prompt,
        modelId: r.modelId,
        modelType: r.modelType,
        error: r.errorMessage || 'Generation failed',
        falRequestId: r.falRequestId,
        // Full run settings from the queue row's parameters — the feed shows
        // them in the failed popup and Re-generate reuses them verbatim.
        // Two row shapes exist: client-failure rows store settings top-level;
        // submit-claim rows nest the raw fal payload under parameters.falInput
        // (aspect_ratio / resolution) — fall back to that or the panel is empty.
        aspectRatio: r.parameters?.aspectRatio || r.parameters?.size
          || r.parameters?.falInput?.aspect_ratio || null,
        quality: r.parameters?.quality || r.parameters?.falInput?.resolution || null,
        referenceImageUrls: Array.isArray(r.parameters?.referenceImageUrls)
          ? r.parameters.referenceImageUrls
          : Array.isArray(r.parameters?.permanentReferenceUrls)
            ? r.parameters.permanentReferenceUrls
            : [],
        createdAt: r.createdAt,
      })),
    })
  } catch (e: any) {
    console.error('failed-generations GET error:', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}

// PATCH { ids?: number[], falRequestIds?: string[] } → dismiss (hide permanently)
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json()
    const ids: number[] = Array.isArray(body.ids) ? body.ids.filter((n: any) => Number.isInteger(n)) : []
    const falIds: string[] = Array.isArray(body.falRequestIds) ? body.falRequestIds.filter((s: any) => typeof s === 'string' && s.length < 200) : []
    if (ids.length === 0 && falIds.length === 0) {
      return NextResponse.json({ error: 'Nothing to dismiss' }, { status: 400 })
    }

    let dismissed = 0
    if (ids.length > 0) {
      dismissed += await prisma.$executeRaw`
        UPDATE "GenerationQueue" SET "dismissedAt" = NOW()
        WHERE "userId" = ${user.id} AND id IN (${Prisma.join(ids)}) AND "dismissedAt" IS NULL`
    }
    if (falIds.length > 0) {
      dismissed += await prisma.$executeRaw`
        UPDATE "GenerationQueue" SET "dismissedAt" = NOW()
        WHERE "userId" = ${user.id} AND "falRequestId" IN (${Prisma.join(falIds)}) AND "dismissedAt" IS NULL`
    }
    return NextResponse.json({ success: true, dismissed })
  } catch (e: any) {
    console.error('failed-generations PATCH error:', e)
    return NextResponse.json({ error: 'Failed to dismiss' }, { status: 500 })
  }
}

// POST { prompt, modelId, modelType, error } → persist a client-observed failure
// that has no queue row (e.g. the submit request itself failed on the network)
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { prompt, modelId, modelType, error, aspectRatio, quality, referenceImageUrls, queuedAt, falRequestId } = await request.json()
    if (!prompt || !modelId || (modelType !== 'image' && modelType !== 'video')) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }

    // Idempotency: repeat reports of the same dead job (client retries, stale
    // slots re-failing after a reload) return the EXISTING row instead of
    // piling up duplicate error cards in the account's feed.
    if (typeof falRequestId === 'string' && falRequestId.length > 0 && falRequestId.length < 200) {
      const existing = await prisma.generationQueue.findFirst({
        where: { userId: user.id, falRequestId, status: 'failed' },
        select: { id: true },
      })
      if (existing) return NextResponse.json({ success: true, id: existing.id, deduped: true })
    }

    // createdAt = when the generation was QUEUED, not when the failure was
    // reported. Images are backdated to queue time; if fails were stamped at
    // failure time instead, a batch's errors would all sort ABOVE its images
    // after a refresh (fail time > queue time) and bury the real generations.
    const createdAtOverride = typeof queuedAt === 'number'
      && queuedAt > Date.now() - 24 * 3600 * 1000 && queuedAt <= Date.now() + 60_000
      ? new Date(queuedAt) : null

    const row = await prisma.generationQueue.create({
      data: {
        userId: user.id,
        modelId: String(modelId).slice(0, 100),
        modelType,
        prompt: String(prompt).slice(0, 5000),
        parameters: {
          source: 'client-failure',
          // Keep the run's settings so restored tiles show them + can retry
          ...(typeof aspectRatio === 'string' ? { aspectRatio: aspectRatio.slice(0, 20) } : {}),
          ...(typeof quality === 'string' ? { quality: quality.slice(0, 20) } : {}),
          ...(Array.isArray(referenceImageUrls)
            ? { referenceImageUrls: referenceImageUrls.filter((u: unknown) => typeof u === 'string' && (u as string).startsWith('https://')).slice(0, 10) }
            : {}),
        },
        status: 'failed',
        ticketCost: 0,
        errorMessage: String(error || 'Generation failed').slice(0, 2000),
        completedAt: new Date(),
        ...(createdAtOverride ? { createdAt: createdAtOverride } : {}),
        ...(typeof falRequestId === 'string' && falRequestId.length > 0 && falRequestId.length < 200
          ? { falRequestId } : {}),
      },
      select: { id: true },
    })
    return NextResponse.json({ success: true, id: row.id })
  } catch (e: any) {
    console.error('failed-generations POST error:', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
