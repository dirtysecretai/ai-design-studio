import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'

fal.config({ credentials: process.env.FAL_KEY! })

// POST /api/admin/wan-27-pro-status
// Polls a FAL queue Wan 2.7 Pro job. On completion, re-hosts images on Vercel Blob and saves to DB.
export async function POST(req: Request) {
  let requestId: string | undefined
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    const body = await req.json()
    requestId = body.requestId
    const { falEndpoint, prompt, aspectRatio, referenceImageUrls, queuedAt } = body
    if (!requestId || !falEndpoint) {
      return NextResponse.json({ error: 'Missing requestId or falEndpoint' }, { status: 400 })
    }

    const status = await fal.queue.status(falEndpoint, { requestId, logs: false })

    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result<any>(falEndpoint, { requestId })
      const falImages: { url: string; width?: number; height?: number }[] = result.data?.images || []

      if (falImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'No images returned from model')
        return NextResponse.json({ status: 'failed', error: 'No images returned from model' })
      }

      const hostedImages: { url: string; width?: number; height?: number }[] = []
      for (let i = 0; i < falImages.length; i++) {
        const falImg = falImages[i]
        try {
          const res = await fetch(falImg.url)
          if (!res.ok) continue
          const buffer = Buffer.from(await res.arrayBuffer())
          const filename = `wan27-${Date.now()}-${i}.png`
          const url = await uploadToR2(filename, buffer, 'image/png')
          hostedImages.push({ url, width: falImg.width, height: falImg.height })
        } catch (e) {
          console.error(`wan-27-pro-status: failed to re-host image ${i}:`, e)
        }
      }

      if (hostedImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'Failed to download generated images')
        return NextResponse.json({ status: 'failed', error: 'Failed to download generated images' })
      }

      // Idempotency: if already saved for this requestId, return existing records
      try {
        const existing = await prisma.generatedImage.findMany({
          where: { falRequestId: requestId },
          select: { id: true, imageUrl: true },
          orderBy: { id: 'asc' },
        })
        if (existing.length > 0) {
          console.log(`↩ Wan 2.7 Pro already saved [${requestId}] returning ${existing.length} existing record(s)`)
          return NextResponse.json({
            status: 'completed',
            images: existing.map(img => ({ url: img.imageUrl, dbId: img.id })),
          })
        }
      } catch {
        // falRequestId column may not exist yet — skip idempotency check
      }

      // Save to DB
      const savedIds: number[] = []
      try {
        const targetUserId: number | null = sessionUser?.id ?? null
        if (!targetUserId) {
          console.error('wan-27-pro-status: no session user — skipping DB save')
        }
        if (targetUserId) {
          const created = await Promise.all(hostedImages.map(img =>
            prisma.generatedImage.create({
              data: {
                // createdAt = when the user QUEUED this generation, not when it
                // finished. The feed orders on createdAt, so completion time
                // reshuffled tiles on every refresh. Sanity-capped to the last 24h.
                ...(typeof queuedAt === 'number' && queuedAt > Date.now() - 24 * 3600 * 1000 && queuedAt <= Date.now() + 60_000
                  ? { createdAt: new Date(queuedAt) } : {}),
                userId:             targetUserId!,
                prompt:             prompt || '',
                imageUrl:           img.url,
                model:              'wan-2.7-pro',
                ticketCost:         4,
                quality:            'auto',
                aspectRatio:        aspectRatio || '16:9',
                referenceImageUrls: Array.isArray(referenceImageUrls) ? referenceImageUrls : [],
                expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                falRequestId:       requestId,
              },
              select: { id: true },
            })
          ))
          created.forEach(r => savedIds.push(r.id))
        }
      } catch (dbErr) {
        console.error('wan-27-pro-status: DB save failed (non-fatal):', dbErr)
      }

      await releaseQueueSlot(requestId, false)
      console.log(`✓ Wan 2.7 Pro completed [${requestId}] ${hostedImages.length} image(s)`)
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
    console.error('wan-27-pro-status error:', error)
    if (error.status === 422 || error.constructor?.name === 'ValidationError') {
      const detail = Array.isArray(error.body?.detail)
        ? error.body.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
        : error.body?.message || error.message || 'Unprocessable content'
      if (requestId) await releaseQueueSlot(requestId, true, `Generation failed: ${detail}`)
      return NextResponse.json({ status: 'failed', error: `Generation failed: ${detail}` })
    }
    return NextResponse.json({ status: 'in_progress', error: error.message })
  }
}
