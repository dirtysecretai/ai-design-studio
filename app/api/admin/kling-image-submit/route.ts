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

// POST /api/admin/kling-image-submit
// Submits a Kling V3 image generation job to the FAL async queue.
// Chooses text-to-image or image-to-image based on whether image_url is provided.
// Returns immediately with { requestId, falEndpoint } — client polls /api/admin/kling-image-status.
export async function POST(req: Request) {
  try {
    const _ck = await cookies(); const _tok = _ck.get('session')?.value
    const _u = _tok ? await getUserFromSession(_tok) : null
    if (await isGenerationBlocked(_u?.email)) {
      return jsonPrivate({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const {
      prompt,
      image_url,
      num_images = 1,
      aspect_ratio = '16:9',
      output_format = 'png',
      resolution = '1K',
    } = await req.json()

    if (!prompt?.trim()) {
      return jsonPrivate({ error: 'Prompt is required' }, { status: 400 })
    }

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_images: Math.min(Math.max(1, parseInt(num_images) || 1), 9),
      aspect_ratio,
      output_format,
      resolution,
    }

    const permanentReferenceUrls: string[] = []
    let endpoint: string
    if (image_url) {
      // Upload reference image to FAL storage; also persist to Vercel Blob for DB
      let hostedUrl = image_url
      if (image_url.startsWith('data:')) {
        const [meta, b64] = image_url.split(',')
        const mimeType = meta.split(':')[1]?.split(';')[0] || 'image/jpeg'
        const buffer = Buffer.from(b64, 'base64')
        const falBlob = new Blob([buffer], { type: mimeType })
        hostedUrl = await fal.storage.upload(falBlob)
        const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
        const vUrl = await uploadToR2(`reference-kling-v3-${Date.now()}.${ext}`, buffer, mimeType)
        permanentReferenceUrls.push(vUrl)
      } else {
        // Already a permanent https:// URL
        permanentReferenceUrls.push(image_url)
      }
      input.image_url = hostedUrl
      endpoint = 'fal-ai/kling-image/v3/image-to-image'
    } else {
      endpoint = 'fal-ai/kling-image/v3/text-to-image'
    }

    console.log(`Kling V3 submit (${endpoint}):`, JSON.stringify({ ...input, image_url: input.image_url ? '[url]' : undefined }))

    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null
    const targetUserId: number | null = sessionUser?.id ?? null
    if (!targetUserId) return jsonPrivate({ error: 'Not authenticated — log in before using the admin scanner' }, { status: 401 })

    // Server-side ticket check — Kling V3 costs 2 tickets
    const ticketCost = 2
    const chargedCost = isAdminEmail(sessionUser!.email) ? 0 : ticketCost
    // ── Spam-safe submission order (see kling-o3-submit for the rationale):
    // atomic user-slot claim → charge → global slot/submit, with the claimed
    // row flipped through pending → queued/processing/failed exactly once.
    const rowParams = { falEndpoint: endpoint, falInput: input as Record<string, unknown>, usePolling: true, permanentReferenceUrls }
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser?.email)
      if (!_cf.ok) return jsonPrivate({ error: _cf.reason }, { status: 400 })
    }
    const claim = await claimUserGenerationRow({
      userId: targetUserId,
      modelId: 'kling-v3-image',
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
    await prisma.generationQueue.update({
      where: { id: claim.rowId },
      data: { parameters: { ...rowParams, chargeMode: 'deduct' } as any },
    }).catch(() => {})

    // Sync counter from ground truth, then atomically claim a global slot
    const { claimed, maxConcurrent } = await syncAndClaimFalSlot()

    if (!claimed) {
      // At capacity — queue for later (counter was NOT incremented)
      await prisma.generationQueue.update({ where: { id: claim.rowId }, data: { status: 'queued' } })
      console.log(`Kling V3 queued (at capacity, max=${maxConcurrent}) → queueId #${claim.rowId}`)
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
    console.error('Kling image submit error:', error)
    return jsonPrivate({ error: error.message || 'Submission failed' }, { status: 500 })
  }
}
