"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { ArrowLeft, Shield, Loader2, RefreshCw, FlaskConical, Check, X } from "lucide-react"

// Admin console for the AI Design Studio Content Filter (CCBill compliance).
// Regular users are ALWAYS filtered — these controls only govern the admin
// bypass and which engine runs, plus a live prompt tester.

type FilterState = {
  adminFilterOn: boolean
  mode: "gemini" | "static"
  stats?: { categories: { category: string; terms: number }[]; nameCount: number }
}
type TestResult = {
  keyword: { category: string; term: string } | null
  name: string | null
  llm: "BLOCK" | "ALLOW" | "UNAVAILABLE"
  finalGemini: "BLOCK" | "ALLOW"
  finalStatic: "BLOCK" | "ALLOW"
}

function getAdminPassword(): string {
  try { return sessionStorage.getItem("admin-password") ?? "" } catch { return "" }
}

export default function ContentFilterAdminPage() {
  const [pw, setPw] = useState("")
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [state, setState] = useState<FilterState | null>(null)
  const [saving, setSaving] = useState(false)
  const [testInput, setTestInput] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const headers = useCallback((): Record<string, string> => {
    const p = getAdminPassword()
    return p ? { "x-admin-password": p } : {}
  }, [])

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/content-filter", { headers: headers() })
    if (!res.ok) { setAuthed(false); return }
    setState(await res.json())
    setAuthed(true)
  }, [headers])

  useEffect(() => { load() }, [load])

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    try { sessionStorage.setItem("admin-password", pw) } catch {}
    await load()
  }

  async function update(body: { on?: boolean; mode?: "gemini" | "static" }) {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/content-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const d = await res.json()
        setState(prev => ({ ...(prev ?? { adminFilterOn: false, mode: "gemini" }), ...d }))
      }
    } finally { setSaving(false) }
  }

  async function runTest(e: React.FormEvent) {
    e.preventDefault()
    if (!testInput.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch("/api/admin/content-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ testPrompt: testInput }),
      })
      const d = await res.json().catch(() => null)
      if (res.ok && d?.test) setTestResult(d.test)
    } finally { setTesting(false) }
  }

  if (authed === false) {
    return (
      <div className="min-h-screen bg-[#050810] flex items-center justify-center p-6">
        <form onSubmit={submitPassword} className="w-full max-w-sm space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="flex items-center gap-2 text-white font-semibold"><Shield size={16} className="text-emerald-400" /> Content Filter</div>
          <input
            type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Admin password"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
          />
          <button className="w-full py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-sm hover:bg-emerald-500/30 transition-all">Unlock</button>
        </form>
      </div>
    )
  }

  const Verdict = ({ v }: { v: "BLOCK" | "ALLOW" | "UNAVAILABLE" }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${
      v === "BLOCK" ? "bg-red-500/15 text-red-400" : v === "ALLOW" ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.06] text-slate-500"
    }`}>
      {v === "BLOCK" ? <X size={10} /> : v === "ALLOW" ? <Check size={10} /> : null}{v}
    </span>
  )

  return (
    <div className="min-h-screen bg-[#050810] text-white">
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#050810]/90 backdrop-blur-xl">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/admin" className="flex items-center gap-1.5 text-slate-500 hover:text-slate-300 transition-colors text-sm">
            <ArrowLeft size={15} /> Admin
          </Link>
          <span className="text-white/10">|</span>
          <Shield size={16} className="text-emerald-400" />
          <h1 className="text-base font-semibold">Content Filter</h1>
          <button onClick={load} className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-all"><RefreshCw size={14} /></button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-[13px] text-slate-400 leading-relaxed">
          Every generation prompt is screened <span className="text-slate-200">server-side</span> before charging or
          submission: CCBill keyword list → static real-person name list → (AI mode) Gemini policy check.{" "}
          <span className="text-emerald-300">Regular users are always filtered</span> — the controls below only affect
          admin accounts and which engine runs.
        </div>

        {state && (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              {/* Admin toggle */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
                <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Apply to admin accounts</p>
                <button
                  onClick={() => update({ on: !state.adminFilterOn })}
                  disabled={saving}
                  className={`w-full py-2.5 rounded-lg border text-sm font-medium transition-all ${
                    state.adminFilterOn
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-400"
                  }`}
                >
                  {saving ? <Loader2 size={14} className="animate-spin inline" /> : state.adminFilterOn ? "ON — admins are filtered too" : "OFF — admins are exempt"}
                </button>
                <p className="text-[11px] text-slate-600">Users are filtered regardless of this switch.</p>
              </div>

              {/* Engine mode */}
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
                <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Engine</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => update({ mode: "gemini" })}
                    disabled={saving}
                    className={`flex-1 py-2.5 rounded-lg border text-sm transition-all ${state.mode === "gemini" ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-white/[0.03] border-white/[0.08] text-slate-500 hover:bg-white/[0.06]"}`}
                  >AI (Gemini)</button>
                  <button
                    onClick={() => update({ mode: "static" })}
                    disabled={saving}
                    className={`flex-1 py-2.5 rounded-lg border text-sm transition-all ${state.mode === "static" ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300" : "bg-white/[0.03] border-white/[0.08] text-slate-500 hover:bg-white/[0.06]"}`}
                  >Static (free)</button>
                </div>
                <p className="text-[11px] text-slate-600">
                  AI: lists + Gemini judgment (~$0.00007/prompt, catches unlisted names &amp; "similar terms"). Static: lists only, no API calls.
                </p>
              </div>
            </div>

            {/* Stats */}
            {state.stats && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">Coverage</p>
                <div className="flex flex-wrap gap-1.5">
                  {state.stats.categories.map(c => (
                    <span key={c.category} className="px-2 py-1 rounded-md bg-white/[0.05] border border-white/[0.08] text-[11px] text-slate-400">
                      {c.category} <span className="text-slate-600">· {c.terms}</span>
                    </span>
                  ))}
                  <span className="px-2 py-1 rounded-md bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-300">
                    real-person names · {state.stats.nameCount}
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Prompt tester */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
            <FlaskConical size={12} /> Test a prompt
          </p>
          <form onSubmit={runTest} className="flex gap-2">
            <input
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              placeholder='e.g. "kim kardashian covered in blood" or "Tony Stark flying"'
              className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
            />
            <button disabled={testing || !testInput.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-sm hover:bg-emerald-500/30 transition-all disabled:opacity-50">
              {testing ? <Loader2 size={14} className="animate-spin" /> : "Test"}
            </button>
          </form>
          {testResult && (
            <div className="space-y-1.5 text-[13px]">
              <div className="flex items-center justify-between py-1 border-b border-white/[0.05]">
                <span className="text-slate-500">Keyword list</span>
                {testResult.keyword
                  ? <span className="text-red-400 text-[12px]">hit: {testResult.keyword.term} <span className="text-slate-600">({testResult.keyword.category})</span></span>
                  : <span className="text-slate-600 text-[12px]">no match</span>}
              </div>
              <div className="flex items-center justify-between py-1 border-b border-white/[0.05]">
                <span className="text-slate-500">Name list</span>
                {testResult.name
                  ? <span className="text-red-400 text-[12px]">hit: {testResult.name}</span>
                  : <span className="text-slate-600 text-[12px]">no match</span>}
              </div>
              <div className="flex items-center justify-between py-1 border-b border-white/[0.05]">
                <span className="text-slate-500">AI policy check</span><Verdict v={testResult.llm} />
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-400 font-medium">Final — AI mode</span><Verdict v={testResult.finalGemini} />
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-400 font-medium">Final — Static mode</span><Verdict v={testResult.finalStatic} />
              </div>
            </div>
          )}
        </div>

        <p className="text-[11px] text-slate-600">
          Complaints console: <Link href="/admin/content-reports" className="text-slate-400 hover:text-white underline underline-offset-2">/admin/content-reports</Link> — monthly CCBill export auto-generates on the 1st.
        </p>
      </main>
    </div>
  )
}
