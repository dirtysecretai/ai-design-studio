"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  HardDrive, Cloud, AlertCircle, RotateCcw, Loader2,
  ChevronLeft, Trash2, CheckCircle2, CirclePlay, Square
} from "lucide-react"

// ─── Shared primitives ────────────────────────────────────────────────────────

function ProgressBar({ value, total, color = "bg-cyan-500" }: { value: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function StatRow({ label, stats }: { label: string; stats: { r2: number; total: number; blob: number } }) {
  const pct = stats.total > 0 ? ((stats.r2 / stats.total) * 100).toFixed(1) : "0.0"
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-500 tabular-nums">
          {stats.r2.toLocaleString()} / {stats.total.toLocaleString()}{" "}
          <span className="text-slate-600">({pct}%)</span>
        </span>
      </div>
      <ProgressBar value={stats.r2} total={stats.total} />
    </div>
  )
}

// ─── Migration Panel ──────────────────────────────────────────────────────────

interface TableStats { total: number; blob: number; r2: number }
interface MigrationStats {
  generatedImage: TableStats
  trainingData:   TableStats
  carouselImage:  TableStats
  overall:        TableStats
  errorCount:     number
}

function MigrationPanel() {
  const [stats, setStats] = useState<MigrationStats | null>(null)
  const [error, setError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  const fetchStats = async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const res = await fetch(`/api/admin/migration-stats?t=${Date.now()}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setStats(data)
      setLastUpdated(new Date())
      setError(false)
    } catch {
      setError(true)
    } finally {
      if (manual) setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchStats()
    intervalRef.current = setInterval(() => fetchStats(), 8000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const isDone    = stats && stats.overall.blob === 0
  const isRunning = stats && stats.overall.blob > 0

  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center">
            <HardDrive size={13} className="text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white leading-none">R2 Migration</p>
            <p className="text-[10px] text-slate-600 mt-0.5">Vercel Blob → Cloudflare R2</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400/80">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              In progress
            </span>
          )}
          {isDone && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400/80">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Complete
            </span>
          )}
          {lastUpdated && (
            <span className="text-[10px] text-slate-700 tabular-nums">
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => fetchStats(true)}
            disabled={refreshing}
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] rounded-lg px-2 py-1 transition-all disabled:opacity-40"
          >
            <RotateCcw size={10} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-[11px] text-red-400/80">
          <AlertCircle size={12} />
          Could not reach migration-stats API
        </div>
      )}

      {stats && (
        <>
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] p-3 space-y-2">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-widest">Overall</p>
                <p className="text-2xl font-bold text-white tabular-nums leading-none mt-0.5">
                  {stats.overall.r2.toLocaleString()}
                  <span className="text-sm font-normal text-slate-600"> / {stats.overall.total.toLocaleString()}</span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-slate-600 tabular-nums">
                  {stats.overall.total > 0 ? ((stats.overall.r2 / stats.overall.total) * 100).toFixed(2) : "0.00"}%
                </p>
                <p className="text-[10px] text-orange-400/70 tabular-nums mt-0.5">
                  {stats.overall.blob.toLocaleString()} remaining
                </p>
              </div>
            </div>
            <ProgressBar value={stats.overall.r2} total={stats.overall.total} color="bg-gradient-to-r from-cyan-500 to-fuchsia-500" />
          </div>

          <div className="space-y-3">
            <StatRow label="Generated Images" stats={stats.generatedImage} />
            <StatRow label="Training Data"    stats={stats.trainingData} />
            <StatRow label="Carousel Images"  stats={stats.carouselImage} />
          </div>

          <div className="flex gap-2 pt-0.5 flex-wrap">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 bg-white/[0.03] border border-white/[0.06] rounded-lg px-2.5 py-1.5">
              <Cloud size={11} className="text-orange-400" />
              <span className="tabular-nums text-slate-400">{stats.overall.blob.toLocaleString()}</span>
              <span>on Vercel Blob</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 bg-white/[0.03] border border-white/[0.06] rounded-lg px-2.5 py-1.5">
              <HardDrive size={11} className="text-cyan-400" />
              <span className="tabular-nums text-slate-400">{stats.overall.r2.toLocaleString()}</span>
              <span>on R2</span>
            </div>
            {stats.errorCount > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-400/80 bg-red-500/[0.06] border border-red-500/20 rounded-lg px-2.5 py-1.5">
                <AlertCircle size={11} />
                <span className="tabular-nums">{stats.errorCount}</span>
                <span>errors</span>
              </div>
            )}
          </div>
        </>
      )}

      {!stats && !error && (
        <div className="flex items-center gap-2 text-[11px] text-slate-600">
          <Loader2 size={12} className="animate-spin" />
          Loading stats...
        </div>
      )}
    </div>
  )
}

// ─── Blob Cleanup Panel ───────────────────────────────────────────────────────

type CleanupStatus = 'checking' | 'idle' | 'running' | 'paused' | 'done' | 'error'

function BlobCleanupPanel() {
  const [status, setStatus]     = useState<CleanupStatus>('checking')
  const [total, setTotal]       = useState<number | null>(null)   // null = still counting
  const [counting, setCounting] = useState(true)                  // full count in progress
  const [deleted, setDeleted]   = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const runningRef              = useRef(false)

  const adminPassword = typeof window !== 'undefined'
    ? sessionStorage.getItem('admin-password') ?? ''
    : ''
  const authHeaders = { 'x-admin-password': adminPassword }

  useEffect(() => {
    // 1. Quick check first (single page) — shows idle/done almost instantly
    const quickCheck = async () => {
      try {
        const res  = await fetch(`/api/admin/blob-cleanup?quick=1&t=${Date.now()}`, { headers: authHeaders })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        if (data.total === 0 && !data.hasMore) {
          setTotal(0)
          setStatus('done')
          setCounting(false)
          return false // no blobs — skip full count
        }
        setStatus('idle')
        return true
      } catch (err: any) {
        setErrorMsg(err.message)
        setStatus('error')
        setCounting(false)
        return false
      }
    }

    // 2. Full count in background — updates total without blocking the UI
    const fullCount = async () => {
      try {
        const res  = await fetch(`/api/admin/blob-cleanup?t=${Date.now()}`, { headers: authHeaders })
        const data = await res.json()
        if (!data.error) setTotal(data.total ?? 0)
      } catch {
        // non-fatal — UI still works without the total
      } finally {
        setCounting(false)
      }
    }

    quickCheck().then(hasBlobs => { if (hasBlobs) fullCount() })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startDeletion = async () => {
    if (runningRef.current) return
    runningRef.current = true
    setStatus('running')
    setErrorMsg(null)

    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

    try {
      while (runningRef.current) {
        const res = await fetch('/api/admin/blob-cleanup', { method: 'POST', headers: authHeaders })
        if (res.status === 429) { await delay(4000); continue }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? `Server error ${res.status}`)
        }
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        const count = data.deleted ?? 0
        setDeleted(prev => prev + count)
        if (count === 0) { runningRef.current = false; setStatus('done'); break }
        await delay(1000)
      }
    } catch (err: any) {
      runningRef.current = false
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  const pauseDeletion = () => { runningRef.current = false; setStatus('paused') }

  const remaining = total !== null ? Math.max(0, total - deleted) : null
  const pct       = total && total > 0 ? Math.min(100, (deleted / total) * 100) : 0

  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-red-500/15 flex items-center justify-center">
            <Trash2 size={13} className="text-red-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white leading-none">Blob Cleanup</p>
            <p className="text-[10px] text-slate-600 mt-0.5">Delete files from Vercel Blob</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {counting && <Loader2 size={11} className="animate-spin text-slate-600" />}
          {status === 'running' && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400/80">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Deleting
            </span>
          )}
          {status === 'done' && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400/80">
              <CheckCircle2 size={11} className="text-emerald-400" />
              Empty
            </span>
          )}
          {status === 'paused' && (
            <span className="flex items-center gap-1 text-[10px] text-slate-400/80">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
              Paused
            </span>
          )}
        </div>
      </div>

      {/* Checking spinner (before quick check returns) */}
      {status === 'checking' && (
        <div className="flex items-center gap-2 text-[11px] text-slate-600">
          <Loader2 size={12} className="animate-spin" />
          Checking Vercel Blob…
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="flex items-center gap-2 text-[11px] text-red-400/80">
          <AlertCircle size={12} />
          {errorMsg ?? 'Unknown error'}
        </div>
      )}

      {/* Done */}
      {status === 'done' && (
        <div className="rounded-lg bg-emerald-500/[0.06] border border-emerald-500/20 p-3 flex items-center gap-2">
          <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
          <div>
            <p className="text-[12px] font-semibold text-emerald-400">Vercel Blob is empty</p>
            {deleted > 0 && (
              <p className="text-[11px] text-slate-500 mt-0.5">{deleted.toLocaleString()} blobs deleted this session</p>
            )}
          </div>
        </div>
      )}

      {/* Progress counter (idle / running / paused) */}
      {(status === 'idle' || status === 'running' || status === 'paused') && (
        <>
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] p-3 space-y-2">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-widest">Deleted</p>
                <p className="text-2xl font-bold text-white tabular-nums leading-none mt-0.5">
                  {deleted.toLocaleString()}
                  {total !== null && (
                    <span className="text-sm font-normal text-slate-600"> / {total.toLocaleString()}</span>
                  )}
                </p>
              </div>
              <div className="text-right">
                {total !== null ? (
                  <>
                    <p className="text-[10px] text-slate-600 tabular-nums">{pct.toFixed(1)}%</p>
                    {remaining !== null && remaining > 0 && (
                      <p className="text-[10px] text-orange-400/70 tabular-nums mt-0.5">
                        {remaining.toLocaleString()} remaining
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[10px] text-slate-600 tabular-nums">counting…</p>
                )}
              </div>
            </div>

            {/* Progress bar: determinate once total is known, indeterminate while counting */}
            <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
              {total !== null ? (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-red-500 to-orange-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              ) : (
                <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-red-500 to-orange-500 opacity-50 animate-pulse" />
              )}
            </div>

            {status === 'running' && (
              <p className="text-[10px] text-amber-400/70">Deleting in batches of 100…</p>
            )}
          </div>

          {/* Warning — only before starting */}
          {status === 'idle' && (
            <div className="flex items-start gap-2 text-[11px] text-amber-400/70 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg px-3 py-2.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>Permanently deletes all files from Vercel Blob. Only proceed after confirming the R2 migration is 100% complete.</span>
            </div>
          )}
        </>
      )}

      {/* Action buttons */}
      {(status === 'idle' || status === 'paused') && (
        <button
          onClick={startDeletion}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 text-red-400 text-sm font-semibold transition-all"
        >
          <CirclePlay size={14} />
          {status === 'paused' ? 'Resume Deletion' : 'Start Deletion'}
        </button>
      )}

      {status === 'running' && (
        <button
          onClick={pauseDeletion}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08] text-slate-400 text-sm font-semibold transition-all"
        >
          <Square size={13} />
          Pause
        </button>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StoragePage() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const authed   = localStorage.getItem("multiverse-admin-auth") === "true"
    const password = sessionStorage.getItem("admin-password")
    if (!authed || !password) {
      window.location.href = '/admin'
    } else {
      setReady(true)
    }
  }, [])

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#09090f] flex items-center justify-center">
        <Loader2 size={20} className="text-slate-600 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#09090f] relative">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-cyan-500/[0.04] rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 max-w-3xl mx-auto px-5 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => window.location.href = '/admin'}
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors"
          >
            <ChevronLeft size={15} />
            Admin
          </button>
          <span className="text-slate-700">/</span>
          <div>
            <h1 className="text-lg font-bold text-white leading-none">Storage Management</h1>
            <p className="text-[11px] text-slate-600 mt-0.5">R2 migration · Vercel Blob cleanup</p>
          </div>
        </div>

        {/* Panels */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MigrationPanel />
          <BlobCleanupPanel />
        </div>

        {/* CLI tip */}
        <div className="mt-4 rounded-xl bg-white/[0.02] border border-white/[0.05] p-3">
          <p className="text-[10px] text-slate-600 font-semibold uppercase tracking-widest mb-1.5">CLI Alternative</p>
          <code className="text-[11px] text-slate-500 font-mono">npx tsx scripts/delete-vercel-blobs.ts</code>
        </div>
      </div>
    </div>
  )
}
