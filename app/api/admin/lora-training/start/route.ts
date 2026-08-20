import { NextRequest, NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getTrainerFamily } from '@/lib/trainer-families'

export const maxDuration = 300

function authOk(req: NextRequest) {
  const pass = process.env.ADMIN_PASSWORD
  // Fail closed: a missing ADMIN_PASSWORD must deny, not allow
  if (!pass) return false
  return req.headers.get('x-admin-password') === pass
}


const EDIT_TRAINER = 'fal-ai/flux-2-trainer/edit'

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { imageIds?: number[]; zipUrl?: string; modelId: string; config: Record<string, unknown>; name: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { imageIds, zipUrl, modelId, config, name } = body

  if (!modelId?.trim())
    return NextResponse.json({ error: 'modelId is required' }, { status: 400 })
  if (!name?.trim())
    return NextResponse.json({ error: 'name is required' }, { status: 400 })

  let jobConfig: Record<string, unknown>
  let imageCount: number

  if (modelId === EDIT_TRAINER) {
    if (!zipUrl?.trim())
      return NextResponse.json({ error: 'zipUrl is required for edit trainer' }, { status: 400 })
    jobConfig = { ...config, _zipUrl: zipUrl }
    imageCount = 0
  } else {
    if (!Array.isArray(imageIds) || imageIds.length === 0)
      return NextResponse.json({ error: 'imageIds must be a non-empty array' }, { status: 400 })

    const family = getTrainerFamily(modelId)
    const images = await prisma.generatedImage.findMany({
      where: { id: { in: imageIds } },
      select: { id: true, imageUrl: true },
    })
    if (images.length === 0)
      return NextResponse.json({ error: 'No images found for given imageIds' }, { status: 400 })

    let usable = images
    if (family) {
      if (family.media === 'video') {
        // Video trainers only eat motion media — GIFs are auto-converted in
        // prepare, stills are rejected up front so the run can't silently shrink
        usable = images.filter(i => /\.(gif|mp4|mov|m4v|webm)(\?|#|$)/i.test(i.imageUrl))
        const stills = images.length - usable.length
        if (stills > 0 && usable.length < family.datasetRules.min)
          return NextResponse.json({ error: `${family.label} needs video/GIF items — ${stills} still image(s) in the selection can't be used` }, { status: 400 })
      }
      if (usable.length < family.datasetRules.min)
        return NextResponse.json({ error: `${family.label} needs at least ${family.datasetRules.min} items (got ${usable.length})` }, { status: 400 })
      if (usable.length > family.datasetRules.max)
        return NextResponse.json({ error: `${family.label} accepts at most ${family.datasetRules.max} items (got ${usable.length})` }, { status: 400 })
      if (family.familyId === 'wan22-image' && !String(config?.trigger_phrase ?? '').trim())
        return NextResponse.json({ error: 'trigger_phrase is required for the Wan 2.2 image trainer' }, { status: 400 })
    }

    jobConfig = { ...config, _imageIds: usable.map(i => i.id) }
    imageCount = usable.length
  }

  const job = await prisma.loraTrainingJob.create({
    data: {
      name: name.trim(),
      modelId,
      status: 'preparing',
      config: jobConfig as object,
      imageCount,
    },
  })

  // Kick off the prepare endpoint as an independent HTTP request
  // after() just launches it — the prepare endpoint has its own lifecycle.
  // Base comes from the INCOMING request origin so a dev-server start kicks the
  // dev prepare (env fallback used to point local starts at production, which
  // ran a stale prepare against the shared DB).
  const reqOrigin = req.nextUrl.origin
  after(async () => {
    const base = reqOrigin || process.env.NEXT_PUBLIC_SITE_URL || 'https://prompt-protocol.vercel.app'
    try {
      await fetch(`${base}/api/admin/lora-training/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': process.env.ADMIN_PASSWORD ?? '',
        },
        body: JSON.stringify({ jobId: job.id }),
        signal: AbortSignal.timeout(5_000), // just wait long enough to confirm it started
      })
    } catch {
      // Timeout or network error launching prepare — that's fine, prepare runs independently
    }
  })

  return NextResponse.json({ jobId: job.id })
}
