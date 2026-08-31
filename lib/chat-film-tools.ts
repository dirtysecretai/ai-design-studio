import { NextRequest } from 'next/server'
import prisma from '@/lib/prisma'
import { getCreateModel } from '@/lib/chat-hub-models'
import { submitChatVideo } from '@/lib/chat-video-submit'
import { AUDIO_MODELS, buildAudioCall, getAudioModel } from '@/lib/audio-models'

// The four tools that turn a shot list into a delivered film. Kept out of
// chat-hub-agent.ts (already ~230KB) and registered there under the
// movie-production skill, which is what stops the other video employees from
// half-using this pipeline.

type Ctx = {
  user: { id: number; email: string }
  attachedImageUrls: string[]
  allowedImages?: Set<string>
  generatedUrls?: string[]
  /** Seconds the finished cut is supposed to run, from the format dropdown. */
  targetSeconds?: number
}

export type ShotSpec = {
  n: number
  model: string
  prompt: string
  settings?: Record<string, string>
  reference_image_urls?: string[]
}

/** Only media this conversation has actually seen may be fed to a render. */
function allowed(ctx: Ctx, urls: string[] | undefined): string[] {
  if (!Array.isArray(urls)) return []
  return urls.filter(u =>
    typeof u === 'string' && u.startsWith('https://')
    && (!ctx.allowedImages || ctx.allowedImages.has(u)))
}

/**
 * Submit a whole shot list in ONE call.
 *
 * One create_media per shot burns a model step each and hits the reply's step
 * cap long before a film is finished. This submits every shot, returns the
 * queue ids, and lets the render happen after the turn ends.
 */
export async function executeRenderShots(
  input: { shots: ShotSpec[]; aspect?: string; fps?: number },
  ctx: Ctx,
): Promise<{ submitted: { n: number; queueId: number; model: string }[]; failed: { n: number; error: string }[]; queueIds: number[]; note: string } | { error: string }> {
  const shots = Array.isArray(input.shots) ? input.shots.slice(0, 16) : []
  if (shots.length === 0) return { error: 'shots must be a non-empty array' }

  // HARD GUARD against paying twice for one shot list. The per-shot prompt
  // check below only catches an exact repeat; a re-plan that reworded the
  // shots slipped straight past it and billed a second full batch. If ANY
  // video from this account is still rendering, a new batch is almost
  // certainly the same run submitting again — refuse and point at the ids.
  const inFlight = await prisma.generationQueue.findMany({
    where: {
      userId: ctx.user.id,
      modelType: 'video',
      status: { in: ['queued', 'processing'] },
      createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 32,
  })
  if (inFlight.length > 0) {
    const ids = inFlight.map(j => j.id)
    // Not an error — the shots this call wanted are already rendering. Report
    // it as a normal outcome so the run reads as "in progress" rather than
    // showing the user a red failure for a guard that worked.
    return {
      submitted: ids.map((id, i) => ({ n: i + 1, queueId: id, model: 'in-flight' })),
      failed: [],
      queueIds: ids,
      note:
        `Already rendering — ${ids.length} shot(s) from this run are in the queue (ids ${ids.join(', ')}), so nothing new was submitted and the user was not billed again. `
        + `Do NOT re-submit. End the turn: the finished shots and their frames come back on their own and you continue from there.`,
    }
  }

  const submitted: { n: number; queueId: number; model: string }[] = []
  const failed: { n: number; error: string }[] = []
  let reused = 0

  for (const shot of shots) {
    const spec = getCreateModel(shot.model)
    if (!spec || spec.kind !== 'video' || spec.disabled) {
      failed.push({ n: shot.n, error: `${shot.model} is not an available video model` })
      continue
    }
    const refs = allowed(ctx, shot.reference_image_urls)
    if (spec.needsRef && refs.length === 0) {
      failed.push({ n: shot.n, error: `${spec.label} needs a start image — pass reference_image_urls from this conversation` })
      continue
    }
    const settings: Record<string, string> = {
      ...(shot.settings ?? {}),
      ...(input.aspect ? { aspect: input.aspect } : {}),
    }
    // IDEMPOTENCY. An approval round-trip can replay this call, and the agent
    // sometimes re-submits after a pause because it sees no media in the reply
    // yet. Both re-render a shot the user has already paid for. The queue row
    // stores the prompt and model, so an identical shot still in flight is a
    // duplicate — hand back the job that already exists.
    const dup = await prisma.generationQueue.findFirst({
      where: {
        userId: ctx.user.id,
        modelId: spec.id,
        prompt: shot.prompt.trim(),
        status: { in: ['queued', 'processing'] },
        createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
      },
      select: { id: true },
      orderBy: { id: 'desc' },
    })
    if (dup) {
      submitted.push({ n: shot.n, queueId: dup.id, model: spec.id })
      reused++
      continue
    }

    const res = await submitChatVideo(spec, shot.prompt, refs.slice(0, spec.maxRefs), settings, {
      userId: ctx.user.id,
    })
    if (res.ok) submitted.push({ n: shot.n, queueId: res.queueId, model: spec.id })
    else failed.push({ n: shot.n, error: res.error })
  }

  if (submitted.length === 0) {
    return { error: `No shot could be submitted. ${failed.map(f => `#${f.n}: ${f.error}`).join(' | ')}` }
  }

  return {
    submitted,
    failed,
    queueIds: submitted.map(x => x.queueId),
    note:
      `${submitted.length} shot(s) submitted${reused ? ` (${reused} already in flight — reused, not re-paid)` : ''}${failed.length ? `, ${failed.length} rejected` : ''}. `
      + `Rendering runs on the server and outlives this reply — do NOT wait, do NOT claim any shot is finished, `
      + `and do NOT assemble yet. Tell the user what is rendering and end the turn; the finished shots and their `
      + `frames come back automatically, and you continue from there.`,
  }
}

/** Where the submitted shots have got to, with frames for the finished ones. */
export async function executeCheckShots(
  input: { queue_ids: number[] },
  ctx: Ctx,
): Promise<{ shots: { queueId: number; status: string; url?: string; lastFrame?: string; midFrame?: string; error?: string }[]; done: boolean; note: string } | { error: string }> {
  const ids = (Array.isArray(input.queue_ids) ? input.queue_ids : [])
    .map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 16)
  if (ids.length === 0) return { error: 'queue_ids must be a non-empty array of queue ids' }

  const rows = await prisma.generationQueue.findMany({
    where: { id: { in: ids }, userId: ctx.user.id },
    select: { id: true, status: true, errorMessage: true, parameters: true, falRequestId: true },
  })

  const shots: { queueId: number; status: string; url?: string; lastFrame?: string; midFrame?: string; error?: string }[] = []
  let pending = 0

  for (const row of rows) {
    const p = (row.parameters ?? {}) as Record<string, any>
    const urls = Array.isArray(p.completedImageUrls) ? p.completedImageUrls : []
    let url: string | undefined = typeof urls[0] === 'string' ? urls[0] : undefined
    // Video settles without writing completedImageUrls — the saved generation
    // is the record of what it produced.
    if (!url && row.status === 'completed' && row.falRequestId) {
      const saved = await prisma.generatedImage.findFirst({
        where: { falRequestId: row.falRequestId, userId: ctx.user.id },
        select: { imageUrl: true },
        orderBy: { id: 'desc' },
      })
      url = saved?.imageUrl
    }
    if (row.status === 'completed' && url) {
      // The agent cannot watch video: extract the frames it will judge from,
      // and the last frame doubles as the next shot's start image.
      const frames = await extractFrames(url).catch(() => null)
      if (frames?.mid) ctx.allowedImages?.add(frames.mid)
      if (frames?.last) ctx.allowedImages?.add(frames.last)
      shots.push({ queueId: row.id, status: 'completed', url, midFrame: frames?.mid, lastFrame: frames?.last })
    } else if (row.status === 'failed') {
      shots.push({ queueId: row.id, status: 'failed', error: row.errorMessage ?? 'Generation failed' })
    } else {
      pending++
      shots.push({ queueId: row.id, status: row.status })
    }
  }

  return {
    shots,
    done: pending === 0,
    note: pending > 0
      ? `${pending} shot(s) still rendering. End the turn — they finish on their own and you will be continued.`
      : 'All shots settled. The attached frames ARE the shots: judge identity against the canon descriptor, hands, eyes, light direction and grade before cutting anything. A LAST frame is also the start image for a chained next shot.',
  }
}

/** frames op on the assembly route. */
async function extractFrames(videoUrl: string): Promise<{ mid?: string; last?: string }> {
  const { POST } = await import('@/app/api/video/assemble/route')
  const res = await POST(new NextRequest('http://internal/api/video/assemble', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'frames', videoUrl, at: ['mid', 'last'] }),
  }))
  const data = (await res.json()) as { frames?: Record<string, string> }
  return { mid: data?.frames?.mid, last: data?.frames?.last }
}

/**
 * Pull stills out of any video in the conversation.
 *
 * The video models are producing frames at a quality the image models would
 * charge for, and every one of them is a usable asset: a start image for the
 * next shot, a reference for an image generation, a plate to edit, a poster
 * source, a thumbnail. Before this the frames were trapped inside the clip.
 */
export async function executeExtractFrames(
  input: { video_url: string; at?: string[]; times_sec?: number[] },
  ctx: Ctx,
): Promise<{ frames: { at: string; url: string }[]; durationSec: number; note: string } | { error: string }> {
  const videoUrl = typeof input.video_url === 'string' ? input.video_url : ''
  if (!videoUrl.startsWith('https://')) return { error: 'video_url must be a video from this conversation' }
  if (ctx.allowedImages && !ctx.allowedImages.has(videoUrl)) {
    return { error: 'That video is not from this conversation — extract only from clips generated or shown here.' }
  }

  const { POST } = await import('@/app/api/video/assemble/route')
  const call = async (payload: Record<string, unknown>) => {
    const res = await POST(new NextRequest('http://internal/api/video/assemble', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return (await res.json()) as Record<string, any>
  }

  const at = Array.isArray(input.at) && input.at.length
    ? input.at.filter(a => a === 'first' || a === 'mid' || a === 'last')
    : ['first', 'mid', 'last']

  const out = await call({ op: 'frames', videoUrl, at })
  if (!out?.frames) return { error: String(out?.error || 'Frame extraction failed') }

  const frames: { at: string; url: string }[] = []
  for (const [which, url] of Object.entries(out.frames as Record<string, string>)) {
    if (typeof url !== 'string') continue
    frames.push({ at: which, url })
    // Usable straight away as a reference or an edit source
    ctx.allowedImages?.add(url)
    ctx.generatedUrls?.push(url)
  }

  return {
    frames,
    durationSec: Number(out.durationSec) || 0,
    note:
      `${frames.length} frame(s) extracted and now usable as references. `
      + `Feed them to create_media as reference_image_urls (a LAST frame is the seamless start image for the next shot), `
      + `to an image model to build a matching still, or to edit_image as a plate. Free — no model ran.`,
  }
}

/** Stitch the approved takes, and optionally mix music/voice over the cut. */
export async function executeAssembleFilm(
  input: {
    clips?: { url: string; trimStart?: number; trimEnd?: number }[]
    video_url?: string
    aspect?: string
    fps?: number
    music?: { url: string; gainDb?: number; fadeOutSec?: number }
    voice?: { url: string; atSec?: number; gainDb?: number }[]
    captions?: { text: string; startSec: number; endSec: number }[]
    captionPosition?: string
  },
  ctx: Ctx,
): Promise<{ mediaUrl: string; durationSec: number; note: string } | { error: string }> {
  const { POST } = await import('@/app/api/video/assemble/route')

  const call = async (payload: Record<string, unknown>) => {
    const res = await POST(new NextRequest('http://internal/api/video/assemble', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return (await res.json()) as Record<string, any>
  }

  let filmUrl = typeof input.video_url === 'string' ? input.video_url : ''
  let durationSec = 0

  if (!filmUrl) {
    const clips = (input.clips ?? [])
      .map(c => (typeof c === 'string' ? { url: c } : c))
      .filter(c => c && typeof c.url === 'string')
    if (clips.length === 0) return { error: 'Pass clips (the shot URLs in cut order) or video_url (an existing cut to score)' }
    const out = await call({ op: 'stitch', clips, aspect: input.aspect ?? '16:9', fps: input.fps ?? 24 })
    if (!out?.url) return { error: String(out?.error || 'Stitch failed') }
    filmUrl = out.url
    durationSec = Number(out.durationSec) || 0
  }

  if (input.music || (input.voice && input.voice.length)) {
    const out = await call({ op: 'mux', videoUrl: filmUrl, music: input.music, voice: input.voice })
    if (!out?.url) return { error: String(out?.error || 'Audio mix failed') }
    filmUrl = out.url
    durationSec = Number(out.durationSec) || durationSec
  }

  // Captions go on LAST: they are burned into the picture, so anything that
  // re-encodes video afterwards would soften them.
  if (Array.isArray(input.captions) && input.captions.length > 0) {
    const out = await call({
      op: 'captions', videoUrl: filmUrl,
      captions: input.captions, position: input.captionPosition,
    })
    if (!out?.url) return { error: String(out?.error || 'Caption burn-in failed') }
    filmUrl = out.url
  }

  ctx.generatedUrls?.push(filmUrl)
  ctx.allowedImages?.add(filmUrl)

  // A cut that came in far under the runtime the user chose is not a finished
  // film, and saying so here is the only check that does not depend on the
  // model noticing. A 6s cut was once delivered against a 60s setting because
  // three of four shots had failed and nothing objected.
  const target = ctx.targetSeconds ?? 0
  const short = target > 0 && durationSec > 0 && durationSec < target * 0.6
  const shortfall = short
    ? ` THIS CUT IS ONLY ${durationSec}s AGAINST A TARGET OF ~${target}s — IT IS NOT THE FINISHED FILM. Shots are missing or failed. Do NOT present it as done: say plainly how short it is and why, then either shoot the missing beats and re-assemble, or ask the user how they want to proceed.`
    : ''

  return {
    mediaUrl: filmUrl,
    durationSec,
    note: `Film assembled (${durationSec}s).${shortfall} It is shown to the user automatically — do not print the URL. Watch the CUT as a whole before calling it done: pacing, grade continuity between shots, and whether the last shot answers the first.`,
  }
}

/** Music or voiceover for the cut. */
export async function executeCreateAudio(
  input: { kind: string; model?: string; prompt?: string; text?: string; duration_sec?: number; voice?: string; video_url?: string },
  ctx: Ctx,
): Promise<{ mediaUrl: string; kind: string; model: string; note: string } | { error: string }> {
  const spec = getAudioModel(input.model, input.kind)
  if (!spec) {
    return { error: `No audio model for kind "${input.kind}". Available: ${AUDIO_MODELS.map(m => `${m.id} (${m.kind})`).join(', ')}` }
  }
  const built = buildAudioCall(spec, input)
  if ('error' in built) return { error: built.error }

  try {
    const { fal } = await import('@fal-ai/client')
    const result = await fal.subscribe(built.endpoint, { input: built.input as any, logs: false })
    const data = result.data as any
    const url: string | undefined =
      data?.audio?.url ?? data?.audio_file?.url ?? data?.video?.url ?? data?.audio_url
    if (!url) return { error: `${spec.label} returned no audio` }

    ctx.generatedUrls?.push(url)
    ctx.allowedImages?.add(url)
    return {
      mediaUrl: url,
      kind: spec.kind,
      model: spec.id,
      note: `${spec.label} produced ${spec.kind}. Mix it over the cut with assemble_film (music/voice), then present the scored film.`,
    }
  } catch (err: any) {
    return { error: `${spec.label} failed: ${String(err?.message || err).slice(0, 300)}` }
  }
}
