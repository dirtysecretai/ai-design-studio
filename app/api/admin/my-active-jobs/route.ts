import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'

// GET /api/admin/my-active-jobs
//
// The caller's own image generations that are still outstanding — queued
// (waiting for a slot) or processing (submitted to fal). The portal renders a
// placeholder tile per row, which is what makes a run survive a refresh: jobs
// belong to the account, so a fresh tab can pick up work it never started,
// including server-side batches no tab ever created slots for.
//
// Scoped to the session user, never to an id in the request.

export const runtime = 'nodejs'

/** A tab only needs enough to draw placeholders; this is not a queue console. */
const MAX_JOBS = 200

export async function GET() {
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const jobs = await prisma.generationQueue.findMany({
    where: {
      userId: user.id,
      modelType: 'image',
      status: { in: ['queued', 'processing'] },
    },
    select: {
      id: true, modelId: true, prompt: true, status: true,
      createdAt: true, parameters: true,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_JOBS,
  })

  return NextResponse.json({
    jobs: jobs.map(j => {
      const p = (j.parameters ?? {}) as Record<string, unknown>
      return {
        id: j.id,
        modelId: typeof p.model === 'string' ? p.model : j.modelId,
        prompt: j.prompt,
        status: j.status,
        createdAt: j.createdAt.toISOString(),
        aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : 'auto',
        quality: typeof p.quality === 'string' ? p.quality : undefined,
        referenceImageUrls: Array.isArray(p.referenceImageUrls)
          ? (p.referenceImageUrls as unknown[]).filter((u): u is string => typeof u === 'string')
          : [],
        batch: p.batch === true,
      }
    }),
  })
}
