import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { syncAndClaimFalSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { claimUserGenerationRow } from '@/lib/user-concurrency'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets, isAdminEmail } from '@/lib/ticket-gate'
import { enforceContentFilter } from '@/lib/content-filter'
import { jsonPrivate } from '@/lib/api-json'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/kling-o3-submit
// Submits a Kling O3 (Omni Image) job to the FAL async queue.
// Chooses text-to-image or image-to-image based on whether image_urls is provided.
// Returns immediately with { requestId, falEndpoint } — client polls /api/admin/kling-o3-status.
export async function POST(req: Request) {
  try {
    const _ck = await cookies(); const _tok = _ck.get('session')?.value
    const _u = _tok ? await getUserFromSession(_tok) : null
    if (await isGenerationBlocked(_u?.email)) {
      return jsonPrivate({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const {
      prompt,
      image_urls,
      num_images = 1,
      aspect_ratio = '16:9',
      output_format = 'png',
      resolution = '1K',
    } = await req.json()

    if (!prompt?.trim()) {
      return jsonPrivate({ error: 'Prompt is required' }, { status: 400 })
    }

    const hasRefImages = Array.isArray(image_urls) && image_urls.length > 0

    // Upload any base64 data URIs to FAL storage; also persist to Vercel Blob for DB
    let hostedImageUrls: string[] = []
    const permanentReferenceUrls: string[] = []
    if (hasRefImages) {
      for (let i = 0; i < image_urls.slice(0, 10).length; i++) {
        const url = image_urls[i]
        try {
          if (url.startsWith('data:')) {
            const [meta, b64] = url.split(',')
            const mimeType = meta.split(':')[1]?.split(';')[0] || 'image/jpeg'
            const buffer = Buffer.from(b64, 'base64')
            const falBlob = new Blob([buffer], { type: mimeType })
            const falUrl = await fal.storage.upload(falBlob)
            hostedImageUrls.push(falUrl)
            const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
            const vUrl = await uploadToR2(`reference-kling-o3-${Date.now()}-${i}.${ext}`, buffer, mimeType)
            permanentReferenceUrls.push(vUrl)
          } else {
            // Already a permanent https:// URL
            hostedImageUrls.push(url)
            permanentReferenceUrls.push(url)
          }
        } catch { continue }
      }
    }

    const endpoint = hostedImageUrls.length > 0
      ? 'fal-ai/kling-image/o3/image-to-image'
      : 'fal-ai/kling-image/o3/text-to-image'

    // If "auto" is selected, omit aspect_ratio and let the model use its default
    const resolvedAspectRatio = aspect_ratio === 'auto' ? undefined : aspect_ratio

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_images: Math.min(Math.max(1, parseInt(num_images) || 1), 9),
      output_format,
      resolution,
    }
    if (resolvedAspectRatio) input.aspect_ratio = resolvedAspectRatio

    if (hostedImageUrls.length > 0) {
      input.image_urls = hostedImageUrls
    }

    console.log(`Kling O3 submit (${endpoint}):`, JSON.stringify({
      ...input,
      image_urls: input.image_urls ? `[${(input.image_urls as string[]).length} urls]` : undefined,
    }))

    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null
    const targetUserId: number | null = sessionUser?.id ?? null
    if (!targetUserId) return jsonPrivate({ error: 'Not authenticated — log in before using the admin scanner' }, { status: 401 })

    // Server-side ticket check — Kling O3: 4 for 4K, 2 otherwise
    const ticketCost = (resolution as string) === '4K' ? 4 : 2
    const chargedCost = isAdminEmail(sessionUser!.email) ? 0 : ticketCost
    // ── Spam-safe submission order ──
    // 1. ATOMIC user-slot claim (advisory-locked row create) BEFORE charging:
    //    a burst of simultaneous presses serializes here, and a 429 rejection
    //    costs nothing (the old order deducted tickets, THEN rejected on
    //    concurrency — charging users for generations that never ran).
    // 2. Atomic ticket deduction; failure releases the claim.
    // 3. Global fal slot / provider submit; the claimed row is flipped to
    //    queued/processing/failed so every path settles exactly once.
    const rowParams = { falEndpoint: endpoint, falInput: input, usePolling: true, permanentReferenceUrls }
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser?.email)
      if (!_cf.ok) return jsonPrivate({ error: _cf.reason }, { status: 400 })
    }
    const claim = await claimUserGenerationRow({
      userId: targetUserId,
      modelId: 'kling-o3-image',
      modelType: 'image',
      prompt: (prompt as string).trim(),
      parameters: rowParams,
      ticketCost: chargedCost,
    })
    if (!claim.ok) {
      return jsonPrivate(
        { error: `Queue full (${claim.activeCount}/${claim.limit} active). Wait for a generation to finish.` },
        { status: 429 }
      )
    }
    const ticketResult = await deductGenerationTickets(targetUserId, sessionUser!.email, ticketCost)
    if (!ticketResult.ok) {
      await prisma.generationQueue.delete({ where: { id: claim.rowId } }).catch(() => {})
      return jsonPrivate(
        { error: `Insufficient tickets — need ${ticketResult.need}, have ${ticketResult.have}` },
        { status: 402 },
      )
    }
    // Mark the charge on the row — the stale-pending sweeper refunds only
    // rows that actually charged (crash between here and the flip below)
    await prisma.generationQueue.update({
      where: { id: claim.rowId },
      data: { parameters: { ...rowParams, chargeMode: 'deduct' } as any },
    }).catch(() => {})

    // Sync counter from ground truth, then atomically claim a global slot
    const { claimed, maxConcurrent } = await syncAndClaimFalSlot()

    if (!claimed) {
      // At capacity — queue for later (counter was NOT incremented)
      await prisma.generationQueue.update({ where: { id: claim.rowId }, data: { status: 'queued' } })
      console.log(`Kling O3 queued (at capacity, max=${maxConcurrent}) → queueId #${claim.rowId}`)
      return jsonPrivate({ success: true, queued: true, queueId: claim.rowId, permanentReferenceUrls })
    }

    // Slot claimed (counter already incremented) — submit to FAL
    try {
      const submitted = await fal.queue.submit(endpoint, { input })
      await prisma.generationQueue.update({
        where: { id: claim.rowId },
        data: { status: 'processing', falRequestId: submitted.request_id, startedAt: new Date() },
      })

      return jsonPrivate({
        success: true,
        requestId: submitted.request_id,
        falEndpoint: endpoint,
        queueId: claim.rowId,
        permanentReferenceUrls,
      })
    } catch (submitError: any) {
      // FAL submit failed — release the slot, refund, settle the row
      const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
      await prisma.modelConcurrencyLimit.updateMany({
        where: { modelId: FAL_GLOBAL_ID },
        data: { currentActive: { decrement: 1 } },
      }).catch(() => {})
      await refundGenerationTickets(targetUserId!, sessionUser!.email, ticketCost)
      await prisma.generationQueue.update({
        where: { id: claim.rowId },
        data: { status: 'failed', completedAt: new Date(), errorMessage: 'Submission to provider failed' },
      }).catch(() => {})
      throw submitError
    }
  } catch (error: any) {
    console.error('Kling O3 submit error:', error)
    return jsonPrivate({ error: error.message || 'Submission failed' }, { status: 500 })
  }
}
