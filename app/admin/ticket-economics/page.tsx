"use client"

// ── Ticket Economics (ADMIN ONLY) ────────────────────────────────────────────
// What every model charges the user in tickets, what it costs US in USD on fal,
// and therefore whether it makes money. Ticket costs are never typed in here —
// image models read config/ai-models.config.ts and video models call the same
// lib/ticket-pricing.ts#videoTicketCost the billing route calls, so this page
// cannot quote a price the user will not actually be charged.
//
// The only thing the owner types is fal's USD cost and a note. Those live in
// User.portalPreferences.ticketEconomics via /api/user/preferences.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle, ArrowLeft, Calculator, Check, ChevronDown, Loader2, Lock,
  RefreshCw, Search, Sparkles, X,
} from "lucide-react"
import { SiteLogoBox } from "@/components/SitePageHeader"
import { AI_MODELS, getTicketCost } from "@/config/ai-models.config"
import { FAL_TOOL_MODELS, TOOL_CATEGORY_LABEL } from "@/lib/fal-tool-models"
import {
  DEV_TIER_PRICING_NOTES, TICKET_PACKAGES, VIDEO_MODEL_SPECS,
  usdPerTicket, videoTicketCost, videoTicketCostDev,
  type VideoModelPricingSpec,
} from "@/lib/ticket-pricing"

const SILVER_RIM =
  "conic-gradient(from 0deg, rgba(226,232,240,0.1), #f8fafc, #94a3b8, rgba(226,232,240,0.15), #cbd5e1, #64748b, rgba(226,232,240,0.1))"

function SilverRim({ rounded = 16 }: { rounded?: number }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 pointer-events-none z-20"
      style={{
        borderRadius: rounded,
        padding: 1.5,
        opacity: 0.5,
        WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        maskComposite: "exclude",
      } as React.CSSProperties}
    >
      <span className="absolute -inset-[75%] animate-spin" style={{ background: SILVER_RIM, animationDuration: "6s" }} />
    </span>
  )
}

const pw = () => { try { return sessionStorage.getItem("admin-password") || "" } catch { return "" } }
const ah = (): Record<string, string> => (pw() ? { "x-admin-password": pw() } : {})

// ── Types ───────────────────────────────────────────────────────────────────

type Kind = "image" | "video" | "tool"
type CostUnit = "gen" | "sec"

/** What the owner typed for one model. */
interface CostEntry {
  usd: number | null
  unit: CostUnit
  notes: string
  /** Which of fal's parsed prices this row follows, when more than one exists. */
  pick?: string | null
}

/** Where a row's cost number comes from. */
type CostSource = "synced" | "manual"

/** One price parsed out of fal's own blurb. */
interface FalCandidate {
  usd: number
  unit: CostUnit
  label: string
  context: string
}

/** Identity of a candidate, stable across re-sweeps. */
const candKey = (c: FalCandidate) => `${c.usd}|${c.unit}|${c.label}`

interface Basis {
  /** Index into TICKET_PACKAGES, or -1 for the custom rate. */
  pack: number
  tier: "free" | "dev"
  customUsdPerTicket: number
}

/** Per-row knobs for the formula-priced video models. */
interface Knobs {
  duration: string
  resolution: string
  audio: boolean
  /** Seconds of the uploaded clip, for lipsync / motion / video tools. */
  sourceSec: number
  upscaleFactor: string
}

interface Persisted {
  costs: Record<string, CostEntry>
  basis: Basis
  knobs: Record<string, Knobs>
  costSource: CostSource
}

interface FalRow {
  id: string
  kind: Kind
  endpoint: string | null
  endpoints: string[]
  match: "exact" | "prefix" | "none"
  pricingText: string | null
  suggested: { usd: number; unit: CostUnit; resolution: string | null } | null
  candidates: FalCandidate[]
  suggestSkipReason: string | null
}

/**
 * Which of fal's parsed prices a row should follow when the owner has not
 * picked one: the tier matching the row's own settings, else the dearest.
 * Never the cheapest — a margin flattered by a tier this run isn't using is
 * worse than no number at all.
 */
function autoCandidate(cands: FalCandidate[], k: Knobs, supportsAudio: boolean): FalCandidate | null {
  if (cands.length === 0) return null
  if (cands.length === 1) return cands[0]
  const res = (k.resolution || "").toLowerCase()
  if (res) {
    const hit = cands.find(c => c.label.includes(res))
    if (hit) return hit
  }
  if (supportsAudio) {
    const want = k.audio ? "audio on" : "audio off"
    const hit = cands.find(c => c.label.includes(want))
    if (hit) return hit
  }
  return [...cands].sort((a, b) => b.usd - a.usd)[0]
}

interface FalPayload {
  scannedAt: string
  catalogSize: number
  catalogWithPricing: number
  rows: FalRow[]
  matched: number
  unmatched: number
  errors: string[]
  cached?: boolean
}

// ── Model rows, built once from code ────────────────────────────────────────

interface ModelRow {
  key: string
  id: string
  kind: Kind
  label: string
  spec?: VideoModelPricingSpec
  /** Image only: quality choices that actually change the ticket price. */
  qualities: string[]
  note?: string
  /** Tool only: what calls it, so an unbilled row can be traced to a feature. */
  usedBy?: string
  /** Tool only: tickets charged today. These are all 0 — that is the point. */
  toolTickets?: number
}

/**
 * Quality tiers worth showing for an image model: probe getTicketCost with each
 * candidate and keep one label per distinct price. Models with a single price
 * get no selector at all.
 */
function imageQualities(id: string): string[] {
  const candidates = ["2k", "4k", "4x"]
  const seen = new Map<number, string>()
  for (const q of candidates) {
    const c = getTicketCost(id, q)
    if (!seen.has(c)) seen.set(c, q)
  }
  return seen.size > 1 ? [...seen.values()] : []
}

const MODEL_ROWS: ModelRow[] = [
  ...VIDEO_MODEL_SPECS.map<ModelRow>(spec => ({
    key: `video:${spec.id}`,
    id: spec.id,
    kind: "video",
    label: spec.label,
    spec,
    qualities: [],
    note: spec.note,
  })),
  ...AI_MODELS.map<ModelRow>(m => ({
    key: `image:${m.id}`,
    id: m.id,
    kind: "image",
    label: m.displayName,
    qualities: imageQualities(m.id),
  })),
  // Everything else this site calls at fal: audio, masking, relight, face
  // swap, transcription, LoRA training. Every one of them is FREE to the user
  // today, which is precisely why they belong on a page about margin.
  ...FAL_TOOL_MODELS.map<ModelRow>(t => ({
    key: `tool:${t.id}`,
    id: t.id,
    kind: "tool",
    label: `${TOOL_CATEGORY_LABEL[t.category]} · ${t.label}`,
    qualities: [],
    note: t.notes,
    usedBy: t.usedBy,
    toolTickets: t.ticketCost,
  })),
]

const DEFAULT_BASIS: Basis = { pack: 1, tier: "free", customUsdPerTicket: 0.18 }

function defaultKnobs(spec?: VideoModelPricingSpec): Knobs {
  return {
    duration: spec?.durations[0] ?? "5",
    resolution: spec?.resolutions.includes("1080p") ? "1080p" : (spec?.resolutions[0] ?? "1080p"),
    audio: false,
    sourceSec: 5,
    upscaleFactor: "2",
  }
}

/** Seconds this row is billed for — what a per-second fal rate multiplies. */
function billedSeconds(spec: VideoModelPricingSpec, k: Knobs): number {
  if (spec.durationSource !== "none") return k.sourceSec
  if (k.duration === "auto") return 5
  const n = parseInt(k.duration)
  return Number.isFinite(n) ? n : 5
}

const fmtUsd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)
const fmtPct = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(0)}%`

// ── Page ────────────────────────────────────────────────────────────────────

export default function TicketEconomicsPage() {
  // ── Auth gate (same pattern as /admin/model-watch) ──
  const [authed, setAuthed] = useState(false)
  const [gatePw, setGatePw] = useState("")
  const [gateBusy, setGateBusy] = useState(false)
  const [gateError, setGateError] = useState<string | null>(null)
  useEffect(() => { if (pw()) setAuthed(true) }, [])
  const unlock = async () => {
    if (!gatePw.trim() || gateBusy) return
    setGateBusy(true); setGateError(null)
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: gatePw }),
      })
      if (res.ok) {
        try { sessionStorage.setItem("admin-password", gatePw) } catch {}
        setGatePw(""); setAuthed(true)
      } else setGateError("Incorrect password")
    } catch { setGateError("Verification failed") } finally { setGateBusy(false) }
  }

  // ── Owner-entered data ──
  const [costs, setCosts] = useState<Record<string, CostEntry>>({})
  const [knobs, setKnobs] = useState<Record<string, Knobs>>({})
  const [basis, setBasis] = useState<Basis>(DEFAULT_BASIS)
  // Synced: follow the numbers parsed out of fal's own pricing copy, so the
  // sheet fills itself. Manual: only what the owner typed counts.
  const [costSource, setCostSource] = useState<CostSource>("synced")
  const [loadedPrefs, setLoadedPrefs] = useState(false)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")

  // ── fal pricing sweep ──
  const [fal, setFal] = useState<FalPayload | null>(null)
  const [falLoading, setFalLoading] = useState(false)
  const [falError, setFalError] = useState<string | null>(null)

  // ── View ──
  const [kindFilter, setKindFilter] = useState<"all" | Kind>("all")
  const [query, setQuery] = useState("")
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // ── Calculator ──
  const [calcUsd, setCalcUsd] = useState("0.10")
  const [calcMargin, setCalcMargin] = useState("70")

  // ── Load persisted prefs ──
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/user/preferences")
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        const te = (data?.preferences?.ticketEconomics ?? {}) as Partial<Persisted>
        if (cancelled) return
        if (te.costs && typeof te.costs === "object") setCosts(te.costs as Record<string, CostEntry>)
        if (te.knobs && typeof te.knobs === "object") setKnobs(te.knobs as Record<string, Knobs>)
        if (te.basis && typeof te.basis === "object") setBasis({ ...DEFAULT_BASIS, ...te.basis })
        if (te.costSource === "synced" || te.costSource === "manual") setCostSource(te.costSource)
      } catch {
        // A missing/failed prefs read just means an empty sheet — never blocks the page
      } finally {
        if (!cancelled) setLoadedPrefs(true)
      }
    })()
    return () => { cancelled = true }
  }, [authed])

  // ── Debounced save (~1s) ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstSaveSkip = useRef(true)
  useEffect(() => {
    if (!authed || !loadedPrefs) return
    // Don't write straight back what we just read
    if (firstSaveSkip.current) { firstSaveSkip.current = false; return }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState("saving")
    saveTimer.current = setTimeout(async () => {
      try {
        const body: { ticketEconomics: Persisted } = { ticketEconomics: { costs, knobs, basis, costSource } }
        const res = await fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        setSaveState(res.ok ? "saved" : "error")
      } catch { setSaveState("error") }
    }, 1000)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [costs, knobs, basis, costSource, authed, loadedPrefs])

  // ── fal sweep ──
  const loadFal = useCallback(async (refresh = false) => {
    setFalLoading(true); setFalError(null)
    try {
      const res = await fetch(`/api/admin/ticket-economics${refresh ? "?refresh=1" : ""}`, { headers: ah() })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || `fal pricing failed (${res.status})`)
      setFal(data as FalPayload)
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setFalError(`Some keyword pages failed: ${data.errors.slice(0, 4).join(" · ")}`)
      }
    } catch (e) {
      setFalError(e instanceof Error ? e.message : "fal pricing failed")
    } finally { setFalLoading(false) }
  }, [])

  useEffect(() => { if (authed) void loadFal() }, [authed, loadFal])

  const falByKey = useMemo(() => {
    const m = new Map<string, FalRow>()
    for (const r of fal?.rows ?? []) m.set(`${r.kind}:${r.id}`, r)
    return m
  }, [fal])

  // ── Basis rate ──
  const rate = useMemo(() => {
    if (basis.pack < 0) return Math.max(0, basis.customUsdPerTicket) || 0
    const pack = TICKET_PACKAGES[basis.pack] ?? TICKET_PACKAGES[1]
    return usdPerTicket(pack, basis.tier)
  }, [basis])

  // ── Computed rows ──
  const computed = useMemo(() => {
    return MODEL_ROWS.map(row => {
      const k = knobs[row.key] ?? defaultKnobs(row.spec)
      let ticketsRegular: number
      let ticketsDev: number
      let seconds = 1

      if (row.kind === "video" && row.spec) {
        const input = {
          model: row.id,
          duration: k.duration,
          resolution: k.resolution || "1080p",
          generateAudio: k.audio,
          sd20Mode: "t2v",
          effectiveSd20Mode: "t2v",
          referenceVideoCount: 0,
          referenceVideoDurationSec: 0,
          editVideoDurationSec: row.spec.durationSource === "source-clip" ? k.sourceSec : 0,
          lipsyncVideoDurationSec: row.spec.durationSource === "lipsync" ? k.sourceSec : 0,
          motionVideoDurationSec: row.spec.durationSource === "motion" ? k.sourceSec : undefined,
          characterOrientation: "image",
          videoUpscaleFactor: k.upscaleFactor,
        }
        ticketsRegular = videoTicketCost(input)
        ticketsDev = videoTicketCostDev(input)
        seconds = billedSeconds(row.spec, k)
      } else if (row.kind === "tool") {
        // No pricing function to consult: these have never been billed. The
        // row exists to show fal's cost against a revenue of zero.
        ticketsRegular = row.toolTickets ?? 0
        ticketsDev = ticketsRegular
      } else {
        const q = row.qualities.length > 0 ? (k.duration || row.qualities[0]) : undefined
        ticketsRegular = getTicketCost(row.id, row.qualities.includes(q ?? "") ? q : row.qualities[0])
        ticketsDev = ticketsRegular
      }

      const entry = costs[row.key]

      // fal's parsed prices for this row, and the one it follows by default
      const cands = falByKey.get(row.key)?.candidates ?? []
      const picked = entry?.pick ? cands.find(c => candKey(c) === entry.pick) ?? null : null
      const auto = picked ?? autoCandidate(cands, k, !!row.spec?.supportsAudio)

      // A typed number always wins — that is what an override is. In manual
      // mode fal's numbers are ignored outright.
      const typed = entry?.usd == null ? null : { usd: entry.usd, unit: entry.unit }
      const active = costSource === "manual" ? typed : (typed ?? (auto ? { usd: auto.usd, unit: auto.unit } : null))
      const source: "manual" | "synced" | "none" =
        active == null ? "none" : typed != null ? "manual" : "synced"

      const perGen = active == null
        ? null
        : active.unit === "sec" ? active.usd * seconds : active.usd

      const revenue = ticketsRegular * rate
      const revenueDev = ticketsDev * rate
      const margin = perGen == null ? null : revenue - perGen
      const marginPct = perGen == null || revenue <= 0 ? null : ((revenue - perGen) / revenue) * 100

      return { row, k, ticketsRegular, ticketsDev, seconds, perGen, revenue, revenueDev, margin, marginPct, cands, auto, source }
    })
  }, [knobs, costs, rate, falByKey, costSource])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return computed.filter(c => {
      if (kindFilter !== "all" && c.row.kind !== kindFilter) return false
      if (onlyMissing && c.perGen != null) return false
      if (q && !`${c.row.id} ${c.row.label}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [computed, kindFilter, query, onlyMissing])

  // ── Summary ──
  const summary = useMemo(() => {
    const priced = computed.filter(c => c.perGen != null && c.marginPct != null)
    const missing = computed.length - priced.length
    const totalMargin = priced.reduce((s, c) => s + (c.margin ?? 0), 0)
    const avgPct = priced.length ? priced.reduce((s, c) => s + (c.marginPct ?? 0), 0) / priced.length : null
    const worst = [...priced].sort((a, b) => (a.marginPct ?? 0) - (b.marginPct ?? 0)).slice(0, 6)
    const losing = priced.filter(c => (c.margin ?? 0) < 0).length
    const synced = computed.filter(c => c.source === "synced").length
    const manual = computed.filter(c => c.source === "manual").length
    const syncable = computed.filter(c => c.cands.length > 0).length
    return { priced: priced.length, missing, totalMargin, avgPct, worst, losing, synced, manual, syncable }
  }, [computed])

  const falMatched = fal ? fal.matched : 0
  const falTotal = fal ? fal.rows.length : 0

  // ── Mutators ──
  const setCost = (key: string, patch: Partial<CostEntry>) =>
    setCosts(prev => {
      const base: CostEntry = prev[key] ?? { usd: null, unit: "gen", notes: "" }
      return { ...prev, [key]: { ...base, ...patch } }
    })
  const setKnob = (key: string, spec: VideoModelPricingSpec | undefined, patch: Partial<Knobs>) =>
    setKnobs(prev => {
      const base: Knobs = prev[key] ?? defaultKnobs(spec)
      return { ...prev, [key]: { ...base, ...patch } }
    })

  // ── Calculator ──
  const calc = useMemo(() => {
    const cost = parseFloat(calcUsd)
    const m = parseFloat(calcMargin)
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(m) || m >= 100) return null
    const revenueNeeded = cost / (1 - m / 100)
    const per = TICKET_PACKAGES.flatMap(p => ([
      { label: `${p.tickets} pack · free`, r: usdPerTicket(p, "free") },
      { label: `${p.tickets} pack · dev`, r: usdPerTicket(p, "dev") },
    ]))
    return {
      revenueNeeded,
      rows: per.map(x => ({ ...x, tickets: Math.ceil(revenueNeeded / x.r) })),
      atBasis: rate > 0 ? Math.ceil(revenueNeeded / rate) : null,
    }
  }, [calcUsd, calcMargin, rate])

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6 overflow-x-hidden">
        <div className="relative isolate w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a101d] p-6 space-y-4">
          <SilverRim />
          <div className="flex items-center gap-3">
            <SiteLogoBox size={34} rounded={11} />
            <div>
              <p className="text-sm font-bold text-white">Ticket Economics</p>
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">Admin only</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Lock size={13} className="text-slate-500 shrink-0" />
            <input type="password" value={gatePw} onChange={e => setGatePw(e.target.value)}
              onKeyDown={e => e.key === "Enter" && unlock()}
              placeholder="Admin password"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30" />
            <button onClick={unlock} disabled={gateBusy}
              className="px-3.5 py-2 rounded-lg bg-white/10 border border-white/25 text-sm font-bold text-white hover:bg-white/15 disabled:opacity-50">
              {gateBusy ? <Loader2 size={14} className="animate-spin" /> : "Unlock"}
            </button>
          </div>
          {gateError && <p className="text-[11px] text-red-400">{gateError}</p>}
        </div>
      </div>
    )
  }

  const cellCls = "px-2.5 py-2 align-top"
  const inputCls = "px-2 py-1 rounded-md bg-slate-950 border border-white/10 text-[12px] text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30"
  const selectCls = "px-1.5 py-1 rounded-md bg-slate-950 border border-white/10 text-[11px] text-white focus:outline-none focus:border-white/30"
  const chipCls = (on: boolean) =>
    `px-2 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors ${
      on ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`

  return (
    <div className="min-h-screen bg-[#05080f] text-white overflow-x-hidden overscroll-x-none">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#05080f]/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/admin" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-xs text-slate-400 hover:text-white transition-all shrink-0">
            <ArrowLeft size={12} /> Admin
          </Link>
          <SiteLogoBox size={26} rounded={9} />
          <div className="min-w-0">
            <p className="text-sm font-bold leading-none truncate">Ticket Economics</p>
            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mt-1 truncate">tickets in · fal dollars out</p>
          </div>
          <div className="flex-1" />
          <span className="text-[9px] font-mono uppercase tracking-[0.16em] shrink-0 min-w-[46px] text-right">
            {saveState === "saving" && <span className="text-slate-500">saving…</span>}
            {saveState === "saved" && <span className="text-emerald-400 inline-flex items-center gap-1"><Check size={10} />saved</span>}
            {saveState === "error" && <span className="text-red-400">save failed</span>}
          </span>
          <button onClick={() => void loadFal(true)} disabled={falLoading} title="Re-sweep fal pricing"
            className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40 shrink-0">
            <RefreshCw size={13} className={falLoading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-5 space-y-4">

        {/* ── $/ticket basis ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
          <SilverRim />
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">$ / ticket basis</p>
            <p className="text-[11px] text-slate-500">margin depends entirely on which pack the user bought</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TICKET_PACKAGES.map((p, i) => (
              <button key={p.tickets} onClick={() => setBasis(b => ({ ...b, pack: i }))} className={chipCls(basis.pack === i)}>
                {p.tickets}
              </button>
            ))}
            <button onClick={() => setBasis(b => ({ ...b, pack: -1 }))} className={chipCls(basis.pack === -1)}>custom</button>
            <span className="w-px self-stretch bg-white/10 mx-1" />
            <button onClick={() => setBasis(b => ({ ...b, tier: "free" }))} className={chipCls(basis.tier === "free" && basis.pack >= 0)} disabled={basis.pack < 0}>free tier</button>
            <button onClick={() => setBasis(b => ({ ...b, tier: "dev" }))} className={chipCls(basis.tier === "dev" && basis.pack >= 0)} disabled={basis.pack < 0}>dev tier</button>
            {basis.pack === -1 && (
              <span className="inline-flex items-center gap-1 ml-1">
                <span className="text-[11px] text-slate-500">$</span>
                <input type="number" step="0.001" min="0" value={basis.customUsdPerTicket}
                  onChange={e => setBasis(b => ({ ...b, customUsdPerTicket: parseFloat(e.target.value) || 0 }))}
                  className={`${inputCls} w-24`} />
                <span className="text-[11px] text-slate-500">/ticket</span>
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-lg font-bold text-emerald-300">${rate.toFixed(4)}<span className="text-[11px] font-normal text-slate-500"> per ticket</span></p>
            {basis.pack >= 0 && (
              <p className="text-[11px] text-slate-500">
                {TICKET_PACKAGES[basis.pack].tickets} tickets for ${(basis.tier === "dev" ? TICKET_PACKAGES[basis.pack].devTierPrice : TICKET_PACKAGES[basis.pack].freeTierPrice).toFixed(2)} ({basis.tier} tier)
              </p>
            )}
          </div>
          {/* Every pack's rate, so the spread is visible at a glance */}
          <div className="overflow-x-auto overscroll-x-contain -mx-1 px-1">
            <table className="w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-slate-500 font-mono uppercase tracking-wider text-[9px]">
                  <th className="text-left py-1 pr-2">pack</th>
                  <th className="text-right py-1 px-2">free $</th>
                  <th className="text-right py-1 px-2">free $/tkt</th>
                  <th className="text-right py-1 px-2">dev $</th>
                  <th className="text-right py-1 pl-2">dev $/tkt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {TICKET_PACKAGES.map(p => (
                  <tr key={p.tickets}>
                    <td className="py-1 pr-2 text-slate-300">{p.tickets}</td>
                    <td className="py-1 px-2 text-right text-slate-400">${p.freeTierPrice.toFixed(2)}</td>
                    <td className="py-1 px-2 text-right text-white font-mono">${usdPerTicket(p, "free").toFixed(4)}</td>
                    <td className="py-1 px-2 text-right text-slate-400">${p.devTierPrice.toFixed(2)}</td>
                    <td className="py-1 pl-2 text-right text-white font-mono">${usdPerTicket(p, "dev").toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Summary ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
          <SilverRim />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="models" value={String(computed.length)} sub={`${VIDEO_MODEL_SPECS.length} video · ${AI_MODELS.length} image · ${FAL_TOOL_MODELS.length} tools`} />
            <Stat label="no fal cost" value={String(summary.missing)}
              sub={costSource === "synced" ? `${summary.synced} synced · ${summary.manual} typed` : `${summary.manual} typed · ${summary.syncable} syncable`}
              tone={summary.missing > 0 ? "warn" : "ok"} />
            <Stat label="avg margin" value={summary.avgPct == null ? "—" : fmtPct(summary.avgPct)} sub={`over ${summary.priced} priced`} tone={summary.avgPct != null && summary.avgPct < 0 ? "bad" : "ok"} />
            <Stat label="losing money" value={String(summary.losing)} sub="negative margin" tone={summary.losing > 0 ? "bad" : "ok"} />
          </div>
          <p className="text-[11px] text-slate-500">
            Total margin at one generation each, at the current basis:{" "}
            <span className={summary.totalMargin < 0 ? "text-red-400 font-bold" : "text-emerald-300 font-bold"}>{fmtUsd(summary.totalMargin)}</span>
          </p>
          {summary.worst.length > 0 && (
            <div>
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mb-1.5">worst margins</p>
              <div className="flex flex-wrap gap-1.5">
                {summary.worst.map(c => (
                  <span key={c.row.key}
                    className={`px-2 py-1 rounded-lg border text-[10px] font-mono ${
                      (c.marginPct ?? 0) < 0
                        ? "bg-red-500/15 text-red-300 border-red-400/30"
                        : "bg-white/[0.04] text-slate-400 border-white/10"}`}>
                    {c.row.label} {fmtPct(c.marginPct ?? 0)}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] font-mono text-slate-600">
            fal pricing: {falMatched}/{falTotal} models matched
            {fal ? ` · catalog ${fal.catalogSize} (${fal.catalogWithPricing} priced) · swept ${new Date(fal.scannedAt).toLocaleString()}${fal.cached ? " · cached" : ""}` : falLoading ? " · sweeping…" : ""}
          </p>
          {falError && <p className="text-[11px] text-amber-400 break-words">{falError}</p>}
        </div>

        {/* ── What should I charge? ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
          <SilverRim />
          <div className="flex items-center gap-2">
            <Calculator size={15} className="text-emerald-300 shrink-0" />
            <p className="text-sm font-bold">What should I charge?</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500">fal cost (USD)</span>
              <input type="number" step="0.001" min="0" value={calcUsd} onChange={e => setCalcUsd(e.target.value)} className={`${inputCls} w-28`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500">target margin %</span>
              <input type="number" step="1" max="99" value={calcMargin} onChange={e => setCalcMargin(e.target.value)} className={`${inputCls} w-24`} />
            </label>
            {calc && (
              <div className="text-[11px] text-slate-400">
                needs <span className="text-white font-bold">{fmtUsd(calc.revenueNeeded)}</span> of revenue
                {calc.atBasis != null && <> · <span className="text-emerald-300 font-bold">{calc.atBasis} tickets</span> at the current basis</>}
              </div>
            )}
          </div>
          {!calc && <p className="text-[11px] text-amber-400">Enter a cost ≥ 0 and a margin below 100%.</p>}
          {calc && (
            <div className="overflow-x-auto overscroll-x-contain -mx-1 px-1">
              <table className="w-full min-w-[520px] text-[11px]">
                <thead>
                  <tr className="text-slate-500 font-mono uppercase tracking-wider text-[9px]">
                    <th className="text-left py-1 pr-2">pack · tier</th>
                    <th className="text-right py-1 px-2">$/ticket</th>
                    <th className="text-right py-1 pl-2">tickets to charge</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {calc.rows.map(r => (
                    <tr key={r.label}>
                      <td className="py-1 pr-2 text-slate-300 whitespace-nowrap">{r.label}</td>
                      <td className="py-1 px-2 text-right font-mono text-slate-400">${r.r.toFixed(4)}</td>
                      <td className="py-1 pl-2 text-right font-mono font-bold text-white">{r.tickets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-slate-600">
            Margin here is (revenue − cost) / revenue. The cheapest pack is the safest number to price against —
            a buyer on the 1000-pack pays the least per ticket.
          </p>
        </div>

        {/* ── Honesty notes ── */}
        <div className="relative isolate rounded-2xl border border-amber-400/20 bg-amber-500/[0.05] p-3.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} className="text-amber-400 shrink-0" />
            <p className="text-[11px] font-bold text-amber-200">Read before trusting a row</p>
          </div>
          <ul className="text-[11px] text-amber-100/70 space-y-1 list-disc pl-4">
            <li><b>Dev tier is not discounted.</b> /api/video/generate accepts a <code className="font-mono">hasDevTier</code> flag and never reads it, and /api/generate has no tier branch either — every tier pays the same tickets. The dev column mirrors the regular column for that reason, not by omission.</li>
            <li>Image ticket costs come from <code className="font-mono">config/ai-models.config.ts</code> (what /api/generate charges). The portal-v2 UI keeps its own <code className="font-mono">calcTicketCost</code> table with extra models and extra quality tiers; this page does not read it.</li>
            <li>Several video models are marked PLACEHOLDER in the pricing code and are admin-only until priced — their margins are guesses until you enter a real fal cost.</li>
            <li><b>Synced numbers are parsed out of fal&apos;s marketing copy, not billed rates.</b> Where a blurb quotes several prices each becomes a pickable tier, and a row defaults to the tier matching its own settings — or, failing that, to the <b>dearest</b> price quoted, so a margin is never flattered. Rows priced per megapixel or per token sync nothing at all, because neither converts to a per-generation figure from here. Switch the cost source to <b>manual</b> to price only against numbers you typed yourself.</li>
          </ul>
        </div>

        {/* ── Controls ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-3 space-y-3">
          <SilverRim />
          <div className="flex items-center gap-2">
            <Search size={13} className="text-slate-500 shrink-0" />
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search model…"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30" />
            {query && (
              <button onClick={() => setQuery("")} className="p-2 rounded-lg text-slate-500 hover:text-white shrink-0"><X size={13} /></button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["all", "video", "image"] as const).map(c => (
              <button key={c} onClick={() => setKindFilter(c)} className={chipCls(kindFilter === c)}>{c}</button>
            ))}
            <span className="w-px self-stretch bg-white/10 mx-1" />
            <button onClick={() => setOnlyMissing(v => !v)} className={chipCls(onlyMissing)}>no fal cost yet</button>
          </div>

          {/* Cost source. Synced reads fal's own pricing copy so the sheet
              fills itself; manual counts only what was typed. A typed number
              overrides its row in either mode. */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/[0.06]">
            <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mr-1">cost source</span>
            <button onClick={() => setCostSource("synced")} className={chipCls(costSource === "synced")}>
              synced · fal
            </button>
            <button onClick={() => setCostSource("manual")} className={chipCls(costSource === "manual")}>
              manual
            </button>
            <span className="text-[10px] text-slate-500 basis-full sm:basis-auto">
              {costSource === "synced"
                ? <>{summary.synced} rows on fal&apos;s parsed numbers · {summary.manual} typed by hand · {summary.missing} still blank</>
                : <>{summary.manual} typed by hand · {summary.syncable} rows have a fal number waiting</>}
            </span>
          </div>
        </div>

        {/* ── Table ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-2">
          <SilverRim />
          <div className="overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-[1080px] text-[12px] border-collapse">
              <thead>
                <tr className="text-slate-500 font-mono uppercase tracking-wider text-[9px] border-b border-white/[0.08]">
                  <th className={`${cellCls} text-left`}>model</th>
                  <th className={`${cellCls} text-left`}>kind</th>
                  <th className={`${cellCls} text-left`}>settings</th>
                  <th className={`${cellCls} text-right`}>tkts</th>
                  <th className={`${cellCls} text-right`}>tkts dev</th>
                  <th className={`${cellCls} text-left`}>fal cost (USD)</th>
                  <th className={`${cellCls} text-right`}>revenue</th>
                  <th className={`${cellCls} text-right`}>margin $</th>
                  <th className={`${cellCls} text-right`}>margin %</th>
                  <th className={`${cellCls} text-left`}>notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {visible.length === 0 && (
                  <tr><td colSpan={10} className="py-14 text-center text-xs text-slate-500">Nothing matches — clear the filters.</td></tr>
                )}
                {visible.map(c => {
                  const key = c.row.key
                  const entry = costs[key]
                  const falRow = falByKey.get(key)
                  const isOpen = expanded === key
                  const negative = c.margin != null && c.margin < 0
                  const devNote = DEV_TIER_PRICING_NOTES[c.row.id]
                  return (
                    <tr key={key} className="hover:bg-white/[0.02] transition-colors">
                      {/* model */}
                      <td className={cellCls}>
                        <p className="font-bold text-white whitespace-nowrap">{c.row.label}</p>
                        <p className="text-[9px] font-mono text-slate-600 whitespace-nowrap">{c.row.id}</p>
                      </td>
                      {/* kind */}
                      <td className={cellCls}>
                        <span className={`px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase ${
                          c.row.kind === "video"
                            ? "bg-violet-500/15 text-violet-300 border-violet-400/25"
                            : c.row.kind === "tool"
                            // Amber, because every tool row is a cost with no
                            // revenue against it until it is priced.
                            ? "bg-amber-500/15 text-amber-300 border-amber-400/25"
                            : "bg-sky-500/15 text-sky-300 border-sky-400/25"}`}>
                          {c.row.kind}
                        </span>
                      </td>
                      {/* settings */}
                      <td className={cellCls}>
                        <div className="flex flex-wrap items-center gap-1 max-w-[260px]">
                          {c.row.kind === "video" && c.row.spec ? (
                            <>
                              {c.row.spec.durations.length > 0 && (
                                <select value={c.k.duration} onChange={e => setKnob(key, c.row.spec, { duration: e.target.value })} className={selectCls}>
                                  {c.row.spec.durations.map(d => <option key={d} value={d}>{d === "auto" ? "auto" : `${d}s`}</option>)}
                                </select>
                              )}
                              {c.row.spec.resolutions.length > 0 && (
                                <select value={c.k.resolution} onChange={e => setKnob(key, c.row.spec, { resolution: e.target.value })} className={selectCls}>
                                  {c.row.spec.resolutions.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                              )}
                              {c.row.spec.supportsAudio && (
                                <button onClick={() => setKnob(key, c.row.spec, { audio: !c.k.audio })} className={chipCls(c.k.audio)}>audio</button>
                              )}
                              {c.row.spec.durationSource !== "none" && (
                                <label className="inline-flex items-center gap-1">
                                  <input type="number" min="0" step="0.5" value={c.k.sourceSec}
                                    onChange={e => setKnob(key, c.row.spec, { sourceSec: parseFloat(e.target.value) || 0 })}
                                    className={`${inputCls} w-16`} />
                                  <span className="text-[9px] font-mono text-slate-600">src s</span>
                                </label>
                              )}
                              {c.row.spec.showUpscaleFactor && (
                                <select value={c.k.upscaleFactor} onChange={e => setKnob(key, c.row.spec, { upscaleFactor: e.target.value })} className={selectCls}>
                                  {["1", "2", "3", "4"].map(f => <option key={f} value={f}>{f}x</option>)}
                                </select>
                              )}
                            </>
                          ) : c.row.qualities.length > 0 ? (
                            <select value={c.row.qualities.includes(c.k.duration) ? c.k.duration : c.row.qualities[0]}
                              onChange={e => setKnob(key, undefined, { duration: e.target.value })} className={selectCls}>
                              {c.row.qualities.map(q => <option key={q} value={q}>{q}</option>)}
                            </select>
                          ) : (
                            <span className="text-[10px] text-slate-600 font-mono">flat</span>
                          )}
                        </div>
                        {c.row.kind === "video" && (
                          <p className="text-[9px] font-mono text-slate-600 mt-1">{c.seconds}s billed</p>
                        )}
                        {c.row.kind === "tool" && c.row.usedBy && (
                          <p className="text-[9px] text-slate-600 mt-1">{c.row.usedBy}</p>
                        )}
                      </td>
                      {/* tickets */}
                      <td className={`${cellCls} text-right font-mono font-bold text-white`}>{c.ticketsRegular}</td>
                      <td className={`${cellCls} text-right font-mono`}>
                        <span className={c.ticketsDev === c.ticketsRegular ? "text-slate-500" : "text-emerald-300 font-bold"}>{c.ticketsDev}</span>
                        {c.ticketsDev === c.ticketsRegular && <span className="block text-[8px] text-slate-700 font-mono">same</span>}
                        {devNote && (
                          <span title={devNote} className="block text-[8px] text-amber-400 font-mono cursor-help">see note</span>
                        )}
                      </td>
                      {/* fal cost */}
                      <td className={cellCls}>
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] text-slate-500">$</span>
                          {/* Shows the synced figure when the row is following
                              fal; typing over it makes the row an override. */}
                          <input type="number" step="0.0001" min="0" placeholder="—"
                            value={entry?.usd ?? (c.source === "synced" && c.auto ? c.auto.usd : "")}
                            onChange={e => {
                              const v = e.target.value
                              setCost(key, { usd: v === "" ? null : parseFloat(v) })
                            }}
                            className={`${inputCls} w-24 ${c.source === "synced" ? "text-cyan-200 border-cyan-400/25" : ""}`} />
                          <select
                            value={c.source === "synced" && c.auto ? c.auto.unit : (entry?.unit ?? "gen")}
                            onChange={e => setCost(key, { unit: e.target.value as CostUnit })}
                            className={selectCls}>
                            <option value="gen">/gen</option>
                            <option value="sec">/sec</option>
                          </select>
                        </div>
                        {/* where this row's number came from */}
                        <div className="flex flex-wrap items-center gap-1 mt-0.5">
                          {c.source === "synced" && (
                            <span className="px-1.5 py-0.5 rounded border border-cyan-400/30 bg-cyan-500/10 text-[8px] font-mono uppercase tracking-wide text-cyan-300">
                              synced
                            </span>
                          )}
                          {c.source === "manual" && c.auto && (
                            <>
                              <span className="px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-500/10 text-[8px] font-mono uppercase tracking-wide text-amber-300">
                                overridden
                              </span>
                              <button onClick={() => setCost(key, { usd: null })}
                                title={`Back to fal's $${c.auto.usd}/${c.auto.unit}`}
                                className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono text-slate-400 hover:text-white hover:border-white/25">
                                revert
                              </button>
                            </>
                          )}
                          {costSource === "manual" && c.auto && c.source !== "manual" && (
                            <button onClick={() => setCost(key, { usd: c.auto!.usd, unit: c.auto!.unit })}
                              title="Copy fal's parsed number into this row - parsed, NOT confirmed"
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-400/30 bg-emerald-500/10 text-[9px] font-mono text-emerald-300 hover:bg-emerald-500/20">
                              <Sparkles size={9} />use ${c.auto.usd}/{c.auto.unit}
                            </button>
                          )}
                          {(entry?.unit === "sec" || (c.source === "synced" && c.auto?.unit === "sec")) && c.perGen != null && (
                            <span className="text-[9px] font-mono text-slate-600">= {fmtUsd(c.perGen)} this run</span>
                          )}
                        </div>

                        {/* which of fal's tiers this row follows */}
                        {c.cands.length > 1 && c.source !== "manual" && (
                          <select
                            value={entry?.pick && c.cands.some(cd => candKey(cd) === entry.pick) ? entry.pick : (c.auto ? candKey(c.auto) : "")}
                            onChange={e => setCost(key, { pick: e.target.value })}
                            title="fal quotes more than one price here - pick the one this row is priced against"
                            className={`${selectCls} mt-1 max-w-[220px]`}>
                            {c.cands.map(cd => (
                              <option key={candKey(cd)} value={candKey(cd)}>
                                {cd.label || "flat"} - ${cd.usd}/{cd.unit}
                              </option>
                            ))}
                          </select>
                        )}
                        {/* fal's own words */}
                        {falRow?.pricingText ? (
                          <div className="mt-1 max-w-[300px]">
                            <button onClick={() => setExpanded(isOpen ? null : key)}
                              className="text-left text-[10px] text-slate-500 hover:text-slate-300 transition-colors flex items-start gap-1">
                              <ChevronDown size={10} className={`mt-0.5 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                              <span className={isOpen ? "" : "line-clamp-2"}>
                                {falRow.pricingText.replace(/\*\*/g, "")}
                              </span>
                            </button>
                            {isOpen && (
                              <p className="text-[9px] font-mono text-slate-700 mt-1 break-all">
                                fal: {falRow.endpoint} ({falRow.match})
                              </p>
                            )}
                            {c.cands.length === 0 && falRow.suggestSkipReason && (
                              <p className="text-[9px] font-mono text-slate-700 mt-0.5">
                                nothing safe to sync: {falRow.suggestSkipReason} — enter by hand
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-[9px] font-mono text-slate-700 mt-1">
                            {fal ? "no fal pricing text — enter by hand" : falLoading ? "sweeping fal…" : ""}
                          </p>
                        )}
                      </td>
                      {/* revenue */}
                      <td className={`${cellCls} text-right font-mono text-slate-300 whitespace-nowrap`}>{fmtUsd(c.revenue)}</td>
                      {/* margin */}
                      <td className={`${cellCls} text-right font-mono whitespace-nowrap ${negative ? "text-red-400 font-bold" : "text-emerald-300"}`}>
                        {c.margin == null ? <span className="text-slate-700">—</span> : fmtUsd(c.margin)}
                      </td>
                      <td className={`${cellCls} text-right font-mono whitespace-nowrap ${negative ? "text-red-400 font-bold" : "text-emerald-300"}`}>
                        {c.marginPct == null ? <span className="text-slate-700">—</span> : fmtPct(c.marginPct)}
                      </td>
                      {/* notes */}
                      <td className={cellCls}>
                        <input value={entry?.notes ?? ""} onChange={e => setCost(key, { notes: e.target.value })}
                          placeholder="note…" className={`${inputCls} w-40`} />
                        {c.row.note && <p className="text-[9px] text-slate-600 mt-1 max-w-[220px]">{c.row.note}</p>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[10px] font-mono text-slate-600 text-center pb-6">
          showing {visible.length} of {computed.length} · ticket costs read from code · fal costs saved to your account
        </p>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone = "ok" }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-300" : "text-white"
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 min-w-0">
      <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 truncate">{label}</p>
      <p className={`text-xl font-bold leading-tight mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-600 truncate">{sub}</p>}
    </div>
  )
}
