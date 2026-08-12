import { NextResponse } from 'next/server'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { checkIsAdmin } from '@/lib/admin-check'
import { uploadToR2 } from '@/lib/r2'

const RUNPOD_API   = 'https://api.runpod.ai/v2'
const COMFYUI_URL  = 'http://localhost:8188'
// Local 22GB BF16 checkpoints run with CPU offload on a 16GB GPU — minutes per
// image, so give the poll plenty of headroom
const POLL_TIMEOUT = 600_000

// Upload a data-URL image into ComfyUI's input folder; returns the stored filename
async function uploadToComfy(dataUrl: string, name: string): Promise<string> {
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
  if (!m) throw new Error('Invalid image data URL')
  const buf = Buffer.from(m[2], 'base64')
  const fd = new FormData()
  fd.append('image', new Blob([new Uint8Array(buf)], { type: `image/${m[1]}` }), name)
  fd.append('overwrite', 'true')
  const res = await fetch(`${COMFYUI_URL}/upload/image`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`ComfyUI image upload failed (${res.status})`)
  const j = await res.json() as { name: string }
  return j.name
}

type LocalImageMode = 'img2img' | 'kontext' | 'fill' | 'inpaint'

// Build a ComfyUI API-format workflow for Flux + optional LoRAs.
// Image modes (local): img2img (any ckpt), kontext (ReferenceLatent edit),
// fill (InpaintModelConditioning), inpaint (SetLatentNoiseMask on a plain ckpt).
function buildFluxWorkflow(opts: {
  checkpoint: string
  loras: Array<{ name: string; strength: number }>
  prompt: string
  width: number
  height: number
  steps: number
  guidance: number
  seed: number
  image?: string      // ComfyUI input filename (from uploadToComfy)
  mask?: string       // ComfyUI input filename — white = regenerate
  imageMode?: LocalImageMode
  denoise?: number
}): Record<string, unknown> {
  const { checkpoint, loras, prompt, width, height, steps, guidance, seed } = opts
  const nodes: Record<string, unknown> = {}
  let nextId = 1
  const add = (class_type: string, inputs: Record<string, unknown>): string => {
    const id = String(nextId++)
    nodes[id] = { class_type, inputs }
    return id
  }

  const ckptId = add('CheckpointLoaderSimple', { ckpt_name: checkpoint })
  let modelRef: [string, number] = [ckptId, 0]
  let clipRef:  [string, number] = [ckptId, 1]
  const vaeRef: [string, number] = [ckptId, 2]
  for (const lora of loras) {
    const lid = add('LoraLoader', {
      model: modelRef, clip: clipRef, lora_name: lora.name,
      strength_model: lora.strength, strength_clip: lora.strength,
    })
    modelRef = [lid, 0]
    clipRef  = [lid, 1]
  }

  const posId = add('CLIPTextEncode', { clip: clipRef, text: prompt })
  const negId = add('CLIPTextEncode', { clip: clipRef, text: '' })

  let posRef: [string, number]
  let negRef: [string, number] = [negId, 0]
  let latentRef: [string, number]
  let denoise = 1.0

  if (opts.image && opts.imageMode === 'kontext') {
    // Kontext edit: reference image conditions the generation (official graph:
    // CLIPTextEncode → ReferenceLatent → FluxGuidance), full denoise
    const loadId  = add('LoadImage', { image: opts.image })
    const scaleId = add('FluxKontextImageScale', { image: [loadId, 0] })
    const encId   = add('VAEEncode', { pixels: [scaleId, 0], vae: vaeRef })
    const refId   = add('ReferenceLatent', { conditioning: [posId, 0], latent: [encId, 0] })
    posRef    = [add('FluxGuidance', { conditioning: [refId, 0], guidance }), 0]
    latentRef = [encId, 0]
  } else if (opts.image && opts.mask && opts.imageMode === 'fill') {
    // Flux Fill inpaint: model sees the full image with the masked region noised
    const loadId = add('LoadImage', { image: opts.image })
    const maskLd = add('LoadImage', { image: opts.mask })
    const i2m    = add('ImageToMask', { image: [maskLd, 0], channel: 'red' })
    const guide  = add('FluxGuidance', { conditioning: [posId, 0], guidance })
    const cond   = add('InpaintModelConditioning', {
      positive: [guide, 0], negative: [negId, 0], vae: vaeRef,
      pixels: [loadId, 0], mask: [i2m, 0], noise_mask: true,
    })
    posRef    = [cond, 0]
    negRef    = [cond, 1]
    latentRef = [cond, 2]
  } else if (opts.image && opts.mask && opts.imageMode === 'inpaint') {
    // Non-Fill checkpoint inpaint: partial denoise restricted by a latent mask
    const loadId = add('LoadImage', { image: opts.image })
    const maskLd = add('LoadImage', { image: opts.mask })
    const i2m    = add('ImageToMask', { image: [maskLd, 0], channel: 'red' })
    const encId  = add('VAEEncode', { pixels: [loadId, 0], vae: vaeRef })
    const nm     = add('SetLatentNoiseMask', { samples: [encId, 0], mask: [i2m, 0] })
    posRef    = [add('FluxGuidance', { conditioning: [posId, 0], guidance }), 0]
    latentRef = [nm, 0]
    denoise   = opts.denoise ?? 0.85
  } else if (opts.image && opts.imageMode === 'img2img') {
    const loadId = add('LoadImage', { image: opts.image })
    const encId  = add('VAEEncode', { pixels: [loadId, 0], vae: vaeRef })
    posRef    = [add('FluxGuidance', { conditioning: [posId, 0], guidance }), 0]
    latentRef = [encId, 0]
    denoise   = opts.denoise ?? 0.65
  } else {
    posRef    = [add('FluxGuidance', { conditioning: [posId, 0], guidance }), 0]
    latentRef = [add('EmptyLatentImage', { width, height, batch_size: 1 }), 0]
  }

  const sampId = add('KSampler', {
    model: modelRef, positive: posRef, negative: negRef, latent_image: latentRef,
    seed, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise,
  })
  const vaeId = add('VAEDecode', { samples: [sampId, 0], vae: vaeRef })
  add('SaveImage', { images: [vaeId, 0], filename_prefix: `flux_custom_${Date.now()}` })

  return nodes
}

// Poll ComfyUI history until the prompt completes or times out
async function pollComfyHistory(promptId: string): Promise<{ filename: string; subfolder: string } | null> {
  const deadline = Date.now() + POLL_TIMEOUT
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const res = await fetch(`${COMFYUI_URL}/history/${promptId}`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const data = await res.json() as Record<string, unknown>
      const entry = data[promptId] as Record<string, unknown> | undefined
      if (!entry) continue
      // outputs are present when done
      const outputs = entry.outputs as Record<string, { images?: Array<{ filename: string; subfolder: string }> }> | undefined
      if (!outputs) continue
      for (const nodeOut of Object.values(outputs)) {
        if (nodeOut.images?.length) return nodeOut.images[0]
      }
    } catch { /* keep polling */ }
  }
  return null
}

export async function POST(req: Request) {
  // Require admin password header OR a session belonging to an admin email
  const adminPass = process.env.ADMIN_PASSWORD
  const hasAdminPass = adminPass && req.headers.get('x-admin-password') === adminPass
  if (!hasAdminPass) {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    const sessionUser = token ? await getUserFromSession(token) : null
    // checkIsAdmin = the AdminAccount table (canonical admin list), NOT
    // ticket-gate's isAdminEmail (that list only decides who generates free)
    if (!sessionUser || !await checkIsAdmin(sessionUser.email ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let body: {
    mode: 'local' | 'runpod'
    prompt: string
    checkpoint: string
    loras: Array<{ name?: string; r2_key?: string; strength: number }>
    width?: number
    height?: number
    steps?: number
    guidance?: number
    seed?: number | null
    sampler?: string
    negative_prompt?: string
    true_cfg?: number
    refine?: boolean
    refine_strength?: number
    upscale?: string
    upscale_strength?: number
    adetailer?: boolean
    adetailer_strength?: number
    color_contrast?: number
    color_saturation?: number
    color_s_curve?: number
    ip_adapter_images?: string[]
    ip_adapter_scale?: number
    img2img_image?: string
    img2img_strength?: number
    esrgan_model?: string
    combo_order?: string
    gfpgan?: boolean
    gfpgan_weight?: number
    pipeline_steps?: Array<{ type: string; upscale_factor?: number; strength?: number; model?: string; target_px?: number }>
    controlnet?: boolean
    controlnet_conditions?: Array<{ mode: string; scale: number; image: string }>
    inpaint_image?: string
    inpaint_mask?: string
    inpaint_strength?: number
    use_flux_fill?: boolean
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { mode, prompt, checkpoint, loras = [], width = 1024, height = 1024, steps = 20, guidance = 3.5 } = body
  const seed = (body.seed == null || body.seed === -1) ? Math.floor(Math.random() * 2 ** 32) : body.seed

  // ── RunPod mode ─────────────────────────────────────────────────────────────
  if (mode === 'runpod') {
    const endpointId = process.env.RUNPOD_ENDPOINT_ID
    const apiKey     = process.env.RUNPOD_API_KEY
    if (!endpointId || !apiKey)
      return NextResponse.json({ error: 'RunPod not configured' }, { status: 500 })

    const payload = {
      action:            'inference',
      prompt,
      checkpoint_r2_key: checkpoint,
      loras: loras.map(l => ({ r2_key: l.r2_key ?? l.name, strength: l.strength })),
      width, height, steps, guidance, seed,
      sampler:           body.sampler           ?? 'euler',
      negative_prompt:   body.negative_prompt   ?? '',
      true_cfg:          body.true_cfg          ?? 4.0,
      refine:            body.refine            ?? false,
      refine_strength:   body.refine_strength   ?? 0.3,
      upscale:           body.upscale           ?? 'none',
      upscale_strength:  body.upscale_strength  ?? 0.3,
      adetailer:         body.adetailer         ?? false,
      adetailer_strength: body.adetailer_strength ?? 0.35,
      color_contrast:    body.color_contrast    ?? 1.0,
      color_saturation:  body.color_saturation  ?? 1.0,
      color_s_curve:     body.color_s_curve     ?? 0.0,
      ip_adapter_images: body.ip_adapter_images ?? [],
      ip_adapter_scale:  body.ip_adapter_scale  ?? 0.6,
      img2img_image:     body.img2img_image     ?? '',
      img2img_strength:  body.img2img_strength  ?? 0.65,
      esrgan_model:      body.esrgan_model      ?? 'x4plus',
      combo_order:       body.combo_order       ?? 'flux-first',
      gfpgan:            body.gfpgan            ?? false,
      gfpgan_weight:     body.gfpgan_weight     ?? 0.8,
      pipeline_steps:    body.pipeline_steps    ?? [],
      controlnet:             body.controlnet             ?? false,
      controlnet_conditions:  body.controlnet_conditions  ?? [],
      inpaint_image:          body.inpaint_image          ?? '',
      inpaint_mask:           body.inpaint_mask           ?? '',
      inpaint_strength:       body.inpaint_strength       ?? 0.85,
      use_flux_fill:          body.use_flux_fill          ?? false,
    }

    const res = await fetch(`${RUNPOD_API}/${endpointId}/run`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // executionTimeout OVERRIDES the endpoint's default (600s!) per job —
      // 8K pipeline chains run 15-40+ min and were being killed mid-ESRGAN
      // ("job timed out after 1 retries" at exactly ~603s execution)
      body:    JSON.stringify({ input: payload, policy: { executionTimeout: 2 * 60 * 60 * 1000 } }),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `RunPod error: ${err}` }, { status: res.status })
    }
    const data = await res.json() as { id: string }

    // METADATA SIDECAR — the DB row used to be written only by the browser when
    // its poller saw "completed". Close the tab, sleep the phone, or switch
    // devices and the finished image was orphaned in R2 forever. Writing the
    // prompt + settings here lets /reconcile rebuild the row server-side from
    // the deterministic output key, with no browser involved.
    try {
      await uploadToR2(
        `inference/meta/${data.id}.json`,
        Buffer.from(JSON.stringify({
          jobId:      data.id,
          prompt:     body.prompt ?? '',
          createdAt:  new Date().toISOString(),
          seed,
          width, height,
          checkpoint: body.checkpoint ?? '',
          loras:      loras.map(l => ({ key: l.r2_key ?? l.name, strength: l.strength })),
          steps:      body.steps, guidance: body.guidance,
          sampler:    body.sampler, upscale: body.upscale,
          pipeline_steps: body.pipeline_steps ?? [],
          adetailer:  body.adetailer, adetailer_strength: body.adetailer_strength,
          img2img:    !!body.img2img_image, img2img_strength: body.img2img_strength,
        })),
        'application/json',
      )
    } catch (e) {
      console.error('[flux/generate] sidecar write failed (non-fatal):', e)
    }

    // Return the resolved seed so the client can record it (a -1/"random"
    // request gets its actual value here) — enables exact rescan later
    return NextResponse.json({ mode: 'runpod', job_id: data.id, seed })
  }

  // ── Local (ComfyUI) mode ────────────────────────────────────────────────────
  // Image inputs: upload to ComfyUI first, then wire into the matching workflow.
  // Kontext checkpoints use the ReferenceLatent edit graph; Fill checkpoints get
  // native inpaint conditioning; anything else falls back to plain i2i/inpaint.
  let localImage: string | undefined
  let localMask: string | undefined
  let localImageMode: LocalImageMode | undefined
  let localDenoise: number | undefined
  try {
    if (body.inpaint_image && body.inpaint_mask) {
      localImage = await uploadToComfy(body.inpaint_image, `pv2-inpaint-${Date.now()}.png`)
      localMask  = await uploadToComfy(body.inpaint_mask,  `pv2-mask-${Date.now()}.png`)
      localImageMode = body.use_flux_fill ? 'fill' : 'inpaint'
      localDenoise   = body.inpaint_strength ?? 0.85
    } else if (body.img2img_image) {
      localImage = await uploadToComfy(body.img2img_image, `pv2-i2i-${Date.now()}.png`)
      localImageMode = /kontext/i.test(checkpoint) ? 'kontext' : 'img2img'
      localDenoise   = body.img2img_strength ?? 0.65
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Image upload to ComfyUI failed' },
      { status: 502 },
    )
  }

  const workflow = buildFluxWorkflow({
    checkpoint,
    loras: loras.map(l => ({ name: l.name ?? '', strength: l.strength })),
    prompt, width, height, steps, guidance, seed,
    image: localImage, mask: localMask, imageMode: localImageMode, denoise: localDenoise,
  })

  let promptRes: Response
  try {
    promptRes = await fetch(`${COMFYUI_URL}/prompt`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt: workflow }),
      signal:  AbortSignal.timeout(10_000),
    })
  } catch {
    return NextResponse.json({ error: 'ComfyUI is not running (localhost:8188 unreachable)' }, { status: 503 })
  }

  if (!promptRes.ok) {
    const txt = await promptRes.text()
    return NextResponse.json({ error: `ComfyUI rejected workflow: ${txt}` }, { status: 502 })
  }

  const { prompt_id: promptId } = await promptRes.json() as { prompt_id: string }

  // Poll for completion
  const imgInfo = await pollComfyHistory(promptId)
  if (!imgInfo) return NextResponse.json({ error: 'ComfyUI timed out — generation took too long' }, { status: 504 })

  // Fetch the image bytes from ComfyUI
  const viewUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder)}&type=output`
  const imgRes  = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) })
  if (!imgRes.ok) return NextResponse.json({ error: 'Failed to fetch image from ComfyUI' }, { status: 502 })

  const buf     = Buffer.from(await imgRes.arrayBuffer())
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`

  return NextResponse.json({ mode: 'local', image_data_url: dataUrl, seed })
}
