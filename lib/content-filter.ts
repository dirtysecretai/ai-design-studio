import prisma from '@/lib/prisma'
import { checkIsAdmin } from '@/lib/admin-check'
import { celebrityNameCheck } from '@/lib/celebrity-names'

// ── AI Design Studio Content Filter (CCBill compliance) ─────────────────────
//
// Server-side prompt screening applied to EVERY generation before anything is
// submitted to a provider. Two tiers:
//
//   1. Keyword screen — CCBill's reviewed term list (2026-08-17 compliance
//      email) plus obvious variants, word-boundary matched on a normalized
//      (lowercased, leetspeak-folded) copy of the prompt. Instant and free.
//      CCBill re-tests these exact terms, so they hard-fail here no matter
//      how the second tier would have judged the context.
//
//   2. AI policy check — Gemini flash-lite classifies what no list can:
//      real-person/celebrity names (their reviewer generated "kim kardashian
//      covered in blood" — zero listed words), misspellings, and "similar
//      terms" (their letter says the list is NOT all-inclusive). Fails OPEN
//      on model errors/timeouts so generation never breaks — tier 1 is still
//      enforced — and every failure is logged.
//
// Regular users are ALWAYS filtered — nothing client-side can disable this.
// Admin accounts are filtered too by default; the portal-v2 admin toggle
// flips SystemState."adminContentFilterOn" (raw SQL — column added
// out-of-band) to exempt admin accounts only. Regular users are unaffected
// by the toggle in either position.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const LLM_MODEL = 'gemini-3.1-flash-lite-preview'
const LLM_TIMEOUT_MS = 3_000

// CCBill's listed terms by category. Matched with word boundaries against the
// normalized prompt (see normalize()). Multi-word terms allow flexible
// whitespace. Keep entries lowercase.
const TERM_GROUPS: { category: string; terms: string[] }[] = [
  { category: 'celebrity', terms: ['celeb', 'celebs', 'celebrity', 'celebrities'] },
  { category: 'prostitution', terms: ['hooker', 'hookers', 'prostitute', 'prostituted', 'prostitutes', 'prostitution', 'prostituting', 'whore', 'whores'] },
  { category: 'trafficking', terms: ['sex trafficking', 'human trafficking', 'trafficked'] },
  { category: 'incest', terms: ['incest', 'inzest', 'inbreed', 'inbreeding', 'inbreeded', 'inbred'] },
  { category: 'diaper', terms: ['diaper', 'diapers'] },
  { category: 'underage', terms: [
    'child', 'children', 'jailbait', 'jail bait', 'lolita', 'loli', 'lolicon', 'shota', 'shotacon',
    'pedo', 'pedophilia', 'pedophile', 'paedophile', 'preteen', 'pre teen', 'pre-teen',
    'underage', 'under age', 'young teen', 'young teens', 'minor', 'minors', 'schoolgirl', 'school girl', 'schoolboy',
  ] },
  { category: 'extreme-violence', terms: [
    'abduct', 'abduction', 'abducting', 'abducted', 'asphyxiate', 'asphyxiation', 'blacked out',
    'cannibal', 'cannibalism', 'chloroform', 'chloroformed', 'chloroforming', 'flogging',
    'kidnap', 'kidnapped', 'kidnapping', 'snuff', 'strangulation', 'strangling', 'strangled', 'strangle',
    'suffocation', 'suffocate', 'suffocating', 'unconscious', 'unconsciousness',
  ] },
  { category: 'non-consent', terms: [
    'coma', 'comatose', 'doze', 'drunk', 'drunken', 'entranced', 'entrance',
    // "Drinking" on CCBill's list means ALCOHOL consumption — drinking coffee
    // or water is fine, so only alcohol-specific phrases are listed. The LLM
    // tier still catches contextual alcohol + sexual-content combinations.
    'drinking alcohol', 'drinking beer', 'drinking wine', 'drinking vodka', 'drinking whiskey',
    'drinking liquor', 'binge drinking', 'intoxicated', 'inebriated', 'wasted drunk',
    'forced sex', 'forceful', 'forcing', 'hypno', 'hypnotize', 'hypnotized', 'hypnotizing', 'hypnosis',
    'knock out', 'knocked out', 'knockout', 'molest', 'molested', 'molesting', 'molestation',
    'non consent', 'nonconsent', 'non-consent', 'non consensual', 'nonconsensual', 'paralyzed', 'passed out',
    'rape', 'raped', 'raping', 'rapist', 'snooze', 'roofie', 'roofied', 'date rape', 'sedated', 'sedate',
  ] },
  { category: 'excretions', terms: [
    'golden shower', 'golden showers', 'menstruation', 'menstruating', 'menstrual cycle', 'menstrual',
    'poo', 'poop', 'scat', 'skat', 'vomit', 'vomitted', 'vomited', 'vomitting', 'vomiting',
    'watersports', 'water sports', 'piss', 'pissing', 'urine', 'urinating', 'peeing',
  ] },
  { category: 'bestiality', terms: [
    'animal sex', 'beastiality', 'bestiality', 'dog sex', 'farm sex', 'horse sex', 'zoophilia', 'zoophile', 'zoo sex',
  ] },
]

// Leetspeak/symbol folding so "l0lita" / "r@pe" don't slip the list
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' }

function normalize(prompt: string): string {
  let s = prompt.toLowerCase()
  s = s.replace(/[0134578@$!]/g, ch => LEET[ch] ?? ch)
  // Punctuation → spaces so "jail.bait"/"jail_bait" read as "jail bait"
  s = s.replace(/[^a-z\s-]/g, ' ').replace(/[-_]/g, ' ').replace(/\s+/g, ' ')
  return ` ${s.trim()} `
}

const COMPILED = TERM_GROUPS.map(g => ({
  category: g.category,
  patterns: g.terms.map(t => new RegExp(`\\b${t.replace(/\s+/g, '\\s+')}\\b`)),
  terms: g.terms,
}))

export function keywordCheck(prompt: string): { category: string; term: string } | null {
  const n = normalize(prompt)
  for (const g of COMPILED) {
    for (let i = 0; i < g.patterns.length; i++) {
      if (g.patterns[i].test(n)) return { category: g.category, term: g.terms[i] }
    }
  }
  return null
}

// Verdict cache — batch mode fires the SAME prompt many times, and users
// retry identical prompts; each unique prompt is billed once per instance.
const llmVerdictCache = new Map<string, { allowed: boolean }>()
const LLM_CACHE_MAX = 500

// Tier 2: LLM policy classifier. Returns null when it can't run (no key,
// timeout, provider error) — callers treat null as "allow" (fail-open).
export async function llmCheck(prompt: string): Promise<{ allowed: boolean; category?: string } | null> {
  if (!GEMINI_API_KEY) return null
  const cacheKey = normalize(prompt)
  const cached = llmVerdictCache.get(cacheKey)
  if (cached) return cached.allowed ? { allowed: true } : { allowed: false, category: 'policy' }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ parts: [{ text:
`Content-policy classifier for an adult AI image/video platform. Judge ONLY the prompt below. Reply with EXACTLY one word: BLOCK or ALLOW.

BLOCK if the prompt involves any of:
- A SPECIFIC real person identified by NAME or unmistakable unique description (a named celebrity, actor, musician, influencer, politician, athlete, or any named real individual). Generic unnamed people ("an influencer", "a famous actress", "a politician") are NOT a reason to block.
- Anyone under 18, childlike or age-ambiguous "teen" subjects
- Non-consent: rape, molestation, or drugged/drunk/sleeping/unconscious/hypnotized subjects in sexual or suggestive context
- Extreme violence or gore: blood, torture, kidnapping, strangulation, snuff, cannibalism
- Incest (including step-family), bestiality, prostitution/escorting, sex trafficking
- Scat, urine, vomit, or diapers in fetish context

ALLOW everything else, including: ordinary adult content with adult fictional consenting subjects, and FICTIONAL CHARACTERS from movies, games, anime, or books referred to by the CHARACTER'S name (e.g. a superhero or game protagonist) — a fictional character is fine even if a real actor plays them, but naming the real actor is BLOCK.

PROMPT:
${prompt.slice(0, 4000)}

One word:` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 },
        }),
      }
    )
    if (!res.ok) {
      console.error(`[content-filter] llm HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim().toUpperCase()
    const remember = (allowed: boolean) => {
      if (llmVerdictCache.size >= LLM_CACHE_MAX) {
        const oldest = llmVerdictCache.keys().next().value
        if (oldest !== undefined) llmVerdictCache.delete(oldest)
      }
      llmVerdictCache.set(cacheKey, { allowed })
    }
    if (text.startsWith('BLOCK')) { remember(false); return { allowed: false, category: 'policy' } }
    if (text.startsWith('ALLOW')) { remember(true); return { allowed: true } }
    console.error(`[content-filter] llm unexpected verdict: ${text.slice(0, 40)}`)
    return null
  } catch (e) {
    console.error('[content-filter] llm check failed (fail-open):', e instanceof Error ? e.message : e)
    return null
  }
}

// SystemState."adminContentFilterOn" + "contentFilterMode" — raw SQL
// (columns added out-of-band), cached briefly so per-generation reads are cheap.
// mode 'gemini' = keyword + names list + LLM policy check (paid, strongest)
// mode 'static' = keyword + names list only (free, no API calls)
export type FilterMode = 'gemini' | 'static'
let filterStateCache: { at: number; on: boolean; mode: FilterMode } | null = null
async function readFilterState(): Promise<{ on: boolean; mode: FilterMode }> {
  if (filterStateCache && Date.now() - filterStateCache.at < 15_000) return filterStateCache
  try {
    const rows = await prisma.$queryRaw<{ on: boolean; mode: string }[]>`SELECT "adminContentFilterOn" AS "on", "contentFilterMode" AS "mode" FROM "SystemState" LIMIT 1`
    const on = rows.length === 0 ? false : rows[0].on !== false
    const mode: FilterMode = rows.length > 0 && rows[0].mode === 'static' ? 'static' : 'gemini'
    filterStateCache = { at: Date.now(), on, mode }
    return filterStateCache
  } catch {
    return { on: true, mode: 'gemini' } // fail-closed for admins, strongest mode
  }
}

export async function setAdminFilterOn(on: boolean): Promise<void> {
  await prisma.$executeRaw`UPDATE "SystemState" SET "adminContentFilterOn" = ${on}`
  filterStateCache = null
}

export async function setFilterMode(mode: FilterMode): Promise<void> {
  await prisma.$executeRaw`UPDATE "SystemState" SET "contentFilterMode" = ${mode}`
  filterStateCache = null
}

export async function getFilterState(): Promise<{ adminFilterOn: boolean; mode: FilterMode }> {
  filterStateCache = null
  const st = await readFilterState()
  return { adminFilterOn: st.on, mode: st.mode }
}

const BLOCK_MESSAGE = 'This prompt was blocked by the content policy filter. Please rephrase and try again.'

/**
 * The one call every generation route makes before charging or submitting.
 * Returns { ok: true } to proceed, or { ok: false, reason } to 400.
 * Admin accounts skip screening ONLY while the admin toggle is off.
 */
export async function enforceContentFilter(
  prompt: string | null | undefined,
  userEmail: string | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const p = (prompt ?? '').trim()
  if (!p) return { ok: true }

  const state = await readFilterState()

  // Admin bypass — verified server-side, controlled by the global admin toggle
  if (userEmail && await checkIsAdmin(userEmail)) {
    if (!state.on) return { ok: true }
  }

  const kw = keywordCheck(p)
  if (kw) {
    console.log(`[content-filter] BLOCKED (keyword:${kw.category}/${kw.term}) user=${userEmail ?? 'anon'}`)
    return { ok: false, reason: BLOCK_MESSAGE }
  }

  // Static real-person name list — free, runs in BOTH modes (in gemini mode a
  // hit here also saves the paid LLM call)
  const nameHit = celebrityNameCheck(normalize(p))
  if (nameHit) {
    console.log(`[content-filter] BLOCKED (name-list:${nameHit}) user=${userEmail ?? 'anon'}`)
    return { ok: false, reason: BLOCK_MESSAGE }
  }

  if (state.mode === 'gemini') {
    const llm = await llmCheck(p)
    if (llm && !llm.allowed) {
      console.log(`[content-filter] BLOCKED (llm) user=${userEmail ?? 'anon'} prompt="${p.slice(0, 120)}"`)
      return { ok: false, reason: BLOCK_MESSAGE }
    }
  }

  return { ok: true }
}

// ── Admin settings-page helpers ──────────────────────────────────────────────

export function filterStats(): { categories: { category: string; terms: number }[] } {
  return { categories: TERM_GROUPS.map(g => ({ category: g.category, terms: g.terms.length })) }
}

/**
 * Dry-run a prompt through every tier (ignores the admin toggle — this is the
 * settings-page tester). Reports each tier's verdict plus what the final
 * outcome would be in each engine mode.
 */
export async function testPromptVerdict(prompt: string): Promise<{
  keyword: { category: string; term: string } | null
  name: string | null
  llm: 'BLOCK' | 'ALLOW' | 'UNAVAILABLE'
  finalGemini: 'BLOCK' | 'ALLOW'
  finalStatic: 'BLOCK' | 'ALLOW'
}> {
  const kw = keywordCheck(prompt)
  const name = celebrityNameCheck(normalize(prompt))
  const llmRes = await llmCheck(prompt)
  const llm = llmRes === null ? 'UNAVAILABLE' : llmRes.allowed ? 'ALLOW' : 'BLOCK'
  const listBlocked = !!kw || !!name
  return {
    keyword: kw,
    name,
    llm,
    finalStatic: listBlocked ? 'BLOCK' : 'ALLOW',
    finalGemini: listBlocked || llm === 'BLOCK' ? 'BLOCK' : 'ALLOW',
  }
}
