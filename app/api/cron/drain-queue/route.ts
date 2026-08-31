import { after, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { promoteNextQueuedJob, FAL_GLOBAL_ID } from '@/lib/fal-queue'
import { syncActiveCounters } from '@/app/api/admin/queue/stats/route'
import { processChunk, getBaseUrl } from '@/app/api/admin/auto-caption/jobs/_processor'
import { uploadToR2 } from '@/lib/r2'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'

// Jobs stuck in 'processing' longer than this are CANDIDATES for being reset.
// Was 10 minutes, which force-failed jobs fal was still happily running —
// NB2 edit jobs routinely take 6-11 min and video models far longer, so live
// work was being destroyed and refunded. Nothing is failed now without asking
// fal first (see verifyWithFal below); this is just the "worth checking" line.
// 12 (was 25): verifyWithFal makes a low line SAFE — live jobs are always
// spared — while a dead poller's COMPLETED job gets harvested well inside
// NanoBanana's ~1h result purge. At 25 min a job that finished in 2 min but
// lost its poller (page reload) raced the purge and often lost the image.
const STALE_MINUTES = 12
// Video generation is legitimately slow — give it a much longer leash
const STALE_MINUTES_VIDEO = 60

/**
 * GET /api/cron/drain-queue
 *
 * Called by Vercel Cron every minute (see vercel.json).
 *
 * Safety model:
 *  - Does NOT call syncActiveCounters() unconditionally. That function does a
 *    SET operation which races with webhook DECREMENTs and causes counter drift.
 *  - ONLY calls syncActiveCounters() after forcefully failing confirmed-dead
 *    jobs (> STALE_MINUTES in processing). Those jobs will never receive a
 *    webhook, so no pending DECREMENTs exist — the SET is safe.
 *  - Slot promotion uses the atomic updateMany (currentActive < maxConcurrent)
 *    inside promoteNextQueuedJob, which is safe under concurrent webhook calls.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // ── 1. Reset stale jobs ──────────────────────────────────────────────────
    // Mark any job that has been in 'processing' for > STALE_MINUTES as failed.
    // These jobs will never receive a webhook callback (FAL timeout is < 30 min),
    // so their slots are permanently leaked.  After failing them it is safe to
    // sync the counter because no in-flight webhook decrements exist for them.
    const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000)

    const staleCandidates = await prisma.generationQueue.findMany({
      where: { status: 'processing', startedAt: { lt: staleThreshold } },
      select: {
        id: true, modelType: true, startedAt: true, falRequestId: true, parameters: true,
        userId: true, modelId: true, prompt: true, ticketCost: true, createdAt: true,
      },
    })

    // NEVER fail a job fal is still running (or has finished). Ask fal for the
    // truth first — a "stuck" job is usually just slow, and killing it threw
    // away a completed image AND refunded the user for work we actually paid
    // for. Only jobs fal reports as gone/failed (or that we can't identify) are
    // reset. Unreachable fal = leave it alone and re-check next minute.
    const verifyWithFal = async (j: typeof staleCandidates[number]): Promise<'completed' | 'alive' | 'dead' | 'unknown'> => {
      const params = j.parameters as { falEndpoint?: string } | null
      const ep = params?.falEndpoint
      if (!j.falRequestId || !ep || !process.env.FAL_KEY) return 'dead' // never submitted → safe to fail
      try {
        // fal status lives under owner/app — sub-paths like /edit 405
        const baseApp = ep.split('/').slice(0, 2).join('/')
        const res = await fetch(`https://queue.fal.run/${baseApp}/requests/${j.falRequestId}/status`, {
          headers: { Authorization: `Key ${process.env.FAL_KEY}` },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) return res.status === 404 ? 'dead' : 'unknown'
        const d = await res.json() as { status?: string }
        if (d.status === 'COMPLETED') return 'completed'
        if (d.status === 'IN_PROGRESS' || d.status === 'IN_QUEUE') return 'alive'
        return 'dead'
      } catch { return 'unknown' }
    }

    const toFail: number[] = []
    const toHarvest: typeof staleCandidates = []
    let sparedAlive = 0
    for (const j of staleCandidates) {
      // Video gets a much longer grace period before we even consider it stale
      const limitMin = j.modelType === 'video' ? STALE_MINUTES_VIDEO : STALE_MINUTES
      if (j.startedAt && Date.now() - j.startedAt.getTime() < limitMin * 60 * 1000) continue
      const verdict = await verifyWithFal(j)
      if (verdict === 'dead') toFail.push(j.id)
      else if (verdict === 'completed') { toHarvest.push(j); sparedAlive++ }
      else sparedAlive++
    }

    let staleReset = 0
    if (toFail.length > 0) {
      await prisma.generationQueue.updateMany({
        where: { id: { in: toFail } },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'Auto-reset by cron: provider reports the job is no longer running',
        },
      })
      // Safe to sync here — no pending webhook decrements for these dead jobs
      await syncActiveCounters()
      staleReset = toFail.length
      console.log(`[cron-drain] Reset ${staleReset} confirmed-dead job(s); spared ${sparedAlive} still live at fal`)
    } else if (sparedAlive > 0) {
      console.log(`[cron-drain] ${sparedAlive} long-running job(s) still alive at fal — left running`)
    }

    // ── 1a-video. Settle finished video PROMPTLY, not after an hour ─────────
    // The harvest below only sees jobs already past the stale threshold, which
    // for video is 60 minutes. A shot submitted from the chat renders in a
    // couple of minutes and then, with no tab open to poll it, sat untouched
    // for the rest of that hour — the render was safe but the film could not
    // continue. Anything past a short grace period (long enough not to race a
    // live poller) gets settled here on the next cron tick instead.
    const VIDEO_SETTLE_GRACE_MS = 2 * 60 * 1000
    let videoSettled = 0
    try {
      const liveVideo = await prisma.generationQueue.findMany({
        where: {
          modelType: 'video',
          status: 'processing',
          startedAt: { lt: new Date(Date.now() - VIDEO_SETTLE_GRACE_MS) },
        },
        select: {
          id: true, falRequestId: true, parameters: true, modelId: true,
          prompt: true, ticketCost: true, createdAt: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 8,
      })
      for (const j of liveVideo) {
        const vp = (j.parameters ?? {}) as { falEndpoint?: string; usePolling?: boolean }
        if (!vp.usePolling || !j.falRequestId || !vp.falEndpoint) continue
        // Someone already saved it — just settle the row
        const already = await prisma.generatedImage.count({ where: { falRequestId: j.falRequestId } })
        if (already > 0) {
          await releaseQueueSlot(j.falRequestId, false).catch(() => {})
          videoSettled++
          continue
        }
        try {
          const { NextRequest } = await import('next/server')
          const { POST: videoStatus } = await import('@/app/api/video/status/route')
          const res = await videoStatus(new NextRequest('http://internal/api/video/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: j.falRequestId,
              falEndpoint: vp.falEndpoint,
              prompt: j.prompt,
              model: j.modelId,
              ticketCost: j.ticketCost,
              queuedAt: j.createdAt?.getTime(),
            }),
          }))
          const data = (await res.json()) as { status?: string }
          if (data?.status === 'completed' || data?.status === 'failed') videoSettled++
        } catch (e) {
          // Still rendering, or a transient fal error — next tick tries again
        }
      }
      if (videoSettled > 0) console.log(`[cron-drain] settled ${videoSettled} video job(s)`)
    } catch (e) {
      console.error('[cron-drain] video settle pass failed:', e)
    }

    // ── 1a-harvest. Save completed-at-fal jobs nobody is polling ─────────────
    // A job that fal COMPLETED but that is still 'processing' after the stale
    // threshold means the polling client is gone (tab closed mid-batch). We
    // already paid fal for it — before this existed the row sat until fal
    // purged the result and it eventually failed+refunded: pay fal AND refund
    // the user AND lose the image. Now the cron finishes the client's job:
    // fetch the result, re-host to R2, save GeneratedImage rows (queue-time
    // createdAt keeps feed order), settle the row via releaseQueueSlot.
    // Zero images returned = the model refused (content filter) — fail+refund,
    // exactly what the live poller does. Image polling-jobs only; capped per
    // run to stay inside the function budget (cron re-runs every minute).
    // Newest first: fresh results are the ones fal still has — old rows whose
    // results 504/expired must not head-of-line-block recoverable ones.
    toHarvest.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
    let harvested = 0
    for (const j of toHarvest.slice(0, 6)) {
      const params = j.parameters as {
        falEndpoint?: string
        falInput?: { aspect_ratio?: string; resolution?: string; output_format?: string }
        permanentReferenceUrls?: string[]
        usePolling?: boolean
      } | null
      if (!params?.usePolling || !j.falRequestId || !params.falEndpoint) continue
      if (j.modelType !== 'image' && j.modelType !== 'video') continue

      // Video settles through /api/video/status's handler, which owns the R2
      // re-host, the GeneratedImage row and releaseQueueSlot. Same trick as the
      // chat submit path: call it as a function, no HTTP hop.
      if (j.modelType === 'video') {
        try {
          const already = await prisma.generatedImage.count({ where: { falRequestId: j.falRequestId } })
          if (already > 0) {
            await releaseQueueSlot(j.falRequestId, false).catch(() => {})
            harvested++
            continue
          }
          const { NextRequest } = await import('next/server')
          const { POST: videoStatus } = await import('@/app/api/video/status/route')
          const res = await videoStatus(new NextRequest('http://internal/api/video/status', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // No session here — settle as the job's owner.
              ...(process.env.CRON_SECRET
                ? { 'x-internal-key': process.env.CRON_SECRET, 'x-internal-user': String(j.userId) }
                : {}),
            },
            body: JSON.stringify({
              requestId: j.falRequestId,
              falEndpoint: params.falEndpoint,
              prompt: j.prompt,
              model: j.modelId,
              ticketCost: j.ticketCost,
              queuedAt: j.createdAt?.getTime(),
            }),
          }))
          const data = (await res.json()) as { status?: string }
          if (data?.status === 'completed' || data?.status === 'failed') harvested++
          console.log(`[cron] video harvest #${j.id} (${j.modelId}) → ${data?.status ?? 'unknown'}`)
        } catch (e) {
          console.error(`[cron] video harvest failed for #${j.id}:`, e)
        }
        continue
      }

      try {
        // Idempotency: if images for this request were already saved (client
        // came back and harvested first), just settle the row.
        const already = await prisma.generatedImage.count({ where: { falRequestId: j.falRequestId } })
        if (already > 0) {
          await releaseQueueSlot(j.falRequestId, false)
          harvested++
          continue
        }
        const baseApp = params.falEndpoint.split('/').slice(0, 2).join('/')
        const res = await fetch(`https://queue.fal.run/${baseApp}/requests/${j.falRequestId}`, {
          headers: { Authorization: `Key ${process.env.FAL_KEY}` },
          signal: AbortSignal.timeout(15000),
        })
        if (res.status === 422) {
          // COMPLETED status but 422 result = the model finished WITHOUT usable
          // output (content filter / validation refusal). Permanent — fail+refund.
          await releaseQueueSlot(j.falRequestId, true, 'The model did not generate the expected output — content may have been filtered')
          continue
        }
        if (res.status === 404 || res.status === 410) {
          // Result purged by fal before we could harvest it — image is gone.
          await releaseQueueSlot(j.falRequestId, true, 'Generation result expired before it could be saved')
          continue
        }
        if (!res.ok) {
          // 5xx: usually transient — but NanoBanana results expire at fal on
          // the order of an hour, after which the result endpoint 500/504s
          // permanently. A COMPLETED row whose result has been unfetchable
          // this long is unrecoverable: settle it (fail+refund) instead of
          // sparing it forever.
          const ageMs = Date.now() - (j.startedAt?.getTime() ?? j.createdAt.getTime())
          if (ageMs > 2 * 60 * 60 * 1000) {
            await releaseQueueSlot(j.falRequestId, true, 'Generation result expired before it could be saved')
          }
          continue // young rows: transient, retry next minute
        }
        const data = await res.json() as { images?: { url: string; width?: number; height?: number }[] }
        const falImages = Array.isArray(data?.images) ? data.images : []
        if (falImages.length === 0) {
          await releaseQueueSlot(j.falRequestId, true, 'The model did not generate the expected output — content may have been filtered')
          continue
        }
        const format = params.falInput?.output_format || 'png'
        const saved: string[] = []
        for (let i = 0; i < falImages.length; i++) {
          try {
            const imgRes = await fetch(falImages[i].url, { signal: AbortSignal.timeout(30000) })
            if (!imgRes.ok) continue
            const buffer = Buffer.from(await imgRes.arrayBuffer())
            const ext = format === 'jpeg' ? 'jpg' : format
            const url = await uploadToR2(`nb2-${Date.now()}-${i}.${ext}`, buffer, `image/${format === 'jpeg' ? 'jpeg' : format}`)
            await prisma.generatedImage.create({
              data: {
                userId:             j.userId,
                prompt:             j.prompt || '',
                imageUrl:           url,
                model:              j.modelId,
                ticketCost:         j.ticketCost,
                quality:            params.falInput?.resolution || 'auto',
                aspectRatio:        params.falInput?.aspect_ratio || 'auto',
                referenceImageUrls: Array.isArray(params.permanentReferenceUrls) ? params.permanentReferenceUrls : [],
                expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                falRequestId:       j.falRequestId,
                createdAt:          j.createdAt, // queue time — the feed's ordering key
              },
            })
            saved.push(url)
          } catch (imgErr) {
            console.error(`[cron-drain] harvest: image ${i} of ${j.falRequestId} failed:`, imgErr)
          }
        }
        if (saved.length > 0) {
          await prisma.generationQueue.update({
            where: { id: j.id },
            data: { resultUrl: saved[0] },
          }).catch(() => {})
          await releaseQueueSlot(j.falRequestId, false)
          harvested++
          console.log(`[cron-drain] Harvested ${saved.length} image(s) for orphaned job ${j.falRequestId}`)
        }
        // saved.length === 0 with images present = R2/network hiccup → leave
        // 'processing', retried next minute
      } catch (harvestErr) {
        console.error(`[cron-drain] harvest error for ${j.falRequestId}:`, harvestErr)
      }
    }

    // ── 1b. Sweep orphaned 'pending' claims ─────────────────────────────────
    // 'pending' rows are atomic user-slot claims made at submit time (see
    // claimUserGenerationRow). They live for a second or two before flipping
    // to queued/processing — one older than 10 minutes means the function
    // crashed mid-submit. Fail it (frees the user's slot) and refund IF the
    // row was marked charged (parameters.chargeMode) before the crash.
    const stalePending = await prisma.generationQueue.findMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
      select: { id: true, userId: true, ticketCost: true, parameters: true },
    })
    for (const p of stalePending) {
      const settled = await prisma.generationQueue.updateMany({
        where: { id: p.id, status: 'pending' }, // guard: exactly-once even across cron overlaps
        data: { status: 'failed', completedAt: new Date(), errorMessage: 'Submission was interrupted — not charged' },
      })
      if (settled.count === 0) continue
      const params = p.parameters as { chargeMode?: string } | null
      if (params?.chargeMode === 'deduct' && p.ticketCost > 0) {
        await prisma.ticket.update({
          where: { userId: p.userId },
          data: { balance: { increment: p.ticketCost } },
        }).catch(() => {})
      }
    }
    if (stalePending.length > 0) console.log(`[cron-drain] Swept ${stalePending.length} orphaned pending claim(s)`)

    // ── 2. Promote queued jobs into free slots ───────────────────────────────
    // Read current state.  If stale reset happened the counter was just synced;
    // otherwise we trust the stored counter (avoid the SET/DECREMENT race).
    const [globalLimit, queuedCount] = await Promise.all([
      prisma.modelConcurrencyLimit.findUnique({ where: { modelId: FAL_GLOBAL_ID } }),
      prisma.generationQueue.count({ where: { status: 'queued' } }),
    ])

    let promoted = 0
    if (globalLimit && queuedCount > 0) {
      const freeSlots = Math.max(0, globalLimit.maxConcurrent - globalLimit.currentActive)
      const toPromote = Math.min(freeSlots, queuedCount)
      if (toPromote > 0) {
        // Fill all free slots concurrently.  The retry loop inside promoteNextQueuedJob
        // ensures each concurrent call claims a different queued job.
        await Promise.all(
          Array.from({ length: toPromote }, () =>
            promoteNextQueuedJob().catch(e => console.error('[cron-drain] promote error:', e))
          )
        )
        promoted = toPromote
        console.log(`[cron-drain] Promoted ${toPromote} queued job(s)`)
      }
    }

    // ── 3. Re-kick stuck AutoFill caption jobs ───────────────────────────────
    // AutoFill jobs chain chunks via an HTTP self-call. If that call fails, the
    // job stays 'running' but nothing processes it. Re-kick any job that hasn't
    // updated in 90 seconds so the chain resumes without user intervention.
    // This runs unconditionally — autofill must survive even when the image queue is idle.
    const autofillStuckThreshold = new Date(Date.now() - 90_000)
    const stuckAutofillJobs = await prisma.autoFillJob.findMany({
      where:  { status: 'running', updatedAt: { lt: autofillStuckThreshold } },
      select: { id: true },
    })
    if (stuckAutofillJobs.length > 0) {
      const baseUrl = getBaseUrl(request)
      for (const job of stuckAutofillJobs) {
        after(async () => { await processChunk(job.id, baseUrl) })
      }
      console.log(`[cron-drain] Re-kicked ${stuckAutofillJobs.length} stuck autofill job(s)`)
    }

    // ── 4. Promote a queued AutoFill job if the queue has stalled ─────────────
    // Normally a finishing job auto-starts the next queued one, but if a running
    // job died without triggering that hand-off (crash mid-transition), a full
    // queue would sit forever with nothing running. If there are queued jobs and
    // ZERO running jobs, start the oldest queued one. Guarded on running === 0 so
    // it never runs a second job concurrently (autofill is one-at-a-time; stale
    // running jobs are handled by the re-kick above).
    let autofillPromoted = 0
    const runningAutofill = await prisma.autoFillJob.count({ where: { status: 'running' } })
    if (runningAutofill === 0) {
      const nextQueued = await prisma.autoFillJob.findFirst({
        where:   { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select:  { id: true },
      })
      if (nextQueued) {
        await prisma.autoFillJob.update({ where: { id: nextQueued.id }, data: { status: 'running' } })
        const baseUrl = getBaseUrl(request)
        after(async () => { await processChunk(nextQueued.id, baseUrl) })
        autofillPromoted = 1
        console.log(`[cron-drain] Promoted stalled queued autofill job ${nextQueued.id}`)
      }
    }

    return NextResponse.json({ success: true, staleReset, harvested, promoted, autofillKicked: stuckAutofillJobs.length, autofillPromoted })
  } catch (error) {
    console.error('[cron-drain] Error:', error)
    return NextResponse.json({ error: 'Drain failed' }, { status: 500 })
  }
}
