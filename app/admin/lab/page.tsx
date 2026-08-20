"use client"

import { useState } from "react"
import Link from "next/link"
import { FlaskConical, Sparkles, ExternalLink } from "lucide-react"
import AdminScannerPage from "../scanner/page"
import AdminPrototypePage from "../prototype/page"

// Lab — the merged testing ground: the admin Scanner and the Prototype
// experiments as tabs, plus quick links to the standalone one-off model test
// pages that previously had no navigation entry at all.

const TEST_PAGES = [
  { name: "NanoBanana 2", href: "/admin/nano-banana-2" },
  { name: "NanoBanana 2 Live", href: "/admin/nano-banana-2-live" },
  { name: "SeeDream 5 Lite Edit", href: "/admin/seedream-5-lite-edit" },
  { name: "Kling O3 Video", href: "/admin/video-scanner-kling-o3" },
  { name: "Portal (original)", href: "/admin/portal-original" },
]

export default function AdminLabPage() {
  const [tab, setTab] = useState<"scanner" | "prototype">("scanner")
  return (
    <div className="min-h-screen bg-[#050810]">
      <div className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#050810]/95 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-12 flex items-center gap-2 overflow-x-auto">
          <FlaskConical size={15} className="text-slate-400 shrink-0" />
          <span className="text-sm font-semibold text-white mr-3 shrink-0">Lab</span>
          <button
            onClick={() => setTab("scanner")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all shrink-0 ${tab === "scanner" ? "bg-white/[0.1] text-white border border-white/20" : "text-slate-500 hover:text-white border border-transparent"}`}
          >
            <Sparkles size={12} /> Scanner
          </button>
          <button
            onClick={() => setTab("prototype")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all shrink-0 ${tab === "prototype" ? "bg-white/[0.1] text-white border border-white/20" : "text-slate-500 hover:text-white border border-transparent"}`}
          >
            <FlaskConical size={12} /> Prototype
          </button>
          <span className="mx-1 h-4 w-px bg-white/10 shrink-0" />
          {TEST_PAGES.map(p => (
            <Link key={p.href} href={p.href}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-slate-600 hover:text-slate-300 transition-colors shrink-0">
              {p.name} <ExternalLink size={9} />
            </Link>
          ))}
        </div>
      </div>
      {tab === "scanner" ? <AdminScannerPage /> : <AdminPrototypePage />}
    </div>
  )
}
