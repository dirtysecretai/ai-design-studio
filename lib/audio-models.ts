// Audio models for film scoring — music beds, voiceover, and video-matched
// sound. Mirrors lib/fal-video-endpoints.ts: ids the app uses, mapped to the
// fal endpoints they submit to, so nothing has to grep source at runtime.
//
// Every schema below was fetched from fal's live OpenAPI before being written
// here (the same discipline the video endpoints follow) — required fields and
// names are what the endpoint actually declares, not what looked plausible.
//
// PRICING IS PLACEHOLDER. fal does not publish a machine-readable price for
// these and none has been observed in a real run yet; the numbers are marked
// so the Ticket Economics page shows them as unverified rather than silently
// pretending to be costed.

export type AudioKind = 'music' | 'voice' | 'sfx'

export type AudioModelSpec = {
  id: string
  label: string
  kind: AudioKind
  endpoint: string
  /** PLACEHOLDER until a real run prices it. */
  ticketCost: number
  notes: string
}

export const AUDIO_MODELS: AudioModelSpec[] = [
  {
    id: 'lyria-2',
    label: 'Lyria 2',
    kind: 'music',
    endpoint: 'fal-ai/lyria2',
    ticketCost: 4, // PLACEHOLDER
    // Verified: required ['prompt']; properties prompt, negative_prompt, seed.
    notes: 'Instrumental music from a text prompt. The default music bed.',
  },
  {
    id: 'elevenlabs-music',
    label: 'ElevenLabs Music',
    kind: 'music',
    endpoint: 'fal-ai/elevenlabs/music',
    ticketCost: 6, // PLACEHOLDER
    // Verified: prompt, music_length_ms, force_instrumental, output_format.
    notes: 'Music with explicit length control — use when the bed must match a known runtime.',
  },
  {
    id: 'elevenlabs-tts',
    label: 'ElevenLabs TTS',
    kind: 'voice',
    endpoint: 'fal-ai/elevenlabs/tts/multilingual-v2',
    ticketCost: 3, // PLACEHOLDER
    // Verified: required ['text']; voice, stability, similarity_boost, speed, style.
    notes: 'Narration and character voiceover, with named voices and delivery control.',
  },
  {
    id: 'minimax-speech',
    label: 'MiniMax Speech 02 HD',
    kind: 'voice',
    endpoint: 'fal-ai/minimax/speech-02-hd',
    ticketCost: 3, // PLACEHOLDER
    // Verified: required ['text']; voice_setting, audio_setting, output_format.
    notes: 'Alternative TTS voice set.',
  },
  {
    id: 'mmaudio-v2',
    label: 'MMAudio v2',
    kind: 'sfx',
    endpoint: 'fal-ai/mmaudio-v2',
    ticketCost: 4, // PLACEHOLDER
    // Verified: required ['video_url','prompt']; duration, num_steps, cfg_strength.
    notes: 'Sound scored TO an existing clip — foley and ambience for shots rendered without native audio.',
  },
]

export function getAudioModel(id: string | undefined, kind?: string): AudioModelSpec | undefined {
  if (id) {
    const exact = AUDIO_MODELS.find(m => m.id === id)
    if (exact) return exact
  }
  if (kind) return AUDIO_MODELS.find(m => m.kind === kind)
  return undefined
}

export function buildAudioCall(
  spec: AudioModelSpec,
  input: { prompt?: string; text?: string; duration_sec?: number; voice?: string; video_url?: string },
): { endpoint: string; input: Record<string, unknown> } | { error: string } {
  if (spec.kind === 'music') {
    const prompt = (input.prompt ?? '').trim()
    if (!prompt) return { error: `${spec.label} needs a prompt describing the music.` }
    if (spec.id === 'elevenlabs-music') {
      const ms = Math.round(Math.max(5, Math.min(300, input.duration_sec ?? 30)) * 1000)
      return { endpoint: spec.endpoint, input: { prompt, music_length_ms: ms, force_instrumental: true } }
    }
    return { endpoint: spec.endpoint, input: { prompt } }
  }

  if (spec.kind === 'voice') {
    const text = (input.text ?? input.prompt ?? '').trim()
    if (!text) return { error: `${spec.label} needs the line to speak (text).` }
    if (spec.id === 'minimax-speech') {
      return { endpoint: spec.endpoint, input: { text } }
    }
    return {
      endpoint: spec.endpoint,
      input: { text, ...(input.voice ? { voice: input.voice } : {}) },
    }
  }

  // sfx: scored to a clip, so it needs the clip
  const videoUrl = (input.video_url ?? '').trim()
  const prompt = (input.prompt ?? '').trim()
  if (!videoUrl) return { error: `${spec.label} scores an existing clip — pass video_url.` }
  if (!prompt) return { error: `${spec.label} needs a prompt describing the sound.` }
  return {
    endpoint: spec.endpoint,
    input: { video_url: videoUrl, prompt, ...(input.duration_sec ? { duration: input.duration_sec } : {}) },
  }
}
