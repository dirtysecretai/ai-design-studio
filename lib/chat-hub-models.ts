// Curated model list for the AI Chat Hub. Serves as both the client dropdown
// source and the server-side allowlist for the send route.
//
// Two routing modes per provider:
//  - 'gateway': Vercel AI Gateway — model addressed as the "provider/model"
//    `id` string, billed on AI_GATEWAY_API_KEY. IDs verified against
//    https://ai-gateway.vercel.sh/v1/models on 2026-07-10.
//  - 'direct': the provider's own API via its @ai-sdk package — model
//    addressed as `directId`, billed on that provider's own API key.

import { CHAT_VIDEO_MODELS } from '@/lib/chat-video-catalog'
import { CHAT_IMAGE_MODELS } from '@/lib/chat-image-catalog'

export type ChatHubProvider = 'Anthropic' | 'OpenAI' | 'Google' | 'xAI'
export type ChatHubRoute = 'gateway' | 'direct'

export type ChatHubModel = {
  id: string        // gateway id ("provider/model") — also the canonical id stored in the DB
  directId: string  // the provider's native API model id
  label: string
  provider: ChatHubProvider
  maxImages: number // max reference images accepted per message (conservative per-provider caps)
  strengths?: string // one-liner used in the agent roster description
  custom?: boolean   // user-added gateway model (Chat Settings) — gateway route only
  ollama?: boolean   // locally-served Ollama model — resolved against the local server, no API key
  runpod?: boolean   // rented-GPU model on the user's RunPod endpoint (OpenAI-compatible vLLM)
  openrouter?: boolean // model served via the user's OpenRouter key (OpenAI-compatible)
}

export const CHAT_HUB_MODELS: ChatHubModel[] = [
  // Anthropic's native API uses dashes where the gateway uses dots
  { id: 'anthropic/claude-fable-5',      directId: 'claude-fable-5',           label: 'Claude Fable 5',   provider: 'Anthropic', maxImages: 20, strengths: 'top-tier reasoning, coding, nuanced writing' },
  { id: 'anthropic/claude-sonnet-5',     directId: 'claude-sonnet-5',          label: 'Claude Sonnet 5',  provider: 'Anthropic', maxImages: 20, strengths: 'strong all-rounder: reasoning, coding, long context' },
  { id: 'anthropic/claude-opus-4.8',     directId: 'claude-opus-4-8',          label: 'Claude Opus 4.8',  provider: 'Anthropic', maxImages: 20, strengths: 'deep analysis and careful long-form work' },
  { id: 'anthropic/claude-haiku-4.5',    directId: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5', provider: 'Anthropic', maxImages: 20, strengths: 'fast and cheap for simple subtasks' },
  { id: 'openai/gpt-5.5',                directId: 'gpt-5.5',                  label: 'GPT-5.5',          provider: 'OpenAI',    maxImages: 10, strengths: 'strong general reasoning and structured output' },
  { id: 'openai/gpt-5.5-pro',            directId: 'gpt-5.5-pro',              label: 'GPT-5.5 Pro',      provider: 'OpenAI',    maxImages: 10, strengths: 'slow but very thorough problem solving' },
  { id: 'openai/gpt-5.4-mini',           directId: 'gpt-5.4-mini',             label: 'GPT-5.4 Mini',     provider: 'OpenAI',    maxImages: 10, strengths: 'fast and cheap for drafts and summaries' },
  { id: 'google/gemini-3.1-pro-preview', directId: 'gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro',   provider: 'Google',    maxImages: 16, strengths: 'strong reasoning, huge context, good vision' },
  { id: 'google/gemini-3.5-flash',       directId: 'gemini-3.5-flash',         label: 'Gemini 3.5 Flash', provider: 'Google',    maxImages: 16, strengths: 'very fast, cheap, good vision — great for parallel research' },
  { id: 'google/gemini-3.5-flash-lite',  directId: 'gemini-3.5-flash-lite',    label: 'Gemini 3.5 Flash Lite', provider: 'Google', maxImages: 16, strengths: 'cheapest Google model — quick lookups and simple subtasks' },
  { id: 'google/gemini-3.6-flash',       directId: 'gemini-3.6-flash',         label: 'Gemini 3.6 Flash', provider: 'Google',    maxImages: 16, strengths: 'fast with improved tool use over 3.5' },
  { id: 'google/gemini-3.7-flash',       directId: 'gemini-3.7-flash',         label: 'Gemini 3.7 Flash', provider: 'Google',    maxImages: 16, strengths: 'newest flash — strongest agentic/tool-calling of the Flash line, great for employees' },
  { id: 'xai/grok-4.5',                  directId: 'grok-4.5',                 label: 'Grok 4.5',         provider: 'xAI',       maxImages: 8, strengths: 'strong reasoning, current-events knowledge' },
  { id: 'xai/grok-4.1-fast-reasoning',   directId: 'grok-4.1-fast-reasoning',  label: 'Grok 4.1 Fast',    provider: 'xAI',       maxImages: 8, strengths: 'fast reasoning at low cost' },
]

export const CHAT_HUB_PROVIDERS: ChatHubProvider[] = ['Anthropic', 'OpenAI', 'Google', 'xAI']

export const DEFAULT_CHAT_MODEL = CHAT_HUB_MODELS[0].id

export function isAllowedChatModel(id: string): boolean {
  return CHAT_HUB_MODELS.some(m => m.id === id)
}

export function getChatModel(id: string): ChatHubModel | undefined {
  return CHAT_HUB_MODELS.find(m => m.id === id)
}

// ── User-added custom models (any Vercel AI Gateway model id) ──────────────
export type CustomChatModel = { id: string; label: string }
export const CUSTOM_MODEL_ID_RE = /^[\w.-]+\/[\w.:-]+$/
export const MAX_CUSTOM_MODELS = 20

export function sanitizeCustomModels(raw: unknown): CustomChatModel[] {
  if (!Array.isArray(raw)) return []
  const out: CustomChatModel[] = []
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || !CUSTOM_MODEL_ID_RE.test(item.id)) continue
    if (out.some(m => m.id === item.id)) continue
    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim().slice(0, 40)
      : item.id.split('/').pop()!.slice(0, 40)
    out.push({ id: item.id, label })
    if (out.length >= MAX_CUSTOM_MODELS) break
  }
  return out
}

// Resolve a model id against built-ins + the user's custom list. Customs are
// synthesized specs: gateway-route only, provider display-only from the prefix.
export function getChatModelForUser(id: string, customs: CustomChatModel[]): ChatHubModel | undefined {
  const builtin = getChatModel(id)
  if (builtin) return builtin
  // Local Ollama models: any 'ollama/<name>' id resolves without an
  // allowlist — the target is the admin's own local server, not a paid API
  if (id.startsWith('ollama/') && id.length > 7 && id.length < 140) {
    const name = id.slice(7)
    return { id, directId: name, label: `${name} (local)`, provider: 'OpenAI', maxImages: 4, ollama: true }
  }
  // RunPod models: any 'runpod/<served-model-id>' id resolves against the
  // user's linked RunPod endpoint (vLLM serves HF repo paths, so the name
  // may itself contain slashes, e.g. runpod/huihui-ai/Qwen3-VL-...)
  if (id.startsWith('runpod/') && id.length > 7 && id.length < 200) {
    const name = id.slice(7)
    const short = name.split('/').pop()!.slice(0, 40)
    return { id, directId: name, label: `${short} (pod)`, provider: 'OpenAI', maxImages: 8, runpod: true }
  }
  // OpenRouter models: any 'openrouter/<vendor>/<model>' id resolves via the
  // user's OpenRouter key (OpenAI-compatible). The OpenRouter model id keeps
  // its own slash, e.g. openrouter/anthropic/claude-3.5-sonnet.
  if (id.startsWith('openrouter/') && id.length > 11 && id.length < 200) {
    const name = id.slice(11)
    const short = name.split('/').pop()!.slice(0, 40)
    return { id, directId: name, label: `${short} (OR)`, provider: 'OpenAI', maxImages: 8, openrouter: true }
  }
  const custom = customs.find(m => m.id === id)
  if (!custom) return undefined
  return {
    id: custom.id,
    directId: custom.id,
    label: custom.label,
    provider: 'OpenAI', // placeholder — never used for key lookup (custom = gateway only)
    maxImages: 8,
    custom: true,
  }
}

// Which env var carries each provider's direct API key (server-side only)
export const DIRECT_KEY_ENV: Record<ChatHubProvider, string> = {
  Anthropic: 'ANTHROPIC_API_KEY',
  OpenAI: 'OPENAI_API_KEY',
  Google: 'GEMINI_API_KEY',
  xAI: 'XAI_API_KEY',
}

// ── "+" menu Create models — the studio's own FAL image/video models ────────
// Mirrors the portal's Image/Video taskbar dropdowns (same models, same
// provider groups). Pro Scanner v3 runs through the raw Gemini API (not FAL).
// Excluded on purpose: upscalers + RunPod local models (need a source image /
// local PC, not a prompt), Kling V3 Motion (needs a motion video) and
// Lipsync v3 (needs video + audio inputs).
// Per-model configurable settings, mirroring what the model's dedicated
// scanner prompt box offers (aspect ratio, quality, duration, audio, …)
export type CreateField = {
  key: 'aspect' | 'quality' | 'resolution' | 'duration' | 'audio'
  label: string
  options: string[]
  def: string
}
export type ChatCreateSettings = Record<string, string>

export type ChatCreateModel = {
  id: string
  label: string
  kind: 'image' | 'video'
  group: string       // provider group, taskbar-style
  ticketCost: number  // tickets at the DEFAULT settings (menu display; the real
                      // charge is computeCreateCost with the chosen settings)
  maxRefs: number     // max active reference images — mirrors the scanner's
                      // maxReferenceImages (0 = model doesn't take refs)
  fields?: CreateField[]
  geminiApi?: string  // set = generated via the raw Gemini API (model name)
  needsRef?: boolean  // requires at least one attached reference image
  noRefs?: boolean    // model has no reference support — attached refs are ignored
  disabled?: string   // listed but not usable in chat yet — reason shown in the menu
  strengths?: string  // what this model is actually good at — injected into the
                      // orchestrator's media instructions so it picks well
  guide?: string      // distilled prompting guide (from fal's official docs) —
                      // injected so the orchestrator writes expert prompts
  endFrame?: boolean  // video model accepts a second ref as the END frame
                      // (refs[0] = start, refs[1] = end → end_image_url)
  admin?: boolean     // admin-only model (pricing TBD) — excluded from non-admin
                      // contexts via usableCreateModels()
}

const A = (label: string, options: string[], def: string): CreateField => ({ key: 'aspect', label, options, def })
const Q = (options: string[], def: string): CreateField => ({ key: 'quality', label: 'Quality', options, def })
const R = (options: string[], def: string): CreateField => ({ key: 'resolution', label: 'Res', options, def })
const D = (options: string[], def: string): CreateField => ({ key: 'duration', label: 'Sec', options, def })
const AUDIO: CreateField = { key: 'audio', label: 'Audio', options: ['off', 'on'], def: 'off' }

// Fill in every field's default for missing/invalid values (shared client+server)
export function resolveCreateSettings(model: ChatCreateModel, raw: unknown): ChatCreateSettings {
  const out: ChatCreateSettings = {}
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const f of model.fields ?? []) {
    const v = src[f.key]
    out[f.key] = typeof v === 'string' && f.options.includes(v) ? v : f.def
  }
  return out
}

// Ticket cost for the chosen settings — formulas copied from the scanners
// (config getTicketCost + video/generate + admin submit routes)
export function computeCreateCost(model: ChatCreateModel, s: ChatCreateSettings): number {
  const dur = parseInt(s.duration === 'auto' ? '5' : (s.duration ?? '5')) || 5
  const resMult = s.resolution === '1080p' ? 2.25 : s.resolution === '480p' ? 0.5 : 1.0
  switch (model.id) {
    case 'nano-banana-pro':    return s.quality === '4k' ? 14 : 7
    case 'nano-banana-pro-2':  return s.quality === '4k' ? 12 : 7
    case 'gemini-3-pro-image': return s.quality === '4k' ? 15 : 7
    case 'kling-o3-image':     return s.quality === '4k' ? 4 : 2
    case 'seedream-4.5':       return s.quality === '4k' ? 4 : 2
    case 'seedream-5-lite':    return s.quality === '3k' ? 4 : 2
    case 'seedream-5-pro':     return 10 // flat — public, 2K only
    case 'recraft-v4.1':       return 15 // flat — public
    case 'gemini-omni-flash':  return (parseInt(s.duration ?? '8') || 8) * 15 // PLACEHOLDER ≈ seedance-2.0
    case 'gpt-image-2': {
      const size = s.aspect ?? '1024x1024'
      if (s.quality === 'low') return 1
      if (s.quality === 'high') {
        if (size === '1024x1024') return 8
        if (size === '2560x1440') return 9
        if (size === '3840x2160') return 15
        return 6
      }
      if (size === '1024x1024' || size === '2560x1440') return 3
      if (size === '3840x2160') return 4
      return 2
    }
    case 'kling-v3':          return dur * (s.audio === 'on' ? 8 : 6)
    case 'seedance-1.5':      return Math.ceil(dur * 2.0 * resMult * (s.audio === 'on' ? 1.0 : 0.5)) + 1
    case 'seedance-2.0':      return Math.ceil(dur * 15 * resMult)
    case 'seedance-2.5':      return Math.ceil(dur * 18 * resMult)
    case 'seedance-2.0-fast': return Math.ceil(dur * 12 * (s.resolution === '480p' ? 0.5 : 1.0))
    case 'wan-2.5': {
      const table: Record<string, Record<string, number>> = {
        '480p': { '5': 7, '10': 14 }, '720p': { '5': 13, '10': 26 }, '1080p': { '5': 20, '10': 40 },
      }
      return table[s.resolution ?? '720p']?.[s.duration ?? '5'] ?? 20
    }
    case 'happy-horse':       return dur * (s.resolution === '1080p' ? 12 : 7)
    default:                  return model.ticketCost
  }
}

// Group accents copied from the taskbar dropdown design
export const CHAT_CREATE_GROUPS: Record<string, { accent: string; dot: string }> = {
  'Gemini':            { accent: 'text-blue-400',    dot: 'bg-blue-400' },
  'Kling':             { accent: 'text-orange-400',  dot: 'bg-orange-400' },
  'ByteDance':         { accent: 'text-emerald-400', dot: 'bg-emerald-400' },
  'Wan':               { accent: 'text-violet-400',  dot: 'bg-violet-400' },
  'Black Forest Labs': { accent: 'text-amber-400',   dot: 'bg-amber-400' },
  'OpenAI':            { accent: 'text-green-400',   dot: 'bg-green-400' },
  'Z-Image':           { accent: 'text-cyan-400',    dot: 'bg-cyan-400' },
  'Lipsync':           { accent: 'text-pink-400',    dot: 'bg-pink-400' },
  'Alibaba':           { accent: 'text-yellow-400',  dot: 'bg-yellow-400' },
  'Recraft':           { accent: 'text-fuchsia-400', dot: 'bg-fuchsia-400' },
  'Google':            { accent: 'text-blue-400',    dot: 'bg-blue-400' },
}

const SECONDS = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i))

export const CHAT_CREATE_MODELS: ChatCreateModel[] = [
  // ── Image ── (taskbar Image dropdown order; options mirror each model's scanner)
  { id: 'nano-banana-pro',   label: 'NanoBanana Pro',     kind: 'image', group: 'Gemini', maxRefs: 8, ticketCost: 7,
    strengths: 'top-tier photorealism, accurate text-in-image rendering, strong instruction following and multi-ref editing — go-to for premium hero images and ads',
    guide: 'Same prompting rules as nano-banana-pro-2.',
    fields: [A('AR', ['1:1', '2:3', '3:2', '4:5', '3:4', '4:3', '9:16', '16:9'], '1:1'), Q(['2k', '4k'], '2k')] },
  { id: 'nano-banana-pro-2', label: 'NanoBanana Pro 2',   kind: 'image', group: 'Gemini', maxRefs: 14, ticketCost: 7,
    strengths: 'newest Gemini image model — best-in-class realism and prompt adherence, up to 14 refs for character/product consistency. PREFERRED for people: skin texture, faces, photoreal portraits',
    guide: 'Natural conversational sentences — NO keyword tags or "masterpiece" boosters (they actively hurt). Order: subject → composition → action → location → style; 1-3 sentences (longer only for text-heavy designs). Text to render goes in "double quotes" with a style note ("TITLE" in bold sans-serif), max 3-5 text elements; use 2k+ when text is small. Edits: plain-English instructions, no masks; explicitly state what to PRESERVE ("keep pose identical"); one edit per call.',
    fields: [A('AR', ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'], 'auto'), Q(['1k', '2k', '4k'], '2k')] },
  { id: 'gemini-2.5-flash-image', label: 'Flash Scanner v2.5', kind: 'image', group: 'Gemini', maxRefs: 4, ticketCost: 2,
    geminiApi: 'gemini-2.5-flash-image',
    strengths: 'fast + cheap Gemini image gen — drafts, quick concepts, casual edits',
    fields: [A('AR', ['1:1', '4:5', '9:16', '16:9'], '1:1')] },
  { id: 'gemini-3-pro-image', label: 'Pro Scanner v3',    kind: 'image', group: 'Gemini', maxRefs: 8, ticketCost: 7,
    geminiApi: 'gemini-3-pro-image-preview',
    strengths: 'Gemini 3 Pro image quality with strong reasoning about layout/typography — infographics, UI mockups, text-heavy designs',
    fields: [A('AR', ['1:1', '2:3', '3:2', '4:5', '3:4', '4:3', '9:16', '16:9'], '1:1'), Q(['2k', '4k'], '2k')] },
  { id: 'kling-image-v3',    label: 'Kling V3',           kind: 'image', group: 'Kling', maxRefs: 1, ticketCost: 2,
    strengths: 'cinematic stills with dramatic lighting and film-like color — moody scenes, atmospheres',
    fields: [A('AR', ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'], '1:1'), Q(['1k', '2k'], '2k')] },
  { id: 'kling-o3-image',    label: 'Kling O3',           kind: 'image', group: 'Kling', maxRefs: 10, ticketCost: 2,
    strengths: 'strong multi-reference composition and style transfer at low cost — combining several refs into one scene',
    fields: [A('AR', ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'], 'auto'), Q(['1k', '2k', '4k'], '2k')] },
  { id: 'seedream-4.5',      label: 'SeeDream 4.5',       kind: 'image', group: 'ByteDance', maxRefs: 8, ticketCost: 2,
    strengths: 'excellent aesthetics-per-ticket — beauty/fashion/product shots, stylized art, great default when budget matters',
    guide: 'Front-loads attention: the MOST important concept goes first, then style, lighting, composition, technical details. Sweet spot 30-100 words — overlong prompts confuse it. Use photographic vocabulary ("medium shot", "golden hour lighting", "dramatic side lighting") and explicit negations to steer style ("not cartoon-like").',
    fields: [A('AR', ['1:1', '2:3', '3:2', '4:5', '3:4', '4:3', '9:16', '16:9', '21:9'], '1:1'), Q(['2k', '4k'], '2k')] },
  { id: 'seedream-5-lite',   label: 'SeeDream 5.0 Lite',  kind: 'image', group: 'ByteDance', maxRefs: 10, ticketCost: 2,
    strengths: 'newest SeeDream line, light tier — clean detailed renders, strong faces, fast turnaround',
    fields: [Q(['2k', '3k'], '2k')] },
  { id: 'seedream-5-pro',    label: 'SeeDream 5.0 Pro',   kind: 'image', group: 'ByteDance', maxRefs: 10, ticketCost: 10,
    strengths: 'SeeDream flagship — deep-thinking prompt understanding, native text in 14 languages, precise control over dense layouts and structured designs; top ByteDance image quality',
    guide: 'Handles long, structured prompts better than 4.5 — spell out layout regions and text placements explicitly. Text to render goes in quotes. Same front-loading principle: core subject first.',
    fields: [Q(['2k'], '2k')] },
  { id: 'recraft-v4.1',      label: 'Recraft v4.1',       kind: 'image', group: 'Recraft', maxRefs: 0, ticketCost: 15, noRefs: true,
    strengths: 'design-first generator — brand systems, editorial work, production-ready raster images with sharp prompt control and clean composition; takes NO refs, text-to-image only',
    fields: [A('AR', ['1:1', '4:3', '3:4', '16:9', '9:16'], '1:1')] },
  { id: 'wan-2.7-pro',       label: 'Wan 2.7 Pro',        kind: 'image', group: 'Wan', maxRefs: 4, ticketCost: 4,
    strengths: 'painterly + illustrative styles, strong East-Asian aesthetics, reliable img2img editing',
    fields: [A('AR', ['1:1', '4:3', '16:9', '3:4', '9:16'], '1:1')] },
  { id: 'flux-1-dev',        label: 'FLUX 1 Dev',         kind: 'image', group: 'Black Forest Labs', maxRefs: 1, ticketCost: 2,
    strengths: 'classic FLUX look — crisp graphic compositions, posters, concept art; single ref img2img',
    fields: [A('AR', ['1:1', '16:9', '9:16', '4:3', '3:4'], '1:1'), Q(['1k', '2k', '4k'], '2k')] },
  { id: 'flux-2',            label: 'FLUX 2',             kind: 'image', group: 'Black Forest Labs', maxRefs: 4, ticketCost: 1,
    strengths: 'cheapest capable all-rounder (1 ticket) — drafts, iterations, exploring variations before a premium final',
    guide: 'Natural language, never keyword lists. Core subject FIRST — it prioritizes early information. Exact colors as HEX codes ("#0e0e18 background"); for complex scenes use structured, hierarchical descriptions.',
    fields: [A('AR', ['1:1', '4:5', '9:16', '16:9'], '1:1')] },
  { id: 'gpt-image-2',       label: 'ChatGPT Images 2.0', kind: 'image', group: 'OpenAI', maxRefs: 8, ticketCost: 3,
    strengths: 'best instruction comprehension for complex multi-step edit requests. PREFERRED for images containing text (headlines, UI, posters, logos)',
    guide: 'Structure prompts as labeled sections with linebreaks: Scene / Subject / Important details / Use case / Constraints. Concrete visual facts, never vague praise ("overcast daylight", "brushed aluminum", "50mm feel" — not "stunning"). Literal text in quotes marked EXACT TEXT with font/placement + "no extra words, no text artifacts". Edits: separate Change vs Preserve lists, repeat the Preserve list every iteration, ONE revision per turn. Multi-image: label roles ("Image 1: base scene. Image 2: jacket reference.") and refer to labels.',
    fields: [A('Size', ['1024x1024', '1024x768', '1024x1536', '1920x1080', '2560x1440', '3840x2160'], '1024x1024'), Q(['low', 'medium', 'high'], 'medium')] },
  { id: 'z-image-base',      label: 'Z-Image Base',       kind: 'image', group: 'Z-Image', maxRefs: 0, ticketCost: 1, noRefs: true,
    strengths: 'ultra-cheap text-to-image, surprisingly strong realism — bulk drafts; takes NO refs',
    fields: [A('AR', ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'], '1:1'), Q(['1k', '2k', '4k'], '2k')] },
  { id: 'z-image-turbo',     label: 'Z-Image Turbo',      kind: 'image', group: 'Z-Image', maxRefs: 1, ticketCost: 1,
    strengths: 'fastest generation in the studio — instant previews, quick img2img restyles',
    fields: [A('AR', ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'], '1:1'), Q(['1k', '2k', '4k'], '2k')] },
  // ── Video ── (taskbar Video dropdown order)
  { id: 'kling-v3',          label: 'Kling 3.0',          kind: 'video', group: 'Kling', maxRefs: 2, ticketCost: 30, needsRef: true, endFrame: true,
    strengths: 'BEST FOR: hero beats, dialogue, real physics, deliberate camera moves. The only reliable START+END frame control (2nd ref = end frame), which is what makes shot-to-shot continuity chaining possible. Native audio with lip sync. WEAK AT: cost, only 2 references, and CHARACTER DRIFT UNDER MOVEMENT \u2014 the more the subject moves, the faster the face and wardrobe wander off the reference. A start frame alone is fine for a stationary subject, a camera pull-back or a landscape move; for any shot where a character MOVES A LOT, pass an end frame as well and the character holds across the whole clip. PERMISSIVE: no known likeness or IP refusals.',
    guide: 'Direct like a cinematographer: scene descriptions with ACTIVE verbs ("walks", "billows"), explicit camera moves ("slow push-in", "tracking shot", "dolly zoom") — no camera direction = static shot. Short punchy sentences, one action each; no keyword lists. 3-6s is the coherence sweet spot (max 15s). Ref 1 = start frame; optional ref 2 = end frame — it animates from start toward end (morphs, transitions, loops).',
    fields: [D(SECONDS(3, 15), '5'), A('AR', ['16:9', '9:16', '1:1'], '16:9'), AUDIO] },
  { id: 'kling-v3-motion',   label: 'Kling V3 Motion',    kind: 'video', group: 'Kling', maxRefs: 0, ticketCost: 0, disabled: 'needs a motion video input' },
  { id: 'seedance-1.5',      label: 'SeeDance 1.5',       kind: 'video', group: 'ByteDance', maxRefs: 2, ticketCost: 6, endFrame: true,
    strengths: 'BEST FOR: drafts, proof-of-story passes, establishing plates, inserts and cutaways. The cheapest way to find out whether a sequence works before committing budget. Supports START+END frame (2nd ref = end frame). WEAK AT: fine detail and faces held close. REFUSES: recognisable real people and owned franchise characters (ByteDance filter, no override).',
    fields: [D(SECONDS(4, 12), '5'), R(['480p', '720p', '1080p'], '720p'), A('AR', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], '16:9'), AUDIO] },
  { id: 'seedance-2.0',      label: 'SeeDance 2.0',       kind: 'video', group: 'ByteDance', maxRefs: 9, ticketCost: 75,
    strengths: 'BEST FOR: THE HARDEST SHOTS IN THE FILM — characters moving through a scene, fighting, running, climbing, reaching, reacting; several characters staged and interacting in one frame; and MULTI-PART shots where the action changes partway (label the beats "Shot 1: … Shot 2: …" in one prompt and it cuts them for you). Nine references addressed @Image1-@Image9, so it is also the strongest way to RE-ANCHOR a whole cast from stills. Cinematic detail, native synced audio. DO NOT WASTE IT on a slow push over a landscape — a cheap model does that just as well; spend this where PERFORMANCE and complex motion decide the shot. WEAK AT: no end-frame control, so it cannot land on a planned pose. REFUSES: reference images that read as a RECOGNISABLE REAL PERSON, and owned franchise characters named in the prompt. The filter judges what is VISIBLE, so a shot framed without the restricted face is fair game — see the filter-safe framing rules.',
    guide: 'References by tag in prompt order: "@Image1 is the hero product… styled like @Image2" (up to 9; ref videos/audio are portal-only). Multi-shot: label cuts "Shot 1: … Shot 2: …" — ONE action + ONE camera move per shot; labels create cut points, unlabeled = continuous take. Prompt order: subject+action → camera (real cinematography terms) → explicit sound cues (audio is native + synced) → transitions. 2-4 sentences single shot, 4-8 multi-shot. Duration 4-15s or auto.',
    fields: [D(['auto', ...SECONDS(4, 15)], 'auto'), R(['480p', '720p'], '720p'), A('AR', ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'auto'), AUDIO] },
  { id: 'seedance-2.0-fast', label: 'SeeDance 2.0 Fast',  kind: 'video', group: 'ByteDance', maxRefs: 9, ticketCost: 60,
    strengths: 'BEST FOR: the same character action, multi-character staging and multi-part shots as 2.0, when speed and cost matter more than the last tenth of the detail. The sensible default for mid-sequence coverage — use it to give ordinary action beats a capable engine instead of demoting them to a weak one. WEAK AT: same lack of end-frame control. REFUSES: the same ByteDance filter as 2.0, judged on what is visible in frame.',
    guide: 'Same prompting rules as seedance-2.0.',
    fields: [D(['auto', ...SECONDS(4, 15)], 'auto'), R(['480p', '720p'], '720p'), A('AR', ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'auto'), AUDIO] },
  { id: 'seedance-2.5',      label: 'SeeDance 2.5',      kind: 'video', group: 'ByteDance', maxRefs: 9, ticketCost: 90, admin: true,
    strengths: 'BEST FOR: everything 2.0 does — character movement, action, multi-character staging, multi-part shots — at the highest quality in the catalog, plus 1080p. This is the model to spend on the shots the film is judged by: the opening, the turn, the climax. Nine references (@Image1-@Image9). It is equally strong on plates, weather, water and effects, but picking it ONLY for a gentle landscape move spends the most capable engine you have on the easiest shot in the film. WEAK AT: no end-frame control, and it is expensive. REFUSES: the same ByteDance filter as 2.0 — judged on what is VISIBLE in the frame, not on who the character is in the story. ADMIN ONLY.',
    guide: 'Same prompting rules as seedance-2.0. Reach for this on plates, environments and effects — especially animating a still you just generated.',
    fields: [D(['auto', ...SECONDS(4, 12)], 'auto'), R(['480p', '720p', '1080p'], '1080p'), A('AR', ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'auto'), AUDIO] },
  { id: 'gemini-omni-flash', label: 'Gemini Omni Flash',  kind: 'video', group: 'Google', maxRefs: 9, ticketCost: 120, admin: true,
    strengths: 'BEST FOR: text-to-video with no plate at all, single-image animation, or blending several references into one look. Native synced audio. WEAK AT: locked to 3-10s and 16:9 or 9:16 only. Google screens inputs, so treat a real-person cast as risky here too. ADMIN ONLY.',
    guide: 'With 2+ refs, bind them inline as <IMAGE_REF_0>, <IMAGE_REF_1>… (0-INDEXED, unlike SeeDance\'s @Image1). One ref = true start frame. Keep prompts cinematic: subject+action → camera → sound cues. Duration is an integer 3-10s (no auto).',
    fields: [D(SECONDS(3, 10), '8'), A('AR', ['16:9', '9:16'], '16:9')] },
  { id: 'wan-2.5',           label: 'Wan 2.5',            kind: 'video', group: 'Wan', maxRefs: 1, ticketCost: 13, needsRef: true,
    strengths: 'BEST FOR: animating an existing plate at mid cost, with prompt expansion filling in motion detail. Landscapes, environments, products, atmosphere. WEAK AT: one reference only, no end frame, so it cannot chain or hold a multi-character scene. PERMISSIVE: the safety checker is honoured, making it a safe fallback when a strict provider refuses the cast.',
    fields: [D(['5', '10'], '5'), R(['480p', '720p', '1080p'], '720p')] },
  { id: 'lipsync-v3',        label: 'Lipsync v3',         kind: 'video', group: 'Lipsync', maxRefs: 0, ticketCost: 0, disabled: 'needs video + audio inputs' },
  { id: 'happy-horse',       label: 'Happy Horse',        kind: 'video', group: 'Alibaba', maxRefs: 1, ticketCost: 35, needsRef: true,
    strengths: 'BEST FOR: expressive character performance from ONE still, such as reactions, gestures, a face carrying a beat. WEAK AT: single reference, no end frame, not a camera-move model. Good cheap coverage between hero shots.',
    fields: [D(SECONDS(3, 15), '5'), R(['720p', '1080p'], '720p')] },
]

// Every video model the SITE ships that the list above does not already
// describe by hand. The hub used to carry nine entries against the studio's
// thirty-one, so most of the roster was simply unreachable from chat and each
// new model had to be remembered in two places. Video submits through
// /api/video/generate, which owns the endpoints and the admin gate, so a
// derived entry is enough to make a model usable. Hand-written entries win —
// their strengths/guide text is better than anything generated.
for (const v of CHAT_VIDEO_MODELS) {
  if (!CHAT_CREATE_MODELS.some(m => m.id === v.id)) {
    CHAT_CREATE_MODELS.push(v as ChatCreateModel)
  }
}

// Same for images, now that they submit through /api/generate too. The
// hand-written entries above keep their curated strengths/guide text; the rest
// of the studio's roster is derived so a model added to the site shows up here
// without being remembered twice.
for (const i of CHAT_IMAGE_MODELS) {
  if (!CHAT_CREATE_MODELS.some(m => m.id === i.id)) {
    CHAT_CREATE_MODELS.push(i as ChatCreateModel)
  }
}

// Ticket cost of the LLM's generate_image tool (NanoBanana Pro at 2K)
export const CHAT_TOOL_IMAGE_COST = 7

export function getCreateModel(id: string): ChatCreateModel | undefined {
  return CHAT_CREATE_MODELS.find(m => m.id === id)
}

// Admin gate for the catalog. The chat hub is entirely admin-only today
// (requireChatHubAdmin), so callers pass true — but every consumer routes
// through this so opening the hub to non-admins later is a one-flag change.
export function usableCreateModels(isAdmin: boolean): ChatCreateModel[] {
  return CHAT_CREATE_MODELS.filter(m => isAdmin || !m.admin)
}

const PROVIDER_APP_NAME: Record<ChatHubProvider, string> = {
  Anthropic: 'the Claude app',
  OpenAI: 'ChatGPT',
  Google: 'the Gemini app',
  xAI: 'Grok',
}

// Built-in "app-style" instruction template. Raw API models answer tersely by
// default because consumer apps (Gemini app, ChatGPT, Claude) inject their own
// system prompts — this recreates that behavior.
export function appStyleInstructions(model: ChatHubModel): string {
  return `You are ${model.label}, running inside a chat application. Respond the way you would in ${PROVIDER_APP_NAME[model.provider]}:
- Be thorough and detailed by default. Prefer complete, well-developed answers over terse ones.
- Structure longer answers with markdown headings, bullet points, and numbered steps where they help readability.
- Use a warm, conversational tone. It's good to open with a brief direct answer, then expand.
- Match depth to the question: brief for trivial questions, comprehensive for open-ended ones.
- Put code in fenced code blocks. Offer natural follow-up suggestions when they would genuinely help.`
}

// ── Agent capabilities catalog ───────────────────────────────────────────────
// Single source of truth for what the orchestrator can do — rendered in
// Profile → Chat Settings → "Agent Tools & Capabilities". KEEP THIS UPDATED
// whenever the orchestrator gains or loses a tool.
export type AgentCapability = {
  id: string
  name: string
  description: string
  approval: 'always-ask' | 'ask-mode' | 'auto'
  cost: string
}

export const AGENT_CAPABILITIES: AgentCapability[] = [
  {
    id: 'delegate_task',
    name: 'Delegate to other models',
    description: 'Hands a subtask to any model in the roster (auto or your manual list, plus custom Hub models) and folds the answer into its reply — including vision tasks like critiquing a generated frame (it can attach conversation images to the delegate).',
    approval: 'ask-mode',
    cost: 'API usage on the target model\'s key',
  },
  {
    id: 'create_media',
    name: 'Generate images & video (with chaining)',
    description: 'Uses the studio\'s media models (NanoBanana, SeeDream, FLUX, Kling, SeeDance…) with recommended or user-tweaked settings. Sees its own results afterwards and can iterate: regenerate with different settings/models, feed a generated or edited image into an image-to-video model, or edit outputs and reuse them as references. Every generation still pauses for approval.',
    approval: 'always-ask',
    cost: 'Tickets (shown before approval)',
  },
  {
    id: 'render_shots',
    name: 'Render a whole shot list (Movie Studio)',
    description: 'Submits every shot of a film in one call, each with its own model, prompt, settings and references, so a sequence is not rendered one model step at a time. Renders continue on the server after the reply ends and are settled automatically.',
    approval: 'always-ask',
    cost: 'Tickets per shot (summed before approval)',
  },
  {
    id: 'check_shots',
    name: 'Check shots + extract frames (Movie Studio)',
    description: 'Reports which submitted shots have landed and extracts the MID and LAST frame of each. The agent cannot watch video, so those frames are how it judges a shot — and a LAST frame becomes the start image of the next chained shot.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'assemble_film',
    name: 'Cut and score the film (Movie Studio)',
    description: 'Stitches approved shots into one MP4 (normalising size, frame rate and pixel aspect, and synthesising silence for shots with no audio track), and mixes a music bed or voiceover over the cut. ffmpeg only — no model runs.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'create_audio',
    name: 'Music, voiceover and foley (Movie Studio)',
    description: 'Generates a music bed, a spoken line, or sound scored to an existing clip, for mixing over the finished cut.',
    approval: 'always-ask',
    cost: 'Tickets (shown before approval)',
  },
  {
    id: 'edit_image',
    name: 'Edit images (Photoshop-style)',
    description: 'Programmatic edits on any image in the conversation — or on a blank canvas for composition/pose blocking sketches it then uses as generation references. Crop, resize, rotate, flip, grayscale, blur + regional blur, sharpen, brightness/saturation/hue, tint, rounded corners, vignette, canvas extension/borders, exact-text overlay (6 fonts, any color, outlines), vector shapes with gradients (scrims, badges, dividers, sketches), and image overlay with opacity + blend modes. Up to 20 chained ops per edit.',
    approval: 'ask-mode',
    cost: 'Free',
  },
  {
    id: 'search_refs',
    name: 'Browse your reference library',
    description: 'Lists your saved references (filtered by folder name) and can feed them into generations and edits.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'dataset',
    name: 'Browse dataset & buckets (admin)',
    description: 'Admin accounts only: browses the dataset page\'s folders and buckets read-only and pulls curated bucket images into edits and generations. Non-admin accounts have no access at all — the tool refuses them server-side.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'dataset_edit',
    name: 'Change dataset & buckets (admin)',
    description: 'Admin accounts only: creates buckets/folders, files generations into buckets, toggles training marks, moves buckets. EVERY change pauses for your explicit approval — nothing is modified without a yes. Training export itself still runs from the dataset page.',
    approval: 'always-ask',
    cost: 'Free',
  },
  {
    id: 'web_search',
    name: 'Web search',
    description: 'Live web answers with sources (Google-grounded) for current events and facts.',
    approval: 'auto',
    cost: 'Google API usage (free tier)',
  },
  {
    id: 'save_memory',
    name: 'Project memory',
    description: 'Reads and updates persistent notes shared by every chat in a project — long-running projects accumulate knowledge. (Chats outside projects have no memory.)',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'remember',
    name: 'Global memory',
    description: 'Saves short durable facts (brand colors, voice, preferences) to your account-wide memory — every chat sees them, and you can view/edit/delete entries in the Memory panel.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'load_skill',
    name: 'On-demand skill playbooks',
    description: 'Skills keep only a short summary in context; when the work actually needs a craft playbook (design rules, prompting guides, ad/film/style systems), the model loads it mid-run — you pay for knowledge only when it\'s used.',
    approval: 'auto',
    cost: 'Free (playbook tokens only when loaded)',
  },
  {
    id: 'publish_instagram',
    name: 'Publish to Instagram',
    description: 'Publishes a finished image or reel with a caption to your connected Instagram professional account. ALWAYS pauses for your explicit approval — the approval card shows the exact media and caption before anything ships.',
    approval: 'always-ask',
    cost: 'Free (IG rate limit ~100 posts/day)',
  },
  {
    id: 'propose_plan',
    name: 'One-tap plan approval',
    description: 'Plans media/multi-step work up front (after a clarifying quiz when needed): summary, numbered steps, and the summed ticket cost — approved in one tap. In-budget generations then run automatically with no per-step approvals; failures or scope changes come back as plan-update approvals for just the additional tickets.',
    approval: 'always-ask',
    cost: 'The plan\'s summed ticket budget',
  },
  {
    id: 'edit_instructions',
    name: 'Edit instructions & presets',
    description: 'Can rewrite the current chat\'s standing instructions (persona) or save a named instructions preset to your library — always shows you the proposed text and waits for your approval first.',
    approval: 'always-ask',
    cost: 'Free',
  },
  {
    id: 'ask_user',
    name: 'Clarifying quiz',
    description: 'When your request is ambiguous, the model can pop a short multiple-choice quiz (1-4 questions) in the approval bar so the output matches exactly what you want.',
    approval: 'always-ask',
    cost: 'Free',
  },
  {
    id: 'write_summary',
    name: 'Closing summary card',
    description: 'Ends every multi-step run with a dedicated Summary card at the bottom of the reply — what was done, what was produced, models used, tickets spent, and next options — instead of burying the recap in flowing text.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'record_evaluation',
    name: 'Structured image evaluations',
    description: 'After every generation or edit, the model inspects the result and records a dedicated evaluation card with a pass/revise verdict and notes — so quality checks are visible steps, not buried in reply text.',
    approval: 'auto',
    cost: 'Free',
  },
  {
    id: 'compaction',
    name: 'Long-chat auto-compaction',
    description: 'Past 40 messages, older history is automatically summarized and kept in context, so long conversations don\'t forget their beginnings.',
    approval: 'auto',
    cost: 'One cheap summarize call per ~30 messages',
  },
]
