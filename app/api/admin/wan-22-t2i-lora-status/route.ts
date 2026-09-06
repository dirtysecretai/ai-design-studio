import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'

fal.config({ credentials: process.env.FAL_KEY! })

// POST /api/admin/wan-22-t2i-lora-status
// Polls a Wan 2.2 A14B text-to-image LoRA job. Output shape differs from most
// image endpoints: a SINGLE `image` object (not an images array) — normalized
// here. On completion re-hosts to R2 and saves the GeneratedImage record.
export async function POST(req: Request) {
  let requestId: string | undefined
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    const body = await req.json()
    requestId = body.requestId
    const { falEndpoint, prompt, aspectRatio, loraName, queuedAt } = body
    if (!requestId || !falEndpoint) {
      return NextResponse.json({ error: 'Missing requestId or falEndpoint' }, { status: 400 })
    }

    const status = await fal.queue.status(falEndpoint, { requestId, logs: false })

    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result<any>(falEndpoint, { requestId })
      const falImages: { url: string; width?: number; height?: number }[] =
        result.data?.images || (result.data?.image?.url ? [result.data.image] : [])

      if (falImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'No images returned from model')
        return NextResponse.json({ status: 'failed', error: 'No images returned from model' })
      }

      const hostedImages: { url: string; width?: number; height?: number }[] = []
      for (let i = 0; i < falImages.length; i++) {
        try {
          const res = await fetch(falImages[i].url)
          if (!res.ok) continue
          const buffer = Buffer.from(await res.arrayBuffer())
          const url = await uploadToR2(`wan22lora-${Date.now()}-${i}.png`, buffer, 'image/png')
          hostedImages.push({ url, width: falImages[i].width, height: falImages[i].height })
        } catch (e) {
          console.error(`wan-22-t2i-lora-status: failed to re-host image ${i}:`, e)
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
          return NextResponse.json({
            status: 'completed',
            images: existing.map(img => ({ url: img.imageUrl, dbId: img.id })),
          })
        }
      } catch { /* idempotency check best-effort */ }

      const savedIds: number[] = []
      try {
        const targetUserId: number | null = sessionUser?.id ?? null
        if (targetUserId) {
          const created = await Promise.all(hostedImages.map(img =>
            prisma.generatedImage.create({
              data: {
                userId:      targetUserId,
                prompt:      prompt || '',
                imageUrl:    img.url,
                model:       'wan-2.2-t2i-lora',
                ticketCost:  0,
                quality:     'auto',
                aspectRatio: aspectRatio || '1:1',
                expiresAt:   new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                falRequestId: requestId,
                ...(typeof queuedAt === 'number' && queuedAt > Date.now() - 24 * 3600 * 1000 && queuedAt <= Date.now() + 60_000
                  ? { createdAt: new Date(queuedAt) } : {}),
                ...(loraName ? { videoMetadata: { loraName: String(loraName).slice(0, 120) } } : {}),
              },
              select: { id: true },
            })
          ))
          created.forEach(r => savedIds.push(r.id))
        }
      } catch (dbErr) {
        console.error('wan-22-t2i-lora-status: DB save failed (non-fatal):', dbErr)
      }

      await releaseQueueSlot(requestId, false)
      console.log(`✓ Wan 2.2 T2I LoRA completed [${requestId}] ${hostedImages.length} image(s)`)
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
    console.error('wan-22-t2i-lora-status error:', error)
    if (error.status === 422 || error.constructor?.name === 'ValidationError') {
      const detail = Array.isArray(error.body?.detail)
        ? error.body.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
        : error.body?.message || error.message || 'Unprocessable content'
      if (requestId) await releaseQueueSlot(requestId, true, `Generation failed: ${detail}`)
      return NextResponse.json({ status: 'failed', error: `Generation failed: ${detail}` })
    }
    if (error.status === 404 || /not.found|no.longer.available|expired/i.test(error.message ?? '')) {
      if (requestId) await releaseQueueSlot(requestId, true, 'Generation request expired or not found')
      return NextResponse.json({ status: 'failed', error: 'Generation request expired or not found' })
    }
    return NextResponse.json({ status: 'in_progress', error: error.message })
  }
}
