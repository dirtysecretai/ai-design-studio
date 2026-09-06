// GET /api/prompting-studio/jobs
// Returns all in-flight (and recently settled) GenerationQueue records for the
// current user so the canvas can restore loading placeholders after a page refresh
// and enforce per-account concurrency limits.

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { jsonPrivate } from '@/lib/api-json'


export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const source = searchParams.get('source') // 'canvas' | 'main-scanner' | null
    // Explicitly tracked queue ids (the client's live placeholders): these are
    // returned regardless of the 2-hour settled window OR the source filter, so
    // a tracked tile can ALWAYS learn its job's fate — no more forever-spinners
    // when a job predates the window or was created without a source tag.
    const trackedIds = (searchParams.get('ids') ?? '')
      .split(',')
      .map(s => parseInt(s))
      .filter(n => Number.isInteger(n) && n > 0)
      .slice(0, 50)

    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) {
      return jsonPrivate({ error: 'Not authenticated' }, { status: 401 })
    }

    const user = await getUserFromSession(token)
    if (!user) {
      return jsonPrivate({ error: 'Invalid session' }, { status: 401 })
    }

    // Auto-fail PROVABLY-DEAD stuck jobs only. The old version force-failed
    // anything older than 10 minutes with NO provider check — so a user who
    // closed their tab mid-batch came back to find every job "timed out"
    // while fal had actually COMPLETED them (fal charged, tickets released,
    // images discarded — the worst possible outcome). Now a job with a fal
    // request id is verified first: still queued/running/completed at fal →
    // spared (the drain-queue cron harvests completed ones). Only jobs fal
    // doesn't know (404/GONE) or that have NO request id can be failed here.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    const staleCandidates = await prisma.generationQueue.findMany({
      where: {
        userId: user.id,
        status: { in: ['processing', 'queued'] },
        startedAt: { lt: tenMinutesAgo },
      },
      select: { id: true, ticketCost: true, falRequestId: true, parameters: true },
    })
    const provablyDead: { id: number; ticketCost: number }[] = []
    for (const j of staleCandidates.slice(0, 20)) {
      if (!j.falRequestId) { provablyDead.push(j); continue }
      try {
        const params = j.parameters as { falEndpoint?: string } | null
        const baseApp = (params?.falEndpoint || '').split('/').slice(0, 2).join('/')
        if (!baseApp || !process.env.FAL_KEY) continue // can't verify → spare
        const res = await fetch(`https://queue.fal.run/${baseApp}/requests/${j.falRequestId}/status`, {
          headers: { Authorization: `Key ${process.env.FAL_KEY}` },
          signal: AbortSignal.timeout(6000),
        })
        if (res.status === 404) { provablyDead.push(j); continue }
        // ok / in-progress / completed / transient error → spare
      } catch { /* unreachable — spare, re-checked next poll */ }
    }
    if (provablyDead.length > 0) {
      await prisma.generationQueue.updateMany({
        where: { id: { in: provablyDead.map(j => j.id) }, status: { in: ['processing', 'queued'] } },
        data: {
          status: 'failed',
          errorMessage: 'Generation timed out — please try again',
          completedAt: new Date(),
        },
      })
      const totalReserved = provablyDead.reduce((sum, j) => sum + j.ticketCost, 0)
      if (totalReserved > 0) {
        await prisma.ticket.update({
          where: { userId: user.id },
          data: { reserved: { decrement: totalReserved } },
        })
      }
    }

    // Fetch jobs that are still in-flight OR settled within the last 2 hours.
    // The 2-hour window lets the client resolve placeholders that completed
    // while the page was reloading, without returning stale old data.
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000)

    const allJobs = await prisma.generationQueue.findMany({
      where: {
        userId: user.id,
        modelType: 'image',
        OR: [
          { status: { in: ['processing', 'queued'] } },
          {
            status: { in: ['completed', 'failed'] },
            updatedAt: { gte: since },
          },
          ...(trackedIds.length > 0 ? [{ id: { in: trackedIds } }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    })

    // Filter jobs by source so each client only sees its own jobs.
    // Canvas jobs are identified by slotId or source='canvas'.
    // Main-scanner jobs include: explicitly tagged, OR jobs with falRequestId that
    // lack canvas markers (NB2/Kling/GPT-Image-2 from submit routes cross-device).
    const trackedIdSet = new Set(trackedIds)
    const jobs = allJobs.filter(j => {
      // Explicitly tracked ids always pass — the client is showing a tile for them
      if (trackedIdSet.has(j.id)) return true
      const params = j.parameters as any
      const isCanvasJob = params?.slotId != null || params?.source === 'canvas'
      if (source === 'main-scanner') {
        return params?.source === 'main-scanner' || (!isCanvasJob && j.falRequestId)
      }
      // Default (canvas): jobs tagged as canvas or with a slotId
      return isCanvasJob
    })

    const activeCount = jobs.filter(
      j => j.status === 'processing' || j.status === 'queued'
    ).length

    return jsonPrivate({ jobs, activeCount })
  } catch (error: any) {
    console.error('Jobs fetch error:', error)
    return jsonPrivate({ error: 'Failed to fetch jobs' }, { status: 500 })
  }
}
