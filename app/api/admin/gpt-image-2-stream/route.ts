import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkUserConcurrency } from '@/lib/user-concurrency'
import { cookies } from 'next/headers'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets } from '@/lib/ticket-gate'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY! })

const TEXT_ENDPOINT = 'fal-ai/gpt-image-2'
const EDIT_ENDPOINT = 'openai/gpt-image-2/edit'

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split('x').map(Number)
  return (w && h) ? { width: w, height: h } : { width: 1024, height: 1024 }
}

function computeGptTicketCost(quality: string, size: string): number {
  if (quality === 'low') return 1
  if (quality === 'medium') {
    if (size === '1024x1024' || size === '2560x1440') return 3
    if (size === '3840x2160') return 4
    return 2
  }
  if (quality === 'high') {
    if (size === '1024x1024') return 8
    if (size === '2560x1440') return 9
    if (size === '3840x2160') return 15
    return 6
  }
  return 1
}

// POST /api/admin/gpt-image-2-stream
//
// SSE flow:
//   1. { type: 'submitted', requestId, falEndpoint }  — sent immediately after fal.queue.submit()
//   2. { type: 'complete', images, permanentReferenceUrls } — final R2-hosted images + DB IDs
//      OR { type: 'error', error }
//
// Uses queue submit (not fal.stream) so requestId is always available immediately for slot persistence.
export async function POST(req: Request) {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  const sessionUser = token ? await getUserFromSession(token) : null

  if (!sessionUser) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  if (await isGenerationBlocked(sessionUser.email)) {
    return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
  }

  const body = await req.json()
  const {
    prompt,
    quality = 'high',
    size = '1024x1024',
    outputFormat = 'png',
    referenceImages = [],
    referenceImageUrls = [],
  } = body

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  const userId = sessionUser.id

  // Server-side concurrency check FIRST — the old order deducted tickets and
  // then rejected on concurrency WITHOUT refunding (charged for nothing)
  const { allowed, activeCount, limit } = await checkUserConcurrency(userId)
  if (!allowed) {
    return NextResponse.json(
      { error: `Queue full (${activeCount}/${limit} active). Wait for a generation to finish.` },
      { status: 429 }
    )
  }

  // Server-side ticket check — compute cost from quality + size, do not trust client value
  const ticketCost = computeGptTicketCost(quality, size)
  // CCBill content filter — must pass BEFORE any charge or provider submit
  {
    const _cf = await enforceContentFilter(prompt, sessionUser.email)
    if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
  }
  const ticketResult = await deductGenerationTickets(userId, sessionUser.email, ticketCost)
  if (!ticketResult.ok) {
    return NextResponse.json(
      { error: `Insufficient tickets — need ${ticketResult.need}, have ${ticketResult.have}` },
      { status: 402 },
    )
  }
  const encoder = new TextEncoder()
  const safeFormat = ['jpeg', 'png', 'webp'].includes(outputFormat) ? outputFormat : 'png'
  // FAL only accepts low/medium/high
  const VALID_QUALITIES = ['low', 'medium', 'high']
  const safeQuality = VALID_QUALITIES.includes(quality) ? quality : 'high'

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
      }
      let submittedEventSent = false

      try {
        console.log(`GPT Image 2 stream: quality=${quality}→${safeQuality} size=${size} format=${safeFormat} refs=${referenceImages.length}`)
        const { width, height } = parseSize(size)
        const hasRefImages = Array.isArray(referenceImages) && referenceImages.length > 0
        const permanentReferenceUrls: string[] = [...referenceImageUrls]

        let endpoint: string
        let input: Record<string, unknown>

        if (hasRefImages) {
          const falUrls: string[] = []
          for (let i = 0; i < referenceImages.slice(0, 8).length; i++) {
            const img = referenceImages[i] as string
            try {
              // Library refs arrive as permanent https URLs — pass them straight
              // to fal (it fetches URLs natively). Base64-decoding a URL string
              // would upload garbage bytes the model can't read.
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
              if (!permanentReferenceUrls[i]) {
                const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
                const r2Url = await uploadToR2(`ref-gpt2-${Date.now()}-${i}.${ext}`, buffer, mimeType)
                permanentReferenceUrls.push(r2Url)
              }
            } catch (e) {
              console.error(`gpt-image-2-stream: failed to upload ref image ${i}:`, e)
            }
          }
          // If every ref failed to upload, the edit endpoint would 422 on an empty
          // image_urls — fail fast with an actionable message (and refund) instead.
          if (falUrls.length === 0) {
            await refundGenerationTickets(userId, sessionUser.email, ticketCost)
            send({ type: 'error', error: 'Your reference image(s) couldn\'t be uploaded to the model. Remove and re-add them, then try again.' })
            return
          }
          endpoint = EDIT_ENDPOINT
          input = {
            prompt: prompt.trim(),
            image_urls: falUrls,
            quality: safeQuality,
            output_format: safeFormat,
          }
        } else {
          endpoint = TEXT_ENDPOINT
          // Text endpoint does not support output_format
          input = {
            prompt: prompt.trim(),
            quality: safeQuality,
            width,
            height,
            n: 1,
          }
        }

        // Submit to FAL queue — gives us a real requestId immediately (same as submit route)
        const submitted = await fal.queue.submit(endpoint, { input })
        const requestId = submitted.request_id

        console.log(`GPT Image 2 queued requestId=${requestId} endpoint=${endpoint}`)

        // Create a GenerationQueue entry so the active count is visible cross-device
        let queueEntryId: number | null = null
        try {
          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId,
              modelId:     'gpt-image-2',
              modelType:   'image',
              prompt:      prompt.trim(),
              parameters:  { falEndpoint: endpoint, falInput: input, size, quality: safeQuality, ticketCost } as any,
              status:      'processing',
              ticketCost:  typeof ticketCost === 'number' ? ticketCost : 0,
              falRequestId: requestId,
              startedAt:   new Date(),
            },
            select: { id: true },
          })
          queueEntryId = queueEntry.id
        } catch (dbErr) {
          console.error('gpt-image-2-stream: queue entry creation failed (non-fatal):', dbErr)
        }

        // Send 'submitted' immediately — client writes slot to sessionStorage
        submittedEventSent = true
        send({ type: 'submitted', requestId, falEndpoint: endpoint, permanentReferenceUrls })

        const markQueueDone = async (status: 'completed' | 'failed') => {
          if (!queueEntryId) return
          await prisma.generationQueue.update({
            where: { id: queueEntryId },
            data: { status, completedAt: new Date() },
          }).catch(() => {})
        }

        // Poll until FAL job completes (max ~4 minutes, 5s intervals = 48 polls)
        let result: any = null
        for (let i = 0; i < 48; i++) {
          await new Promise(r => setTimeout(r, 5000))
          const status = await fal.queue.status(endpoint, { requestId, logs: false })
          if ((status as any).status === 'COMPLETED') {
            result = await fal.queue.result<any>(endpoint, { requestId })
            break
          } else if ((status as any).status === 'ERROR' || (status as any).status === 'FAILED') {
            await markQueueDone('failed')
            send({ type: 'error', error: 'Generation failed on FAL servers' })
            return
          }
        }

        if (!result) {
          await markQueueDone('failed')
          send({ type: 'error', error: 'Generation timed out' })
          return
        }

        const falImages: { url?: string; content_type?: string }[] =
          result?.images || result?.data?.images || []

        if (falImages.length === 0) {
          send({ type: 'error', error: 'No images returned from model' })
          return
        }

        // Send a partial event immediately with the temporary FAL URL so the image
        // appears in the UI right away with the scan-reveal animation, while R2 upload runs.
        const firstFalUrl = falImages[0]?.url
        if (firstFalUrl && !firstFalUrl.startsWith('data:')) {
          send({ type: 'partial', url: firstFalUrl })
        }

        const hostedImages: { url: string }[] = []
        for (let i = 0; i < falImages.length; i++) {
          const falImg = falImages[i]
          try {
            let buffer: Buffer
            let mimeType = falImg.content_type || `image/${safeFormat}`
            if (falImg.url?.startsWith('data:')) {
              const base64 = falImg.url.split(',')[1]
              buffer = Buffer.from(base64, 'base64')
              mimeType = falImg.url.split(';')[0].replace('data:', '') || `image/${safeFormat}`
            } else if (falImg.url) {
              const res = await fetch(falImg.url)
              if (!res.ok) continue
              buffer = Buffer.from(await res.arrayBuffer())
              mimeType = res.headers.get('content-type') || mimeType
            } else {
              continue
            }
            const ext = mimeType.includes('webp') ? 'webp' : mimeType.includes('jpeg') ? 'jpg' : 'png'
            const url = await uploadToR2(`gpt-image-2-${Date.now()}-${i}.${ext}`, buffer, mimeType)
            hostedImages.push({ url })
          } catch (e) {
            console.error(`gpt-image-2-stream: failed to re-host image ${i}:`, e)
          }
        }

        if (hostedImages.length === 0) {
          send({ type: 'error', error: 'Failed to download generated images' })
          return
        }

        // Idempotency: skip DB save if already saved via polling path
        let savedIds: number[] = []
        try {
          const existing = await prisma.generatedImage.findMany({
            where: { falRequestId: requestId },
            select: { id: true, imageUrl: true },
            orderBy: { id: 'asc' },
          })
          if (existing.length > 0) {
            console.log(`↩ GPT Image 2 already saved [${requestId}] — skipping duplicate DB write`)
            savedIds = existing.map(r => r.id)
          } else {
            const created = await Promise.all(hostedImages.map(img =>
              prisma.generatedImage.create({
                data: {
                  userId,
                  prompt:             prompt.trim(),
                  imageUrl:           img.url,
                  model:              'gpt-image-2',
                  ticketCost:         typeof ticketCost === 'number' ? ticketCost : 0,
                  quality:            safeQuality,
                  aspectRatio:        size || '1024x1024',
                  referenceImageUrls: Array.isArray(permanentReferenceUrls) ? permanentReferenceUrls : [],
                  expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                  falRequestId:       requestId,
                },
                select: { id: true },
              })
            ))
            savedIds = created.map(r => r.id)
          }
        } catch (dbErr) {
          console.error('gpt-image-2-stream: DB save failed (non-fatal):', dbErr)
        }

        await markQueueDone('completed')
        console.log(`✓ GPT Image 2 completed [${requestId}] ${hostedImages.length} image(s)`)
        send({
          type: 'complete',
          requestId,
          images: hostedImages.map((img, i) => ({ url: img.url, dbId: savedIds[i] ?? null })),
          permanentReferenceUrls,
        })
      } catch (err: any) {
        console.error('gpt-image-2-stream error:', err, 'body:', JSON.stringify(err?.body))
        const { friendlyFalError, extractFalErrorDetail } = await import('@/lib/fal-friendly-errors')
        send({ type: 'error', error: friendlyFalError(extractFalErrorDetail(err)) })
        // Only refund server-side if FAL submit never happened — post-submit failures
        // are refunded by the client's existing use-tickets refund call.
        if (!submittedEventSent) {
          await refundGenerationTickets(userId, sessionUser.email, ticketCost)
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
