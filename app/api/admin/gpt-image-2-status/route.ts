import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'

fal.config({ credentials: process.env.FAL_KEY! })

// POST /api/admin/gpt-image-2-status
// Polls a FAL queue ChatGPT Images 2.0 job. On completion, re-hosts images on R2 and saves to DB.
export async function POST(req: Request) {
  let requestId: string | undefined
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    const body = await req.json()
    requestId = body.requestId
    const { falEndpoint, prompt, aspectRatio, quality, referenceImageUrls, ticketCost, size, queuedAt } = body

    if (!requestId || !falEndpoint) {
      return NextResponse.json({ error: 'Missing requestId or falEndpoint' }, { status: 400 })
    }

    const status = await fal.queue.status(falEndpoint, { requestId, logs: false })

    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result<any>(falEndpoint, { requestId })

      // gpt-image-2 returns images as either URLs or base64 data URIs
      const falImages: { url?: string; content_type?: string; file_name?: string }[] = result.data?.images || []

      if (falImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'No images returned from model')
        return NextResponse.json({ status: 'failed', error: 'No images returned from model' })
      }

      const hostedImages: { url: string }[] = []
      for (let i = 0; i < falImages.length; i++) {
        const falImg = falImages[i]
        try {
          let buffer: Buffer
          let mimeType = falImg.content_type || 'image/png'

          if (falImg.url?.startsWith('data:')) {
            // Base64 data URI
            const base64 = falImg.url.split(',')[1]
            buffer = Buffer.from(base64, 'base64')
            mimeType = falImg.url.split(';')[0].replace('data:', '') || 'image/png'
          } else if (falImg.url) {
            const res = await fetch(falImg.url)
            if (!res.ok) continue
            buffer = Buffer.from(await res.arrayBuffer())
            mimeType = res.headers.get('content-type') || mimeType
          } else {
            continue
          }

          const ext = mimeType.includes('webp') ? 'webp' : mimeType.includes('jpeg') ? 'jpg' : 'png'
          const filename = `gpt-image-2-${Date.now()}-${i}.${ext}`
          const url = await uploadToR2(filename, buffer, mimeType)
          hostedImages.push({ url })
        } catch (e) {
          console.error(`gpt-image-2-status: failed to re-host image ${i}:`, e)
        }
      }

      if (hostedImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'Failed to download generated images')
        return NextResponse.json({ status: 'failed', error: 'Failed to download generated images' })
      }

      // Idempotency: skip if already saved
      try {
        const existing = await prisma.generatedImage.findMany({
          where: { falRequestId: requestId },
          select: { id: true, imageUrl: true },
          orderBy: { id: 'asc' },
        })
        if (existing.length > 0) {
          console.log(`↩ GPT Image 2 already saved [${requestId}] returning ${existing.length} record(s)`)
          return NextResponse.json({
            status: 'completed',
            images: existing.map(img => ({ url: img.imageUrl, dbId: img.id })),
          })
        }
      } catch {}

      const savedIds: number[] = []
      const targetUserId: number | null = sessionUser?.id ?? null
      if (!targetUserId) {
        console.error('gpt-image-2-status: no session user — skipping DB save')
      } else {
        try {
          const created = await Promise.all(hostedImages.map(img =>
            prisma.generatedImage.create({
              data: {
                // createdAt = when the user QUEUED this generation, not when it
                // finished. The feed orders on createdAt, so completion time
                // reshuffled tiles on every refresh. Sanity-capped to the last 24h.
                ...(typeof queuedAt === 'number' && queuedAt > Date.now() - 24 * 3600 * 1000 && queuedAt <= Date.now() + 60_000
                  ? { createdAt: new Date(queuedAt) } : {}),
                userId:             targetUserId,
                prompt:             prompt || '',
                imageUrl:           img.url,
                model:              'gpt-image-2',
                ticketCost:         typeof ticketCost === 'number' ? ticketCost : 0,
                quality:            quality || 'medium',
                aspectRatio:        size || aspectRatio || '1024x1024',
                referenceImageUrls: Array.isArray(referenceImageUrls) ? referenceImageUrls : [],
                expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                falRequestId:       requestId,
              },
              select: { id: true },
            })
          ))
          created.forEach(r => savedIds.push(r.id))
        } catch (dbErr) {
          console.error('gpt-image-2-status: DB save failed (non-fatal):', dbErr)
        }
      }

      await releaseQueueSlot(requestId, false)
      console.log(`✓ GPT Image 2 completed [${requestId}] ${hostedImages.length} image(s)`)
      return NextResponse.json({
        status: 'completed',
        images: hostedImages.map((img, i) => ({ ...img, dbId: savedIds[i] ?? null })),
      })

    } else if ((status as any).status === 'ERROR' || (status as any).status === 'FAILED') {
      await releaseQueueSlot(requestId, true, 'Generation failed on FAL servers')
      return NextResponse.json({ status: 'failed', error: 'Generation failed on FAL servers' })
    } else {
      return NextResponse.json({ status: 'in_progress', falStatus: status.status })
    }

  } catch (error: any) {
    console.error('gpt-image-2-status error:', error)
    if (error.status === 422 || error.constructor?.name === 'ValidationError') {
      const { friendlyFalError, extractFalErrorDetail } = await import('@/lib/fal-friendly-errors')
      const detail = friendlyFalError(extractFalErrorDetail(error))
      if (requestId) await releaseQueueSlot(requestId, true, `Generation failed: ${detail}`)
      return NextResponse.json({ status: 'failed', error: `Generation failed: ${detail}` })
    }
    return NextResponse.json({ status: 'in_progress', error: error.message })
  }
}
