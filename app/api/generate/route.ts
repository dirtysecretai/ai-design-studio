import { NextResponse } from 'next/server'
import { after } from 'next/server'
import prisma from '@/lib/prisma'
import { resolveRequestUser, requireScopes, canUseModel, modelNotPermittedResponse } from '@/lib/api-key-auth'
import { uploadToR2 } from '@/lib/r2'
import { getTicketCost, getModelById } from '@/config/ai-models.config'
import { fal } from "@fal-ai/client"
import { isGenerationBlocked } from '@/lib/generation-guard'
import { reserveGenerationTickets } from '@/lib/ticket-gate'
import { checkUserConcurrency } from '@/lib/user-concurrency'
import { enforceContentFilter } from '@/lib/content-filter'
import {
  FAL_IMAGE_MODEL_IDS,
  getFalImageModelSpec,
  buildFalImageInput,
  falImageModelIsPromptless,
} from '@/lib/fal-image-models'


const GEMINI_API_KEY = process.env.GEMINI_API_KEY

// NEW: Configure FAL.ai
fal.config({
  credentials: process.env.FAL_KEY
})

// A reference image arrives either as an https URL (library images — the client
// sends the URL directly instead of base64-encoding megabytes into <img>+canvas
// on iPad Safari) or as a base64 data URL (File/pre-upload refs). These
// normalize both shapes for the various downstream consumers.
async function refToBuffer(ref: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(ref)) {
    const r = await fetch(ref, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`reference fetch ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  return Buffer.from(ref.split(',')[1] || ref, 'base64')
}
async function refToBase64(ref: string): Promise<string> {
  if (/^https?:\/\//i.test(ref)) return (await refToBuffer(ref)).toString('base64')
  return ref.split(',')[1] || ref
}

export async function POST(request: Request) {
  try {
    console.log('=== UNIVERSE SCAN STARTED ===')

    // Check authentication — bearer API key (desktop app) or session cookie
    const resolved = await resolveRequestUser(request)
    if ('error' in resolved) return resolved.error
    const { user, apiAuth } = resolved

    console.log('User:', user.email, 'Balance:', user.tickets?.balance)

    // Check system state
    const systemState = await prisma.systemState.findFirst()

    // Check maintenance — admins and audit accounts bypass
    if (await isGenerationBlocked(user.email?.toLowerCase())) {
      return NextResponse.json(
        { error: 'Multiverse Scanner is offline for maintenance' },
        { status: 503 }
      )
    }

    // Parse request body
    const body = await request.json()
    const {
      prompt,
      quality = '2k',
      aspectRatio = '16:9',
      referenceImages = [],
      model = 'gemini-2.5-flash-image',  // Default to Flash Scanner v2.5
      adminMode: adminModeRaw = false,  // Admin mode - no ticket deduction
      syncMode: syncModeRaw = false,   // If true: wait for FAL.ai and return imageUrl directly (used by composition canvas)
      loraUrl,            // Optional LoRA weights URL
      loraName,           // Optional LoRA display name (for metadata)
      loraScale = 1.0,    // LoRA strength (0-2)
      loraGuidanceScale,  // Guidance / CFG scale override
      loraSteps,          // Inference steps override
      // Clarity Upscaler params
      upscaleImageUrl,
      upscaleFactor = 2,
      upscaleCreativity = 0.35,
      upscaleResemblance = 0.6,
      upscaleGuidance = 4,
      upscaleSteps = 18,
      // AuraSR params
      auraSrCheckpoint = 'v2',
      auraSrOverlappingTiles = false,
      // ESRGAN params
      esrganModel = 'RealESRGAN_x4plus',
      esrganFace = false,
      esrganOutputFormat = 'png',
      // SUPIR params
      supirModelName = 'SUPIR-v0F',
      supirSteps = 20,
      supirUseLlava = false,
      supirCfg = 4.0,
      supirColorFix = 'Wavelet',
      supirNegPrompt = 'blurry, noisy, low quality, oversmoothed, jpeg artifacts, deformed',
      // SeeDream 4.5 params
      seedreamSafetyChecker = false,
      // FLUX 1 Dev params
      fluxDevSafetyChecker = true,
    } = body

    // Gemini scanner models were retired from the public offering (2026-07-29):
    // ADMIN ONLY, enforced server-side regardless of which UI submitted the job
    // The 2026-08 fal image batch (Qwen 3, Reve 2.1, MAI 2.5, Grok Imagine 2,
    // Meta Muse, Bria FIBO, Ideogram v4, NB2 Lite, Recraft v4, Pixelcut,
    // Virtual Try-On, Topaz suite) is admin-only while under test.
    const ADMIN_ONLY_IMAGE_MODELS = new Set([
      'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image-preview',
      'flash-scanner-v2.5', 'pro-scanner-v3',
      ...FAL_IMAGE_MODEL_IDS,
    ])
    if (ADMIN_ONLY_IMAGE_MODELS.has(model)) {
      const { checkIsAdmin } = await import('@/lib/admin-check')
      if (!(await checkIsAdmin(user.email))) {
        return NextResponse.json({ error: 'This model is not available' }, { status: 403 })
      }
    }

    // Bearer API-key calls: enforce scopes + per-model permission, and force the
    // queue path (adminMode/syncMode are portal concepts — sync blocks too long
    // for a desktop poller).
    if (apiAuth) {
      const denied = requireScopes(apiAuth, 'generate:image', 'tickets:spend')
      if (denied) return denied
      if (!canUseModel(apiAuth, 'image', model)) return modelNotPermittedResponse(model)
    }
    const adminMode = apiAuth ? false : adminModeRaw
    const syncMode = apiAuth ? false : syncModeRaw

    // Check if admin mode is requested and user is actually admin
    const isAdminUser = user.email === 'dirtysecretai@gmail.com'
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, user.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    const skipTickets = adminMode && isAdminUser

    if (skipTickets) {
      console.log('🔓 ADMIN MODE: Skipping ticket check/deduction for', user.email)
    }

    // Upscaler models don't require a prompt
    if (model !== 'clarity-upscaler' && model !== 'aura-sr' && model !== 'esrgan' && model !== 'drct' && model !== 'supir' && !falImageModelIsPromptless(model) && (!prompt || prompt.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Universe coordinates required' },
        { status: 400 }
      )
    }

    // Validate model exists and is available
    const selectedModel = getModelById(model)
    if (!selectedModel || !selectedModel.isAvailable) {
      return NextResponse.json({ 
        error: `Model ${model} is not available. Please select a different model.` 
      }, { status: 400 })
    }

    // Check per-model maintenance status
    if (model === 'nano-banana' && systemState?.nanoBananaMaintenance) {
      return NextResponse.json(
        { error: 'NanoBanana is currently offline. Please try NanoBanana Pro or SeeDream 4.5 instead.' },
        { status: 503 }
      )
    }
    
    if (model === 'nano-banana-pro' && systemState?.nanoBananaProMaintenance) {
      return NextResponse.json(
        { error: 'NanoBanana Pro is currently offline. Please try NanoBanana or SeeDream 4.5 instead.' },
        { status: 503 }
      )
    }

    if (model === 'seedream-4.5' && systemState?.seedreamMaintenance) {
      return NextResponse.json(
        { error: 'SeeDream 4.5 is currently offline. Please try NanoBanana or NanoBanana Pro instead.' },
        { status: 503 }
      )
    }

    // Get ticket cost
    const ticketCost = model === 'clarity-upscaler'
      ? (upscaleFactor === 4 ? 26 : 7)
      : model === 'aura-sr' || model === 'esrgan'
        ? 1
        : model === 'drct'
          ? 1 // minimum; actual cost computed server-side after fetching image dimensions
          : getTicketCost(model, quality)
    console.log('Selected model:', selectedModel.displayName, '- Quality:', quality, '- Cost:', ticketCost, 'ticket(s)')

    // Per-user concurrency cap — this route creates GenerationQueue rows but never
    // gated on them, so a user could fire unlimited concurrent FAL jobs (runaway
    // cost). checkUserConcurrency counts the user's in-flight image jobs; owners
    // get a 999 limit so admins are effectively unlimited.
    if (!adminMode) {
      const { allowed, activeCount, limit } = await checkUserConcurrency(user.id)
      if (!allowed) {
        return NextResponse.json(
          { error: `Too many generations in progress (${activeCount}/${limit}). Wait for one to finish.` },
          { status: 429 }
        )
      }
    }

    // Check ticket balance (skip for admin mode)
    const ticketRecord = await prisma.ticket.findUnique({
      where: { userId: user.id }
    })

    // Effective available balance = balance minus any tickets reserved for in-flight jobs.
    // Clamp reserved to >= 0: a negative reserved field (from a bug or race) would otherwise
    // inflate the effective balance and allow generations with 0 tickets.
    const reservedSafe = Math.max(0, ticketRecord?.reserved ?? 0)
    const effectiveBalance = (ticketRecord?.balance ?? 0) - reservedSafe
    if (!skipTickets && effectiveBalance < ticketCost) {
      return NextResponse.json(
        { error: `Insufficient tickets. Need ${ticketCost} ticket(s), but you have ${effectiveBalance}.` },
        { status: 402 }
      )
    }

    console.log('Scanning universe with coordinates:', prompt)
    console.log('Parameters:', { 
      model: selectedModel.displayName,
      quality, 
      aspectRatio, 
      referenceImageCount: referenceImages.length,
      ticketCost
    })

    // Generate image using selected model
    console.log(`Generating image with ${selectedModel.displayName}...`)
    const generateStart = Date.now()

    let buffer: Buffer
    let imageBuffers: Buffer[] = []  // For multi-image models (Gemini only now)

    // Route to correct provider based on model
    if (selectedModel.provider === 'fal' || model === 'supir') {
      // ============================================
      // FAL.AI PROVIDER — ASYNC via fal.queue.submit
      // Images arrive via webhook at /api/webhooks/fal
      // ============================================
      console.log('Using FAL.ai async queue...')

      let reservationMade = false
      try {
        let modelEndpoint = selectedModel.name

        // ── Clarity Upscaler ─────────────────────────────────────────────────
        if (model === 'clarity-upscaler') {
          if (!upscaleImageUrl) {
            return NextResponse.json({ error: 'upscaleImageUrl is required for clarity-upscaler' }, { status: 400 })
          }
          const upscalePrompt = (prompt || 'masterpiece, best quality, highres').trim()

          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, ticketCost)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${reserveResult.need} ticket(s), but you have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
          const webhookUrl = `${process.env.APP_URL || `https://${process.env.VERCEL_URL}`}/api/webhooks/fal`

          // Re-upload source image to FAL storage so FAL can fetch it reliably.
          // R2 URLs can be inaccessible from FAL's servers; FAL CDN URLs always work.
          // For 4x upscale: pre-shrink the image so output stays ≤4096px on the long side,
          // since FAL clarity-upscaler rejects inputs where upscale_factor * max(w,h) > ~4096.
          const FAL_MAX_OUTPUT_PX = 4096
          let falSourceUrl = upscaleImageUrl
          try {
            const srcRes = await fetch(upscaleImageUrl, { signal: AbortSignal.timeout(20_000) })
            if (srcRes.ok) {
              const contentType = srcRes.headers.get('content-type') || 'image/jpeg'
              const rawBuffer = Buffer.from(await srcRes.arrayBuffer())
              let uploadBuffer: Buffer | Uint8Array = rawBuffer

              if (upscaleFactor > 2) {
                const sharp = (await import('sharp')).default
                const meta = await sharp(rawBuffer).metadata()
                const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0)
                const maxInputPx = Math.floor(FAL_MAX_OUTPUT_PX / upscaleFactor)
                if (maxDim > maxInputPx) {
                  uploadBuffer = await sharp(rawBuffer)
                    .resize({ [meta.width! >= meta.height! ? 'width' : 'height']: maxInputPx, withoutEnlargement: true })
                    .jpeg({ quality: 95 })
                    .toBuffer()
                  console.log(`[clarity-upscaler] pre-resized source to fit ${upscaleFactor}x limit (was ${maxDim}px, capped at ${maxInputPx}px)`)
                }
              }

              const srcBlob = new Blob([new Uint8Array(uploadBuffer)], { type: contentType })
              falSourceUrl = await fal.storage.upload(srcBlob)
              console.log(`[clarity-upscaler] re-uploaded source to FAL storage: ${falSourceUrl}`)
            }
          } catch (uploadErr) {
            console.warn('[clarity-upscaler] failed to re-upload to FAL storage, using original URL:', uploadErr)
          }

          const { request_id } = await fal.queue.submit('fal-ai/clarity-upscaler', {
            input: {
              image_url: falSourceUrl,
              prompt: upscalePrompt,
              upscale_factor: upscaleFactor,
              negative_prompt: '(worst quality, low quality, normal quality:2)',
              creativity: upscaleCreativity,
              resemblance: upscaleResemblance,
              guidance_scale: upscaleGuidance,
              num_inference_steps: upscaleSteps,
              enable_safety_checker: false,
            },
            webhookUrl,
          })

          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: model,
              modelType: 'image',
              prompt: upscalePrompt,
              parameters: {
                source: 'main-scanner',
                quality: `${upscaleFactor}x`,
                aspectRatio: 'auto',
                model,
                adminMode: skipTickets,
                upscaleImageUrl,
                upscaleFactor,
                upscaleCreativity,
                upscaleResemblance,
                upscaleGuidance,
                upscaleSteps,
              },
              status: 'processing',
              ticketCost: skipTickets ? 0 : ticketCost,
              falRequestId: request_id,
              startedAt: new Date(),
            }
          })

          await Promise.all([
            prisma.modelConcurrencyLimit.updateMany({
              where: { modelId: model },
              data: { currentActive: { increment: 1 } },
            }),
            prisma.modelConcurrencyLimit.updateMany({
              where: { modelId: FAL_GLOBAL_ID },
              data: { currentActive: { increment: 1 } },
            }),
          ])

          console.log(`[clarity-upscaler] ${upscaleFactor}x submitted, request_id=${request_id}`)
          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: `${upscaleFactor}x upscale queued — ${ticketCost} ticket(s) reserved.`,
            modelUsed: selectedModel.displayName,
            ticketsUsed: skipTickets ? 0 : ticketCost,
          })
        }

        // ── AuraSR ──────────────────────────────────────────────────────────────
        if (model === 'aura-sr') {
          if (!upscaleImageUrl) {
            return NextResponse.json({ error: 'upscaleImageUrl is required for aura-sr' }, { status: 400 })
          }

          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, 1)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${reserveResult.need} ticket(s), but you have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
          const webhookUrl = `${process.env.APP_URL || `https://${process.env.VERCEL_URL}`}/api/webhooks/fal`

          // Re-upload source to FAL storage for reliable cross-origin access
          let falSourceUrl = upscaleImageUrl
          try {
            const srcRes = await fetch(upscaleImageUrl, { signal: AbortSignal.timeout(20_000) })
            if (srcRes.ok) {
              const contentType = srcRes.headers.get('content-type') || 'image/jpeg'
              const rawBuffer = Buffer.from(await srcRes.arrayBuffer())
              const srcBlob = new Blob([new Uint8Array(rawBuffer)], { type: contentType })
              falSourceUrl = await fal.storage.upload(srcBlob)
              console.log(`[aura-sr] re-uploaded source to FAL storage: ${falSourceUrl}`)
            }
          } catch (uploadErr) {
            console.warn('[aura-sr] failed to re-upload to FAL storage, using original URL:', uploadErr)
          }

          const { request_id } = await fal.queue.submit('fal-ai/aura-sr', {
            input: {
              image_url: falSourceUrl,
              upscaling_factor: upscaleFactor,
              overlapping_tiles: auraSrOverlappingTiles,
              checkpoint: auraSrCheckpoint,
            } as any,
            webhookUrl,
          })

          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: model,
              modelType: 'image',
              prompt: `${upscaleFactor}x AuraSR`,
              parameters: {
                source: 'main-scanner',
                quality: `${upscaleFactor}x`,
                aspectRatio: 'auto',
                model,
                adminMode: skipTickets,
                upscaleImageUrl,
                upscaleFactor,
                auraSrCheckpoint,
                auraSrOverlappingTiles,
              },
              status: 'processing',
              ticketCost: skipTickets ? 0 : 1,
              falRequestId: request_id,
              startedAt: new Date(),
            }
          })

          await Promise.all([
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: model }, data: { currentActive: { increment: 1 } } }),
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: FAL_GLOBAL_ID }, data: { currentActive: { increment: 1 } } }),
          ])

          console.log(`[aura-sr] ${upscaleFactor}x checkpoint=${auraSrCheckpoint} submitted, request_id=${request_id}`)
          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: `${upscaleFactor}x AuraSR queued — 1 ticket reserved.`,
            modelUsed: 'AuraSR',
            ticketsUsed: skipTickets ? 0 : 1,
          })
        }

        // ── ESRGAN ──────────────────────────────────────────────────────────────
        if (model === 'esrgan') {
          if (!upscaleImageUrl) {
            return NextResponse.json({ error: 'upscaleImageUrl is required for esrgan' }, { status: 400 })
          }

          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, 1)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${reserveResult.need} ticket(s), but you have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
          const webhookUrl = `${process.env.APP_URL || `https://${process.env.VERCEL_URL}`}/api/webhooks/fal`

          // Re-upload source to FAL storage for reliable cross-origin access
          let falSourceUrl = upscaleImageUrl
          try {
            const srcRes = await fetch(upscaleImageUrl, { signal: AbortSignal.timeout(20_000) })
            if (srcRes.ok) {
              const contentType = srcRes.headers.get('content-type') || 'image/jpeg'
              const rawBuffer = Buffer.from(await srcRes.arrayBuffer())
              const srcBlob = new Blob([new Uint8Array(rawBuffer)], { type: contentType })
              falSourceUrl = await fal.storage.upload(srcBlob)
              console.log(`[esrgan] re-uploaded source to FAL storage: ${falSourceUrl}`)
            }
          } catch (uploadErr) {
            console.warn('[esrgan] failed to re-upload to FAL storage, using original URL:', uploadErr)
          }

          const { request_id } = await fal.queue.submit('fal-ai/esrgan', {
            input: {
              image_url: falSourceUrl,
              scale: upscaleFactor,
              model: esrganModel,
              face: esrganFace,
              output_format: esrganOutputFormat,
            },
            webhookUrl,
          })

          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: model,
              modelType: 'image',
              prompt: `${upscaleFactor}x ESRGAN (${esrganModel})`,
              parameters: {
                source: 'main-scanner',
                quality: `${upscaleFactor}x`,
                aspectRatio: 'auto',
                model,
                adminMode: skipTickets,
                upscaleImageUrl,
                upscaleFactor,
                esrganModel,
                esrganFace,
                esrganOutputFormat,
              },
              status: 'processing',
              ticketCost: skipTickets ? 0 : 1,
              falRequestId: request_id,
              startedAt: new Date(),
            }
          })

          await Promise.all([
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: model }, data: { currentActive: { increment: 1 } } }),
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: FAL_GLOBAL_ID }, data: { currentActive: { increment: 1 } } }),
          ])

          console.log(`[esrgan] ${upscaleFactor}x model=${esrganModel} submitted, request_id=${request_id}`)
          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: `${upscaleFactor}x ESRGAN queued — 1 ticket reserved.`,
            modelUsed: 'ESRGAN',
            ticketsUsed: skipTickets ? 0 : 1,
          })
        }

        // ── DRCT Super-Resolution ───────────────────────────────────────────────
        if (model === 'drct') {
          if (!upscaleImageUrl) {
            return NextResponse.json({ error: 'upscaleImageUrl is required for drct' }, { status: 400 })
          }

          const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
          const webhookUrl = `${process.env.APP_URL || `https://${process.env.VERCEL_URL}`}/api/webhooks/fal`

          // Fetch image, get dimensions for accurate MP-based pricing, then re-upload to FAL storage.
          let falSourceUrl = upscaleImageUrl
          let drctTicketCost = 1
          try {
            const srcRes = await fetch(upscaleImageUrl, { signal: AbortSignal.timeout(20_000) })
            if (srcRes.ok) {
              const contentType = srcRes.headers.get('content-type') || 'image/jpeg'
              const rawBuffer = Buffer.from(await srcRes.arrayBuffer())
              const sharp = (await import('sharp')).default
              const meta = await sharp(rawBuffer).metadata()
              if (meta.width && meta.height) {
                const outW = meta.width * upscaleFactor
                const outH = meta.height * upscaleFactor
                drctTicketCost = Math.max(1, Math.ceil((outW * outH) / 1_000_000 * 0.5))
                console.log(`[drct] output ${outW}x${outH} = ${((outW * outH) / 1_000_000).toFixed(2)} MP → ${drctTicketCost} ticket(s)`)
              }
              const srcBlob = new Blob([new Uint8Array(rawBuffer)], { type: contentType })
              falSourceUrl = await fal.storage.upload(srcBlob)
              console.log(`[drct] re-uploaded source to FAL storage: ${falSourceUrl}`)
            }
          } catch (uploadErr) {
            console.warn('[drct] failed to fetch/re-upload source, using original URL:', uploadErr)
          }

          // Check actual ticket cost against balance — atomic to prevent TOCTOU races
          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, drctTicketCost)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${drctTicketCost} ticket(s) for this output size, but you have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          const { request_id } = await fal.queue.submit('fal-ai/drct-super-resolution', {
            input: {
              image_url: falSourceUrl,
              upscale_factor: upscaleFactor,
            },
            webhookUrl,
          })

          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: model,
              modelType: 'image',
              prompt: `${upscaleFactor}x DRCT`,
              parameters: {
                source: 'main-scanner',
                quality: `${upscaleFactor}x`,
                aspectRatio: 'auto',
                model,
                adminMode: skipTickets,
                upscaleImageUrl,
                upscaleFactor,
                drctTicketCost,
              },
              status: 'processing',
              ticketCost: skipTickets ? 0 : drctTicketCost,
              falRequestId: request_id,
              startedAt: new Date(),
            }
          })

          await Promise.all([
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: model }, data: { currentActive: { increment: 1 } } }),
            prisma.modelConcurrencyLimit.updateMany({ where: { modelId: FAL_GLOBAL_ID }, data: { currentActive: { increment: 1 } } }),
          ])

          console.log(`[drct] ${upscaleFactor}x submitted (${drctTicketCost} tickets), request_id=${request_id}`)
          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: `${upscaleFactor}x DRCT queued — ${drctTicketCost} ticket(s) reserved.`,
            modelUsed: 'DRCT Super-Resolution',
            ticketsUsed: skipTickets ? 0 : drctTicketCost,
          })
        }

        // ── SUPIR (Replicate) ──────────────────────────────────────────────────
        if (model === 'supir') {
          if (!upscaleImageUrl) {
            return NextResponse.json({ error: 'upscaleImageUrl is required for supir' }, { status: 400 })
          }

          const supirCost = 8
          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, supirCost)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${supirCost}, have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          // Submit to Replicate
          const predRes = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              version: '9daf6d19556db0fd6e347a7a5cae7d4a68cf25486266ca3e6dc82618f0a2e0b9',
              input: {
                image: upscaleImageUrl,
                upscale: upscaleFactor,
                SUPIR_sign: supirModelName.slice(-1),  // "SUPIR-v0F" → "F", "SUPIR-v0Q" → "Q"
                use_llava: supirUseLlava,
                a_prompt: 'masterpiece, best quality, highres, sharp details',
                n_prompt: supirNegPrompt,
                edm_steps: supirSteps,
                s_cfg: supirCfg,
                linear_cfg: false,
                color_fix_type: supirColorFix,
              },
            }),
          })
          if (!predRes.ok) {
            const errText = await predRes.text()
            if (!skipTickets) await prisma.ticket.update({ where: { userId: user.id }, data: { reserved: { decrement: supirCost } } })
            if (predRes.status === 429) {
              return NextResponse.json({ error: 'SUPIR is rate limited — only 1 prediction at a time on your Replicate plan. Add credit to your Replicate account to increase the limit.' }, { status: 429 })
            }
            return NextResponse.json({ error: `SUPIR error: ${errText.slice(0, 120)}` }, { status: 500 })
          }
          const prediction = await predRes.json()

          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: 'supir',
              modelType: 'image',
              prompt: `${upscaleFactor}x SUPIR`,
              parameters: { source: 'main-scanner', quality: `${upscaleFactor}x`, aspectRatio: 'auto', model: 'supir', adminMode: skipTickets, upscaleImageUrl, upscaleFactor },
              status: 'processing',
              ticketCost: skipTickets ? 0 : supirCost,
              falRequestId: prediction.id,
              startedAt: new Date(),
            },
          })

          // Background: poll Replicate → save result → settle tickets → mark done
          after(async () => {
            try {
              const pollUrl = `https://api.replicate.com/v1/predictions/${prediction.id}`
              const headers = { 'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}` }
              const maxAttempts = 72  // 72 × 5s = 6 minutes max
              let attempt = 0
              while (attempt < maxAttempts) {
                attempt++
                await new Promise(r => setTimeout(r, 5000))
                const poll = await fetch(pollUrl, { headers })
                if (!poll.ok) continue
                const pred = await poll.json()
                if (pred.status === 'succeeded' && pred.output) {
                  const outputUrl: string = Array.isArray(pred.output) ? pred.output[0] : pred.output
                  let hostedUrl = outputUrl
                  try {
                    const imgRes = await fetch(outputUrl)
                    if (imgRes.ok) {
                      const buf = Buffer.from(await imgRes.arrayBuffer())
                      hostedUrl = await uploadToR2(`supir-${Date.now()}.png`, buf, 'image/png')
                    }
                  } catch {}
                  await prisma.generatedImage.create({
                    data: {
                      userId: user.id,
                      prompt: `${upscaleFactor}x SUPIR`,
                      imageUrl: hostedUrl,
                      model: 'supir',
                      ticketCost: skipTickets ? 0 : supirCost,
                      quality: `${upscaleFactor}x`,
                      aspectRatio: 'auto',
                      expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
                      falRequestId: prediction.id,
                    },
                  })
                  await prisma.generationQueue.update({ where: { id: queueEntry.id }, data: { status: 'completed' } })
                  if (!skipTickets) {
                    await prisma.ticket.update({ where: { userId: user.id }, data: { balance: { decrement: supirCost }, reserved: { decrement: supirCost } } })
                  }
                  break
                } else if (pred.status === 'failed' || pred.status === 'canceled') {
                  const rawErr: string = pred.error || 'Replicate prediction failed'
                  const friendlyErr = rawErr.includes('CUDA out of memory') || rawErr.includes('out of memory')
                    ? 'GPU out of memory — try a smaller image or lower upscale factor'
                    : rawErr.slice(0, 120)
                  await prisma.generationQueue.update({ where: { id: queueEntry.id }, data: { status: 'failed', errorMessage: friendlyErr } })
                  if (!skipTickets) await prisma.ticket.update({ where: { userId: user.id }, data: { reserved: { decrement: supirCost } } })
                  break
                }
              }
              if (attempt >= maxAttempts) {
                await prisma.generationQueue.update({ where: { id: queueEntry.id }, data: { status: 'failed', errorMessage: 'SUPIR timed out' } })
                if (!skipTickets) await prisma.ticket.update({ where: { userId: user.id }, data: { reserved: { decrement: supirCost } } })
              }
            } catch (err) {
              console.error('[supir] background worker error:', err)
            }
          })

          console.log(`[supir] ${upscaleFactor}x prediction=${prediction.id} queued`)
          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: `${upscaleFactor}x SUPIR queued — ${supirCost} tickets reserved.`,
            modelUsed: 'SUPIR',
            ticketsUsed: skipTickets ? 0 : supirCost,
          })
        }

        // ── 2026-08 fal image batch ─────────────────────────────────────────
        // Input shapes live in lib/fal-image-models.ts, verified field-by-field
        // against each endpoint's live OpenAPI Input schema. Nothing below this
        // block touches these models — they skip the legacy quality/reference
        // chain entirely.
        const newFalSpec = getFalImageModelSpec(model)
        let newFalInput: Record<string, any> | null = null
        const newFalPermanentRefs: string[] = []

        if (newFalSpec) {
          modelEndpoint = newFalSpec.endpoint

          // Input images: an explicit upscale-style source URL wins (matches the
          // other upscalers), then the portal's reference images, in order.
          const rawSources: string[] = []
          if (typeof upscaleImageUrl === 'string' && upscaleImageUrl) rawSources.push(upscaleImageUrl)
          if (Array.isArray(referenceImages)) rawSources.push(...referenceImages.filter((r: unknown) => typeof r === 'string' && r))

          const falImageUrls: string[] = []
          // Pure text-to-image endpoints (maxInputImages 0) skip uploads entirely.
          for (const ref of rawSources.slice(0, newFalSpec.maxInputImages)) {
            try {
              const imageBuffer = await refToBuffer(ref)
              const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' })
              falImageUrls.push(await fal.storage.upload(blob))
              // Keep a permanent copy for the DB record (reuse https refs as-is).
              if (/^https?:\/\//i.test(ref)) {
                newFalPermanentRefs.push(ref)
              } else {
                const refFilename = `reference-${user.id}-${Date.now()}-${falImageUrls.length}.jpg`
                newFalPermanentRefs.push(await uploadToR2(refFilename, imageBuffer, 'image/jpeg'))
              }
            } catch (uploadError) {
              console.error(`[${model}] failed to upload input image:`, uploadError)
            }
          }

          try {
            const built = buildFalImageInput(newFalSpec, {
              prompt: typeof prompt === 'string' ? prompt.trim() : '',
              aspectRatio,
              quality,
              imageUrls: falImageUrls,
              options: body,
            })
            modelEndpoint = built.endpoint
            newFalInput = built.input
          } catch (buildErr: any) {
            return NextResponse.json(
              { error: buildErr?.message || `Invalid input for ${model}` },
              { status: 400 }
            )
          }

          console.log(`[${model}] endpoint=${modelEndpoint} input=${JSON.stringify(newFalInput).slice(0, 500)}`)
        }

        // Prompt used for DB/queue bookkeeping — promptless models (Topaz,
        // Pixelcut, Virtual Try-On) still need a non-empty label.
        const jobPrompt =
          (typeof prompt === 'string' ? prompt.trim() : '') || selectedModel.displayName

        const inputParams: any = newFalInput
          ? { ...newFalInput }
          : { prompt: prompt.trim() }

        // Only add enable_safety_checker for models that support it (SeeDream)
        if (model === 'seedream-4.5') {
          inputParams.enable_safety_checker = seedreamSafetyChecker === true
        }

        // Check if regular NanoBanana is trying to use reference images (not supported)
        if (model === 'nano-banana' && referenceImages && referenceImages.length > 0) {
          return NextResponse.json({
            error: 'NanoBanana does not support reference images. Please use NanoBanana Pro or SeeDream 4.5 for reference image features.'
          }, { status: 400 })
        }

        // Configure quality/resolution based on model
        if (newFalSpec) {
          // input already fully built by lib/fal-image-models.ts
        } else if (model === 'seedream-4.5') {
          const qualityMultiplier = quality === '4k' ? 2 : 1
          const baseSizes: Record<string, { width: number, height: number }> = {
            '1:1': { width: 1024, height: 1024 },
            '4:5': { width: 896, height: 1152 },
            '3:4': { width: 896, height: 1152 },
            '2:3': { width: 896, height: 1344 },
            '9:16': { width: 768, height: 1344 },
            '16:9': { width: 1344, height: 768 },
            '3:2': { width: 1344, height: 896 },
            '4:3': { width: 1152, height: 896 },
            '21:9': { width: 1536, height: 640 },
          }
          const dimensions = baseSizes[aspectRatio] || baseSizes['1:1']
          inputParams.image_size = {
            width: dimensions.width * qualityMultiplier,
            height: dimensions.height * qualityMultiplier
          }
          inputParams.max_images = 1
          inputParams.num_images = 1
          console.log(`SeeDream 4.5: ${inputParams.image_size.width}x${inputParams.image_size.height}`)

        } else if (model === 'flux-2') {
          const fluxSizeMap: Record<string, string> = {
            '1:1': 'square_hd',
            '4:3': 'landscape_4_3',
            '3:4': 'portrait_4_3',
            '16:9': 'landscape_16_9',
            '9:16': 'portrait_16_9',
          }
          if (quality === '4k') {
            const baseSizes: Record<string, { width: number, height: number }> = {
              '1:1': { width: 1536, height: 1536 },
              '4:5': { width: 1344, height: 1680 },
              '3:4': { width: 1344, height: 1792 },
              '9:16': { width: 1080, height: 1920 },
              '16:9': { width: 1920, height: 1080 },
              '4:3': { width: 1792, height: 1344 },
              '3:2': { width: 1920, height: 1280 },
            }
            const dimensions = baseSizes[aspectRatio] || baseSizes['1:1']
            inputParams.image_size = { width: dimensions.width, height: dimensions.height }
          } else {
            inputParams.image_size = fluxSizeMap[aspectRatio] || 'square_hd'
          }
          inputParams.num_images = 1
          inputParams.output_format = 'png'
          inputParams.enable_safety_checker = false
          inputParams.guidance_scale = loraUrl && loraGuidanceScale ? loraGuidanceScale : 2.5
          inputParams.num_inference_steps = loraUrl && loraSteps ? loraSteps : 28
          if (loraUrl) {
            modelEndpoint = 'fal-ai/flux-2/lora'
            inputParams.loras = [{ path: loraUrl, scale: loraScale ?? 1.0 }]
          }
          console.log(`FLUX 2: ${JSON.stringify(inputParams.image_size)}`)

        } else if (model === 'flux-1-dev') {
          const f1Sizes: Record<string, Record<string, { width: number; height: number }>> = {
            '1k': { '1:1': {width:1024,height:1024}, '16:9': {width:1280,height:720}, '9:16': {width:720,height:1280}, '4:3': {width:1024,height:768}, '3:4': {width:768,height:1024} },
            '2k': { '1:1': {width:1920,height:1920}, '16:9': {width:1920,height:1080}, '9:16': {width:1080,height:1920}, '4:3': {width:1920,height:1440}, '3:4': {width:1440,height:1920} },
            '4k': { '1:1': {width:2560,height:2560}, '16:9': {width:2560,height:1440}, '9:16': {width:1440,height:2560}, '4:3': {width:2560,height:1920}, '3:4': {width:1920,height:2560} },
          }
          const tier = quality === '4k' ? '4k' : quality === '2k' ? '2k' : '1k'
          const dims = (f1Sizes[tier] || f1Sizes['1k'])[aspectRatio] || f1Sizes[tier]['1:1']
          inputParams.image_size = { width: dims.width, height: dims.height }
          inputParams.num_inference_steps = loraUrl ? (loraSteps ?? 28) : 40
          inputParams.guidance_scale = loraUrl ? (loraGuidanceScale ?? 3.5) : 3.5
          inputParams.num_images = 1
          inputParams.enable_safety_checker = fluxDevSafetyChecker === true
          inputParams.output_format = 'png'
          inputParams.acceleration = loraUrl ? 'none' : 'regular'
          if (loraUrl) {
            modelEndpoint = 'fal-ai/flux-lora'
            inputParams.loras = [{ path: loraUrl, scale: loraScale ?? 1.0 }]
          }
          console.log(`FLUX 1 Dev${loraUrl ? ' LoRA' : ''}: ${dims.width}x${dims.height}`)

        } else if (model === 'z-image-base' || model === 'z-image-turbo') {
          const zSizes: Record<string, { w: number; h: number }> = {
            '1:1':  { w: 1024, h: 1024 },
            '16:9': { w: 1280, h: 720  },
            '9:16': { w: 720,  h: 1280 },
            '4:3':  { w: 1024, h: 768  },
            '3:4':  { w: 768,  h: 1024 },
            '4:5':  { w: 896,  h: 1120 },
          }
          const mult = quality === '4k' ? 4 : quality === '2k' ? 2 : 1
          const dims = zSizes[aspectRatio] || zSizes['1:1']
          inputParams.image_size = { width: dims.w * mult, height: dims.h * mult }
          inputParams.enable_safety_checker = false
          inputParams.acceleration = 'regular'
          inputParams.output_format = 'png'
          inputParams.num_images = 1
          if (loraUrl) {
            modelEndpoint = model === 'z-image-turbo' ? 'fal-ai/z-image/turbo/lora' : 'fal-ai/z-image/base/lora'
            inputParams.loras = [{ path: loraUrl, scale: loraScale ?? 1.0 }]
            if (loraGuidanceScale) inputParams.guidance_scale = loraGuidanceScale
            if (loraSteps) inputParams.num_inference_steps = loraSteps
          }

        } else if (model === 'nano-banana-pro') {
          // NanoBanana Pro
          inputParams.resolution = quality === '4k' ? '4K' : '2K'
          inputParams.aspect_ratio = aspectRatio
          inputParams.output_format = 'png'
          inputParams.num_images = 1
          inputParams.safety_tolerance = 6
          inputParams.enable_safety_checker = false
          console.log(`NanoBanana Pro: resolution=${inputParams.resolution} aspect=${aspectRatio}`)
        } else {
          // NanoBanana (cluster) — generates 2 images per job
          inputParams.resolution = quality === '4k' ? '4K' : '2K'
          inputParams.aspect_ratio = aspectRatio
          inputParams.output_format = 'png'
          inputParams.num_images = 2
          console.log(`NanoBanana Cluster: resolution=${inputParams.resolution} aspect=${aspectRatio}`)
        }

        // Handle reference images (upload to FAL storage first)
        const permanentReferenceUrls: string[] = newFalSpec ? [...newFalPermanentRefs] : []
        if (!newFalSpec && referenceImages && referenceImages.length > 0) {
          console.log(`Processing ${referenceImages.length} reference images for ${selectedModel.displayName} edit mode`)

          if (model === 'seedream-4.5') {
            modelEndpoint = 'fal-ai/bytedance/seedream/v4.5/edit'
          } else if (model === 'nano-banana-pro') {
            modelEndpoint = 'fal-ai/nano-banana-pro/edit'
          } else if (model === 'flux-2') {
            modelEndpoint = loraUrl ? 'fal-ai/flux-2/lora/edit' : 'fal-ai/flux-2/edit'
          } else if (model === 'z-image-turbo') {
            modelEndpoint = loraUrl
              ? 'fal-ai/z-image/turbo/image-to-image/lora'
              : 'fal-ai/z-image/turbo/image-to-image'
          } else if (model === 'flux-1-dev') {
            modelEndpoint = loraUrl ? 'fal-ai/flux-lora/image-to-image' : 'fal-ai/flux-1/dev/image-to-image'
          }

          const isSingularI2I = model === 'z-image-turbo' || model === 'flux-1-dev'
          const maxImages = model === 'flux-2' ? 4 : isSingularI2I ? 1 : referenceImages.length
          const imagesToUpload = referenceImages.slice(0, maxImages)

          const imageUrls: string[] = []
          for (const ref of imagesToUpload) {
            try {
              // Refs arrive either as an https URL (library images — the client
              // no longer base64-encodes those) or as a base64 data URL.
              const imageBuffer = await refToBuffer(ref)
              const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' })
              const uploadedUrl = await fal.storage.upload(blob)
              imageUrls.push(uploadedUrl)

              // Also save to permanent R2 storage for the DB record. If the ref
              // was already a permanent https URL, reuse it rather than re-hosting.
              if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) {
                permanentReferenceUrls.push(ref)
              } else {
                const refFilename = `reference-${user.id}-${Date.now()}-${imageUrls.length}.jpg`
                const refUrl = await uploadToR2(refFilename, imageBuffer, 'image/jpeg')
                permanentReferenceUrls.push(refUrl)
              }
            } catch (uploadError) {
              console.error('Failed to upload reference image:', uploadError)
            }
          }

          if (imageUrls.length > 0) {
            if (isSingularI2I) {
              inputParams.image_url = imageUrls[0]
              inputParams.strength = model === 'flux-1-dev' ? (loraUrl ? 0.85 : 0.95) : 0.6
              console.log(`${model} i2i: image_url set, strength=${inputParams.strength}`)
            } else {
              inputParams.image_urls = imageUrls
              console.log(`Edit mode: ${imageUrls.length} reference images uploaded`)
            }
          }
        }

        if (syncMode) {
          // ─── SYNCHRONOUS PATH (composition canvas) ────────────────────
          // Wait for FAL.ai to finish and return imageUrl immediately.
          console.log(`Calling FAL.ai synchronously: ${modelEndpoint}`)
          const result = await fal.subscribe(modelEndpoint, { input: inputParams, logs: false })
          const falImageUrl = result.data.images?.[0]?.url
          if (!falImageUrl) throw new Error('FAL.ai did not return an image')

          // Download from FAL temporary storage and re-host on R2
          const falRes = await fetch(falImageUrl)
          const imageBuffer = Buffer.from(await falRes.arrayBuffer())
          const filename = `universe-scan-${user.id}-${Date.now()}.png`
          const syncUrl = await uploadToR2(filename, imageBuffer, 'image/png')
          console.log(`Sync image uploaded to R2: ${syncUrl}`)

          // Save to database
          const expiresAt = new Date()
          expiresAt.setFullYear(expiresAt.getFullYear() + 100)
          await prisma.generatedImage.create({
            data: {
              userId: user.id,
              prompt: jobPrompt,
              imageUrl: syncUrl,
              model,
              ticketCost: skipTickets ? 0 : ticketCost,
              referenceImageUrls: permanentReferenceUrls,
              quality,
              aspectRatio,
              expiresAt,
            },
          })

          // Deduct tickets atomically — prevents negative balances from concurrent sync requests
          let newBalance = ticketRecord?.balance || 0
          if (!skipTickets) {
            const affected = await prisma.$executeRaw`
              UPDATE "Ticket"
              SET balance = balance - ${ticketCost}, "totalUsed" = "totalUsed" + ${ticketCost}
              WHERE "userId" = ${user.id}
                AND (balance - COALESCE(reserved, 0)) >= ${ticketCost}
            `
            if (affected === 0) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${ticketCost} ticket(s) to complete this generation.` },
                { status: 402 }
              )
            }
            const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
            newBalance = Math.max(0, (updatedTicket?.balance ?? 0) - (updatedTicket?.reserved ?? 0))
          }

          console.log('=== FAL.AI SYNC GENERATION COMPLETE ===')
          return NextResponse.json({ imageUrl: syncUrl, newBalance, modelUsed: selectedModel.displayName })

        } else {
          // ─── ASYNC SUBMIT TO FAL.AI (main portal queue flow) ─────────
          const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`
          const webhookUrl = `${appUrl}/api/webhooks/fal`

          // Reserve tickets upfront — same for both queued and immediate paths.
          // The actual balance deduction only happens in the FAL webhook on success.
          if (!skipTickets) {
            const reserveResult = await reserveGenerationTickets(user.id, user.email!, ticketCost)
            if (!reserveResult.ok) {
              return NextResponse.json(
                { error: `Insufficient tickets. Need ${reserveResult.need} ticket(s), but you have ${reserveResult.have}.` },
                { status: 402 }
              )
            }
            reservationMade = true
          }
          const updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
          const newBalance = skipTickets
            ? (ticketRecord?.balance || 0)
            : Math.max(0, (updatedTicket?.balance || 0) - (updatedTicket?.reserved || 0))

          // ── Check global FAL concurrency limit ───────────────────────
          const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
          const globalLimit = await prisma.modelConcurrencyLimit.findUnique({
            where: { modelId: FAL_GLOBAL_ID },
          })
          const isAtGlobalLimit =
            globalLimit != null && globalLimit.currentActive >= globalLimit.maxConcurrent

          if (isAtGlobalLimit) {
            // ── QUEUED PATH: hold job in our DB, submit to FAL when a slot opens ──
            console.log(`[generate] queued — model=${model} endpoint=${modelEndpoint} loraUrl=${loraUrl ?? 'none'} loras=${JSON.stringify(inputParams.loras ?? null)}`)
            const queueEntry = await prisma.generationQueue.create({
              data: {
                userId: user.id,
                modelId: model,
                modelType: 'image',
                prompt: jobPrompt,
                parameters: {
                  source: 'main-scanner',
                  quality,
                  aspectRatio,
                  model,
                  adminMode: skipTickets,
                  referenceImageUrls: permanentReferenceUrls,
                  loraUrl: loraUrl || null,
                  loraName: loraName || null,
                  // Stored so promoteNextQueuedJob can replay this job later
                  falEndpoint: modelEndpoint,
                  falInput: inputParams,
                },
                status: 'queued',
                ticketCost: skipTickets ? 0 : ticketCost,
                // falRequestId and startedAt are null until the job is promoted
              },
            })

            console.log(
              `[global-limit] At capacity (${globalLimit.currentActive}/${globalLimit.maxConcurrent}) — job #${queueEntry.id} queued`
            )

            return NextResponse.json({
              success: true,
              queued: true,
              queueId: queueEntry.id,
              newBalance,
              message: skipTickets
                ? `Admin scan queued — waiting for a free generation slot.`
                : `Universe scan queued! ${ticketCost} ticket(s) reserved — generation begins when a slot opens.`,
              modelUsed: selectedModel.displayName,
              ticketsUsed: skipTickets ? 0 : ticketCost,
            })
          }

          // ── IMMEDIATE PATH: submit to FAL now ───────────────────────
          console.log(`[generate] model=${model} endpoint=${modelEndpoint}`)
          console.log(`[generate] loraUrl=${loraUrl ?? 'none'} loras=${JSON.stringify(inputParams.loras ?? null)}`)
          console.log(`Submitting to FAL.ai queue: ${modelEndpoint}`)
          console.log(`Webhook URL: ${webhookUrl}`)

          const { request_id } = await fal.queue.submit(modelEndpoint, {
            input: inputParams,
            webhookUrl,
          })

          console.log(`FAL.ai accepted job, request_id: ${request_id}`)

          // Create queue entry
          const queueEntry = await prisma.generationQueue.create({
            data: {
              userId: user.id,
              modelId: model,
              modelType: 'image',
              prompt: jobPrompt,
              parameters: {
                source: 'main-scanner',
                quality,
                aspectRatio,
                model,
                adminMode: skipTickets,
                referenceImageUrls: permanentReferenceUrls,
                loraUrl: loraUrl || null,
                loraName: loraName || null,
              },
              status: 'processing',
              ticketCost: skipTickets ? 0 : ticketCost,
              falRequestId: request_id,
              startedAt: new Date(),
            }
          })

          // Increment active counts — per-model AND global
          await Promise.all([
            prisma.modelConcurrencyLimit.updateMany({
              where: { modelId: model },
              data: { currentActive: { increment: 1 } },
            }),
            prisma.modelConcurrencyLimit.updateMany({
              where: { modelId: FAL_GLOBAL_ID },
              data: { currentActive: { increment: 1 } },
            }),
          ])

          console.log(`Queue entry created: #${queueEntry.id}`)
          console.log('=== FAL.AI JOB SUBMITTED — AWAITING WEBHOOK ===')

          return NextResponse.json({
            success: true,
            queued: true,
            queueId: queueEntry.id,
            newBalance,
            message: skipTickets
              ? `Admin scan queued! (FREE) — image will appear shortly.`
              : `Universe scan queued! ${ticketCost} ticket(s) reserved.`,
            modelUsed: selectedModel.displayName,
            ticketsUsed: skipTickets ? 0 : ticketCost,
          })
        }

      } catch (error: any) {
        console.error('FAL.ai queue submit error:', error)
        // If the reservation was made before the error, release it so tickets
        // aren't stuck in "reserved" state from a job that will never complete.
        if (reservationMade) {
          await prisma.ticket.update({
            where: { userId: user.id },
            data: { reserved: { decrement: ticketCost } }
          }).catch(e => console.error('Failed to release reservation on error:', e))
        }
        return NextResponse.json(
          { error: `FAL.ai submission failed: ${error.message}` },
          { status: 500 }
        )
      }

    } else {
      // ============================================
      // GEMINI PROVIDER (Existing code)
      // ============================================
      
      // Check if Gemini API is configured
      if (!GEMINI_API_KEY) {
        console.error('Gemini API key not configured')
        return NextResponse.json(
          { error: 'Multiverse Scanner not configured. Contact administrator.' },
          { status: 500 }
        )
      }

      // Use the model's actual name (not ID) for API calls
      const modelName = selectedModel.name
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`

      // Build content parts array
      const contentParts: any[] = []

      // Add reference images first if provided
      if (referenceImages && referenceImages.length > 0) {
        console.log(`Adding ${referenceImages.length} reference images`)
        for (const ref of referenceImages) {
          const base64Data = await refToBase64(ref)
          contentParts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Data
            }
          })
        }
      }

      // Add text prompt with enhanced quality instructions
      const qualityInstructions = quality === '4k' 
        ? 'Generate in ultra-high resolution 4K quality with maximum detail and clarity. ' 
        : ''
      
      const aspectInstructions = `Aspect ratio must be ${aspectRatio}. `
      const fullPrompt = qualityInstructions + aspectInstructions + prompt.trim()
      
      contentParts.push({
        text: fullPrompt
      })

      const imageSize = quality.toUpperCase()
      
      const requestBody: any = {
        contents: [{
          parts: contentParts
        }],
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
        }
      }

      console.log('Calling Gemini API with', contentParts.length, 'parts...')
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Gemini API call failed:', response.status, errorText)
        
        // Check for rate limit error (429)
        if (response.status === 429) {
          const otherModel = model === 'gemini-3-pro-image-preview' 
            ? 'Flash Scanner v2.5 (2000/day available!) or SeeDream 4.5' 
            : 'Pro Scanner v3 or SeeDream 4.5'
          
          return NextResponse.json({ 
            error: `Daily quota exceeded for ${selectedModel.displayName}. This model has reached its ${selectedModel.rateLimit.rpd} requests/day limit. Try switching to ${otherModel} or wait until tomorrow when quotas reset.` 
          }, { status: 429 })
        }
        
        return NextResponse.json(
          { 
            error: `Generation failed: ${response.status}`,
            details: errorText.substring(0, 300)
          },
          { status: 500 }
        )
      }

      const result = await response.json()
      const generateTime = Date.now() - generateStart
      console.log(`Image generated in ${generateTime}ms`)

      // Check for prompt-level blocks FIRST (blocked before generation even starts)
      if (result.promptFeedback && result.promptFeedback.blockReason) {
        const blockReason = result.promptFeedback.blockReason
        console.error('Prompt blocked:', {
          blockReason,
          promptFeedback: result.promptFeedback,
          prompt: prompt.substring(0, 100)
        })
        
        return NextResponse.json({
          error: 'Sensitive content detected. Ticket not charged. Try another prompt or use SeeDream 4.5 / NanoBanana Pro for less restrictive generation.',
          blocked: true
        }, { status: 400 })
      }

      // Extract image from response
      if (!result.candidates || result.candidates.length === 0) {
        console.error('No candidates in response:', result)
        return NextResponse.json(
          { error: 'No image generated' },
          { status: 500 }
        )
      }

      const candidate = result.candidates[0]
      
      // Check for content filtering BEFORE checking content parts
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        const finishReason = candidate.finishReason
        const finishMessage = candidate.finishMessage || ''
        
        console.error('Generation blocked:', {
          finishReason,
          finishMessage,
          prompt: prompt.substring(0, 100)
        })
        
        // Specific handling for different block reasons
        if (finishReason === 'SAFETY' || finishReason === 'IMAGE_SAFETY' || finishReason === 'IMAGE_OTHER') {
          return NextResponse.json({
            error: 'Sensitive content detected. Ticket not charged. Try another prompt or use SeeDream 4.5 / NanoBanana Pro for less restrictive generation.',
            blocked: true
          }, { status: 400 })
        }
        
        // Other finish reasons
        return NextResponse.json({
          error: `Generation blocked: ${finishReason}. Ticket not charged. Try rephrasing your prompt.`,
          blocked: true
        }, { status: 400 })
      }
      
      if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
        console.error('No content parts in candidate:', candidate)
        return NextResponse.json(
          { error: 'Invalid response structure' },
          { status: 500 }
        )
      }

      // Loop through ALL parts to find the image
      let imageBytes
      let refusalText = ''
      for (const part of candidate.content.parts) {
        if (part.inlineData && part.inlineData.data) {
          imageBytes = part.inlineData.data
          console.log('Found image in inlineData, size:', imageBytes.length)
          break
        } else if (part.text) {
          refusalText = part.text
          console.log('Model included text:', part.text.substring(0, 100))
        }
      }
      
      if (!imageBytes) {
        console.error('No image data found in any part')
        
        // Check if the text is a refusal due to sensitive content
        const sensitiveKeywords = ['explicit', 'nudity', 'nude', 'sexually', "can't create", "cannot create", "inappropriate", "unsafe"]
        const isSensitiveRefusal = sensitiveKeywords.some(keyword => 
          refusalText.toLowerCase().includes(keyword)
        )
        
        if (isSensitiveRefusal) {
          return NextResponse.json(
            { 
              error: 'Sensitive content detected. Ticket not charged. Try another prompt or use SeeDream 4.5 / NanoBanana Pro for less restrictive generation.',
              blocked: true
            },
            { status: 400 }
          )
        }
        
        // Generic error for other text responses
        return NextResponse.json(
          { error: 'Model returned text instead of image. Try a different prompt or remove reference images.' },
          { status: 500 }
        )
      }

      // Convert base64 to buffer
      buffer = Buffer.from(imageBytes, 'base64')
      console.log('Buffer size:', buffer.length, 'bytes')
    }

    // Upload to Vercel Blob
    console.log('Uploading to storage...')

    // First, upload reference images to permanent storage (if any)
    const permanentReferenceUrls: string[] = []
    if (referenceImages && referenceImages.length > 0) {
      console.log(`Uploading ${referenceImages.length} reference image(s) to permanent storage...`)
      for (let i = 0; i < referenceImages.length; i++) {
        try {
          // Already a permanent https URL (library ref) — reuse as-is, no re-host
          if (/^https?:\/\//i.test(referenceImages[i])) {
            permanentReferenceUrls.push(referenceImages[i])
            continue
          }
          const refBuffer = await refToBuffer(referenceImages[i])
          const refFilename = `reference-${user.id}-${Date.now()}-${i}.jpg`

          const refUrl = await uploadToR2(refFilename, refBuffer, 'image/jpeg')

          permanentReferenceUrls.push(refUrl)
          console.log(`Reference image ${i + 1} uploaded: ${refUrl}`)
        } catch (refErr) {
          console.error(`Failed to upload reference image ${i + 1}:`, refErr)
        }
      }
    }

    // For NanoBanana (multiple images), upload all
    // For other models (single image), upload one
    const uploadedImages: { url: string, id: string }[] = []

    // Determine if this is a multi-image generation
    const isMultiImage = model === 'nano-banana' && imageBuffers && imageBuffers.length > 1
    const buffersToUpload = isMultiImage ? imageBuffers : [buffer]

    console.log(`Uploading ${buffersToUpload.length} generated image(s)...`)
    
    for (let i = 0; i < buffersToUpload.length; i++) {
      const filename = `universe-scan-${user.id}-${Date.now()}-${i}.png`

      const blobUrl = await uploadToR2(filename, buffersToUpload[i], 'image/png')

      console.log(`Image ${i + 1} uploaded: ${blobUrl}`)

      // Save each image to database
      const expiresAt = new Date()
      expiresAt.setFullYear(expiresAt.getFullYear() + 100)

      const savedImage = await prisma.generatedImage.create({
        data: {
          userId: user.id,
          prompt: prompt.trim(),
          imageUrl: blobUrl,
          model,
          ticketCost: skipTickets ? 0 : (isMultiImage ? 0 : ticketCost), // 0 for admin mode, only charge for first image in multi-gen
          referenceImageUrls: permanentReferenceUrls, // Save reference images used
          quality,
          aspectRatio,
          expiresAt,
        },
      })

      uploadedImages.push({ url: blobUrl, id: String(savedImage.id) })
      console.log(`Image ${i + 1} saved to database: ${savedImage.id}`)
    }

    // Consume tickets (only once, even for multi-image) - skip for admin mode.
    // Atomic WHERE balance >= cost prevents going negative even if a concurrent
    // request slipped through the earlier balance check.
    let updatedTicket = ticketRecord
    if (!skipTickets) {
      console.log(`Consuming ${ticketCost} ticket(s)...`)
      const affected = await prisma.$executeRaw`
        UPDATE "Ticket"
        SET balance = balance - ${ticketCost}, "totalUsed" = "totalUsed" + ${ticketCost}
        WHERE "userId" = ${user.id} AND balance >= ${ticketCost}
      `
      if (affected === 0) {
        // Balance was depleted between the earlier check and now (race condition).
        // Image already generated and saved — log but don't charge negative.
        console.error(`[generate] Atomic deduction failed for user ${user.id} — balance depleted mid-request. Image: ${uploadedImages[0]?.url}`)
      } else {
        console.log('Tickets consumed.')
      }
      updatedTicket = await prisma.ticket.findUnique({ where: { userId: user.id } })
    } else {
      console.log('🔓 ADMIN MODE: Skipping ticket deduction')
    }

    console.log('=== UNIVERSE SCAN COMPLETE ===')

    const generateTime = Date.now() - generateStart

    // Return appropriate response based on single or multi-image
    // Use effective balance (balance - reserved) to match what /api/user/tickets returns,
    // preventing a visual spike when reserved tickets from in-flight FAL jobs inflate the raw balance.
    const rawBalance = skipTickets ? (ticketRecord?.balance || 0) : (updatedTicket?.balance || 0)
    const rawReserved = skipTickets ? (ticketRecord?.reserved || 0) : (updatedTicket?.reserved || 0)
    const finalBalance = Math.max(0, rawBalance - rawReserved)
    const ticketsActuallyUsed = skipTickets ? 0 : ticketCost

    if (isMultiImage) {
      return NextResponse.json({
        success: true,
        images: uploadedImages, // Array of {url, id}
        imageUrl: uploadedImages[0].url, // Backwards compat
        imageId: uploadedImages[0].id, // Backwards compat
        newBalance: finalBalance,
        message: skipTickets ? `Admin scan complete! Generated ${uploadedImages.length} images (FREE).` : `Universe scan complete! Generated ${uploadedImages.length} images.`,
        generationTime: generateTime,
        modelUsed: selectedModel.displayName,
        ticketsUsed: ticketsActuallyUsed,
      })
    } else {
      return NextResponse.json({
        success: true,
        imageUrl: uploadedImages[0].url,
        imageId: uploadedImages[0].id,
        newBalance: finalBalance,
        message: skipTickets ? 'Admin scan complete! (FREE)' : 'Universe scan complete!',
        generationTime: generateTime,
        modelUsed: selectedModel.displayName,
        ticketsUsed: ticketsActuallyUsed,
      })
    }

  } catch (error: any) {
    console.error('=== UNIVERSE SCAN ERROR ===')
    console.error('Error:', error)
    console.error('Stack:', error.stack)

    return NextResponse.json(
      {
        error: 'Universe scan failed. Please try again.',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      },
      { status: 500 }
    )
  }
}
