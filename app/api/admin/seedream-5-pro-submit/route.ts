import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { checkIsAdmin } from '@/lib/admin-check'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/seedream-5-pro-submit — SeeDream 5.0 Pro (10 tickets/generation).
// CCBill compliance: regular users ALWAYS run with fal's content safety checker ON
// and cannot disable it; admins default OFF and may toggle it.
// SeeDream 5.0 Pro is its own model (newer than v5 Lite): the documented queue
// endpoints use the bare `bytedance/` owner prefix, like the other recent fal
// models (bytedance/seedance-2.0, google/gemini-omni-flash).
// Async FAL queue submit → queueId; completion via /api/webhooks/fal.
const ENDPOINT_BASE = 'bytedance/seedream/v5/pro'

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
    const {
      prompt,
      images_base64 = [],
      image_size = 'auto_2K',
      custom_width,
      custom_height,
      quality = '2k',
      aspectRatio = '1:1',
      referenceImageUrls = [],
    } = body
    // CCBill compliance: non-admins ALWAYS get the safety checker on and can't turn it
    // off. Admins default off and may toggle via enable_safety_checker in the body.
    const enable_safety_checker = isAdmin ? (body.enable_safety_checker === true) : true

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    // Flat 10 tickets per generation.
    const ticketCost = 10

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
      enable_safety_checker,
    }

    // SeeDream 5.0 Pro runs at 2K. Non-square ratios come through as a custom
    // width/height; 1:1 uses FAL's auto_2K default (omitted here).
    if (image_size === 'custom' && custom_width && custom_height) {
      input.image_size = {
        width: parseInt(String(custom_width)),
        height: parseInt(String(custom_height)),
      }
    } else if (image_size !== 'auto_2K') {
      input.image_size = image_size
    }
    // auto_2K: omit — it's FAL's default

    // Reference images as base64 data URIs (bypasses URL-based content scanner)
    const hasRefImages = Array.isArray(images_base64) && images_base64.length > 0
    if (hasRefImages) {
      const dataUris: string[] = (images_base64 as string[])
        .slice(0, 10)
        .filter((uri: string) => typeof uri === 'string' && uri.length > 0)
        // Library refs arrive as https URLs — fal fetches those natively; only bare base64 needs the data-URI wrapper
        .map((uri: string) => (uri.startsWith('data:') || uri.startsWith('http')) ? uri : `data:image/jpeg;base64,${uri}`)

      if (dataUris.length > 0) {
        input.image_urls = dataUris
      }
    }

    const endpoint = hasRefImages
      ? `${ENDPOINT_BASE}/edit`
      : `${ENDPOINT_BASE}/text-to-image`

    const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`
    const webhookUrl = `${appUrl}/api/webhooks/fal`

    console.log(`SeeDream 5 Pro async submit (${endpoint}), webhook: ${webhookUrl}`)

    let request_id: string
    try {
      const result = await fal.queue.submit(endpoint, { input, webhookUrl })
      request_id = result.request_id
    } catch (falErr: any) {
      await prisma.ticket.update({
        where: { userId: user.id },
        data: { reserved: { decrement: ticketCost } },
      })
      throw falErr
    }

    console.log(`FAL accepted SeeDream 5 Pro job: ${request_id}`)

    const queueEntry = await prisma.generationQueue.create({
      data: {
        userId:      user.id,
        modelId:     'seedream-5-pro',
        modelType:   'image',
        prompt:      prompt.trim(),
        parameters:  {
          source: 'main-scanner',
          adminMode: false,
          quality,
          aspectRatio,
          referenceImageUrls,
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

    console.log(`SeeDream 5 Pro queue entry #${queueEntry.id} created, reserved ${ticketCost} ticket(s)`)

    return NextResponse.json({ success: true, queueId: queueEntry.id, newBalance })
  } catch (error: any) {
    console.error('SeeDream 5 Pro submit error:', {
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
