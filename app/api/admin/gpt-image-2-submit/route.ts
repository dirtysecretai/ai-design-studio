import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { syncAndClaimFalSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { checkUserConcurrency } from '@/lib/user-concurrency'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets } from '@/lib/ticket-gate'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY })

const TEXT_ENDPOINT = 'fal-ai/gpt-image-2'
const EDIT_ENDPOINT = 'openai/gpt-image-2/edit'

function computeGptTicketCost(quality: string, size: string): number {
  if (quality === 'low') return 1
  if (quality === 'high') {
    if (size === '1024x1024') return 8
    if (size === '2560x1440') return 9
    if (size === '3840x2160') return 15
    return 6
  }
  // medium (default)
  if (size === '1024x1024' || size === '2560x1440') return 3
  if (size === '3840x2160') return 4
  return 2
}

// Size tokens are the exact pixel dimensions shown in the portal (e.g. "1920x1080").
// Split on "x" to get width/height directly — no lookup table needed.
function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split('x').map(Number)
  return (w && h) ? { width: w, height: h } : { width: 1024, height: 1024 }
}

// POST /api/admin/gpt-image-2-submit
// Text-to-image  → fal-ai/gpt-image-2   (no reference images)
// Image editing  → openai/gpt-image-2/edit  (reference images provided)
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    if (await isGenerationBlocked(sessionUser?.email)) {
      return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const targetUserId: number | null = sessionUser?.id ?? null
    if (!targetUserId) {
      return NextResponse.json({ error: 'Not authenticated — log in before using the admin scanner' }, { status: 401 })
    }

    const { allowed, activeCount, limit } = await checkUserConcurrency(targetUserId)
    if (!allowed) {
      return NextResponse.json(
        { error: `Queue full (${activeCount}/${limit} active). Wait for a generation to finish.` },
        { status: 429 }
      )
    }

    const body = await req.json()
    const {
      prompt,
      quality = 'medium',
      size = '1024x1024',        // pixel-dimension token from the portal
      referenceImages = [],       // base64 data URIs from the client
      referenceImageUrls = [],    // permanent R2 URLs for DB storage
    } = body

    // Compute ticket cost server-side — never trust client-supplied value
    const ticketCost = computeGptTicketCost(quality as string, size as string)

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    // Deduct tickets before submitting to FAL
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser?.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    const ticketResult = await deductGenerationTickets(targetUserId, sessionUser!.email, ticketCost)
    if (!ticketResult.ok) {
      return NextResponse.json(
        { error: `Insufficient tickets — need ${ticketResult.need}, have ${ticketResult.have}` },
        { status: 402 },
      )
    }

    const { width, height } = parseSize(size)
    const hasRefImages = Array.isArray(referenceImages) && referenceImages.length > 0

    let endpoint: string
    let input: Record<string, unknown>
    const permanentReferenceUrls: string[] = [...referenceImageUrls]

    if (hasRefImages) {
      // ── Edit mode: upload ref images to FAL storage ───────────────────────────
      const falUrls: string[] = []
      for (let i = 0; i < referenceImages.slice(0, 8).length; i++) {
        const img = referenceImages[i] as string
        try {
          // Library refs arrive as permanent https URLs — pass them straight to
          // fal (it fetches URLs natively). Base64-decoding a URL string would
          // upload garbage bytes the model can't read.
          if (img.startsWith('http')) {
            falUrls.push(img)
            if (!permanentReferenceUrls.includes(img)) permanentReferenceUrls.push(img)
            continue
          }
          const base64 = img.startsWith('data:') ? img.split(',')[1] : img
          const mimeType = img.startsWith('data:') ? img.split(';')[0].replace('data:', '') : 'image/jpeg'
          const buffer = Buffer.from(base64, 'base64')
          const blob = new Blob([buffer], { type: mimeType })
          const falUrl = await fal.storage.upload(blob)
          falUrls.push(falUrl)
          // Also persist to R2 so the DB reference survives FAL URL expiry
          if (!img.startsWith('data:') || permanentReferenceUrls.length <= i) {
            const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
            const r2Url = await uploadToR2(`ref-gpt2-${Date.now()}-${i}.${ext}`, buffer, mimeType)
            if (!permanentReferenceUrls[i]) permanentReferenceUrls.push(r2Url)
          }
        } catch (e) {
          console.error(`gpt-image-2-submit: failed to upload ref image ${i}:`, e)
        }
      }

      endpoint = EDIT_ENDPOINT
      input = {
        prompt: prompt.trim(),
        image_urls: falUrls,
        quality,
        // size not passed for edit — model infers from input image
      }
    } else {
      // ── Text-to-image mode ────────────────────────────────────────────────────
      endpoint = TEXT_ENDPOINT
      input = {
        prompt: prompt.trim(),
        quality,
        width,
        height,
        n: 1,
      }
    }

    console.log(`GPT Image 2 submit (${endpoint}) size=${size} quality=${quality} refs=${referenceImages.length}`)

    const { claimed } = await syncAndClaimFalSlot()

    if (!claimed) {
      const queueEntry = await prisma.generationQueue.create({
        data: {
          userId:    targetUserId,
          modelId:   'gpt-image-2',
          modelType: 'image',
          prompt:    prompt.trim(),
          parameters: { falEndpoint: endpoint, falInput: input, usePolling: true, permanentReferenceUrls, size, quality, ticketCost } as any,
          status:    'queued',
          ticketCost,
        },
      })
      return NextResponse.json({ success: true, queued: true, queueId: queueEntry.id, permanentReferenceUrls })
    }

    try {
      const submitted = await fal.queue.submit(endpoint, { input })

      const queueEntry = await prisma.generationQueue.create({
        data: {
          userId:      targetUserId,
          modelId:     'gpt-image-2',
          modelType:   'image',
          prompt:      prompt.trim(),
          parameters:  { falEndpoint: endpoint, falInput: input, usePolling: true, permanentReferenceUrls, size, quality, ticketCost } as any,
          status:      'processing',
          ticketCost,
          falRequestId: submitted.request_id,
          startedAt:   new Date(),
        },
      })

      console.log(`GPT Image 2 submitted requestId=${submitted.request_id} queueId=#${queueEntry.id}`)

      return NextResponse.json({
        success: true,
        requestId: submitted.request_id,
        falEndpoint: endpoint,
        queueId: queueEntry.id,
        permanentReferenceUrls,
      })
    } catch (submitError: any) {
      const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
      await prisma.modelConcurrencyLimit.updateMany({
        where: { modelId: FAL_GLOBAL_ID },
        data: { currentActive: { decrement: 1 } },
      }).catch(() => {})
      await refundGenerationTickets(targetUserId, sessionUser!.email, ticketCost)
      throw submitError
    }
  } catch (error: any) {
    console.error('GPT Image 2 submit error:', error)
    return NextResponse.json({ error: error.message || 'Submission failed' }, { status: 500 })
  }
}
