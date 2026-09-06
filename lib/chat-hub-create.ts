import { fal } from '@/lib/fal-client'
import { uploadToR2 } from '@/lib/r2'
import type { ChatCreateSettings } from '@/lib/chat-hub-models'

fal.config({ credentials: process.env.FAL_KEY })

// ── Size maps copied from the portal's generate routes ──────────────────────
const SEEDREAM_SIZES: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 }, '4:5': { width: 896, height: 1152 },
  '3:4': { width: 896, height: 1152 },  '2:3': { width: 896, height: 1344 },
  '9:16': { width: 768, height: 1344 }, '16:9': { width: 1344, height: 768 },
  '3:2': { width: 1344, height: 896 },  '4:3': { width: 1152, height: 896 },
  '21:9': { width: 1536, height: 640 },
}
const FLUX2_SIZE_ENUM: Record<string, string> = {
  '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:5': 'portrait_4_3',
}
const WAN27_SIZE_ENUM: Record<string, string> = {
  '1:1': 'square_hd', '4:3': 'landscape_4_3', '16:9': 'landscape_16_9',
  '3:4': 'portrait_4_3', '9:16': 'portrait_16_9',
}
const FLUX1_SIZES: Record<string, Record<string, { width: number; height: number }>> = {
  '1k': { '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1280, height: 720 }, '9:16': { width: 720, height: 1280 }, '4:3': { width: 1024, height: 768 }, '3:4': { width: 768, height: 1024 } },
  '2k': { '1:1': { width: 1920, height: 1920 }, '16:9': { width: 1920, height: 1080 }, '9:16': { width: 1080, height: 1920 }, '4:3': { width: 1920, height: 1440 }, '3:4': { width: 1440, height: 1920 } },
  '4k': { '1:1': { width: 2560, height: 2560 }, '16:9': { width: 2560, height: 1440 }, '9:16': { width: 1440, height: 2560 }, '4:3': { width: 2560, height: 1920 }, '3:4': { width: 1920, height: 2560 } },
}
const ZIMAGE_SIZES: Record<string, { w: number; h: number }> = {
  '1:1': { w: 1024, h: 1024 }, '16:9': { w: 1280, h: 720 }, '9:16': { w: 720, h: 1280 },
  '4:3': { w: 1024, h: 768 }, '3:4': { w: 768, h: 1024 }, '4:5': { w: 896, h: 1120 },
}

// Endpoints + inputs copied from the portal's own generate routes, with the
// chosen per-model settings applied (aspect / quality / duration / audio…).
export function buildFalCall(modelId: string, prompt: string, refs: string[], s: ChatCreateSettings):
  { endpoint: string; input: Record<string, unknown> } | { error: string } {
  const hasRefs = refs.length > 0
  switch (modelId) {
    // ── Gemini family (FAL-hosted) ───────────────────────────────────────
    case 'nano-banana-pro':
      return {
        endpoint: hasRefs ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro',
        input: {
          prompt, resolution: s.quality === '4k' ? '4K' : '2K', aspect_ratio: s.aspect,
          output_format: 'png', num_images: 1, safety_tolerance: 6, enable_safety_checker: false,
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    case 'nano-banana-pro-2':
      return {
        endpoint: hasRefs ? 'fal-ai/nano-banana-2/edit' : 'fal-ai/nano-banana-2',
        input: {
          prompt, num_images: 1, aspect_ratio: s.aspect, output_format: 'png',
          safety_tolerance: '6', resolution: (s.quality ?? '2k').toUpperCase(),
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    // ── Kling images ─────────────────────────────────────────────────────
    case 'kling-image-v3':
      return {
        endpoint: hasRefs ? 'fal-ai/kling-image/v3/image-to-image' : 'fal-ai/kling-image/v3/text-to-image',
        input: {
          prompt, num_images: 1, aspect_ratio: s.aspect, output_format: 'png',
          resolution: s.quality ?? '2k',
          ...(hasRefs ? { image_url: refs[0] } : {}),
        },
      }
    case 'kling-o3-image':
      return {
        endpoint: hasRefs ? 'fal-ai/kling-image/o3/image-to-image' : 'fal-ai/kling-image/o3/text-to-image',
        input: {
          prompt, num_images: 1, resolution: (s.quality ?? '2k').toUpperCase(),
          ...(s.aspect && s.aspect !== 'auto' ? { aspect_ratio: s.aspect } : {}),
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    // ── ByteDance images ─────────────────────────────────────────────────
    case 'seedream-4.5': {
      const base = SEEDREAM_SIZES[s.aspect] ?? SEEDREAM_SIZES['1:1']
      const mult = s.quality === '4k' ? 2 : 1
      return {
        endpoint: hasRefs ? 'fal-ai/bytedance/seedream/v4.5/edit' : 'fal-ai/bytedance/seedream/v4.5/text-to-image',
        input: {
          prompt, image_size: { width: base.width * mult, height: base.height * mult },
          num_images: 1, max_images: 1, enable_safety_checker: false,
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    }
    case 'seedream-5-lite':
      return {
        endpoint: hasRefs ? 'fal-ai/bytedance/seedream/v5/lite/edit' : 'fal-ai/bytedance/seedream/v5/lite/text-to-image',
        input: {
          prompt, enable_safety_checker: false,
          // 2k = FAL's auto_2K default (omit); 3k = explicit 3072px
          ...(s.quality === '3k' ? { image_size: { width: 3072, height: 3072 } } : {}),
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    case 'seedream-5-pro':
      // Pro documents the bare `bytedance/` owner prefix — the recent-model
      // pattern (seedance-2.0, gemini-omni-flash); it is a separate model from
      // v5 Lite, whose older fal-ai/ path is not a template. 2K only.
      return {
        endpoint: hasRefs ? 'bytedance/seedream/v5/pro/edit' : 'bytedance/seedream/v5/pro/text-to-image',
        input: {
          prompt, enable_safety_checker: false,
          ...(hasRefs ? { image_urls: refs.slice(0, 10) } : {}),
        },
      }
    // ── Recraft ──────────────────────────────────────────────────────────
    case 'recraft-v4.1': {
      // t2i only — fal has no v4.1 image-to-image (404 as of 2026-07) and
      // v4.1 dropped the style parameter
      const RECRAFT_SIZE: Record<string, string> = {
        '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3',
        '16:9': 'landscape_16_9', '9:16': 'portrait_16_9',
      }
      return {
        endpoint: 'fal-ai/recraft/v4.1/text-to-image',
        input: {
          prompt, image_size: RECRAFT_SIZE[s.aspect] ?? 'square_hd', enable_safety_checker: false,
        },
      }
    }
    // ── Wan image ────────────────────────────────────────────────────────
    case 'wan-2.7-pro':
      return {
        endpoint: hasRefs ? 'fal-ai/wan/v2.7/pro/edit' : 'fal-ai/wan/v2.7/pro/text-to-image',
        input: {
          prompt, image_size: WAN27_SIZE_ENUM[s.aspect] ?? 'square_hd', num_images: 1,
          ...(hasRefs ? { image_urls: refs } : {}),
        },
      }
    // ── Black Forest Labs ────────────────────────────────────────────────
    case 'flux-1-dev': {
      if (hasRefs) {
        return {
          endpoint: 'fal-ai/flux-1/dev/image-to-image',
          input: {
            prompt, image_url: refs[0], strength: 0.95,
            num_images: 1, output_format: 'png', enable_safety_checker: false,
          },
        }
      }
      const tier = FLUX1_SIZES[s.quality ?? '2k'] ?? FLUX1_SIZES['2k']
      return {
        endpoint: 'fal-ai/flux-1/dev',
        input: {
          prompt, image_size: tier[s.aspect] ?? tier['1:1'],
          num_inference_steps: 40, guidance_scale: 3.5, num_images: 1,
          enable_safety_checker: false, output_format: 'png', acceleration: 'regular',
        },
      }
    }
    case 'flux-2':
      return {
        endpoint: hasRefs ? 'fal-ai/flux-2/edit' : 'fal-ai/flux-2',
        input: {
          prompt, image_size: FLUX2_SIZE_ENUM[s.aspect] ?? 'square_hd',
          num_images: 1, output_format: 'png', enable_safety_checker: false,
          guidance_scale: 2.5, num_inference_steps: 28,
          ...(hasRefs ? { image_urls: refs.slice(0, 4) } : {}),
        },
      }
    // ── OpenAI ───────────────────────────────────────────────────────────
    case 'gpt-image-2': {
      const quality = s.quality ?? 'medium'
      if (hasRefs) {
        return {
          endpoint: 'openai/gpt-image-2/edit',
          input: { prompt, image_urls: refs.slice(0, 8), quality },
        }
      }
      const [w, h] = (s.aspect ?? '1024x1024').split('x').map(n => parseInt(n))
      return {
        endpoint: 'fal-ai/gpt-image-2',
        input: { prompt, quality, width: w || 1024, height: h || 1024, n: 1 },
      }
    }
    // ── Z-Image ──────────────────────────────────────────────────────────
    case 'z-image-base':
    case 'z-image-turbo': {
      const dims = ZIMAGE_SIZES[s.aspect] ?? ZIMAGE_SIZES['1:1']
      const mult = s.quality === '4k' ? 4 : s.quality === '2k' ? 2 : 1
      const size = { width: dims.w * mult, height: dims.h * mult }
      if (modelId === 'z-image-turbo' && hasRefs) {
        return {
          endpoint: 'fal-ai/z-image/turbo/image-to-image',
          input: {
            prompt, image_url: refs[0], strength: 0.6, image_size: size,
            enable_safety_checker: false, acceleration: 'regular', output_format: 'png', num_images: 1,
          },
        }
      }
      return {
        endpoint: modelId === 'z-image-turbo' ? 'fal-ai/z-image/turbo' : 'fal-ai/z-image/base',
        input: {
          prompt, image_size: size,
          enable_safety_checker: false, acceleration: 'regular', output_format: 'png', num_images: 1,
        },
      }
    }
    // ── Video ────────────────────────────────────────────────────────────
    case 'kling-v3':
      if (!hasRefs) return { error: 'Kling 3.0 needs a reference image attached (image-to-video model)' }
      return {
        endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
        input: {
          prompt, start_image_url: refs[0], duration: s.duration ?? '5',
          aspect_ratio: s.aspect ?? '16:9', generate_audio: s.audio === 'on',
          // Second ref = end frame (controlled start→end shot)
          ...(refs[1] ? { end_image_url: refs[1] } : {}),
        },
      }
    case 'seedance-1.5':
      return {
        endpoint: hasRefs
          ? 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video'
          : 'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
        input: {
          prompt, aspect_ratio: s.aspect ?? '16:9', resolution: s.resolution ?? '720p',
          duration: s.duration ?? '5', generate_audio: s.audio === 'on', enable_safety_checker: false,
          ...(hasRefs ? { image_url: refs[0] } : {}),
          // Second ref = end frame (matches the portal's video route)
          ...(refs[1] ? { end_image_url: refs[1] } : {}),
        },
      }
    case 'seedance-2.0':
    case 'seedance-2.0-fast': {
      // Refs are plain REFERENCES (reference-to-video): the prompt decides how
      // each image is used ("open on image 1", style match, character…) — no
      // start/end-frame mechanics. 0 refs = text-to-video.
      // NOTE: SD 2.0 is published under the `bytedance` owner — a `fal-ai/`
      // prefix 404s ("Path /seedance-2.0/... not found"), verified live.
      const base = modelId === 'seedance-2.0-fast'
        ? 'bytedance/seedance-2.0/fast'
        : 'bytedance/seedance-2.0'
      const sd20Base: Record<string, unknown> = {
        prompt, resolution: s.resolution ?? '720p',
        generate_audio: s.audio === 'on', enable_safety_checker: false,
        ...(s.duration && s.duration !== 'auto' ? { duration: s.duration } : {}),
        ...(s.aspect && s.aspect !== 'auto' ? { aspect_ratio: s.aspect } : {}),
      }
      if (refs.length >= 1) {
        // r2v accepts up to 9 images, addressed in the prompt as @Image1…@Image9
        return { endpoint: `${base}/reference-to-video`, input: { ...sd20Base, image_urls: refs.slice(0, 9) } }
      }
      return { endpoint: `${base}/text-to-video`, input: sd20Base }
    }
    case 'gemini-omni-flash': {
      // ADMIN ONLY. Google multimodal video — published under the `google`
      // owner (no fal-ai/ prefix, same as bytedance/seedance-2.0).
      // 0 refs → t2v · 1 ref → true start-frame i2v · 2+ refs → r2v with
      // <IMAGE_REF_0>… tags (0-indexed). Schema: integer duration 3-10,
      // aspect_ratio 16:9|9:16 ONLY — no resolution/audio/safety keys.
      // (The edit/video-to-video variant is portal-only: create_media has no
      // video input.)
      const omniBase: Record<string, unknown> = {
        prompt,
        duration: parseInt(s.duration ?? '8') || 8,
        aspect_ratio: s.aspect === '9:16' ? '9:16' : '16:9',
      }
      if (refs.length >= 2) {
        return { endpoint: 'google/gemini-omni-flash/reference-to-video', input: { ...omniBase, image_urls: refs.slice(0, 9) } }
      }
      if (refs.length === 1) {
        return { endpoint: 'google/gemini-omni-flash/image-to-video', input: { ...omniBase, image_url: refs[0] } }
      }
      return { endpoint: 'google/gemini-omni-flash', input: omniBase }
    }
    case 'wan-2.5':
      if (!hasRefs) return { error: 'Wan 2.5 needs a reference image attached (image-to-video model)' }
      return {
        endpoint: 'fal-ai/wan-25-preview/image-to-video',
        input: {
          prompt, image_url: refs[0], resolution: s.resolution ?? '720p', duration: s.duration ?? '5',
          enable_prompt_expansion: true, enable_safety_checker: false,
        },
      }
    case 'happy-horse':
      if (!hasRefs) return { error: 'Happy Horse needs a reference image attached (image-to-video model)' }
      return {
        endpoint: 'alibaba/happy-horse/image-to-video',
        input: {
          prompt, image_url: refs[0], resolution: s.resolution ?? '720p',
          duration: parseInt(s.duration ?? '5') || 5, enable_safety_checker: false,
        },
      }
    default:
      return { error: 'Unknown create model' }
  }
}

// Flash Scanner v2.5 / Pro Scanner v3 — raw Gemini API instead of FAL.
// Mirrors the GEMINI PROVIDER branch of app/api/generate: refs as inlineData,
// image comes back as base64 and is re-hosted on R2.
export async function generateWithGeminiApi(
  apiModel: string, prompt: string, refs: string[], s: ChatCreateSettings,
): Promise<{ url: string } | { error: string }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { error: 'GEMINI_API_KEY is not configured' }

  const contentParts: any[] = []
  for (const refUrl of refs) {
    try {
      const res = await fetch(refUrl)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      contentParts.push({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } })
    } catch { /* skip unfetchable ref */ }
  }
  const qualityInstructions = s.quality === '4k'
    ? 'Generate in ultra-high resolution 4K quality with maximum detail and clarity. '
    : ''
  contentParts.push({ text: `${qualityInstructions}Aspect ratio must be ${s.aspect ?? '1:1'}. ${prompt}` })

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${key}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: contentParts }],
      generationConfig: { temperature: 1.0, topP: 0.95, topK: 40 },
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (response.status === 429) return { error: 'Daily quota exceeded for this scanner — try again tomorrow or use NanoBanana Pro' }
    return { error: `Gemini API error ${response.status}: ${text.slice(0, 150)}` }
  }
  const data = await response.json()
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  let imageBase64: string | undefined
  let refusalText = ''
  for (const part of parts) {
    if (part.inlineData?.data) { imageBase64 = part.inlineData.data; break }
    if (part.text) refusalText = part.text
  }
  if (!imageBase64) {
    return { error: refusalText ? `Model returned text instead of an image: ${refusalText.slice(0, 150)}` : 'No image in response' }
  }
  const url = await uploadToR2(`chat-hub-gemini-${Date.now()}.png`, Buffer.from(imageBase64, 'base64'), 'image/png')
  return { url }
}

// ── Session-feed sync ────────────────────────────────────────────────────────
// Chat generations also land in the user's main portal feed (GeneratedImage).
// Images are re-hosted on R2 for durability (FAL URLs are temporary); the
// returned URL replaces the FAL one everywhere. Videos keep their FAL URL
// (same as the video pipeline) with videoMetadata for feed detection.
export async function persistChatGeneration(opts: {
  userId: number
  prompt: string
  mediaUrl: string
  modelId: string
  kind: 'image' | 'video'
  settings: Record<string, string>
  ticketCost: number
  referenceImageUrls?: string[]
}): Promise<string> {
  let finalUrl = opts.mediaUrl
  if (opts.kind === 'image' && !opts.mediaUrl.includes('.r2.dev/')) {
    try {
      const res = await fetch(opts.mediaUrl)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const ct = res.headers.get('content-type') ?? 'image/png'
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
        finalUrl = await uploadToR2(`chat-gen-${opts.userId}-${Date.now()}.${ext}`, buf, ct)
      }
    } catch (err) {
      console.error('chat-gen R2 rehost failed (keeping FAL URL):', err)
    }
  }
  try {
    const { default: prisma } = await import('@/lib/prisma')
    await prisma.generatedImage.create({
      data: {
        userId: opts.userId,
        prompt: opts.prompt,
        imageUrl: finalUrl,
        model: opts.modelId,
        ticketCost: opts.ticketCost,
        referenceImageUrls: opts.referenceImageUrls ?? [],
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        quality: opts.settings.quality ?? opts.settings.resolution ?? null,
        aspectRatio: opts.settings.aspect ?? null,
        ...(opts.kind === 'video'
          ? { videoMetadata: { isVideo: true, duration: opts.settings.duration ?? null } }
          : {}),
      },
    })
  } catch (err) {
    console.error('chat feed sync error:', err)
  }
  return finalUrl
}
