"use client"

import { useState, useEffect, useCallback, useRef, useMemo, memo, useDeferredValue } from "react"
import {
  Database, Download, ChevronLeft, ChevronRight, Search,
  Loader2, ImageIcon, Star, BookMarked, CheckSquare, Square, X,
  ArrowLeft, RefreshCw, SlidersHorizontal, Sparkles, Tag, MessageSquare,
  Plus, Hash, ChevronDown, MousePointer2, Copy, ExternalLink,
  User, Calendar, Cpu, Layers, Clock, Fingerprint, Film, Video,
  FolderOpen, FolderPlus, Pencil, Trash2, MoreHorizontal,
  UploadCloud, FileImage, HardDrive, Ruler, Check
} from "lucide-react"
import { AddToBucketModal, type Bucket, type BucketFolder } from "@/components/AddToBucketModal"
import { MultiFilterSelect } from "@/components/MultiFilterSelect"
import { ReferencePanel } from "./ReferencePanel"
import { SiteLogoBox } from "@/components/SitePageHeader"

const UPLOADS_BUCKET_NAME = '__uploads__'

// Portal design system: animated silver rim (masked band) for popup chrome
const SILVER_RIM_CONIC =
  "conic-gradient(from 0deg, rgba(226,232,240,0.1), #f8fafc, #94a3b8, rgba(226,232,240,0.15), #cbd5e1, #64748b, rgba(226,232,240,0.1))"

// ─── Custom dropdowns ─────────────────────────────────────────────────────────

const FilterSelect = memo(function FilterSelect({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)
  const selected        = options.find(o => o.value === value) ?? options[0]

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs text-slate-300 hover:text-white hover:border-white/20 transition-all whitespace-nowrap"
      >
        {selected.label}
        <ChevronDown size={10} className={`text-slate-600 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-full rounded-xl bg-[#131320] border border-white/[0.1] shadow-2xl overflow-hidden py-1">
          {options.map(opt => (
            <button key={opt.value} onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors whitespace-nowrap
                ${opt.value === value ? "text-cyan-300 bg-cyan-500/10" : "text-slate-400 hover:text-white hover:bg-white/[0.06]"}`}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

// Multi-select dropdown moved to components/MultiFilterSelect.tsx (shared with ReferencePanel)

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImageRecord {
  id: number
  prompt: string
  imageUrl: string
  referenceImageUrls: string[]
  model: string
  quality: string | null
  aspectRatio: string | null
  ticketCost: number
  markedForTraining: boolean
  adminTags: string[]
  adminCaption: string | null
  createdAt: string
  expiresAt: string | null
  falRequestId: string | null
  videoMetadata: any | null
  isDeleted: boolean
  user: { id: number; email: string; name: string | null }
  imageRating: {
    score: number
    wasAccurate: boolean | null
    tags: string[]
    feedbackText: string | null
    createdAt: string
  } | null
}

// Bucket / BucketFolder types + AddToBucketModal are shared with portal-v2
// (imported at the top of this file from components/AddToBucketModal)

interface Pagination { page: number; limit: number; total: number; totalPages: number }
interface Facets {
  models:    { value: string; count: number }[]
  aspects:   { value: string; count: number }[]
  qualities: { value: string | null; count: number }[]
  tags:      { value: string; count: number }[]
  users:     { id: number; email: string; name: string | null; count: number }[]
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function getAdminPassword() {
  try { return sessionStorage.getItem("admin-password") || "" } catch { return "" }
}
function authHeaders(): Record<string, string> {
  const p = getAdminPassword()
  return p ? { "x-admin-password": p } : {}
}

// ─── Tag pill input ───────────────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder = "Add tag…", suggestions = [] }: {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  suggestions?: string[]
}) {
  const [input, setInput]     = useState("")
  const [showSug, setShowSug] = useState(false)
  const inputRef              = useRef<HTMLInputElement>(null)

  const addTag = (tag: string) => {
    const clean = tag.trim().toLowerCase().replace(/[,\s]+/g, '-').replace(/[^a-z0-9-_]/g, '')
    if (clean && !tags.includes(clean)) onChange([...tags, clean])
    setInput(""); setShowSug(false)
  }
  const removeTag = (tag: string) => onChange(tags.filter(t => t !== tag))
  const filteredSug = suggestions.filter(s => !tags.includes(s) && s.includes(input.toLowerCase())).slice(0, 6)

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5 min-h-[36px] p-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] cursor-text"
        onClick={() => inputRef.current?.focus()}>
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/15 border border-cyan-500/20 text-cyan-300 text-[11px] leading-none">
            <Hash size={8} />{tag}
            <button onClick={() => removeTag(tag)} className="hover:text-white ml-0.5"><X size={9} /></button>
          </span>
        ))}
        <input ref={inputRef} value={input}
          onChange={e => { setInput(e.target.value); setShowSug(true) }}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); addTag(input) }
            if (e.key === 'Backspace' && !input && tags.length) removeTag(tags[tags.length - 1])
          }}
          onBlur={() => setTimeout(() => setShowSug(false), 150)}
          placeholder={tags.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[80px] bg-transparent text-xs text-white placeholder:text-slate-600 outline-none"
        />
      </div>
      {showSug && filteredSug.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filteredSug.map(s => (
            <button key={s} onClick={() => addTag(s)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.08] text-slate-400 hover:text-white text-[11px] transition-colors">
              <Plus size={8} />{s}
            </button>
          ))}
        </div>
      )}
      <p className="text-[10px] text-slate-700">Enter or comma to add · tags are lowercased</p>
    </div>
  )
}

// ─── Upload modal ─────────────────────────────────────────────────────────────

interface UploadFileMeta {
  description: string
  tags:        string[]
  caption:     string
  marked:      boolean
}

const BATCH_SIZE = 10
const UPLOAD_ACCEPT = 'image/*,video/mp4,video/webm,video/quicktime,video/avi,video/x-matroska'

function fmt2(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function emptyMeta(): UploadFileMeta {
  return { description: '', tags: [], caption: '', marked: false }
}

function UploadModal({ bucketId, suggestions, onClose, onUploaded }: {
  bucketId:   number
  suggestions: string[]
  onClose:    () => void
  onUploaded: () => void
}) {
  const [files,       setFiles]       = useState<File[]>([])
  const [previews,    setPreviews]    = useState<({ url: string; w: number; h: number } | null)[]>([])
  const [metas,       setMetas]       = useState<UploadFileMeta[]>([])
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  // Bulk-apply fields
  const [bulkTags,    setBulkTags]    = useState<string[]>([])
  const [bulkCaption, setBulkCaption] = useState('')
  const [bulkDesc,    setBulkDesc]    = useState('')
  const [bulkMarked,  setBulkMarked]  = useState(false)

  const [uploading,   setUploading]   = useState(false)
  const [progress,    setProgress]    = useState({ done: 0, total: 0, msg: '' })
  const [dragging,    setDragging]    = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function addFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming).filter(f =>
      !f.type || f.type.startsWith('image/') || f.type.startsWith('video/')
    )
    if (!arr.length) return
    setFiles(prev => {
      const offset = prev.length
      arr.forEach((f, i) => {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f)
          const img = new window.Image()
          img.onload = () => {
            setPreviews(p => {
              const copy = [...p]
              copy[offset + i] = { url, w: img.naturalWidth, h: img.naturalHeight }
              return copy
            })
          }
          img.src = url
        }
      })
      return [...prev, ...arr]
    })
    setPreviews(p => [...p, ...arr.map(() => null)])
    setMetas(m => [...m, ...arr.map(emptyMeta)])
  }

  function removeFile(i: number) {
    const url = previews[i]?.url
    if (url) URL.revokeObjectURL(url)
    setFiles(f => f.filter((_, j) => j !== i))
    setPreviews(p => p.filter((_, j) => j !== i))
    setMetas(m => m.filter((_, j) => j !== i))
    if (expandedIdx === i) setExpandedIdx(null)
    else if (expandedIdx !== null && expandedIdx > i) setExpandedIdx(expandedIdx - 1)
  }

  function updateMeta(i: number, patch: Partial<UploadFileMeta>) {
    setMetas(m => m.map((meta, j) => j === i ? { ...meta, ...patch } : meta))
  }

  function applyBulkToAll() {
    setMetas(m => m.map(meta => ({
      description: bulkDesc    || meta.description,
      tags:        bulkTags.length ? [...new Set([...meta.tags, ...bulkTags])] : meta.tags,
      caption:     bulkCaption || meta.caption,
      marked:      bulkMarked  || meta.marked,
    })))
  }

  function applyBulkToUnset() {
    setMetas(m => m.map(meta => ({
      description: meta.description || bulkDesc,
      tags:        meta.tags.length  ? meta.tags : [...bulkTags],
      caption:     meta.caption      || bulkCaption,
      marked:      meta.marked       || bulkMarked,
    })))
  }

  async function handleUpload() {
    if (!files.length || uploading) return
    setUploading(true)
    const total = files.length
    const pw    = sessionStorage.getItem('admin-password') || ''

    try {
      // Step 1: Get presigned R2 PUT URLs for every file in one small JSON request.
      // Files are never sent through Vercel — they go directly to R2, bypassing
      // the 4.5MB serverless body limit that broke batch uploads of 4K images.
      setProgress({ done: 0, total, msg: `Preparing ${total} upload${total !== 1 ? 's' : ''}…` })
      const presignRes = await fetch('/api/admin/dataset/presign', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body:    JSON.stringify({
          files: files.map(f => ({ filename: f.name, mimeType: f.type || 'image/jpeg' })),
        }),
      })
      if (!presignRes.ok) throw new Error(`Could not prepare uploads: ${await presignRes.text()}`)
      const { results } = await presignRes.json() as {
        results: Array<{ uploadUrl: string; publicUrl: string; normalizedMime: string }>
      }

      // Step 2: PUT files directly to R2 — 5 concurrent at a time
      const CONCURRENCY = 5
      let uploadDone = 0
      const uploaded: Array<{ imageUrl: string; mimeType: string; filename: string; width: number; height: number; meta: UploadFileMeta } | null> =
        new Array(files.length).fill(null)

      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const end = Math.min(i + CONCURRENCY, files.length)
        setProgress({ done: uploadDone, total, msg: `Uploading ${i + 1}–${end} of ${total}…` })

        await Promise.all(
          Array.from({ length: end - i }, (_, k) => i + k).map(async idx => {
            const file    = files[idx]
            const presign = results[idx]
            if (!presign) return

            const putRes = await fetch(presign.uploadUrl, {
              method:  'PUT',
              headers: { 'Content-Type': presign.normalizedMime },
              body:    file,
            })
            if (!putRes.ok) throw new Error(`Upload failed for "${file.name}" (${putRes.status})`)

            uploaded[idx] = {
              imageUrl: presign.publicUrl,
              mimeType: presign.normalizedMime,
              filename: file.name,
              width:    previews[idx]?.w ?? 0,
              height:   previews[idx]?.h ?? 0,
              meta:     metas[idx],
            }
          })
        )
        uploadDone += end - i
      }

      const validRecords = uploaded.filter((r): r is NonNullable<typeof r> => r !== null)
      if (validRecords.length === 0) throw new Error('No files could be uploaded')

      // Step 3: Save DB records in batches of 20 (tiny JSON, no size issues)
      setProgress({ done: validRecords.length, total, msg: 'Saving to database…' })
      const RECORD_BATCH = 20
      for (let i = 0; i < validRecords.length; i += RECORD_BATCH) {
        const saveRes = await fetch('/api/admin/dataset/record', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
          body:    JSON.stringify({ bucketId, records: validRecords.slice(i, i + RECORD_BATCH) }),
        })
        if (!saveRes.ok) throw new Error(`Save failed: ${(await saveRes.json()).error}`)
      }

      const n = validRecords.length
      setProgress({ done: n, total, msg: `✓ ${n} file${n !== 1 ? 's' : ''} uploaded` })
      setTimeout(() => { onUploaded(); onClose() }, 1000)
    } catch (err: any) {
      setProgress(p => ({ ...p, msg: `Error: ${err.message}` }))
      setUploading(false)
    }
  }

  const hasBulk = bulkDesc || bulkTags.length > 0 || bulkCaption || bulkMarked
  const metaSetCount = metas.filter(m => m.description || m.tags.length || m.caption || m.marked).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[94vh] rounded-2xl bg-[#0c0c18] border border-white/[0.1] shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <UploadCloud size={14} className="text-violet-400" />
            <span className="text-xs font-semibold text-white">Upload Images &amp; Videos</span>
            {files.length > 0 && <span className="text-[10px] text-slate-500">{files.length} file{files.length !== 1 ? 's' : ''}</span>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-600 hover:text-slate-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 flex flex-col">

          {/* Drop zone */}
          <div className="p-4 shrink-0">
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl py-6 text-center cursor-pointer transition-all
                ${dragging ? 'border-violet-500/60 bg-violet-500/10' : 'border-white/[0.08] hover:border-white/20 hover:bg-white/[0.02]'}`}
            >
              <UploadCloud size={24} className="mx-auto text-slate-600 mb-1.5" />
              <p className="text-xs text-slate-400 font-medium">{files.length > 0 ? 'Drop more files or click to add' : 'Drop files here or click to browse'}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">Images (JPEG, PNG, WebP, AVIF) · Videos (MP4, WebM, MOV)</p>
              <input ref={inputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden"
                onChange={e => e.target.files && addFiles(e.target.files)} />
            </div>
          </div>

          {files.length > 0 && (
            <div className="flex flex-col flex-1 min-h-0">

              {/* ── Bulk apply panel ── */}
              <div className="mx-4 mb-3 rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden shrink-0">
                <div className="px-4 py-2.5 border-b border-white/[0.05] flex items-center justify-between">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Bulk Apply</p>
                  <div className="flex items-center gap-2">
                    <button onClick={applyBulkToUnset} disabled={!hasBulk}
                      className="text-[10px] px-2.5 py-1 rounded-lg bg-white/[0.05] border border-white/[0.08] text-slate-400 hover:text-white disabled:opacity-30 transition-all">
                      Apply to unset
                    </button>
                    <button onClick={applyBulkToAll} disabled={!hasBulk}
                      className="text-[10px] px-2.5 py-1 rounded-lg bg-violet-500/15 border border-violet-500/25 text-violet-400 hover:bg-violet-500/20 disabled:opacity-30 transition-all">
                      Apply to all
                    </button>
                  </div>
                </div>
                <div className="p-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[9px] text-slate-600 mb-1">Description</p>
                    <input value={bulkDesc} onChange={e => setBulkDesc(e.target.value)}
                      placeholder="Applied to all files…"
                      className="w-full rounded-lg bg-white/[0.04] border border-white/[0.07] px-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/30" />
                  </div>
                  <div>
                    <p className="text-[9px] text-slate-600 mb-1">Caption</p>
                    <input value={bulkCaption} onChange={e => setBulkCaption(e.target.value)}
                      placeholder="Training caption…"
                      className="w-full rounded-lg bg-white/[0.04] border border-white/[0.07] px-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/30" />
                  </div>
                  <div className="col-span-2">
                    <p className="text-[9px] text-slate-600 mb-1">Tags</p>
                    <TagInput tags={bulkTags} onChange={setBulkTags} suggestions={suggestions} />
                  </div>
                  <div className="col-span-2">
                    <button onClick={() => setBulkMarked(v => !v)}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-lg border text-[11px] transition-all
                        ${bulkMarked ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-white/[0.03] border-white/[0.06] text-slate-600 hover:text-white'}`}>
                      <BookMarked size={10} /> Mark all for training
                    </button>
                  </div>
                </div>
              </div>

              {/* ── File list ── */}
              <div className="px-4 pb-1 flex items-center justify-between shrink-0">
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold">
                  {files.length} file{files.length !== 1 ? 's' : ''}
                  {metaSetCount > 0 && <span className="ml-2 normal-case font-normal text-violet-500">{metaSetCount} with individual metadata</span>}
                </p>
                <button onClick={() => { setFiles([]); setPreviews([]); setMetas([]); setExpandedIdx(null) }}
                  className="text-[10px] text-slate-700 hover:text-red-400 transition-colors">Remove all</button>
              </div>

              <div className="overflow-y-auto flex-1 px-4 pb-2 space-y-1">
                {files.map((f, i) => {
                  const isVideo   = f.type.startsWith('video/')
                  const preview   = previews[i]
                  const meta      = metas[i]
                  const hasIndiv  = !!(meta.description || meta.tags.length || meta.caption || meta.marked)
                  const isExpanded = expandedIdx === i

                  return (
                    <div key={i} className={`rounded-xl border transition-all ${isExpanded ? 'bg-white/[0.04] border-violet-500/20' : 'bg-white/[0.02] border-white/[0.05] hover:border-white/[0.09]'}`}>
                      {/* Row */}
                      <div className="flex items-center gap-2.5 p-2.5">
                        {/* Thumbnail */}
                        <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-white/[0.05] flex items-center justify-center">
                          {isVideo ? (
                            <Film size={16} className="text-slate-500" />
                          ) : preview ? (
                            <img src={preview.url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <FileImage size={16} className="text-slate-600" />
                          )}
                        </div>
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] text-white truncate font-medium">{f.name}</p>
                          <p className="text-[9px] text-slate-600">
                            {fmt2(f.size)}
                            {preview ? ` · ${preview.w}×${preview.h}` : ''}
                            {isVideo && ' · video'}
                          </p>
                          {hasIndiv && !isExpanded && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {meta.tags.map(t => <span key={t} className="text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-400">{t}</span>)}
                              {meta.caption && <span className="text-[9px] text-slate-600 italic truncate max-w-[140px]">"{meta.caption}"</span>}
                              {meta.marked && <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-500">training</span>}
                            </div>
                          )}
                        </div>
                        {/* Actions */}
                        <button
                          onClick={() => setExpandedIdx(isExpanded ? null : i)}
                          className={`text-[10px] px-2 py-1 rounded-lg border transition-all shrink-0
                            ${hasIndiv ? 'bg-violet-500/10 border-violet-500/20 text-violet-400' : 'bg-white/[0.04] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                          {isExpanded ? 'Done' : 'Edit'}
                        </button>
                        <button onClick={() => removeFile(i)} className="text-slate-700 hover:text-red-400 transition-colors shrink-0 p-1">
                          <X size={12} />
                        </button>
                      </div>

                      {/* Expanded per-file editor */}
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-white/[0.05]">
                          <div className="grid grid-cols-2 gap-2.5">
                            <div>
                              <p className="text-[9px] text-slate-600 mb-1">Description</p>
                              <input value={meta.description} onChange={e => updateMeta(i, { description: e.target.value })}
                                placeholder="Describe this file…"
                                className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/40" />
                            </div>
                            <div>
                              <p className="text-[9px] text-slate-600 mb-1">Caption</p>
                              <input value={meta.caption} onChange={e => updateMeta(i, { caption: e.target.value })}
                                placeholder="Training caption…"
                                className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/40" />
                            </div>
                          </div>
                          <div>
                            <p className="text-[9px] text-slate-600 mb-1">Tags</p>
                            <TagInput tags={meta.tags} onChange={t => updateMeta(i, { tags: t })} suggestions={suggestions} />
                          </div>
                          <button onClick={() => updateMeta(i, { marked: !meta.marked })}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] transition-all
                              ${meta.marked ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-white/[0.03] border-white/[0.06] text-slate-600 hover:text-white'}`}>
                            <BookMarked size={10} /> Mark for training
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.06] flex items-center gap-3 shrink-0">
          {progress.msg ? (
            <div className="flex-1 flex items-center gap-3">
              <p className={`text-xs ${progress.msg.startsWith('Error') ? 'text-red-400' : progress.msg.startsWith('✓') ? 'text-emerald-400' : 'text-slate-400'}`}>
                {progress.msg}
              </p>
              {uploading && progress.total > 0 && (
                <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden max-w-[120px]">
                  <div className="h-full bg-violet-500 transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              )}
            </div>
          ) : <span className="flex-1" />}
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-500 hover:text-white text-xs transition-all">Cancel</button>
          <button onClick={handleUpload} disabled={uploading || files.length === 0}
            className="flex items-center gap-1.5 px-5 py-1.5 rounded-lg bg-violet-500/20 border border-violet-500/30 text-violet-300 text-xs font-medium hover:bg-violet-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
            {uploading && <Loader2 size={11} className="animate-spin" />}
            {uploading ? `Uploading ${progress.done}/${progress.total}…` : `Upload ${files.length} file${files.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Detail modal ─────────────────────────────────────────────────────────────

function DetailModal({ img, suggestions, onClose, onSave }: {
  img: ImageRecord
  suggestions: string[]
  onClose: () => void
  onSave: (id: number, tags: string[], caption: string | null, marked: boolean) => Promise<void>
}) {
  const [tags,    setTags]    = useState<string[]>(img.adminTags)
  const [caption, setCaption] = useState(img.adminCaption ?? "")
  const [marked,  setMarked]  = useState(img.markedForTraining)
  const [saving,  setSaving]  = useState(false)
  const [imgErr,  setImgErr]  = useState(false)
  const [copied,  setCopied]  = useState<string | null>(null)
  const isVideo = img.imageUrl?.match(/\.(mp4|webm|mov)$/i)

  const dirty = JSON.stringify(tags) !== JSON.stringify(img.adminTags)
    || (caption.trim() || null) !== img.adminCaption
    || marked !== img.markedForTraining

  async function handleSave() {
    setSaving(true)
    await onSave(img.id, tags, caption.trim() || null, marked)
    setSaving(false)
  }

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  function fmt(dateStr: string | null) {
    if (!dateStr) return "—"
    return new Date(dateStr).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  }

  const vm = img.videoMetadata as any
  const isUpload = img.model === '__upload__'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[92vh] rounded-2xl bg-[#0c0c18] border border-white/[0.1] shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-white">{isUpload ? 'Upload' : 'Generation'} #{img.id}</span>
            {isUpload && <span className="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-violet-500/15 text-violet-400">upload</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${img.isDeleted ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400"}`}>
              {img.isDeleted ? "deleted" : "active"}
            </span>
            {img.markedForTraining && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-emerald-500/15 text-emerald-400">training</span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-600 hover:text-slate-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Modal body — scroll */}
        <div className="flex flex-col md:flex-row overflow-hidden flex-1 min-h-0">

          {/* Left: image + refs */}
          <div className="md:w-72 shrink-0 flex flex-col bg-black/30 border-b md:border-b-0 md:border-r border-white/[0.06]">
            {/* Main image / video */}
            <div className="relative bg-black/40 aspect-square md:aspect-auto md:flex-1 min-h-0">
              {isVideo ? (
                <video
                  src={img.imageUrl}
                  controls
                  playsInline
                  poster={vm?.thumbnailUrl ?? undefined}
                  className="absolute inset-0 w-full h-full object-contain"
                />
              ) : imgErr ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                  <ImageIcon size={24} className="text-slate-700" />
                  <span className="text-[10px] text-slate-700">Failed to load</span>
                </div>
              ) : (
                <img src={img.imageUrl} alt="" className="w-full h-full object-contain" onError={() => setImgErr(true)} />
              )}

              {/* Open full */}
              {!isVideo && !imgErr && (
                <a href={img.imageUrl} target="_blank" rel="noreferrer"
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white/60 hover:text-white transition-colors">
                  <ExternalLink size={11} />
                </a>
              )}
            </div>

            {/* Reference images */}
            {img.referenceImageUrls.length > 0 && (
              <div className="p-2 border-t border-white/[0.06]">
                <p className="text-[9px] text-slate-600 uppercase tracking-wider mb-1.5">
                  {img.referenceImageUrls.length} Reference image{img.referenceImageUrls.length > 1 ? "s" : ""}
                </p>
                <div className="grid grid-cols-4 gap-1">
                  {img.referenceImageUrls.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noreferrer" className="aspect-square rounded-md overflow-hidden bg-white/[0.04] border border-white/[0.06] hover:border-white/20 transition-colors">
                      <img src={url} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: all metadata */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5 min-w-0">

            {/* ── Prompt ── */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold">Prompt</p>
                <button onClick={() => copyText(img.prompt, 'prompt')}
                  className="flex items-center gap-1 text-[10px] text-slate-600 hover:text-slate-300 transition-colors">
                  <Copy size={9} />
                  {copied === 'prompt' ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words bg-white/[0.03] rounded-lg px-3 py-2.5 border border-white/[0.05]">
                {img.prompt}
              </p>
            </div>

            {/* ── Generation info / Upload info ── */}
            {isUpload ? (
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-2">Upload info</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {vm?.originalFilename && <InfoRow icon={<FileImage size={11} />} label="Filename"   value={vm.originalFilename} copyKey="filename" copied={copied} onCopy={copyText} mono truncate />}
                  {vm?.fileSize         && <InfoRow icon={<HardDrive size={11} />} label="File size"  value={vm.fileSize < 1024*1024 ? `${(vm.fileSize/1024).toFixed(1)} KB` : `${(vm.fileSize/1024/1024).toFixed(2)} MB`} />}
                  {vm?.mimeType         && <InfoRow icon={<FileImage size={11} />} label="Type"       value={vm.mimeType} mono />}
                  {vm?.width && vm?.height && <InfoRow icon={<Ruler size={11} />}  label="Dimensions" value={`${vm.width} × ${vm.height} px`} />}
                  {img.aspectRatio      && <InfoRow icon={<Layers size={11} />}    label="Aspect"     value={img.aspectRatio} />}
                  <InfoRow icon={<Calendar size={11} />} label="Uploaded"  value={vm?.uploadedAt ? fmt(vm.uploadedAt) : fmt(img.createdAt)} />
                  <InfoRow icon={<Calendar size={11} />} label="DB created" value={fmt(img.createdAt)} />
                  <InfoRow icon={<User size={11} />}     label="Image URL" value={img.imageUrl} copyKey="url" copied={copied} onCopy={copyText} mono truncate />
                </div>
              </div>
            ) : (
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-2">Generation info</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <InfoRow icon={<Cpu size={11} />}        label="Model"       value={img.model} copyKey="model" copied={copied} onCopy={copyText} mono />
                  <InfoRow icon={<Layers size={11} />}     label="Aspect"      value={img.aspectRatio ?? "—"} />
                  <InfoRow icon={<Sparkles size={11} />}   label="Quality"     value={img.quality ?? "—"} />
                  <InfoRow icon={<Tag size={11} />}        label="Ticket cost" value={`${img.ticketCost} ticket${img.ticketCost !== 1 ? "s" : ""}`} />
                  <InfoRow icon={<Calendar size={11} />}   label="Created"     value={fmt(img.createdAt)} />
                  <InfoRow icon={<Clock size={11} />}      label="Expires"     value={fmt(img.expiresAt)} />
                  <InfoRow icon={<User size={11} />}       label="User"        value={img.user.name ? `${img.user.name} (${img.user.email})` : img.user.email} copyKey="email" copied={copied} onCopy={copyText} />
                  <InfoRow icon={<Hash size={11} />}       label="User ID"     value={`#${img.user.id}`} />
                  {img.falRequestId && (
                    <InfoRow icon={<Fingerprint size={11} />} label="FAL ID" value={img.falRequestId} copyKey="falId" copied={copied} onCopy={copyText} mono truncate />
                  )}
                </div>
              </div>
            )}

            {/* ── Video metadata ── */}
            {vm && !isUpload && (
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-2">Video metadata</p>

                {/* Scalar fields */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mb-3">
                  {vm.duration   && <InfoRow icon={<Film size={11} />}   label="Duration"   value={`${vm.duration}s`} />}
                  {vm.resolution && <InfoRow icon={<Layers size={11} />} label="Resolution" value={vm.resolution} />}
                  {vm.aspectRatio && vm.aspectRatio !== img.aspectRatio && <InfoRow icon={<Layers size={11} />} label="Aspect" value={vm.aspectRatio} />}
                  {vm.audioEnabled !== undefined && <InfoRow icon={<Film size={11} />} label="Audio" value={vm.audioEnabled ? 'Yes' : 'No'} />}
                  {vm.characterOrientation && <InfoRow icon={<Film size={11} />} label="Orientation" value={vm.characterOrientation} />}
                  {/* Any remaining unknown scalar fields */}
                  {Object.entries(vm)
                    .filter(([k, v]) => !['duration','resolution','aspectRatio','thumbnailUrl','isVideo','audioEnabled','startFrameUrl','endFrameUrl','motionVideoUrl','keepOriginalSound','characterOrientation'].includes(k) && typeof v !== 'object')
                    .map(([k, v]) => (
                      <InfoRow key={k} icon={<Film size={11} />} label={k} value={String(v)} />
                    ))
                  }
                </div>

                {/* Reference frames — show as image thumbnails */}
                {(vm.startFrameUrl || vm.endFrameUrl || vm.motionVideoUrl || vm.thumbnailUrl) && (
                  <div className="grid grid-cols-2 gap-2">
                    {vm.startFrameUrl && (
                      <a href={vm.startFrameUrl} target="_blank" rel="noreferrer" className="group relative rounded-lg overflow-hidden border border-white/[0.08] hover:border-white/20 transition-colors bg-black/30">
                        <img src={vm.startFrameUrl} alt="Start frame" className="w-full aspect-video object-cover" onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                        <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-black/60 text-[9px] text-slate-300 flex items-center gap-1">
                          <ExternalLink size={8} className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          Start frame
                        </div>
                      </a>
                    )}
                    {vm.endFrameUrl && (
                      <a href={vm.endFrameUrl} target="_blank" rel="noreferrer" className="group relative rounded-lg overflow-hidden border border-white/[0.08] hover:border-white/20 transition-colors bg-black/30">
                        <img src={vm.endFrameUrl} alt="End frame" className="w-full aspect-video object-cover" onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                        <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-black/60 text-[9px] text-slate-300 flex items-center gap-1">
                          <ExternalLink size={8} className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          End frame
                        </div>
                      </a>
                    )}
                    {vm.motionVideoUrl && (
                      <a href={vm.motionVideoUrl} target="_blank" rel="noreferrer" className="group relative rounded-lg overflow-hidden border border-white/[0.08] hover:border-white/20 transition-colors bg-black/30 col-span-2">
                        <video src={vm.motionVideoUrl} muted className="w-full aspect-video object-cover" />
                        <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-black/60 text-[9px] text-slate-300 flex items-center gap-1">
                          <ExternalLink size={8} className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          Motion reference
                        </div>
                      </a>
                    )}
                    {vm.thumbnailUrl && !vm.startFrameUrl && !vm.endFrameUrl && (
                      <a href={vm.thumbnailUrl} target="_blank" rel="noreferrer" className="relative rounded-lg overflow-hidden border border-white/[0.08] bg-black/30">
                        <img src={vm.thumbnailUrl} alt="Thumbnail" className="w-full aspect-video object-cover" />
                        <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-black/60 text-[9px] text-slate-300">Thumbnail</div>
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── User rating ── */}
            {!isUpload && img.imageRating ? (
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-2">User rating</p>
                <div className="bg-white/[0.03] rounded-lg border border-white/[0.05] p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-0.5">
                      {[1,2,3,4,5].map(i => (
                        <Star key={i} size={13} className={i <= img.imageRating!.score ? "text-amber-400 fill-amber-400" : "text-slate-700"} />
                      ))}
                    </div>
                    <span className="text-xs font-semibold text-white">{img.imageRating.score}/5</span>
                    {img.imageRating.wasAccurate !== null && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${img.imageRating.wasAccurate ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                        {img.imageRating.wasAccurate ? "Accurate" : "Inaccurate"}
                      </span>
                    )}
                  </div>
                  {img.imageRating.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {img.imageRating.tags.map(t => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-400">{t}</span>
                      ))}
                    </div>
                  )}
                  {img.imageRating.feedbackText && (
                    <p className="text-[11px] text-slate-400 italic">"{img.imageRating.feedbackText}"</p>
                  )}
                  <p className="text-[9px] text-slate-700">Rated {fmt(img.imageRating.createdAt)}</p>
                </div>
              </div>
            ) : (!isUpload ? (
              <div>
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-1.5">User rating</p>
                <p className="text-xs text-slate-700 italic">Not rated yet</p>
              </div>
            ) : null)}

            {/* ── Admin metadata (editable) ── */}
            <div>
              <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-2">Admin metadata</p>
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] text-slate-600 mb-1.5">Tags</p>
                  <TagInput tags={tags} onChange={setTags} suggestions={suggestions} />
                </div>
                <div>
                  <p className="text-[10px] text-slate-600 mb-1.5">Caption</p>
                  <textarea value={caption} onChange={e => setCaption(e.target.value)}
                    placeholder="Write a caption for training…"
                    rows={3}
                    className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40 resize-none"
                  />
                </div>
                <button onClick={() => setMarked(v => !v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-all
                    ${marked
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                      : "bg-white/[0.04] border-white/[0.07] text-slate-500 hover:text-white"}`}>
                  <BookMarked size={11} />
                  {marked ? "Marked for training" : "Mark for training"}
                </button>
              </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleSave} disabled={saving || !dirty}
                className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-medium hover:bg-cyan-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                {saving && <Loader2 size={11} className="animate-spin" />}
                {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </button>
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-500 hover:text-white text-xs transition-all">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Compact label+value row used inside the detail modal
function InfoRow({ icon, label, value, copyKey, copied, onCopy, mono, truncate }: {
  icon: React.ReactNode
  label: string
  value: string
  copyKey?: string
  copied?: string | null
  onCopy?: (v: string, k: string) => void
  mono?: boolean
  truncate?: boolean
}) {
  return (
    <div className="flex items-start gap-1.5 min-w-0">
      <span className="text-slate-600 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] text-slate-600 uppercase tracking-wide leading-none mb-0.5">{label}</p>
        <div className="flex items-center gap-1 min-w-0">
          <span className={`text-[11px] text-slate-300 leading-snug ${mono ? "font-mono" : ""} ${truncate ? "truncate" : "break-all"}`}>
            {value}
          </span>
          {copyKey && onCopy && (
            <button onClick={() => onCopy(value, copyKey)} className="shrink-0 text-slate-700 hover:text-slate-400 transition-colors">
              {copied === copyKey ? <span className="text-[9px] text-emerald-500">✓</span> : <Copy size={9} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Bulk modals ──────────────────────────────────────────────────────────────

function BulkModal({ mode, count, suggestions, onClose, onApply }: {
  mode: "tags" | "caption"
  count: number
  suggestions: string[]
  onClose: () => void
  onApply: (data: { addTags?: string[]; caption?: string }) => Promise<void>
}) {
  const [tags,   setTags]   = useState<string[]>([])
  const [caption,setCaption]= useState("")
  const [saving, setSaving] = useState(false)

  async function handleApply() {
    if (mode === "tags" && tags.length === 0) return
    if (mode === "caption" && !caption.trim()) return
    setSaving(true)
    await onApply(mode === "tags" ? { addTags: tags } : { caption: caption.trim() })
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-[#0f0f1a] border border-white/[0.1] shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-white">{mode === "tags" ? "Add tags" : "Set caption"}</p>
            <p className="text-[11px] text-slate-600 mt-0.5">
              {count} image{count !== 1 ? "s" : ""} · {mode === "tags" ? "merged with existing" : "replaces existing caption"}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/[0.06] text-slate-600 hover:text-slate-300 transition-colors">
            <X size={14} />
          </button>
        </div>
        {mode === "tags"
          ? <TagInput tags={tags} onChange={setTags} suggestions={suggestions} />
          : <textarea value={caption} onChange={e => setCaption(e.target.value)}
              placeholder="Write a caption for these images…" rows={4} autoFocus
              className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40 resize-none"
            />
        }
        <div className="flex items-center gap-2 mt-4">
          <button onClick={handleApply}
            disabled={saving || (mode === "tags" ? tags.length === 0 : !caption.trim())}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-medium hover:bg-cyan-500/25 transition-all disabled:opacity-50">
            {saving && <Loader2 size={11} className="animate-spin" />}
            Apply
          </button>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-500 hover:text-white text-xs transition-all">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Auto-fill panel ──────────────────────────────────────────────────────────

type AutoFillMode  = 'caption' | 'tags' | 'flux'
type AutoFillModel = 'pro' | 'flash'

interface AutoFillEvent {
  type:       'start' | 'processing' | 'result' | 'skip' | 'error' | 'done'
  id?:        number
  current?:   number
  total?:     number
  value?:     string
  tags?:      string[]
  error?:     string
  reason?:    string
  processed?: number
  skipped?:   number
  failed?:    number
  modelId?:   string
}

interface RunEntry {
  jobId:          string
  status:         'running' | 'queued' | 'paused' | 'done' | 'cancelled'
  mode:           AutoFillMode
  modelKey:       AutoFillModel
  totalCount:     number
  nextIndex:      number
  processedCount: number
  skippedCount:   number
  failedCount:    number
  updatedAt:      string | null
  label:          string
}

// ─── Persistence helpers (used by AutoFillPanel + DatasetPage) ────────────────

const PAGE_PREFS_KEY     = 'dataset-page-prefs'
const AUTOFILL_PREFS_KEY = 'dataset-autofill-prefs'
const AUTOFILL_JOBS_KEY  = 'dataset-autofill-jobs'

function loadPrefs(key: string): Record<string, any> {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} }
}
function savePrefs(key: string, data: Record<string, any>) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch {}
}

// ─── Masonry "Rows" packing (mirrors portal-v2 feed) ─────────────────────────
// Estimate a tile's relative height from its stored aspect ratio ("2:3" /
// "1024x1536" → height per unit column width) so columns balance BEFORE the
// images load and tiles don't move as they fill in.
const arHeightWeight = (ar?: string | null): number => {
  if (!ar || ar === "auto") return 1
  const [w, h] = ar.replace(/x/i, ":").split(":").map(parseFloat)
  return w > 0 && h > 0 ? h / w : 1
}
// Deterministic shortest-column packing: each item goes to the currently
// shortest column, so the first row fills left-to-right and appending new
// items never moves existing ones.
function distributeMasonry<T extends { weight: number }>(items: T[], n: number): T[][] {
  const cols: T[][] = Array.from({ length: n }, () => [])
  const heights = new Array(n).fill(0)
  for (const item of items) {
    let min = 0
    for (let i = 1; i < n; i++) if (heights[i] < heights[min]) min = i
    cols[min].push(item)
    heights[min] += item.weight
  }
  return cols
}

function AutoFillPanel({ selected, imageUrlById, onClose, onItemSaved, onJobChange }: {
  selected:     Set<number>
  imageUrlById: Record<number, string>
  onClose:      () => void
  onItemSaved:  (id: number, data: { caption?: string; tags?: string[] }) => void
  onJobChange?: (running: boolean) => void
}) {
  const count = selected.size

  // Config — lazy init from localStorage
  const [_ap]        = useState(() => loadPrefs(AUTOFILL_PREFS_KEY))
  const [mode,        setMode]        = useState<AutoFillMode>(() => _ap.mode        ?? 'caption')
  const [model,       setModel]       = useState<AutoFillModel>(() => _ap.model       ?? 'flash')
  const [overwrite,   setOverwrite]   = useState<boolean>(() => _ap.overwrite   ?? false)
  const [advanced,    setAdvanced]    = useState<boolean>(() => _ap.advanced    ?? false)
  const [context,     setContext]     = useState<string>(() => _ap.context     ?? '')
  const [contextTags, setContextTags] = useState<string[]>(() => _ap.contextTags ?? [])
  const [tagInput,    setTagInput]    = useState('')

  useEffect(() => {
    savePrefs(AUTOFILL_PREFS_KEY, { mode, model, overwrite, advanced, context, contextTags })
  }, [mode, model, overwrite, advanced, context, contextTags])

  // Queue of runs
  const [runs, setRuns] = useState<RunEntry[]>([])
  const runsRef         = useRef<RunEntry[]>([])
  const seenResultIds    = useRef(new Map<string, Set<number>>())
  const isInitialized    = useRef(false)
  const [selectedRunId,  setSelectedRunId]  = useState<string | null>(null)
  const selectedRunIdRef = useRef<string | null>(null)
  const [detailResults,  setDetailResults]  = useState<any[]>([])
  const [editingId,      setEditingId]      = useState<number | null>(null)
  const [editValue,      setEditValue]      = useState('')
  const [savingIds,      setSavingIds]      = useState(new Set<number>())
  const lastAutoKick     = useRef<Record<string, number>>({}) // jobId → last auto-kick timestamp

  // Keep ref in sync + notify parent + persist active job IDs (guard on isInitialized to avoid overwriting localStorage before restore)
  useEffect(() => {
    runsRef.current = runs
    onJobChange?.(runs.some(r => r.status === 'running' || r.status === 'paused' || r.status === 'queued'))
    if (!isInitialized.current) return
    const activeIds = runs.filter(r => r.status !== 'done' && r.status !== 'cancelled').map(r => r.jobId)
    try { localStorage.setItem(AUTOFILL_JOBS_KEY, JSON.stringify(activeIds)) } catch {}
  }, [runs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mount: load active jobs from DB (cross-device — not localStorage-specific)
  useEffect(() => {
    fetch('/api/admin/auto-caption/jobs', { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { jobs: [] })
      .then(({ jobs }: { jobs: any[] }) => {
        const entries: RunEntry[] = jobs
          .filter((j: any) => j.status !== 'done' && j.status !== 'cancelled')
          .map((j: any) => {
            const modeLabel = j.mode === 'flux' ? 'FLUX' : j.mode === 'caption' ? 'Caption' : 'Tags'
            const tag = j.triggerWord || (j.curatorContext ? j.curatorContext.slice(0, 24) : null)
            return {
              jobId:          j.id,
              status:         j.status as RunEntry['status'],
              mode:           j.mode as AutoFillMode,
              modelKey:       j.modelKey as AutoFillModel,
              totalCount:     j.totalCount,
              nextIndex:      j.nextIndex,
              processedCount: j.processedCount,
              skippedCount:   j.skippedCount,
              failedCount:    j.failedCount,
              updatedAt:      j.updatedAt ?? null,
              label:          tag ? `${modeLabel} · ${tag}` : modeLabel,
            } as RunEntry
          })
        if (entries.length) setRuns(entries)
      })
      .catch(() => {})
      .finally(() => { isInitialized.current = true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Polling — single interval reads from ref to avoid stale closures; also polls selected job for detail view
  useEffect(() => {
    const interval = setInterval(async () => {
      // Poll running + queued + paused so we detect backend status transitions (e.g. queued→running)
      const active     = runsRef.current.filter(r => r.status === 'running' || r.status === 'queued' || r.status === 'paused')
      const selectedId = selectedRunIdRef.current
      const jobIds     = [...new Set([...active.map(r => r.jobId), ...(selectedId ? [selectedId] : [])])]
      if (!jobIds.length) return
      await Promise.all(jobIds.map(async (jobId) => {
        try {
          const res = await fetch(`/api/admin/auto-caption/jobs/${jobId}`, { headers: authHeaders() })
          if (!res.ok) return
          const job = await res.json()

          // Update detail results if this is the selected job
          if (jobId === selectedRunIdRef.current && Array.isArray(job.results)) {
            setDetailResults(job.results)
          }

          // Surface new results to parent grid (running jobs only)
          const run = runsRef.current.find(r => r.jobId === jobId)
          if (run?.status === 'running') {
            const seen = seenResultIds.current.get(jobId) ?? new Set<number>()
            const results: any[] = Array.isArray(job.results) ? job.results : []
            results.filter((item: any) => item.type === 'result' && !seen.has(item.id)).forEach((item: any) => {
              seen.add(item.id)
              const isTagMode = run.mode === 'tags'
              onItemSaved(item.id, isTagMode ? { tags: item.tags } : { caption: item.value })
            })
            seenResultIds.current.set(jobId, seen)
          }

          setRuns(prev => prev.map(r => r.jobId === jobId ? {
            ...r,
            status:         job.status,
            nextIndex:      job.nextIndex,
            totalCount:     job.totalCount,
            processedCount: job.processedCount,
            skippedCount:   job.skippedCount,
            failedCount:    job.failedCount,
            updatedAt:      job.updatedAt ?? r.updatedAt,
          } : r))

          // Auto-kick stuck jobs — don't wait for user to click Resume
          const isStuckNow = job.status === 'running'
            && job.updatedAt
            && Date.now() - new Date(job.updatedAt).getTime() > 90_000
          const lastKick = lastAutoKick.current[jobId] ?? 0
          if (isStuckNow && Date.now() - lastKick > 60_000) {
            lastAutoKick.current[jobId] = Date.now()
            fetch(`/api/admin/auto-caption/jobs/${jobId}/continue`, {
              method: 'POST', headers: authHeaders(),
            }).catch(() => {})
          }
        } catch {}
      }))
    }, 3000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep selectedRunIdRef in sync with state
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])

  // Fetch detail results immediately when a run is selected
  useEffect(() => {
    if (!selectedRunId) { setDetailResults([]); return }
    fetch(`/api/admin/auto-caption/jobs/${selectedRunId}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(job => { if (Array.isArray(job.results)) setDetailResults(job.results) })
      .catch(() => {})
  }, [selectedRunId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────────────────────────────

  function cleanTagsClient(raw: string): string[] {
    return raw.split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')).filter(t => t.length > 0 && t.length <= 40)
  }

  async function addToQueue() {
    if (count === 0) return
    const ids = Array.from(selected)
    const modeLabel    = mode === 'flux' ? 'FLUX' : mode === 'caption' ? 'Caption' : 'Tags'
    const triggerLabel = contextTags.length ? contextTags[0] : ''
    const label        = triggerLabel ? `${modeLabel} · ${triggerLabel}` : `${modeLabel} · ${ids.length} images`

    try {
      const res = await fetch('/api/admin/auto-caption/jobs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body:    JSON.stringify({
          ids, mode, model, overwrite, advanced,
          context:     context.trim() || undefined,
          contextTags: contextTags.length ? contextTags : undefined,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { jobId, status: jobStatus } = await res.json()
      const newRun: RunEntry = {
        jobId, status: jobStatus as RunEntry['status'],
        mode, modelKey: model, totalCount: ids.length, nextIndex: 0,
        processedCount: 0, skippedCount: 0, failedCount: 0,
        updatedAt: new Date().toISOString(), label,
      }
      setRuns(prev => [...prev, newRun])
    } catch (err: unknown) {
      alert(`Failed to queue: ${(err as Error).message}`)
    }
  }

  async function pauseRun(jobId: string) {
    await fetch(`/api/admin/auto-caption/jobs/${jobId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ status: 'paused' }),
    }).catch(() => {})
    setRuns(prev => prev.map(r => r.jobId === jobId ? { ...r, status: 'paused' } : r))
  }

  async function resumeRun(jobId: string) {
    await fetch(`/api/admin/auto-caption/jobs/${jobId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ status: 'running' }),
    }).catch(() => {})
    await fetch(`/api/admin/auto-caption/jobs/${jobId}/continue`, {
      method: 'POST', headers: authHeaders(),
    }).catch(() => {})
    setRuns(prev => prev.map(r => r.jobId === jobId ? { ...r, status: 'running', updatedAt: new Date().toISOString() } : r))
  }

  async function cancelRun(jobId: string) {
    await fetch(`/api/admin/auto-caption/jobs/${jobId}`, {
      method: 'DELETE', headers: authHeaders(),
    }).catch(() => {})
    setRuns(prev => prev.map(r => r.jobId === jobId ? { ...r, status: 'cancelled' } : r))
  }

  async function resumeStuck(jobId: string) {
    await fetch(`/api/admin/auto-caption/jobs/${jobId}/continue`, {
      method: 'POST', headers: authHeaders(),
    }).catch(() => {})
    setRuns(prev => prev.map(r => r.jobId === jobId ? { ...r, updatedAt: new Date().toISOString() } : r))
  }

  function dismissRun(jobId: string) {
    setRuns(prev => prev.filter(r => r.jobId !== jobId))
  }

  async function continueRun(jobId: string) {
    try {
      const res = await fetch(`/api/admin/auto-caption/jobs/${jobId}/resume`, {
        method: 'POST', headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { status: newStatus, nextIndex, totalCount } = await res.json()
      setRuns(prev => prev.map(r => r.jobId === jobId ? {
        ...r, status: newStatus as RunEntry['status'],
        nextIndex, totalCount, updatedAt: new Date().toISOString(),
      } : r))
    } catch (err: unknown) {
      alert(`Failed to continue: ${(err as Error).message}`)
    }
  }

  async function saveDetailEdit(itemId: number, isTagMode: boolean) {
    const newVal = editValue.trim()
    if (!newVal) return
    setSavingIds(prev => new Set([...prev, itemId]))
    try {
      const updatedTags  = isTagMode ? cleanTagsClient(newVal) : undefined
      const updatedValue = isTagMode ? updatedTags!.join(', ') : newVal
      await fetch('/api/admin/dataset', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(isTagMode ? { ids: [itemId], tags: updatedTags } : { ids: [itemId], caption: newVal }),
      })
      setDetailResults(prev => prev.map((r: any) =>
        r.id === itemId ? { ...r, value: updatedValue, ...(updatedTags ? { tags: updatedTags } : {}) } : r
      ))
      onItemSaved(itemId, isTagMode ? { tags: updatedTags! } : { caption: newVal })
      setEditingId(null)
      setEditValue('')
    } catch (err: unknown) {
      alert(`Failed: ${(err as Error).message}`)
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(itemId); return n })
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const selectedRun  = runs.find(r => r.jobId === selectedRunId) ?? null
  const activeCount  = runs.filter(r => r.status === 'running' || r.status === 'paused').length
  const queuedCount  = runs.filter(r => r.status === 'queued').length

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
        {selectedRunId ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <button onClick={() => { setSelectedRunId(null); setEditingId(null); setEditValue('') }}
              className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-slate-300 transition-colors shrink-0">
              <ArrowLeft size={13} />
            </button>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate leading-none">{selectedRun?.label ?? 'Job Detail'}</p>
              <p className="text-[10px] mt-0.5 leading-none text-slate-600">
                {detailResults.filter((r: any) => r.type === 'result').length} results
                {selectedRun && selectedRun.totalCount > 0 ? ` · ${selectedRun.nextIndex}/${selectedRun.totalCount}` : ''}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-white/[0.06] border border-white/[0.12] flex items-center justify-center">
              <Sparkles size={12} className="text-slate-200" />
            </div>
            <div>
              <p className="text-xs font-black tracking-tight leading-none text-transparent bg-clip-text bg-gradient-to-r from-white via-white/85 to-white/55">Auto Fill</p>
              <p className="text-[10px] mt-0.5 leading-none">
                {activeCount > 0 || queuedCount > 0
                  ? <span className="text-emerald-400/80">
                      {activeCount > 0 ? `${activeCount} active` : ''}
                      {activeCount > 0 && queuedCount > 0 ? ' · ' : ''}
                      {queuedCount > 0 ? `${queuedCount} queued` : ''}
                    </span>
                  : <span className="text-slate-600">{count > 0 ? `${count} selected` : 'Select images on the right'}</span>
                }
              </p>
            </div>
          </div>
        )}
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-600 hover:text-slate-300 transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* ── Scrollable body ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── Detail view ──────────────────────────────────────────────────── */}
        {selectedRunId && selectedRun && (
          <div className="p-3 space-y-3">
            {/* Progress summary */}
            {selectedRun.status !== 'queued' && (
              <div>
                <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden mb-1.5">
                  <div className={`h-full rounded-full transition-all duration-500 ${
                    selectedRun.status === 'done'      ? 'bg-emerald-500' :
                    selectedRun.status === 'paused'    ? 'bg-amber-500' :
                    selectedRun.status === 'cancelled' ? 'bg-red-500/60' : 'bg-cyan-500'
                  }`} style={{ width: `${selectedRun.totalCount > 0 ? (selectedRun.nextIndex / selectedRun.totalCount) * 100 : 0}%` }} />
                </div>
                <p className="text-[10px] text-slate-600 leading-none">
                  {selectedRun.processedCount > 0 && <span className="text-emerald-600">{selectedRun.processedCount} filled </span>}
                  {selectedRun.skippedCount > 0 && <span>{selectedRun.skippedCount} skipped </span>}
                  {selectedRun.failedCount > 0 && <span className="text-red-500">{selectedRun.failedCount} failed</span>}
                  {selectedRun.status === 'running' && selectedRun.processedCount === 0 && selectedRun.skippedCount === 0 && <span className="text-slate-700">Starting…</span>}
                </p>
              </div>
            )}
            {/* Results list */}
            {detailResults.length === 0 ? (
              <p className="text-[11px] text-slate-700 text-center py-8">
                {selectedRun.status === 'queued' ? 'Job is queued — results will appear once it starts.' : 'No results yet…'}
              </p>
            ) : (
              [...detailResults].reverse().map((item: any) => (
                <div key={`${item.id}-${item.type}`} className={`rounded-xl border overflow-hidden ${
                  item.type === 'error' ? 'border-red-500/15 bg-red-500/[0.03]' :
                  item.type === 'skip'  ? 'border-white/[0.04] bg-transparent' :
                                          'border-white/[0.07] bg-white/[0.02]'
                }`}>
                  <div className="flex gap-2.5 p-2.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.imageUrl} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0 bg-white/[0.03]" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 mb-1">
                        <span className={`text-[8px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
                          item.type === 'result' ? 'bg-emerald-500/15 text-emerald-400' :
                          item.type === 'skip'   ? 'bg-slate-700/40 text-slate-500' :
                                                   'bg-red-500/15 text-red-400'
                        }`}>
                          {item.type === 'result' ? (selectedRun.mode === 'tags' ? 'tagged' : 'captioned') : item.type}
                        </span>
                      </div>
                      {item.type === 'result' ? (
                        editingId === item.id ? (
                          <div className="space-y-1">
                            <textarea
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              className="w-full rounded-lg border border-cyan-500/30 bg-white/[0.03] px-2 py-1.5 text-[10px] text-slate-200 placeholder-slate-700 outline-none resize-none"
                              rows={selectedRun.mode === 'tags' ? 2 : 3}
                              autoFocus
                            />
                            <div className="flex gap-1">
                              <button onClick={() => saveDetailEdit(item.id, selectedRun.mode === 'tags')}
                                disabled={savingIds.has(item.id)}
                                className="px-2 py-0.5 rounded-lg bg-cyan-500/15 border border-cyan-500/25 text-cyan-400 text-[9px] hover:bg-cyan-500/20 disabled:opacity-50 transition-all">
                                {savingIds.has(item.id) ? 'Saving…' : 'Save'}
                              </button>
                              <button onClick={() => { setEditingId(null); setEditValue('') }}
                                className="px-2 py-0.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-500 text-[9px] hover:text-slate-300 transition-all">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            {selectedRun.mode === 'tags' ? (
                              <div className="flex flex-wrap gap-0.5 mb-1">
                                {(item.tags ?? []).slice(0, 10).map((tag: string) => (
                                  <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/15 text-cyan-400/70">{tag}</span>
                                ))}
                                {(item.tags ?? []).length > 10 && <span className="text-[9px] text-slate-600">+{(item.tags as string[]).length - 10}</span>}
                                {(!item.tags || (item.tags as string[]).length === 0) && <span className="text-[10px] text-slate-700 italic">no tags</span>}
                              </div>
                            ) : (
                              <p className="text-[10px] text-slate-400 leading-relaxed mb-1 line-clamp-3">{item.value}</p>
                            )}
                            <button onClick={() => { setEditingId(item.id); setEditValue(selectedRun.mode === 'tags' ? (item.tags ?? []).join(', ') : (item.value ?? '')) }}
                              className="text-[9px] text-slate-600 hover:text-cyan-400 transition-colors">
                              Edit ✎
                            </button>
                          </div>
                        )
                      ) : item.type === 'error' ? (
                        <p className="text-[10px] text-red-400/70 italic leading-relaxed">{item.error ?? 'Unknown error'}</p>
                      ) : (
                        <p className="text-[10px] text-slate-600 italic">{item.error ? `Skipped: ${item.error}` : 'Skipped'}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Config + Queue — hidden when detail view is active */}
        <div className={selectedRunId ? 'hidden' : ''}>

        {/* Config section */}
        <div className="px-4 pt-3 pb-3 space-y-2.5 border-b border-white/[0.05]">

          {/* Mode */}
          <div className="flex gap-1.5">
            {([
              { id: 'caption', label: 'Caption',      active: 'bg-white/[0.12] border-white/30 text-white' },
              { id: 'tags',    label: 'Tags',         active: 'bg-white/[0.12] border-white/30 text-white' },
              { id: 'flux',    label: 'FLUX Caption', active: 'bg-amber-500/15 border-amber-500/30 text-amber-300' },
            ] as const).map(m => (
              <button key={m.id} onClick={() => setMode(m.id)}
                className={`flex-1 py-1.5 rounded-lg border text-[10px] font-medium transition-all
                  ${mode === m.id ? m.active : 'bg-white/[0.03] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Model + advanced */}
          <div className="flex gap-1.5">
            {([{ key: 'flash', label: 'Flash Lite' }, { key: 'pro', label: 'Pro' }] as const).map(m => (
              <button key={m.key} onClick={() => setModel(m.key)}
                className={`flex-1 py-1.5 rounded-lg border text-[11px] transition-all
                  ${model === m.key ? 'bg-white/[0.12] border-white/30 text-white' : 'bg-white/[0.03] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                {m.label}
              </button>
            ))}
            {mode !== 'flux' && ([{ key: false, label: 'Basic' }, { key: true, label: 'Advanced' }] as const).map(m => (
              <button key={String(m.key)} onClick={() => setAdvanced(m.key)}
                className={`flex-1 py-1.5 rounded-lg border text-[11px] transition-all
                  ${advanced === m.key ? 'bg-white/[0.12] border-white/30 text-white' : 'bg-white/[0.03] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Context tags */}
          {mode === 'flux' && (
            <p className="text-[10px] text-amber-400/70">
              First tag = trigger word (e.g. <span className="font-mono text-amber-300">DARTHVADER</span>). Additional tags = context.
            </p>
          )}
          <div className={`flex flex-wrap gap-1 min-h-[26px] rounded-lg border px-2 py-1.5 ${mode === 'flux' ? 'border-amber-500/25 bg-amber-500/[0.03]' : 'border-white/[0.07] bg-white/[0.02]'}`}>
            {contextTags.map((tag, i) => (
              <span key={tag} className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border
                ${mode === 'flux' && i === 0
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                  : 'bg-white/[0.06] border-white/15 text-slate-200'}`}>
                {mode === 'flux' && i === 0 && <span className="text-[8px] mr-0.5 opacity-60">⚡</span>}
                {tag}
                <button onClick={() => setContextTags(prev => prev.filter(t => t !== tag))} className="text-current opacity-50 hover:opacity-100 ml-0.5">×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                  e.preventDefault()
                  const val = tagInput.trim().replace(/,$/, '')
                  if (val && !contextTags.includes(val)) setContextTags(prev => [...prev, val])
                  setTagInput('')
                }
                if (e.key === 'Backspace' && !tagInput && contextTags.length) setContextTags(prev => prev.slice(0, -1))
              }}
              placeholder={
                mode === 'flux'
                  ? contextTags.length === 0 ? '⚡ Trigger word (Enter)…' : 'Add context tag…'
                  : contextTags.length ? 'Add subject…' : 'Subject / context tags (Enter)'
              }
              className="flex-1 min-w-[80px] bg-transparent text-[11px] text-white placeholder-slate-600 outline-none"
            />
          </div>
          {mode !== 'flux' && (context || contextTags.length === 0) && (
            <textarea value={context} onChange={e => setContext(e.target.value)}
              placeholder="Optional: full context sentence…"
              rows={1}
              className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-slate-300 placeholder-slate-700 outline-none resize-none"
            />
          )}

          {/* Overwrite toggle */}
          <div className="flex items-center gap-2">
            <button onClick={() => setOverwrite(v => !v)}
              className={`w-7 h-3.5 rounded-full transition-colors relative shrink-0 ${overwrite ? 'bg-white/80' : 'bg-white/[0.1]'}`}>
              <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full transition-transform ${overwrite ? 'translate-x-3.5 bg-[#05080f]' : 'translate-x-0 bg-white'}`} />
            </button>
            <span className="text-[10px] text-slate-600">Overwrite existing</span>
          </div>

          {/* Add to queue button */}
          <button
            onClick={addToQueue}
            disabled={count === 0}
            className="relative overflow-hidden w-full py-2 rounded-lg bg-white/10 border border-white/25 text-white text-xs font-bold hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {count > 0 && (
              <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent pointer-events-none" style={{ animation: 'sheen-sweep 2.6s infinite' }} />
            )}
            {count === 0 ? 'Select images on the right →' : `Add to Queue (${count} images)`}
          </button>
        </div>

        {/* ── Queue ──────────────────────────────────────────────────────────── */}
        {runs.length > 0 ? (
          <div className="p-3 space-y-2">
            <p className="text-[10px] text-slate-600 uppercase tracking-wider px-1">Queue</p>
            {runs.map(run => {
              const isRunning   = run.status === 'running'
              const isPaused    = run.status === 'paused'
              const isQueued    = run.status === 'queued'
              const isDone      = run.status === 'done'
              const isCancelled = run.status === 'cancelled'
              const isStuck     = isRunning && !!run.updatedAt && Date.now() - new Date(run.updatedAt).getTime() > 90_000
              const pct         = run.totalCount > 0 ? (run.nextIndex / run.totalCount) * 100 : 0

              return (
                <div key={run.jobId}
                onClick={() => { setSelectedRunId(run.jobId); setEditingId(null); setEditValue('') }}
                className={`rounded-xl border overflow-hidden cursor-pointer transition-colors ${
                  isRunning   ? 'border-cyan-500/20 bg-cyan-500/[0.03] hover:bg-cyan-500/[0.05]' :
                  isPaused    ? 'border-amber-500/20 bg-amber-500/[0.03] hover:bg-amber-500/[0.05]' :
                  isQueued    ? 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]' :
                  isDone      ? 'border-emerald-500/20 bg-emerald-500/[0.02] hover:bg-emerald-500/[0.04]' :
                               'border-white/[0.05] bg-transparent hover:bg-white/[0.02]'
                }`}>
                  <div className="px-3 pt-2.5 pb-2.5">

                    {/* Top row: badges + controls */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                          <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
                            isStuck     ? 'bg-red-500/15 text-red-400' :
                            isRunning   ? 'bg-cyan-500/15 text-cyan-400' :
                            isPaused    ? 'bg-amber-500/15 text-amber-400' :
                            isQueued    ? 'bg-slate-700/60 text-slate-400' :
                            isDone      ? 'bg-emerald-500/15 text-emerald-400' :
                                         'bg-white/[0.05] text-slate-600'
                          }`}>
                            {isStuck ? 'Stalled' : run.status}
                          </span>
                          <span className="text-[10px] text-slate-300 truncate font-medium">{run.label}</span>
                        </div>
                        <p className="text-[10px] text-slate-600">
                          {run.mode === 'flux' ? 'FLUX' : run.mode === 'caption' ? 'Caption' : 'Tags'}
                          {' · '}{run.modelKey === 'flash' ? 'Flash Lite' : 'Pro'}
                          {isQueued ? ` · ${run.totalCount} images` : ` · ${run.nextIndex}/${run.totalCount}`}
                        </p>
                      </div>

                      {/* Controls */}
                      <div className="flex items-center gap-1 shrink-0 mt-0.5">
                        {isStuck && (
                          <button onClick={e => { e.stopPropagation(); resumeStuck(run.jobId) }}
                            className="px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[9px] hover:bg-amber-500/15 transition-all">
                            Resume
                          </button>
                        )}
                        {isRunning && !isStuck && (
                          <button onClick={e => { e.stopPropagation(); pauseRun(run.jobId) }} title="Pause"
                            className="w-6 h-6 rounded-lg bg-white/[0.05] border border-white/[0.08] text-slate-400 hover:text-white text-[10px] flex items-center justify-center transition-all">
                            ⏸
                          </button>
                        )}
                        {isPaused && (
                          <button onClick={e => { e.stopPropagation(); resumeRun(run.jobId) }} title="Resume"
                            className="w-6 h-6 rounded-lg bg-white/[0.05] border border-white/[0.08] text-slate-400 hover:text-white text-[10px] flex items-center justify-center transition-all">
                            ▶
                          </button>
                        )}
                        {(isRunning || isPaused || isQueued) && (
                          <button onClick={e => { e.stopPropagation(); cancelRun(run.jobId) }} title="Cancel"
                            className="w-6 h-6 rounded-lg bg-red-500/[0.07] border border-red-500/15 text-red-500 hover:text-red-400 text-[10px] flex items-center justify-center transition-all">
                            ■
                          </button>
                        )}
                        {(isDone || isCancelled) && (
                          <>
                            {isCancelled && run.nextIndex < run.totalCount && (
                              <button onClick={e => { e.stopPropagation(); continueRun(run.jobId) }}
                                className="px-2 py-0.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-500 hover:text-cyan-300 text-[9px] transition-all">
                                Continue
                              </button>
                            )}
                            <button onClick={e => { e.stopPropagation(); dismissRun(run.jobId) }}
                              className="px-2 py-0.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-600 hover:text-slate-400 text-[9px] transition-all">
                              Dismiss
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    {!isQueued && (
                      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden mb-1.5">
                        <div className={`h-full rounded-full transition-all duration-500 ${
                          isDone    ? 'bg-emerald-500' :
                          isPaused  ? 'bg-amber-500' :
                          isStuck   ? 'bg-red-500/60' :
                                      'bg-cyan-500'
                        }`} style={{ width: `${pct}%` }} />
                      </div>
                    )}

                    {/* Counts */}
                    {!isQueued && (run.processedCount > 0 || run.skippedCount > 0 || run.failedCount > 0) && (
                      <p className="text-[10px] text-slate-600 leading-none">
                        {run.processedCount > 0 && <span className="text-emerald-600">{run.processedCount} filled</span>}
                        {run.processedCount > 0 && run.skippedCount > 0 && <span className="mx-1 text-slate-700">·</span>}
                        {run.skippedCount > 0 && <span>{run.skippedCount} skipped</span>}
                        {(run.processedCount > 0 || run.skippedCount > 0) && run.failedCount > 0 && <span className="mx-1 text-slate-700">·</span>}
                        {run.failedCount > 0 && <span className="text-red-500">{run.failedCount} failed</span>}
                      </p>
                    )}
                    {isDone && run.processedCount === 0 && run.skippedCount > 0 && (
                      <p className="text-[10px] text-amber-500/60 mt-0.5">All skipped — enable Overwrite to re-process</p>
                    )}
                    {!isQueued && run.processedCount === 0 && run.skippedCount === 0 && run.failedCount === 0 && isRunning && (
                      <p className="text-[10px] text-slate-700">Starting…</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <p className="text-[11px] text-slate-600">No runs yet.</p>
            <p className="text-[10px] text-slate-700 mt-1">Select images on the right, configure, then add to queue.</p>
          </div>
        )}
        </div>{/* end config+queue wrapper */}
      </div>
    </div>
  )
}

// ─── Pagination nav ───────────────────────────────────────────────────────────

function PageNav({ pagination, page, loading, setPage, className = "" }: {
  pagination: { totalPages: number }
  page: number
  loading: boolean
  setPage: (fn: (p: number) => number) => void
  className?: string
}) {
  const total = pagination.totalPages
  const mid   = Math.min(Math.max(page, 4), total - 3)
  const pages = total <= 7
    ? Array.from({ length: total }, (_, i) => i + 1)
    : [...new Set([1, 2, 3, mid - 1, mid, mid + 1, total - 2, total - 1, total].filter(v => v > 0 && v <= total))].sort((a, b) => a - b)

  return (
    <div className={`flex items-center justify-center gap-2 flex-wrap ${className}`}>
      <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}
        className="p-2 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-400 hover:text-white disabled:opacity-30 transition-all">
        <ChevronLeft size={15} />
      </button>
      <div className="flex items-center gap-1">
        {pages.map(p => (
          <button key={p} onClick={() => setPage(() => p)}
            className={`w-8 h-8 rounded-lg text-xs font-medium transition-all
              ${p === page ? "bg-cyan-500/20 border border-cyan-500/30 text-cyan-300" : "bg-white/[0.04] border border-white/[0.07] text-slate-500 hover:text-white"}`}>
            {p}
          </button>
        ))}
      </div>
      <button onClick={() => setPage(p => Math.min(total, p + 1))} disabled={page >= total || loading}
        className="p-2 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-400 hover:text-white disabled:opacity-30 transition-all">
        <ChevronRight size={15} />
      </button>
      <form
        onSubmit={e => {
          e.preventDefault()
          const val = parseInt((e.currentTarget.elements.namedItem('gotopage') as HTMLInputElement).value)
          if (!isNaN(val)) setPage(() => Math.max(1, Math.min(total, val)));
          (e.currentTarget.elements.namedItem('gotopage') as HTMLInputElement).value = ''
        }}
        className="flex items-center gap-1.5 ml-1"
      >
        <span className="text-[10px] text-slate-600">Go to</span>
        <input
          name="gotopage"
          type="number"
          min={1}
          max={total}
          placeholder={String(page)}
          className="w-14 h-8 rounded-lg bg-white/[0.04] border border-white/[0.07] text-xs text-white text-center outline-none focus:border-cyan-500/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
      </form>
    </div>
  )
}

// ─── Image card ───────────────────────────────────────────────────────────────

const ImageCard = memo(function ImageCard({ img, selected, selectMode, onSelect, onOpen, onToggleMark, index, layout = "grid", showInfo = true }: {
  img: ImageRecord
  selected: boolean
  selectMode: boolean
  onSelect: (id: number) => void
  onOpen: (img: ImageRecord) => void
  onToggleMark: (id: number, current: boolean) => void
  index: number
  // grid = uniform squares (classic); masonry = natural aspect, portal-style
  layout?: "grid" | "masonry"
  showInfo?: boolean
}) {
  const [imgError, setImgError] = useState(false)
  const isVideo = img.imageUrl?.match(/\.(mp4|webm|mov)$/i)
  const priority = index < 6

  function handleClick() {
    if (selectMode) onSelect(img.id)
    else onOpen(img)
  }

  return (
    <div
      onClick={handleClick}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
      className={`group relative rounded-xl overflow-hidden border transition-all cursor-pointer
        ${selected
          ? "border-cyan-500/60 ring-1 ring-cyan-500/30"
          : img.markedForTraining
            ? "border-emerald-500/40 hover:border-emerald-400/60"
            : "border-white/[0.07] hover:border-white/20"
        } bg-white/[0.03]`}
    >
      <div className={`relative ${layout === "masonry" ? "" : "aspect-square"} bg-white/[0.03]`}>
        {isVideo ? (
          <>
            {img.videoMetadata?.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img.videoMetadata.thumbnailUrl}
                alt=""
                loading={priority ? 'eager' : 'lazy'}
                decoding="async"
                className={layout === "masonry" ? "w-full h-auto block" : "absolute inset-0 w-full h-full object-cover"}
              />
            ) : (
              <div className={`${layout === "masonry" ? "aspect-video" : "absolute inset-0"} flex items-center justify-center bg-violet-950/30`}>
                <Sparkles size={24} className="text-violet-400" />
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-8 h-8 rounded-full bg-black/60 flex items-center justify-center">
                <Video size={14} className="text-white ml-0.5" />
              </div>
            </div>
          </>
        ) : imgError ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <ImageIcon size={20} className="text-slate-700" />
          </div>
        ) : (
          // The grid used to feed multi-MB ORIGINALS through the Next image
          // optimizer, which choked at scale (half the tiles never loaded).
          // The 400px webp thumb route is cached and loads like the portal feed.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/admin/dataset/thumb/${img.id}`}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            onError={() => setImgError(true)}
            className={layout === "masonry" ? "w-full h-auto block" : "absolute inset-0 w-full h-full object-cover"}
          />
        )}

        {/* Checkbox — always visible in select mode, hover-only otherwise */}
        {selectMode && (
          <div className="absolute top-1.5 left-1.5 z-10">
            {selected
              ? <CheckSquare size={16} className="text-cyan-400 drop-shadow-md" />
              : <Square      size={16} className="text-white/60 drop-shadow-md" />
            }
          </div>
        )}

        {/* Training mark (top-right) */}
        <button
          className={`absolute top-1.5 right-1.5 z-10 p-1 rounded-md transition-all
            ${img.markedForTraining ? "bg-emerald-500/80 opacity-100" : "bg-black/50 opacity-0 group-hover:opacity-100"}`}
          onClick={e => { e.stopPropagation(); onToggleMark(img.id, img.markedForTraining) }}
          title={img.markedForTraining ? "Remove from training set" : "Mark for training"}
        >
          <BookMarked size={11} className={img.markedForTraining ? "text-white" : "text-white/80"} />
        </button>

        {/* Bottom-left badges: caption check + ref count */}
        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1">
          {img.adminCaption && (
            <div className="w-4 h-4 rounded-full bg-emerald-500/80 flex items-center justify-center" title="Has caption">
              <Check size={9} className="text-white" strokeWidth={3} />
            </div>
          )}
          {img.referenceImageUrls.length > 0 && (
            <div className="px-1.5 py-0.5 rounded-md bg-black/60 text-[9px] text-slate-300 leading-none">
              {img.referenceImageUrls.length}ref
            </div>
          )}
        </div>

        {/* Rating (bottom-right) */}
        {img.imageRating && (
          <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5">
            {[1,2,3,4,5].map(i => (
              <Star key={i} size={8} className={i <= img.imageRating!.score ? "text-amber-400 fill-amber-400" : "text-slate-700"} />
            ))}
          </div>
        )}
      </div>

      {/* Metadata row — hidden on mobile, visible on sm+, toggleable via Feed settings */}
      {showInfo && (
      <div className="hidden sm:block px-2 py-1.5 space-y-1">
        <p className="text-[10px] text-slate-400 leading-snug line-clamp-2">{img.prompt}</p>

        {img.adminTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {img.adminTags.slice(0, 3).map(tag => (
              <span key={tag} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/15 text-cyan-400 text-[9px] leading-none">
                <Hash size={7} />{tag}
              </span>
            ))}
            {img.adminTags.length > 3 && <span className="text-[9px] text-slate-600">+{img.adminTags.length - 3}</span>}
          </div>
        )}

        {img.adminCaption && (
          <p className="text-[9px] text-slate-600 italic truncate">"{img.adminCaption}"</p>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          {img.model === '__upload__' ? (
            <>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 leading-none">upload</span>
              {img.aspectRatio && <span className="text-[9px] text-slate-600">{img.aspectRatio}</span>}
              <span className="text-[9px] text-slate-700 ml-auto truncate max-w-[80px]">{((img.videoMetadata as any)?.originalFilename ?? '').slice(0, 20) || '—'}</span>
            </>
          ) : (
            <>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-500 leading-none">{img.model.replace('fal-ai/', '').slice(0, 16)}</span>
              {img.aspectRatio && <span className="text-[9px] text-slate-600">{img.aspectRatio}</span>}
              <span className="text-[9px] text-slate-700 ml-auto">{img.ticketCost}t</span>
            </>
          )}
        </div>
        <p className="text-[9px] text-slate-700 truncate">{img.user.email}</p>
      </div>
      )}
    </div>
  )
}, (prev, next) =>
  prev.selected      === next.selected      &&
  prev.selectMode    === next.selectMode    &&
  prev.img           === next.img           &&
  prev.index         === next.index         &&
  prev.onSelect      === next.onSelect      &&
  prev.onOpen        === next.onOpen        &&
  prev.onToggleMark  === next.onToggleMark  &&
  prev.layout        === next.layout        &&
  prev.showInfo      === next.showInfo
)

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DatasetPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [sessionChecked,  setSessionChecked]  = useState(false)
  // Inline unlock on the auth gate — sessionStorage is per-tab, so a fresh tab
  // has no stored password and the old static gate dead-ended the user
  const [gatePassword,  setGatePassword]  = useState("")
  const [gateVerifying, setGateVerifying] = useState(false)
  const [gateError,     setGateError]     = useState<string | null>(null)

  const handleGateUnlock = async () => {
    if (!gatePassword.trim() || gateVerifying) return
    setGateVerifying(true)
    setGateError(null)
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: gatePassword }),
      })
      if (res.ok) {
        try {
          sessionStorage.setItem('admin-password', gatePassword)
          localStorage.setItem('multiverse-admin-auth', 'true')
        } catch {}
        setGatePassword("")
        setIsAuthenticated(true) // data loads via the isAuthenticated-keyed effects
      } else {
        const data = await res.json().catch(() => null)
        setGateError(data?.error || 'Incorrect password')
      }
    } catch {
      setGateError('Verification failed — check your connection.')
    } finally {
      setGateVerifying(false)
    }
  }

  // Load persisted prefs once on mount
  const [_p] = useState(() => loadPrefs(PAGE_PREFS_KEY))

  // Data
  const [images,       setImages]       = useState<ImageRecord[]>([])
  const [pagination,   setPagination]   = useState<Pagination | null>(null)
  const [facets,       setFacets]       = useState<Facets | null>(null)
  const [overallStats, setOverallStats] = useState<{ marked: number; tagged: number; captioned: number } | null>(null)
  const [bucketStats,  setBucketStats]  = useState<{ marked: number; tagged: number; captioned: number; total: number } | null>(null)
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState("")

  // Modes & modals
  const [selectMode, setSelectMode] = useState(false)
  const [selected,   setSelected]   = useState<Set<number>>(new Set())
  const [detailImg,  setDetailImg]  = useState<ImageRecord | null>(null)
  const [bulkMode,   setBulkMode]   = useState<"tags" | "caption" | null>(null)
  const [autoFillOpen,    setAutoFillOpen]    = useState<boolean>(() => _p.autoFillOpen ?? false)
  const [addToBucketOpen, setAddToBucketOpen] = useState(false)
  const [hasRunningJob,   setHasRunningJob]   = useState(false)

  // Buckets
  const [buckets,          setBuckets]          = useState<Bucket[]>([])
  const [bucketFilter,     setBucketFilter]     = useState<string>(() => _p.bucketFilter ?? "")
  const [bucketMenuId,     setBucketMenuId]     = useState<number | null>(null)
  const [renamingId,       setRenamingId]       = useState<number | null>(null)
  const [uploadsBucketId,  setUploadsBucketId]  = useState<number | null>(null)
  const [uploadModalOpen,  setUploadModalOpen]  = useState(false)
  const [renameValue,   setRenameValue]   = useState("")
  const [folders,      setFolders]      = useState<BucketFolder[]>([])
  const [folderPath,   setFolderPath]   = useState<number[]>(() => _p.folderPath ?? [])
  const [folderMenuId, setFolderMenuId] = useState<number | null>(null)
  const [menuAnchor,   setMenuAnchor]   = useState<{ x: number; y: number } | null>(null)
  const activeFolderId = folderPath.length > 0 ? folderPath[folderPath.length - 1] : null

  // Filters
  const [search,       setSearch]       = useState<string>(() => _p.search       ?? "")
  const [models,       setModels]       = useState<string[]>(() => _p.models      ?? [])
  const [aspectRatios, setAspectRatios] = useState<string[]>(() => _p.aspectRatios ?? [])
  const [qualities,    setQualities]    = useState<string[]>(() => _p.qualities   ?? [])
  const [hasRefs,      setHasRefs]      = useState<string>(() => _p.hasRefs       ?? "")
  const [hasRating,    setHasRating]    = useState<string>(() => _p.hasRating     ?? "")
  const [hasCaption,   setHasCaption]   = useState<string>(() => _p.hasCaption    ?? "")
  const [hasTag,       setHasTag]       = useState<string>(() => _p.hasTag        ?? "")
  const [tagFilter,    setTagFilter]    = useState<string>(() => _p.tagFilter     ?? "")
  const [userFilters,  setUserFilters]  = useState<string[]>(() => _p.userFilters ?? [])
  // Exclude sorted work: values are "b:<bucketId>" or "f:<folderId>" (folder = whole subtree).
  // Generations already in any excluded bucket are hidden — leaving only what still needs sorting.
  const [excludeSel,   setExcludeSel]   = useState<string[]>(() => _p.excludeSel ?? [])
  const [mediaType,    setMediaType]    = useState<string>(() => _p.mediaType     ?? "")
  const [markedOnly,   setMarkedOnly]   = useState<boolean>(() => _p.markedOnly   ?? false)
  const [sort,         setSort]         = useState<string>(() => _p.sort          ?? "newest")
  const [pageSize,     setPageSize]     = useState<number>(() => {
    const saved = _p.pageSize ?? 12
    // iPad/mobile: cap at 12 to avoid iOS tab eviction from too many large images in GPU memory
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return Math.min(saved, 12)
    return saved
  })
  const [cols,         setCols]         = useState<number>(() => _p.cols           ?? 4)
  // Feed layout: grid (classic uniform squares) or masonry (natural aspect,
  // portal-style); the info footer under each tile is independently toggleable
  const [feedLayout,   setFeedLayout]   = useState<"grid" | "masonry">(() => _p.feedLayout === "masonry" ? "masonry" : "grid")
  // Masonry packing: "rows" (JS shortest-column, fills left-to-right, stable) or
  // "flow" (CSS columns, packs top-to-bottom down each column) — same as portal-v2
  const [feedMasonryMode, setFeedMasonryMode] = useState<"rows" | "flow">(() => _p.feedMasonryMode === "flow" ? "flow" : "rows")
  const [feedShowInfo, setFeedShowInfo] = useState<boolean>(() => _p.feedShowInfo ?? true)
  const [recentBucketIds, setRecentBucketIds] = useState<number[]>(() => _p.recentBucketIds ?? [])
  const [page,         setPage]         = useState<number>(() => _p.page          ?? 1)
  const [filtersOpen,  setFiltersOpen]  = useState<boolean>(() => _p.filtersOpen  ?? false)
  // Feed mode: generation records (default) or user reference libraries
  const [viewMode,     setViewMode]     = useState<"generation" | "reference">(() => _p.viewMode === "reference" ? "reference" : "generation")

  const searchTimer         = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Facets fetched once per session (global data, expensive queries)
  const facetsLoadedRef     = useRef(false)
  const isMountedRef        = useRef(false)
  const bucketStatsAbortRef = useRef<AbortController | null>(null)
  const fetchAbortRef       = useRef<AbortController | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState<string>(() => _p.search ?? "")

  const [bulkLoading,        setBulkLoading]        = useState(false)
  const [exportingBucketId,  setExportingBucketId]  = useState<number | null>(null)
  const [selectAllLoading,   setSelectAllLoading]   = useState(false)

  // ── Auth ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    setIsAuthenticated(localStorage.getItem("multiverse-admin-auth") === "true" && !!sessionStorage.getItem("admin-password"))
    setSessionChecked(true)
  }, [])

  // ── Prevent iOS Safari pull-to-refresh (causes full tab reload on iPad) ────────
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior
    document.body.style.overscrollBehavior = 'none'
    return () => { document.body.style.overscrollBehavior = prev }
  }, [])

  // ── Close bucket/folder menus on outside click ───────────────────────────────
  useEffect(() => {
    function close(e: MouseEvent) {
      if ((e.target as Element)?.closest?.('[data-menu-btn]')) return
      setBucketMenuId(null); setFolderMenuId(null); setMenuAnchor(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  function openBucketMenu(e: React.MouseEvent, id: number) {
    e.stopPropagation(); e.nativeEvent.stopImmediatePropagation()
    if (bucketMenuId === id) { setBucketMenuId(null); setMenuAnchor(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuAnchor({ x: Math.min(rect.left, window.innerWidth - 184), y: rect.bottom + 4 })
    setBucketMenuId(id); setFolderMenuId(null)
  }

  function openFolderMenu(e: React.MouseEvent, id: number) {
    e.stopPropagation(); e.nativeEvent.stopImmediatePropagation()
    if (folderMenuId === id) { setFolderMenuId(null); setMenuAnchor(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuAnchor({ x: Math.min(rect.left, window.innerWidth - 184), y: rect.bottom + 4 })
    setFolderMenuId(id); setBucketMenuId(null)
  }

  // ── Load buckets ─────────────────────────────────────────────────────────────
  const loadBuckets = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/buckets', { headers: authHeaders() })
      if (!res.ok) return
      let list: Bucket[] = await res.json()

      // Ensure the permanent Uploads bucket exists
      let uploadsBucket = list.find(b => b.name === UPLOADS_BUCKET_NAME)
      if (!uploadsBucket) {
        const cr = await fetch('/api/admin/buckets', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: UPLOADS_BUCKET_NAME, description: 'Admin-uploaded training images', color: '#7c3aed' }),
        })
        if (cr.ok) {
          const created = await cr.json()
          uploadsBucket = { ...created, count: 0 }
          list = [uploadsBucket!, ...list]
        }
      }

      if (uploadsBucket) setUploadsBucketId(uploadsBucket.id)
      // Always show uploads bucket first
      setBuckets([
        ...(uploadsBucket ? [uploadsBucket] : []),
        ...list.filter(b => b.name !== UPLOADS_BUCKET_NAME),
      ])
    } catch {}
  }, [])

  useEffect(() => { if (isAuthenticated) loadBuckets() }, [isAuthenticated, loadBuckets])

  // ── Load folders ─────────────────────────────────────────────────────────────
  const loadFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/folders', { headers: authHeaders() })
      if (!res.ok) return
      setFolders(await res.json())
    } catch {}
  }, [])

  useEffect(() => { if (isAuthenticated) loadFolders() }, [isAuthenticated, loadFolders])

  // ── Persist prefs to localStorage ───────────────────────────────────────────
  useEffect(() => {
    savePrefs(PAGE_PREFS_KEY, {
      search, models, aspectRatios, qualities, hasRefs, hasRating, hasCaption, hasTag,
      tagFilter, userFilters, excludeSel, mediaType, markedOnly, sort, pageSize, page,
      bucketFilter, filtersOpen, autoFillOpen, folderPath, cols, recentBucketIds, viewMode,
      feedLayout, feedMasonryMode, feedShowInfo,
    })
  }, [search, models, aspectRatios, qualities, hasRefs, hasRating, hasCaption, hasTag,
      tagFilter, userFilters, excludeSel, mediaType, markedOnly, sort, pageSize, page,
      bucketFilter, filtersOpen, autoFillOpen, folderPath, cols, recentBucketIds, viewMode,
      feedLayout, feedMasonryMode, feedShowInfo])

  // ── Search debounce ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const alreadyMounted = isMountedRef.current  // capture now; timer fires after mounted flag is set
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search)
      if (alreadyMounted) setPage(1)
    }, 400)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  // ── Reset page on filter change (skip on first mount) ────────────────────────
  const filterResetDeps = [models, aspectRatios, qualities, hasRefs, hasRating, hasCaption, hasTag, tagFilter, userFilters, excludeSel, mediaType, markedOnly, bucketFilter, sort, pageSize]
  useEffect(() => {
    if (isMountedRef.current) setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, filterResetDeps)

  // Set mounted flag AFTER filter reset effect so the first-run guard works correctly.
  // React runs effects in declaration order, so this fires after the effect above on mount.
  useEffect(() => { isMountedRef.current = true }, [])

  // ── Exit select mode when selection is cleared ───────────────────────────────
  useEffect(() => { if (selected.size === 0 && selectMode) { /* keep mode on intentionally */ } }, [selected])

  // Exclude sorted work: expand folder picks ("f:id") into every bucket in that
  // folder's subtree, union with direct bucket picks ("b:id"), append as repeated
  // excludeBucket params. Shared by the feed fetch and Select All so they agree.
  function appendExcludeParams(params: URLSearchParams) {
    if (excludeSel.length === 0) return
    const excludeBucketIds = new Set<number>()
    excludeSel.forEach(v => {
      if (v.startsWith('b:')) {
        const id = Number(v.slice(2))
        if (!isNaN(id)) excludeBucketIds.add(id)
      } else if (v.startsWith('f:')) {
        const folderId = Number(v.slice(2))
        if (isNaN(folderId)) return
        const subtree = getDescendantIds(folderId)
        buckets.forEach(b => { if (b.folderId != null && subtree.has(b.folderId)) excludeBucketIds.add(b.id) })
      }
    })
    excludeBucketIds.forEach(id => params.append('excludeBucket', String(id)))
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!isAuthenticated) return
    if (viewMode === "reference") return // Reference mode fetches via ReferencePanel

    // Cancel any in-flight request — prevents stale data from the first of a
    // double-fetch (e.g. filter change + filterResetDeps page-reset firing separately)
    fetchAbortRef.current?.abort()
    const ctrl = new AbortController()
    fetchAbortRef.current = ctrl

    setLoading(true); setError(""); setSelected(new Set())
    // Hung requests previously spun the loader forever — abort after 30s
    const timeoutId = setTimeout(() => ctrl.abort(), 30_000)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize), sort })
      // Facets are global + heavy — fetch once per session, not per click
      if (!facetsLoadedRef.current) params.set('facets', '1')
      models.forEach(m => params.append('model', m))
      aspectRatios.forEach(a => params.append('aspectRatio', a))
      qualities.forEach(q => params.append('quality', q))
      userFilters.forEach(u => params.append('userId', u))
      if (hasRefs)        params.set('hasRefs',   hasRefs)
      if (hasRating)      params.set('hasRating', hasRating)
      if (hasCaption)     params.set('hasCaption', hasCaption)
      if (hasTag)         params.set('hasTag',     hasTag)
      if (tagFilter)      params.set('tagFilter',  tagFilter)
      if (mediaType)      params.set('mediaType',  mediaType)
      if (bucketFilter)   params.set('bucketId',   bucketFilter)
      if (markedOnly)     params.set('markedOnly', 'true')
      if (debouncedSearch) params.set('search',    debouncedSearch)
      appendExcludeParams(params)
      const res  = await fetch(`/api/admin/dataset?${params}`, { headers: authHeaders(), signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setImages(data.images); setPagination(data.pagination)
      if (data.facets) { setFacets(data.facets); facetsLoadedRef.current = true }
      if (data.overallStats) setOverallStats(data.overallStats)
      setLoading(false)
    } catch (e: any) {
      // Superseded by a newer fetch → drop silently. Our own timeout abort →
      // surface it (the old swallow-all left the spinner stuck forever).
      if (ctrl.signal.aborted && fetchAbortRef.current !== ctrl) return
      setError(ctrl.signal.aborted ? 'Request timed out — change a filter or refresh to retry' : e.message)
      setLoading(false)
    } finally {
      clearTimeout(timeoutId)
    }
  }, [isAuthenticated, viewMode, page, pageSize, sort, models, aspectRatios, qualities, userFilters, excludeSel, buckets, folders, hasRefs, hasRating, hasCaption, hasTag, tagFilter, mediaType, bucketFilter, markedOnly, debouncedSearch])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Bucket stats — separate non-blocking fetch so it never delays image load ──
  useEffect(() => {
    if (!isAuthenticated || !bucketFilter) { setBucketStats(null); return }
    if (bucketStatsAbortRef.current) bucketStatsAbortRef.current.abort()
    const ctrl = new AbortController()
    bucketStatsAbortRef.current = ctrl
    const params = new URLSearchParams({ statsOnly: 'true', bucketId: bucketFilter })
    fetch(`/api/admin/dataset?${params}`, { headers: authHeaders(), signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.bucketStats) setBucketStats(data.bucketStats) })
      .catch(() => {})
    return () => ctrl.abort()
  }, [isAuthenticated, bucketFilter])

  // ── Patch helper ─────────────────────────────────────────────────────────────
  async function patch(body: object) {
    const res = await fetch('/api/admin/dataset', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  // ── Toggle training mark ──────────────────────────────────────────────────────
  async function toggleMark(ids: number[], marked: boolean) {
    setBulkLoading(true)
    try {
      await patch({ ids, marked })
      setImages(prev => prev.map(img => ids.includes(img.id) ? { ...img, markedForTraining: marked } : img))
      setSelected(new Set())
    } catch (e: any) { alert(`Failed: ${e.message}`) }
    finally { setBulkLoading(false) }
  }

  // Stable ref for per-card mark toggle — avoids breaking ImageCard memo
  const handleCardToggleMark = useCallback((id: number, current: boolean) => {
    const doToggle = async () => {
      try {
        const marked = !current
        await fetch('/api/admin/dataset', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body:    JSON.stringify({ ids: [id], marked }),
        })
        setImages(prev => prev.map(img => img.id === id ? { ...img, markedForTraining: marked } : img))
      } catch {}
    }
    doToggle()
  }, [])

  // ── Save from detail modal ────────────────────────────────────────────────────
  async function saveDetail(id: number, tags: string[], caption: string | null, marked: boolean) {
    await patch({ ids: [id], tags, caption, marked })
    setImages(prev => prev.map(img =>
      img.id === id ? { ...img, adminTags: tags, adminCaption: caption, markedForTraining: marked } : img
    ))
    if (detailImg?.id === id) setDetailImg(prev => prev ? { ...prev, adminTags: tags, adminCaption: caption, markedForTraining: marked } : prev)
  }

  // ── Bulk tag / caption ────────────────────────────────────────────────────────
  async function applyBulk(data: { addTags?: string[]; caption?: string }) {
    const ids = Array.from(selected)
    setBulkLoading(true)
    try {
      await patch({ ids, ...data })
      setImages(prev => prev.map(img => {
        if (!ids.includes(img.id)) return img
        let next = { ...img }
        if (data.addTags)            next.adminTags    = [...new Set([...img.adminTags, ...data.addTags])]
        if (data.caption !== undefined) next.adminCaption = data.caption || null
        return next
      }))
      setSelected(new Set())
    } catch (e: any) { alert(`Failed: ${e.message}`) }
    finally { setBulkLoading(false) }
  }

  // ── Selection helpers ────────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: number) => {
    if (loading) return
    setSelected(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
    })
  }, [loading])

  function selectAll() { setSelected(new Set(images.map(i => i.id))) }

  async function selectAllRecords() {
    setSelectAllLoading(true)
    try {
      const params = new URLSearchParams({ idsOnly: "true", sort })
      models.forEach(m => params.append('model', m))
      aspectRatios.forEach(a => params.append('aspectRatio', a))
      qualities.forEach(q => params.append('quality', q))
      userFilters.forEach(u => params.append('userId', u))
      if (hasRefs)        params.set('hasRefs',   hasRefs)
      if (hasRating)      params.set('hasRating', hasRating)
      if (hasCaption)     params.set('hasCaption', hasCaption)
      if (hasTag)         params.set('hasTag',     hasTag)
      if (tagFilter)      params.set('tagFilter',  tagFilter)
      if (mediaType)      params.set('mediaType',  mediaType)
      if (bucketFilter)   params.set('bucketId',   bucketFilter)
      if (markedOnly)     params.set('markedOnly', 'true')
      if (debouncedSearch) params.set('search',    debouncedSearch)
      appendExcludeParams(params)
      const res  = await fetch(`/api/admin/dataset?${params}`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { ids } = await res.json()
      setSelected(new Set(ids as number[]))
    } catch (e: any) { alert(`Failed: ${e.message}`) }
    finally { setSelectAllLoading(false) }
  }

  // ── Export selected → client-side JSON ──────────────────────────────────────
  function handleExport() {
    if (selected.size === 0) return
    const selectedImages = images.filter(img => selected.has(img.id))
    const payload = selectedImages.map(img => ({
      id:                img.id,
      prompt:            img.prompt,
      imageUrl:          img.imageUrl,
      model:             img.model,
      quality:           img.quality,
      aspectRatio:       img.aspectRatio,
      ticketCost:        img.ticketCost,
      markedForTraining: img.markedForTraining,
      adminTags:         img.adminTags,
      adminCaption:      img.adminCaption,
      createdAt:         img.createdAt,
    }))
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `selected-dataset-${new Date().toISOString().slice(0, 10)}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  // ── Export bucket → zip ───────────────────────────────────────────────────
  async function exportBucket(b: { id: number; name: string }) {
    setExportingBucketId(b.id)
    try {
      const res = await fetch(`/api/admin/buckets/${b.id}/export`, { headers: authHeaders() })
      if (!res.ok) { alert(`Export failed: ${await res.text()}`); return }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = `${b.name.replace(/[^a-z0-9-_]/gi, '_')}-dataset.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) { alert(`Export error: ${e.message}`) }
    finally { setExportingBucketId(null) }
  }

  // ── Bucket helpers ────────────────────────────────────────────────────────────
  async function removeFromBucket(bucketId: number) {
    const ids = Array.from(selected)
    const res = await fetch(`/api/admin/buckets/${bucketId}/images`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ imageIds: ids }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await loadBuckets()
    setSelected(new Set())
    // Remove the images from local state so the grid updates immediately
    setImages(prev => prev.filter(img => !ids.includes(img.id)))
  }

  async function addToBucket(bucketId: number) {
    const ids = Array.from(selected)
    const res = await fetch(`/api/admin/buckets/${bucketId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ imageIds: ids }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setRecentBucketIds(prev => [bucketId, ...prev.filter(id => id !== bucketId)].slice(0, 20))
    await loadBuckets()
    setSelected(new Set())
  }

  async function createAndAddToBucket(name: string) {
    const createRes = await fetch('/api/admin/buckets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    })
    if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`)
    const bucket: Bucket = await createRes.json()
    await addToBucket(bucket.id)
    await loadBuckets()
  }

  async function deleteBucket(id: number) {
    if (!confirm('Delete this bucket? Images are not deleted.')) return
    await fetch(`/api/admin/buckets/${id}`, { method: 'DELETE', headers: authHeaders() })
    if (bucketFilter === String(id)) setBucketFilter("")
    await loadBuckets()
    setBucketMenuId(null)
  }

  async function renameBucket(id: number) {
    if (!renameValue.trim()) return
    await fetch(`/api/admin/buckets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: renameValue.trim() }),
    })
    setRenamingId(null)
    setRenameValue("")
    await loadBuckets()
  }

  async function createBucket(folderId?: number | null) {
    const name = prompt('Bucket name:')?.trim()
    if (!name) return
    const res = await fetch('/api/admin/buckets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, folderId: folderId ?? null }),
    })
    if (res.ok) await loadBuckets()
  }

  async function createFolder(parentId: number | null = null) {
    const name = prompt('Folder name:')?.trim()
    if (!name) return
    const res = await fetch('/api/admin/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, parentId }),
    })
    if (res.ok) await loadFolders()
  }

  async function renameFolder(id: number) {
    const folder = folders.find(f => f.id === id)
    const name = prompt('New folder name:', folder?.name ?? '')?.trim()
    if (!name) return
    await fetch(`/api/admin/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    })
    await loadFolders()
  }

  async function deleteFolder(id: number) {
    if (!confirm('Delete this folder? Buckets inside will be ungrouped, sub-folders will move to root.')) return
    await fetch(`/api/admin/folders/${id}`, { method: 'DELETE', headers: authHeaders() })
    setFolderPath(prev => { const idx = prev.indexOf(id); return idx === -1 ? prev : prev.slice(0, idx) })
    await Promise.all([loadFolders(), loadBuckets()])
  }

  async function moveFolderTo(folderId: number, parentId: number | null) {
    await fetch(`/api/admin/folders/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ parentId }),
    })
    setFolderMenuId(null)
    await loadFolders()
  }

  function getDescendantIds(folderId: number): Set<number> {
    const result = new Set<number>([folderId])
    const queue = [folderId]
    while (queue.length > 0) {
      const id = queue.shift()!
      folders.filter(f => (f.parentId ?? null) === id).forEach(f => { result.add(f.id); queue.push(f.id) })
    }
    return result
  }

  async function moveBucketToFolder(bucketId: number, folderId: number | null) {
    await fetch(`/api/admin/buckets/${bucketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ folderId }),
    })
    setBucketMenuId(null)
    await loadBuckets()
  }

  // ── Deferred image list — keeps UI responsive while grid re-renders ───────────
  const deferredImages = useDeferredValue(images)

  // ── Derived values (all useMemo MUST be before any early return) ─────────────
  const selectedArr      = useMemo(() => Array.from(selected), [selected])
  const imageMarkedById  = useMemo(() => {
    const m: Record<number, boolean> = {}
    images.forEach(i => { m[i.id] = i.markedForTraining })
    return m
  }, [images])
  const allPageMarked    = useMemo(
    () => selectedArr.length > 0 && selectedArr.every(id => imageMarkedById[id]),
    [selectedArr, imageMarkedById]
  )
  const tagSuggestions   = useMemo(() => facets?.tags.map(t => t.value) ?? [], [facets?.tags])
  const hasActiveFilters = useMemo(
    () => !!(models.length || aspectRatios.length || qualities.length || hasRefs || hasRating || hasCaption || hasTag || tagFilter || userFilters.length || excludeSel.length || mediaType || bucketFilter || markedOnly || search),
    [models, aspectRatios, qualities, hasRefs, hasRating, hasCaption, hasTag, tagFilter, userFilters, excludeSel, mediaType, bucketFilter, markedOnly, search]
  )
const modelOptions      = useMemo(() => (facets?.models    ?? []).map(m => ({ value: m.value,       label: `${m.value.replace('fal-ai/', '')} (${m.count})` })), [facets?.models])
  const aspectOptions     = useMemo(() => (facets?.aspects   ?? []).map(a => ({ value: a.value ?? '', label: `${a.value} (${a.count})` })),                          [facets?.aspects])
  const qualityOptions    = useMemo(() => (facets?.qualities ?? []).map(q => ({ value: q.value ?? '', label: `${q.value} (${q.count})` })),                          [facets?.qualities])
  const userOptions       = useMemo(() => (facets?.users     ?? []).map(u => ({ value: String(u.id), label: `${u.name ? `${u.name} · ` : ''}${u.email} (${u.count})` })), [facets?.users])
  // Exclude picker: folders first (exclude the whole subtree), then individual buckets
  // labeled with their parent folder for context
  const excludeOptions    = useMemo(() => {
    const folderName = new Map(folders.map(f => [f.id, f.name]))
    const folderOpts = folders.map(f => {
      const subtree = getDescendantIds(f.id)
      const bucketCount = buckets.filter(b => b.folderId != null && subtree.has(b.folderId)).length
      return { value: `f:${f.id}`, label: `📁 ${f.name} — whole tree (${bucketCount} bucket${bucketCount === 1 ? '' : 's'})` }
    })
    const bucketOpts = buckets.map(b => ({
      value: `b:${b.id}`,
      label: b.folderId != null && folderName.has(b.folderId) ? `${folderName.get(b.folderId)} / ${b.name}` : b.name,
    }))
    return [...folderOpts, ...bucketOpts]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, buckets])
  const sortOptions       = useMemo(() => [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }, { value: "rating", label: "Highest rated" }, { value: "cost", label: "Highest cost" }], [])
  const mediaTypeOptions  = useMemo(() => [{ value: "", label: "Images & videos" }, { value: "image", label: "Images only" }, { value: "video", label: "Videos only" }], [])
  const hasRefsOptions    = useMemo(() => [{ value: "", label: "Refs: any" }, { value: "true", label: "Has refs" }, { value: "false", label: "No refs" }, { value: "1", label: "1 ref" }, { value: "2", label: "2 refs" }, { value: "3", label: "3 refs" }, { value: "4+", label: "4+ refs" }], [])
  const hasRatingOptions  = useMemo(() => [{ value: "", label: "Rating: any" },  { value: "true", label: "Has rating" },  { value: "false", label: "Not rated" }],  [])
  const hasCaptionOptions = useMemo(() => [{ value: "", label: "Caption: any" }, { value: "true", label: "Has caption" }, { value: "false", label: "No caption" }], [])
  const hasTagOptions     = useMemo(() => [{ value: "", label: "Tags: any" },    { value: "true", label: "Has tags" },    { value: "false", label: "No tags" }],    [])
  const tagFilterOptions  = useMemo(() => [{ value: "", label: "Filter by tag…" }, ...(facets?.tags ?? []).map(t => ({ value: t.value, label: `#${t.value} (${t.count})` }))], [facets?.tags])
  const autoFillImageUrlById = useMemo(
    () => Object.fromEntries(images.map(img => [img.id, (img.videoMetadata as any)?.thumbnailUrl || img.imageUrl])),
    [images]
  )

  // ── Auth gate (after all hooks) ───────────────────────────────────────────────
  if (!sessionChecked) return (
    <div className="min-h-screen bg-[#05080f] flex items-center justify-center">
      <Loader2 size={20} className="text-slate-600 animate-spin" />
    </div>
  )
  if (!isAuthenticated) return (
    <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
        <div className="w-10 h-10 mx-auto mb-3 rounded-xl bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center">
          <Database size={16} className="text-cyan-400" />
        </div>
        <p className="text-white font-semibold mb-1">Admin access required</p>
        <p className="text-[11px] text-slate-500 mb-4 leading-relaxed">
          Enter the admin password to unlock this tab. (Each browser tab needs it once.)
        </p>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleGateUnlock() }}>
          <input
            type="password"
            autoFocus
            value={gatePassword}
            onChange={e => setGatePassword(e.target.value)}
            placeholder="Admin password"
            className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
          />
          <button
            type="submit"
            disabled={!gatePassword.trim() || gateVerifying}
            className="px-3.5 py-2 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-sm font-medium hover:bg-cyan-500/25 disabled:opacity-40 transition-all"
          >
            {gateVerifying ? <Loader2 size={14} className="animate-spin" /> : "Unlock"}
          </button>
        </form>
        {gateError && <p className="text-[11px] text-rose-400 mt-2.5">{gateError}</p>}
        <button onClick={() => window.location.href = '/admin'}
          className="mt-4 text-[11px] text-slate-600 hover:text-slate-400 transition-colors">
          Go to Admin panel instead →
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#05080f] text-white flex w-full">

      {/* ── Menu backdrop — closes any open context menu on tap/click outside ── */}
      {(bucketMenuId !== null || folderMenuId !== null) && (
        <div className="fixed inset-0 z-40" onClick={() => { setBucketMenuId(null); setFolderMenuId(null); setMenuAnchor(null) }} />
      )}

      {/* ── Auto Fill side panel (desktop) / bottom sheet (mobile) ── */}
      {autoFillOpen && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-40 sm:hidden"
            onClick={() => setAutoFillOpen(false)}
          />
          <aside className={[
            // shared
            "bg-[#0a0a15] flex flex-col z-50",
            // mobile: fixed bottom sheet
            "fixed inset-x-0 bottom-0 h-[88vh] rounded-t-2xl border-t border-white/[0.1] sm:rounded-none sm:border-t-0",
            // desktop: sticky sidebar
            "sm:relative sm:w-[340px] sm:shrink-0 sm:h-screen sm:sticky sm:top-0 sm:border-r sm:border-white/[0.06]",
          ].join(" ")}>
            {/* Mobile drag handle */}
            <div className="sm:hidden flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>
            <AutoFillPanel
              selected={selected}
              imageUrlById={autoFillImageUrlById}
              onClose={() => setAutoFillOpen(false)}
              onJobChange={setHasRunningJob}
              onItemSaved={(id, data) => {
                setImages(prev => prev.map(img => {
                  if (img.id !== id) return img
                  return {
                    ...img,
                    ...(data.caption !== undefined && { adminCaption: data.caption }),
                    ...(data.tags    !== undefined && { adminTags:    data.tags    }),
                  }
                }))
              }}
            />
          </aside>
        </>
      )}

      {/* ── Main content column ── */}
      <div className={`flex flex-col w-full min-w-0 min-h-screen ${autoFillOpen ? 'sm:h-screen sm:overflow-y-auto' : ''}`}>

      {/* Modals */}
      {uploadModalOpen && uploadsBucketId && (
        <UploadModal
          bucketId={uploadsBucketId}
          suggestions={tagSuggestions}
          onClose={() => setUploadModalOpen(false)}
          onUploaded={() => { loadBuckets(); fetchData() }}
        />
      )}
      {detailImg && (
        <DetailModal
          img={detailImg}
          suggestions={tagSuggestions}
          onClose={() => setDetailImg(null)}
          onSave={saveDetail}
        />
      )}
      {bulkMode && (
        <BulkModal
          mode={bulkMode}
          count={selected.size}
          suggestions={tagSuggestions}
          onClose={() => setBulkMode(null)}
          onApply={applyBulk}
        />
      )}
      {addToBucketOpen && (
        <AddToBucketModal
          count={selected.size}
          buckets={buckets}
          folders={folders}
          recentBucketIds={recentBucketIds}
          onClose={() => setAddToBucketOpen(false)}
          onAdd={addToBucket}
          onCreateAndAdd={createAndAddToBucket}
        />
      )}

      {/* ── Header — site design: synced logo, gradient title, silver chrome ── */}
      <div className="sticky top-0 z-30 w-full bg-[#070b14]/90 backdrop-blur border-b border-white/[0.08]">

        {/* ONE merged taskbar row: back · logo+title · scrollable actions · stats · refresh */}
        <div className="px-3 py-2 flex items-center gap-2.5">
          <button onClick={() => window.location.href = '/admin'}
            title="Back to Admin"
            className="shrink-0 p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          {/* Direct jump to the portal — skips the extra hop through /admin */}
          <button onClick={() => window.location.href = '/admin/portal-v2'}
            title="Back to Portal"
            className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white transition-colors">
            <ArrowLeft size={12} />
            <span className="text-[10px] font-semibold leading-none">Portal</span>
          </button>
          <div className="flex items-center gap-2.5 min-w-0 shrink-0">
            <SiteLogoBox size={28} rounded={9} />
            <div className="min-w-0">
              <h1 className="text-sm font-black tracking-tight leading-none text-transparent bg-clip-text bg-gradient-to-r from-white via-white/85 to-white/55">Dataset</h1>
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-600 leading-none mt-1 truncate">
                {pagination ? `${pagination.total.toLocaleString()} records` : "Loading…"}
              </p>
            </div>
          </div>

          {/* Actions — scrollable segment between the title and the stats */}
          <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-hide px-1">
          {/* Feed mode: generation records vs user reference libraries */}
          <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden shrink-0">
            <button onClick={() => setViewMode("generation")}
              className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${viewMode === "generation" ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>
              Generation
            </button>
            <button onClick={() => setViewMode("reference")}
              className={`px-2.5 py-1.5 text-[11px] font-medium border-l border-white/[0.08] transition-colors ${viewMode === "reference" ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>
              Reference
            </button>
          </div>
          {/* Feed settings — columns, page size + all filters live in the popup */}
          <button onClick={() => setFiltersOpen(v => !v)}
            className={`relative shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium overflow-hidden transition-all
              ${filtersOpen || hasActiveFilters ? "bg-white/[0.12] border-white/30 text-white" : "bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white"}`}>
            {(filtersOpen || hasActiveFilters) && (
              <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/[0.15] to-transparent pointer-events-none" style={{ animation: 'sheen-sweep 2.6s infinite' }} />
            )}
            <SlidersHorizontal size={11} /> Feed{hasActiveFilters ? " •" : ""}
          </button>
          {viewMode === "generation" && (
            <>
              <button onClick={() => { setSelectMode(v => !v); setSelected(new Set()) }}
                className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                  ${selectMode ? "bg-white/[0.12] border-white/30 text-white" : "bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white"}`}>
                {selectMode ? <><CheckSquare size={11} /> Selecting</> : <><MousePointer2 size={11} /> Select</>}
              </button>
              <button onClick={() => setAutoFillOpen(v => !v)}
                className={`relative shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                  ${autoFillOpen || hasRunningJob ? 'bg-white/[0.12] border-white/30 text-white' : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white'}`}>
                <Sparkles size={11} /> Auto Fill
                {hasRunningJob && !autoFillOpen && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                )}
              </button>
              {uploadsBucketId && (
                <button onClick={() => { setUploadModalOpen(true); setBucketFilter(String(uploadsBucketId)) }}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08] text-slate-400 text-[11px] hover:text-white hover:border-white/20 transition-all">
                  <UploadCloud size={11} /> Upload
                </button>
              )}
              <button onClick={handleExport} disabled={selected.size === 0}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] hover:bg-emerald-500/15 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                <Download size={11} /> Export{selected.size > 0 ? ` (${selected.size})` : ""}
              </button>
            </>
          )}
          </div>{/* end scrollable actions */}

          {overallStats && (
            <div className="hidden md:flex shrink-0 items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[11px]">
              <span className="text-[9px] text-slate-600 font-mono uppercase tracking-wider">overall</span>
              <span className="text-emerald-400/80">{overallStats.marked.toLocaleString()} marked</span>
              <span className="text-slate-300">{overallStats.tagged.toLocaleString()} tagged</span>
              <span className="text-slate-400">{overallStats.captioned.toLocaleString()} captioned</span>
            </div>
          )}
          <button onClick={fetchData} className="shrink-0 p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white transition-colors">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Feed settings popup — columns, page size + all filters (portal-style) */}
        {filtersOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setFiltersOpen(false)} />
            <div className="absolute inset-x-2 top-full mt-1.5 z-50">
              <div className="relative isolate max-w-3xl mx-auto rounded-2xl border border-white/[0.08] bg-[#070b14]/95 backdrop-blur-md shadow-2xl p-4 space-y-3">
                {/* Animated silver rim */}
                <div
                  className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none"
                  style={{
                    padding: '1.5px',
                    WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                    WebkitMaskComposite: 'xor',
                    mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                    maskComposite: 'exclude',
                  } as React.CSSProperties}
                >
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 aspect-square w-[300%] animate-spin" style={{ background: SILVER_RIM_CONIC, animationDuration: '5s' }} />
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-slate-400">Feed Settings</p>
                  <button onClick={() => setFiltersOpen(false)} className="text-slate-500 hover:text-white transition-colors"><X size={13} /></button>
                </div>
                {/* Columns */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 w-16 shrink-0">Columns</span>
                  <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <button key={n} onClick={() => setCols(n)}
                        className={`px-2.5 py-1.5 text-[11px] transition-colors ${cols === n ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{n}</button>
                    ))}
                  </div>
                </div>
                {/* Page size */}
                {viewMode === "generation" && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 w-16 shrink-0">Per page</span>
                    {/* Multiples of 12 → full rows at both 4 and 6 columns. 240/480 are
                        heavy (amber, portal convention) — lots of thumbs at once. */}
                    <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
                      {[12, 24, 48, 120, 240, 480].map(n => {
                        const heavy = n >= 240
                        return (
                          <button key={n} onClick={() => setPageSize(n)}
                            className={`px-2.5 py-1.5 text-[11px] transition-colors ${
                              pageSize === n
                                ? heavy ? 'bg-amber-500/20 text-amber-300' : 'bg-white/[0.12] text-white'
                                : heavy ? 'text-amber-600/70 hover:text-amber-300' : 'text-slate-500 hover:text-white'}`}>{n}</button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {/* Layout — classic grid vs portal-style masonry */}
                {viewMode === "generation" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 w-16 shrink-0">Layout</span>
                    <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
                      {(["grid", "masonry"] as const).map(l => (
                        <button key={l} onClick={() => setFeedLayout(l)}
                          className={`px-2.5 py-1.5 text-[11px] capitalize transition-colors ${feedLayout === l ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{l}</button>
                      ))}
                    </div>
                    {feedLayout === "masonry" && (
                      <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
                        {(["rows", "flow"] as const).map(m => (
                          <button key={m} onClick={() => setFeedMasonryMode(m)}
                            title={m === "rows" ? "Fills left-to-right, tiles never jump" : "CSS columns — packs top-to-bottom"}
                            className={`px-2.5 py-1.5 text-[11px] capitalize transition-colors ${feedMasonryMode === m ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{m}</button>
                        ))}
                      </div>
                    )}
                    <button onClick={() => setFeedShowInfo(v => !v)}
                      className={`px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors ${feedShowInfo ? 'bg-white/[0.12] border-white/30 text-white' : 'bg-white/[0.03] border-white/[0.08] text-slate-500 hover:text-white'}`}>
                      Caption &amp; info
                    </button>
                  </div>
                )}
                {viewMode === "generation" && (<div className="border-t border-white/[0.06] pt-3 space-y-2.5">
                <p className="text-[9px] font-mono uppercase tracking-wider text-slate-600">Filters</p>
            {/* Row 1 */}
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative w-full sm:w-52">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search prompts…"
                  className="w-full pl-7 pr-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40" />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                    <X size={10} className="text-slate-500" />
                  </button>
                )}
              </div>
              <MultiFilterSelect values={models}       onChange={setModels}       placeholder="Model: any"   options={modelOptions} />
              <MultiFilterSelect values={aspectRatios} onChange={setAspectRatios} placeholder="Aspect: any"  options={aspectOptions} />
              <MultiFilterSelect values={qualities}    onChange={setQualities}    placeholder="Quality: any" options={qualityOptions} />
              <FilterSelect value={sort}      onChange={setSort}      options={sortOptions} />
              <FilterSelect value={mediaType} onChange={setMediaType} options={mediaTypeOptions} />
            </div>
            {/* Row 2 */}
            <div className="flex flex-wrap gap-2 items-center">
              <FilterSelect value={hasRefs}    onChange={setHasRefs}    options={hasRefsOptions} />
              <FilterSelect value={hasRating}  onChange={setHasRating}  options={hasRatingOptions} />
              <FilterSelect value={hasCaption} onChange={setHasCaption} options={hasCaptionOptions} />
              <FilterSelect value={hasTag}     onChange={setHasTag}     options={hasTagOptions} />
              {(facets?.tags.length ?? 0) > 0 && (
                <FilterSelect value={tagFilter} onChange={setTagFilter} options={tagFilterOptions} />
              )}
              {userOptions.length > 0 && (
                <MultiFilterSelect values={userFilters} onChange={setUserFilters} placeholder="User: any" searchable options={userOptions} />
              )}
              {excludeOptions.length > 0 && (
                <MultiFilterSelect values={excludeSel} onChange={setExcludeSel} placeholder="Exclude: none" searchable options={excludeOptions} />
              )}
              <button onClick={() => setMarkedOnly(v => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all
                  ${markedOnly ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-white/[0.05] border-white/[0.08] text-slate-400 hover:text-white"}`}>
                <BookMarked size={11} /> Training only
              </button>
              {hasActiveFilters && (
                <button onClick={() => { setModels([]); setAspectRatios([]); setQualities([]); setHasRefs(""); setHasRating(""); setHasCaption(""); setHasTag(""); setTagFilter(""); setUserFilters([]); setExcludeSel([]); setMediaType(""); setBucketFilter(""); setMarkedOnly(false); setSearch("") }}
                  className="text-[11px] text-slate-600 hover:text-slate-400 transition-colors">
                  Clear all
                </button>
              )}
            </div>
                </div>)}
              </div>
            </div>
          </>
        )}

        {/* Bulk action bar — only in select mode */}
        {selectMode && selected.size > 0 && (
          <div className="border-t border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2">
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
            <span className="text-xs text-cyan-300 font-medium shrink-0 pr-1">{selected.size} selected</span>
              <button onClick={selectAll} className="shrink-0 text-[11px] text-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap">
                Page
              </button>
              <button onClick={selectAllRecords} disabled={selectAllLoading}
                className="shrink-0 flex items-center gap-1 text-[11px] text-cyan-500/70 hover:text-cyan-300 transition-colors disabled:opacity-50 whitespace-nowrap">
                {selectAllLoading
                  ? <><Loader2 size={10} className="animate-spin" /> Selecting…</>
                  : <>All {pagination ? pagination.total.toLocaleString() : ""}</>
                }
              </button>
              <button onClick={() => setAddToBucketOpen(true)}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[11px] hover:bg-violet-500/15 transition-all whitespace-nowrap">
                <FolderOpen size={11} /> Bucket
              </button>
              {bucketFilter && (
                <button onClick={() => removeFromBucket(parseInt(bucketFilter))} disabled={bulkLoading}
                  className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] hover:bg-red-500/15 transition-all disabled:opacity-50 whitespace-nowrap">
                  <FolderOpen size={11} /> Remove
                </button>
              )}
              <button onClick={() => setAutoFillOpen(true)}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500/10 to-violet-500/10 border border-cyan-500/20 text-[11px] text-white/80 hover:text-white transition-all whitespace-nowrap">
                <Sparkles size={11} /> Auto Fill
              </button>
              <button onClick={() => setBulkMode("tags")} disabled={bulkLoading}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[11px] hover:bg-cyan-500/15 transition-all disabled:opacity-50 whitespace-nowrap">
                <Tag size={11} /> Tags
              </button>
              <button onClick={() => setBulkMode("caption")} disabled={bulkLoading}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[11px] hover:bg-violet-500/15 transition-all disabled:opacity-50 whitespace-nowrap">
                <MessageSquare size={11} /> Caption
              </button>
              <button onClick={() => toggleMark(selectedArr, !allPageMarked)} disabled={bulkLoading}
                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] hover:bg-emerald-500/15 transition-all disabled:opacity-50 whitespace-nowrap">
                {bulkLoading ? <Loader2 size={11} className="animate-spin" /> : <BookMarked size={11} />}
                {allPageMarked ? "Unmark" : "Mark"}
              </button>
              <button onClick={() => setSelected(new Set())}
                className="shrink-0 p-1 rounded hover:bg-white/[0.06] text-slate-600 hover:text-slate-400 transition-colors">
                <X size={13} />
              </button>
            </div>
          </div>
        )}
      </div>{/* end sticky header */}

      {/* Body */}
      <div className="w-full max-w-7xl mx-auto px-3 py-4">

        {/* Reference mode: user reference libraries (account refs incl. cleared) */}
        {viewMode === "reference" && (
          <ReferencePanel authHeaders={authHeaders} cols={cols} />
        )}

        {viewMode === "generation" && (<>
        {/* ── Bucket bar ── */}
        {(buckets.length > 0 || folders.length > 0) && (
          <div className="mb-3 flex items-end gap-2 overflow-x-auto pb-2 scrollbar-hide">

            {/* All buckets card */}
            <div
              onClick={() => { setBucketFilter(""); setFolderPath([]) }}
              className="relative shrink-0 w-[76px] cursor-pointer"
            >
              <div className={`w-full h-[52px] rounded-t-lg flex items-center justify-center border-t border-l border-r transition-colors
                ${!bucketFilter && folderPath.length === 0
                  ? 'bg-violet-500/10 border-violet-500/40'
                  : 'bg-white/[0.03] border-white/[0.08] hover:border-white/15'}`}>
                <Database size={20} className={!bucketFilter && folderPath.length === 0 ? 'text-violet-400' : 'text-slate-600'} />
              </div>
              <div className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r transition-colors
                ${!bucketFilter && folderPath.length === 0
                  ? 'bg-violet-500/15 border-violet-500/40'
                  : 'bg-white/[0.03] border-white/[0.08]'}`}>
                <p className={`text-[9px] truncate leading-tight font-medium
                  ${!bucketFilter && folderPath.length === 0 ? 'text-violet-300' : 'text-slate-500'}`}>
                  All
                </p>
              </div>
            </div>

            {/* Uploads bucket card */}
            {buckets.filter(b => b.name === UPLOADS_BUCKET_NAME).map(b => {
              const addMode = selectMode && selected.size > 0
              return (
              <div key={b.id} className="relative shrink-0 w-[76px] group">
                <div
                  onClick={() => addMode ? addToBucket(b.id) : (setBucketFilter(v => v === String(b.id) ? "" : String(b.id)), setFolderPath([]))}
                  className={`w-full h-[52px] rounded-t-lg overflow-hidden relative border-t border-l border-r cursor-pointer transition-colors
                    ${addMode ? 'border-emerald-500/40 hover:border-emerald-500/70' : bucketFilter === String(b.id) ? 'border-violet-500/50' : 'border-violet-500/20 hover:border-violet-500/40'}`}
                >
                  <div className={`w-full h-full flex items-center justify-center
                    ${addMode ? 'bg-emerald-500/10' : bucketFilter === String(b.id) ? 'bg-violet-600/20' : 'bg-violet-500/8'}`}>
                    <UploadCloud size={18} className={addMode ? 'text-emerald-500' : 'text-violet-500'} />
                  </div>
                  {b.previewUrls[0] && (
                    <img src={b.previewUrls[0]} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  )}
                  {addMode ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/20 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Plus size={16} className="text-emerald-300" />
                    </div>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); setUploadModalOpen(true); setBucketFilter(String(b.id)) }}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Upload"
                    >
                      <Plus size={9} className="text-violet-300" />
                    </button>
                  )}
                </div>
                <div
                  onClick={() => addMode ? addToBucket(b.id) : (setBucketFilter(v => v === String(b.id) ? "" : String(b.id)), setFolderPath([]))}
                  className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r cursor-pointer transition-colors
                    ${addMode ? 'bg-emerald-500/8 border-emerald-500/30' : bucketFilter === String(b.id) ? 'bg-violet-600/20 border-violet-500/50' : 'bg-violet-500/5 border-violet-500/15'}`}
                >
                  <p className={`text-[9px] truncate leading-tight
                    ${addMode ? 'text-emerald-400' : bucketFilter === String(b.id) ? 'text-violet-300' : 'text-violet-400'}`}>
                    Uploads
                  </p>
                  <p className="text-[8px] text-slate-600">{b.count}</p>
                </div>
              </div>
            )})}

            {/* Top-level folder cards */}
            {folders.filter(f => !f.parentId).map(folder => {
              const isActive = folderPath[0] === folder.id
              const descendants = getDescendantIds(folder.id)
              const totalBuckets = buckets.filter(b => b.folderId !== null && descendants.has(b.folderId)).length
              const movableTargets = folders.filter(f => !f.parentId && f.id !== folder.id)
              return (
                <div key={folder.id} className="relative shrink-0 w-[76px] group">
                  <div
                    onClick={() => setFolderPath(isActive ? [] : [folder.id])}
                    className={`w-full h-[52px] rounded-t-lg overflow-hidden relative border-t border-l border-r cursor-pointer transition-colors
                      ${isActive ? 'border-amber-500/50' : 'border-white/[0.08] hover:border-white/15'}`}
                  >
                    <div className="grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-black/30">
                      {[0,1,2,3].map(i => (
                        <div key={i} className="overflow-hidden bg-white/[0.02] relative">
                          {folder.previewUrls?.[i] && (
                            <img src={folder.previewUrls[i]} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); openFolderMenu(e, folder.id) }}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
                      data-menu-btn
                    >
                      <MoreHorizontal size={9} className="text-white" />
                    </button>
                  </div>
                  <div
                    onClick={() => setFolderPath(isActive ? [] : [folder.id])}
                    className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r cursor-pointer transition-colors
                      ${isActive ? 'bg-amber-500/15 border-amber-500/50' : 'bg-white/[0.03] border-white/[0.08]'}`}
                  >
                    <p className={`text-[9px] truncate leading-tight ${isActive ? 'text-amber-300' : 'text-slate-400'}`}>
                      {folder.name}
                    </p>
                    <p className="text-[8px] text-slate-600">{totalBuckets}</p>
                  </div>
                  {folderMenuId === folder.id && menuAnchor && (
                    <div data-menu-btn className="fixed z-50 rounded-xl bg-[#131320] border border-white/[0.1] shadow-2xl overflow-hidden py-1 min-w-[160px]" style={{ top: menuAnchor.y, left: menuAnchor.x }}>
                      <button onClick={() => { renameFolder(folder.id); setFolderMenuId(null) }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                        <Pencil size={11} /> Rename
                      </button>
                      <button onClick={() => { setFolderMenuId(null); createFolder(folder.id) }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                        <FolderPlus size={11} /> Add subfolder
                      </button>
                      <button onClick={() => { setFolderMenuId(null); createBucket(null) }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                        <Plus size={11} /> Add bucket inside
                      </button>
                      {movableTargets.length > 0 && (
                        <>
                          <div className="px-3 pt-2 pb-1"><p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Move into</p></div>
                          {movableTargets.map(t => (
                            <button key={t.id} onClick={() => moveFolderTo(folder.id, t.id)}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                              <FolderOpen size={11} /> {t.name}
                            </button>
                          ))}
                        </>
                      )}
                      <button onClick={() => deleteFolder(folder.id)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/[0.06] transition-colors">
                        <Trash2 size={11} /> Delete folder
                      </button>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Ungrouped bucket cards (no folder, not uploads) */}
            {buckets.filter(b => !b.folderId && b.name !== UPLOADS_BUCKET_NAME).map(b => {
              const addMode = selectMode && selected.size > 0
              return (
              <div key={b.id} className="relative shrink-0 w-[76px]">
                {renamingId === b.id ? (
                  <div className="flex items-center gap-1 py-1">
                    <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') renameBucket(b.id); if (e.key === 'Escape') { setRenamingId(null); setRenameValue("") } }}
                      className="px-2 py-1 rounded-lg bg-white/[0.08] border border-violet-500/40 text-xs text-white outline-none w-32" />
                    <button onClick={() => renameBucket(b.id)} className="text-[10px] text-violet-400 hover:text-violet-300 px-1">✓</button>
                    <button onClick={() => { setRenamingId(null); setRenameValue("") }} className="text-[10px] text-slate-600 hover:text-slate-400 px-1">✕</button>
                  </div>
                ) : (
                  <div className="group">
                    <div
                      onClick={() => addMode ? addToBucket(b.id) : (setBucketFilter(v => v === String(b.id) ? "" : String(b.id)), setFolderPath([]))}
                      className={`w-full h-[52px] rounded-t-lg overflow-hidden relative border-t border-l border-r cursor-pointer transition-colors
                        ${addMode ? 'border-emerald-500/40 hover:border-emerald-500/70' : bucketFilter === String(b.id) ? 'border-violet-500/50' : 'border-white/[0.08] hover:border-white/15'}`}
                    >
                      <div className={`w-full h-full flex items-center justify-center ${addMode ? 'bg-emerald-500/10' : 'bg-white/[0.03]'}`}>
                        <FolderOpen size={16} className={addMode ? 'text-emerald-700' : 'text-slate-700'} />
                      </div>
                      {b.previewUrls[0] && (
                        <img src={b.previewUrls[0]} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                      )}
                      {addMode ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Plus size={16} className="text-emerald-300" />
                        </div>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); openBucketMenu(e, b.id) }}
                          className="absolute top-1 right-1 p-0.5 rounded bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
                          data-menu-btn
                        >
                          <MoreHorizontal size={9} className="text-white" />
                        </button>
                      )}
                    </div>
                    <div
                      onClick={() => addMode ? addToBucket(b.id) : (setBucketFilter(v => v === String(b.id) ? "" : String(b.id)), setFolderPath([]))}
                      className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r cursor-pointer transition-colors
                        ${addMode ? 'bg-emerald-500/8 border-emerald-500/30' : bucketFilter === String(b.id) ? 'bg-violet-500/15 border-violet-500/50' : 'bg-white/[0.03] border-white/[0.08]'}`}
                    >
                      <p className={`text-[9px] truncate leading-tight
                        ${addMode ? 'text-emerald-400' : bucketFilter === String(b.id) ? 'text-violet-300' : 'text-slate-400'}`}>
                        {b.name}
                      </p>
                      <p className="text-[8px] text-slate-600">{b.count}</p>
                    </div>
                    {bucketMenuId === b.id && menuAnchor && (
                      <div data-menu-btn className="fixed z-50 rounded-xl bg-[#131320] border border-white/[0.1] shadow-2xl overflow-hidden py-1 min-w-[160px]" style={{ top: menuAnchor.y, left: menuAnchor.x }}>
                        <button onClick={() => { setRenamingId(b.id); setRenameValue(b.name); setBucketMenuId(null); setMenuAnchor(null) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                          <Pencil size={11} /> Rename
                        </button>
                        <div className="px-3 pt-2 pb-1">
                          <p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Move to folder</p>
                        </div>
                        {folders.map(f => (
                          <button key={f.id} onClick={() => moveBucketToFolder(b.id, f.id)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                            <FolderOpen size={11} /> {f.name}
                          </button>
                        ))}
                        <button onClick={async () => {
                          const name = prompt('New folder name:')?.trim()
                          if (!name) return
                          const res = await fetch('/api/admin/folders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ name }) })
                          if (res.ok) { const folder = await res.json(); await loadFolders(); moveBucketToFolder(b.id, folder.id) }
                        }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-amber-500 hover:text-amber-300 hover:bg-amber-500/[0.06] transition-colors">
                          <Plus size={11} /> New folder…
                        </button>
                        <button onClick={() => exportBucket(b)} disabled={exportingBucketId === b.id}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/[0.06] transition-colors disabled:opacity-50">
                          {exportingBucketId === b.id ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                          Export zip
                        </button>
                        <button onClick={() => deleteBucket(b.id)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/[0.06] transition-colors">
                          <Trash2 size={11} /> Delete bucket
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )})}

            <button onClick={() => createBucket()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-white/[0.08] text-slate-600 hover:text-slate-300 hover:border-white/20 text-xs whitespace-nowrap shrink-0 transition-all">
              <FolderPlus size={11} /> New bucket
            </button>
            <button onClick={() => createFolder()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-amber-500/20 text-amber-700 hover:text-amber-400 hover:border-amber-500/40 text-xs whitespace-nowrap shrink-0 transition-all">
              <Plus size={11} /> New folder
            </button>
          </div>
        )}

        {/* Folder sub-row — shown when navigated into a folder */}
        {activeFolderId !== null && (
          <div className="mb-3 border-l-2 border-amber-500/30 pl-3">
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              <button onClick={() => setFolderPath([])}
                className="text-[9px] font-mono text-slate-600 hover:text-amber-400 uppercase tracking-wider transition-colors">
                root
              </button>
              {folderPath.map((fid, idx) => (
                <span key={fid} className="flex items-center gap-1">
                  <ChevronRight size={8} className="text-slate-700" />
                  <button
                    onClick={() => setFolderPath(prev => prev.slice(0, idx + 1))}
                    className={`text-[9px] font-mono uppercase tracking-wider transition-colors
                      ${idx === folderPath.length - 1 ? "text-amber-400" : "text-slate-500 hover:text-amber-400"}`}
                  >
                    {folders.find(f => f.id === fid)?.name ?? fid}
                  </button>
                </span>
              ))}
            </div>

            {/* Sub-folders + buckets in current folder */}
            <div className="flex items-end gap-2 overflow-x-auto pb-2 scrollbar-hide">

              {/* Sub-folder cards */}
              {folders.filter(f => (f.parentId ?? null) === activeFolderId).map(sf => {
                const sfDescendants = getDescendantIds(sf.id)
                const sfBucketCount = buckets.filter(b => b.folderId !== null && sfDescendants.has(b.folderId)).length
                const isSubActive = folderPath.includes(sf.id)
                const movableTargets = folders.filter(f => !sfDescendants.has(f.id))
                return (
                  <div key={sf.id} className="relative shrink-0 w-[72px] group">
                    <div
                      onClick={() => setFolderPath(prev => [...prev, sf.id])}
                      className={`w-full h-[46px] rounded-t-lg overflow-hidden relative border-t border-l border-r cursor-pointer transition-colors
                        ${isSubActive ? 'border-amber-500/50' : 'border-amber-500/15 hover:border-amber-500/30'}`}
                    >
                      <div className="grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-black/30">
                        {[0,1,2,3].map(i => (
                          <div key={i} className="overflow-hidden bg-white/[0.02] relative">
                            {sf.previewUrls?.[i] && (
                              <img src={sf.previewUrls[i]} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                            )}
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); openFolderMenu(e, sf.id) }}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
                        data-menu-btn
                      >
                        <MoreHorizontal size={8} className="text-white" />
                      </button>
                    </div>
                    <div
                      onClick={() => setFolderPath(prev => [...prev, sf.id])}
                      className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r cursor-pointer transition-colors
                        ${isSubActive ? 'bg-amber-500/15 border-amber-500/50' : 'bg-amber-500/5 border-amber-500/15'}`}
                    >
                      <p className={`text-[9px] truncate leading-tight ${isSubActive ? 'text-amber-300' : 'text-amber-600'}`}>
                        {sf.name}
                      </p>
                      <p className="text-[8px] text-slate-600">{sfBucketCount}</p>
                    </div>
                    {folderMenuId === sf.id && menuAnchor && (
                      <div data-menu-btn className="fixed z-50 rounded-xl bg-[#131320] border border-white/[0.1] shadow-2xl overflow-hidden py-1 min-w-[160px]" style={{ top: menuAnchor.y, left: menuAnchor.x }}>
                        <button onClick={() => { renameFolder(sf.id); setFolderMenuId(null) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                          <Pencil size={11} /> Rename
                        </button>
                        <button onClick={() => { setFolderMenuId(null); createFolder(sf.id) }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                          <FolderPlus size={11} /> Add subfolder
                        </button>
                        <button onClick={() => moveFolderTo(sf.id, null)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                          <FolderOpen size={11} /> Move to root
                        </button>
                        {movableTargets.filter(t => t.id !== sf.id && t.id !== activeFolderId).length > 0 && (
                          <>
                            <div className="px-3 pt-2 pb-1"><p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Move into</p></div>
                            {movableTargets.filter(t => t.id !== sf.id && t.id !== activeFolderId).map(t => (
                              <button key={t.id} onClick={() => moveFolderTo(sf.id, t.id)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                                <FolderOpen size={11} /> {t.name}
                              </button>
                            ))}
                          </>
                        )}
                        <button onClick={() => deleteFolder(sf.id)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/[0.06] transition-colors">
                          <Trash2 size={11} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Bucket cards directly in activeFolderId */}
              {buckets.filter(b => b.folderId === activeFolderId).map(b => {
                const addMode = selectMode && selected.size > 0
                return (
                <div key={b.id} className="relative shrink-0 w-[72px]">
                  {renamingId === b.id ? (
                    <div className="flex items-center gap-1 py-1">
                      <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') renameBucket(b.id); if (e.key === 'Escape') { setRenamingId(null); setRenameValue("") } }}
                        className="px-2 py-1 rounded-lg bg-white/[0.08] border border-violet-500/40 text-xs text-white outline-none w-32" />
                      <button onClick={() => renameBucket(b.id)} className="text-[10px] text-violet-400 hover:text-violet-300 px-1">✓</button>
                      <button onClick={() => { setRenamingId(null); setRenameValue("") }} className="text-[10px] text-slate-600 hover:text-slate-400 px-1">✕</button>
                    </div>
                  ) : (
                    <div className="group">
                      <div
                        onClick={() => addMode ? addToBucket(b.id) : setBucketFilter(v => v === String(b.id) ? "" : String(b.id))}
                        className={`w-full h-[46px] rounded-t-lg overflow-hidden relative border-t border-l border-r cursor-pointer transition-colors
                          ${addMode ? 'border-emerald-500/40 hover:border-emerald-500/70' : bucketFilter === String(b.id) ? 'border-violet-500/50' : 'border-white/[0.08] hover:border-white/15'}`}
                      >
                        <div className={`w-full h-full flex items-center justify-center ${addMode ? 'bg-emerald-500/10' : 'bg-white/[0.03]'}`}>
                          <FolderOpen size={14} className={addMode ? 'text-emerald-700' : 'text-slate-700'} />
                        </div>
                        {b.previewUrls[0] && (
                          <img src={b.previewUrls[0]} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                        )}
                        {addMode ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/20 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Plus size={14} className="text-emerald-300" />
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); openBucketMenu(e, b.id) }}
                            className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity"
                            data-menu-btn
                          >
                            <MoreHorizontal size={8} className="text-white" />
                          </button>
                        )}
                      </div>
                      <div
                        onClick={() => addMode ? addToBucket(b.id) : setBucketFilter(v => v === String(b.id) ? "" : String(b.id))}
                        className={`px-1.5 py-1 rounded-b-lg border-b border-l border-r cursor-pointer transition-colors
                          ${addMode ? 'bg-emerald-500/8 border-emerald-500/30' : bucketFilter === String(b.id)
                            ? 'bg-violet-500/15 border-violet-500/50'
                            : 'bg-white/[0.03] border-white/[0.08]'}`}
                      >
                        <p className={`text-[9px] truncate leading-tight
                          ${addMode ? 'text-emerald-400' : bucketFilter === String(b.id) ? 'text-violet-300' : 'text-slate-400'}`}>
                          {b.name}
                        </p>
                        <p className="text-[8px] text-slate-600">{b.count}</p>
                      </div>
                      {bucketMenuId === b.id && menuAnchor && (
                        <div data-menu-btn className="fixed z-50 rounded-xl bg-[#131320] border border-white/[0.1] shadow-2xl overflow-hidden py-1 min-w-[160px]" style={{ top: menuAnchor.y, left: menuAnchor.x }}>
                          <button onClick={() => { setRenamingId(b.id); setRenameValue(b.name); setBucketMenuId(null) }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                            <Pencil size={11} /> Rename
                          </button>
                          <button onClick={() => moveBucketToFolder(b.id, null)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                            <FolderOpen size={11} /> Remove from folder
                          </button>
                          {folders.filter(f => f.id !== activeFolderId).length > 0 && (
                            <>
                              <div className="px-3 pt-2 pb-1"><p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Move to</p></div>
                              {folders.filter(f => f.id !== activeFolderId).map(f => (
                                <button key={f.id} onClick={() => moveBucketToFolder(b.id, f.id)}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                                  <FolderOpen size={11} /> {f.name}
                                </button>
                              ))}
                            </>
                          )}
                          <button onClick={() => exportBucket(b)} disabled={exportingBucketId === b.id}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/[0.06] transition-colors disabled:opacity-50">
                            {exportingBucketId === b.id ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                            Export zip
                          </button>
                          <button onClick={() => deleteBucket(b.id)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/[0.06] transition-colors">
                            <Trash2 size={11} /> Delete bucket
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )})}

              {folders.filter(f => (f.parentId ?? null) === activeFolderId).length === 0 && buckets.filter(b => b.folderId === activeFolderId).length === 0 && (
                <span className="text-[11px] text-slate-700 italic">Empty folder</span>
              )}
              <button onClick={() => createBucket(activeFolderId)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-white/[0.07] text-slate-600 hover:text-slate-300 text-xs whitespace-nowrap shrink-0 transition-all">
                <Plus size={10} /> Add bucket
              </button>
              <button onClick={() => createFolder(activeFolderId)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-amber-500/15 text-amber-800 hover:text-amber-500 hover:border-amber-500/30 text-xs whitespace-nowrap shrink-0 transition-all">
                <FolderPlus size={10} /> Add subfolder
              </button>
            </div>
          </div>
        )}

        {buckets.length === 0 && folders.length === 0 && (
          <div className="mb-4 flex items-center gap-2">
            <button onClick={() => createBucket()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-white/[0.08] text-slate-700 hover:text-slate-400 hover:border-white/20 text-xs transition-all">
              <FolderPlus size={11} /> Create a bucket to organize generations
            </button>
          </div>
        )}

        {/* Stats row — bucket-level + page-level counts */}
        {bucketFilter && bucketStats && (
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.07] text-[11px] w-fit">
              <span className="text-[9px] text-violet-500/60 font-mono uppercase tracking-wider">bucket</span>
              <span className="text-slate-500">{bucketStats.total.toLocaleString()} total</span>
              <span className="text-emerald-400/80">{bucketStats.marked.toLocaleString()} marked</span>
              <span className="text-cyan-400/70">{bucketStats.tagged.toLocaleString()} tagged</span>
              <span className="text-violet-400/70">{bucketStats.captioned.toLocaleString()} captioned</span>
            </div>
            {images.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.07] text-[11px] w-fit">
                <span className="text-[9px] text-sky-500/60 font-mono uppercase tracking-wider">page</span>
                <span className="text-slate-500">{images.length} total</span>
                <span className="text-emerald-400/80">{images.filter(img => img.markedForTraining).length} marked</span>
                <span className="text-cyan-400/70">{images.filter(img => img.adminTags.length > 0).length} tagged</span>
                <span className="text-violet-400/70">{images.filter(img => !!img.adminCaption).length} captioned</span>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
        )}

        {/* Select mode hint */}
        {selectMode && selected.size === 0 && (
          <div className="mb-4 flex items-center gap-3 text-xs text-cyan-400/60">
            <span className="flex items-center gap-1.5"><CheckSquare size={12} /> Click images to select them, or</span>
            <button onClick={selectAllRecords} disabled={selectAllLoading}
              className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-medium transition-colors disabled:opacity-50">
              {selectAllLoading
                ? <><Loader2 size={10} className="animate-spin" /> Selecting…</>
                : <>select all {pagination ? pagination.total.toLocaleString() : ""} records</>
              }
            </button>
          </div>
        )}

        {loading && images.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={20} className="animate-spin text-slate-600" />
          </div>
        ) : images.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-600">
            <Database size={32} className="mb-3" />
            <p className="text-sm">No records match your filters</p>
          </div>
        ) : (
          <>
            {pagination && pagination.totalPages > 1 && (
              <PageNav pagination={pagination} page={page} loading={loading} setPage={setPage} className="mb-4" />
            )}

            {feedLayout === "masonry" && feedMasonryMode === "rows" ? (
              /* Masonry "Rows": JS shortest-column packing — fills left-to-right,
                 balanced by stored aspect ratio so tiles don't jump as images load */
              <div className="flex gap-2 items-start">
                {distributeMasonry(
                  deferredImages.map((img, i) => ({
                    img, i,
                    // Info footer adds a roughly constant strip below each tile
                    weight: arHeightWeight(img.aspectRatio) + (feedShowInfo ? 0.35 : 0),
                  })),
                  cols,
                ).map((col, ci) => (
                  <div key={ci} className="flex-1 min-w-0 space-y-2">
                    {col.map(({ img, i }) => (
                      <ImageCard
                        key={img.id}
                        img={img}
                        index={i}
                        selected={selected.has(img.id)}
                        selectMode={selectMode}
                        onSelect={toggleSelect}
                        onOpen={setDetailImg}
                        onToggleMark={handleCardToggleMark}
                        layout="masonry"
                        showInfo={feedShowInfo}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : feedLayout === "masonry" ? (
              /* Masonry "Flow": CSS columns, packs top-to-bottom down each column */
              <div className={`${{1:'columns-1',2:'columns-2',3:'columns-3',4:'columns-4',5:'columns-5',6:'columns-6'}[cols] ?? 'columns-4'}`} style={{ columnGap: '0.5rem' }}>
                {deferredImages.map((img, i) => (
                  <div key={img.id} className="mb-2 break-inside-avoid">
                    <ImageCard
                      img={img}
                      index={i}
                      selected={selected.has(img.id)}
                      selectMode={selectMode}
                      onSelect={toggleSelect}
                      onOpen={setDetailImg}
                      onToggleMark={handleCardToggleMark}
                      layout="masonry"
                      showInfo={feedShowInfo}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className={`grid gap-2 ${{1:'grid-cols-1',2:'grid-cols-2',3:'grid-cols-3',4:'grid-cols-4',5:'grid-cols-5',6:'grid-cols-6'}[cols] ?? 'grid-cols-4'}`}>
                {deferredImages.map((img, i) => (
                  <ImageCard
                    key={img.id}
                    img={img}
                    index={i}
                    selected={selected.has(img.id)}
                    selectMode={selectMode}
                    onSelect={toggleSelect}
                    onOpen={setDetailImg}
                    onToggleMark={handleCardToggleMark}
                    layout="grid"
                    showInfo={feedShowInfo}
                  />
                ))}
              </div>
            )}

            {pagination && pagination.totalPages > 1 && (
              <PageNav pagination={pagination} page={page} loading={loading} setPage={setPage} className="mt-6" />
            )}
          </>
        )}
        </>)}
      </div>

      </div>{/* end main content column */}
    </div>
  )
}
