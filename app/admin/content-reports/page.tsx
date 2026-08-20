"use client"

// CCBill compliance console: review complaints, remove content, and produce the
// monthly violations report (due to the processor by the 2nd Monday each month).

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  RefreshCw, ShieldAlert, ArrowLeft, ChevronDown, ChevronUp, Search,
  Copy, Download, CheckCircle, Scale, EyeOff, Clock3 } from "lucide-react"

interface ContentReport {
  id: number
  createdAt: string
  updatedAt: string
  type: string
  contentUrl: string
  description: string
  reporterEmail: string | null
  reporterName: string | null
  isDepictedPerson: boolean
  status: string
  resolutionNote: string | null
  actionTaken: string | null
  resolvedAt: string | null
  reviewedBy: string | null
  relatedImageId: number | null
  relatedImage?: {
    id: number
    userId: number
    isDeleted: boolean
    imageUrl: string
    thumbnailUrl: string | null
  } | null
}

const TYPE_LABELS: Record<string, string> = {
  'illegal-content': 'Illegal content',
  'non-consensual': 'Non-consensual',
  'underage-concern': 'Underage concern',
  'copyright': 'Copyright',
  'depicted-person-appeal': 'Depicted-person appeal',
  'other': 'Other',
}

const STATUS_LABELS: Record<string, string> = {
  'open': 'Open',
  'under-review': 'Under review',
  'resolved-removed': 'Resolved — removed',
  'resolved-no-violation': 'Resolved — no violation',
  'escalated': 'Escalated (neutral review)',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    'illegal-content': 'bg-red-500/15 text-red-400 border-red-500/30',
    'non-consensual': 'bg-red-500/15 text-red-400 border-red-500/30',
    'underage-concern': 'bg-red-500/15 text-red-400 border-red-500/30',
    'copyright': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    'depicted-person-appeal': 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30',
    'other': 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${styles[type] ?? styles.other}`}>
      {TYPE_LABELS[type] ?? type}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    'open': 'bg-red-500/20 text-red-400',
    'under-review': 'bg-amber-500/20 text-amber-400',
    'resolved-removed': 'bg-green-500/20 text-green-400',
    'resolved-no-violation': 'bg-slate-500/20 text-slate-400',
    'escalated': 'bg-fuchsia-500/20 text-fuchsia-400',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status] ?? styles.open}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

// ── Resolution deadline (CCBill: 5 business days; NCII: 48 clock hours) ─────
// Deadline = createdAt + 5 business days (weekends skipped, end of that day
// UTC). Non-consensual reports use the stricter 48-hour clock instead.
function resolutionDeadline(createdAtIso: string, type: string): Date {
  const created = new Date(createdAtIso)
  if (type === 'non-consensual') return new Date(created.getTime() + 48 * 3600 * 1000)
  const d = new Date(created)
  let added = 0
  while (added < 5) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  d.setUTCHours(23, 59, 59, 999)
  return d
}

function fmtRemain(ms: number): string {
  const abs = Math.abs(ms)
  const dys = Math.floor(abs / 86_400_000)
  const hrs = Math.floor((abs % 86_400_000) / 3_600_000)
  const mins = Math.floor((abs % 3_600_000) / 60_000)
  if (dys > 0) return `${dys}d ${hrs}h`
  if (hrs > 0) return `${hrs}h ${mins}m`
  return `${mins}m`
}

// Live countdown chip: green (>2d) → amber (≤2d) → red (overdue). Resolved
// reports show whether the deadline was met instead of a running clock.
function DeadlineChip({ createdAt, type, status, resolvedAt, now }: {
  createdAt: string; type: string; status: string; resolvedAt: string | null; now: number
}) {
  const deadline = resolutionDeadline(createdAt, type).getTime()
  const open = status === 'open' || status === 'under-review'
  if (!open) {
    if (!resolvedAt) return null
    const onTime = new Date(resolvedAt).getTime() <= deadline
    return (
      <span className={`shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold leading-none ${onTime ? 'bg-emerald-500/10 text-emerald-500/80' : 'bg-red-500/10 text-red-400/80'}`}>
        {onTime ? 'on time' : 'past deadline'}
      </span>
    )
  }
  const remain = deadline - now
  const overdue = remain < 0
  const urgent = !overdue && remain <= 2 * 86_400_000
  return (
    <span
      title={`Resolution deadline: ${new Date(deadline).toLocaleString()} (${type === 'non-consensual' ? 'NCII 48-hour rule' : '5 business days'})`}
      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold leading-none tabular-nums ${
        overdue ? 'bg-red-500/15 text-red-400'
        : urgent ? 'bg-amber-500/15 text-amber-400'
        : 'bg-emerald-500/10 text-emerald-400'
      }`}
    >
      <Clock3 size={9} />
      {overdue ? `OVERDUE ${fmtRemain(remain)}` : `${fmtRemain(remain)} left`}
    </span>
  )
}

export default function AdminContentReportsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [password, setPassword] = useState("")
  const [adminPassword, setAdminPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const [reports, setReports] = useState<ContentReport[]>([])
  // Per-minute tick so every deadline countdown stays live
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [activeTab, setActiveTab] = useState<'reports' | 'monthly'>('reports')

  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  // Per-report resolution drafts (note / action / reviewer)
  const [drafts, setDrafts] = useState<Record<number, { note: string; action: string; reviewer: string }>>({})

  // Auto-generated monthly exports (ComplianceExport, written by the
  // /api/cron/ccbill-export cron on the 1st of each month)
  const [savedExports, setSavedExports] = useState<{ month: string; createdAt: string }[]>([])
  const loadSavedExports = async (pwd: string) => {
    try {
      const res = await fetch('/api/admin/compliance-exports', { headers: { 'x-admin-password': pwd } })
      if (res.ok) setSavedExports((await res.json()).exports ?? [])
    } catch {}
  }
  const openSavedExport = async (m: string, kind: 'summary' | 'csv') => {
    try {
      const res = await fetch(`/api/admin/compliance-exports?month=${m}`, { headers: { 'x-admin-password': adminPassword } })
      if (!res.ok) return
      const d = await res.json()
      const content = kind === 'summary' ? d.export.summary : d.export.csv
      const blob = new Blob([content], { type: kind === 'csv' ? 'text/csv' : 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = kind === 'csv' ? `content-violations-${m}.csv` : `ccbill-report-${m}.txt`
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }
  const generateExportNow = async () => {
    try {
      await fetch(`/api/cron/ccbill-export?month=${month}&force=1`, { headers: { 'x-admin-password': adminPassword } })
      loadSavedExports(adminPassword)
    } catch {}
  }

  // Monthly report tab
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [copied, setCopied] = useState(false)

  const fetchData = useCallback(async (pwd: string) => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/content-report', { headers: { 'x-admin-password': pwd } })
      loadSavedExports(pwd)
      if (res.ok) {
        const data = await res.json()
        setReports(Array.isArray(data) ? data : [])
      }
    } catch (error) {
      console.error('Failed to fetch reports:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const authStatus = localStorage.getItem("multiverse-admin-auth")
    const savedPassword = sessionStorage.getItem("admin-password")
    if (authStatus === "true" && savedPassword) {
      setAdminPassword(savedPassword)
      setIsAuthenticated(true)
      fetchData(savedPassword)
      const interval = setInterval(() => fetchData(savedPassword), 30000)
      return () => clearInterval(interval)
    } else {
      localStorage.removeItem("multiverse-admin-auth")
    }
  }, [fetchData])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const response = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (response.ok) {
        setAdminPassword(password)
        sessionStorage.setItem("admin-password", password)
        setIsAuthenticated(true)
        localStorage.setItem("multiverse-admin-auth", "true")
        fetchData(password)
      } else {
        alert("Invalid password")
      }
    } catch {
      alert("Authentication failed")
    }
  }

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase()
    return reports.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (typeFilter !== 'all' && r.type !== typeFilter) return false
      if (q && !(
        r.contentUrl.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        (r.reporterEmail || '').toLowerCase().includes(q) ||
        (r.reporterName || '').toLowerCase().includes(q)
      )) return false
      return true
    })
  }, [reports, searchQuery, statusFilter, typeFilter])

  const stats = useMemo(() => ({
    total: reports.length,
    open: reports.filter(r => r.status === 'open').length,
    underReview: reports.filter(r => r.status === 'under-review').length,
    resolved: reports.filter(r => r.status.startsWith('resolved-')).length,
    escalated: reports.filter(r => r.status === 'escalated').length,
  }), [reports])

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const getDraft = (r: ContentReport) =>
    drafts[r.id] ?? { note: r.resolutionNote || '', action: r.actionTaken || '', reviewer: r.reviewedBy || '' }

  const setDraft = (id: number, patch: Partial<{ note: string; action: string; reviewer: string }>) => {
    setDrafts(prev => ({ ...prev, [id]: { ...(prev[id] ?? { note: '', action: '', reviewer: '' }), ...patch } }))
  }

  const updateReport = async (r: ContentReport, status: string, removeImage = false) => {
    const draft = getDraft(r)
    try {
      await fetch('/api/content-report', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({
          id: r.id,
          status,
          resolutionNote: draft.note || null,
          actionTaken: draft.action || (removeImage ? 'content removed' : status === 'resolved-no-violation' ? 'no violation found' : null),
          reviewedBy: draft.reviewer || null,
          removeImage,
        }),
      })
      fetchData(adminPassword)
    } catch (error) {
      console.error('Failed to update report:', error)
    }
  }

  // ---- Monthly aggregation (CCBill's four bullets) ----
  const monthly = useMemo(() => {
    const inMonth = (iso: string | null) => !!iso && iso.slice(0, 7) === month
    const received = reports.filter(r => inMonth(r.createdAt))
    const violations = reports.filter(r => r.status === 'resolved-removed' && inMonth(r.resolvedAt))
    const resolvedInMonth = reports.filter(r => (r.status.startsWith('resolved-') || r.status === 'escalated') && inMonth(r.resolvedAt))
    const byType: Record<string, number> = {}
    for (const v of violations) byType[v.type] = (byType[v.type] ?? 0) + 1
    return { received, violations, resolvedInMonth, byType }
  }, [reports, month])

  const monthlyText = useMemo(() => {
    const lines: string[] = []
    lines.push(`Content Violations Report — ${month}`)
    lines.push(`Prompt & Protocol LLC — prompt-protocol.vercel.app`)
    lines.push('')
    lines.push(`Complaints received this month: ${monthly.received.length}`)
    lines.push(`Violations found this month: ${monthly.violations.length}`)
    lines.push('')
    lines.push('Violation types:')
    if (Object.keys(monthly.byType).length === 0) {
      lines.push('  (none)')
    } else {
      for (const [t, n] of Object.entries(monthly.byType)) {
        lines.push(`  ${TYPE_LABELS[t] ?? t}: ${n}`)
      }
    }
    lines.push('')
    lines.push('URLs with content violations:')
    if (monthly.violations.length === 0) {
      lines.push('  (none)')
    } else {
      for (const v of monthly.violations) {
        lines.push(`  ${v.contentUrl}`)
        lines.push(`    type: ${TYPE_LABELS[v.type] ?? v.type} · action: ${v.actionTaken || 'content removed'} · resolved: ${v.resolvedAt ? formatDate(v.resolvedAt) : '-'}`)
      }
    }
    lines.push('')
    lines.push('Actions taken on complaints resolved this month:')
    if (monthly.resolvedInMonth.length === 0) {
      lines.push('  (none)')
    } else {
      for (const r of monthly.resolvedInMonth) {
        lines.push(`  #${r.id} [${TYPE_LABELS[r.type] ?? r.type}] ${STATUS_LABELS[r.status] ?? r.status} — ${r.actionTaken || '-'}`)
      }
    }
    return lines.join('\n')
  }, [monthly, month])

  const copyMonthly = async () => {
    try {
      await navigator.clipboard.writeText(monthlyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const downloadCsv = () => {
    const esc = (s: string | null) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['id', 'createdAt', 'type', 'status', 'contentUrl', 'actionTaken', 'resolvedAt', 'reviewedBy', 'resolutionNote'].join(','),
      ...monthly.received.map(r =>
        [r.id, r.createdAt, r.type, r.status, esc(r.contentUrl), esc(r.actionTaken), r.resolvedAt ?? '', esc(r.reviewedBy), esc(r.resolutionNote)].join(',')
      ),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `content-violations-${month}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#050810] flex items-center justify-center p-6">
        <form onSubmit={handleLogin} className="w-full max-w-sm p-6 rounded-xl border border-slate-800 bg-slate-900/60 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="text-cyan-400" size={20} />
            <h1 className="text-lg font-bold text-white">Content Reports</h1>
          </div>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="bg-slate-950 border-slate-700 text-white"
          />
          <Button type="submit" className="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold">
            Login
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#050810] text-white p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <a href="/admin" className="p-2 rounded-lg border border-slate-800 hover:border-slate-600 transition-colors">
              <ArrowLeft size={16} />
            </a>
            <ShieldAlert className="text-cyan-400" size={24} />
            <div>
              <h1 className="text-xl font-bold">Content Reports</h1>
              <p className="text-xs text-slate-500">Complaints, takedowns & depicted-person appeals — resolve within 5 business days (NCII: 48 hours) · <a href="/admin/feedback" className="underline underline-offset-2 hover:text-slate-400">legacy feedback archive</a></p>
            </div>
          </div>
          <button
            onClick={() => fetchData(adminPassword)}
            className="p-2 rounded-lg border border-slate-800 hover:border-slate-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Total', value: stats.total, color: 'text-white' },
            { label: 'Open', value: stats.open, color: 'text-red-400' },
            { label: 'Under review', value: stats.underReview, color: 'text-amber-400' },
            { label: 'Resolved', value: stats.resolved, color: 'text-green-400' },
            { label: 'Escalated', value: stats.escalated, color: 'text-fuchsia-400' },
          ].map(s => (
            <div key={s.label} className="p-3 rounded-xl border border-slate-800 bg-slate-900/40">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setActiveTab('reports')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'reports' ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300' : 'border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            Reports
          </button>
          <button
            onClick={() => setActiveTab('monthly')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'monthly' ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300' : 'border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            Monthly CCBill Report
          </button>
        </div>

        {activeTab === 'reports' && (
          <>
            {/* Filters */}
            <div className="flex flex-wrap gap-2 mb-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search URL, description, reporter..."
                  className="bg-slate-950 border-slate-700 text-white pl-9"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 text-white text-sm px-3"
              >
                <option value="all">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 text-white text-sm px-3"
              >
                <option value="all">All types</option>
                {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>

            {/* Report list */}
            <div className="space-y-3">
              {filtered.length === 0 && (
                <div className="p-8 rounded-xl border border-slate-800 bg-slate-900/40 text-center text-slate-500 text-sm">
                  No reports match the current filters.
                </div>
              )}
              {filtered.map(r => {
                const expanded = expandedIds.has(r.id)
                const draft = getDraft(r)
                return (
                  <div key={r.id} className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
                    <button
                      onClick={() => toggleExpand(r.id)}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-900/70 transition-colors"
                    >
                      <span className="font-mono text-xs text-slate-500 shrink-0">#{r.id}</span>
                      <TypeBadge type={r.type} />
                      <StatusBadge status={r.status} />
                      <span className="text-xs text-slate-400 truncate flex-1">{r.contentUrl}</span>
                      <DeadlineChip createdAt={r.createdAt} type={r.type} status={r.status} resolvedAt={r.resolvedAt} now={nowTick} />
                      <span className="text-xs text-slate-600 shrink-0 hidden sm:block">{formatDate(r.createdAt)}</span>
                      {expanded ? <ChevronUp size={14} className="shrink-0 text-slate-500" /> : <ChevronDown size={14} className="shrink-0 text-slate-500" />}
                    </button>

                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-slate-800 pt-3">
                        <div className="text-sm text-slate-300 whitespace-pre-wrap">{r.description}</div>

                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
                          <span>Reporter: {r.reporterName || 'Anonymous'}{r.reporterEmail ? ` · ${r.reporterEmail}` : ''}</span>
                          {r.isDepictedPerson && <span className="text-fuchsia-400">Depicted-person appeal</span>}
                          {r.resolvedAt && <span>Resolved: {formatDate(r.resolvedAt)}</span>}
                          {r.reviewedBy && <span>Reviewed by: {r.reviewedBy}</span>}
                        </div>

                        {r.relatedImage ? (
                          <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-800 bg-slate-950/60">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={r.relatedImage.thumbnailUrl || r.relatedImage.imageUrl}
                              alt="Reported content"
                              className="w-16 h-16 object-cover rounded-lg border border-slate-800"
                            />
                            <div className="text-xs text-slate-400">
                              <div>Matched generation #{r.relatedImage.id} · owner user {r.relatedImage.userId}</div>
                              <div className={r.relatedImage.isDeleted ? 'text-green-400' : 'text-amber-400'}>
                                {r.relatedImage.isDeleted ? 'Already removed (soft-deleted)' : 'Still live'}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs text-slate-600">No matching generation found in the database (external or already purged URL).</div>
                        )}

                        {/* Resolution inputs */}
                        <div className="grid sm:grid-cols-3 gap-2">
                          <Input
                            value={draft.reviewer}
                            onChange={(e) => setDraft(r.id, { reviewer: e.target.value })}
                            placeholder="Reviewed by"
                            className="bg-slate-950 border-slate-700 text-white text-sm"
                          />
                          <Input
                            value={draft.action}
                            onChange={(e) => setDraft(r.id, { action: e.target.value })}
                            placeholder="Action taken (e.g. content removed)"
                            className="bg-slate-950 border-slate-700 text-white text-sm"
                          />
                          <Input
                            value={draft.note}
                            onChange={(e) => setDraft(r.id, { note: e.target.value })}
                            placeholder="Resolution note"
                            className="bg-slate-950 border-slate-700 text-white text-sm"
                          />
                        </div>

                        {/* Actions */}
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => updateReport(r, 'under-review')}
                            className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                          >
                            Mark Under Review
                          </button>
                          <button
                            onClick={() => updateReport(r, 'resolved-removed', !!r.relatedImage && !r.relatedImage.isDeleted)}
                            className="px-3 py-1.5 rounded-lg border border-green-500/40 bg-green-500/10 text-green-300 text-xs font-medium hover:bg-green-500/20 transition-colors inline-flex items-center gap-1.5"
                          >
                            <EyeOff size={12} />
                            Resolve — Removed{r.relatedImage && !r.relatedImage.isDeleted ? ' (removes content)' : ''}
                          </button>
                          <button
                            onClick={() => updateReport(r, 'resolved-no-violation')}
                            className="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800/40 text-slate-300 text-xs font-medium hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5"
                          >
                            <CheckCircle size={12} />
                            Resolve — No Violation
                          </button>
                          <button
                            onClick={() => updateReport(r, 'escalated')}
                            className="px-3 py-1.5 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300 text-xs font-medium hover:bg-fuchsia-500/20 transition-colors inline-flex items-center gap-1.5"
                          >
                            <Scale size={12} />
                            Escalate to Neutral Review
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {activeTab === 'monthly' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="h-9 rounded-md border border-slate-700 bg-slate-950 text-white text-sm px-3"
              />
              <button
                onClick={copyMonthly}
                className="px-3 py-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 text-xs font-medium hover:bg-cyan-500/20 transition-colors inline-flex items-center gap-1.5"
              >
                <Copy size={12} />
                {copied ? 'Copied!' : 'Copy as text'}
              </button>
              <button
                onClick={downloadCsv}
                className="px-3 py-2 rounded-lg border border-slate-600 bg-slate-800/40 text-slate-300 text-xs font-medium hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5"
              >
                <Download size={12} />
                Download CSV
              </button>
              <span className="text-xs text-slate-600">Due to CCBill by the 2nd Monday of each month.</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Complaints received', value: monthly.received.length },
                { label: 'Violations found', value: monthly.violations.length },
                { label: 'Resolved this month', value: monthly.resolvedInMonth.length },
                { label: 'Violation types', value: Object.keys(monthly.byType).length },
              ].map(s => (
                <div key={s.label} className="p-3 rounded-xl border border-slate-800 bg-slate-900/40">
                  <div className="text-xl font-bold text-white">{s.value}</div>
                  <div className="text-xs text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            <pre className="p-4 rounded-xl border border-slate-800 bg-slate-950/80 text-xs text-slate-300 whitespace-pre-wrap overflow-x-auto">
              {monthlyText}
            </pre>

            {/* Auto-generated monthly exports — written by the cron on the 1st,
                ready to review & send before the 2nd-Monday deadline */}
            <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/40 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Saved exports (auto-generated monthly)</p>
                <button
                  onClick={generateExportNow}
                  className="px-2.5 py-1 rounded-lg border border-slate-600 bg-slate-800/40 text-slate-300 text-[11px] hover:bg-slate-800 transition-colors"
                >
                  Generate {month} now
                </button>
              </div>
              {savedExports.length === 0 ? (
                <p className="text-xs text-slate-600">
                  None yet — the first export auto-saves on the 1st of next month (or click Generate).
                </p>
              ) : (
                <div className="space-y-1">
                  {savedExports.map(ex => (
                    <div key={ex.month} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-slate-950/60 border border-slate-800">
                      <span className="text-xs text-white font-mono">{ex.month}</span>
                      <span className="text-[10px] text-slate-600">saved {new Date(ex.createdAt).toLocaleDateString()}</span>
                      <div className="flex gap-1.5">
                        <button onClick={() => openSavedExport(ex.month, 'summary')}
                          className="px-2 py-1 rounded-md border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 transition-colors">Report .txt</button>
                        <button onClick={() => openSavedExport(ex.month, 'csv')}
                          className="px-2 py-1 rounded-md border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-800 transition-colors">CSV</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
