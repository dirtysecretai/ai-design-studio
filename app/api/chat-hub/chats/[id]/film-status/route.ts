import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import type { AgentStep } from '@/lib/chat-hub-agent'

// GET /api/chat-hub/chats/[id]/film-status
//
// Chat video is submitted, not awaited: the render outlives the 300s send
// function, so create_media returns a queue id and the turn ends. Something
// still has to (a) ask fal whether the shot finished and (b) put the finished
// clip back into the reply that ordered it. This route is that something.
//
// It settles through /api/video/status's own handler rather than re-doing the
// work: that route already re-hosts to R2, writes the GeneratedImage row and
// releases the queue slot. Calling it as a function keeps this request's user
// context, exactly like the submit path in lib/chat-video-submit.

export const runtime = 'nodejs'
export const maxDuration = 60

type PendingShot = { step: AgentStep; queueId: number }

/** Past this, a shot is treated as stalled so the film can proceed without it. */
const STALLED_AFTER_MS = 15 * 60 * 1000

/**
 * Record one shot's outcome. A single-video step is finished by its one shot;
 * a render_shots step is only finished once every id it carries has settled,
 * so it keeps a per-shot record and flips to done at the end.
 */
function markSettled(step: AgentStep, queueId: number, url: string | null, error?: string) {
  const many = (step as AgentStep & { queueIds?: number[] }).queueIds
  if (!Array.isArray(many)) {
    if (url) { step.status = 'done'; step.imageUrl = url }
    else { step.status = 'error'; step.error = error }
    return
  }
  const results = ((step as AgentStep & { shotResults?: Record<string, string> }).shotResults ??= {})
  results[String(queueId)] = url ?? `ERROR: ${error ?? 'failed'}`
  if (url && !step.imageUrl) step.imageUrl = url
  if (many.every(id => results[String(id)] !== undefined)) {
    step.status = Object.values(results).every(v => v.startsWith('ERROR:')) ? 'error' : 'done'
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const chatId = Number((await params).id)
  if (!Number.isInteger(chatId)) return NextResponse.json({ error: 'Bad chat id' }, { status: 400 })

  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: user.id }, select: { id: true } })
  if (!chat) return NextResponse.json({ error: 'Chat not found' }, { status: 404 })

  // Only the newest assistant reply can still be waiting on shots
  const row = await prisma.chatMessage.findFirst({
    where: { chatId, role: 'assistant' },
    orderBy: { id: 'desc' },
    select: { id: true, imageUrls: true, metadata: true },
  })
  if (!row) return NextResponse.json({ shots: [], done: true })

  const meta = (row.metadata ?? {}) as { agentSteps?: AgentStep[] }
  const steps = Array.isArray(meta.agentSteps) ? meta.agentSteps : []

  // Two shapes reach here: a single create_media video (queueId) and a whole
  // shot list from render_shots (queueIds). Handling only the first is why a
  // batch-rendered film reported "no media" — nothing ever settled it.
  const pending: PendingShot[] = []
  for (const step of steps) {
    if (step.status !== 'running') continue
    const one = (step as AgentStep & { queueId?: number }).queueId
    if (typeof one === 'number' && one > 0 && !step.imageUrl) {
      pending.push({ step, queueId: one })
    }
    const many = (step as AgentStep & { queueIds?: number[] }).queueIds
    if (Array.isArray(many)) {
      for (const q of many) if (typeof q === 'number' && q > 0) pending.push({ step, queueId: q })
    }
  }

  if (pending.length === 0) {
    return NextResponse.json({ shots: [], done: true })
  }

  const jobs = await prisma.generationQueue.findMany({
    where: { id: { in: pending.map(p => p.queueId) }, userId: user.id },
    select: {
      id: true, status: true, errorMessage: true, falRequestId: true, modelType: true,
      modelId: true, prompt: true, ticketCost: true, createdAt: true, parameters: true,
    },
  })
  const byId = new Map(jobs.map(j => [j.id, j]))

  const { POST: videoStatus } = await import('@/app/api/video/status/route')
  let changed = false
  const settled: { queueId: number; status: string; url?: string; error?: string }[] = []

  for (const { step, queueId } of pending) {
    const job = byId.get(queueId)
    if (!job) {
      settled.push({ queueId, status: 'missing' })
      continue
    }
    const p = (job.parameters ?? {}) as Record<string, any>

    // Already settled by another poller (the feed, the cron) — take its result.
    // completedImageUrls is an IMAGE convention: the fal webhook writes it. A
    // video is settled by /api/video/status, which saves a GeneratedImage and
    // closes the row WITHOUT recording the url here — so a finished shot looked
    // like "completed with nothing to show" and the film never continued.
    // Fall back to the generation the request actually produced.
    if (job.status === 'completed' || job.status === 'failed') {
      const urls: unknown = p.completedImageUrls
      let url = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : undefined
      if (!url && job.status === 'completed' && job.falRequestId) {
        const saved = await prisma.generatedImage.findFirst({
          where: { falRequestId: job.falRequestId, userId: user.id },
          select: { imageUrl: true },
          orderBy: { id: 'desc' },
        })
        url = saved?.imageUrl
      }
      if (job.status === 'completed' && url) {
        markSettled(step, queueId, url); changed = true
        settled.push({ queueId, status: 'completed', url })
      } else if (job.status === 'failed') {
        markSettled(step, queueId, null, job.errorMessage ?? 'Generation failed'); changed = true
        settled.push({ queueId, status: 'failed', error: job.errorMessage ?? 'Generation failed' })
      } else {
        // Closed as completed but nothing to show: the generation is genuinely
        // gone. Settle it as a failure rather than reporting a done shot with
        // no footage, which used to let the run continue and then report "no
        // media" for a shot it thought had landed.
        markSettled(step, queueId, null, 'Finished with no output'); changed = true
        settled.push({ queueId, status: 'failed', error: 'Finished with no output' })
      }
      continue
    }

    if (!job.falRequestId || !p.falEndpoint) {
      settled.push({ queueId, status: job.status })
      continue
    }

    // Image jobs settle themselves: the fal webhook writes the GeneratedImage
    // rows and closes the queue row, and the cron harvests any the webhook
    // missed. Asking the VIDEO status route about one would be nonsense — just
    // report where it is and pick the result up on a later tick.
    if (job.modelType !== 'video') {
      settled.push({ queueId, status: 'in_progress' })
      continue
    }

    try {
      const res = await videoStatus(new NextRequest('http://internal/api/video/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: job.falRequestId,
          falEndpoint: p.falEndpoint,
          prompt: job.prompt,
          model: job.modelId,
          duration: p.duration,
          resolution: p.resolution,
          ticketCost: job.ticketCost,
          // Queue order in the feed, not completion order
          queuedAt: job.createdAt.getTime(),
        }),
      }))
      const data = (await res.json()) as Record<string, any>

      if (data?.status === 'completed' && typeof data.videoUrl === 'string') {
        markSettled(step, queueId, data.videoUrl); changed = true
        settled.push({ queueId, status: 'completed', url: data.videoUrl })
      } else if (data?.status === 'failed') {
        markSettled(step, queueId, null, String(data.error || 'Generation failed')); changed = true
        settled.push({ queueId, status: 'failed', error: String(data.error || 'Generation failed') })
      } else {
        // A shot that has been running far longer than any model needs is not
        // going to unblock the film by being waited on harder. Report it as
        // stalled so the run can continue with the takes it has and TELL the
        // user, instead of polling forever behind one bad job.
        const ageMs = Date.now() - (job.createdAt?.getTime() ?? Date.now())
        if (ageMs > STALLED_AFTER_MS) {
          const msg = 'Still rendering long past the expected time — continuing without this shot'
          markSettled(step, queueId, null, msg); changed = true
          settled.push({ queueId, status: 'stalled', error: msg })
        } else {
          settled.push({ queueId, status: 'in_progress' })
        }
      }
    } catch (err: any) {
      // A transient fal/network error is not a failed shot — try again next tick
      settled.push({ queueId, status: 'in_progress', error: String(err?.message || err).slice(0, 200) })
    }
  }

  if (changed) {
    const newUrls = settled
      .filter(s => s.status === 'completed' && s.url)
      .map(s => s.url as string)
    // The client polls this every 8s and a slow tick can overlap the next one:
    // both read the same imageUrls, both append the same settled shot, and the
    // clip renders twice. A Set on write is the only ordering-proof fix.
    const merged = [...new Set([...row.imageUrls, ...newUrls])].filter(Boolean)
    await prisma.chatMessage.update({
      where: { id: row.id },
      data: {
        metadata: { ...(row.metadata as Record<string, unknown>), agentSteps: steps } as any,
        ...(merged.length !== row.imageUrls.length ? { imageUrls: merged } : {}),
      },
    })
  }

  const stillRunning = settled.some(s => s.status === 'in_progress')
  return NextResponse.json({
    messageId: row.id,
    shots: settled,
    done: !stillRunning,
  })
}
