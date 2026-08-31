import { celebrityNameCheck } from '@/lib/celebrity-names'

// How tolerant each provider's OWN content filter is.
//
// This is not our filter (that is lib/content-filter.ts, which enforces the
// CCBill rules on prompts). This is the opposite problem: a request we are
// happy to run gets rejected by the PROVIDER because their model ships a
// filter we cannot turn off. A character that renders fine on one model comes
// back as content_policy_violation on another, and the user pays for the
// discovery — the job is accepted, queued, and only fails at execution.
//
// Tiers are assigned from OBSERVED behaviour and published schemas, not from
// vibes. Where a model has not been exercised enough to know, it is 'unknown'
// and treated as tunable-but-unproven rather than being guessed into a tier.

/**
 * What actually trips a strict provider. Observed in production, in rough order
 * of how reliably it causes a rejection:
 *
 *  1. RECOGNISABLE REAL PEOPLE — a reference photo that reads as a specific
 *     living person. This is the single biggest trigger and it is judged on the
 *     IMAGE, so no amount of prompt rewording avoids it.
 *  2. OWNED CHARACTERS — Marvel/DC/Disney/Nintendo/anime figures named in the
 *     prompt ("Thor", "Elsa"), whether or not the images match.
 *  3. MINORS, or adult content involving anyone who reads as young.
 *  4. EXPLICIT / revealing content generally.
 *
 * SeeDance (ByteDance) rejects on 1 and 2 aggressively. Knowing this before a
 * shot is routed is the difference between a free reroute and a paid failure.
 */
export type StrictTriggerKind = 'real-person' | 'owned-character'

export type ContentPolicyTier =
  /** Provider filter is strict AND has no exposed control. Expect rejections. */
  | 'strict'
  /** Ships a safety parameter we set to its most permissive value for admins. */
  | 'tunable'
  /** Open-weight; the safety checker can be switched off entirely. */
  | 'open'
  /** Not enough evidence yet — treat as tunable, report failures. */
  | 'unknown'

export type ModelContentPolicy = {
  tier: ContentPolicyTier
  /** Why it carries this tier — evidence, not opinion. */
  note: string
}

const POLICY: Record<string, ModelContentPolicy> = {
  // ── Verified strict ──────────────────────────────────────────────────────
  'google-virtual-try-on': {
    tier: 'strict',
    // Reproduced against the live endpoint 2026-08-29: fal accepts the submit
    // then fails the job with content_policy_violation on person_image_url
    // and/or product_image_url. The schema has three fields and none of them
    // is a safety control.
    note: 'Google screens both input photos and exposes no safety parameter. Confirmed rejections on ordinary character photos.',
  },
  'seedance-2.0': {
    tier: 'strict',
    note: 'ByteDance rejects recognisable real people and owned franchise characters, judged on the reference IMAGES as well as the prompt. No safety control in the schema.',
  },
  'seedance-2.0-fast': {
    tier: 'strict',
    note: 'Same ByteDance filter: real-person likeness and owned characters are refused.',
  },
  'seedance-2.5': {
    tier: 'strict',
    note: 'Same ByteDance family filter: real-person likeness and owned characters are refused.',
  },
  'seedance-1.5': {
    tier: 'strict',
    note: 'ByteDance family filter: real-person likeness and owned characters are refused.',
  },

  // ── Tunable: a safety field we lower for admins ──────────────────────────
  'flux-3': {
    tier: 'tunable',
    // safety_tolerance: integer, minimum 0, maximum 4 (schema fetched
    // 2026-08-29). We send 4 — the most permissive the schema allows — when an
    // admin turns the safety toggle off.
    note: 'safety_tolerance 0-4; we send 4 for admins with the safety toggle off.',
  },
  'minimax-h3-max': {
    tier: 'tunable',
    note: 'Exposes a safety checker toggle that we honour.',
  },
  'wan-3.0': { tier: 'tunable', note: 'Exposes a safety checker toggle that we honour.' },
  'wan-3.0-prime': { tier: 'tunable', note: 'Exposes a safety checker toggle that we honour.' },
  'wan-2.5': { tier: 'tunable', note: 'Exposes a safety checker toggle that we honour.' },
  'wan-2.7': { tier: 'tunable', note: 'Exposes a safety checker toggle that we honour.' },

  // ── Open weights: the checker can be switched off outright ───────────────
  'wan-2.2-lora': {
    tier: 'open',
    note: 'Open-weight Wan 2.2; enable_safety_checker is set false for admins.',
  },
}

export function contentPolicyFor(modelId: string): ModelContentPolicy {
  return POLICY[modelId] ?? { tier: 'unknown', note: 'Provider tolerance not yet characterised.' }
}

/** Short marker for a model catalog line, e.g. "STRICT FILTER". */
export function policyMarker(modelId: string): string {
  const p = contentPolicyFor(modelId)
  if (p.tier === 'strict') return 'STRICT provider filter — rejects many character refs'
  if (p.tier === 'open') return 'safety checker off'
  if (p.tier === 'tunable') return 'safety tunable'
  return ''
}

/**
 * Franchise characters a strict provider will refuse by NAME. Deliberately
 * short and high-signal — this is a routing hint, not a rights database, and a
 * false positive only costs a model swap.
 */
const OWNED_CHARACTERS = [
  'thor', 'loki', 'iron man', 'spider man', 'spiderman', 'captain america', 'hulk',
  'black widow', 'batman', 'superman', 'wonder woman', 'joker', 'harley quinn',
  'darth vader', 'luke skywalker', 'princess leia', 'yoda', 'mandalorian',
  'elsa', 'mickey mouse', 'moana', 'ariel', 'harry potter', 'hermione',
  'mario', 'luigi', 'zelda', 'link', 'pikachu', 'sonic',
  'goku', 'naruto', 'sasuke', 'luffy', 'eren', 'gojo', 'tanjiro',
  'james bond', 'john wick', 'wednesday addams', 'eleven',
]

const OWNED_RE = OWNED_CHARACTERS.map(n => ({
  name: n,
  re: new RegExp(`\\b${n.replace(/ /g, '\\s+')}\\b`),
}))

/** Mirrors lib/content-filter's normalize() closely enough for name matching. */
function normalizeForNames(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
  return ` ${s.trim()} `
}

/**
 * Does this text name something a strict provider will refuse? Reuses the
 * real-person list the CCBill prompt filter already maintains
 * (lib/celebrity-names) rather than keeping a second copy.
 *
 * Text only — a reference PHOTO of a real person is invisible here and is the
 * more common trigger; that check belongs to the agent, which can see it.
 */
export function strictFilterRisk(text: string): { kind: StrictTriggerKind; term: string } | null {
  const normalized = normalizeForNames(text)
  const celeb = celebrityNameCheck(normalized)
  if (celeb) return { kind: 'real-person', term: celeb }
  for (const { name, re } of OWNED_RE) {
    if (re.test(normalized)) return { kind: 'owned-character', term: name }
  }
  return null
}

/** Models to prefer when the cast is likely to trip a strict provider. */
export function isSafeForSensitiveCast(modelId: string): boolean {
  const t = contentPolicyFor(modelId).tier
  return t === 'open' || t === 'tunable'
}
