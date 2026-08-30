import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import prisma from '@/lib/prisma'
import { releaseQueueSlot } from '@/lib/admin-queue-helpers'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { uploadToR2 } from '@/lib/r2'

fal.config({ credentials: process.env.FAL_KEY! })

// POST /api/admin/video-status
// Polls a FAL queue video job and saves to DB on completion.
// Requires a valid session — previously anyone with a requestId+falEndpoint could
// drive fal.queue.result + an R2 upload here.
export async function POST(req: Request) {
  let requestId: string | undefined
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null
    if (!sessionUser) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await req.json()
    requestId = body.requestId
    const { falEndpoint, prompt, model, duration, resolution, ticketCost, aspectRatio, audioEnabled, startFrameUrl, endFrameUrl, motionVideoUrl, keepOriginalSound, characterOrientation } = body
    if (!requestId || !falEndpoint) {
      return NextResponse.json({ error: 'Missing requestId or falEndpoint' }, { status: 400 })
    }

    const status = await fal.queue.status(falEndpoint, { requestId, logs: false })

    if (status.status === 'COMPLETED') {
      // Idempotency guard: if the GenerationQueue entry is already 'completed', a previous poll
      // already saved this video to DB. Return the result without creating a duplicate row.
      const existingJob = await prisma.generationQueue.findFirst({
        where: { falRequestId: requestId, status: 'completed' },
        select: { id: true },
      })

      const result = await fal.queue.result<any>(falEndpoint, { requestId })
      const falVideoUrl = result.data?.video?.url
      if (!falVideoUrl) {
        return NextResponse.json({ status: 'failed', error: 'No video URL in FAL result' })
      }

      if (existingJob) {
        // Already processed — skip DB save to prevent duplicate.
        console.log(`⚡ Video already saved [${requestId}] — returning cached result`)
        let cachedVideoId: number | null = null
        let cachedVideoUrl = falVideoUrl
        try {
          const saved = await prisma.generatedImage.findFirst({
            where: { falRequestId: requestId },
            select: { id: true, imageUrl: true },
            orderBy: { id: 'desc' },
          })
          if (saved) { cachedVideoId = saved.id; cachedVideoUrl = saved.imageUrl }
        } catch {}
        return NextResponse.json({ status: 'completed', videoUrl: cachedVideoUrl, videoId: cachedVideoId })
      }

      console.log(`✓ Video generation completed [${requestId}] model=${model} duration=${duration} url=${falVideoUrl}`)

      // Upload video to Vercel Blob for permanent storage (FAL URLs expire after ~24–48h)
      let permanentVideoUrl = falVideoUrl
      try {
        const videoRes = await fetch(falVideoUrl)
        if (videoRes.ok) {
          const contentType = videoRes.headers.get('content-type') || 'video/mp4'
          const ext = contentType.includes('webm') ? 'webm' : 'mp4'
          const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
          const filename = `video-admin-${Date.now()}.${ext}`
          permanentVideoUrl = await uploadToR2(filename, videoBuffer, contentType)
          console.log(`[admin/video-status] Uploaded video to blob: ${permanentVideoUrl}`)
        }
      } catch (uploadErr) {
        console.error('[admin/video-status] Failed to upload video to blob (using FAL URL as fallback):', uploadErr)
      }

      // Save to DB under the session user
      let savedVideoId: number | null = null
      try {
        if (!sessionUser) {
          console.error('Admin video-status: no session user — skipping DB save')
        } else {
          // Queue time for the feed's ordering key. existingJob above is the
          // completed-dedupe probe (null here by definition), so ask for the
          // row itself: completion order is not the order things were asked for.
          const queueRow = await prisma.generationQueue.findFirst({
            where: { falRequestId: requestId },
            select: { createdAt: true },
            orderBy: { id: 'desc' },
          })
          const created = await prisma.generatedImage.create({
            data: {
              ...(queueRow ? { createdAt: queueRow.createdAt } : {}),
              userId:      sessionUser.id,
              prompt:      prompt || '',
              imageUrl:    permanentVideoUrl,
              model:       model || 'wan-2.5',
              quality:     resolution || '1080p',
              aspectRatio: aspectRatio || '16:9',
              ticketCost:  ticketCost || 0,
              expiresAt:   new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
              falRequestId: requestId,
              videoMetadata: {
                duration:             duration || '5',
                resolution:           resolution || '1080p',
                aspectRatio:          aspectRatio || '16:9',
                isVideo:              true,
                audioEnabled:         audioEnabled ?? false,
                startFrameUrl:        startFrameUrl || null,
                endFrameUrl:          endFrameUrl || null,
                motionVideoUrl:       motionVideoUrl || null,
                keepOriginalSound:    keepOriginalSound ?? true,
                characterOrientation: characterOrientation || null,
              } as any,
            },
            select: { id: true },
          })
          savedVideoId = created.id
        }
      } catch (dbErr) {
        console.error('Admin video-status: failed to save to DB (non-fatal):', dbErr)
      }

      await releaseQueueSlot(requestId, false)
      return NextResponse.json({ status: 'completed', videoUrl: permanentVideoUrl, videoId: savedVideoId })

    } else if ((status as any).status === 'ERROR' || (status as any).status === 'FAILED') {
      await releaseQueueSlot(requestId, true, 'Video generation failed on FAL servers')
      return NextResponse.json({ status: 'failed', error: 'Video generation failed on FAL servers' })
    } else {
      // IN_QUEUE or IN_PROGRESS — keep polling
      return NextResponse.json({ status: 'in_progress', falStatus: status.status })
    }

  } catch (error: any) {
    console.error('Admin video status error:', error, 'body:', JSON.stringify(error.body))
    // 422 ValidationError = FAL rejected the job (bad input, unsupported format, content policy)
    // Treat these as permanent failures so the UI stops polling and shows the error.
    if (error.status === 422 || error.constructor?.name === 'ValidationError') {
      const rawDetail = Array.isArray(error.body?.detail)
        ? error.body.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
        : error.body?.message || error.message || 'Unprocessable content'
      const { friendlyFalVideoError } = await import('@/lib/fal-friendly-errors')
      const detail = friendlyFalVideoError(rawDetail)
      if (requestId) await releaseQueueSlot(requestId, true, `Generation failed: ${detail}`)
      return NextResponse.json({ status: 'failed', error: `Generation failed: ${detail}` })
    }
    // Return in_progress on transient network/server errors so the client keeps polling
    return NextResponse.json({ status: 'in_progress', error: error.message })
  }
}
