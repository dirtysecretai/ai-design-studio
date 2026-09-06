import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { syncAndClaimFalSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { claimUserGenerationRow } from '@/lib/user-concurrency'
import { cookies } from 'next/headers'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets, isAdminEmail } from '@/lib/ticket-gate'
import { enforceContentFilter } from '@/lib/content-filter'
import { jsonPrivate } from '@/lib/api-json'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/nano-banana-2-live
// Uploads reference images to FAL storage, then submits to FAL async queue.
// Returns immediately with { requestId, falEndpoint } — client polls /api/admin/nb2-status.
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    if (await isGenerationBlocked(sessionUser?.email)) {
      return jsonPrivate({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const body = await req.json()
    const {
      prompt,
      num_images = 1,
      aspect_ratio = 'auto',
      output_format = 'png',
      safety_tolerance = '4',
      resolution = '1K',
      limit_generations = true,
      enable_web_search = false,
      seed,
      image_urls,
    } = body

    if (!prompt?.trim()) {
      return jsonPrivate({ error: 'Prompt is required' }, { status: 400 })
    }

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_images: Math.min(Math.max(1, parseInt(num_images) || 1), 4),
      aspect_ratio,
      output_format,
      safety_tolerance: String(safety_tolerance),
      resolution,
      limit_generations,
      enable_web_search,
    }

    if (seed !== undefined && seed !== null && seed !== '') {
      input.seed = parseInt(seed)
    }

    // Upload reference images to FAL storage if provided; also save to Vercel Blob for permanent DB storage
    const hasReferenceImages = Array.isArray(image_urls) && image_urls.length > 0
    const permanentReferenceUrls: string[] = []
    if (hasReferenceImages) {
      const falUrls: string[] = []
      const urlsToProcess = image_urls.slice(0, 14)
      for (let i = 0; i < urlsToProcess.length; i++) {
        const url = urlsToProcess[i]
        try {
          // Detect MIME from data URI prefix before fetching
          let mimeType = 'image/jpeg'
          if (url.startsWith('data:')) {
            mimeType = url.split(',')[0].split(':')[1]?.split(';')[0] || 'image/jpeg'
          }
          const imgRes = await fetch(url)
          if (!imgRes.ok) continue
          const arrayBuffer = await imgRes.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          if (!url.startsWith('data:')) {
            mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
          }
          // Upload to FAL for model use
          const falBlob = new Blob([buffer], { type: mimeType })
          const falUrl = await fal.storage.upload(falBlob)
          falUrls.push(falUrl)
          // Also upload to Vercel Blob for permanent DB reference
          const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
          const vUrl = await uploadToR2(`reference-nb2-${Date.now()}-${i}.${ext}`, buffer, mimeType)
          permanentReferenceUrls.push(vUrl)
        } catch { continue }
      }
      if (falUrls.length > 0) {
        input.image_urls = falUrls
      }
    }

    const endpoint = hasReferenceImages && (input.image_urls as string[])?.length > 0
      ? 'fal-ai/nano-banana-2/edit'
      : 'fal-ai/nano-banana-2'

    console.log(`NanoBanana 2 submit (${endpoint}):`, JSON.stringify({
      ...input,
      image_urls: input.image_urls ? `[${(input.image_urls as string[]).length} urls]` : undefined,
    }))

    const targetUserId: number | null = sessionUser?.id ?? null
    if (!targetUserId) return jsonPrivate({ error: 'Not authenticated — log in before using the admin scanner' }, { status: 401 })

    // Server-side ticket check — cost: 12 for 4K, 7 otherwise
    const ticketCost = (resolution as string) === '4K' ? 12 : 7
    // Amount actually debited from the DB — 0 for admins (image gens bypass
    // charging). Stored on the queue row so a failure refunds exactly this.
    const chargedCost = isAdminEmail(sessionUser!.email) ? 0 : ticketCost
    // ── Spam-safe submission order (see kling-o3-submit for the rationale):
    // atomic user-slot claim → charge → global slot/submit, with the claimed
    // row flipped through pending → queued/processing/failed exactly once.
    const rowParams = { falEndpoint: endpoint, falInput: input, usePolling: true, permanentReferenceUrls }
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser?.email)
      if (!_cf.ok) return jsonPrivate({ error: _cf.reason }, { status: 400 })
    }
    const claim = await claimUserGenerationRow({
      userId: targetUserId,
      modelId: 'nano-banana-pro-2',
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
      console.log(`NanoBanana 2 queued (at capacity, max=${maxConcurrent}) → queueId #${claim.rowId}`)
      return jsonPrivate({ success: true, queued: true, queueId: claim.rowId, permanentReferenceUrls })
    }

    // Slot claimed (counter already incremented) — submit to FAL
    try {
      const submitted = await fal.queue.submit(endpoint, { input })
      await prisma.generationQueue.update({
        where: { id: claim.rowId },
        data: { status: 'processing', falRequestId: submitted.request_id, startedAt: new Date() },
      })

      console.log(`NanaBanana 2 submitted (${endpoint}) requestId=${submitted.request_id} queueId=#${claim.rowId}`)

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
    console.error('NanoBanana 2 submit error:', error)
    return jsonPrivate(
      { error: error.message || 'Submission failed' },
      { status: 500 }
    )
  }
}
