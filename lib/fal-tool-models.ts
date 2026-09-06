/**
 * The fal models that are neither an image model nor a video model.
 *
 * Ticket Economics reads two catalogs — VIDEO_MODEL_SPECS and AI_MODELS — and
 * between them they cover every generation the user is CHARGED for. Everything
 * else this site calls has been invisible there: the audio the Movie Studio
 * scores a film with, the segmentation behind the reference masking tools, the
 * relight pass, face swap, transcription, LoRA training. All of it spends real
 * fal credit at zero tickets.
 *
 * This is that list, so the same page can price it. It is a PRICING catalog,
 * not a runtime one: nothing dispatches from here, so an entry going stale
 * costs a wrong row rather than a broken feature — but each one names the code
 * that actually calls it, which is what makes drift findable.
 */

export type ToolModelCategory = 'audio' | 'masking' | 'relight' | 'faceswap' | 'transcribe' | 'training' | 'threed'

export type FalToolModel = {
  /** Our id. Matches lib/audio-models.ts where one exists. */
  id: string
  label: string
  category: ToolModelCategory
  endpoint: string
  /** What it costs the user today. 0 = we eat the fal bill. */
  ticketCost: number
  /** Where it is called from, so a stale row can be traced. */
  usedBy: string
  notes: string
}

import { THREED_MODELS } from '@/lib/fal-3d-models'

const BASE_TOOL_MODELS: FalToolModel[] = [
  // ── audio: every one of these is free to the user right now ──────────────
  {
    id: 'lyria-2',
    label: 'Lyria 2',
    category: 'audio',
    endpoint: 'fal-ai/lyria2',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — default music bed',
    notes: 'Instrumental music from a prompt.',
  },
  {
    id: 'elevenlabs-music',
    label: 'ElevenLabs Music',
    category: 'audio',
    endpoint: 'fal-ai/elevenlabs/music',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — music with an exact length',
    notes: 'Priced per second of music in fal’s blurb, so length drives the cost.',
  },
  {
    id: 'elevenlabs-sfx',
    label: 'ElevenLabs Sound Effects',
    category: 'audio',
    endpoint: 'fal-ai/elevenlabs/sound-effects',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — standalone effects placed on the cut',
    notes: '0.5–22s per call. A film can make a dozen of these.',
  },
  {
    id: 'elevenlabs-tts',
    label: 'ElevenLabs TTS',
    category: 'audio',
    endpoint: 'fal-ai/elevenlabs/tts/multilingual-v2',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — narration',
    notes: 'Usually priced per character of text rather than per call.',
  },
  {
    id: 'minimax-speech',
    label: 'MiniMax Speech 02 HD',
    category: 'audio',
    endpoint: 'fal-ai/minimax/speech-02-hd',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — alternative voice set',
    notes: 'Alternative TTS.',
  },
  {
    id: 'mmaudio-v2',
    label: 'MMAudio v2',
    category: 'audio',
    endpoint: 'fal-ai/mmaudio-v2',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — scores a whole clip',
    notes: 'Video-to-audio: runs over a clip, so it is priced closer to a video model than an audio one.',
  },

  {
    id: 'sonilo-sfx',
    label: 'Sonilo Sound Effects',
    category: 'audio',
    endpoint: 'sonilo/v1.1/text-to-sound-effects',
    ticketCost: 0,
    usedBy: 'create_audio (Movie Studio) — default standalone effect',
    notes: 'fal publishes $0.0018 per second of output — the cheapest audio call on the site.',
  },

  // ── masking: behind the reference editor, offered free today ─────────────
  {
    id: 'evf-sam',
    label: 'EVF-SAM (prompted mask)',
    category: 'masking',
    endpoint: 'fal-ai/evf-sam',
    ticketCost: 0,
    usedBy: 'app/api/user/ref-mask — “Edit reference” masking WITH a prompt',
    notes: 'Text-prompted segmentation. One call per mask the user paints.',
  },
  {
    id: 'birefnet-v2',
    label: 'BiRefNet v2 (subject mask)',
    category: 'masking',
    endpoint: 'fal-ai/birefnet/v2',
    ticketCost: 0,
    usedBy: 'app/api/user/ref-mask (no prompt) + chat-hub cutouts',
    notes: 'Salient-subject mask. The default when no prompt is given.',
  },
  {
    id: 'sam2-image',
    label: 'SAM 2 (point/box mask)',
    category: 'masking',
    endpoint: 'fal-ai/sam2/image',
    ticketCost: 0,
    usedBy: 'chat-hub segmentation',
    notes: 'Point- and box-driven segmentation.',
  },

  // ── the rest ────────────────────────────────────────────────────────────
  {
    id: 'iclight-v2',
    label: 'IC-Light v2 (relight)',
    category: 'relight',
    endpoint: 'fal-ai/iclight-v2',
    ticketCost: 0,
    usedBy: 'relight tool (Movie Studio)',
    notes: 'Image relighting. Behaves like an image generation, so it should probably be priced like one.',
  },
  {
    id: 'lightx-relight',
    label: 'Light-X Relight (video)',
    category: 'relight',
    endpoint: 'fal-ai/lightx/relight',
    ticketCost: 0,
    usedBy: 'relight_video tool (Movie Studio)',
    notes: 'Relights FINISHED footage. fal publishes $0.10 per output video second — real money on a 60s film.',
  },
  {
    id: 'lightx-recamera',
    label: 'Light-X ReCamera (video)',
    category: 'relight',
    endpoint: 'fal-ai/lightx/recamera',
    ticketCost: 0,
    usedBy: 'recamera tool (Movie Studio)',
    notes: 'Re-shoots an existing clip on a new camera move. Also $0.10 per output video second.',
  },
  {
    id: 'face-swap',
    label: 'Face Swap',
    category: 'faceswap',
    endpoint: 'fal-ai/face-swap',
    ticketCost: 0,
    usedBy: 'Face Swap employee + chat-hub face swap',
    notes: 'One call per swapped face.',
  },
  {
    id: 'wizper',
    label: 'Wizper (transcription)',
    category: 'transcribe',
    endpoint: 'fal-ai/wizper',
    ticketCost: 0,
    usedBy: 'app/api/admin/transcribe',
    notes: 'Admin-only today, so the exposure is small — but it is priced per minute of audio.',
  },

  // ── training: the big-ticket items, all currently unbilled ───────────────
  {
    id: 'flux-lora-training',
    label: 'FLUX LoRA training',
    category: 'training',
    endpoint: 'fal-ai/flux-lora-fast-training',
    ticketCost: 0,
    usedBy: 'LoRA trainer',
    notes: 'Priced per training run, and far more expensive than any single generation.',
  },
  {
    id: 'flux-2-trainer',
    label: 'FLUX 2 trainer',
    category: 'training',
    endpoint: 'fal-ai/flux-2-trainer',
    ticketCost: 0,
    usedBy: 'LoRA trainer',
    notes: 'Per run.',
  },
  {
    id: 'wan-22-trainer',
    label: 'Wan 2.2 video trainer',
    category: 'training',
    endpoint: 'fal-ai/wan-22-trainer',
    ticketCost: 0,
    usedBy: 'Wan LoRA pipeline (video)',
    notes: 'Video LoRA training — the most expensive call on the site.',
  },
  {
    id: 'wan-22-image-trainer',
    label: 'Wan 2.2 image trainer',
    category: 'training',
    endpoint: 'fal-ai/wan-22-image-trainer',
    ticketCost: 0,
    usedBy: 'Wan LoRA pipeline (image)',
    notes: 'Per run.',
  },
  {
    id: 'ltx2-video-trainer',
    label: 'LTX-2 video trainer',
    category: 'training',
    endpoint: 'fal-ai/ltx2-video-trainer',
    ticketCost: 0,
    usedBy: 'LoRA trainer',
    notes: 'Per run.',
  },
  {
    id: 'z-image-base-trainer',
    label: 'Z-Image base trainer',
    category: 'training',
    endpoint: 'fal-ai/z-image-base-trainer',
    ticketCost: 0,
    usedBy: 'LoRA trainer',
    notes: 'Per run.',
  },
  {
    id: 'z-image-turbo-trainer',
    label: 'Z-Image turbo trainer',
    category: 'training',
    endpoint: 'fal-ai/z-image-turbo-trainer-v2',
    ticketCost: 0,
    usedBy: 'LoRA trainer',
    notes: 'Per run.',
  },
]

/**
 * The 3D suite, folded into the pricing catalog.
 *
 * Generated from THREED_MODELS rather than retyped: the 3D catalog already
 * carries fal's published price per model, and two lists of the same numbers
 * drift the moment one is edited.
 */
const THREED_PRICING: FalToolModel[] = THREED_MODELS.map(m => ({
  id: `3d-${m.id}`,
  label: m.label,
  category: 'threed' as const,
  endpoint: m.endpoint,
  ticketCost: 0,
  usedBy: '3D Studio',
  notes: m.usd != null
    ? `fal publishes $${m.usd} per generation. ${m.caveat ?? ''}`.trim()
    : `No published price. ${m.caveat ?? ''}`.trim(),
}))

export const FAL_TOOL_MODELS: FalToolModel[] = [...BASE_TOOL_MODELS, ...THREED_PRICING]

export const TOOL_CATEGORY_LABEL: Record<ToolModelCategory, string> = {
  audio: 'Audio',
  masking: 'Masking',
  relight: 'Relight',
  faceswap: 'Face swap',
  transcribe: 'Transcription',
  training: 'LoRA training',
  threed: '3D',
}
