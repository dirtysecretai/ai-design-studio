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
  let step = 'init'
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

    step = 'parse-body'
    const body = await req.json()
    const {
      prompt,
      images_base64 = [],        // Array of base64 data URIs from client
      image_size = 'auto_2K',    // Preset enum OR 'custom'
      custom_width,
      custom_height,
      num_images = 1,
      max_images = 1,
      enable_safety_checker = true,
    } = body

    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }

    // Server-side ticket cost — 4 for 3K, 2 otherwise
    const ticketCost = (image_size as string) === 'auto_3K' ? 4 : 2
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

    // Minimal input — only send fields we know FAL accepts.
    // num_images / max_images / image_size are sent optionally to avoid
    // triggering unknown-field or pattern-validation errors.
    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      enable_safety_checker,
    }

    // Only add num_images if > 1
    const parsedNumImages = Math.min(Math.max(1, parseInt(String(num_images)) || 1), 8)
    if (parsedNumImages > 1) input.num_images = parsedNumImages

    // Image size — omit auto_2K (FAL default) to avoid pattern issues.
    // auto_3K and others: map to explicit custom objects.
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
      // Pass standard presets (square_hd, landscape_16_9, etc.) as-is
      input.image_size = image_size
    }
    // auto_2K: omit — it's FAL's default

    // Determine mode: edit (image_urls provided) or text-to-image
    const hasRefImages = Array.isArray(images_base64) && images_base64.length > 0

    if (hasRefImages) {
      // Pass images as base64 data URIs directly — bypasses FAL's URL-based
      // content scanner which runs on public storage URLs but not inline base64.
      const dataUris: string[] = (images_base64 as any[])
        .slice(0, 10)
        .filter((uri: any) => typeof uri === 'string' && uri.length > 0)
        // Library refs arrive as https URLs — fal fetches those natively; only bare base64 needs the data-URI wrapper
        .map((uri: string) => (uri.startsWith('data:') || uri.startsWith('http')) ? uri : `data:image/jpeg;base64,${uri}`)

      if (dataUris.length > 0) {
        input.image_urls = dataUris
      }
    }

    const endpoint = hasRefImages
      ? 'fal-ai/bytedance/seedream/v5/lite/edit'
      : 'fal-ai/bytedance/seedream/v5/lite/text-to-image'

    console.log(`SeedDream 5 Lite request (${endpoint}):`, JSON.stringify({
      ...input,
      image_urls: hasRefImages ? `[${(input.image_urls as string[])?.length} base64 uris]` : undefined,
    }))

    step = 'fal-subscribe'
    let result: any
    try {
      const start = Date.now()
      result = await fal.subscribe(endpoint, {
        input,
        logs: false,
      })
      const elapsed = Date.now() - start
      result._elapsed = elapsed
    } catch (falError: any) {
      // Surface the full FAL validation detail so it's visible in logs
      console.error('FAL API error:', {
        message: falError.message,
        status: falError.status,
        body: JSON.stringify(falError.body),
      })
      const detail = falError.body?.detail
      let detailMsg: string | null = null
      if (Array.isArray(detail)) {
        detailMsg = detail.map((d: any) => `${d.loc?.join('.')} — ${d.msg}`).join('; ')
      } else if (typeof detail === 'string') {
        detailMsg = detail
      } else if (detail) {
        detailMsg = JSON.stringify(detail)
      }
      await refundGenerationTickets(sessionUser.id, sessionUser.email, ticketCost)
      const rawBody = JSON.stringify(falError.body)
      const errorMsg = detailMsg || falError.message || 'Generation failed'
      return NextResponse.json(
        { error: `${errorMsg} | FAL body: ${rawBody}` },
        { status: 500 }
      )
    }

    const elapsed: number = result._elapsed ?? 0
    const falImages: { url: string; width?: number; height?: number }[] =
      (result.data as any).images || []
    const seed: number | undefined = (result.data as any).seed

    if (falImages.length === 0) {
      await refundGenerationTickets(sessionUser.id, sessionUser.email, ticketCost)
      return NextResponse.json({ error: 'No images returned from model' }, { status: 500 })
    }

    // Download from FAL temporary storage and re-host on Vercel Blob
    const hostedImages: { url: string; width?: number; height?: number }[] = []
    for (let i = 0; i < falImages.length; i++) {
      const falImg = falImages[i]
      try {
        const res = await fetch(falImg.url)
        if (!res.ok) {
          console.error(`Failed to download image ${i + 1}: ${res.status}`)
          continue
        }
        const buffer = Buffer.from(await res.arrayBuffer())
        const filename = `sd5-lite-edit-${Date.now()}-${i}.png`
        const url = await uploadToR2(filename, buffer, 'image/png')
        hostedImages.push({ url, width: falImg.width, height: falImg.height })
      } catch (downloadErr) {
        console.error(`Failed to re-host image ${i + 1}:`, downloadErr)
      }
    }

    if (hostedImages.length === 0) {
      return NextResponse.json({ error: 'Failed to host generated images' }, { status: 500 })
    }

    // Save to DB so images survive page refresh
    const qualityLabel = (() => {
      if (typeof image_size === 'object' && image_size !== null) {
        const w = (image_size as any).width || 0
        return w >= 3072 ? '3k' : '2k'
      }
      return image_size === 'auto_3K' ? '3k' : '2k'
    })()
    try {
      const targetUserId: number | null = sessionUser?.id ?? null
      if (!targetUserId) {
        console.error('seedream-5-lite-edit: no session user — skipping DB save')
      }
      if (targetUserId) {
        await Promise.all(hostedImages.map(img =>
          prisma.generatedImage.create({
            data: {
              userId:             targetUserId!,
              prompt:             prompt.trim(),
              imageUrl:           img.url,
              model:              'seedream-5-lite',
              ticketCost:         0,
              referenceImageUrls: hasRefImages ? (input.image_urls as string[] ?? []) : [],
              quality:            qualityLabel,
              aspectRatio:        '1:1',
              expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
            },
          })
        ))
      }
    } catch (dbErr) {
      console.error('SeedDream5 Lite: failed to save to DB (non-fatal):', dbErr)
    }

    return NextResponse.json({
      success: true,
      images: hostedImages,
      seed,
      elapsed,
      requestId: result.requestId,
    })
  } catch (error: any) {
    console.error(`SeedDream 5 Lite Edit outer error at step [${step}]:`, error)
    return NextResponse.json(
      { error: `[${step}] ${error.message || 'Generation failed'}` },
      { status: 500 }
    )
  }
}
