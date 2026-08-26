"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import {
  MessageSquare, Wrench, Image as ImageIcon, Sparkles, Tag,
  Users, CreditCard, ListOrdered, FlaskConical, Home, LayoutDashboard,
  LogOut, ChevronRight, ShieldOff, Loader2, Shield, FileText, HardDrive, Database, Brain, ClipboardCheck, PackageOpen, Telescope, ShieldAlert, ShieldCheck, Film } from "lucide-react"
import { SiteBrandHero, SiteLogoBox } from "@/components/SitePageHeader"

const TOOL_PAGES = [
  {
    group: "Compliance",
    items: [
      { name: "Content Reports",    description: "CCBill complaints & monthly export",    href: "/admin/content-reports", icon: ShieldAlert, badge: "reports" },
      { name: "Content Filter",     description: "CCBill prompt filter & engine mode",    href: "/admin/content-filter", icon: ShieldCheck },
      { name: "Audit Accounts",     description: "Merchant auditor bypass accounts",      href: "/admin/audit-accounts", icon: ClipboardCheck },
    ]
  },
  {
    group: "People",
    items: [
      { name: "Users",              description: "Accounts, subs & transactions",         href: "/admin/users",          icon: Users },
      { name: "Dev Tier",           description: "Dev subscriptions & analytics",         href: "/admin/dev-tier",       icon: CreditCard },
      { name: "Promotions",         description: "Discount codes & free tickets",         href: "/admin/promotions",     icon: Tag },
    ]
  },
  {
    group: "Training",
    items: [
      { name: "Dataset",            description: "Browse & curate training data",         href: "/admin/dataset",        icon: Database },
      { name: "Dataset Prep",       description: "Build export templates & datasets",     href: "/admin/dataset-prep",   icon: PackageOpen },
      { name: "OneTrainer",         description: "Fine-tune models with OneTrainer",      href: "/admin/onetrainer",     icon: Brain },
      { name: "LoRA Training",      description: "FAL trainers - Flux, Wan 2.2, LTX-2",   href: "/admin/lora-training",  icon: Sparkles, badge: "training" },
      { name: "Upscaler Training",  description: "Train ESRGAN / DRCT upscalers",         href: "/admin/upscaler",       icon: Telescope },
      { name: "Slicing Studio",     description: "Cut stored videos into frames & clips", href: "/admin/slicing-studio", icon: Film },
    ]
  },
  {
    group: "Content",
    items: [
      { name: "News & Notifications", description: "Articles, notifications & pages",     href: "/admin/news",           icon: FileText },
      { name: "Images",             description: "Generated images & carousel",           href: "/admin/images",         icon: ImageIcon },
    ]
  },
  {
    group: "System",
    items: [
      { name: "Queue",              description: "Generation queue & concurrency",        href: "/admin/queue",          icon: ListOrdered, badge: "queue" },
      { name: "Maintenance",        description: "Feature & model toggles",               href: "/admin/maintenance",    icon: Wrench },
      { name: "Admins",             description: "Admin accounts & permissions",          href: "/admin/accounts",       icon: Shield },
      { name: "Storage",            description: "R2 uploads / migration / cleanup",      href: "/admin/storage",        icon: HardDrive },
      { name: "Lab",                description: "Scanner, prototype & model test pages", href: "/admin/lab",            icon: FlaskConical },
    ]
  },
]

const NAV_LINKS = [
  { name: "Portal V2", href: "/admin/portal-v2", icon: Home },
  { name: "Dashboard",  href: "/dashboard",       icon: LayoutDashboard },
]

// Silver ambience shared by every state of this page
function AdminBackdrop() {
  return (
    <div aria-hidden className="fixed inset-0 pointer-events-none overflow-hidden">
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 50% -10%, rgba(148,163,184,0.10), transparent 60%)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 15% 110%, rgba(226,232,240,0.05), transparent 45%)" }} />
      {/* one slow band of silver light drifting across the page */}
      <div
        className="absolute inset-y-0 left-0 w-1/2"
        style={{
          background: "linear-gradient(100deg, transparent, rgba(226,232,240,0.03), rgba(248,250,252,0.06), rgba(226,232,240,0.03), transparent)",
          animation: "sheen-sweep 11s ease-in-out infinite",
        }}
      />
    </div>
  )
}

type PanelStats = {
  reports: { open: number; overdue: number; nearestDeadline: number | null }
  queue: { queued: number; processing: number }
  training: { active: number; failed24h: number }
  ccbillExport: { month: string; ready: boolean }
}

function fmtCountdown(ms: number): string {
  const abs = Math.abs(ms)
  const d = Math.floor(abs / 86_400_000)
  const h = Math.floor((abs % 86_400_000) / 3_600_000)
  if (d > 0) return `${d}d ${h}h`
  const m = Math.floor((abs % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [stats, setStats] = useState<PanelStats | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [isAdminAccount, setIsAdminAccount] = useState<boolean | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    let alive = true
    const load = () => fetch('/api/admin/panel-stats')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d && !d.error) setStats(d) })
      .catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [isAuthenticated])

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/admin/verify')
        if (res.ok) {
          const data = await res.json()
          setSessionEmail(data.email)
          setIsAdminAccount(data.isAdmin)

          // Only restore auth if they're an admin account
          if (data.isAdmin) {
            const authStatus = localStorage.getItem("multiverse-admin-auth")
            const savedPassword = sessionStorage.getItem("admin-password")
            if (authStatus === "true" && savedPassword) {
              setIsAuthenticated(true)
            } else {
              localStorage.removeItem("multiverse-admin-auth")
            }
          } else {
            localStorage.removeItem("multiverse-admin-auth")
            sessionStorage.removeItem("admin-password")
          }
        }
      } catch {
        // ignore
      } finally {
        setSessionChecked(true)
      }
    }
    check()
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const data = await res.json()
      if (res.ok) {
        sessionStorage.setItem("admin-password", password)
        localStorage.setItem("multiverse-admin-auth", "true")
        if (data.email) setSessionEmail(data.email)
        setIsAuthenticated(true)
      } else {
        setError(data.error || "Authentication failed")
      }
    } catch {
      setError("Authentication failed")
    }
  }

  const handleLogout = () => {
    localStorage.removeItem("multiverse-admin-auth")
    sessionStorage.removeItem("admin-password")
    setIsAuthenticated(false)
  }

  // Loading
  if (!sessionChecked) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center">
        <AdminBackdrop />
        <Loader2 size={20} className="text-slate-600 animate-spin" />
      </div>
    )
  }

  // Signed in but not an admin account
  if (sessionChecked && isAdminAccount === false && sessionEmail) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6">
        <AdminBackdrop />
        <div className="relative w-full max-w-sm text-center">
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
            <ShieldOff size={22} className="text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Access Denied</h1>
          <p className="text-sm text-slate-500 mt-2">
            <span className="text-slate-300">{sessionEmail}</span> is not authorized for admin access.
          </p>
          <button
            onClick={() => window.location.href = '/dashboard'}
            className="mt-6 px-5 py-2 rounded-xl bg-white/[0.05] border border-white/10 text-sm text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    )
  }

  // Not signed in at all
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6">
        <AdminBackdrop />
        <div className="relative w-full max-w-sm">
          <div className="mb-8">
            <SiteBrandHero />
            <div className="text-center mt-6">
              <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-slate-400">Admin Console</p>
              {sessionEmail && isAdminAccount && (
                <p className="text-xs text-emerald-400/70 mt-2">Signed in as {sessionEmail}</p>
              )}
              {!sessionEmail && (
                <p className="text-xs text-amber-400/60 mt-2">You must be signed in with an admin account</p>
              )}
            </div>
          </div>
          <form onSubmit={handleLogin} className="space-y-3">
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-white/[0.04] border-white/10 text-white placeholder:text-slate-600 focus:border-white/40 h-11"
              autoFocus
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              className="relative overflow-hidden w-full h-11 rounded-xl bg-white/10 border border-white/25 text-white text-sm font-bold hover:bg-white/15 transition-all"
            >
              <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent pointer-events-none" style={{ animation: 'sheen-sweep 2.6s infinite' }} />
              Authenticate
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#05080f] relative">
      <AdminBackdrop />

      <div className="relative z-10 max-w-3xl mx-auto px-5 py-8">

        {/* Header — synced logo inside the animated silver rim */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <SiteLogoBox size={38} rounded={12} />
            <div>
              <h1 className="text-lg font-black tracking-tight leading-none text-transparent bg-clip-text bg-gradient-to-r from-white via-white/85 to-white/55">
                Admin Panel
              </h1>
              <p className="text-[9px] font-mono uppercase tracking-[0.25em] text-slate-500 mt-1">
                Control Center{sessionEmail ? <span className="text-emerald-400/60 normal-case tracking-normal font-sans"> · {sessionEmail}</span> : null}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-red-400 transition-colors py-1.5 px-3 rounded-lg hover:bg-red-500/5"
          >
            <LogOut size={12} />
            Sign out
          </button>
        </div>

        {/* Needs attention - live status strip */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-7">
            <button onClick={() => window.location.href = '/admin/content-reports'}
              className={`text-left p-3 rounded-xl border transition-all hover:brightness-125 ${
                stats.reports.overdue > 0 ? 'bg-red-500/10 border-red-500/30'
                : stats.reports.open > 0 ? 'bg-amber-500/[0.07] border-amber-500/25'
                : 'bg-[#0a101d]/80 border-white/[0.08]'}`}>
              <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Complaints</p>
              <p className={`text-lg font-bold leading-tight ${stats.reports.overdue > 0 ? 'text-red-400' : stats.reports.open > 0 ? 'text-amber-300' : 'text-white'}`}>
                {stats.reports.open}<span className="text-[10px] font-normal text-slate-500"> open</span>
              </p>
              <p className="text-[10px] text-slate-500 leading-tight">
                {stats.reports.overdue > 0
                  ? `${stats.reports.overdue} OVERDUE`
                  : stats.reports.nearestDeadline
                    ? `next due in ${fmtCountdown(stats.reports.nearestDeadline - Date.now())}`
                    : 'all clear'}
              </p>
            </button>
            <button onClick={() => window.location.href = '/admin/queue'}
              className="text-left p-3 rounded-xl bg-[#0a101d]/80 border border-white/[0.08] hover:border-white/25 transition-all">
              <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Queue</p>
              <p className="text-lg font-bold text-white leading-tight">
                {stats.queue.processing}<span className="text-[10px] font-normal text-slate-500"> running</span>
              </p>
              <p className="text-[10px] text-slate-500 leading-tight">{stats.queue.queued} waiting</p>
            </button>
            <button onClick={() => window.location.href = '/admin/lora-training'}
              className={`text-left p-3 rounded-xl border transition-all hover:brightness-125 ${
                stats.training.failed24h > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-[#0a101d]/80 border-white/[0.08]'}`}>
              <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Training</p>
              <p className={`text-lg font-bold leading-tight ${stats.training.failed24h > 0 ? 'text-red-400' : 'text-white'}`}>
                {stats.training.active}<span className="text-[10px] font-normal text-slate-500"> active</span>
              </p>
              <p className="text-[10px] text-slate-500 leading-tight">
                {stats.training.failed24h > 0 ? `${stats.training.failed24h} failed (24h)` : 'no recent failures'}
              </p>
            </button>
            <button onClick={() => window.location.href = '/admin/content-reports'}
              className={`text-left p-3 rounded-xl border transition-all hover:brightness-125 ${
                stats.ccbillExport.ready ? 'bg-[#0a101d]/80 border-white/[0.08]' : 'bg-amber-500/[0.07] border-amber-500/25'}`}>
              <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">CCBill Export</p>
              <p className={`text-lg font-bold leading-tight ${stats.ccbillExport.ready ? 'text-emerald-400' : 'text-amber-300'}`}>
                {stats.ccbillExport.ready ? 'Ready' : 'Pending'}
              </p>
              <p className="text-[10px] text-slate-500 leading-tight">{stats.ccbillExport.month} - due 2nd Monday</p>
            </button>
          </div>
        )}

        {/* Tool groups */}
        <div className="space-y-6">
          {TOOL_PAGES.map((group) => (
            <div key={group.group}>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2.5 px-0.5">
                {group.group}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {group.items.map((item) => (
                  <button
                    key={item.name}
                    onClick={() => window.location.href = item.href}
                    className="group relative overflow-hidden flex items-center gap-3 p-3.5 rounded-xl bg-[#0a101d]/80 border border-white/[0.08] hover:border-white/25 hover:bg-white/[0.05] transition-all text-left"
                  >
                    {/* sheen sweep on hover */}
                    <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/[0.09] to-transparent pointer-events-none opacity-0 group-hover:opacity-100" style={{ animation: 'sheen-sweep 2.4s infinite' }} />
                    <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.12] text-slate-200 group-hover:text-white group-hover:border-white/30 flex items-center justify-center shrink-0 transition-colors">
                      <item.icon size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white leading-none">{item.name}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-snug truncate">{item.description}</p>
                    </div>
                    {(() => {
                      if (!stats || !("badge" in item)) return null
                      const badge = (item as { badge?: string }).badge
                      const n = badge === "reports" ? stats.reports.open
                        : badge === "queue" ? stats.queue.queued + stats.queue.processing
                        : badge === "training" ? stats.training.active
                        : 0
                      if (n <= 0) return null
                      const alert = badge === "reports" && stats.reports.overdue > 0
                      return (
                        <span className={`shrink-0 min-w-[20px] text-center px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none ${alert ? "bg-red-500/20 text-red-400" : "bg-white/[0.1] text-slate-300"}`}>
                          {n}
                        </span>
                      )
                    })()}
                    <ChevronRight size={13} className="text-slate-700 group-hover:text-slate-400 shrink-0 transition-colors" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Navigation links */}
        <div className="mt-6 pt-5 border-t border-white/[0.06] flex gap-2">
          {NAV_LINKS.map((link) => (
            <button
              key={link.name}
              onClick={() => window.location.href = link.href}
              className="relative overflow-hidden flex items-center gap-2 py-2 px-4 rounded-lg bg-white/[0.04] border border-white/[0.1] hover:bg-white/[0.08] hover:border-white/25 transition-all text-sm text-slate-400 hover:text-white"
            >
              <link.icon size={13} />
              {link.name}
            </button>
          ))}
        </div>

      </div>
    </div>
  )
}
