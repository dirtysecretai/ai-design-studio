import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { checkIsAdmin } from '@/lib/admin-check'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/recraft-submit — Recraft v4.1 (15 tickets/generation).
// CCBill compliance: regular users ALWAYS run with fal's content safety checker ON
// and cannot disable it; admins default OFF and may toggle it.
// Recraft v4.1 text-to-image. TEXT-TO-IMAGE ONLY: fal has no
// fal-ai/recraft/v4.1/image-to-image (404 as of 2026-07) and v4.1 dropped the
// style parameter — TODO: wire i2i/styles if fal publishes them (or fall back
// to recraft v3, which still has both).
// Async FAL queue submit → queueId; completion via /api/webhooks/fal.

const RECRAFT_SIZE: Record<string, string> = {
  '1:1':  'square_hd',
  '4:3':  'landscape_4_3',
  '3:4':  'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const user = await getUserFromSession(token)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

    const isAdmin = await checkIsAdmin(user.email)

    if (await isGenerationBlocked(user.email)) {
      return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const body = await req.json()
    const { prompt, aspectRatio = '1:1' } = body
    // CCBill compliance: non-admins ALWAYS get the safety checker on and can't turn it
    // off. Admins default off and may toggle via enable_safety_checker in the body.
    const enable_safety_checker = isAdmin ? (body.enable_safety_checker === true) : true

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    const ticketCost = 15

    const ticket = await prisma.ticket.findUnique({ where: { userId: user.id } })
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, user.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    const availableBalance = (ticket?.balance ?? 0) - (ticket?.reserved ?? 0)
    if (availableBalance < ticketCost) {
      return NextResponse.json({ error: 'Insufficient tickets' }, { status: 402 })
    }

    const updatedTicket = await prisma.ticket.update({
      where: { userId: user.id },
      data: { reserved: { increment: ticketCost } },
      select: { balance: true, reserved: true },
    })
    const newBalance = Math.max(0, updatedTicket.balance - updatedTicket.reserved)

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      image_size: RECRAFT_SIZE[aspectRatio] ?? 'square_hd',
      enable_safety_checker,
    }

    const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`
    const webhookUrl = `${appUrl}/api/webhooks/fal`

    console.log(`Recraft v4.1 async submit, webhook: ${webhookUrl}`)

    let request_id: string
    try {
      const result = await fal.queue.submit('fal-ai/recraft/v4.1/text-to-image', { input, webhookUrl })
      request_id = result.request_id
    } catch (falErr: any) {
      await prisma.ticket.update({
        where: { userId: user.id },
        data: { reserved: { decrement: ticketCost } },
      })
      throw falErr
    }

    console.log(`FAL accepted Recraft v4.1 job: ${request_id}`)

    const queueEntry = await prisma.generationQueue.create({
      data: {
        userId:      user.id,
        modelId:     'recraft-v4.1',
        modelType:   'image',
        prompt:      prompt.trim(),
        parameters:  {
          source: 'main-scanner',
          adminMode: false,
          aspectRatio,
          referenceImageUrls: [],
        },
        status:      'processing',
        ticketCost,
        falRequestId: request_id,
        startedAt:   new Date(),
      },
    })

    const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
    await prisma.modelConcurrencyLimit.updateMany({
      where: { modelId: FAL_GLOBAL_ID },
      data: { currentActive: { increment: 1 } },
    })

    console.log(`Recraft v4.1 queue entry #${queueEntry.id} created, reserved ${ticketCost} ticket(s)`)

    return NextResponse.json({ success: true, queueId: queueEntry.id, newBalance })
  } catch (error: any) {
    console.error('Recraft v4.1 submit error:', {
      message: error.message,
      status: error.status,
      body: JSON.stringify(error.body),
    })
    const detail = error.body?.detail
    let detailMsg: string | null = null
    if (Array.isArray(detail)) {
      detailMsg = detail.map((d: any) => `${d.loc?.join('.')} — ${d.msg}`).join('; ')
    } else if (typeof detail === 'string') {
      detailMsg = detail
    } else if (detail) {
      detailMsg = JSON.stringify(detail)
    }
    const rawBody = JSON.stringify(error.body)
    return NextResponse.json(
      { error: `${detailMsg || error.message || 'Submission failed'} | FAL body: ${rawBody}` },
      { status: 500 }
    )
  }
}
