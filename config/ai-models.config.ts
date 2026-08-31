// AI Model Configuration - FAL.ai models (NanoBanana + SeeDream)
// Imagen models require different setup (commented out for now)

export interface AIModel {
  id: string
  name: string
  displayName: string
  description: string
  ticketCost: number
  category: 'standard' | 'premium' | 'ultra'
  rateLimit: {
    rpm: number
    rpd: number
  }
  quality: 'fast' | 'balanced' | 'high' | 'ultra'
  isAvailable: boolean
  provider?: 'gemini' | 'fal'
}

export const AI_MODELS: AIModel[] = [
  // NANOBANANA - FAL.ai (Gemini 2.5 Flash Image) - Fast & Cheap - 2 IMAGES!
  {
    id: 'nano-banana',
    name: 'fal-ai/nano-banana',
    displayName: 'NanoBanana Cluster',
    description: 'Fast, artistic generation - 2 tickets for 2 images!',
    ticketCost: 2,
    category: 'standard',
    rateLimit: {
      rpm: 0, // No rate limit on FAL.ai
      rpd: 0  // Unlimited with credits
    },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // NANOBANANA PRO - FAL.ai (Gemini 3 Pro Image) - High Quality
  {
    id: 'nano-banana-pro',
    name: 'fal-ai/nano-banana-pro',
    displayName: 'NanoBanana Pro',
    description: 'Premium quality - 7 tickets (2K) or 14 tickets (4K)',
    ticketCost: 7,
    category: 'premium',
    rateLimit: {
      rpm: 0, // No rate limit on FAL.ai
      rpd: 0  // Unlimited with credits
    },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // NANOBANANA PRO 2 - FAL.ai (Gemini 3 Pro Image 2) - Flagship
  // Was portal-only: the admin scanner drove it through its own
  // /api/admin/nano-banana-2-live route, so it existed nowhere in AI_MODELS.
  // Anything validating against this config — the chat hub included —
  // answered "Model nano-banana-pro-2 is not available".
  {
    id: 'nano-banana-pro-2',
    name: 'fal-ai/nano-banana-2',
    displayName: 'NanoBanana Pro 2',
    description: 'Newest Gemini image model - 7 tickets (2K) or 12 tickets (4K)',
    ticketCost: 7,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // SEEDREAM 4.5 - FAL.ai (ByteDance)
  {
    id: 'seedream-4.5',
    name: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    displayName: 'SeeDream 4.5',
    description: 'Premium quality with excellent text rendering',
    ticketCost: 2,  // 2 tickets (2K), 4 tickets (4K)
    category: 'standard',
    rateLimit: {
      rpm: 0, // No rate limit on FAL.ai
      rpd: 0  // Unlimited with credits
    },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // FLUX 2 - FAL.ai (Black Forest Labs)
  // FLUX 1 Dev - FAL.ai text-to-image and image-to-image
  {
    id: 'flux-1-dev',
    name: 'fal-ai/flux-1/dev',
    displayName: 'FLUX 1 Dev',
    description: 'FLUX.1 Dev — 2 tickets (1k), 5 tickets (2k), 6 tickets (4k)',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  {
    id: 'flux-2',
    name: 'fal-ai/flux-2',
    displayName: 'FLUX 2',
    description: 'Enhanced realism, crisp text, native editing - 1 ticket',
    ticketCost: 1,
    category: 'standard',
    rateLimit: {
      rpm: 0, // No rate limit on FAL.ai
      rpd: 0  // Unlimited with credits
    },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // DIRECT GEMINI API MODELS (No FAL.ai filtering!)
  
  // PRO SCANNER V3 - Direct Gemini API (Gemini 3 Pro Image Preview)
  {
    id: 'gemini-3-pro-image',
    name: 'gemini-3-pro-image-preview',  // Correct model from Google AI Studio
    displayName: 'Pro Scanner v3',
    description: 'Direct Gemini API - No filtering! 7 tickets (2K) or 15 tickets (4K)',
    ticketCost: 7,
    category: 'premium',
    rateLimit: {
      rpm: 10,
      rpd: 250  // Was 250/day based on Tier 2
    },
    quality: 'high',
    isAvailable: true,
    provider: 'gemini'
  },

  // FLASH SCANNER V2.5 - Direct Gemini API (Gemini 2.5 Flash Image)
  {
    id: 'gemini-2.5-flash-image',
    name: 'gemini-2.5-flash-image',
    displayName: 'Flash Scanner v2.5',
    description: 'Direct Gemini API - Fast generation, no filtering!',
    ticketCost: 1,
    category: 'standard',
    rateLimit: {
      rpm: 100,
      rpd: 2000  // Was 2000/day based on Tier 2
    },
    quality: 'balanced',
    isAvailable: true,
    provider: 'gemini'
  },

  // Z-IMAGE BASE - FAL.ai text-to-image with optional LoRA support
  {
    id: 'z-image-base',
    name: 'fal-ai/z-image/base',
    displayName: 'Z-Image Base',
    description: 'High quality text-to-image with optional LoRA. 1/4/15 tickets (1k/2k/4k)',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Z-IMAGE TURBO - FAL.ai fast text-to-image with optional LoRA support
  {
    id: 'z-image-turbo',
    name: 'fal-ai/z-image/turbo',
    displayName: 'Z-Image Turbo',
    description: 'Lightning fast text-to-image with optional LoRA. 1/2/8 tickets (1k/2k/4k)',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // CLARITY UPSCALER - fal-ai/clarity-upscaler
  {
    id: 'clarity-upscaler',
    name: 'fal-ai/clarity-upscaler',
    displayName: 'Clarity Upscaler',
    description: 'AI-powered upscaler — 7 tickets (2x) or 26 tickets (4x)',
    ticketCost: 7,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },

  // DRCT Super-Resolution - fal-ai/drct-super-resolution
  {
    id: 'drct',
    name: 'fal-ai/drct-super-resolution',
    displayName: 'DRCT Super-Resolution',
    description: 'Transformer upscaler — 1 ticket per 2 MP of output',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // ESRGAN - fal-ai/esrgan
  {
    id: 'esrgan',
    name: 'fal-ai/esrgan',
    displayName: 'ESRGAN',
    description: 'Real-ESRGAN upscaler — 6 model variants, 1 ticket flat',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // SUPIR - Replicate zust-ai/supir
  {
    id: 'supir',
    name: 'zust-ai/supir',
    displayName: 'SUPIR',
    description: 'LLaVA-guided diffusion upscaler — 8 tickets flat',
    ticketCost: 8,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
  },

  // AURASR - fal-ai/aura-sr
  {
    id: 'aura-sr',
    name: 'fal-ai/aura-sr',
    displayName: 'AuraSR',
    description: 'Fast GAN upscaler optimized for FLUX outputs — 1 ticket flat',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // CHATGPT IMAGES 2.0 - fal-ai/gpt-image-2
  {
    id: 'gpt-image-2',
    name: 'fal-ai/gpt-image-2',
    displayName: 'ChatGPT Images 2.0',
    description: 'OpenAI GPT Image 2 via FAL — text-to-image and image editing',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-08 FAL IMAGE BATCH — ADMIN ONLY while under test.
  // Gate lives in app/api/generate/route.ts (ADMIN_ONLY_IMAGE_MODELS).
  // Input shapes: lib/fal-image-models.ts (verified against live fal OpenAPI).
  // ═══════════════════════════════════════════════════════════════════════════

  // Qwen Image 3 (Alibaba)
  {
    id: 'qwen-image-3',
    name: 'alibaba/qwen-image-3/text-to-image',
    displayName: 'Qwen Image 3',
    description: 'Alibaba Qwen Image 3 text-to-image — strong text rendering',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'qwen-image-3-edit',
    name: 'alibaba/qwen-image-3/edit',
    displayName: 'Qwen Image 3 Edit',
    description: 'Qwen Image 3 multi-reference image editing',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Reve 2.1
  {
    id: 'reve-2.1',
    name: 'reve/2.1/text-to-image',
    displayName: 'Reve 2.1',
    description: 'Reve 2.1 text-to-image — wide aspect-ratio range (4:1 to 1:4)',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'reve-2.1-edit',
    name: 'reve/2.1/edit',
    displayName: 'Reve 2.1 Edit',
    description: 'Reve 2.1 single-image editing',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Microsoft MAI Image 2.5 Pro
  {
    id: 'mai-image-2.5-pro',
    name: 'microsoft/mai-image-2.5-pro',
    displayName: 'MAI Image 2.5 Pro',
    description: 'Microsoft MAI Image 2.5 Pro text-to-image',
    ticketCost: 4,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'mai-image-2.5-pro-edit',
    name: 'microsoft/mai-image-2.5-pro/edit',
    displayName: 'MAI Image 2.5 Pro Edit',
    description: 'Microsoft MAI Image 2.5 Pro single-image editing',
    ticketCost: 4,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // xAI Grok Imagine 2
  {
    id: 'grok-imagine-2',
    name: 'xai/grok-imagine-image/v2.0/text-to-image',
    displayName: 'Grok Imagine 2',
    description: 'xAI Grok Imagine 2 text-to-image — 1k/2k resolution',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'grok-imagine-2-edit',
    name: 'xai/grok-imagine-image/v2.0/edit',
    displayName: 'Grok Imagine 2 Edit',
    description: 'xAI Grok Imagine 2 multi-reference editing',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Meta Muse
  {
    id: 'meta-muse',
    name: 'meta/muse-image/text-to-image',
    displayName: 'Meta Muse',
    description: 'Meta Muse Image text-to-image',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'meta-muse-edit',
    name: 'meta/muse-image/edit',
    displayName: 'Meta Muse Edit',
    description: 'Meta Muse Image editing — up to 10 reference images',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Bria FIBO 1.5
  {
    id: 'bria-fibo',
    name: 'bria/fibo-gen-1.5/text-to-image',
    displayName: 'Bria FIBO 1.5',
    description: 'Bria FIBO 1.5 text-to-image — licensed-data model, 1MP/4MP',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'bria-fibo-edit',
    name: 'bria/fibo-edit-1.5/edit',
    displayName: 'Bria FIBO 1.5 Edit',
    description: 'Bria FIBO 1.5 instruction editing (optional mask)',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },

  // Ideogram v4
  {
    id: 'ideogram-v4-instant',
    name: 'ideogram/v4/instant',
    displayName: 'Ideogram v4 Instant',
    description: 'Ideogram v4 Instant — fastest tier, great typography',
    ticketCost: 1,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'ideogram-v4-fast',
    name: 'ideogram/v4/fast',
    displayName: 'Ideogram v4 Fast',
    description: 'Ideogram v4 Fast — TURBO/BALANCED/QUALITY rendering speeds',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'balanced',
    isAvailable: true,
    provider: 'fal'
  },

  // Google NanoBanana 2 Lite
  {
    id: 'nano-banana-2-lite',
    name: 'google/nano-banana-2-lite',
    displayName: 'NanoBanana 2 Lite',
    description: 'Gemini NanoBanana 2 Lite — extreme aspect ratios up to 8:1',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'balanced',
    isAvailable: true,
    provider: 'fal'
  },

  // Recraft v4 — style + vector
  {
    id: 'recraft-v4-style',
    name: 'recraft/v4/style/text-to-image',
    displayName: 'Recraft v4 Style',
    description: 'Recraft v4 styled text-to-image (style_id + style refs)',
    ticketCost: 3,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'recraft-v4-style-pro',
    name: 'recraft/v4/style/pro/text-to-image',
    displayName: 'Recraft v4 Style Pro',
    description: 'Recraft v4 Pro styled text-to-image',
    ticketCost: 6,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'recraft-v4-vector',
    name: 'recraft/v4/style/text-to-vector',
    displayName: 'Recraft v4 Vector',
    description: 'Recraft v4 text-to-vector (SVG output)',
    ticketCost: 4,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'high',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'recraft-v4-vector-pro',
    name: 'recraft/v4/style/pro/text-to-vector',
    displayName: 'Recraft v4 Vector Pro',
    description: 'Recraft v4 Pro text-to-vector (SVG output)',
    ticketCost: 8,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },

  // Pixelcut product photo
  {
    id: 'pixelcut-product-photo',
    name: 'pixelcut/product-photo',
    displayName: 'Pixelcut Product Photo',
    description: 'Product cutout + studio background — no prompt needed',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'balanced',
    isAvailable: true,
    provider: 'fal'
  },

  // Google Virtual Try-On
  {
    id: 'google-virtual-try-on',
    name: 'google/virtual-try-on',
    displayName: 'Virtual Try-On',
    description: 'Dress a person photo in a garment photo — needs 2 images',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'balanced',
    isAvailable: true,
    provider: 'fal'
  },

  // Topaz image suite
  {
    id: 'topaz-img-upscale-precision',
    name: 'topaz/upscale/image/precision',
    displayName: 'Topaz Precision Upscale',
    description: 'Topaz precision upscale 1-4x — faithful detail recovery',
    ticketCost: 4,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-img-upscale-creative',
    name: 'topaz/upscale/image/creative',
    displayName: 'Topaz Creative Upscale',
    description: 'Topaz Bloom creative upscale 1-4x',
    ticketCost: 4,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-img-upscale-generative',
    name: 'topaz/upscale/image/generative',
    displayName: 'Topaz Generative Upscale',
    description: 'Topaz Wonder/Recover generative upscale 1-4x (optional prompt)',
    ticketCost: 5,
    category: 'premium',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-img-upscale-transparent',
    name: 'topaz/upscale/image/transparent',
    displayName: 'Topaz Transparent Upscale',
    description: 'Topaz alpha-preserving upscale — always PNG',
    ticketCost: 4,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'ultra',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-adjust',
    name: 'topaz/adjust/image',
    displayName: 'Topaz Adjust',
    description: 'Topaz Adjust V2 / White Balance / Colorize',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-sharpen',
    name: 'topaz/sharpen/image',
    displayName: 'Topaz Sharpen',
    description: 'Topaz sharpen — 11 model variants (lens blur, motion, portrait…)',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-denoise',
    name: 'topaz/denoise/image',
    displayName: 'Topaz Denoise',
    description: 'Topaz denoise — Normal / Strong / Extreme / Denoise Max',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },
  {
    id: 'topaz-restore',
    name: 'topaz/restore/image',
    displayName: 'Topaz Restore',
    description: 'Topaz restore — Recover 3 / Dust-Scratch V2',
    ticketCost: 2,
    category: 'standard',
    rateLimit: { rpm: 0, rpd: 0 },
    quality: 'fast',
    isAvailable: true,
    provider: 'fal'
  },

  // IMAGEN MODELS - Require Vertex AI (different setup)
  // Uncomment these when you set up Vertex AI
  /*
  {
    id: 'imagen-4.0-generate-001',
    name: 'imagen-4.0-generate-001',
    displayName: 'Imagen 4 Standard',
    description: 'Latest image generation with better text rendering',
    ticketCost: 1,
    category: 'standard',
    rateLimit: {
      rpm: 10,
      rpd: 100
    },
    quality: 'high',
    isAvailable: true
  },
  {
    id: 'imagen-4.0-ultra-generate-001',
    name: 'imagen-4.0-ultra-generate-001',
    displayName: 'Imagen 4 ULTRA',
    description: 'Maximum fidelity image generation',
    ticketCost: 1,
    category: 'standard',
    rateLimit: {
      rpm: 5,
      rpd: 50
    },
    quality: 'ultra',
    isAvailable: true
  },
  */

  // PREMIUM TIER - 2 tickets (COMING SOON - Requires Imagen setup)
  // Uncomment these when you set up Imagen API
  /*
  {
    id: 'imagen-4.0-fast-generate',
    name: 'imagen-4.0-fast-generate',
    displayName: 'Imagen Fast v4.0',
    description: 'Premium image generation with enhanced details',
    ticketCost: 2,
    category: 'premium',
    rateLimit: {
      rpm: 0,
      rpd: 10
    },
    quality: 'high',
    isAvailable: true
  },
  {
    id: 'imagen-4.0-generate',
    name: 'imagen-4.0-generate',
    displayName: 'Imagen Standard v4.0',
    description: 'High-quality multiverse imagery with refined output',
    ticketCost: 2,
    category: 'premium',
    rateLimit: {
      rpm: 0,
      rpd: 10
    },
    quality: 'high',
    isAvailable: true
  },

  // ULTRA TIER - 5 tickets (COMING SOON - Requires Imagen setup)
  {
    id: 'imagen-4.0-ultra-generate',
    name: 'imagen-4.0-ultra-generate',
    displayName: 'Imagen ULTRA v4.0 ⚡',
    description: 'Maximum fidelity - The pinnacle of multiverse scanning technology',
    ticketCost: 5,
    category: 'ultra',
    rateLimit: {
      rpm: 0,
      rpd: 5
    },
    quality: 'ultra',
    isAvailable: true
  },
  */
]

// Helper functions
export function getModelById(id: string): AIModel | undefined {
  return AI_MODELS.find(m => m.id === id)
}

export function getAvailableModels(): AIModel[] {
  return AI_MODELS.filter(m => m.isAvailable)
}

export function getModelsByCategory(category: 'standard' | 'premium' | 'ultra'): AIModel[] {
  return AI_MODELS.filter(m => m.category === category && m.isAvailable)
}

export function getTicketCost(modelId: string, quality?: '2k' | '4k' | string): number {
  const model = getModelById(modelId)
  if (!model) return 1

  // Clarity Upscaler: 7 tickets (2x), 26 tickets (4x)
  if (modelId === 'clarity-upscaler') {
    return quality === '4x' ? 26 : 7
  }

  // NanoBanana Pro: 7 tickets for 2K, 14 tickets for 4K
  if (modelId === 'nano-banana-pro') {
    return quality === '4k' ? 14 : 7
  }

  // NanoBanana Pro 2: 7 tickets for 2K, 12 tickets for 4K
  if (modelId === 'nano-banana-pro-2') {
    return quality === '4k' ? 12 : 7
  }

  // Pro Scanner v3: 7 tickets for 2K, 15 tickets for 4K
  if (modelId === 'gemini-3-pro-image') {
    return quality === '4k' ? 15 : 7
  }

  // SeeDream 4.5: 2 tickets for 2K, 4 tickets for 4K
  if (modelId === 'seedream-4.5') {
    return quality === '4k' ? 4 : 2
  }

  return model.ticketCost
}

// Category colors for UI
export const CATEGORY_COLORS = {
  standard: {
    border: 'border-cyan-400',
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-400',
    glow: 'shadow-cyan-500/50'
  },
  premium: {
    border: 'border-fuchsia-400',
    bg: 'bg-fuchsia-500/10',
    text: 'text-fuchsia-400',
    glow: 'shadow-fuchsia-500/50'
  },
  ultra: {
    border: 'border-yellow-400',
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-400',
    glow: 'shadow-yellow-500/50'
  }
}

// NOTE: To enable Imagen models:
// 1. Verify model availability in Google AI Studio
// 2. Check if models require Vertex AI instead of Gemini API
// 3. Update API endpoint in generate route if needed
// 4. Uncomment models above and set isAvailable: true
// 5. Test each model individually before going live
