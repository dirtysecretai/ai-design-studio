import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import prisma from '@/lib/prisma'
import { syncAndClaimFalSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { claimUserGenerationRow } from '@/lib/user-concurrency'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets, isAdminEmail } from '@/lib/ticket-gate'
import { checkIsAdmin } from '@/lib/admin-check'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/wan-22-t2i-lora-submit — ADMIN ONLY
// Wan 2.2 A14B text-to-image with a custom trained LoRA (from the wan-22
// trainer pipeline). Follows the hardened spam-safe submit ladder: atomic
// user-slot claim → charge → global slot/submit, row flipped pending →
// queued/processing/failed exactly once. parameters carries falEndpoint +
// falInput + usePolling so the drain-queue cron harvests orphaned completions.

const ENDPOINT = 'fal-ai/wan/v2.2-a14b/text-to-image/lora'

type WanImageSize = 'square_hd' | 'square' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9'
function aspectRatioToImageSize(aspectRatio: string): WanImageSize {
  switch (aspectRatio) {
    case '1:1':  return 'square_hd'
    case '4:3':  return 'landscape_4_3'
    case '16:9': return 'landscape_16_9'
    case '3:4':  return 'portrait_4_3'
    case '9:16': return 'portrait_16_9'
    default:     return 'square_hd'
  }
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null
    if (await isGenerationBlocked(sessionUser?.email)) {
      return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }
    const targetUserId: number | null = sessionUser?.id ?? null
    if (!targetUserId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // Hard admin gate — this model is not user-facing yet
    if (!sessionUser || !(await checkIsAdmin(sessionUser.email))) {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 })
    }

    const { prompt, aspect_ratio = '1:1', loras } = await req.json()
    if (!prompt?.trim()) return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })

    // Only OUR trained LoRA artifacts may be loaded — never arbitrary URLs
    const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
    const wanLoras: { path: string; scale: number; transformer: 'high' | 'low' | 'both' }[] = []
    for (const l of (Array.isArray(loras) ? loras.slice(0, 2) : [])) {
      const p = typeof l?.path === 'string' ? l.path : ''
      if (!publicBase || !p.startsWith(`${publicBase}/training/video-loras/`)) {
        return NextResponse.json({ error: 'Invalid LoRA path' }, { status: 400 })
      }
      wanLoras.push({
        path: p,
        scale: Math.min(4, Math.max(0, Number(l?.scale) || 1)),
        transformer: l?.transformer === 'low' || l?.transformer === 'both' ? l.transformer : 'high',
      })
    }
    if (wanLoras.length === 0) return NextResponse.json({ error: 'Select a trained LoRA first' }, { status: 400 })

    const input = {
      prompt: String(prompt).trim(),
      loras: wanLoras,
      image_size: aspectRatioToImageSize(String(aspect_ratio)),
      enable_safety_checker: false, // admin-only route
    }

    // PLACEHOLDER cost — admin-only, so charged 0 in practice
    const ticketCost = 2
    const chargedCost = isAdminEmail(sessionUser.email) ? 0 : ticketCost

    const rowParams = { falEndpoint: ENDPOINT, falInput: input, usePolling: true }
    const claim = await claimUserGenerationRow({
      userId: targetUserId,
      modelId: 'wan-2.2-t2i-lora',
      modelType: 'image',
      prompt: String(prompt).trim(),
      parameters: rowParams,
      ticketCost: chargedCost,
    })
    if (!claim.ok) {
      return NextResponse.json(
        { error: `Queue full (${claim.activeCount}/${claim.limit} active). Wait for a generation to finish.` },
        { status: 429 }
      )
    }
    const ticketResult = await deductGenerationTickets(targetUserId, sessionUser.email, ticketCost)
    if (!ticketResult.ok) {
      await prisma.generationQueue.delete({ where: { id: claim.rowId } }).catch(() => {})
      return NextResponse.json(
        { error: `Insufficient tickets — need ${ticketResult.need}, have ${ticketResult.have}` },
        { status: 402 },
      )
    }
    await prisma.generationQueue.update({
      where: { id: claim.rowId },
      data: { parameters: { ...rowParams, chargeMode: 'deduct' } as any },
    }).catch(() => {})

    const { claimed, maxConcurrent } = await syncAndClaimFalSlot()
    if (!claimed) {
      await prisma.generationQueue.update({ where: { id: claim.rowId }, data: { status: 'queued' } })
      console.log(`Wan 2.2 T2I LoRA queued (at capacity, max=${maxConcurrent}) → queueId #${claim.rowId}`)
      return NextResponse.json({ success: true, queued: true, queueId: claim.rowId })
    }

    try {
      const submitted = await fal.queue.submit(ENDPOINT, { input })
      await prisma.generationQueue.update({
        where: { id: claim.rowId },
        data: { status: 'processing', falRequestId: submitted.request_id, startedAt: new Date() },
      })
      return NextResponse.json({
        success: true,
        requestId: submitted.request_id,
        falEndpoint: ENDPOINT,
        queueId: claim.rowId,
      })
    } catch (submitError: any) {
      const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
      await prisma.modelConcurrencyLimit.updateMany({
        where: { modelId: FAL_GLOBAL_ID },
        data: { currentActive: { decrement: 1 } },
      }).catch(() => {})
      await refundGenerationTickets(targetUserId, sessionUser.email, ticketCost)
      await prisma.generationQueue.update({
        where: { id: claim.rowId },
        data: { status: 'failed', completedAt: new Date(), errorMessage: 'Submission to provider failed' },
      }).catch(() => {})
      throw submitError
    }
  } catch (error: any) {
    console.error('Wan 2.2 T2I LoRA submit error:', error)
    return NextResponse.json({ error: error.message || 'Submission failed' }, { status: 500 })
  }
}
