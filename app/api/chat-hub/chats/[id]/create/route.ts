import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import {
  getCreateModel, resolveCreateSettings, computeCreateCost,
} from '@/lib/chat-hub-models'
import { buildFalCall, generateWithGeminiApi, persistChatGeneration } from '@/lib/chat-hub-create'
import { deductGenerationTickets, refundGenerationTickets } from '@/lib/ticket-gate'

export const maxDuration = 300

fal.config({ credentials: process.env.FAL_KEY })


// POST /api/chat-hub/chats/[id]/create — { prompt, createModelId, imageUrls?, settings? }
// Direct media generation in chat (no LLM involved): charges tickets like the
// scanners, persists the user prompt, runs the model synchronously, persists
// the result as an assistant message whose imageUrls carry the generated media.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireChatHubAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const chatId = parseInt((await params).id)
  if (isNaN(chatId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const createModelId = typeof body.createModelId === 'string' ? body.createModelId : ''
  if (!prompt) return NextResponse.json({ error: 'Prompt is empty' }, { status: 400 })
  const spec = getCreateModel(createModelId)
  if (!spec) return NextResponse.json({ error: 'Unknown create model' }, { status: 400 })
  if (spec.disabled) {
    return NextResponse.json({ error: `${spec.label} is not available in chat yet — ${spec.disabled}` }, { status: 400 })
  }
  if (!spec.geminiApi && !process.env.FAL_KEY) {
    return NextResponse.json({ error: 'FAL_KEY is not configured' }, { status: 500 })
  }

  const settings = resolveCreateSettings(spec, body.settings)
  const ticketCost = computeCreateCost(spec, settings)

  // Clamped to the model's own scanner reference limit (0 = no refs)
  const refs: string[] = Array.isArray(body.imageUrls)
    ? body.imageUrls
        .filter((u: unknown): u is string => typeof u === 'string' && /^https:\/\//.test(u))
        .slice(0, Math.min(10, spec.maxRefs))
    : []

  const call = spec.geminiApi ? null : buildFalCall(createModelId, prompt, refs, settings)
  if (call && 'error' in call) return NextResponse.json({ error: call.error }, { status: 400 })

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId: user.id },
    select: { id: true, title: true },
  })
  if (!chat) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Same ticket charging as the scanners (admin emails bypass inside the gate).
  // Charged before submission; refunded if the generation fails.
  const ticketResult = await deductGenerationTickets(user.id, user.email, ticketCost)
  if (!ticketResult.ok) {
    return NextResponse.json(
      { error: `Insufficient tickets — ${spec.label} costs ${ticketCost}, you have ${ticketResult.have}` },
      { status: 402 },
    )
  }

  await prisma.chatMessage.create({ data: { chatId, role: 'user', content: prompt, imageUrls: refs } })
  if (chat.title === 'New chat') {
    await prisma.chat.update({ where: { id: chatId }, data: { title: prompt.slice(0, 60) } })
  }

  try {
    let mediaUrl: string | undefined
    let endpointUsed: string
    if (spec.geminiApi) {
      const r = await generateWithGeminiApi(spec.geminiApi, prompt, refs, settings)
      if ('error' in r) {
        await refundGenerationTickets(user.id, user.email, ticketCost)
        return NextResponse.json({ error: r.error }, { status: 502 })
      }
      mediaUrl = r.url
      endpointUsed = spec.geminiApi
    } else {
      const result = await fal.subscribe(call!.endpoint, { input: call!.input as any, logs: false })
      const data = result.data as any
      mediaUrl = data?.images?.[0]?.url ?? data?.video?.url
      endpointUsed = call!.endpoint
    }
    if (!mediaUrl) {
      await refundGenerationTickets(user.id, user.email, ticketCost)
      return NextResponse.json({ error: 'The model returned no media' }, { status: 502 })
    }

    // Sync to the user's main session feed (re-hosts images on R2)
    mediaUrl = await persistChatGeneration({
      userId: user.id, prompt, mediaUrl,
      modelId: createModelId, kind: spec.kind, settings, ticketCost,
      referenceImageUrls: refs,
    })

    await prisma.chatMessage.create({
      data: {
        chatId,
        role: 'assistant',
        content: '',
        model: createModelId,
        imageUrls: [mediaUrl],
        metadata: { createModel: createModelId, kind: spec.kind, endpoint: endpointUsed, settings, ticketCost },
      },
    })
    await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
    return NextResponse.json({ url: mediaUrl })
  } catch (err: any) {
    console.error('chat-hub create error:', err)
    await refundGenerationTickets(user.id, user.email, ticketCost)
    return NextResponse.json(
      { error: `Generation failed: ${String(err?.message || err).slice(0, 200)}` },
      { status: 502 },
    )
  }
}
