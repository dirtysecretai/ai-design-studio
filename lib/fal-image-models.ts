/**
 * fal.ai image-model registry (2026-08 batch).
 *
 * Every input shape here was verified against the live OpenAPI schema at
 *   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 * (components.schemas.*Input). Enum values are model-specific — they are NOT
 * interchangeable between models. If you change anything in this file, re-run
 * scripts/verify-fal-image-models.mjs before deploying: a wrong key is a paid
 * 422 for the account owner.
 *
 * These models are ADMIN-ONLY while under test; the gate lives in
 * app/api/generate/route.ts (ADMIN_ONLY_IMAGE_MODELS).
 */

export interface FalImageBuildContext {
  /** User prompt (already trimmed). May be '' for promptless models. */
  prompt: string
  /** Portal aspect ratio, e.g. '16:9'. Mapped per model to that model's enum. */
  aspectRatio: string
  /** Portal quality tier: '1k' | '2k' | '4k' (anything else is treated as 1k). */
  quality: string
  /** fal-hosted URLs for the user's reference / input images, in order. */
  imageUrls: string[]
  /** Raw request body — per-model knobs are read from here (all optional). */
  options: Record<string, any>
}

export interface FalImageModelSpec {
  /**
   * Sibling spec to run instead when the request carries reference images.
   * These families ship text-to-image and edit as separate fal endpoints; the
   * portal exposes ONE model and picks by what the user attached, the way
   * NanoBanana already behaves.
   */
  editVariant?: string
  /** App-side model id (matches config/ai-models.config.ts `id`). */
  id: string
  /** fal endpoint id passed to fal.queue.submit(). */
  endpoint: string
  /** Endpoint cannot run without at least one input image. */
  needsImage: boolean
  /** fal input field the input image(s) land in (null = none). */
  imageParam: 'image_url' | 'image_urls' | 'person_image_url' | null
  /** Max input images the endpoint accepts. */
  maxInputImages: number
  /** Endpoint has no prompt-ish field, or the prompt is optional. */
  promptRequired: boolean
  /** Aspect ratio enum this model accepts (null = model has no aspect_ratio). */
  aspectRatios: string[] | null
  /** True when the model takes width/height via `image_size` instead. */
  usesImageSize: boolean
  /** Schema minLength on `prompt` (fal 422s below this). */
  promptMin?: number
  /** Schema maxLength on `prompt` — the builder truncates rather than 422s. */
  promptMax?: number
  /** Human note surfaced in the report / UI. */
  notes?: string
  build(ctx: FalImageBuildContext): Record<string, any>
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns `value` when it is a member of `allowed`, otherwise `fallback`. */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** Clamped number, or `undefined` when the caller didn't supply one. */
function num(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/** Clamped integer, or `undefined`. */
function int(value: unknown, min: number, max: number): number | undefined {
  const n = num(value, min, max)
  return n === undefined ? undefined : Math.round(n)
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Drops keys whose value is undefined so we never send `"key": undefined`. */
function compact<T extends Record<string, any>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k]
  return obj
}

const BASE_DIMS: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 896],
  '3:4': [896, 1152],
  '3:2': [1216, 832],
  '2:3': [832, 1216],
  '4:5': [896, 1120],
  '5:4': [1120, 896],
  '21:9': [1536, 640],
  '9:21': [640, 1536],
  '2:1': [1408, 704],
  '1:2': [704, 1408],
}

/**
 * Portal aspect ratio + quality tier → an explicit {width,height} for models
 * whose `image_size` accepts a custom object. `maxDim` keeps us inside each
 * provider's practical ceiling (the schema cap of 14142 is not a real limit).
 */
function imageSize(aspectRatio: string, quality: string, maxDim = 2048): { width: number; height: number } {
  const [bw, bh] = BASE_DIMS[aspectRatio] ?? BASE_DIMS['1:1']
  const mult = quality === '4k' ? 3 : quality === '2k' ? 2 : 1
  let w = bw * mult
  let h = bh * mult
  const scale = Math.min(1, maxDim / Math.max(w, h))
  w = Math.max(256, Math.round((w * scale) / 16) * 16)
  h = Math.max(256, Math.round((h * scale) / 16) * 16)
  return { width: w, height: h }
}

/** Truncates to the schema's maxLength; returns undefined for empty input. */
function clip(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined
  const t = text.slice(0, max)
  return t.length > 0 ? t : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// enum tables (verified per endpoint — do not share between models)
// ─────────────────────────────────────────────────────────────────────────────

const AR_REVE = ['4:1', '3:1', '21:9', '2:1', '17:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '1:2', '1:3', '1:4', 'auto'] as const
const AR_MAI = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const
const AR_GROK_T2I = ['2:1', '20:9', '19.5:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:19.5', '9:20', '1:2'] as const
const AR_GROK_EDIT = ['auto', ...AR_GROK_T2I] as const
const AR_MUSE = ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'] as const
const AR_BRIA = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const
const AR_NB2 = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'] as const
const AR_NB2_LITE = ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'] as const

const TOPAZ_PRECISION_MODELS = ['Standard V2', 'High Fidelity V3', 'High Fidelity V2', 'Low Resolution V2', 'CGI', 'Text Refine'] as const
const TOPAZ_CREATIVE_MODELS = ['Bloom 2', 'Bloom', 'Bloom Realism'] as const
const TOPAZ_GENERATIVE_MODELS = ['Wonder 3.5', 'Wonder 3', 'Wonder 2', 'Wonder', 'Recover 3', 'Standard MAX', 'Redefine', 'Recovery V2', 'Recovery'] as const
const TOPAZ_ADJUST_MODELS = ['Adjust V2', 'White Balance', 'Colorize'] as const
const TOPAZ_SHARPEN_MODELS = ['Standard', 'Strong', 'Lens Blur V2', 'Motion Blur', 'Natural', 'Refocus', 'Wildlife', 'Portrait', 'Auto Sharpen', 'Super Focus V3', 'Super Focus V2'] as const
const TOPAZ_DENOISE_MODELS = ['Normal', 'Strong', 'Extreme', 'Denoise Max'] as const
const TOPAZ_RESTORE_MODELS = ['Recover 3', 'Dust-Scratch V2'] as const
const TOPAZ_SUBJECT_DETECTION = ['All', 'Foreground', 'Background'] as const
const TOPAZ_OUTPUT_FORMATS = ['jpeg', 'png'] as const

/** Shared knobs for the simple single-image Topaz endpoints. */
function topazSimple<T extends string>(models: readonly T[], fallback: T) {
  return (ctx: FalImageBuildContext) =>
    compact({
      image_url: ctx.imageUrls[0],
      model: pickEnum(ctx.options.topazModel, models, fallback),
      output_format: pickEnum(ctx.options.topazOutputFormat, TOPAZ_OUTPUT_FORMATS, 'png'),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// registry
// ─────────────────────────────────────────────────────────────────────────────

export const FAL_IMAGE_MODELS: Record<string, FalImageModelSpec> = {
  // ── Qwen Image 3 ───────────────────────────────────────────────────────────
  'qwen-image-3': {
    id: 'qwen-image-3',
    editVariant: 'qwen-image-3-edit',
    promptMin: 1,
    promptMax: 5000,
    endpoint: 'alibaba/qwen-image-3/text-to-image',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: null,
    usesImageSize: true,
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        image_size: imageSize(ctx.aspectRatio, ctx.quality, 4096),
        num_images: 1,
        output_format: 'png',
        enable_safety_checker: false,
        enable_prompt_expansion: bool(ctx.options.qwenPromptExpansion) ?? true,
        negative_prompt: clip(ctx.options.qwenNegativePrompt, 500),
      }),
  },
  'qwen-image-3-edit': {
    id: 'qwen-image-3-edit',
    promptMin: 1,
    promptMax: 5000,
    endpoint: 'alibaba/qwen-image-3/edit',
    needsImage: true,
    imageParam: 'image_urls',
    maxInputImages: 6,
    promptRequired: true,
    aspectRatios: null,
    usesImageSize: true,
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        image_urls: ctx.imageUrls,
        image_size: imageSize(ctx.aspectRatio, ctx.quality, 4096),
        num_images: 1,
        output_format: 'png',
        enable_safety_checker: false,
        enable_prompt_expansion: bool(ctx.options.qwenPromptExpansion) ?? true,
        negative_prompt: clip(ctx.options.qwenNegativePrompt, 500),
      }),
  },

  // ── Reve 2.1 ───────────────────────────────────────────────────────────────
  'reve-2.1': {
    id: 'reve-2.1',
    editVariant: 'reve-2.1-edit',
    promptMin: 1,
    promptMax: 4000,
    endpoint: 'reve/2.1/text-to-image',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_REVE],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_REVE, 'auto'),
      num_images: 1,
      output_format: 'png',
    }),
  },
  'reve-2.1-edit': {
    id: 'reve-2.1-edit',
    promptMin: 1,
    promptMax: 4000,
    endpoint: 'reve/2.1/edit',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: true,
    aspectRatios: [...AR_REVE],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_url: ctx.imageUrls[0],
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_REVE, 'auto'),
      num_images: 1,
      output_format: 'png',
    }),
  },

  // ── Microsoft MAI Image 2.5 Pro ────────────────────────────────────────────
  'mai-image-2.5-pro': {
    id: 'mai-image-2.5-pro',
    editVariant: 'mai-image-2.5-pro-edit',
    promptMin: 3,
    promptMax: 5000,
    endpoint: 'microsoft/mai-image-2.5-pro',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_MAI],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_MAI, 'auto'),
      output_format: 'png',
      num_images: 1,
    }),
  },
  'mai-image-2.5-pro-edit': {
    id: 'mai-image-2.5-pro-edit',
    promptMin: 3,
    promptMax: 5000,
    endpoint: 'microsoft/mai-image-2.5-pro/edit',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: true,
    aspectRatios: [...AR_MAI],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_url: ctx.imageUrls[0],
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_MAI, 'auto'),
      output_format: 'png',
      num_images: 1,
    }),
  },

  // ── xAI Grok Imagine 2 ─────────────────────────────────────────────────────
  'grok-imagine-2': {
    id: 'grok-imagine-2',
    editVariant: 'grok-imagine-2-edit',
    promptMin: 1,
    promptMax: 8000,
    endpoint: 'xai/grok-imagine-image/v2.0/text-to-image',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_GROK_T2I],
    usesImageSize: false,
    notes: 'resolution 1k|2k; quality knob is low|medium (grokQuality)',
    build: (ctx) => ({
      prompt: ctx.prompt,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_GROK_T2I, '1:1'),
      resolution: ctx.quality === '1k' ? '1k' : '2k',
      quality: pickEnum(ctx.options.grokQuality, ['low', 'medium'] as const, 'medium'),
      num_images: 1,
      output_format: 'png',
    }),
  },
  'grok-imagine-2-edit': {
    id: 'grok-imagine-2-edit',
    promptMin: 1,
    promptMax: 8000,
    endpoint: 'xai/grok-imagine-image/v2.0/edit',
    needsImage: true,
    imageParam: 'image_urls',
    maxInputImages: 4,
    promptRequired: true,
    aspectRatios: [...AR_GROK_EDIT],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_urls: ctx.imageUrls,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_GROK_EDIT, 'auto'),
      resolution: ctx.quality === '1k' ? '1k' : '2k',
      quality: pickEnum(ctx.options.grokQuality, ['low', 'medium'] as const, 'medium'),
      num_images: 1,
      output_format: 'png',
    }),
  },

  // ── Meta Muse ──────────────────────────────────────────────────────────────
  'meta-muse': {
    id: 'meta-muse',
    editVariant: 'meta-muse-edit',
    promptMin: 1,
    promptMax: 20000,
    endpoint: 'meta/muse-image/text-to-image',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_MUSE],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_MUSE, '1:1'),
      num_images: 1,
      output_format: 'png',
    }),
  },
  'meta-muse-edit': {
    id: 'meta-muse-edit',
    promptMin: 1,
    promptMax: 20000,
    endpoint: 'meta/muse-image/edit',
    needsImage: true,
    imageParam: 'image_urls',
    maxInputImages: 10,
    promptRequired: true,
    aspectRatios: [...AR_MUSE],
    usesImageSize: false,
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_urls: ctx.imageUrls,
      aspect_ratio: pickEnum(ctx.aspectRatio, AR_MUSE, '1:1'),
      num_images: 1,
      output_format: 'png',
    }),
  },

  // ── Bria FIBO 1.5 ──────────────────────────────────────────────────────────
  'bria-fibo': {
    id: 'bria-fibo',
    editVariant: 'bria-fibo-edit',
    endpoint: 'bria/fibo-gen-1.5/text-to-image',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_BRIA],
    usesImageSize: false,
    notes: 'resolution is 1MP|4MP; style_preset No Style|Photoreal',
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        aspect_ratio: pickEnum(ctx.aspectRatio, AR_BRIA, '1:1'),
        resolution: ctx.quality === '1k' ? '1MP' : '4MP',
        style_preset: pickEnum(ctx.options.briaStylePreset, ['No Style', 'Photoreal'] as const, 'No Style'),
        seed: int(ctx.options.briaSeed, 0, 2_147_483_647),
      }),
  },
  'bria-fibo-edit': {
    id: 'bria-fibo-edit',
    endpoint: 'bria/fibo-edit-1.5/edit',
    needsImage: true,
    imageParam: 'image_urls',
    maxInputImages: 10,
    promptRequired: true,
    aspectRatios: [...AR_BRIA],
    usesImageSize: false,
    notes: 'prompt field is `instruction`, NOT `prompt`; no output_format/num_images',
    build: (ctx) =>
      compact({
        instruction: ctx.prompt,
        image_urls: ctx.imageUrls,
        aspect_ratio: pickEnum(ctx.aspectRatio, AR_BRIA, '1:1'),
        mask_url: typeof ctx.options.briaMaskUrl === 'string' ? ctx.options.briaMaskUrl : undefined,
        seed: int(ctx.options.briaSeed, 0, 2_147_483_647),
      }),
  },

  // ── Ideogram v4 ────────────────────────────────────────────────────────────
  'ideogram-v4-instant': {
    id: 'ideogram-v4-instant',
    promptMin: 1,
    promptMax: 10000,
    endpoint: 'ideogram/v4/instant',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: null,
    usesImageSize: true,
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_size: imageSize(ctx.aspectRatio, ctx.quality, 2048),
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: false,
      expansion_model: pickEnum(ctx.options.ideogramExpansionModel, ['None', 'Medium'] as const, 'Medium'),
    }),
  },
  'ideogram-v4-fast': {
    id: 'ideogram-v4-fast',
    promptMin: 1,
    promptMax: 10000,
    endpoint: 'ideogram/v4/fast',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: null,
    usesImageSize: true,
    notes: 'adds rendering_speed TURBO|BALANCED|QUALITY',
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_size: imageSize(ctx.aspectRatio, ctx.quality, 2048),
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: false,
      expansion_model: pickEnum(ctx.options.ideogramExpansionModel, ['None', 'Medium'] as const, 'Medium'),
      rendering_speed: pickEnum(ctx.options.ideogramRenderingSpeed, ['TURBO', 'BALANCED', 'QUALITY'] as const, 'BALANCED'),
    }),
  },

  // ── Google NanoBanana Pro 2 ───────────────────────────────────────────────
  // A real spec rather than a hand-rolled branch, so everything that speaks
  // "fal image model" can drive it: server-side batches, /api/generate's own
  // fal path, and the chat hub. resolution is a STRING enum, and so is
  // safety_tolerance (verified against fal's OpenAPI for this endpoint).
  'nano-banana-pro-2': {
    id: 'nano-banana-pro-2',
    editVariant: 'nano-banana-pro-2-edit',
    promptMin: 1,
    promptMax: 50000,
    endpoint: 'fal-ai/nano-banana-2',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_NB2],
    usesImageSize: false,
    notes: 'resolution and safety_tolerance are STRING enums',
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        aspect_ratio: pickEnum(ctx.aspectRatio, AR_NB2, 'auto'),
        resolution: ctx.quality === '4k' ? '4K' : ctx.quality === '1k' ? '1K' : '2K',
        output_format: 'png',
        num_images: 1,
        safety_tolerance: '6',
        enable_web_search: true,
      }),
  },
  'nano-banana-pro-2-edit': {
    id: 'nano-banana-pro-2-edit',
    promptMin: 1,
    promptMax: 50000,
    endpoint: 'fal-ai/nano-banana-2/edit',
    needsImage: true,
    imageParam: 'image_urls',
    maxInputImages: 14,
    promptRequired: true,
    aspectRatios: [...AR_NB2],
    usesImageSize: false,
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        image_urls: ctx.imageUrls,
        aspect_ratio: pickEnum(ctx.aspectRatio, AR_NB2, 'auto'),
        resolution: ctx.quality === '4k' ? '4K' : ctx.quality === '1k' ? '1K' : '2K',
        output_format: 'png',
        num_images: 1,
        safety_tolerance: '6',
        enable_web_search: true,
      }),
  },

  // ── Google NanoBanana 2 Lite ───────────────────────────────────────────────
  'nano-banana-2-lite': {
    id: 'nano-banana-2-lite',
    promptMin: 3,
    promptMax: 50000,
    endpoint: 'google/nano-banana-2-lite',
    needsImage: false,
    imageParam: null,
    maxInputImages: 0,
    promptRequired: true,
    aspectRatios: [...AR_NB2_LITE],
    usesImageSize: false,
    notes: 'safety_tolerance is a STRING enum "1".."6"',
    build: (ctx) =>
      compact({
        prompt: ctx.prompt,
        aspect_ratio: pickEnum(ctx.aspectRatio, AR_NB2_LITE, 'auto'),
        output_format: 'png',
        num_images: 1,
        safety_tolerance: pickEnum(
          typeof ctx.options.nb2LiteSafetyTolerance === 'number'
            ? String(ctx.options.nb2LiteSafetyTolerance)
            : ctx.options.nb2LiteSafetyTolerance,
          ['1', '2', '3', '4', '5', '6'] as const,
          '6',
        ),
        limit_generations: bool(ctx.options.nb2LiteLimitGenerations) ?? true,
        thinking_level:
          ctx.options.nb2LiteThinking === 'minimal' || ctx.options.nb2LiteThinking === 'high'
            ? ctx.options.nb2LiteThinking
            : undefined,
      }),
  },

  // ── Recraft v4 style / vector ──────────────────────────────────────────────
  'recraft-v4-style': recraftSpec('recraft-v4-style', 'recraft/v4/style/text-to-image'),
  'recraft-v4-style-pro': recraftSpec('recraft-v4-style-pro', 'recraft/v4/style/pro/text-to-image'),
  'recraft-v4-vector': recraftSpec('recraft-v4-vector', 'recraft/v4/style/text-to-vector'),
  'recraft-v4-vector-pro': recraftSpec('recraft-v4-vector-pro', 'recraft/v4/style/pro/text-to-vector'),

  // ── Pixelcut product photo ─────────────────────────────────────────────────
  'pixelcut-product-photo': {
    id: 'pixelcut-product-photo',
    endpoint: 'pixelcut/product-photo',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: true,
    notes: 'no prompt; background mode Transparent|Color|Image',
    build: (ctx) => {
      const mode = pickEnum(ctx.options.pixelcutBackgroundMode, ['Transparent', 'Color', 'Image'] as const, 'Transparent')
      const rgb = ctx.options.pixelcutBackgroundColor
      const background: Record<string, any> = compact({
        mode,
        image_fit: mode === 'Image' ? pickEnum(ctx.options.pixelcutImageFit, ['Cover', 'Contain', 'Stretch'] as const, 'Cover') : undefined,
        image_url: mode === 'Image' && typeof ctx.options.pixelcutBackgroundImageUrl === 'string' ? ctx.options.pixelcutBackgroundImageUrl : undefined,
        color:
          mode === 'Color' && rgb && typeof rgb === 'object'
            ? { r: int(rgb.r, 0, 255) ?? 255, g: int(rgb.g, 0, 255) ?? 255, b: int(rgb.b, 0, 255) ?? 255 }
            : undefined,
      })
      return compact({
        image_url: ctx.imageUrls[0],
        image_size: imageSize(ctx.aspectRatio, ctx.quality, 2048),
        output_format: pickEnum(ctx.options.pixelcutOutputFormat, ['png', 'jpeg'] as const, 'png'),
        sync_mode: false,
        background,
        margin: typeof ctx.options.pixelcutMargin === 'string' ? { all: ctx.options.pixelcutMargin } : undefined,
      })
    },
  },

  // ── Google Virtual Try-On ──────────────────────────────────────────────────
  'google-virtual-try-on': {
    id: 'google-virtual-try-on',
    endpoint: 'google/virtual-try-on',
    needsImage: true,
    imageParam: 'person_image_url',
    maxInputImages: 2,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    notes: 'needs TWO images: refs[0] = person, refs[1] = product/garment',
    build: (ctx) => ({
      person_image_url: ctx.imageUrls[0],
      product_image_url: ctx.imageUrls[1],
      num_images: 1,
    }),
  },

  // ── Topaz image suite ──────────────────────────────────────────────────────
  'topaz-img-upscale-precision': {
    id: 'topaz-img-upscale-precision',
    endpoint: 'topaz/upscale/image/precision',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: (ctx) =>
      compact({
        image_url: ctx.imageUrls[0],
        model: pickEnum(ctx.options.topazModel, TOPAZ_PRECISION_MODELS, 'Standard V2'),
        upscale_factor: num(ctx.options.topazUpscaleFactor, 1, 4) ?? 2,
        subject_detection: pickEnum(ctx.options.topazSubjectDetection, TOPAZ_SUBJECT_DETECTION, 'All'),
        face_enhancement: bool(ctx.options.topazFaceEnhancement) ?? true,
        face_enhancement_strength: num(ctx.options.topazFaceEnhancementStrength, 0, 1) ?? 0.8,
        face_enhancement_creativity: num(ctx.options.topazFaceEnhancementCreativity, 0, 1) ?? 0,
        crop_to_fill: bool(ctx.options.topazCropToFill) ?? false,
        output_format: pickEnum(ctx.options.topazOutputFormat, TOPAZ_OUTPUT_FORMATS, 'png'),
        sharpen: num(ctx.options.topazSharpen, 0, 1),
        denoise: num(ctx.options.topazDenoise, 0, 1),
        fix_compression: num(ctx.options.topazFixCompression, 0, 1),
        strength: num(ctx.options.topazStrength, 0.01, 1),
      }),
  },
  'topaz-img-upscale-creative': {
    id: 'topaz-img-upscale-creative',
    endpoint: 'topaz/upscale/image/creative',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: (ctx) =>
      compact({
        image_url: ctx.imageUrls[0],
        model: pickEnum(ctx.options.topazModel, TOPAZ_CREATIVE_MODELS, 'Bloom 2'),
        upscale_factor: num(ctx.options.topazUpscaleFactor, 1, 4) ?? 2,
        output_format: pickEnum(ctx.options.topazOutputFormat, TOPAZ_OUTPUT_FORMATS, 'png'),
        crop_to_fill: bool(ctx.options.topazCropToFill) ?? false,
        creativity: int(ctx.options.topazCreativity, 1, 9),
        color_preservation: bool(ctx.options.topazColorPreservation),
        autoprompt: bool(ctx.options.topazAutoprompt),
      }),
  },
  'topaz-img-upscale-generative': {
    id: 'topaz-img-upscale-generative',
    endpoint: 'topaz/upscale/image/generative',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    notes: 'optional guiding prompt',
    build: (ctx) =>
      compact({
        image_url: ctx.imageUrls[0],
        model: pickEnum(ctx.options.topazModel, TOPAZ_GENERATIVE_MODELS, 'Wonder 3'),
        upscale_factor: num(ctx.options.topazUpscaleFactor, 1, 4) ?? 2,
        subject_detection: pickEnum(ctx.options.topazSubjectDetection, TOPAZ_SUBJECT_DETECTION, 'All'),
        output_format: pickEnum(ctx.options.topazOutputFormat, TOPAZ_OUTPUT_FORMATS, 'png'),
        face_enhancement: bool(ctx.options.topazFaceEnhancement) ?? true,
        face_enhancement_strength: num(ctx.options.topazFaceEnhancementStrength, 0, 1) ?? 0.8,
        face_enhancement_creativity: num(ctx.options.topazFaceEnhancementCreativity, 0, 1) ?? 0,
        crop_to_fill: bool(ctx.options.topazCropToFill) ?? false,
        prompt: clip(ctx.prompt, 1024),
        autoprompt: bool(ctx.options.topazAutoprompt),
        creativity: int(ctx.options.topazCreativity, 1, 6),
        texture: int(ctx.options.topazTexture, 1, 5),
        detail: num(ctx.options.topazDetail, 0, 1),
        denoise: num(ctx.options.topazDenoise, 0, 1),
        sharpen: num(ctx.options.topazSharpen, 0, 1),
        enhancement_strength: ['low', 'medium', 'high'].includes(ctx.options.topazEnhancementStrength)
          ? ctx.options.topazEnhancementStrength
          : undefined,
      }),
  },
  'topaz-img-upscale-transparent': {
    id: 'topaz-img-upscale-transparent',
    endpoint: 'topaz/upscale/image/transparent',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    notes: 'output_format is const "png"; no upscale_factor',
    build: (ctx) => ({
      image_url: ctx.imageUrls[0],
      output_format: 'png',
    }),
  },
  'topaz-adjust': {
    id: 'topaz-adjust',
    endpoint: 'topaz/adjust/image',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: topazSimple(TOPAZ_ADJUST_MODELS, 'Adjust V2'),
  },
  'topaz-sharpen': {
    id: 'topaz-sharpen',
    endpoint: 'topaz/sharpen/image',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: topazSimple(TOPAZ_SHARPEN_MODELS, 'Standard'),
  },
  'topaz-denoise': {
    id: 'topaz-denoise',
    endpoint: 'topaz/denoise/image',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: topazSimple(TOPAZ_DENOISE_MODELS, 'Normal'),
  },
  'topaz-restore': {
    id: 'topaz-restore',
    endpoint: 'topaz/restore/image',
    needsImage: true,
    imageParam: 'image_url',
    maxInputImages: 1,
    promptRequired: false,
    aspectRatios: null,
    usesImageSize: false,
    build: topazSimple(TOPAZ_RESTORE_MODELS, 'Recover 3'),
  },
}

/**
 * Recraft v4 style/vector endpoints all share one input schema.
 * `image_urls` here are STYLE reference images (optional, 1-10), not an edit
 * source — the endpoints are text-to-image / text-to-vector.
 */
function recraftSpec(id: string, endpoint: string): FalImageModelSpec {
  return {
    id,
    endpoint,
    needsImage: false,
    imageParam: 'image_urls',
    maxInputImages: 10,
    promptRequired: true,
    promptMin: 1,
    promptMax: 10000,
    aspectRatios: null,
    usesImageSize: true,
    notes: 'image_urls are optional STYLE references; style_id is a Recraft style UUID',
    build: (ctx) => {
      const colors = Array.isArray(ctx.options.recraftColors)
        ? ctx.options.recraftColors
            .slice(0, 8)
            .filter((c: any) => c && typeof c === 'object')
            .map((c: any) => ({ r: int(c.r, 0, 255) ?? 0, g: int(c.g, 0, 255) ?? 0, b: int(c.b, 0, 255) ?? 0 }))
        : []
      const bg = ctx.options.recraftBackgroundColor
      return compact({
        prompt: ctx.prompt,
        image_size: imageSize(ctx.aspectRatio, ctx.quality, 2048),
        enable_safety_checker: false,
        colors,
        image_urls: ctx.imageUrls.length > 0 ? ctx.imageUrls.slice(0, 10) : undefined,
        style_id: typeof ctx.options.recraftStyleId === 'string' && ctx.options.recraftStyleId ? ctx.options.recraftStyleId : undefined,
        style_match: pickEnum(ctx.options.recraftStyleMatch, ['precise', 'flexible'] as const, 'flexible'),
        background_color:
          bg && typeof bg === 'object'
            ? { r: int(bg.r, 0, 255) ?? 0, g: int(bg.g, 0, 255) ?? 0, b: int(bg.b, 0, 255) ?? 0 }
            : undefined,
      })
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────────────────────

export const FAL_IMAGE_MODEL_IDS = Object.keys(FAL_IMAGE_MODELS)

export function getFalImageModelSpec(id: string): FalImageModelSpec | undefined {
  return FAL_IMAGE_MODELS[id]
}

/** Models in this batch that never need a text prompt. */
export function falImageModelIsPromptless(id: string): boolean {
  const spec = FAL_IMAGE_MODELS[id]
  return !!spec && !spec.promptRequired
}

/**
 * Builds the exact `input` object for fal.queue.submit(). Throws a plain Error
 * with a user-facing message when a required input image is missing.
 */
/**
 * The spec that should actually run: a merged family swaps to its edit sibling
 * as soon as the request has an input image. Falls back to the base when the
 * sibling is missing, so a bad id degrades to text-to-image rather than 500ing.
 */
export function resolveFalImageModelSpec(
  modelId: string,
  hasInputImages: boolean,
): FalImageModelSpec | undefined {
  const base = getFalImageModelSpec(modelId)
  if (!base || !hasInputImages || !base.editVariant) return base
  return getFalImageModelSpec(base.editVariant) ?? base
}

export function buildFalImageInput(
  spec: FalImageModelSpec,
  ctx: FalImageBuildContext,
): { endpoint: string; input: Record<string, any> } {
  if (spec.needsImage && ctx.imageUrls.length === 0) {
    throw new Error(`${spec.id} requires an input image`)
  }
  if (spec.id === 'google-virtual-try-on' && ctx.imageUrls.length < 2) {
    throw new Error('Virtual Try-On needs two images: a person photo and a product photo')
  }
  if (spec.promptRequired && !ctx.prompt) {
    throw new Error(`${spec.id} requires a prompt`)
  }
  // Enforce the schema's prompt minLength up front (a short prompt is a paid
  // 422 otherwise) and truncate to maxLength instead of failing the job.
  if (spec.promptMin && ctx.prompt.length < spec.promptMin) {
    throw new Error(`${spec.id} needs a prompt of at least ${spec.promptMin} characters`)
  }
  const prompt = spec.promptMax ? ctx.prompt.slice(0, spec.promptMax) : ctx.prompt
  const input = spec.build({
    ...ctx,
    prompt,
    imageUrls: ctx.imageUrls.slice(0, spec.maxInputImages),
  })
  return { endpoint: spec.endpoint, input }
}
