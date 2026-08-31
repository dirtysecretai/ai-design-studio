import { AI_MODELS, getTicketCost } from '@/config/ai-models.config'
import { FAL_IMAGE_MODEL_IDS, getFalImageModelSpec } from '@/lib/fal-image-models'

// The chat hub's IMAGE catalog, derived from the site's model config rather
// than hand-listed a second time — the same treatment the video catalog got.
//
// The hub described sixteen image models while the studio ships forty-nine, so
// most of the roster (Ideogram, the Recraft V4 line, the Topaz image suite,
// Qwen, Reve, MAI, Grok, Meta Muse, Bria, Pixelcut, Virtual Try-On) was simply
// unreachable from chat. Image generation now submits through /api/generate,
// which owns every model's input shape and the admin gate, so a derived entry
// is enough to make one usable.

export type ChatImageEntry = {
  id: string
  label: string
  kind: 'image'
  group: string
  maxRefs: number
  ticketCost: number
  needsRef?: boolean
  admin?: boolean
  strengths?: string
}

/**
 * Admin-only images, mirroring app/api/generate's own set. Kept in sync by
 * construction: the fal suite comes from the same exported id list the route
 * spreads into its check.
 */
export const ADMIN_ONLY_IMAGE_MODELS = new Set<string>([
  'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image-preview',
  'flash-scanner-v2.5', 'pro-scanner-v3',
  'nano-banana-pro-2',
  ...FAL_IMAGE_MODEL_IDS,
])

function groupOf(id: string, name: string): string {
  if (id.startsWith('ideogram')) return 'Ideogram'
  if (id.startsWith('recraft')) return 'Recraft'
  if (id.startsWith('topaz')) return 'Topaz'
  if (id.startsWith('qwen')) return 'Alibaba'
  if (id.startsWith('reve')) return 'Reve'
  if (id.startsWith('mai-')) return 'Microsoft'
  if (id.startsWith('grok')) return 'xAI'
  if (id.startsWith('meta-')) return 'Meta'
  if (id.startsWith('bria')) return 'Bria'
  if (id.startsWith('pixelcut')) return 'Pixelcut'
  if (id.startsWith('seedream') || id.startsWith('seedance')) return 'ByteDance'
  if (id.startsWith('nano-banana') || id.startsWith('gemini') || id.includes('scanner') || id.startsWith('google')) return 'Google'
  if (id.startsWith('flux') || id.startsWith('z-image')) return 'Black Forest'
  if (id.startsWith('kling')) return 'Kling'
  if (id.startsWith('gpt-') || name.toLowerCase().includes('chatgpt')) return 'OpenAI'
  if (id.startsWith('wan')) return 'Wan'
  return 'Image'
}

/** Image models are LLM-facing text: say what each is actually for. */
const NOTES: Record<string, string> = {
  'ideogram-v4-instant': 'BEST FOR: text INSIDE the image — signage, posters, labels, book covers. The most reliable speller in the studio. Instant tier: fastest and cheapest.',
  'ideogram-v4-fast': 'BEST FOR: text inside the image, a quality step above Instant. Reach for this when lettering has to be right.',
  'recraft-v4-style': 'BEST FOR: designed typography and brand-consistent styling. Strong at layout-led work rather than photoreal scenes.',
  'recraft-v4-style-pro': 'BEST FOR: the same designed-type work at the highest quality tier.',
  'recraft-v4-vector': 'BEST FOR: true SVG VECTOR output — logos, icons, flat graphics that must scale cleanly.',
  'recraft-v4-vector-pro': 'BEST FOR: vector output at the highest quality tier.',
  'gpt-image-2': 'BEST FOR: instruction-following and short in-scene text; reliable at doing exactly what the prompt says.',
  'google-virtual-try-on': 'Dresses a person photo in a garment photo. Needs BOTH. Google screens the inputs and refuses recognisable real people.',
}

export const CHAT_IMAGE_MODELS: ChatImageEntry[] = AI_MODELS
  .filter(m => m.isAvailable !== false)
  // video and the local/upscaler-only entries are not create_media material
  .filter(m => !/^(local-|clarity-upscaler|aura-sr|esrgan|drct|supir)/.test(m.id))
  .map(m => {
    const fal = getFalImageModelSpec(m.id)
    const maxRefs = fal ? fal.maxInputImages : 4
    return {
      id: m.id,
      label: m.displayName,
      kind: 'image' as const,
      group: groupOf(m.id, m.displayName),
      maxRefs,
      needsRef: fal?.needsImage === true,
      admin: ADMIN_ONLY_IMAGE_MODELS.has(m.id),
      ticketCost: getTicketCost(m.id),
      strengths: NOTES[m.id] ?? m.description ?? undefined,
    }
  })
