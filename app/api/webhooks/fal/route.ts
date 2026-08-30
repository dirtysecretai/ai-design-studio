import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { FAL_GLOBAL_ID, promoteNextQueuedJob } from '@/lib/fal-queue'
import { releaseReservedTickets } from '@/lib/ticket-gate'
import { getTrainerFamily } from '@/lib/trainer-families'

// FAL.ai calls this endpoint when an async job completes or fails.
// We must return 200 quickly — FAL.ai will retry on non-200 responses.
export async function POST(request: Request) {
  try {
    const body = await request.json()
    console.log('=== FAL.AI WEBHOOK RECEIVED ===')
    console.log('request_id:', body.request_id)
    console.log('status:', body.status)

    const { request_id, status, payload, error } = body

    if (!request_id) {
      console.error('Webhook missing request_id')
      return NextResponse.json({ error: 'Missing request_id' }, { status: 400 })
    }

    // Look up the queue entry by falRequestId
    const queueItem = await prisma.generationQueue.findFirst({
      where: { falRequestId: request_id }
    })

    if (!queueItem) {
      // Check if this is a LoRA training job
      const loraJob = await prisma.loraTrainingJob.findFirst({
        where: { requestId: request_id },
      })

      if (loraJob) {
        console.log(`Found LoRA training job #${loraJob.id} for request_id: ${request_id}`)

        if (status === 'ERROR' || status === 'FAILED' || error) {
          const errorMsg = error?.message || error || 'FAL training failed'
          await prisma.loraTrainingJob.update({
            where: { id: loraJob.id },
            data: { status: 'failed', errorMsg },
          })
          console.log(`LoRA job #${loraJob.id} marked failed: ${errorMsg}`)
        } else if (status === 'OK' || status === 'COMPLETED') {
          const data = payload as Record<string, { url?: string } | null> | null
          console.log('[lora-webhook] payload keys:', data ? Object.keys(data) : 'null')
          console.log('[lora-webhook] payload sample:', JSON.stringify(data).substring(0, 500))
          // Try multiple field names — different trainers use different keys
          const loraUrl   = data?.diffusers_lora_file?.url
            ?? data?.lora_file?.url
            ?? data?.safetensors_lora_file?.url
            ?? data?.output_lora_file?.url
            ?? null
          const configUrl = data?.config_file?.url ?? null
          // Trainer families (wan22/ltx2): capture EVERY output file url so
          // finalize can re-host multi-file outputs (e.g. high_noise_lora)
          const family = getTrainerFamily(loraJob.modelId)
          const jobConfig = (loraJob.config ?? {}) as Record<string, unknown>
          const resultUrls: Record<string, string> = {}
          if (family && data) {
            for (const f of family.outputFiles) {
              const u = data[f.key]?.url
              if (u) resultUrls[f.key] = u
            }
          }
          await prisma.loraTrainingJob.update({
            where: { id: loraJob.id },
            data: {
              status: 'completed', loraUrl, configUrl,
              ...(family ? { config: { ...jobConfig, _result: resultUrls } as object } : {}),
            },
          })
          console.log(`LoRA job #${loraJob.id} completed — loraUrl: ${loraUrl}`)
          // Kick artifact re-hosting to R2 (idempotent; status poller also kicks)
          if (family) {
            after(async () => {
              const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://prompt-protocol.vercel.app'
              await fetch(`${base}/api/admin/lora-training/finalize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD ?? '' },
                body: JSON.stringify({ jobId: loraJob.id }),
                signal: AbortSignal.timeout(10_000),
              }).catch(() => {})
            })
          }
        }

        return NextResponse.json({ received: true })
      }

      console.error(`No queue item or LoRA job found for request_id: ${request_id}`)
      // Return 200 anyway — if we return non-200 FAL.ai retries indefinitely
      return NextResponse.json({ received: true })
    }

    // Idempotency: if already settled, acknowledge and skip.
    // Use an atomic status update (updateMany with status filter) so concurrent webhook
    // calls can't both pass this check and double-release the reserved tickets.
    const claimed = await prisma.generationQueue.updateMany({
      where: { id: queueItem.id, status: { notIn: ['completed', 'failed'] } },
      data: { status: 'processing' }, // no-op state change just to acquire the lock
    })
    if (claimed.count === 0) {
      console.log(`Queue item #${queueItem.id} already settled or claimed by concurrent call — skipping`)
      return NextResponse.json({ received: true })
    }

    console.log(`Found queue item #${queueItem.id} for user ${queueItem.userId}`)

    const params = queueItem.parameters as any
    console.log(`[webhook] loraUrl=${params?.loraUrl ?? 'none'} loraName=${params?.loraName ?? 'none'} endpoint stored=${params?.falEndpoint ?? 'immediate-path'}`)

    // ─── FAILURE PATH ───────────────────────────────────────────────
    if (status === 'ERROR' || status === 'FAILED' || error) {
      // fal hands back anything from a string to a validation array. Keep the
      // raw text for the record and show the user something they can act on —
      // a stored "Unexpected status code: 422" tells nobody what to change.
      const rawDetail = Array.isArray(error?.detail)
        ? error.detail.map((d: any) => d?.msg || d?.message || JSON.stringify(d)).join('; ')
        : (typeof error === 'string' ? error : error?.message || error?.detail || 'FAL.ai generation failed')
      const { friendlyFalError } = await import('@/lib/fal-friendly-errors')
      const errorMsg = friendlyFalError(String(rawDetail), params?.model)
      console.error(`FAL.ai job failed for queue #${queueItem.id}:`, rawDetail)
      console.error(`FAL.ai full error object:`, JSON.stringify(error))
      console.error(`FAL.ai full body:`, JSON.stringify(body))

      await Promise.all([
        // Release the reservation — balance was never decremented so no refund needed.
        // GREATEST(0,...) ensures reserved never goes negative (which would inflate balance checks).
        releaseReservedTickets(queueItem.userId, queueItem.ticketCost),
        // Mark queue item failed
        prisma.generationQueue.update({
          where: { id: queueItem.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: errorMsg,
            // Dev-server logs scroll away; the provider's own words belong on
            // the row so a failure can be diagnosed after the fact.
            parameters: { ...(params ?? {}), falError: String(rawDetail).slice(0, 600) },
          }
        })
      ])

      // Decrement active counts (per-model + global) then open a slot for the next queued job
      await Promise.all([
        prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: queueItem.modelId },
          data: { currentActive: { decrement: 1 } },
        }),
        prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: FAL_GLOBAL_ID },
          data: { currentActive: { decrement: 1 } },
        }),
      ])
      await promoteNextQueuedJob()

      console.log(`Queue item #${queueItem.id} marked as failed, tickets refunded`)
      return NextResponse.json({ received: true })
    }

    // ─── SUCCESS PATH ────────────────────────────────────────────────
    if (status === 'OK' || status === 'COMPLETED') {
      console.log(`FAL.ai job completed for queue #${queueItem.id}`)

      // Extract images from FAL.ai payload
      // FAL.ai wraps the model output in payload.images[] for image models
      // Clarity upscaler returns payload.image (singular); all other models return payload.images[]
      const images: { url: string }[] = payload?.images || (payload?.image?.url ? [payload.image] : [])

      if (images.length === 0) {
        console.error('Webhook payload has no images:', JSON.stringify(payload).substring(0, 300))
        await Promise.all([
          releaseReservedTickets(queueItem.userId, queueItem.ticketCost),
          prisma.generationQueue.update({
            where: { id: queueItem.id },
            data: {
              status: 'failed',
              completedAt: new Date(),
              errorMessage: 'No images in FAL.ai response'
            }
          })
        ])
        await Promise.all([
          prisma.modelConcurrencyLimit.updateMany({
            where: { modelId: queueItem.modelId },
            data: { currentActive: { decrement: 1 } },
          }),
          prisma.modelConcurrencyLimit.updateMany({
            where: { modelId: FAL_GLOBAL_ID },
            data: { currentActive: { decrement: 1 } },
          }),
        ])
        await promoteNextQueuedJob()
        return NextResponse.json({ received: true })
      }

      // Upload each image to Vercel Blob and create DB records
      const uploadedImages: { url: string; id: number }[] = []
      const isAdminMode = params?.adminMode === true

      const expiresAt = new Date()
      expiresAt.setFullYear(expiresAt.getFullYear() + 100)

      for (let i = 0; i < images.length; i++) {
        const falImageUrl = images[i].url
        console.log(`Downloading image ${i + 1}/${images.length} from FAL.ai: ${falImageUrl}`)

        try {
          const imageResponse = await fetch(falImageUrl)
          if (!imageResponse.ok) {
            console.error(`Failed to download image ${i + 1}: ${imageResponse.status}`)
            continue
          }

          const imgBuffer = Buffer.from(await imageResponse.arrayBuffer())
          console.log(`Downloaded image ${i + 1}: ${(imgBuffer.length / 1024 / 1024).toFixed(2)} MB`)

          // Keep the real file type. Recraft's vector models return SVG, and
          // storing that as .png/image-png leaves a file nothing can render.
          const falType = (imageResponse.headers.get('content-type') || '').split(';')[0].trim()
          const looksSvg = falType === 'image/svg+xml'
            || /\.svg(\?|#|$)/i.test(falImageUrl)
            || imgBuffer.slice(0, 400).toString('utf8').trimStart().startsWith('<svg')
          const ext = looksSvg ? 'svg'
            : falType === 'image/webp' ? 'webp'
            : falType === 'image/jpeg' ? 'jpg'
            : 'png'
          const mime = looksSvg ? 'image/svg+xml'
            : falType.startsWith('image/') ? falType
            : 'image/png'
          const filename = `universe-scan-${queueItem.userId}-${Date.now()}-${i}.${ext}`
          const url = await uploadToR2(filename, imgBuffer, mime)
          console.log(`Uploaded image ${i + 1} to blob: ${url}`)

          // Save to GeneratedImage table
          const ticketCostForThisImage = i === 0 && !isAdminMode ? queueItem.ticketCost : 0

          const savedImage = await prisma.generatedImage.create({
            data: {
              // QUEUE time, not completion time. The feed orders on createdAt,
              // so defaulting to now() reshuffled every tile on refresh: jobs
              // finish out of order (different models, retries, queue waits)
              // and a batch of 100 landed in a different order than it ran.
              // The queue row's own timestamp is when the user asked for it.
              createdAt: queueItem.createdAt,
              userId: queueItem.userId,
              prompt: params?.savePrompt || queueItem.prompt,
              imageUrl: url,
              model: queueItem.modelId,
              ticketCost: isAdminMode ? 0 : ticketCostForThisImage,
              referenceImageUrls: (params?.referenceImageUrls as string[]) || [],
              quality: (params?.quality as string) || null,
              aspectRatio: (params?.aspectRatio as string) || null,
              videoMetadata: params?.loraUrl
                ? { loraUrl: params.loraUrl, loraName: params.loraName ?? undefined }
                : queueItem.modelId === 'clarity-upscaler'
                  ? {
                      upscaleFactor: params?.upscaleFactor,
                      upscaleCreativity: params?.upscaleCreativity,
                      upscaleResemblance: params?.upscaleResemblance,
                      upscaleGuidance: params?.upscaleGuidance,
                      upscaleSteps: params?.upscaleSteps,
                    }
                  : queueItem.modelId === 'aura-sr'
                    ? {
                        upscaleFactor: params?.upscaleFactor,
                        auraSrCheckpoint: params?.auraSrCheckpoint,
                        auraSrOverlappingTiles: params?.auraSrOverlappingTiles,
                      }
                    : queueItem.modelId === 'esrgan'
                      ? {
                          upscaleFactor: params?.upscaleFactor,
                          esrganModel: params?.esrganModel,
                          esrganFace: params?.esrganFace,
                          esrganOutputFormat: params?.esrganOutputFormat,
                        }
                      : queueItem.modelId === 'drct'
                        ? {
                            upscaleFactor: params?.upscaleFactor,
                            drctTicketCost: params?.drctTicketCost,
                          }
                        : undefined,
              expiresAt,
            }
          })

          uploadedImages.push({ url, id: savedImage.id })
          console.log(`Saved GeneratedImage #${savedImage.id}`)
        } catch (imgError) {
          console.error(`Error processing image ${i + 1}:`, imgError)
        }
      }

      if (uploadedImages.length === 0) {
        // All image downloads/uploads failed
        await Promise.all([
          releaseReservedTickets(queueItem.userId, queueItem.ticketCost),
          prisma.generationQueue.update({
            where: { id: queueItem.id },
            data: {
              status: 'failed',
              completedAt: new Date(),
              errorMessage: 'Failed to process all images from FAL.ai'
            }
          })
        ])
        await Promise.all([
          prisma.modelConcurrencyLimit.updateMany({
            where: { modelId: queueItem.modelId },
            data: { currentActive: { decrement: 1 } },
          }),
          prisma.modelConcurrencyLimit.updateMany({
            where: { modelId: FAL_GLOBAL_ID },
            data: { currentActive: { decrement: 1 } },
          }),
        ])
        await promoteNextQueuedJob()
        return NextResponse.json({ received: true })
      }

      // Finalize tickets — this is the FIRST and ONLY balance deduction.
      // The generate route only reserved tickets; the actual spend happens here
      // once FAL.ai confirms the image was successfully delivered.
      // GREATEST(0, reserved - cost) ensures reserved never goes negative.
      if (!isAdminMode) {
        await prisma.$executeRaw`
          UPDATE "Ticket"
          SET
            balance     = balance - ${queueItem.ticketCost},
            reserved    = GREATEST(0, reserved - ${queueItem.ticketCost}),
            "totalUsed" = "totalUsed" + ${queueItem.ticketCost}
          WHERE "userId" = ${queueItem.userId}
        `
      } else {
        // Admin mode — just clear the reservation without charging
        await releaseReservedTickets(queueItem.userId, queueItem.ticketCost)
      }

      // Mark queue item completed with the primary result URL and image ID
      await prisma.generationQueue.update({
        where: { id: queueItem.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          resultUrl: uploadedImages[0].url,
          resultImageId: uploadedImages[0].id,
          // Store all image URLs in parameters for multi-image models (NanoBanana)
          parameters: {
            ...(params || {}),
            completedImageUrls: uploadedImages.map(img => img.url),
            completedImageIds: uploadedImages.map(img => img.id),
          }
        }
      })

      // Decrement active counts (per-model + global) then promote next queued job
      await Promise.all([
        prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: queueItem.modelId },
          data: { currentActive: { decrement: 1 } },
        }),
        prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: FAL_GLOBAL_ID },
          data: { currentActive: { decrement: 1 } },
        }),
      ])
      await promoteNextQueuedJob()

      console.log(`=== WEBHOOK COMPLETE: Queue #${queueItem.id} done, ${uploadedImages.length} image(s) saved ===`)
      return NextResponse.json({ received: true })
    }

    // Unknown status — just acknowledge
    console.warn(`Unknown FAL.ai webhook status: ${status}`)
    return NextResponse.json({ received: true })

  } catch (err: any) {
    console.error('FAL.ai webhook error:', err)
    // Return 200 to prevent FAL.ai from retrying endlessly on our internal errors
    return NextResponse.json({ received: true })
  }
}
