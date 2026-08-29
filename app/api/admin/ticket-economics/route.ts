import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { FAL_ENDPOINTS } from '@/lib/fal-video-endpoints'
import { VIDEO_MODEL_SPECS } from '@/lib/ticket-pricing'
import { AI_MODELS } from '@/config/ai-models.config'

// GET /api/admin/ticket-economics  → fal's own pricing blurb for every model we
// ship, keyed by OUR model id.
//
// fal's public catalog endpoint returns a `pricingInfoOverride` string per
// model ("$0.04 per second at 768p", "…$0.05 for every second…"). Sweeping it
// means the owner can read fal's words on the row itself instead of opening a
// dozen tabs. Where the blurb names exactly ONE dollar figure and at most one
// resolution we also hand back a parsed suggestion — deliberately conservative,
// because most video models price per resolution and a half-read number here
// would poison the margin maths. ADMIN ONLY.

export const runtime = 'nodejs'
export const maxDuration = 60

async function isAdmin(req: Request): Promise<boolean> {
  if (checkAuth(req)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

// Same keyword sweep as Model Watch. Three pages each is where the curve flattens:
// pages 4-6 added exactly one more of our models for double the requests.
const KEYWORDS = [
  'video', 'image-to-video', 'text-to-video', 'text-to-image',
  'image-to-image', 'upscale', 'edit', 'lora', 'audio',
]
const PAGES_PER_KEYWORD = 3

export type PricingUnit = 'sec' | 'gen'

/**
 * One price fal's blurb actually names, tagged with whatever the same clause
 * said it was for. A model that quotes a rate per resolution yields one of
 * these per resolution, which is what makes the synced column fillable.
 */
export interface FalCandidate {
  usd: number
  unit: PricingUnit
  /** Read off the same clause: '1080p', 'low', 'audio on', or ''. */
  label: string
  /** The clause it came from, so a row can show its working. */
  context: string
}

export interface ParsedFalPrice {
  usd: number
  unit: PricingUnit
  resolution: string | null
}

export interface FalPricingRow {
  /** Our model id, e.g. 'kling-v3' or 'nano-banana-pro'. */
  id: string
  kind: 'video' | 'image'
  /** The fal endpoint the blurb was read off. */
  endpoint: string | null
  /** Every fal endpoint this model of ours can hit. */
  endpoints: string[]
  /** 'exact' when the endpoint id matched fal's catalog id character for character. */
  match: 'exact' | 'prefix' | 'none'
  pricingText: string | null
  /** Only set when the whole blurb names ONE price. Parsed, NOT confirmed. */
  suggested: ParsedFalPrice | null
  /** Every price the blurb names, tagged by resolution/quality. Parsed, NOT confirmed. */
  candidates: FalCandidate[]
  /**
   * Per-tier rates read off the blurb, so a row can offer the figure for the
   * resolution / audio setting it is actually showing. Parsed, NOT confirmed.
   */
  tiers: { resolution: Record<string, ParsedFalPrice>; audio: Record<string, ParsedFalPrice> }
  /** Why no whole-blurb suggestion was offered, for the tooltip. */
  suggestSkipReason: string | null
}

interface Payload {
  scannedAt: string
  catalogSize: number
  catalogWithPricing: number
  rows: FalPricingRow[]
  matched: number
  unmatched: number
  errors: string[]
}

const CACHE_MS = 10 * 60 * 1000
let cache: { at: number; payload: Payload } | null = null

async function fetchPage(kw: string, page: number): Promise<{ id?: unknown; pricingInfoOverride?: unknown }[]> {
  const res = await fetch(
    `https://fal.ai/api/models?keywords=${encodeURIComponent(kw)}&page=${page}`,
    { headers: { accept: 'application/json' }, cache: 'no-store' },
  )
  if (!res.ok) throw new Error(`${kw} p${page}: HTTP ${res.status}`)
  const data = (await res.json()) as { items?: unknown }
  return Array.isArray(data?.items) ? (data.items as { id?: unknown; pricingInfoOverride?: unknown }[]) : []
}

// fal writes prices two ways: "$0.04" and "0.29 $".
const MONEY_RE = /\$\s?([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s?\$/g
const RES_RE = /\b\d{3,4}[pP]\b|\b[24][kK]\b/g
/**
 * "$0.014 per 1000 tokens", "$21.875 / 1M tokens", "per megapixel" — priced
 * against something this page cannot count, so never a per-generation rate.
 * Only consulted AFTER per-second / per-image wording has been ruled out, so
 * "per image for 1K" is not mistaken for a per-1000 rate.
 */
const NOT_A_UNIT_PRICE = /^[^$]{0,40}?(?:per|\/|for)\s*[\d,. ]*\s*(?:thousand|million|[km]\b)?\s*(?:tokens?|mega\s?pixels?|MP\b|pixels?|characters?|minutes?)/i
/** Quality words fal uses to separate two prices inside one sentence. */
const QUALITY_RE = /\b(?:low|medium|high|turbo|standard|draft|ultra|balanced|fast|1k)\b/i
const PER_SECOND = /per\s+(?:output\s+|generated\s+|video\s+)?second\b|\/\s?second|per\s+sec\b/i
/**
 * "$0.10 per 10 seconds of output" — a block rate. Dividing gives a per-second
 * figure the rest of the page can multiply by a clip length.
 */
const PER_N_SECONDS = /per\s+(\d+(?:\.\d+)?)\s*seconds?\b/i
/**
 * "$0.08 per started 24 megapixels of output" — Topaz's image ladder. One
 * ordinary image lands in the first block, so the block price IS the price of
 * a generation; the label says which block so the assumption stays visible.
 */
const PER_STARTED_MP = /per\s+started\s+(\d+)\s*(?:mega\s?pixels?|MP)\b/i
/** fal drops the dollar sign on some models: "will cost 0.035 when…". */
const BARE_COST = /(?:costs?|charged)\s+([0-9]+\.[0-9]{2,5})\b/gi
const PER_IMAGE = /per\s+(?:output\s+|generated\s+|input\s+)?image\b|per\s+generation|per\s+request|per\s+call|each\s+image/i
/** fal's worked examples ("a 5s video at 720p will cost $0.50") are not rates. */
const EXAMPLE_CLAUSE = /\bfor example\b|\bfor instance\b|\be\.g\.|\b\d+\s*-?\s*(?:s|secs?|seconds?)\b/i
/** The duration half of the above, for clauses already cleared of "for example". */
const DURATION_EXAMPLE = /\b\d+\s*-?\s*(?:s|secs?|seconds?)\b/i

/**
 * Split a blurb into clauses WITHOUT cutting decimals in half: a period ends a
 * clause only when whitespace or the end of the string follows it, so the dot
 * in "$0.04" survives. Getting this wrong read every price as "$0".
 */
function splitClauses(text: string): string[] {
  return text.split(/[,;]|\.(?=\s|$)|\s+and\s+|\s+or\s+/i)
}

/**
 * Read prices out of fal's blurb.
 *
 * `parsed` is the strict answer: set only when the WHOLE blurb names one dollar
 * figure with one clear unit, which is rare — almost every video model quotes a
 * rate per resolution.
 *
 * `tiers` is the useful one: the blurb is split into clauses and each price is
 * bound to the resolution (or audio on/off) named in its own clause, falling
 * back to the resolution the previous clause introduced. A tier that picks up
 * two different prices — a promotional rate and the rate after it, say — is
 * dropped rather than guessed at. Both are parsed, NOT confirmed.
 */
export function parseFalPricing(raw: string): {
  parsed: ParsedFalPrice | null
  candidates: FalCandidate[]
  tiers: { resolution: Record<string, ParsedFalPrice>; audio: Record<string, ParsedFalPrice> }
  skipReason: string | null
} {
  const text = raw.replace(/\*\*/g, ' ').replace(/\s+/g, ' ')
  const empty = { resolution: {}, audio: {} }

  // ── document-level unit, used when a clause does not spell one out ──
  const docSec = /per\s+second|\/\s?second|every\s+second|each\s+second/i.test(text)
  const docImg = PER_IMAGE.test(text)
  const docUnit: PricingUnit | null = docSec && !docImg ? 'sec' : (!docSec && docImg ? 'gen' : null)

  // ── strict, whole-blurb read ──
  const allDollars = [...text.matchAll(MONEY_RE)].map(m => parseFloat(m[1] ?? m[2]))
  const distinct = [...new Set(allDollars.filter(n => Number.isFinite(n)))]
  const resTokens = [...new Set((text.match(RES_RE) || []).map(s => s.toLowerCase()))]

  let parsed: ParsedFalPrice | null = null
  let skipReason: string | null = null
  if (distinct.length === 0) skipReason = 'no dollar figure in the text'
  else if (distinct.length > 1) skipReason = `${distinct.length} different dollar figures — priced by tier`
  else if (resTokens.length > 1) skipReason = `${resTokens.length} resolutions mentioned`
  else if (/per\s+mega\s?pixel|per\s+MP\b/i.test(text)) skipReason = 'priced per megapixel — depends on output size'
  else if (/per\s+minute/i.test(text) && !docSec) skipReason = 'priced per minute — convert by hand'
  else if (docSec && docImg) skipReason = 'mixes per-second and per-image wording'
  else if (!docUnit) skipReason = 'unit unclear from the text'
  else parsed = { usd: distinct[0], unit: docUnit, resolution: resTokens[0] ?? null }

  // ── clause-by-clause tier read ──
  const clauses = splitClauses(text)
  const resHits: Record<string, ParsedFalPrice[]> = {}
  const audioHits: Record<string, ParsedFalPrice[]> = {}
  let carriedRes: string | null = null

  for (const clause of clauses) {
    const resInClause = [...new Set((clause.match(RES_RE) || []).map(s => s.toLowerCase()))]
    const monies = [...clause.matchAll(MONEY_RE)]

    if (monies.length === 0) {
      // A bare "For 720p" clause sets the subject for the clause that follows
      if (resInClause.length === 1) carriedRes = resInClause[0]
      continue
    }
    if (EXAMPLE_CLAUSE.test(clause)) { carriedRes = null; continue }

    const key = resInClause.length === 1 ? resInClause[0] : resInClause.length === 0 ? carriedRes : null
    for (const m of monies) {
      const usd = parseFloat(m[1] ?? m[2])
      if (!Number.isFinite(usd)) continue
      const after = clause.slice((m.index ?? 0) + m[0].length)
      if (NOT_A_UNIT_PRICE.test(after)) continue
      const unit: PricingUnit | null =
        PER_SECOND.test(after) ? 'sec' : PER_IMAGE.test(after) ? 'gen' : docUnit
      if (!unit) continue

      const audio = /audio\s*off|without\s+audio|no\s+audio/i.test(after) ? 'off'
        : /audio\s*on|with\s+audio/i.test(after) ? 'on' : null
      if (audio) {
        (audioHits[audio] ??= []).push({ usd, unit, resolution: key })
      } else if (key) {
        (resHits[key] ??= []).push({ usd, unit, resolution: key })
      }
    }
    carriedRes = resInClause.length === 1 ? resInClause[0] : null
  }

  // Only keep a tier every mention agrees on
  const settle = (hits: Record<string, ParsedFalPrice[]>) => {
    const out: Record<string, ParsedFalPrice> = {}
    for (const [k, list] of Object.entries(hits)) {
      const uniq = [...new Set(list.map(p => `${p.usd}|${p.unit}`))]
      if (uniq.length === 1) out[k] = list[0]
    }
    return out
  }

  // ── every plausible unit price, tagged by whatever its own clause named ──
  // The strict read above refuses to answer whenever a blurb quotes more than
  // one figure, which is most of them. This pass keeps them all and lets the
  // owner pick, which is the difference between a column of dashes and a
  // column that fills itself.
  // "Your request will cost X" with no per-second wording anywhere is a price
  // per generation, even when fal never writes the words "per image". Kept out
  // of docUnit so the strict read above does not start calling such blurbs
  // "mixed", which would lose the single-price rows it does answer for.
  const requestCost = /your\s+request\s+will\s+cost/i.test(text)
  const candDocUnit: PricingUnit | null = docUnit ?? (!docSec && requestCost ? 'gen' : null)

  const candidates: FalCandidate[] = []
  const seenCand = new Set<string>()
  let candRes: string | null = null
  // A blurb that opens "$0.10 per 10 seconds of output at 720p" and then lists
  // "$0.20 at 1080p" means per-ten-seconds for every figure that follows, so
  // the divisor carries until something says otherwise.
  let carriedPerN: number | null = null

  for (const sentence of text.split(/\.(?=\s|$)/)) {
    // fal's worked examples restate a rate as a total ("a 5s video will cost
    // $0.98"). Read as a rate that overstates the cost by the clip length, so
    // the WHOLE sentence is skipped — clause-level matching let the figures in
    // the back half of the sentence through.
    if (/\bfor example\b|\bfor instance\b|\be\.g\./i.test(sentence)) continue

    for (const clause of sentence.split(/[,;]|\s+and\s+|\s+or\s+/i)) {
      const resInClause = [...new Set((clause.match(RES_RE) || []).map(x => x.toLowerCase()))]

      const spans: { usd: number; after: string }[] = [...clause.matchAll(MONEY_RE)].map(m => ({
        usd: parseFloat(m[1] ?? m[2]),
        after: clause.slice((m.index ?? 0) + m[0].length),
      }))
      // Some models are quoted without a dollar sign at all
      if (spans.length === 0) {
        for (const bm of clause.matchAll(BARE_COST)) {
          spans.push({ usd: parseFloat(bm[1]), after: clause.slice((bm.index ?? 0) + bm[0].length) })
        }
      }
      if (spans.length === 0) {
        if (resInClause.length === 1) candRes = resInClause[0]
        continue
      }
      // "each 720p 5 second video costs $0.26" prices one length, not a rate
      if (DURATION_EXAMPLE.test(clause) && !PER_N_SECONDS.test(clause)) { candRes = null; continue }

      for (const span of spans) {
        if (!Number.isFinite(span.usd) || span.usd <= 0) continue
        const after = span.after
        const perN = after.match(PER_N_SECONDS)
        const perMp = after.match(PER_STARTED_MP)

        let usd = span.usd
        let extraLabel = ''
        let unit: PricingUnit | null = null

        if (perN) {
          const n = parseFloat(perN[1])
          if (!Number.isFinite(n) || n <= 0) continue
          carriedPerN = n
          usd = span.usd / n
          unit = 'sec'
          extraLabel = `per ${n}s`
        } else if (perMp) {
          unit = 'gen'
          extraLabel = `up to ${perMp[1]}MP`
        } else if (PER_SECOND.test(after)) {
          carriedPerN = null
          unit = 'sec'
        } else if (PER_IMAGE.test(after)) {
          carriedPerN = null
          unit = 'gen'
        } else if (carriedPerN != null) {
          usd = span.usd / carriedPerN
          unit = 'sec'
          extraLabel = `per ${carriedPerN}s`
        } else if (!NOT_A_UNIT_PRICE.test(after)) {
          unit = candDocUnit
        }
        if (!unit) continue

        const bits: string[] = []
        const res = resInClause.length === 1 ? resInClause[0] : resInClause.length === 0 ? candRes : null
        if (res) bits.push(res)
        const quality = clause.match(QUALITY_RE)?.[0]?.toLowerCase()
        if (quality && quality !== res) bits.push(quality)
        if (extraLabel) bits.push(extraLabel)
        if (/audio\s*off|without\s+audio|no\s+audio/i.test(clause)) bits.push('audio off')
        else if (/audio\s*on|with\s+audio/i.test(clause)) bits.push('audio on')

        usd = Math.round(usd * 1e6) / 1e6
        const label = bits.join(' ')
        const dedupe = usd + '|' + unit + '|' + label
        if (seenCand.has(dedupe)) continue
        seenCand.add(dedupe)
        candidates.push({ usd, unit, label, context: clause.trim().slice(0, 140) })
      }
      candRes = resInClause.length === 1 ? resInClause[0] : null
    }
  }

  const tiers = { resolution: settle(resHits), audio: settle(audioHits) }
  return { parsed, candidates, tiers: Object.keys(tiers.resolution).length || Object.keys(tiers.audio).length ? tiers : empty, skipReason }
}

/**
 * Our model id → every fal endpoint it can submit to.
 *
 * FAL_ENDPOINTS is keyed by model id plus a mode suffix ('seedance-2.0-r2v',
 * 'wan-2.7-text'). A plain prefix test would hand 'seedance-2.0-fast-t2v' to
 * 'seedance-2.0' as well, so each key goes to the LONGEST model id it matches.
 */
function videoEndpointMap(): Map<string, string[]> {
  const ids = VIDEO_MODEL_SPECS.map(s => s.id).sort((a, b) => b.length - a.length)
  const out = new Map<string, string[]>(ids.map(id => [id, [] as string[]]))
  for (const [key, endpoint] of Object.entries(FAL_ENDPOINTS)) {
    const owner = ids.find(id => key === id || key.startsWith(id + '-'))
    if (owner) out.get(owner)!.push(endpoint)
  }
  return out
}

function lookup(
  catalog: Map<string, string>,
  endpoints: string[],
): { endpoint: string | null; text: string | null; match: 'exact' | 'prefix' | 'none' } {
  for (const e of endpoints) {
    const t = catalog.get(e)
    if (t) return { endpoint: e, text: t, match: 'exact' }
  }
  // Some of our ids are the family root ('fal-ai/sync-lipsync/v3'); fal lists
  // the per-mode children. Any child's blurb is the family's blurb.
  for (const e of endpoints) {
    for (const [id, t] of catalog) {
      if (t && id.startsWith(e + '/')) return { endpoint: id, text: t, match: 'prefix' }
    }
  }
  return { endpoint: endpoints[0] ?? null, text: null, match: 'none' }
}

async function build(): Promise<Payload> {
  const errors: string[] = []
  const jobs: Promise<{ id?: unknown; pricingInfoOverride?: unknown }[]>[] = []
  for (const kw of KEYWORDS) {
    for (let p = 1; p <= PAGES_PER_KEYWORD; p++) {
      jobs.push(
        fetchPage(kw, p).catch(e => {
          errors.push(e instanceof Error ? e.message : `${kw} p${p}: failed`)
          return []
        }),
      )
    }
  }
  const pages = await Promise.all(jobs)

  const catalog = new Map<string, string>()
  for (const items of pages) {
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : ''
      if (!id || catalog.has(id)) continue
      catalog.set(id, typeof it.pricingInfoOverride === 'string' ? it.pricingInfoOverride : '')
    }
  }

  const rows: FalPricingRow[] = []

  const vmap = videoEndpointMap()
  for (const spec of VIDEO_MODEL_SPECS) {
    const endpoints = vmap.get(spec.id) ?? []
    const hit = lookup(catalog, endpoints)
    const parse = hit.text
      ? parseFalPricing(hit.text)
      : { parsed: null, candidates: [], tiers: { resolution: {}, audio: {} }, skipReason: null }
    rows.push({
      id: spec.id, kind: 'video',
      endpoint: hit.endpoint, endpoints, match: hit.match,
      pricingText: hit.text, suggested: parse.parsed, candidates: parse.candidates, tiers: parse.tiers,
      suggestSkipReason: parse.skipReason,
    })
  }

  for (const m of AI_MODELS) {
    // An AIModel's `name` IS its fal endpoint id (the Gemini/Imagen entries are
    // Google-hosted and will simply never match).
    const endpoints = [m.name]
    const hit = lookup(catalog, endpoints)
    const parse = hit.text
      ? parseFalPricing(hit.text)
      : { parsed: null, candidates: [], tiers: { resolution: {}, audio: {} }, skipReason: null }
    rows.push({
      id: m.id, kind: 'image',
      endpoint: hit.endpoint, endpoints, match: hit.match,
      pricingText: hit.text, suggested: parse.parsed, candidates: parse.candidates, tiers: parse.tiers,
      suggestSkipReason: parse.skipReason,
    })
  }

  const matched = rows.filter(r => !!r.pricingText).length
  return {
    scannedAt: new Date().toISOString(),
    catalogSize: catalog.size,
    catalogWithPricing: [...catalog.values()].filter(Boolean).length,
    rows,
    matched,
    unmatched: rows.length - matched,
    errors,
  }
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1'
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ ...cache.payload, cached: true })
  }

  try {
    const payload = await build()
    // Never pin a total wash-out for ten minutes
    if (payload.matched > 0) cache = { at: Date.now(), payload }
    return NextResponse.json({ ...payload, cached: false })
  } catch (e) {
    if (cache) return NextResponse.json({ ...cache.payload, cached: true, stale: true })
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fal pricing sweep failed' },
      { status: 502 },
    )
  }
}
