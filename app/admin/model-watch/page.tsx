"use client"

// ── fal.ai Model Watch (ADMIN ONLY) ──────────────────────────────────────────
// Sweeps fal's public catalog and shows what this app does NOT wire up yet, so
// a new model gets noticed here rather than on a competitor's site. Rows the
// owner has deliberately passed on can be dismissed; dismissals live in
// localStorage so they never come back as "new".

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  ArrowLeft, EyeOff, ExternalLink, Loader2, Lock, Radar, RefreshCw, RotateCcw, Search, X,
} from "lucide-react"
import { SiteLogoBox } from "@/components/SitePageHeader"

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

const DISMISS_KEY = "model-watch-dismissed"

interface WatchItem {
  id: string
  title: string
  category: string
  owner: string
  have: boolean
  date: string | null
  description: string
  thumbnailUrl: string | null
}

type CatFilter = "all" | "video" | "image" | "upscale" | "other"
const CATS: CatFilter[] = ["all", "video", "image", "upscale", "other"]

const CAT_STYLE: Record<string, string> = {
  video: "bg-violet-500/15 text-violet-300 border-violet-400/25",
  image: "bg-sky-500/15 text-sky-300 border-sky-400/25",
  upscale: "bg-amber-500/15 text-amber-300 border-amber-400/25",
  other: "bg-slate-500/15 text-slate-400 border-white/15",
}

const fmtDate = (iso: string | null) => {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })
}

export default function ModelWatchPage() {
  // ── Auth gate (same pattern as /admin/slicing-studio) ──
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

  // ── Catalog ──
  const [items, setItems] = useState<WatchItem[]>([])
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── View state ──
  const [cat, setCat] = useState<CatFilter>("all")
  const [query, setQuery] = useState("")
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [showDismissed, setShowDismissed] = useState(false)
  const [dismissed, setDismissed] = useState<string[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      const list = raw ? JSON.parse(raw) : []
      if (Array.isArray(list)) setDismissed(list.filter((x): x is string => typeof x === "string"))
    } catch { /* a corrupt list just means nothing is dismissed */ }
  }, [])

  const writeDismissed = (next: string[]) => {
    setDismissed(next)
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)) } catch {}
  }
  const dismiss = (id: string) => { if (!dismissed.includes(id)) writeDismissed([...dismissed, id]) }
  const restore = (id: string) => writeDismissed(dismissed.filter(x => x !== id))

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/admin/model-watch${refresh ? "?refresh=1" : ""}`, { headers: ah() })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || `Catalog failed (${res.status})`)
      setItems(Array.isArray(data.items) ? data.items : [])
      setScannedAt(typeof data.scannedAt === "string" ? data.scannedAt : null)
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setError(`Some keywords failed: ${data.errors.join(" · ")}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catalog failed")
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (authed) void load() }, [authed, load])

  const dismissedSet = useMemo(() => new Set(dismissed), [dismissed])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(m => {
      const isDismissed = dismissedSet.has(m.id)
      if (isDismissed !== showDismissed) return false
      if (cat !== "all" && m.category !== cat) return false
      if (onlyMissing && m.have) return false
      if (q && !`${m.id} ${m.title} ${m.owner}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, dismissedSet, showDismissed, cat, onlyMissing, query])

  // Headline counts ignore the filters but respect dismissals — "still to look
  // at" is the number that matters, not "everything fal has ever shipped".
  const live = useMemo(() => items.filter(m => !dismissedSet.has(m.id)), [items, dismissedSet])
  const missingCount = live.filter(m => !m.have).length

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6 overflow-x-hidden">
        <div className="relative isolate w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a101d] p-6 space-y-4">
          <SilverRim />
          <div className="flex items-center gap-3">
            <SiteLogoBox size={34} rounded={11} />
            <div>
              <p className="text-sm font-bold text-white">Model Watch</p>
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

  return (
    <div className="min-h-screen bg-[#05080f] text-white overflow-x-hidden overscroll-x-none">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#05080f]/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/admin" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-xs text-slate-400 hover:text-white transition-all shrink-0">
            <ArrowLeft size={12} /> Admin
          </Link>
          <SiteLogoBox size={26} rounded={9} />
          <div className="min-w-0">
            <p className="text-sm font-bold leading-none truncate">Model Watch</p>
            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mt-1 truncate">fal.ai catalog · what we don&apos;t have</p>
          </div>
          <div className="flex-1" />
          <button onClick={() => void load(true)} disabled={loading} title="Re-sweep the catalog"
            className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40 shrink-0">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {/* ── Summary ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4">
          <SilverRim />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Radar size={18} className="text-emerald-300 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight">
                <span className="text-emerald-300">{missingCount}</span>
                <span className="text-slate-400 font-normal"> missing of </span>
                <span>{live.length}</span>
                <span className="text-slate-400 font-normal"> in the catalog</span>
              </p>
              <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-slate-500 mt-1">
                {scannedAt ? `swept ${new Date(scannedAt).toLocaleString()}` : loading ? "sweeping…" : "not scanned"}
                {dismissed.length > 0 ? ` · ${dismissed.length} dismissed` : ""}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 break-words">{error}</p>
        )}

        {/* ── Controls ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-3 space-y-3">
          <SilverRim />
          <div className="flex items-center gap-2">
            <Search size={13} className="text-slate-500 shrink-0" />
            <input value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search id, title or owner…"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30" />
            {query && (
              <button onClick={() => setQuery("")} className="p-2 rounded-lg text-slate-500 hover:text-white shrink-0">
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {CATS.map(c => (
              <button key={c} onClick={() => setCat(c)}
                className={`px-2.5 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors ${
                  cat === c ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                {c}
              </button>
            ))}
            <span className="w-px self-stretch bg-white/10 mx-1" />
            <button onClick={() => setOnlyMissing(v => !v)}
              className={`px-2.5 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors ${
                onlyMissing ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-200" : "border-white/10 text-slate-500 hover:text-white"}`}>
              missing only
            </button>
            <button onClick={() => setShowDismissed(v => !v)}
              className={`px-2.5 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors ${
                showDismissed ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
              show dismissed{dismissed.length > 0 ? ` (${dismissed.length})` : ""}
            </button>
          </div>
        </div>

        {/* ── List ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-2">
          <SilverRim />
          <div className="max-h-[calc(100vh-330px)] min-h-[240px] overflow-y-auto overflow-x-hidden overscroll-contain divide-y divide-white/[0.05]">
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-16 text-slate-500 text-xs">
                <Loader2 size={14} className="animate-spin" /> Sweeping fal.ai…
              </div>
            )}
            {!loading && visible.length === 0 && (
              <div className="py-16 text-center text-xs text-slate-500">
                {showDismissed ? "Nothing dismissed yet." : "Nothing matches — try clearing the filters."}
              </div>
            )}
            {visible.map(m => {
              const isDismissed = dismissedSet.has(m.id)
              return (
                <div key={m.id} className="flex items-start gap-2 px-2 py-2.5 hover:bg-white/[0.03] transition-colors">
                  <a href={`https://fal.ai/models/${m.id}`} target="_blank" rel="noopener noreferrer"
                    className="flex-1 min-w-0 group">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-[13px] font-bold text-white truncate group-hover:text-emerald-200 transition-colors">{m.title}</p>
                      <ExternalLink size={10} className="text-slate-600 group-hover:text-emerald-300 shrink-0" />
                    </div>
                    <p className="text-[10px] font-mono text-slate-500 break-all mt-0.5">{m.id}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wide ${CAT_STYLE[m.category] || CAT_STYLE.other}`}>
                        {m.category}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wide ${
                        m.have
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/25"
                          : "bg-rose-500/15 text-rose-300 border-rose-400/25"}`}>
                        {m.have ? "have it" : "missing"}
                      </span>
                      <span className="text-[9px] font-mono text-slate-600 truncate">{m.owner}</span>
                      <span className="text-[9px] font-mono text-slate-700">{fmtDate(m.date)}</span>
                    </div>
                  </a>
                  <button
                    onClick={() => (isDismissed ? restore(m.id) : dismiss(m.id))}
                    title={isDismissed ? "Bring this back into the watch list" : "Dismiss — stop showing this as new"}
                    className="p-2 rounded-lg text-slate-600 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0">
                    {isDismissed ? <RotateCcw size={13} /> : <EyeOff size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <p className="text-[10px] font-mono text-slate-600 text-center pb-4">
          showing {visible.length} · catalog cached ~10 min · refresh re-sweeps fal
        </p>
      </div>
    </div>
  )
}
