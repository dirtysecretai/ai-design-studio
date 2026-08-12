import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import prisma from '@/lib/prisma'

const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// POST /api/admin/flux-inference/save
// Saves a completed RunPod flux generation to GeneratedImage so it shows in /api/my-images
// Body: { r2Key: string, prompt: string }
// Returns: { id: number }
export async function POST(req: Request) {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  const sessionUser = token ? await getUserFromSession(token) : null
  if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Admin-only: flux runs are an admin feature — a plain user session must not
  // be able to insert arbitrary GeneratedImage rows through this route
  if (!await checkIsAdmin(sessionUser.email ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({})) as { r2Key?: string; prompt?: string; videoMetadata?: Record<string, unknown>; referenceImageUrls?: string[]; createdAt?: string }
  const { r2Key, prompt, videoMetadata } = body
  // createdAt = when the generation was QUEUED (the feed's ordering key).
  // Sanity-capped so a bad client value can't strand a row far in the past.
  const queuedDate = body.createdAt ? new Date(body.createdAt) : null
  const createdAtOverride = queuedDate && !isNaN(queuedDate.getTime())
    && queuedDate.getTime() > Date.now() - 24 * 3600 * 1000 && queuedDate.getTime() <= Date.now() + 60_000
    ? queuedDate : null
  // i2i / IP-Adapter refs — shown in the info panel like the other models.
  // https URLs only (never store data URLs in the DB row)
  const refUrls = Array.isArray(body.referenceImageUrls)
    ? body.referenceImageUrls.filter((u): u is string => typeof u === 'string' && u.startsWith('https://')).slice(0, 3)
    : []
  if (!r2Key) return NextResponse.json({ error: 'Missing r2Key' }, { status: 400 })

  // Idempotency: return existing record if already saved
  try {
    const existing = await prisma.generatedImage.findFirst({
      where: { userId: sessionUser.id, imageUrl: `${PUBLIC_URL}/${r2Key}` },
      select: { id: true },
    })
    if (existing) return NextResponse.json({ id: existing.id })
  } catch {}

  const imageUrl = PUBLIC_URL ? `${PUBLIC_URL}/${r2Key}` : `/${r2Key}`

  // Derive aspectRatio from the flux dims so the generic feed/info UI has it
  const fw = Number((videoMetadata as Record<string, unknown> | undefined)?.fluxWidth)
  const fh = Number((videoMetadata as Record<string, unknown> | undefined)?.fluxHeight)

  const record = await prisma.generatedImage.create({
    data: {
      userId:             sessionUser.id,
      prompt:             prompt || '',
      imageUrl,
      model:              'custom-flux-lora',
      ticketCost:         0,
      referenceImageUrls: refUrls,
      expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      ...(videoMetadata ? { videoMetadata: videoMetadata as object } : {}),
      ...(fw > 0 && fh > 0 ? { aspectRatio: `${fw}x${fh}` } : {}),
      ...(createdAtOverride ? { createdAt: createdAtOverride } : {}),
    },
    select: { id: true },
  })

  return NextResponse.json({ id: record.id })
}
