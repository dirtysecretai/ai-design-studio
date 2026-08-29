// ── Ticket pricing: ONE source of truth ──────────────────────────────────────
// The per-generation video ticket cost used to live inline in
// app/api/video/generate/route.ts. It is a BILLING path, so it now lives here
// as a pure function that both the route (which charges) and the admin Ticket
// Economics page (which reasons about margins) call. Every branch, constant and
// rounding rule below is a verbatim lift of the original route code — if you
// change a number here you change what users are charged.
//
// Ticket pack prices also live here so the shop page and the economics page
// cannot drift apart.

/** Video tools take a source clip instead of generating one. */
export const VIDEO_TOOL_MODELS = new Set([
  'flux-video-upscale', 'topaz-upscale-precision', 'topaz-upscale-creative',
  'topaz-upscale-generative', 'seedvr2-video', 'flashvsr-video',
  'bytedance-video-upscale', 'topaz-colorize', 'topaz-deblur',
  'topaz-interpolate', 'topaz-sdr-to-hdr',
])

/**
 * Families whose endpoint is chosen by the inputs given rather than a mode
 * switch: references → r2v, a start image → i2v, otherwise t2v.
 */
export const INPUT_ROUTED_MODELS = new Set([
  'wan-3.0', 'wan-3.0-prime', 'seedance-2.5', 'gemini-omni-1.1', 'ltx-2.5-pro', 'ltx-2.5-fast',
])

export interface VideoTicketCostInput {
  model: string
  /** '5', '10', 'auto', … — same shape the API body carries. Default '5'. */
  duration?: string | number
  /** '480p' | '720p' | '1080p' | … Default '1080p'. */
  resolution?: string
  generateAudio?: boolean
  /** Raw client mode ('t2v' | 'i2v' | 'r2v' | 'edit'). Default 't2v'. */
  sd20Mode?: string
  /** Mode after the route's start-image auto-detection. Defaults to sd20Mode. */
  effectiveSd20Mode?: string
  /** How many reference videos were supplied (0 when the field was absent). */
  referenceVideoCount?: number
  referenceVideoDurationSec?: number
  editVideoDurationSec?: number
  lipsyncVideoDurationSec?: number
  motionVideoDurationSec?: number
  /** 'image' | 'video' — only used as the kling-v3-motion duration fallback. */
  characterOrientation?: string
  videoUpscaleFactor?: string | number
}

/**
 * Tickets charged for one video generation. Extracted verbatim from
 * app/api/video/generate/route.ts — keep the two in lockstep.
 */
export function videoTicketCost(input: VideoTicketCostInput): number {
  const model = input.model
  const duration = String(input.duration ?? '5')
  const resolution = input.resolution ?? '1080p'
  const generateAudio = !!input.generateAudio
  const sd20Mode = input.sd20Mode ?? 't2v'
  const effectiveSd20Mode = input.effectiveSd20Mode ?? sd20Mode
  const referenceVideoCount = input.referenceVideoCount ?? 0
  const referenceVideoDurationSec = input.referenceVideoDurationSec ?? 0
  const editVideoDurationSec = input.editVideoDurationSec ?? 0
  const lipsyncVideoDurationSec = input.lipsyncVideoDurationSec ?? 0
  const motionVideoDurationSec = input.motionVideoDurationSec
  const characterOrientation = input.characterOrientation ?? 'image'
  const videoUpscaleFactor = String(input.videoUpscaleFactor ?? '2')

  const isLipsync = model === 'lipsync-v3'
  const isWanLora = model === 'wan-2.2-lora'

  let ticketCost: number
  if (isLipsync) {
    ticketCost = Math.max(10, Math.ceil((lipsyncVideoDurationSec || 0) * 6));
  } else if (model === 'kling-v3-motion') {
    // 6 tickets/sec × actual video duration (or max if unknown)
    const fallbackSec = characterOrientation === 'video' ? 30 : 10;
    const sec = motionVideoDurationSec ? Math.ceil(motionVideoDurationSec) : fallbackSec;
    ticketCost = sec * 6;
  } else if (model === 'kling-o3') {
    const pricing: Record<string, number> = {
      '3': 15, '4': 18, '5': 20, '6': 24, '7': 28,
      '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
      '13': 52, '14': 56, '15': 60,
    };
    ticketCost = pricing[duration] || 20;
  } else if (model === 'kling-v3') {
    ticketCost = parseInt(duration) * (generateAudio ? 8 : 6);
  } else if (model === 'seedance-1.5') {
    const resMultiplier = resolution === '1080p' ? 2.25 : resolution === '480p' ? 0.5 : 1.0
    const audioMultiplier = generateAudio ? 1.0 : 0.5
    ticketCost = Math.ceil(parseInt(duration) * 2.0 * resMultiplier * audioMultiplier) + 1
  } else if (model === 'seedance-2.0') {
    // fal's SeeDance 2.0 has no 1080p (480p/720p only) — 720p is the 1.0x base
    const resMultiplier = resolution === '480p' ? 0.5 : 1.0
    const hasVideoRefs = sd20Mode === 'r2v' && referenceVideoCount > 0
    const videoInputMultiplier = hasVideoRefs ? 0.6 : 1.0
    const outputDurSec = duration === 'auto' ? 5 : parseInt(duration)
    const effectiveDur = outputDurSec + (hasVideoRefs ? (referenceVideoDurationSec || 0) : 0)
    ticketCost = Math.ceil(effectiveDur * 15 * resMultiplier * videoInputMultiplier)
  } else if (model === 'seedance-2.0-fast') {
    // 12 tickets/sec at 720p; 480p = 0.5x
    const resMultiplier = resolution === '480p' ? 0.5 : 1.0
    const hasVideoRefs = sd20Mode === 'r2v' && referenceVideoCount > 0
    const videoInputMultiplier = hasVideoRefs ? 0.6 : 1.0
    const outputDurSec = duration === 'auto' ? 5 : parseInt(duration)
    const effectiveDur = outputDurSec + (hasVideoRefs ? (referenceVideoDurationSec || 0) : 0)
    ticketCost = Math.ceil(effectiveDur * 12 * resMultiplier * videoInputMultiplier)
  } else if (model === 'gemini-omni-flash') {
    // PLACEHOLDER ≈ SeeDance 2.0 (15 tickets/sec); no resolution knob on this model
    const sec = effectiveSd20Mode === 'edit'
      ? Math.max(3, Math.ceil(editVideoDurationSec || 8))
      : (parseInt(duration) || 8);
    ticketCost = sec * 15;
  } else if (model === 'wan-2.7') {
    // PLACEHOLDER — modeled on Wan 2.5's per-second rates (1080p 20/5s = 4/s,
    // 720p 13/5s = 2.6/s). ADMIN ONLY until priced manually.
    const sec = parseInt(duration) || 5;
    ticketCost = Math.ceil(sec * (resolution === '1080p' ? 4 : 2.6));
  } else if (isWanLora) {
    // PLACEHOLDER — ADMIN ONLY until priced. A14B renders ~81 frames @16fps ≈ 5s
    const sec = Math.ceil((parseInt(duration) || 5));
    ticketCost = Math.ceil(sec * (resolution === '720p' ? 4 : 2.6));
  } else if (VIDEO_TOOL_MODELS.has(model)) {
    // PLACEHOLDER — ADMIN ONLY until priced. Billed against the SOURCE clip's
    // length, since that is what these process.
    const sec = Math.max(1, Math.ceil(editVideoDurationSec || 5));
    const factor = Math.max(1, Math.min(4, parseFloat(videoUpscaleFactor) || 2));
    ticketCost = Math.ceil(sec * 2 * factor);
  } else if (INPUT_ROUTED_MODELS.has(model)) {
    // PLACEHOLDER — ADMIN ONLY until priced. Scaled by resolution the same
    // way the other per-second models are.
    const sec = duration === 'auto' ? 5 : Math.min(20, Math.max(3, parseInt(duration) || 5));
    const perSec = resolution === '4k' ? 9 : resolution === '2160p' ? 9
      : resolution === '1440p' ? 6 : resolution === '1080p' ? 4.5
      : resolution === '720p' ? 3 : 2;
    ticketCost = Math.ceil(sec * perSec);
  } else if (model === 'minimax-h3-max') {
    // PLACEHOLDER — ADMIN ONLY. fal lists $0.025/s at 480P and $0.04/s at
    // 768P (promotional), so this mirrors the shape of Wan 2.7's rates.
    const sec = Math.min(15, Math.max(5, parseInt(duration) || 5));
    ticketCost = Math.ceil(sec * (resolution === '480p' ? 2 : 3.2));
  } else if (model === 'flux-3') {
    // PLACEHOLDER — ADMIN ONLY. Priced above Wan 2.7 since it renders audio.
    const sec = duration === 'auto' ? 5 : Math.min(20, Math.max(5, parseInt(duration) || 5));
    ticketCost = Math.ceil(sec * (resolution === '1080p' ? 6 : 4));
  } else if (model === 'happy-horse') {
    ticketCost = parseInt(duration) * (resolution === '1080p' ? 12 : 7);
  } else {
    const pricing: Record<string, Record<string, number>> = {
      '480p':  { '5': 7,  '10': 14 },
      '720p':  { '5': 13, '10': 26 },
      '1080p': { '5': 20, '10': 40 },
    };
    ticketCost = pricing[resolution]?.[duration] || 20;
  }
  return ticketCost
}

/**
 * Tickets charged to a Dev-Tier subscriber.
 *
 * There is deliberately no discount here: /api/video/generate accepts a
 * `hasDevTier` flag in its body and never reads it, so every tier is billed the
 * same amount. See DEV_TIER_PRICING_NOTES for the one stale UI that still
 * *displays* a dev rate.
 */
export function videoTicketCostDev(input: VideoTicketCostInput): number {
  return videoTicketCost(input)
}

/**
 * Per-model warnings about tier pricing. Only models with a real caveat appear.
 */
export const DEV_TIER_PRICING_NOTES: Record<string, string> = {
  'kling-v3':
    'The legacy /admin/video-scanner-kling-o3 page displays 4/sec (3/sec dev) for Kling 3.0, ' +
    'but the billing route and portal-v2 both charge 6/sec (8/sec with audio) for every tier. ' +
    'The display is stale, not a discount.',
}

// ── Ticket packs ─────────────────────────────────────────────────────────────
// Dev Tier discount is 10% (cut from 20/30% on 2026-07-29 — keep in sync with
// the subscribe page, shop dropdown, and dashboard copy)
export interface TicketPackage {
  tickets: number
  freeTierPrice: number
  devTierPrice: number
  popular?: boolean
  bestValue?: boolean
}

export const TICKET_PACKAGES: TicketPackage[] = [
  { tickets: 25,   freeTierPrice: 5.00,   devTierPrice: 4.50  },
  { tickets: 50,   freeTierPrice: 9.00,   devTierPrice: 8.10,  popular: true  },
  { tickets: 100,  freeTierPrice: 16.00,  devTierPrice: 14.40 },
  { tickets: 250,  freeTierPrice: 35.00,  devTierPrice: 31.50 },
  { tickets: 500,  freeTierPrice: 65.00,  devTierPrice: 58.50, bestValue: true },
  { tickets: 1000, freeTierPrice: 120.00, devTierPrice: 108.00 },
]

/** USD a single ticket cost the buyer, per pack and tier. */
export function usdPerTicket(pack: TicketPackage, tier: 'free' | 'dev'): number {
  return (tier === 'dev' ? pack.devTierPrice : pack.freeTierPrice) / pack.tickets
}

// ── Video model catalogue for the economics page ─────────────────────────────
// Only UI affordances live here (which knobs a row shows). Cost always comes
// from videoTicketCost() above.

export type VideoDurationSource = 'none' | 'lipsync' | 'motion' | 'source-clip'

export interface VideoModelPricingSpec {
  id: string
  label: string
  kind: 'generator' | 'tool'
  /** Duration choices offered on the row; empty when duration is not a knob. */
  durations: string[]
  /** Resolution choices offered on the row; empty when resolution is ignored. */
  resolutions: string[]
  supportsAudio: boolean
  /** Where the billed seconds come from when it is not the duration dropdown. */
  durationSource: VideoDurationSource
  /** Show the 1x-4x upscale factor knob (video tools only). */
  showUpscaleFactor?: boolean
  note?: string
}

const RES_STD = ['480p', '720p', '1080p']
const DUR_5_10 = ['5', '10']

export const VIDEO_MODEL_SPECS: VideoModelPricingSpec[] = [
  { id: 'wan-2.5',            label: 'Wan 2.5',                kind: 'generator', durations: DUR_5_10,                         resolutions: RES_STD,                  supportsAudio: false, durationSource: 'none', note: 'Falls through to the default 480/720/1080 × 5/10 table; anything off that table is 20 tickets.' },
  { id: 'wan-2.7',            label: 'Wan 2.7',                kind: 'generator', durations: DUR_5_10,                         resolutions: ['720p', '1080p'],        supportsAudio: false, durationSource: 'none', note: 'PLACEHOLDER pricing — admin only.' },
  { id: 'wan-2.2-lora',       label: 'Wan 2.2 LoRA',           kind: 'generator', durations: ['5', '10'],                      resolutions: ['480p', '720p'],         supportsAudio: false, durationSource: 'none', note: 'PLACEHOLDER pricing — admin only.' },
  { id: 'wan-3.0',            label: 'Wan 3.0',                kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p', '1440p', '2160p', '4k'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'wan-3.0-prime',      label: 'Wan 3.0 Prime',          kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p', '1440p', '2160p', '4k'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'kling-v3',           label: 'Kling 3.0 Pro',          kind: 'generator', durations: DUR_5_10,                         resolutions: [],                       supportsAudio: true,  durationSource: 'none' },
  { id: 'kling-o3',           label: 'Kling O3',               kind: 'generator', durations: ['3','4','5','6','7','8','9','10','11','12','13','14','15'], resolutions: [], supportsAudio: false, durationSource: 'none', note: 'Flat table by duration; an unlisted duration bills 20.' },
  { id: 'kling-v3-motion',    label: 'Kling 3.0 Motion',       kind: 'generator', durations: [],                               resolutions: [],                       supportsAudio: false, durationSource: 'motion', note: '6 tickets/sec of the motion reference clip. Unknown length falls back to 10s (30s when the character orientation is "video").' },
  { id: 'seedance-1.5',       label: 'SeeDance 1.5 Pro',       kind: 'generator', durations: ['3','5','8','10','12'],          resolutions: RES_STD,                  supportsAudio: true,  durationSource: 'none' },
  { id: 'seedance-2.0',       label: 'SeeDance 2.0',           kind: 'generator', durations: ['auto','3','5','8','10','12'],   resolutions: ['480p', '720p'],         supportsAudio: false, durationSource: 'none', note: 'r2v with video references: 0.6x multiplier, but the reference seconds are added to the billed duration.' },
  { id: 'seedance-2.0-fast',  label: 'SeeDance 2.0 Fast',      kind: 'generator', durations: ['auto','3','5','8','10','12'],   resolutions: ['480p', '720p'],         supportsAudio: false, durationSource: 'none', note: 'Same shape as SeeDance 2.0 at 12 tickets/sec.' },
  { id: 'seedance-2.5',       label: 'SeeDance 2.5',           kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p', '1440p', '2160p', '4k'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'gemini-omni-flash',  label: 'Gemini Omni Flash',      kind: 'generator', durations: ['4', '6', '8', '10', '12'],      resolutions: [],                       supportsAudio: false, durationSource: 'none', note: 'PLACEHOLDER 15 tickets/sec. In edit mode the SOURCE clip length is billed (min 3s, 8s when unknown).' },
  { id: 'gemini-omni-1.1',    label: 'Gemini Omni Flash 1.1',  kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p', '1440p', '2160p', '4k'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'minimax-h3-max',     label: 'MiniMax H3 Max',         kind: 'generator', durations: ['5', '8', '10', '15'],           resolutions: ['480p', '768p'],         supportsAudio: false, durationSource: 'none', note: 'PLACEHOLDER — seconds clamped to 5-15.' },
  { id: 'flux-3',             label: 'FLUX 3 Video',           kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['720p', '1080p'],        supportsAudio: false, durationSource: 'none', note: 'PLACEHOLDER — seconds clamped to 5-20.' },
  { id: 'ltx-2.5-pro',        label: 'LTX 2.5 Pro',            kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'ltx-2.5-fast',       label: 'LTX 2.5 Fast',           kind: 'generator', durations: ['auto', '5', '10', '15', '20'],  resolutions: ['480p', '720p', '1080p', '1440p', '2160p'], supportsAudio: false, durationSource: 'none', note: 'Input-routed family — PLACEHOLDER pricing, admin only.' },
  { id: 'happy-horse',        label: 'Happy Horse',            kind: 'generator', durations: DUR_5_10,                         resolutions: ['720p', '1080p'],        supportsAudio: false, durationSource: 'none' },
  { id: 'lipsync-v3',         label: 'Lipsync v3',             kind: 'generator', durations: [],                               resolutions: [],                       supportsAudio: false, durationSource: 'lipsync', note: '6 tickets/sec of the source video, floor of 10 tickets.' },
  // ── Tools: billed against the source clip ──
  { id: 'flux-video-upscale',       label: 'FLUX Video Upscale',        kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-upscale-precision',  label: 'Topaz Upscale Precision',   kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-upscale-creative',   label: 'Topaz Upscale Creative',    kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-upscale-generative', label: 'Topaz Upscale Generative',  kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'seedvr2-video',            label: 'SeedVR2 Video',             kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'flashvsr-video',           label: 'FlashVSR Video',            kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'bytedance-video-upscale',  label: 'ByteDance Video Upscale',   kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-colorize',           label: 'Topaz Colorize',            kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-deblur',             label: 'Topaz Deblur',              kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-interpolate',        label: 'Topaz Interpolate',         kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
  { id: 'topaz-sdr-to-hdr',         label: 'Topaz SDR to HDR',          kind: 'tool', durations: [], resolutions: [], supportsAudio: false, durationSource: 'source-clip', showUpscaleFactor: true },
]
