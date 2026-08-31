import { NextRequest } from 'next/server'
import prisma from '@/lib/prisma'
import type { ChatCreateModel, ChatCreateSettings } from '@/lib/chat-hub-models'
import { fitRefsForVideo } from '@/lib/video-ref-fit'

// Chat video generation, routed through the site's OWN generation path.
//
// The hub used to keep a second catalog (lib/chat-hub-models + buildFalCall)
// and call fal directly. That meant nine video models instead of thirty-one,
// no ADMIN_ONLY_VIDEO_MODELS gate, no GenerationQueue row, no concurrency slot
// and a ticket formula that could drift from the one the rest of the site
// bills with. Everything worth having lives in /api/video/generate.
//
// The handler is invoked as a FUNCTION, not over HTTP: cookies() resolves
// against the request already in flight, so the job is submitted as the same
// user with no session forwarding and no second round trip. The repo already
// does this — app/api/v1/generate/image/route.ts re-exports /api/generate's
// POST, and drain-queue imports a helper straight out of a route module.

export type ChatVideoSubmission =
  | { ok: true; queueId: number; requestId: string | null; ticketCost: number; queued: boolean }
  | { ok: false; error: string }

/**
 * Map the hub's per-model settings onto the site route's body.
 *
 * The reference images carry different meanings per model and the route
 * validates each shape, so getting this wrong surfaces as a clean 400 rather
 * than a bad render.
 */
function buildBody(
  spec: ChatCreateModel,
  prompt: string,
  refs: string[],
  settings: ChatCreateSettings,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: spec.id,
    prompt,
    duration: settings.duration ?? '5',
    resolution: settings.resolution ?? '1080p',
    generateAudio: settings.audio === 'on',
    klingAspectRatio: settings.aspect ?? '16:9',
    // The hub is admin-only today, and an admin's tickets are bypassed by
    // lib/ticket-gate anyway. Passing false keeps the route as the single
    // authority on charging, so chat can never double-bill.
    adminMode: false,
  }

  if (spec.needsRef) {
    // image-to-video: the first ref is the start frame
    body.imageUrl = refs[0]
    if (spec.endFrame && refs.length > 1) body.endImageUrl = refs[1]
    body.sd20Mode = 'i2v'
  } else if (refs.length > 0) {
    // reference-to-video: the whole set anchors the subject
    body.referenceImageUrls = refs
    body.sd20Mode = refs.length === 1 && spec.endFrame ? 'i2v' : 'r2v'
    if (refs.length === 1) body.imageUrl = refs[0]
  } else {
    body.sd20Mode = 't2v'
  }

  return body
}

/**
 * Submit and return immediately with the queue id. Nothing here waits for the
 * render: the chat send route runs under a 300s function limit and a video is
 * routinely slower than that, so waiting inside the tool call is a design that
 * cannot succeed on Vercel.
 */
export async function submitChatVideo(
  spec: ChatCreateModel,
  prompt: string,
  refs: string[],
  settings: ChatCreateSettings,
  meta?: Record<string, unknown>,
): Promise<ChatVideoSubmission> {
  // A freshly generated plate is a 2K-4K PNG and routinely exceeds fal's 10MB
  // input cap, which the model rejects AFTER reporting the job complete. Fit
  // any oversized ref before it is ever submitted.
  const fitted = await fitRefsForVideo(refs)
  const body = { ...buildBody(spec, prompt, fitted, settings), ...(meta ?? {}) }

  try {
    // Imported lazily: the route module pulls fal + prisma + the queue helpers,
    // and only the video branch of create_media needs any of it.
    const { POST } = await import('@/app/api/video/generate/route')
    const req = new NextRequest('http://internal/api/video/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await POST(req)
    const data = (await res.json()) as Record<string, any>

    if (!res.ok || data?.success === false) {
      return { ok: false, error: String(data?.error || `Video submit failed (${res.status})`) }
    }

    const queueId = Number(data?.queueJobId ?? data?.queueId ?? 0)
    return {
      ok: true,
      queueId: Number.isFinite(queueId) ? queueId : 0,
      requestId: typeof data?.requestId === 'string' ? data.requestId : null,
      ticketCost: Number(data?.ticketCost ?? 0),
      queued: data?.queued === true || !data?.requestId,
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) }
  }
}

/** Where a submitted shot has got to, for the resume path. */
export async function chatVideoStatus(queueId: number): Promise<{
  status: string
  videoUrl: string | null
  error: string | null
}> {
  const row = await prisma.generationQueue.findUnique({
    where: { id: queueId },
    select: { status: true, errorMessage: true, parameters: true },
  })
  if (!row) return { status: 'missing', videoUrl: null, error: 'Job not found' }
  const params = (row.parameters ?? {}) as Record<string, unknown>
  const urls = Array.isArray(params.completedImageUrls) ? params.completedImageUrls : []
  return {
    status: row.status,
    videoUrl: typeof urls[0] === 'string' ? urls[0] : null,
    error: row.errorMessage ?? null,
  }
}
