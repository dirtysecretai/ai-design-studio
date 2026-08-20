"use client"

import { useState } from "react"
import { HardDrive, UploadCloud } from "lucide-react"
import CleanupTools from "./CleanupTools"
import R2StoragePage from "../r2-storage/page"

// Unified Storage hub: both storage tools on one page.
//  • R2 Uploads — checkpoints, models & dataset uploads (was /admin/r2-storage)
//  • Migration & Cleanup — R2 migration + Vercel Blob cleanup (was the old
//    /admin/storage, now ./CleanupTools)
// The /admin/r2-storage route still works; this hub is the panel entry.

export default function StorageHubPage() {
  const [tab, setTab] = useState<"uploads" | "cleanup">("uploads")
  return (
    <div className="min-h-screen bg-[#050810]">
      <div className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#050810]/95 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-12 flex items-center gap-2">
          <HardDrive size={15} className="text-slate-400" />
          <span className="text-sm font-semibold text-white mr-3">Storage</span>
          <button
            onClick={() => setTab("uploads")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${tab === "uploads" ? "bg-white/[0.1] text-white border border-white/20" : "text-slate-500 hover:text-white border border-transparent"}`}
          >
            <UploadCloud size={12} /> R2 Uploads
          </button>
          <button
            onClick={() => setTab("cleanup")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${tab === "cleanup" ? "bg-white/[0.1] text-white border border-white/20" : "text-slate-500 hover:text-white border border-transparent"}`}
          >
            <HardDrive size={12} /> Migration &amp; Cleanup
          </button>
        </div>
      </div>
      {tab === "uploads" ? <R2StoragePage /> : <CleanupTools />}
    </div>
  )
}
