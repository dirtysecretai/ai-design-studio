import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/seedream-5-lite-submit
// Submits a SeeDream 5 Lite job to the FAL async queue and returns a queueId
// immediately so the client doesn't block waiting for the generation to finish.
// Completion is delivered via the FAL webhook (/api/webhooks/fal).
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const user = await getUserFromSession(token)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

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
      enable_safety_checker = false,
      quality = '2k',
      aspectRatio = '1:1',
      referenceImageUrls = [],
    } = body

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    // Calculate ticket cost
    const ticketCost = quality === '3k' ? 4 : 2

    // Check and reserve tickets
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

    // Image size — same logic as the sync route
    const IMAGE_SIZE_CUSTOM_MAP: Record<string, { width: number; height: number }> = {
      'auto_3K': { width: 3072, height: 3072 },
    }
    if (image_size === 'custom' && custom_width && custom_height) {
      input.image_size = {
        width: parseInt(String(custom_width)),
        height: parseInt(String(custom_height)),
      }
    } else if (IMAGE_SIZE_CUSTOM_MAP[image_size]) {
      input.image_size = IMAGE_SIZE_CUSTOM_MAP[image_size]
    } else if (image_size !== 'auto_2K') {
      input.image_size = image_size
    }
    // auto_2K: omit — it's FAL's default

    // Upload reference images as base64 data URIs (bypasses URL-based content scanner)
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
      ? 'fal-ai/bytedance/seedream/v5/lite/edit'
      : 'fal-ai/bytedance/seedream/v5/lite/text-to-image'

    // Submit to FAL async queue — returns immediately with a request_id
    const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`
    const webhookUrl = `${appUrl}/api/webhooks/fal`

    console.log(`SeeDream 5 Lite async submit (${endpoint}), webhook: ${webhookUrl}`)

    let request_id: string
    try {
      const result = await fal.queue.submit(endpoint, { input, webhookUrl })
      request_id = result.request_id
    } catch (falErr: any) {
      // FAL submission failed — release the reservation
      await prisma.ticket.update({
        where: { userId: user.id },
        data: { reserved: { decrement: ticketCost } },
      })
      throw falErr
    }

    console.log(`FAL accepted SeeDream 5 Lite job: ${request_id}`)

    // Create a generationQueue entry so the existing polling and webhook machinery works
    const queueEntry = await prisma.generationQueue.create({
      data: {
        userId:      user.id,
        modelId:     'seedream-5-lite',
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

    // Increment global FAL concurrency counter so the admin queue display stays accurate
    const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
    await prisma.modelConcurrencyLimit.updateMany({
      where: { modelId: FAL_GLOBAL_ID },
      data: { currentActive: { increment: 1 } },
    })

    console.log(`SeeDream 5 Lite queue entry #${queueEntry.id} created, reserved ${ticketCost} ticket(s)`)

    return NextResponse.json({ success: true, queueId: queueEntry.id, newBalance })
  } catch (error: any) {
    console.error('SeeDream 5 Lite submit error:', {
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
