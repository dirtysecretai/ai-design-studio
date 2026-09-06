import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { isGenerationBlocked } from '@/lib/generation-guard'
import { deductGenerationTickets, refundGenerationTickets } from '@/lib/ticket-gate'
import { enforceContentFilter } from '@/lib/content-filter'

fal.config({ credentials: process.env.FAL_KEY })

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null

    if (!sessionUser) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (await isGenerationBlocked(sessionUser.email)) {
      return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const body = await req.json()
    const {
      prompt,
      num_images = 1,
      aspect_ratio = 'auto',
      output_format = 'png',
      safety_tolerance = '4',
      resolution = '1K',
      limit_generations = true,
      enable_web_search = false,
      seed,
    } = body

    // Server-side ticket cost — matches nano-banana-2-live pricing
    const ticketCost = (resolution as string) === '4K' ? 12 : 7
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    const ticketResult = await deductGenerationTickets(sessionUser.id, sessionUser.email, ticketCost)
    if (!ticketResult.ok) {
      return NextResponse.json(
        { error: `Insufficient tickets — need ${ticketResult.need}, have ${ticketResult.have}` },
        { status: 402 },
      )
    }

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_images: Math.min(Math.max(1, parseInt(num_images) || 1), 4),
      aspect_ratio,
      output_format,
      safety_tolerance: String(safety_tolerance),
      resolution,
      limit_generations,
      enable_web_search,
    }

    // Only include seed if provided
    if (seed !== undefined && seed !== null && seed !== '') {
      input.seed = parseInt(seed)
    }

    console.log('NanoBanana 2 prototype request:', JSON.stringify(input))
    const start = Date.now()

    let result: any
    try {
      result = await fal.subscribe('fal-ai/nano-banana-2', { input, logs: false })
    } catch (falErr: any) {
      await refundGenerationTickets(sessionUser.id, sessionUser.email, ticketCost)
      throw falErr
    }

    const elapsed = Date.now() - start
    const falImages: { url: string; width?: number; height?: number; file_size?: number }[] =
      (result.data as any).images || []

    if (falImages.length === 0) {
      await refundGenerationTickets(sessionUser.id, sessionUser.email, ticketCost)
      return NextResponse.json({ error: 'No images returned from model' }, { status: 500 })
    }

    // Download from FAL temporary storage and re-host on Vercel Blob
    const hostedImages: { url: string; width?: number; height?: number }[] = []
    for (let i = 0; i < falImages.length; i++) {
      const falImg = falImages[i]
      const res = await fetch(falImg.url)
      if (!res.ok) {
        console.error(`Failed to download image ${i + 1}: ${res.status}`)
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const ext = output_format === 'jpeg' ? 'jpg' : output_format
      const filename = `nb2-proto-${Date.now()}-${i}.${ext}`
      const url = await uploadToR2(filename, buffer, `image/${output_format === 'jpeg' ? 'jpeg' : output_format}`)
      hostedImages.push({ url, width: falImg.width, height: falImg.height })
    }

    // Save to DB.
    try {
      await Promise.all(hostedImages.map(img =>
          prisma.generatedImage.create({
            data: {
              userId:            sessionUser.id,
              prompt:            prompt.trim(),
              imageUrl:          img.url,
              model:             'nano-banana-2',
              ticketCost,
              referenceImageUrls: [],
              quality:           resolution,
              aspectRatio:       aspect_ratio,
              expiresAt:         new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000), // 90 days
            },
          })
        ))
    } catch (dbErr) {
      // Non-fatal — log but still return the images
      console.error('NanaBanana2: failed to save to DB:', dbErr)
    }

    return NextResponse.json({
      success: true,
      images: hostedImages,
      description: (result.data as any).description || '',
      elapsed,
      requestId: result.requestId,
    })
  } catch (error: any) {
    console.error('NanoBanana 2 prototype error:', error)
    return NextResponse.json(
      { error: error.message || 'Generation failed' },
      { status: 500 }
    )
  }
}
