import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { uploadToR2 } from '@/lib/r2'
import { get3DModel, THREED_MODELS } from '@/lib/fal-3d-models'
import { canonicalMediaUrl } from '@/lib/media-url'
import { jsonPrivate } from '@/lib/api-json'

/**
 * The 3D suite's submit + list endpoint.
 *
 * 3D jobs are minutes long and the result is a FILE, not a picture, so they do
 * not belong in the image queue: the feed would show a broken thumbnail and
 * the settle path would try to re-host a mesh as a JPEG. They run through
 * fal's own queue and are recorded as GeneratedImage rows carrying
 * videoMetadata.threed — an existing Json column, so no migration — which
 * keeps them out of the picture feeds while still giving them an owner, a
 * prompt and a cost.
 *
 * ADMIN ONLY.
 */

export const runtime = 'nodejs'
export const maxDuration = 300

const TAG = 'threed'

async function admin() {
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  if (!user) return null
  return (await checkIsAdmin(user.email)) ? user : null
}

/** Every url fal hands back for a 3D job, whatever the model calls it. */
function harvest(data: Record<string, any>): { url: string; kind: string }[] {
  const out: { url: string; kind: string }[] = []
  // The SAME file is often reachable under two names — Meshy reports its GLB
  // as both `model_glb` and inside `model_urls`, so a naive push listed it
  // twice and React saw two children with one key. First name wins.
  const seen = new Set<string>()
  const push = (v: unknown, kind: string) => {
    const url = typeof v === 'string' ? v : (v as { url?: string })?.url
    if (typeof url !== 'string' || !url.startsWith('http') || seen.has(url)) return
    seen.add(url)
    out.push({ url, kind })
  }
  // The 3D models disagree completely on field names, so every known shape is
  // checked rather than assuming one house style.
  push(data.model_mesh, 'mesh')
  push(data.pbr_model, 'pbr')
  push(data.base_model, 'base')
  push(data.model_glb, 'glb')
  push(data.model_url, 'mesh')
  push(data.mesh, 'mesh')
  push(data.world_file, 'world')
  push(data.rigged_character_glb, 'rigged-glb')
  push(data.rigged_character_fbx, 'rigged-fbx')
  push(data.animation_glb, 'anim-glb')
  push(data.animation_fbx, 'anim-fbx')
  push(data.fbx_file, 'anim-fbx')
  push(data.motion_json, 'motion')
  // VGGT's fused point cloud is a GLB, so it is genuinely orbitable — it was
  // being dropped on the floor along with every preview image below.
  push(data.point_cloud, 'glb')
  push(data.rendered_image, 'preview')
  push(data.preprocessed_image, 'preview')
  push(data.visualization, 'preview')
  push(data.image, 'preview')
  if (Array.isArray(data.images)) data.images.forEach((i: unknown) => push(i, 'preview'))
  // Per-person meshes (SAM3 body) and Tripo's variant map.
  if (Array.isArray(data.meshes)) data.meshes.forEach((m: unknown) => push(m, 'mesh'))
  if (data.model_urls && typeof data.model_urls === 'object') {
    for (const [name, v] of Object.entries(data.model_urls as Record<string, unknown>)) push(v, name)
  }
  return out
}

/**
 * fal's queue, over plain HTTP.
 *
 * The @fal-ai/client's queue helpers were silently failing for the deep
 * endpoint paths this suite uses — eight jobs all COMPLETED at fal and five
 * sat in 'processing' here forever, because anything that was not a 4xx was
 * treated as transient and retried on the next poll, for ever. fal's REST
 * queue takes the BASE app id ('fal-ai/hunyuan-3d'), not the full model path,
 * which is the same shape the image-queue poller already uses successfully.
 */
function baseApp(endpoint: string): string {
  return endpoint.split('/').slice(0, 2).join('/')
}

async function falStatus(endpoint: string, requestId: string): Promise<string | null> {
  const res = await fetch(`https://queue.fal.run/${baseApp(endpoint)}/requests/${requestId}/status`, {
    headers: { Authorization: `Key ${process.env.FAL_KEY ?? ''}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 404) return 'GONE'
  if (!res.ok) return null
  const d = await res.json().catch(() => ({})) as { status?: string }
  return d.status ?? null
}

/**
 * Read a finished job's result — and, when fal refuses, say why.
 *
 * A rejected job is the confusing case: fal accepts the submit, marks the
 * request COMPLETED, and only fails when the RESULT is read, with a 422 whose
 * body names the field it wanted. Reporting that as "the result could not be
 * read" is what made nine wrong field names look like a stuck queue for an
 * afternoon, so the validation detail is unwrapped into the failure message.
 */
async function falResult(
  endpoint: string,
  requestId: string,
): Promise<{ data: Record<string, any> } | { why: string }> {
  const res = await fetch(`https://queue.fal.run/${baseApp(endpoint)}/requests/${requestId}`, {
    headers: { Authorization: `Key ${process.env.FAL_KEY ?? ''}` },
    signal: AbortSignal.timeout(25_000),
  })
  const body = await res.text().catch(() => '')
  if (res.ok) {
    try {
      return { data: JSON.parse(body) as Record<string, any> }
    } catch {
      return { why: 'fal returned a result that was not JSON' }
    }
  }
  let detail: any = null
  try { detail = (JSON.parse(body) as { detail?: unknown }).detail } catch {}
  if (Array.isArray(detail)) {
    // FastAPI's validation shape: one entry per bad field.
    const parts = detail.map((d: any) => {
      const field = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : '?'
      return `${field}: ${d?.msg ?? d?.type ?? 'invalid'}`
    })
    return { why: `fal rejected the input — ${parts.join('; ')}` }
  }
  const text = typeof detail === 'string' ? detail : body
  return { why: `fal returned ${res.status}${text ? ` — ${text.slice(0, 160)}` : ''}` }
}

/**
 * Settle everything that has finished since the last poll.
 *
 * Runs inside the list call rather than on a timer: the client is already
 * polling to show the queue, so a job settles the moment anyone looks —
 * including on a fresh page load after a refresh.
 *
 * Bounded to four jobs a pass. A settle that walks a dozen finished meshes,
 * downloading each result, outlives the request and gets cut off mid-loop —
 * which is how a queue ends up half-drained. Four settle, the rest go on the
 * next poll six seconds later.
 */
async function settle(userId: number): Promise<void> {
  const running = await prisma.generationQueue.findMany({
    where: { userId, modelType: TAG, status: { in: ['processing', 'queued'] } },
    orderBy: { id: 'asc' },
    select: { id: true, modelId: true, prompt: true, falRequestId: true, parameters: true, createdAt: true },
    take: 4,
  })
  if (running.length === 0) return

  for (const job of running) {
    const params = (job.parameters ?? {}) as Record<string, any>
    const endpoint = String(params.endpoint ?? '')
    const fail = (why: string) => prisma.generationQueue.update({
      where: { id: job.id },
      data: { status: 'failed', errorMessage: why.slice(0, 300), completedAt: new Date() },
    })

    if (!job.falRequestId || !endpoint) { await fail('Submitted without a request id'); continue }

    try {
      const st = await falStatus(endpoint, job.falRequestId)
      if (st === 'GONE') { await fail('fal no longer knows this request'); continue }
      if (st !== 'COMPLETED') {
        // A job fal has never heard finish, an hour on, is not coming back.
        // Without this a transient failure kept a tile spinning for ever.
        if (Date.now() - job.createdAt.getTime() > 60 * 60 * 1000) {
          await fail('Timed out — still not finished after an hour')
        }
        continue
      }

      const got = await falResult(endpoint, job.falRequestId)
      if ('why' in got) { await fail(got.why); continue }
      const result = got.data

      const files = harvest(result)
      if (files.length === 0) {
        // Naming the keys fal DID send is what makes an unknown output shape a
        // five-minute fix instead of a mystery.
        await fail(`Returned no usable file. Keys: ${Object.keys(result).slice(0, 10).join(', ')}`)
        continue
      }

      let preview = files.find(f => f.kind === 'preview')?.url ?? null
      const primary = files.find(f => f.kind !== 'preview')?.url ?? files[0].url

      /*
       * An archive result has its useful picture locked inside it.
       *
       * Hunyuan World ships layered geometry plus the panorama it built, all
       * zipped. Without this the asset lands with nothing to display at all,
       * and a finished world reads as a failure. The archive is never
       * downloaded — see lib/zip-peek — so this costs about 13MB on a 563MB
       * result, and failing at it is never a reason to lose the asset.
       */
      let archive: { name: string; bytes: number }[] | null = null
      let layers: { url: string; role: string; depth: number; label?: string }[] | null = null
      const zipFile = files.find(f => /\.zip(\?|$)/i.test(f.url))
      if (zipFile && !preview) {
        try {
          const { buildWorldLayers, worthParallax } = await import('@/lib/world-layers')
          const built = await buildWorldLayers(zipFile.url)
          archive = built.entries

          if (worthParallax(built.layers)) {
            layers = []
            for (const [i, layer] of built.layers.entries()) {
              const url = await uploadToR2(
                `world-layers/${job.id}-${i}-${layer.role}.webp`,
                layer.webp,
                'image/webp',
              )
              layers.push({ url, role: layer.role, depth: layer.depth, label: layer.label })
            }
          }
          if (built.full) {
            const url = await uploadToR2(`world-preview/${job.id}.png`, built.full, 'image/png')
            files.push({ url, kind: 'preview' })
            preview = url
          }
        } catch (err) {
          console.error('[3d settle] archive peek failed', job.id, String((err as Error)?.message).slice(0, 140))
        }
      }

      await prisma.generatedImage.create({
        data: {
          userId,
          prompt: job.prompt,
          imageUrl: preview ?? primary,
          model: `3d:${job.modelId}`,
          ticketCost: 0,
          referenceImageUrls: Array.isArray(params.referenceImageUrls) ? params.referenceImageUrls : [],
          expiresAt: new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
          falRequestId: job.falRequestId,
          videoMetadata: { [TAG]: { endpoint, preview, files, archive, layers, usd: params.usd ?? null } },
        },
      })
      await prisma.generationQueue.update({
        where: { id: job.id },
        data: { status: 'completed', completedAt: new Date() },
      })
    } catch (err: any) {
      // Network blips are retried; a job older than an hour is given up on by
      // the branch above, so nothing can spin indefinitely.
      console.error('[3d settle]', job.id, String(err?.message || err).slice(0, 200))
    }
  }
}

export async function GET(): Promise<Response> {
  const user = await admin()
  if (!user) return jsonPrivate({ error: 'Admin only' }, { status: 401 })

  await settle(user.id).catch(() => { /* the listing must survive a settle failure */ })

  const jobs = await prisma.generationQueue.findMany({
    where: { userId: user.id, modelType: TAG, status: { in: ['processing', 'queued'] } },
    orderBy: { id: 'desc' },
    take: 12,
    select: { id: true, prompt: true, modelId: true, createdAt: true },
  })
  const failed = await prisma.generationQueue.findMany({
    where: {
      userId: user.id, modelType: TAG, status: 'failed',
      completedAt: { gt: new Date(Date.now() - 6 * 3600 * 1000) },
    },
    orderBy: { id: 'desc' },
    take: 6,
    select: {
      id: true, prompt: true, modelId: true, errorMessage: true,
      createdAt: true, completedAt: true, falRequestId: true, parameters: true,
    },
  })

  const rows = await prisma.generatedImage.findMany({
    where: { userId: user.id, isDeleted: false, model: { startsWith: '3d:' } },
    orderBy: { id: 'desc' },
    take: 60,
    select: {
      id: true, prompt: true, model: true, imageUrl: true,
      createdAt: true, videoMetadata: true, ticketCost: true,
    },
  })
  return jsonPrivate({
    // queuedAt is on all three so the client can lay the strip out in the
    // order things were submitted rather than grouping by state — a tile
    // should not jump position just because it finished.
    jobs: jobs.map(j => ({
      id: j.id, prompt: j.prompt, modelId: j.modelId,
      startedAt: j.createdAt, queuedAt: j.createdAt,
    })),
    failed: failed.map(f => ({
      id: f.id,
      prompt: f.prompt,
      modelId: f.modelId,
      error: f.errorMessage ?? 'Failed',
      queuedAt: f.createdAt,
      failedAt: f.completedAt,
      falRequestId: f.falRequestId,
      endpoint: (f.parameters as any)?.endpoint ?? null,
      // What was actually sent, so a rejection can be read against its input
      // instead of guessed at.
      inputs: (f.parameters as any)?.referenceImageUrls ?? [],
    })),
    assets: rows.map(r => ({
      id: r.id,
      prompt: r.prompt,
      modelId: r.model.replace(/^3d:/, ''),
      preview: (r.videoMetadata as any)?.threed?.preview ?? null,
      files: (r.videoMetadata as any)?.threed?.files ?? [],
      // What is inside a .zip output, read once at extraction time so the UI
      // never has to open a 563MB archive to tell the user what it contains.
      archive: (r.videoMetadata as any)?.threed?.archive ?? null,
      // Flattened plates for the parallax viewer, back to front.
      layers: (r.videoMetadata as any)?.threed?.layers ?? null,
      createdAt: r.createdAt,
      queuedAt: r.createdAt,
    })),
  })
}

export async function POST(req: Request): Promise<Response> {
  const user = await admin()
  if (!user) return jsonPrivate({ error: 'Admin only' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as Record<string, any>
  const spec = get3DModel(String(body.modelId ?? ''))
  if (!spec) {
    return jsonPrivate(
      { error: `Unknown 3D model. Available: ${THREED_MODELS.map(m => m.id).join(', ')}` },
      { status: 400 },
    )
  }

  const prompt = String(body.prompt ?? '').trim()
  const imageUrl = canonicalMediaUrl(String(body.imageUrl ?? '').trim())
  const meshUrl = canonicalMediaUrl(String(body.meshUrl ?? '').trim())
  const imageUrls: string[] = Array.isArray(body.imageUrls)
    ? body.imageUrls
        .filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http'))
        .map(canonicalMediaUrl)
    : []

  // Each family names its inputs differently and there is no house style to
  // infer: Trellis wants image_url, Hunyuan wants input_image_url, Tripo's
  // remesh wants mesh_url, Meshy's rigging wants model_url. Guessing produced
  // the worst possible failure — fal accepted the job, reported it COMPLETED,
  // and only 422'd when the result was read, so a rejected job looked stuck.
  // The names now come from the catalog, where they were read off the schemas.
  const imageField = spec.imageField ?? 'image_url'
  const meshField = spec.meshField ?? 'model_url'

  // The bench always hands over the ref strip as an array, so single-image
  // models take the first of it and multi-image models accept a lone image.
  const oneImage = imageUrl || imageUrls[0] || ''
  const manyImages = imageUrls.length > 0 ? imageUrls : (imageUrl ? [imageUrl] : [])

  const input: Record<string, unknown> = {}
  switch (spec.input) {
    case 'text':
      if (!prompt) return jsonPrivate({ error: `${spec.label} needs a prompt` }, { status: 400 })
      input.prompt = prompt
      break
    case 'image':
      if (!oneImage) return jsonPrivate({ error: `${spec.label} needs an image` }, { status: 400 })
      input[imageField] = oneImage
      break
    case 'images':
      if (manyImages.length === 0) return jsonPrivate({ error: `${spec.label} needs at least one image` }, { status: 400 })
      input[imageField] = imageField.endsWith('s') ? manyImages : manyImages[0]
      break
    case 'mesh':
      if (!meshUrl) return jsonPrivate({ error: `${spec.label} needs an existing 3D model` }, { status: 400 })
      input[meshField] = meshUrl
      break
    case 'image+mesh':
      if (!meshUrl || !oneImage) return jsonPrivate({ error: `${spec.label} needs both a mesh and a reference image` }, { status: 400 })
      input[meshField] = meshUrl
      input[imageField] = oneImage
      break
  }
  // A prompt is optional on several image models and steers the result, so it
  // rides along whenever one was typed and the model has somewhere to put it.
  if (prompt && spec.input !== 'text' && spec.promptField) input[spec.promptField] = prompt
  // Model-specific extras the caller opted into, minus anything that would
  // overwrite the input fields resolved above.
  for (const [k, v] of Object.entries((body.options ?? {}) as Record<string, unknown>)) {
    if (!(k in input) && v !== undefined && v !== '' && v !== null) input[k] = v
  }

  // A few models have required options — Hunyuan World will not run without
  // being told what its two foreground objects are. Refusing here costs
  // nothing; letting it through costs a submit, a wait, and a 422.
  const missing = (spec.controls ?? [])
    .filter(c => c.required && (input[c.key] === undefined || input[c.key] === ''))
    .map(c => c.label)
  if (missing.length > 0) {
    return jsonPrivate(
      { error: `${spec.label} needs ${missing.join(' and ')}` },
      { status: 400 },
    )
  }

  const title = prompt || imageUrl || meshUrl || spec.label

  try {
    const { fal } = await import('@fal-ai/client')
    // SUBMIT, DO NOT SUBSCRIBE. subscribe() holds the connection open until the
    // job finishes, so the whole run belonged to one request: a refresh killed
    // it, while the studio was telling the user that leaving was safe.
    const { request_id } = await fal.queue.submit(spec.endpoint, { input: input as any })

    const job = await prisma.generationQueue.create({
      data: {
        userId: user.id,
        modelId: spec.id,
        modelType: TAG,
        prompt: title,
        status: 'processing',
        ticketCost: 0,
        falRequestId: request_id,
        startedAt: new Date(),
        parameters: {
          source: 'threed',
          endpoint: spec.endpoint,
          modelId: spec.id,
          usd: spec.usd,
          referenceImageUrls: [imageUrl, ...imageUrls].filter(Boolean),
        },
      },
      select: { id: true, createdAt: true },
    })

    return jsonPrivate({
      success: true,
      job: { id: job.id, prompt: title, modelId: spec.id, startedAt: job.createdAt },
    })
  } catch (err: any) {
    return jsonPrivate(
      { error: `${spec.label} could not be submitted: ${String(err?.message || err).slice(0, 300)}` },
      { status: 502 },
    )
  }
}
