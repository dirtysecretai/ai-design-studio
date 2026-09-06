/**
 * fal-queue.ts
 *
 * Helper for promoting the next waiting job from our internal queue to FAL.ai
 * when a global concurrency slot opens up (after a job completes or fails).
 *
 * The global FAL concurrency limit is stored in ModelConcurrencyLimit under
 * the synthetic modelId 'fal-global'.  When a generation request arrives and
 * that counter is already at its max, the generate route creates a
 * GenerationQueue row with status='queued' (not submitted to FAL yet) and
 * stores the full FAL endpoint + input in the row's `parameters` field.
 * When a slot opens this helper picks up the oldest waiting row and submits it.
 *
 * IMPORTANT: This function does NOT sync the counter internally.  Callers
 * that need counter-drift correction should call syncActiveCounters() first
 * (e.g. the /kick and /cron-drain endpoints).  The in-function sync was
 * removed because concurrent calls would race on the SET and undo each
 * other's slot increments, causing all but one concurrent promotion to fail.
 *
 * The function also does NOT cascade additional promotions.  Callers that
 * need to fill multiple slots should call promoteNextQueuedJob() once per
 * free slot — the retry loop inside handles concurrent races between calls.
 */

import { fal } from '@/lib/fal-client'
import prisma from '@/lib/prisma'

fal.config({ credentials: process.env.FAL_KEY })

export const FAL_GLOBAL_ID = 'fal-global'

/**
 * Called after any FAL job completes or fails (webhook / polling), or from the
 * kick/cron endpoints to fill free slots.
 *
 * Atomically claims one global slot, then finds and claims the oldest queued
 * job.  Uses a retry loop on the job-claim step so that when multiple calls
 * race for the same oldest job, the losers skip to the next oldest rather than
 * releasing their slot and returning — this lets N concurrent calls each
 * promote a different job.
 */
export async function promoteNextQueuedJob(): Promise<void> {
  try {
    // Read current global limit
    const globalLimit = await prisma.modelConcurrencyLimit.findUnique({
      where: { modelId: FAL_GLOBAL_ID },
    })
    if (!globalLimit) return

    // Atomically claim a global slot — only succeeds if currentActive < maxConcurrent
    const slotClaim = await prisma.modelConcurrencyLimit.updateMany({
      where: {
        modelId: FAL_GLOBAL_ID,
        currentActive: { lt: globalLimit.maxConcurrent },
      },
      data: { currentActive: { increment: 1 } },
    })
    if (slotClaim.count === 0) return // At capacity

    // Find and claim the oldest queued job.
    // Retry loop: if a concurrent call already claimed the candidate job, skip
    // it and try the next oldest — prevents all concurrent callers from piling
    // up on the same row and releasing their slots unnecessarily.
    const triedIds: number[] = []
    let jobToProcess: Awaited<ReturnType<typeof prisma.generationQueue.findFirst>> = null

    while (true) {
      const candidate = await prisma.generationQueue.findFirst({
        where: {
          status: 'queued',
          ...(triedIds.length > 0 ? { id: { notIn: triedIds } } : {}),
        },
        orderBy: { createdAt: 'asc' },
      })

      if (!candidate) {
        // No more waiting jobs — release the slot we just claimed
        await prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: FAL_GLOBAL_ID },
          data: { currentActive: { decrement: 1 } },
        })
        return
      }

      const jobClaim = await prisma.generationQueue.updateMany({
        where: { id: candidate.id, status: 'queued' },
        data: { status: 'processing', startedAt: new Date() },
      })

      if (jobClaim.count > 0) {
        jobToProcess = candidate
        break
      }

      // Another concurrent handler claimed this job — try the next oldest
      triedIds.push(candidate.id)
    }

    // Extract stored FAL submission data
    const params = jobToProcess!.parameters as any
    const falEndpoint: string | undefined = params.falEndpoint
    const falInput: Record<string, unknown> | undefined = params.falInput
    // Polling-based jobs (NB2, Kling, Video): skip webhook so only the status route handles completion
    const usePolling: boolean = params.usePolling === true

    if (!falEndpoint || !falInput) {
      console.error(`Queued job #${jobToProcess!.id} missing falEndpoint/falInput — failing it`)
      await prisma.generationQueue.update({
        where: { id: jobToProcess!.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'Queued job missing stored FAL endpoint or input',
        },
      })
      // Release global counter (no per-model bump was done yet)
      await prisma.modelConcurrencyLimit.updateMany({
        where: { modelId: FAL_GLOBAL_ID },
        data: { currentActive: { decrement: 1 } },
      })
      return
    }

    // Bump per-model counter only for webhook-based jobs (polling routes handle their own cleanup)
    if (!usePolling) {
      await prisma.modelConcurrencyLimit.updateMany({
        where: { modelId: jobToProcess!.modelId },
        data: { currentActive: { increment: 1 } },
      })
    }

    // Submit to FAL — webhook-based jobs get a webhookUrl; polling-based jobs don't
    const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`
    const submitOptions: Parameters<typeof fal.queue.submit>[1] = { input: falInput }
    if (!usePolling) {
      submitOptions.webhookUrl = `${appUrl}/api/webhooks/fal`
    }

    try {
      const { request_id } = await fal.queue.submit(falEndpoint, submitOptions)

      await prisma.generationQueue.update({
        where: { id: jobToProcess!.id },
        data: { falRequestId: request_id },
      })

      console.log(
        `[fal-queue] Promoted job #${jobToProcess!.id} (${jobToProcess!.modelId}) → FAL ${falEndpoint} (request_id: ${request_id})`
      )
    } catch (submitErr) {
      console.error(`[fal-queue] FAL submit failed for promoted job #${jobToProcess!.id} (${jobToProcess!.modelId}):`, submitErr)

      await prisma.generationQueue.update({
        where: { id: jobToProcess!.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'FAL submission failed during queue promotion',
        },
      }).catch(e => console.error('[fal-queue] Failed to mark job as failed:', e))

      // Decrement counters — the slot is now free
      await Promise.all([
        prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: FAL_GLOBAL_ID },
          data: { currentActive: { decrement: 1 } },
        }).catch(e => console.error('[fal-queue] Failed to decrement global counter:', e)),
        ...(usePolling ? [] : [
          prisma.modelConcurrencyLimit.updateMany({
            where: { modelId: jobToProcess!.modelId },
            data: { currentActive: { decrement: 1 } },
          }).catch(e => console.error('[fal-queue] Failed to decrement per-model counter:', e)),
        ]),
      ])

      // Immediately try to fill the freed slot with the next queued job so a
      // single FAL submit failure doesn't leave a slot empty until the next cron tick.
      promoteNextQueuedJob().catch(e => console.error('[fal-queue] Re-promote after submit failure:', e))
    }
  } catch (err) {
    console.error('[fal-queue] promoteNextQueuedJob error:', err)
  }
}
