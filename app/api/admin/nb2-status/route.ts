import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'

fal.config({ credentials: process.env.FAL_KEY! })

// POST /api/admin/nb2-status
// Polls a FAL queue NanoBanana 2 job. On completion, re-hosts images on Vercel Blob and saves to DB.
export async function POST(req: Request) {
  let requestId: string | undefined
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    const body = await req.json()
    requestId = body.requestId
    const { falEndpoint, prompt, outputFormat, aspectRatio, quality, referenceImageUrls, ticketCost, queuedAt, videoMetadata } = body
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

      const format = outputFormat || 'png'
      const hostedImages: { url: string; width?: number; height?: number }[] = []
      for (let i = 0; i < falImages.length; i++) {
        const falImg = falImages[i]
        try {
          const res = await fetch(falImg.url)
          if (!res.ok) continue
          const buffer = Buffer.from(await res.arrayBuffer())
          const ext = format === 'jpeg' ? 'jpg' : format
          const filename = `nb2-${Date.now()}-${i}.${ext}`
          const url = await uploadToR2(filename, buffer, `image/${format === 'jpeg' ? 'jpeg' : format}`)
          hostedImages.push({ url, width: falImg.width, height: falImg.height })
        } catch (e) {
          console.error(`nb2-status: failed to re-host image ${i}:`, e)
        }
      }

      if (hostedImages.length === 0) {
        await releaseQueueSlot(requestId, true, 'Failed to download generated images')
        return NextResponse.json({ status: 'failed', error: 'Failed to download generated images' })
      }

      // Idempotency: if we already saved images for this requestId, return them without
      // re-uploading or re-inserting. This prevents duplicate DB records when the client
      // re-polls a job whose "completed" response was lost (e.g. iOS app kill mid-response).
      try {
        const existing = await prisma.generatedImage.findMany({
          where: { falRequestId: requestId },
          select: { id: true, imageUrl: true },
          orderBy: { id: 'asc' },
        })
        if (existing.length > 0) {
          console.log(`↩ NanoBanana 2 already saved [${requestId}] returning ${existing.length} existing record(s)`)
          return NextResponse.json({
            status: 'completed',
            images: existing.map(img => ({ url: img.imageUrl, dbId: img.id })),
          })
        }
      } catch {
        // falRequestId column may not exist yet — skip idempotency check
      }

      // Save to DB and capture real IDs so the client can display without re-fetching
      const savedIds: number[] = []
      try {
        const targetUserId: number | null = sessionUser?.id ?? null
        if (!targetUserId) {
          console.error('nb2-status: no session user — skipping DB save')
        }
        if (targetUserId) {
          // QUEUE TIME, EVEN WHEN THE CLIENT FORGETS IT.
          //
          // createdAt is the feed's ordering key, so a row saved at COMPLETION
          // time sorts by how fast the model happened to be rather than by the
          // order the user asked for. The client sends queuedAt from its slot,
          // but a slot restored after a reload often no longer carries one \u2014
          // which is why tiles rearranged themselves on refresh. The queue row
          // knows, so ask it.
          let queuedMs = typeof queuedAt === 'number' ? queuedAt : 0
          if (!queuedMs) {
            try {
              const q = await prisma.generationQueue.findFirst({
                where: { falRequestId: requestId },
                select: { createdAt: true },
              })
              if (q?.createdAt) queuedMs = q.createdAt.getTime()
            } catch { /* ordering is worth a try, not a failure */ }
          }

          const created = await prisma.$transaction(async (tx) => {
            // ONE WRITER PER REQUEST ID.
            //
            // The idempotency check above is read-then-act: two pollers for the
            // same job \u2014 a restored one and a re-armed one, say \u2014 both saw no
            // rows and both inserted, which is how seven finished generations
            // became fourteen tiles after a reload. The lock is transaction
            // scoped, so it is released even if this throws.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'nb2-save-' + requestId}))`
            const already = await tx.generatedImage.findMany({
              where: { falRequestId: requestId },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
            if (already.length > 0) return already
            return Promise.all(hostedImages.map(img =>
            tx.generatedImage.create({
              data: {
                userId:             targetUserId!,
                prompt:             prompt || '',
                imageUrl:           img.url,
                model:              'nano-banana-pro-2',
                ticketCost:         typeof ticketCost === 'number' ? ticketCost : 0,
                quality:            quality || 'auto',
                aspectRatio:        aspectRatio || 'auto',
                referenceImageUrls: Array.isArray(referenceImageUrls) ? referenceImageUrls : [],
                expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                falRequestId:       requestId,
                // createdAt = when the user QUEUED the generation (the feed's
                // ordering key), not when it completed — keeps queue order
                // stable across refresh. Sanity-capped to the last 24h.
                ...(queuedMs > Date.now() - 24 * 3600 * 1000 && queuedMs <= Date.now() + 60_000
                  ? { createdAt: new Date(queuedMs) } : {}),
                // Full generation settings for the info panel
                ...(videoMetadata && typeof videoMetadata === 'object'
                  ? { videoMetadata: videoMetadata as object } : {}),
              },
              select: { id: true },
            })
            ))
          })
          created.forEach(r => savedIds.push(r.id))
        }
      } catch (dbErr) {
        console.error('nb2-status: DB save failed (non-fatal):', dbErr)
      }

      await releaseQueueSlot(requestId, false)
      console.log(`✓ NanoBanana 2 completed [${requestId}] ${hostedImages.length} image(s)`)
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
    console.error('nb2-status error:', error)
    if (error.status === 422 || error.constructor?.name === 'ValidationError') {
      const detail = Array.isArray(error.body?.detail)
        ? error.body.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
        : error.body?.message || error.message || 'Unprocessable content'
      if (requestId) await releaseQueueSlot(requestId, true, `Generation failed: ${detail}`)
      return NextResponse.json({ status: 'failed', error: `Generation failed: ${detail}` })
    }
    // 404 / job not found — permanent failure (job expired or never registered)
    if (error.status === 404 || /not.found|no.longer.available|expired/i.test(error.message ?? '')) {
      if (requestId) await releaseQueueSlot(requestId, true, 'Generation request expired or not found')
      return NextResponse.json({ status: 'failed', error: 'Generation request expired or not found' })
    }
    // Transient error — keep polling
    return NextResponse.json({ status: 'in_progress', error: error.message })
  }
}
