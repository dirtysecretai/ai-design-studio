import { NextResponse, after } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkUserConcurrency } from '@/lib/user-concurrency'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { getTicketCost, getModelById } from '@/config/ai-models.config'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { enforceContentFilter } from '@/lib/content-filter'
import { jsonPrivate } from '@/lib/api-json'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_IMAGE_MODELS = ['gemini-3-pro-image', 'gemini-2.5-flash-image']

// POST /api/admin/gemini-submit
// Accepts a Gemini image generation job, reserves tickets, creates a queue entry,
// and returns queueId immediately so the client can poll — same UX as NB2/Kling.
// The actual Gemini API call runs in the background via after().
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return jsonPrivate({ error: 'Not authenticated' }, { status: 401 })

    const user = await getUserFromSession(token)
    if (!user) return jsonPrivate({ error: 'Invalid session' }, { status: 401 })

    if (await isGenerationBlocked(user.email)) {
      return jsonPrivate({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const { allowed, activeCount, limit } = await checkUserConcurrency(user.id)
    if (!allowed) {
      return jsonPrivate(
        { error: `Queue full (${activeCount}/${limit} active). Wait for a generation to finish.` },
        { status: 429 }
      )
    }

    const body = await req.json()
    const {
      prompt,
      model,
      quality = '2k',
      aspectRatio = '16:9',
      referenceImages = [],      // base64 strings (for inline Gemini request)
      referenceImageUrls = [],   // permanent Blob URLs (for DB record)
    } = body

    if (!prompt?.trim()) return jsonPrivate({ error: 'Prompt is required' }, { status: 400 })
    if (!GEMINI_IMAGE_MODELS.includes(model)) return jsonPrivate({ error: 'Invalid model' }, { status: 400 })

    const modelConfig = getModelById(model)
    if (!modelConfig?.isAvailable) {
      return jsonPrivate({ error: `Model ${model} is not available` }, { status: 400 })
    }

    const ticketCost = getTicketCost(model, quality)

    // Check available balance and reserve tickets
    const ticket = await prisma.ticket.findUnique({ where: { userId: user.id } })
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, user.email)
      if (!_cf.ok) return jsonPrivate({ error: _cf.reason }, { status: 400 })
    }
    const availableBalance = (ticket?.balance ?? 0) - (ticket?.reserved ?? 0)
    if (availableBalance < ticketCost) {
      return jsonPrivate(
        { error: `Insufficient tickets. Need ${ticketCost}, have ${availableBalance}.` },
        { status: 402 }
      )
    }

    const updatedTicket = await prisma.ticket.update({
      where: { userId: user.id },
      data: { reserved: { increment: ticketCost } },
      select: { balance: true, reserved: true },
    })
    const newBalance = Math.max(0, updatedTicket.balance - updatedTicket.reserved)

    // Create queue entry (polling picks this up immediately)
    const queueEntry = await prisma.generationQueue.create({
      data: {
        userId:    user.id,
        modelId:   model,
        modelType: 'image',
        prompt:    prompt.trim(),
        parameters: {
          source: 'main-scanner',
          adminMode: false,
          quality,
          aspectRatio,
          referenceImageUrls,
        },
        status:     'processing',
        ticketCost,
        startedAt:  new Date(),
      },
    })

    // Capture all values needed by the background task before after() runs
    const queueId     = queueEntry.id
    const userId      = user.id
    const modelName   = modelConfig.name  // actual Gemini API model name
    const promptStr   = prompt.trim()

    // Run Gemini generation after the response is sent so the client unlocks immediately
    after(async () => {
      // Use a fresh Prisma client — the main handler's client may be disconnected
      try {
        // ── Build Gemini request ────────────────────────────────────────
        const contentParts: any[] = []

        for (const imageBase64 of referenceImages as string[]) {
          const base64Data = imageBase64.split(',')[1] || imageBase64
          contentParts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Data } })
        }

        const qualityPrefix = quality === '4k'
          ? 'Generate in ultra-high resolution 4K quality with maximum detail and clarity. '
          : ''
        const fullPrompt = qualityPrefix + `Aspect ratio must be ${aspectRatio}. ` + promptStr
        contentParts.push({ text: fullPrompt })

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: contentParts }],
            generationConfig: { temperature: 1.0, topP: 0.95, topK: 40 },
          }),
        })

        if (!response.ok) {
          const errText = await response.text()
          throw new Error(`Gemini API error ${response.status}: ${errText.substring(0, 200)}`)
        }

        const result = await response.json()

        if (result.promptFeedback?.blockReason) {
          throw new Error(`Prompt blocked: ${result.promptFeedback.blockReason}`)
        }

        const candidate = result.candidates?.[0]
        if (!candidate) throw new Error('No candidates in Gemini response')
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
          throw new Error(`Generation blocked: ${candidate.finishReason}`)
        }

        // Extract image bytes
        let imageBytes: string | undefined
        for (const part of (candidate.content?.parts ?? [])) {
          if (part.inlineData?.data) { imageBytes = part.inlineData.data; break }
        }
        if (!imageBytes) throw new Error('No image data in Gemini response')

        // ── Upload to R2 ────────────────────────────────────────────────
        const buffer = Buffer.from(imageBytes, 'base64')
        const filename = `universe-scan-${userId}-${Date.now()}.png`
        const url = await uploadToR2(filename, buffer, 'image/png')

        // ── Save GeneratedImage ─────────────────────────────────────────
        const expiresAt = new Date()
        expiresAt.setFullYear(expiresAt.getFullYear() + 100)
        const savedImage = await prisma.generatedImage.create({
          data: {
            userId,
            prompt: promptStr,
            imageUrl: url,
            model,
            ticketCost,
            referenceImageUrls,
            quality,
            aspectRatio,
            expiresAt,
          },
        })

        // ── Deduct tickets ──────────────────────────────────────────────
        await prisma.ticket.update({
          where: { userId },
          data: {
            balance:   { decrement: ticketCost },
            reserved:  { decrement: ticketCost },
            totalUsed: { increment: ticketCost },
          },
        })

        // ── Mark queue completed ────────────────────────────────────────
        await prisma.generationQueue.update({
          where: { id: queueId },
          data: {
            status:       'completed',
            completedAt:  new Date(),
            resultUrl:    url,
            resultImageId: savedImage.id,
            parameters: {
              source: 'main-scanner',
              adminMode: false,
              quality,
              aspectRatio,
              referenceImageUrls,
              completedImageUrls: [url],
              completedImageIds:  [savedImage.id],
            },
          },
        })

        console.log(`Gemini queue #${queueId} completed — image #${savedImage.id}`)
      } catch (err: any) {
        console.error(`Gemini queue #${queueId} failed:`, err.message)
        await Promise.all([
          prisma.ticket.update({
            where: { userId },
            data: { reserved: { decrement: ticketCost } },
          }).catch(() => {}),
          prisma.generationQueue.update({
            where: { id: queueId },
            data: {
              status:      'failed',
              completedAt: new Date(),
              errorMessage: err.message || 'Generation failed',
            },
          }).catch(() => {}),
        ])
      }
    })

    return jsonPrivate({ success: true, queueId, newBalance })
  } catch (err: any) {
    console.error('Gemini submit error:', err)
    return jsonPrivate({ error: err.message || 'Submission failed' }, { status: 500 })
  }
}
