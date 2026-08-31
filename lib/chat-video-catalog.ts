import { VIDEO_MODEL_SPECS, videoTicketCost } from '@/lib/ticket-pricing'
import { ADMIN_ONLY_VIDEO_MODELS } from '@/lib/fal-video-endpoints'
import { contentPolicyFor } from '@/lib/model-content-policy'

// The chat hub's video catalog, DERIVED from the site's own model table rather
// than hand-listed a second time.
//
// The hub used to carry nine hand-written video entries while the site shipped
// thirty-one, so the employee simply could not choose most of the studio — and
// every new model meant remembering to add it here too. Video generation now
// submits through /api/video/generate, which owns the endpoints, the input
// builders and the admin gate, so everything this file needs to describe is
// what the model is FOR and what it costs.
//
// Reference behaviour is the one thing the pricing table does not record, so it
// is declared below. Getting it wrong costs a rejected tool call with a clear
// message from the route, not a wasted render.

export type ChatVideoEntry = {
  id: string
  label: string
  kind: 'video'
  group: string
  maxRefs: number
  ticketCost: number
  needsRef?: boolean
  endFrame?: boolean
  admin?: boolean
  disabled?: string
  strengths?: string
  guide?: string
  fields?: { key: string; label: string; options: string[]; def: string }[]
}

/** How each family takes references. Everything unlisted gets the default. */
const REFS: Record<string, { maxRefs: number; needsRef?: boolean; endFrame?: boolean }> = {
  'kling-v3':            { maxRefs: 2, needsRef: true, endFrame: true },
  'kling-o3':            { maxRefs: 4 },
  'kling-v3-motion':     { maxRefs: 1, needsRef: true },
  'seedance-1.5':        { maxRefs: 2, endFrame: true },
  'seedance-2.0':        { maxRefs: 9 },
  'seedance-2.0-fast':   { maxRefs: 9 },
  'seedance-2.5':        { maxRefs: 9 },
  'gemini-omni-flash':   { maxRefs: 9 },
  'gemini-omni-1.1':     { maxRefs: 9 },
  'wan-2.5':             { maxRefs: 1, needsRef: true },
  'wan-2.7':             { maxRefs: 1 },
  'wan-2.2-lora':        { maxRefs: 1 },
  'wan-3.0':             { maxRefs: 9, endFrame: true },
  'wan-3.0-prime':       { maxRefs: 1, endFrame: true },
  'minimax-h3-max':      { maxRefs: 2, endFrame: true },
  'flux-3':              { maxRefs: 10, endFrame: true },
  'ltx-2.5-pro':         { maxRefs: 2, endFrame: true },
  'ltx-2.5-fast':        { maxRefs: 2, endFrame: true },
  'happy-horse':         { maxRefs: 1, needsRef: true },
  'lipsync-v3':          { maxRefs: 0 },
}

/** Which provider a model belongs to, for grouping in the picker. */
function groupOf(id: string): string {
  if (id.startsWith('kling')) return 'Kling'
  if (id.startsWith('seedance') || id.startsWith('bytedance')) return 'ByteDance'
  if (id.startsWith('wan')) return 'Wan'
  if (id.startsWith('gemini')) return 'Google'
  if (id.startsWith('flux')) return 'Black Forest'
  if (id.startsWith('ltx')) return 'Lightricks'
  if (id.startsWith('topaz')) return 'Topaz'
  if (id.startsWith('minimax')) return 'MiniMax'
  if (id.startsWith('happy')) return 'Alibaba'
  return 'Video'
}

/** One line the router can act on: what it is for, and what it refuses. */
function describe(spec: (typeof VIDEO_MODEL_SPECS)[number]): string {
  const policy = contentPolicyFor(spec.id)
  const bits: string[] = []
  if (spec.kind === 'tool') {
    bits.push('POST-PRODUCTION TOOL: transforms a clip you already have (upscale, restore, interpolate, colour) rather than generating a new shot. Feed it a finished shot.')
  }
  if (spec.supportsAudio) bits.push('Native audio.')
  if (spec.resolutions.length) bits.push(`Resolutions: ${spec.resolutions.join('/')}.`)
  if (policy.tier === 'strict') {
    bits.push('REFUSES recognisable real people and owned franchise characters — which only rules it out of the shots those characters appear IN, not the rest of the film.')
  } else if (policy.tier === 'open' || policy.tier === 'tunable') {
    bits.push('Permissive: safe for a cast a strict provider refuses.')
  }
  if (spec.note) bits.push(spec.note)
  return bits.join(' ')
}

export const CHAT_VIDEO_MODELS: ChatVideoEntry[] = VIDEO_MODEL_SPECS.map(spec => {
  const refs = REFS[spec.id] ?? { maxRefs: 4 }
  const fields: ChatVideoEntry['fields'] = []
  if (spec.durations.length) {
    fields.push({ key: 'duration', label: 'Duration', options: spec.durations, def: spec.durations.includes('5') ? '5' : spec.durations[0] })
  }
  if (spec.resolutions.length) {
    fields.push({ key: 'resolution', label: 'Res', options: spec.resolutions, def: spec.resolutions.includes('720p') ? '720p' : spec.resolutions[0] })
  }
  if (spec.supportsAudio) {
    fields.push({ key: 'audio', label: 'Audio', options: ['off', 'on'], def: 'off' })
  }

  return {
    id: spec.id,
    label: spec.label,
    kind: 'video' as const,
    group: groupOf(spec.id),
    maxRefs: refs.maxRefs,
    needsRef: refs.needsRef,
    endFrame: refs.endFrame,
    admin: ADMIN_ONLY_VIDEO_MODELS.has(spec.id),
    // Priced by the same function that bills the job, at this model's defaults
    ticketCost: videoTicketCost({
      model: spec.id,
      duration: spec.durations.includes('5') ? '5' : (spec.durations[0] ?? '5'),
      resolution: spec.resolutions.includes('720p') ? '720p' : (spec.resolutions[0] ?? '720p'),
      generateAudio: false,
    } as Parameters<typeof videoTicketCost>[0]),
    strengths: describe(spec),
    fields,
  }
})
