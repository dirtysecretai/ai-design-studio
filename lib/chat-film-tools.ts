import { NextRequest } from 'next/server'
import prisma from '@/lib/prisma'
import { getCreateModel } from '@/lib/chat-hub-models'
import { submitChatVideo } from '@/lib/chat-video-submit'
import { checkRefResolution } from '@/lib/video-ref-fit'
import { submitChatImage } from '@/lib/chat-image-submit'
import { AUDIO_MODELS, buildAudioCall, getAudioModel } from '@/lib/audio-models'
import { persistChatGeneration } from '@/lib/chat-hub-create'

// The four tools that turn a shot list into a delivered film. Kept out of
// chat-hub-agent.ts (already ~230KB) and registered there under the
// movie-production skill, which is what stops the other video employees from
// half-using this pipeline.

/**
 * The last unsettled set each chat asked about, so a repeated check with no
 * progress can be refused rather than answered again.
 */
const CHECK_LOOP = new Map<number, { sig: string; at: number }>()

type Ctx = {
  user: { id: number; email: string }
  /** The chat these shots belong to — scopes the duplicate-submit guard. */
  chatId?: number
  attachedImageUrls: string[]
  allowedImages?: Set<string>
  generatedUrls?: string[]
  /** Seconds the finished cut is supposed to run, from the format dropdown. */
  targetSeconds?: number
  /** A hard ticket ceiling the user set. 0 / undefined = no limit. */
  budgetCap?: number
}

export type ShotSpec = {
  n: number
  model: string
  prompt: string
  settings?: Record<string, string>
  reference_image_urls?: string[]
}

/**
 * Every queue id this chat has already submitted, from its own step records.
 * The queue row does not carry a chat id, so the conversation's own history is
 * the authority on which renders belong to it.
 */
async function shotIdsInChat(chatId: number): Promise<number[]> {
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { chatId, role: 'assistant' },
      orderBy: { id: 'desc' },
      take: 40,
      select: { metadata: true },
    })
    const ids = new Set<number>()
    for (const r of rows) {
      const steps = (r.metadata as { agentSteps?: unknown } | null)?.agentSteps
      if (!Array.isArray(steps)) continue
      for (const st of steps as any[]) {
        if (typeof st?.queueId === 'number') ids.add(st.queueId)
        if (Array.isArray(st?.queueIds)) {
          for (const q of st.queueIds) if (typeof q === 'number') ids.add(q)
        }
      }
    }
    return [...ids]
  } catch {
    return []
  }
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
export type PlateSpec = {
  n: number
  model: string
  prompt: string
  settings?: Record<string, string>
  reference_image_urls?: string[]
}

/**
 * Submit several STILLS in one call.
 *
 * create_media waits for its image so the employee can judge it, which is right
 * for one plate and wrong for six: each wait is serial, so a set of plates took
 * as long as the sum of them. This submits them all and returns the queue ids,
 * the same shape render_shots uses \u2014 they settle through film-status and
 * land in the feed together.
 */
export async function executeRenderPlates(
  input: { plates: PlateSpec[]; aspect?: string },
  ctx: Ctx,
): Promise<{ submitted: { n: number; queueId: number; model: string }[]; failed: { n: number; error: string }[]; queueIds?: number[]; note: string } | { error: string }> {
  const plates = Array.isArray(input.plates) ? input.plates.slice(0, 8) : []
  if (plates.length === 0) return { error: 'plates must be a non-empty array' }

  const submitted: { n: number; queueId: number; model: string }[] = []
  const failed: { n: number; error: string }[] = []

  // In PARALLEL: the whole point is that six plates cost one plate's wall time.
  const results = await Promise.all(plates.map(async (plate) => {
    const spec = getCreateModel(plate.model)
    if (!spec || spec.kind !== 'image' || spec.disabled) {
      return { n: plate.n, error: `${plate.model} is not an available image model` } as const
    }
    const refs = allowed(ctx, plate.reference_image_urls).slice(0, spec.maxRefs)
    const settings = {
      ...(plate.settings ?? {}),
      ...(input.aspect ? { aspect: input.aspect } : {}),
    }
    const res = await submitChatImage(spec, plate.prompt, refs, settings, ctx.user.id, { noWait: true })
    if (!res.ok) return { n: plate.n, error: res.error } as const
    return { n: plate.n, queueId: res.queueId ?? 0, model: spec.id } as const
  }))

  for (const r of results) {
    // `error` is only present on the failure shape; narrow explicitly so the
    // success branch keeps its non-optional model/queueId types.
    if ('error' in r) {
      failed.push({ n: r.n, error: String(r.error) })
    } else if (r.queueId > 0) {
      submitted.push({ n: r.n, queueId: r.queueId, model: r.model })
    }
  }
  if (submitted.length === 0) {
    return { error: `No plate could be submitted. ${failed.map(f => `#${f.n}: ${f.error}`).join(' | ')}` }
  }

  return {
    submitted,
    failed,
    queueIds: submitted.map(s => s.queueId),
    note:
      `${submitted.length} plate(s) submitted together and rendering now`
      + `${failed.length ? `; ${failed.length} could not start` : ''}. `
      + `They finish on the server and appear in the user's feed \u2014 do NOT wait here and do NOT re-submit them. `
      + `End the turn; when they land you can judge them and carry on.`,
  }
}


/**
 * Has this film had a storyboard approved?
 *
 * Video costs ten to thirty times what a still does, and until now the user's
 * first look at the film was the assembled cut \u2014 after every one of those
 * renders was paid for. A board of plates is the checkpoint every real
 * production has for exactly this reason: it is the cheapest place to find
 * out the film is wrong.
 */
async function storyboardApproved(chatId: number): Promise<boolean> {
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { chatId, role: 'assistant' },
      orderBy: { id: 'desc' },
      take: 40,
      select: { metadata: true },
    })
    for (const r of rows) {
      const steps = (r.metadata as { agentSteps?: unknown } | null)?.agentSteps
      if (!Array.isArray(steps)) continue
      for (const st of steps as any[]) {
        if (st?.tool === 'present_storyboard' && st.status === 'done') return true
      }
    }
    return false
  } catch {
    // A database hiccup must not become a wall in front of a paid-for run.
    return true
  }
}


/**
 * What this film has spent, in tickets.
 *
 * Refunded work does not count: a failed row has already given the tickets
 * back, so counting it would refuse a run over money nobody was charged.
 */
async function spentOnFilm(chatId: number, userId: number): Promise<number> {
  try {
    const ids = await shotIdsInChat(chatId)
    if (ids.length === 0) return 0
    const jobs = await prisma.generationQueue.findMany({
      where: { id: { in: ids }, userId, status: { notIn: ['failed', 'cancelled'] } },
      select: { ticketCost: true },
    })
    return jobs.reduce((n, j) => n + (j.ticketCost ?? 0), 0)
  } catch {
    return 0
  }
}

export async function executeRenderShots(
  input: { shots: ShotSpec[]; aspect?: string; fps?: number },
  ctx: Ctx,
): Promise<{ submitted: { n: number; queueId: number; model: string }[]; failed: { n: number; error: string }[]; queueIds?: number[]; alreadyRenderingIds?: number[]; note: string } | { error: string }> {
  const shots = Array.isArray(input.shots) ? input.shots.slice(0, 16) : []
  if (shots.length === 0) return { error: 'shots must be a non-empty array' }


  // THE USER'S CEILING. Advice is what the plan already carried; this is the
  // part that cannot be talked past. Checked before the expensive call, not
  // after it.
  if (ctx.chatId && (ctx.budgetCap ?? 0) > 0) {
    const already = await spentOnFilm(ctx.chatId, ctx.user.id)
    if (already >= (ctx.budgetCap as number)) {
      return {
        error:
          `This film has spent ${already} tickets against the ${ctx.budgetCap}-ticket ceiling the user set, so no `
          + `more shots can be rendered. STOP and tell them plainly: what is finished, what is still missing, and `
          + `what it would cost to finish. They can raise the limit in the studio settings if they want to carry on.`,
      }
    }
  }

  // THE STORYBOARD GATE. Nothing expensive happens until the user has seen
  // the film as stills and said yes.
  if (ctx.chatId && !(await storyboardApproved(ctx.chatId))) {
    return {
      error:
        'No storyboard has been approved for this film yet, and video is the expensive part \u2014 ten to thirty times '
        + 'the cost of a still. Render the plates first (render_plates), then call present_storyboard with one frame '
        + 'per shot: the plate url, what happens in the shot, which model will shoot it and how long it runs. The '
        + 'user approves the board and THEN you shoot it. If a plate for a shot genuinely cannot exist \u2014 a pure '
        + 'text-to-video atmosphere shot \u2014 include the frame anyway with plate_url omitted and say why in the '
        + 'description.',
    }
  }

  // HARD GUARD against paying twice for one shot list. The per-shot prompt
  // check below only catches an exact repeat; a re-plan that reworded the
  // shots slipped straight past it and billed a second full batch.
  //
  // Scoped to THIS CHAT. It used to match any video rendering on the account,
  // which meant a brand-new film was refused because shots from a DIFFERENT
  // chat were still in flight — the run made its plates, got refused, and
  // ended with the approved budget unspent. Only shots this conversation
  // actually submitted can be a duplicate of what it is submitting now.
  const ownIds = ctx.chatId ? await shotIdsInChat(ctx.chatId) : null
  const inFlight = (ownIds !== null && ownIds.length === 0)
    ? []
    : await prisma.generationQueue.findMany({
        where: {
          userId: ctx.user.id,
          modelType: 'video',
          status: { in: ['queued', 'processing'] },
          createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
          ...(ownIds ? { id: { in: ownIds } } : {}),
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
      // Deliberately NOT queueIds. Those shots already belong to the step that
      // submitted them, which is tracking them and drawing their placeholders.
      // Handing them back here made a SECOND step adopt the same ids, so four
      // shots drew eight tiles and the settler counted every shot twice.
      alreadyRenderingIds: ids,
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

    // THE START FRAME IS THE FILM'S FIRST FRAME. On an i2v model the leading
    // reference is not a hint, it IS frame one — so a 430x516 phone grab
    // driving a 1080p shot opens the film on an upscaled thumbnail, and every
    // frame chained off it inherits that. Nothing errors, the footage is just
    // soft, which is why this has to be caught here rather than left to taste.
    if (spec.needsRef && refs.length > 0) {
      const verdict = await checkRefResolution(refs[0], settings.resolution ?? settings.quality)
      if (!verdict.ok) {
        failed.push({
          n: shot.n,
          error:
            `start frame is only ${verdict.width}x${verdict.height} — too small to open a `
            + `${settings.resolution ?? settings.quality ?? '1080p'} shot (needs ${verdict.needed}px on the short edge). `
            + `Re-plate this frame at full size first: render it with nano-banana-pro-2 using the low-res picture `
            + `as a likeness reference, or upscale it, then pass THAT plate as the start frame. `
            + `Do not resubmit this shot with the same small image.`,
        })
        continue
      }
    }
    // IDEMPOTENCY. An approval round-trip can replay this call, and the agent
    // re-submits after a pause when it sees no media in the reply yet. Both
    // re-render a shot the user has already paid for.
    //
    // This used to match only jobs still IN FLIGHT, which meant a later pass
    // re-rendered every shot that had already finished — one shot was billed
    // six times that way. A COMPLETED shot with the same model and the same
    // prompt is the same shot: hand it back instead of shooting it again.
    // Any real change to the shot changes its prompt, so a genuine reshoot is
    // never blocked by this.
    const dup = await prisma.generationQueue.findFirst({
      where: {
        userId: ctx.user.id,
        modelId: spec.id,
        prompt: shot.prompt.trim(),
        status: { in: ['queued', 'processing', 'completed'] },
        createdAt: { gt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
        // Only this film's own shots — another production that happens to share
        // a prompt is a different film and must render its own footage.
        ...(ownIds && ownIds.length ? { id: { in: ownIds } } : {}),
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
      `${submitted.length} shot(s) submitted${reused ? ` (${reused} already in flight — reused, not re-paid)` : ''}${failed.length ? `, ${failed.length} rejected — read each rejection and FIX it (a start frame that is too small must be re-plated at full size, not resubmitted)` : ''}. `
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

  // A REPEAT check that found nothing new is a loop. The note below already
  // says "end the turn", and it gets ignored: one run called this twelve times
  // in a row and burned its whole step budget polling. A tool ERROR is the only
  // thing a model reliably stops on, so the second identical check becomes one.
  if (pending > 0 && ctx.chatId) {
    const sig = `${ctx.chatId}:${shots.filter(s => s.status !== 'completed').map(s => s.queueId).sort().join(',')}`
    const seen = CHECK_LOOP.get(ctx.chatId)
    if (seen && seen.sig === sig && Date.now() - seen.at < 10 * 60 * 1000) {
      CHECK_LOOP.delete(ctx.chatId)
      return {
        error:
          `STOP CHECKING — nothing has changed since your last check and ${pending} shot(s) are still rendering. `
          + `Renders finish on the SERVER over several minutes; they cannot complete while you keep calling this. `
          + `END YOUR TURN NOW. You will be continued automatically when the shots land, and you can judge them then.`,
      }
    }
    CHECK_LOOP.set(ctx.chatId, { sig, at: Date.now() })
  } else if (ctx.chatId) {
    CHECK_LOOP.delete(ctx.chatId)
  }

  return {
    shots,
    done: pending === 0,
    note: pending > 0
      ? `${pending} shot(s) still rendering. END THE TURN NOW — do not call check_shots again; they finish on their own and you will be continued.`
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
    clips?: { url: string; trimStart?: number; trimEnd?: number; transition?: { type?: string; durationSec?: number } }[]
    transition?: { type?: string; durationSec?: number }
    video_url?: string
    aspect?: string
    fps?: number
    music?:
      | { url: string; gainDb?: number; fadeOutSec?: number }
      | { url: string; startSec?: number; endSec?: number; gainDb?: number; fadeInSec?: number; fadeOutSec?: number }[]
    voice?: { url: string; atSec?: number; gainDb?: number }[]
    sfx?: { url: string; atSec?: number; gainDb?: number }[]
    captions?: { text: string; startSec: number; endSec: number }[]
    captionPosition?: string
    omitted?: { queueId: number; reason: string }[]
    short_ok?: { reason: string }
  },
  ctx: Ctx,
): Promise<{ mediaUrl: string; durationSec: number; note: string } | { error: string }> {
  // DO NOT CUT WHILE THE FILM IS STILL SHOOTING. One run assembled a 4-second
  // single-clip "film" while the rest of its shots were still rendering — the
  // footage existed minutes later and was never used. Assembling early wastes
  // the shots that had not landed and presents a fragment as the deliverable.
  if (ctx.chatId && Array.isArray(input.clips) && input.clips.length > 0) {
    const own = await shotIdsInChat(ctx.chatId)
    if (own.length) {
      const stillGoing = await prisma.generationQueue.count({
        where: {
          id: { in: own },
          // VIDEO only: a still that has not landed does not stop a cut, and
          // blocking on one would deadlock the film behind a stuck plate.
          modelType: 'video',
          status: { in: ['queued', 'processing'] },
          // And only recent work — an abandoned row from hours ago is not a
          // reason to refuse forever.
          createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
        },
      })
      if (stillGoing > 0) {
        return {
          error:
            `${stillGoing} shot(s) from this film are STILL RENDERING — assembling now would cut a fragment and `
            + `throw away footage the user has already paid for. END THE TURN and wait: you are continued automatically `
            + `when they land, and you can assemble the complete film then.`,
        }
      }
    }
  }

  // AND DO NOT CUT WITHOUT THE FOOTAGE. The shooting guard above only stops a
  // cut while shots are IN FLIGHT. The other half of the same failure is a cut
  // made from SOME of the shots after they have all landed: a 30s film went out
  // against a 60s setting with the remaining shots sitting finished and unused.
  //
  // Leaving a shot out is a legitimate editorial call, so it is allowed — but
  // it has to be SAID. Anything landed, not in the cut and not listed in
  // `omitted` is an oversight, and this is the only place that can catch it.
  if (ctx.chatId && Array.isArray(input.clips) && input.clips.length > 0) {
    const own = await shotIdsInChat(ctx.chatId)
    if (own.length) {
      const landed = await prisma.generationQueue.findMany({
        where: { id: { in: own }, modelType: 'video', status: 'completed' },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      const named = new Set((input.omitted ?? []).map(o => Number(o.queueId)))
      const unaccounted = landed.length - input.clips.length - named.size
      if (unaccounted > 0) {
        const ids = landed.map(l => l.id).filter(id => !named.has(id))
        return {
          error:
            `${landed.length} shots have landed but this cut uses only ${input.clips.length}`
            + `${named.size ? ` (${named.size} deliberately omitted)` : ''} — ${unaccounted} shot(s) are unaccounted for, `
            + `and the user paid for every one. Queue ids that landed: ${ids.slice(0, 24).join(', ')}. `
            + `Either put the missing shots in the cut, or pass them in "omitted" with a real reason each `
            + `("take is soft", "duplicates shot 4"). Run check_shots first if you are not sure which URL is which shot.`,
        }
      }
    }
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

  let filmUrl = typeof input.video_url === 'string' ? input.video_url : ''
  let durationSec = 0

  if (!filmUrl) {
    const clips = (input.clips ?? [])
      .map(c => (typeof c === 'string' ? { url: c } : c))
      .filter(c => c && typeof c.url === 'string')
    if (clips.length === 0) return { error: 'Pass clips (the shot URLs in cut order) or video_url (an existing cut to score)' }
    const out = await call({
      op: 'stitch', clips,
      aspect: input.aspect ?? '16:9',
      fps: input.fps ?? 24,
      ...(input.transition ? { transition: input.transition } : {}),
    })
    if (!out?.url) return { error: String(out?.error || 'Stitch failed') }
    filmUrl = out.url
    durationSec = Number(out.durationSec) || 0
  }

  let musicWarning = ''
  const musicCues = Array.isArray(input.music) ? input.music : input.music ? [input.music] : []
  if (musicCues.length > 0 || input.voice?.length || input.sfx?.length) {
    const out = await call({
      op: 'mux', videoUrl: filmUrl,
      music: musicCues, voice: input.voice, sfx: input.sfx,
    })
    if (!out?.url) return { error: String(out?.error || 'Audio mix failed') }
    filmUrl = out.url
    durationSec = Number(out.durationSec) || durationSec
    // A music model returns the length it returns, which is often shorter than
    // the cue that asked for it. Silence the user did not ask for is the most
    // common way a finished film sounds broken, so the shortfall is reported
    // rather than left to be discovered on playback.
    const covered = Number(out.musicCoverSec) || 0
    if (musicCues.length > 0 && durationSec > 0 && covered < durationSec * 0.5) {
      musicWarning =
        ` WARNING: music covers only ${Math.round(covered)}s of a ${Math.round(durationSec)}s film, so most of it `
        + `plays without a bed. Either the cues were written short or the generated audio came back shorter than `
        + `asked for. Unless the silence is deliberate, generate more music and re-mix: a bed that stops halfway `
        + `and leaves nothing behind it reads as a broken export, not as a choice.`
    }
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

  // THE RUNTIME IS THE SPEC. The user picked a length from a dropdown; a cut
  // that comes in at half of it is not a shorter film, it is an unfinished
  // one. This used to warn under 60% and only refuse under 40%, so a 29s cut
  // against a 60s target sailed through with a note the model then ignored.
  //
  // The bar is 85%, and the refusal does the arithmetic rather than leaving
  // "make it longer" as an exercise. Deliberately shipping short is still
  // possible — the user may have ASKED for it — but it costs an explicit
  // short_ok with a reason, the same way dropping footage costs an omitted.
  const target = ctx.targetSeconds ?? 0
  const reason = String(input.short_ok?.reason ?? '').trim()
  if (target > 0 && durationSec > 0 && durationSec < target * 0.85 && !reason) {
    const missing = Math.round(target - durationSec)
    return {
      error:
        `This cut runs ${durationSec}s against the ${target}s the user set — about ${missing}s short. `
        + `That is not a shorter film, it is an unfinished one, and shipping it is the single most common way `
        + `a production disappoints. Close the gap: `
        + `(a) if shots have landed that are not in this cut, put them in — that is free; `
        + `(b) otherwise shoot roughly ${Math.max(1, Math.ceil(missing / 6))} more shot(s) of about 5-8s that the story `
        + `actually needs, then assemble again. `
        + `Only if the user has explicitly asked for a shorter film, pass short_ok with their reason.`,
    }
  }
  const shortfall = reason
    ? ` Delivered ${durationSec}s against a ${target}s target, short by agreement: "${reason.slice(0, 200)}". Say so plainly to the user.`
    : ''

  // THE CUT IS THE DELIVERABLE, so it belongs in the feed with everything
  // else the user generated. Only the individual SHOTS were landing there —
  // each one has a queue row that settles into a GeneratedImage — while the
  // film those shots exist to make had no row at all and lived only inside
  // the workspace. Every assemble writes its own row, so a re-cut after an
  // edit arrives as a new video rather than replacing the one before it.
  let title = 'Final cut'
  if (ctx.chatId) {
    try {
      const chat = await prisma.chat.findFirst({
        where: { id: ctx.chatId, userId: ctx.user.id },
        select: { title: true },
      })
      if (chat?.title?.trim()) title = chat.title.trim()
    } catch { /* the row is worth writing even without the name */ }
  }
  try {
    await persistChatGeneration({
      userId: ctx.user.id,
      prompt: `${title} — final cut (${durationSec}s)`,
      mediaUrl: filmUrl,
      modelId: 'movie-studio',
      kind: 'video',
      // ffmpeg, not a model: the shots were charged for individually and the
      // cut must not look like it cost anything on top.
      ticketCost: 0,
      settings: {
        duration: String(durationSec),
        ...(input.aspect ? { aspect: input.aspect } : {}),
      },
    })
  } catch (err) {
    // A feed row is not worth losing a finished film over.
    console.error('film feed row failed:', err)
  }

  return {
    mediaUrl: filmUrl,
    durationSec,
    note: `Film assembled (${durationSec}s) and saved to the user's video feed.${shortfall}${musicWarning} It is shown to the user automatically — do not print the URL. Watch the CUT as a whole before calling it done: pacing, grade continuity between shots, and whether the last shot answers the first.`,
  }
}


/**
 * Relight a still, with a model built for it.
 *
 * Prompting an image model to "relight this" works, but it re-generates the
 * picture and the likeness drifts with it. IC-Light is a dedicated relighting
 * pass: it keeps the subject and replaces the light, which is the difference
 * between fixing a plate and shooting a new one.
 *
 * STILLS ONLY. There is no video relighting model here, so this has to happen
 * BEFORE a plate becomes a start frame \u2014 every frame of the shot that follows
 * inherits whatever light this leaves behind.
 */
export async function executeRelight(
  input: { image_url: string; prompt: string; direction?: string; negative_prompt?: string },
  ctx: Ctx,
): Promise<{ mediaUrl: string; note: string } | { error: string }> {
  const url = String(input.image_url ?? '')
  if (!url.startsWith('https://')) return { error: 'image_url must be an image from this conversation' }
  if (ctx.allowedImages && !ctx.allowedImages.has(url)) {
    return { error: 'That image is not from this conversation \u2014 relight one of the stills you have made or been given' }
  }
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt) {
    return { error: 'prompt must describe the NEW light: direction, quality, colour temperature and where the shadows fall' }
  }
  const DIRS = new Set(['None', 'Left', 'Right', 'Top', 'Bottom'])
  const dir = DIRS.has(String(input.direction)) ? String(input.direction) : 'None'

  try {
    const { fal } = await import('@fal-ai/client')
    const result = await fal.subscribe('fal-ai/iclight-v2', {
      input: {
        image_url: url,
        prompt,
        initial_latent: dir,
        ...(input.negative_prompt ? { negative_prompt: String(input.negative_prompt) } : {}),
        enable_safety_checker: false,
        num_images: 1,
      } as any,
      logs: false,
    })
    const data = result.data as any
    const out: string | undefined = data?.images?.[0]?.url
    if (!out) return { error: 'IC-Light returned no image' }

    ctx.generatedUrls?.push(out)
    ctx.allowedImages?.add(out)
    return {
      mediaUrl: out,
      note:
        'Relit. This is now the plate to shoot from \u2014 pass THIS url as the start frame, not the original, or the '
        + 'shot keeps the old light. Check the likeness against the character references before you build on it.',
    }
  } catch (err: any) {
    return { error: `Relight failed: ${String(err?.message || err).slice(0, 300)}` }
  }
}


/**
 * Relight FINISHED footage.
 *
 * The rule used to be "fix the light on the still, because once a clip is
 * rendered its light is fixed" \u2014 true of every model in the catalog, and no
 * longer true of the catalog. Light-X relights a video, so a grade mismatch
 * discovered in the cut costs one pass instead of a reshoot.
 *
 * It is NOT cheap: fal prices it per second of OUTPUT, so relighting a whole
 * film costs more than most of the shots in it. Relight the shot that is
 * wrong, not the film.
 */
export async function executeRelightVideo(
  input: { video_url: string; prompt?: string; direction?: string; reference_image_url?: string; mode?: string },
  ctx: Ctx,
): Promise<{ mediaUrl: string; note: string } | { error: string }> {
  const url = String(input.video_url ?? '')
  if (!url.startsWith('https://')) return { error: 'video_url must be a clip from this conversation' }
  if (ctx.allowedImages && !ctx.allowedImages.has(url)) {
    return { error: 'That clip is not from this conversation' }
  }
  const MODES = new Set(['ic', 'ref', 'hdr', 'bg'])
  const mode = MODES.has(String(input.mode)) ? String(input.mode) : 'ic'
  if ((mode === 'ref' || mode === 'hdr' || mode === 'bg') && !input.reference_image_url) {
    return { error: `relight mode '${mode}' needs reference_image_url \u2014 use mode 'ic' to relight from a description alone` }
  }
  const DIRS = new Set(['Left', 'Right', 'Top', 'Bottom'])
  const dir = DIRS.has(String(input.direction)) ? String(input.direction) : 'Left'
  const prompt = String(input.prompt ?? '').trim()

  try {
    const { fal } = await import('@fal-ai/client')
    const result = await fal.subscribe('fal-ai/lightx/relight', {
      input: {
        video_url: url,
        relit_cond_type: mode,
        ...(prompt ? { prompt } : {}),
        ...(input.reference_image_url ? { relit_cond_img_url: input.reference_image_url } : {}),
        // Only 'ic' reads these, and it is the mode that works from a
        // description rather than a conditioning image.
        ...(mode === 'ic'
          ? { relight_parameters: { bg_source: dir, relight_prompt: prompt || 'natural light', use_sky_mask: false } }
          : {}),
      } as any,
      logs: false,
    })
    const out: string | undefined = (result.data as any)?.video?.url
    if (!out) return { error: 'Light-X returned no video' }
    ctx.generatedUrls?.push(out)
    ctx.allowedImages?.add(out)
    return {
      mediaUrl: out,
      note:
        'Relit clip. Use THIS url in the cut in place of the original. It is priced per second of output, so relight '
        + 'the shots that are wrong rather than the whole film.',
    }
  } catch (err: any) {
    return { error: `Video relight failed: ${String(err?.message || err).slice(0, 300)}` }
  }
}

/**
 * Re-shoot an existing clip on a new camera move.
 *
 * The move a video model gave you is the move you got \u2014 until now. Light-X
 * ReCamera re-renders the same footage along a different camera path, which
 * turns a static take into a push, or gives you a second angle on a shot you
 * cannot re-render without losing the likeness. Same per-second pricing as the
 * relight, so it is a deliberate choice rather than a default.
 */
export async function executeRecamera(
  input: { video_url: string; mode?: string; prompt?: string },
  ctx: Ctx,
): Promise<{ mediaUrl: string; note: string } | { error: string }> {
  const url = String(input.video_url ?? '')
  if (!url.startsWith('https://')) return { error: 'video_url must be a clip from this conversation' }
  if (ctx.allowedImages && !ctx.allowedImages.has(url)) {
    return { error: 'That clip is not from this conversation' }
  }
  const MODES = new Set(['gradual', 'bullet', 'direct', 'dolly-zoom'])
  const mode = MODES.has(String(input.mode)) ? String(input.mode) : 'gradual'
  const prompt = String(input.prompt ?? '').trim()

  try {
    const { fal } = await import('@fal-ai/client')
    const result = await fal.subscribe('fal-ai/lightx/recamera', {
      input: {
        video_url: url,
        camera: 'traj',
        mode,
        ...(prompt ? { prompt } : {}),
      } as any,
      logs: false,
    })
    const out: string | undefined = (result.data as any)?.video?.url
    if (!out) return { error: 'ReCamera returned no video' }
    ctx.generatedUrls?.push(out)
    ctx.allowedImages?.add(out)
    return {
      mediaUrl: out,
      note: 'New camera move on the same footage. Cut THIS in place of the original if it plays better.',
    }
  } catch (err: any) {
    return { error: `ReCamera failed: ${String(err?.message || err).slice(0, 300)}` }
  }
}

/** Music or voiceover for the cut. */
export async function executeCreateAudio(
  input: { kind: string; model?: string; prompt?: string; text?: string; duration_sec?: number; voice?: string; video_url?: string },
  ctx: Ctx,
): Promise<{ mediaUrl: string; kind: string; model: string; note: string } | { error: string }> {
  // Two sfx models with opposite requirements: one scores a clip, the other
  // invents a standalone sound. With no explicit id, the presence of a clip is
  // the only honest signal for which one was meant.
  const wanted = input.model
    ?? (input.kind === 'sfx' ? (input.video_url ? 'mmaudio-v2' : 'sonilo-sfx') : undefined)
  const spec = getAudioModel(wanted, input.kind)
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
