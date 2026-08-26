"use client"

// ── Slicing Studio (ADMIN ONLY) ──────────────────────────────────────────────
// The Frame Extractor grown into a page: upload any number of videos/GIFs
// (no 2-minute budget), stored PERMANENTLY as dataset uploads (they appear on
// /admin/dataset in the __uploads__ bucket), then slice any of them into
// still frames and/or short clips/GIFs. Results save back into the dataset
// or download as a ZIP. Uploads ride presigned R2 PUTs (Vercel bodies cap at
// ~4.5MB) and slicing runs on the existing /api/admin/frames-clips route.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  ArrowLeft, Check, Download, Film, Loader2, Lock, Plus, RefreshCw, Trash2,
  Upload, X, Zap,
  SlidersHorizontal,
  History,
} from "lucide-react"
import { SiteLogoBox } from "@/components/SitePageHeader"

const UPLOADS_BUCKET_NAME = "__uploads__"
const MAX_FRAMES = 300
const MAX_CLIP_SOURCE_SEC = 900 // matches the slicing route's ceiling

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

function laplacianVariance(data: Uint8ClampedArray, w: number, h: number): number {
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  let sum = 0, sumSq = 0
  const n = (w - 2) * (h - 2)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i]
      sum += lap
      sumSq += lap * lap
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

interface LibraryItem {
  id: number
  url: string
  name: string
  isGif: boolean
  createdAt: string
  ar: number          // width/height — reserves tile space so the grid never reflows
  dur: number | null  // seconds; null until probed
  ext: string         // mp4 | gif | mov | webm | …
  segs: number        // how many preview segments exist (1 = just the one)
}

// CSS columns fill top-to-bottom, column by column, so item #2 lands UNDER
// item #1 instead of beside it. Dealing items round-robin into per-column
// buckets restores reading order across the row while keeping ragged heights.
function toColumns<T>(items: T[], cols: number): T[][] {
  const out: T[][] = Array.from({ length: cols }, () => [])
  items.forEach((it, i) => out[i % cols].push(it))
  return out
}

// Tailwind's columns-* breakpoints, mirrored so the JS split matches the CSS
function useColumnCount(counts: { base: number; sm: number; lg: number }) {
  const [n, setN] = useState(counts.base)
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth
      setN(w >= 1024 ? counts.lg : w >= 640 ? counts.sm : counts.base)
    }
    calc()
    window.addEventListener("resize", calc)
    return () => window.removeEventListener("resize", calc)
  }, [counts.base, counts.sm, counts.lg])
  return n
}

const fmtDur = (d: number | null) => {
  if (d == null) return "—"
  if (d < 60) return `${d < 10 ? d.toFixed(1) : Math.round(d)}s`
  const m = Math.floor(d / 60)
  return `${m}m${String(Math.round(d - m * 60)).padStart(2, "0")}s`
}

// "719:722" | "16:9" -> 0.995 | 1.778 (clamped so a freak ratio can't blow up a tile)
function parseAr(v: unknown): number {
  const m = typeof v === "string" ? v.match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/) : null
  if (!m) return 1
  const w = parseFloat(m[1]), h = parseFloat(m[2])
  if (!(w > 0) || !(h > 0)) return 1
  return Math.min(3, Math.max(0.4, w / h))
}

// Static cached thumb until the tile has DWELLED in view, then the real media
// autoplays. The dwell keeps a fast scroll from kicking off dozens of full-size
// GIF/video downloads, and the box below reserves the tile's exact height so
// nothing reflows as media arrives.
//
// crossOrigin="anonymous" is REQUIRED, not cosmetic: without it the browser
// caches a non-CORS copy of this exact URL, and the workspace's later CORS
// fetch/decode of the same URL is rejected out of that cache ("Load failed").
const MEDIA_CLASS = "absolute inset-0 w-full h-full object-cover pointer-events-none"

// Tile playback budget. Animated images don't consume video decoders, so this
// is purely a memory bound and can be far more generous than the old <video>
// cap — every tile you can actually see should be moving.
const LIVE_CAP = 40
const liveTiles: { id: number; off: () => void }[] = []
function claimLive(id: number, off: () => void) {
  const dup = liveTiles.findIndex(t => t.id === id)
  if (dup >= 0) liveTiles.splice(dup, 1)
  liveTiles.push({ id, off })
  while (liveTiles.length > LIVE_CAP) liveTiles.shift()?.off()
}
function releaseLive(id: number) {
  const i = liveTiles.findIndex(t => t.id === id)
  if (i >= 0) liveTiles.splice(i, 1)
}

// The working set survives reloads: sources are permanent dataset rows, so
// only their ids/urls need saving. Extracted frames/clips are in-memory blobs
// and deliberately NOT persisted — they're re-extractable in one tap, and
// stuffing megabytes of image data into storage is how you break a tab.
const WS_KEY = "slicing-studio-working-set-v1"
const WS_MAX = 1000
const PAGE_KEY = "slicing-studio-lib-page-v1"
const WS_HIST_KEY = "slicing-studio-ws-history-v1"
const WS_HIST_MAX = 8
type WsSnapshot = { at: number; items: LibraryItem[] }

// Archive a bench whenever it shrinks or is cleared, so it can be brought back
function pushWsHistory(items: LibraryItem[]) {
  if (items.length === 0) return
  try {
    const raw = localStorage.getItem(WS_HIST_KEY)
    const prev: WsSnapshot[] = raw ? JSON.parse(raw) : []
    const head = prev[0]
    // Skip no-op snapshots (same ids as the newest entry)
    if (head && head.items.length === items.length &&
        head.items.every((it, i) => it.id === items[i].id)) return
    const next = [{ at: Date.now(), items }, ...prev].slice(0, WS_HIST_MAX)
    localStorage.setItem(WS_HIST_KEY, JSON.stringify(next))
  } catch { /* history is a safety net, never a blocker */ }
}
function readWsHistory(): WsSnapshot[] {
  try {
    const raw = localStorage.getItem(WS_HIST_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(sn => Array.isArray(sn?.items) && sn.items.length > 0) : []
  } catch { return [] }
}
type SavedWorkingSet = { v: 1; items: LibraryItem[]; activeId: number | null }

function loadSavedWorkingSet(): SavedWorkingSet | null {
  try {
    const raw = localStorage.getItem(WS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p || p.v !== 1 || !Array.isArray(p.items)) return null
    const items: LibraryItem[] = p.items
      .filter((i: unknown): i is LibraryItem => {
        const it = i as LibraryItem
        return !!it && typeof it.id === "number" && typeof it.url === "string"
      })
      .map((i: LibraryItem) => ({ ...i, ar: typeof i.ar === "number" && i.ar > 0 ? i.ar : 1 }))
    if (items.length === 0) return null
    const activeId = typeof p.activeId === "number" && items.some(i => i.id === p.activeId) ? p.activeId : null
    return { v: 1, items, activeId }
  } catch { return null }
}

// Tiles never touch the original file: they play a cached ~3s/320px preview
// clip, which is a fraction of the bytes and memory. That keeps a page of 60
// tiles well clear of the memory ceiling that makes iPad Safari reload the tab.
const previewSrc = (id: number, seg = 0) =>
  `/api/admin/dataset/preview/${id}${seg ? `?seg=${seg}` : ""}`   // animated webp

// A 3s window is all a tile ever shows, so on a long source it would loop the
// same moment forever. Long sources instead rotate through segments sampled at
// 25% / 50% / 72%. Rotation only starts once a tile is live and visible.
const ROTATE_MIN_SEC = 12
const ROTATE_EVERY_MS = 7000
const segCountFor = (item: { dur: number | null; segs: number }) =>
  item.dur != null && item.dur >= ROTATE_MIN_SEC ? 3 : Math.max(1, item.segs)

function MotionThumb({ item, className = "", idx = 0 }: { item: LibraryItem; className?: string; idx?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [live, setLive] = useState(false)
  // A preview that fails (still generating, transient error) falls back to the
  // still frame and gets ONE more try — never a dead tile, never a retry storm.
  const [failed, setFailed] = useState(false)
  const [seg, setSeg] = useState(0)
  const retriedRef = useRef(false)
  const onPreviewError = () => {
    setFailed(true)
    if (retriedRef.current) return
    retriedRef.current = true
    setTimeout(() => setFailed(false), 4000)
  }
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") { setLive(true); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(es => es.forEach(e => {
      clearTimeout(timer)
      if (e.isIntersecting) {
        // Stagger starts across the grid — forty previews kicking off on the
        // same frame is what makes a page switch hitch
        timer = setTimeout(() => {
          claimLive(item.id, () => setLive(false))
          setLive(true)
        }, 120 + Math.min(idx, 24) * 35)
      } else {
        releaseLive(item.id)
        setLive(false)
      }
    }), { rootMargin: "60px" })
    io.observe(el)
    return () => { clearTimeout(timer); releaseLive(item.id); io.disconnect() }
  }, [item.id, idx])

  // Cycle a long source through its segments while it's on screen. The random
  // phase keeps a grid full of tiles from all switching on the same beat.
  const total = segCountFor(item)
  useEffect(() => {
    if (!live || total < 2) return
    // Start somewhere random so two tiles from the same clip don't march in
    // lockstep, then jump to a random OTHER segment each turn — never the same
    // moment twice in a row.
    setSeg(Math.floor(Math.random() * total))
    const jitter = Math.floor(Math.random() * 2500)
    const t = setInterval(() => {
      setSeg(prev => {
        const pick = Math.floor(Math.random() * (total - 1))
        return pick >= prev ? pick + 1 : pick
      })
    }, ROTATE_EVERY_MS + jitter)
    return () => clearInterval(t)
  }, [live, total])
  return (
    <span ref={ref} className={`relative block bg-black overflow-hidden ${className}`} style={{ aspectRatio: String(item.ar || 1) }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/admin/dataset/thumb/${item.id}`} alt="" className={MEDIA_CLASS} loading="lazy" decoding="async" />
      {live && !failed && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img key={seg} src={previewSrc(item.id, seg)} alt="" onError={onPreviewError}
          className={MEDIA_CLASS} decoding="async" />
      )}
    </span>
  )
}

interface StudioFrame {
  t: number
  url: string
  blob: Blob
  score: number
  norm: number
}

interface StudioClip {
  t: number
  dur: number
  url: string
  blob: Blob
  name: string
  kind: "mp4" | "gif"
  score: number
  norm: number
}

const pw = () => { try { return sessionStorage.getItem("admin-password") || "" } catch { return "" } }
const ah = (): Record<string, string> => (pw() ? { "x-admin-password": pw() } : {})

export default function SlicingStudioPage() {
  // ── Auth gate (same pattern as /admin/dataset) ──
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

  // ── Library (dataset uploads bucket, videos + GIFs) ──
  const [bucketId, setBucketId] = useState<number | null>(null)
  const [allItems, setAllItems] = useState<LibraryItem[]>([])
  const [libLoading, setLibLoading] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [fTypes, setFTypes] = useState<string[]>([])       // [] = every type
  const [fMinDur, setFMinDur] = useState("")
  const [fMaxDur, setFMaxDur] = useState("")
  const [fSort, setFSort] = useState<"newest" | "oldest" | "shortest" | "longest" | "name">("newest")
  const [fOnlyUnused, setFOnlyUnused] = useState(false)
  const libScrollRef = useRef<HTMLDivElement>(null)
  const libCols = useColumnCount({ base: 3, sm: 5, lg: 8 })
  const resCols = useColumnCount({ base: 2, sm: 3, lg: 5 })
  const [pageInput, setPageInput] = useState("1")   // jump-to-page box
  const [libPage, setLibPage] = useState(1)
  const LIB_PAGE_SIZE = 60
  const [error, setError] = useState<string | null>(null)

  // Fetches the whole bucket once. Filtering, sorting and paging all happen
  // on what's already in memory, so they're instant and never re-hit the API.
  const loadLibrary = useCallback(async () => {
    setLibLoading(true)
    try {
      const bRes = await fetch("/api/admin/buckets", { headers: ah() })
      if (!bRes.ok) throw new Error(`Buckets failed (${bRes.status})`)
      const bData = await bRes.json()
      const list: { id: number; name: string }[] = bData.buckets ?? bData ?? []
      let up = list.find(b => b.name === UPLOADS_BUCKET_NAME)
      if (!up) {
        const cr = await fetch("/api/admin/buckets", {
          method: "POST", headers: { "Content-Type": "application/json", ...ah() },
          body: JSON.stringify({ name: UPLOADS_BUCKET_NAME }),
        })
        const cd = await cr.json().catch(() => ({}))
        up = cd.bucket ?? cd
      }
      if (!up?.id) throw new Error("Could not resolve the uploads bucket")
      setBucketId(up.id)
      const res = await fetch(`/api/admin/dataset?slim=1&bucketId=${up.id}&mediaType=motion`, { headers: ah() })
      if (!res.ok) throw new Error(`Library failed (${res.status})`)
      const data = await res.json()
      const rows: { id: number; url: string; aspectRatio?: string | null; name?: string | null; mime?: string | null; dur?: number | null; segs?: number; createdAt: string }[] = data.items ?? []
      setAllItems(rows.map(r => ({
        id: r.id,
        url: r.url,
        name: r.name || r.url.split("/").pop() || `item-${r.id}`,
        isGif: /\.gif(\?|#|$)/i.test(r.url),
        createdAt: r.createdAt,
        ar: parseAr(r.aspectRatio),
        dur: typeof r.dur === "number" ? r.dur : null,
        ext: (r.url.split(".").pop() || "").toLowerCase().replace(/[?#].*$/, ""),
        segs: r.segs ?? 1,
      })))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Library load failed")
    } finally { setLibLoading(false) }
  }, [])
  useEffect(() => {
    if (!authed) return
    void loadLibrary()
    // Resume on the page you were last looking at
    try {
      const start = Math.max(1, parseInt(localStorage.getItem(PAGE_KEY) || "1", 10) || 1)
      setLibPage(start); setPageInput(String(start))
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed])


  // ── Upload new videos/GIFs → permanent dataset rows ──
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const probeDims = (file: File): Promise<{ w: number; h: number }> => new Promise(res => {
    const guard = setTimeout(() => res({ w: 0, h: 0 }), 8000)
    if (file.type === "image/gif" || /\.gif$/i.test(file.name)) {
      const im = new window.Image()
      im.onload = () => { clearTimeout(guard); res({ w: im.naturalWidth, h: im.naturalHeight }) }
      im.onerror = () => { clearTimeout(guard); res({ w: 0, h: 0 }) }
      im.src = URL.createObjectURL(file)
    } else {
      const v = document.createElement("video")
      v.preload = "metadata"; v.muted = true
      v.onloadedmetadata = () => { clearTimeout(guard); res({ w: v.videoWidth, h: v.videoHeight }) }
      v.onerror = () => { clearTimeout(guard); res({ w: 0, h: 0 }) }
      v.src = URL.createObjectURL(file)
    }
  })
  const uploadFiles = async (files: File[]) => {
    if (!bucketId || files.length === 0) return
    setError(null)
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploading(`Uploading ${i + 1}/${files.length} — ${file.name}`)
        const mime = file.type || (/\.gif$/i.test(file.name) ? "image/gif" : "video/mp4")
        const pre = await fetch("/api/admin/dataset/presign", {
          method: "POST", headers: { "Content-Type": "application/json", ...ah() },
          body: JSON.stringify({ files: [{ filename: file.name, mimeType: mime }] }),
        })
        if (!pre.ok) throw new Error(`Presign failed (${pre.status})`)
        const { results } = await pre.json()
        const slot = results?.[0]
        if (!slot) throw new Error("No upload slot")
        const put = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": slot.normalizedMime }, body: file })
        if (!put.ok) throw new Error(`Upload failed (${put.status})`)
        const dims = await probeDims(file)
        const rec = await fetch("/api/admin/dataset/record", {
          method: "POST", headers: { "Content-Type": "application/json", ...ah() },
          body: JSON.stringify({
            bucketId,
            records: [{ imageUrl: slot.publicUrl, mimeType: slot.normalizedMime, filename: file.name, width: dims.w, height: dims.h, meta: {} }],
          }),
        })
        if (!rec.ok) throw new Error(`Record failed (${rec.status})`)
      }
      await loadLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed")
    } finally { setUploading(null) }
  }

  // ── Workspace: a WORKING SET of selected sources; one is active at a time
  // and each keeps its own extracted results (cached on switch) ──
  const [workingSet, setWorkingSet] = useState<LibraryItem[]>([])
  const [histOpen, setHistOpen] = useState(false)
  const [history, setHistory] = useState<WsSnapshot[]>([])
  const [active, setActive] = useState<LibraryItem | null>(null)
  const [activePlayUrl, setActivePlayUrl] = useState<string | null>(null) // gif → converted mp4 blob URL
  const [activeDuration, setActiveDuration] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const resultsCacheRef = useRef<Map<number, { frames: StudioFrame[]; clips: StudioClip[] }>>(new Map())
  const prepCacheRef = useRef<Map<number, { playUrl: string; duration: number }>>(new Map())

  const switchActive = async (item: LibraryItem, stashCurrent = true) => {
    if (extracting || preparing) return
    if (stashCurrent && active && active.id !== item.id) {
      resultsCacheRef.current.set(active.id, { frames, clips })
    }
    if (active?.id === item.id) return
    setActive(item)
    const cached = resultsCacheRef.current.get(item.id)
    setFrames(cached?.frames ?? [])
    setClips(cached?.clips ?? [])
    setProgress(0)
    setError(null)
    const prep = prepCacheRef.current.get(item.id)
    if (prep) {
      setActivePlayUrl(prep.playUrl)
      setActiveDuration(prep.duration)
      return
    }
    setActivePlayUrl(null); setActiveDuration(0)
    setPreparing(true)
    try {
      let url = item.url
      if (item.isGif) {
        // GIFs can't seek in <video> — one transient server conversion gives
        // the workspace a playable/extractable MP4 (the stored GIF is untouched)
        // Server-side fetch+convert: the browser never downloads the GIF, so
        // a big one can't blow the tab's memory or trip Safari's "Load failed"
        const res = await fetch("/api/admin/frames-gif", {
          method: "POST",
          headers: { ...ah(), "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url }),
        })
        if (!res.ok) {
          const msg = await res.json().then(j => j.error).catch(() => "")
          throw new Error(msg || `GIF conversion failed (${res.status})`)
        }
        url = URL.createObjectURL(await res.blob())
      }
      // Canvas extraction needs pixel access, so this load must be CORS-clean.
      const probe = (u: string) => new Promise<number>((res, rej) => {
        const v = document.createElement("video")
        v.preload = "metadata"; v.muted = true
        v.crossOrigin = "anonymous"
        v.onloadedmetadata = () => res(v.duration)
        v.onerror = () => rej(new Error("decode failed"))
        v.src = u
      })
      let playUrl = url
      let duration = 0
      try {
        duration = await probe(playUrl)
      } catch (err) {
        if (playUrl.startsWith("blob:")) throw err
        // R2 only sends CORS headers to allow-listed origins; route through
        // our own origin instead, where CORS cannot apply.
        playUrl = `/api/admin/media-proxy?url=${encodeURIComponent(url)}`
        duration = await probe(playUrl)
      }
      prepCacheRef.current.set(item.id, { playUrl, duration })
      setActivePlayUrl(playUrl)
      setActiveDuration(duration)
    } catch (e) {
      setError(`Could not open "${item.name}" — ${e instanceof Error ? e.message : "unknown error"}`)
      setActive(null)
    } finally { setPreparing(false) }
  }

  // Jump straight to a typed page number (clamped to the real range)
  const jumpToPage = () => {
    if (libLoading) return
    const n = parseInt(pageInput, 10)
    if (!Number.isFinite(n)) { setPageInput(String(libPage)); return }
    const target = Math.min(libTotalPages, Math.max(1, n))
    setPageInput(String(target))
    if (target !== libPage) goToPage(target)
  }

  // Library tile tap: toggle the item in/out of the working set
  const toggleSource = (item: LibraryItem) => {
    if (extracting || preparing) return
    if (workingSet.some(x => x.id === item.id)) { removeFromSet(item.id); return }
    setWorkingSet(prev => [...prev, item])
    if (!active) void switchActive(item, false)
  }

  const removeFromSet = (id: number) => {
    if (extracting || preparing) return
    pushWsHistory(workingSet)      // archive before shrinking
    const cached = resultsCacheRef.current.get(id)
    const gone = new Set<string>([
      ...(cached?.frames ?? []).map(f => f.url),
      ...(cached?.clips ?? []).map(c => c.url),
      ...(active?.id === id ? [...frames.map(f => f.url), ...clips.map(c => c.url)] : []),
    ])
    cached?.frames.forEach(f => URL.revokeObjectURL(f.url))
    cached?.clips.forEach(c => URL.revokeObjectURL(c.url))
    resultsCacheRef.current.delete(id)
    const prep = prepCacheRef.current.get(id)
    if (prep && prep.playUrl.startsWith("blob:")) URL.revokeObjectURL(prep.playUrl)
    prepCacheRef.current.delete(id)
    setSelected(prev => new Set([...prev].filter(u => !gone.has(u))))
    const rest = workingSet.filter(x => x.id !== id)
    setWorkingSet(rest)
    if (active?.id === id) {
      setActive(null); setActivePlayUrl(null); setActiveDuration(0)
      setFrames([]); setClips([])
      if (rest.length > 0) void switchActive(rest[0], false)
    }
  }

  const clearWorkingSet = () => {
    if (extracting || preparing) return
    pushWsHistory(workingSet)      // archive before wiping
    for (const v of resultsCacheRef.current.values()) {
      v.frames.forEach(f => URL.revokeObjectURL(f.url))
      v.clips.forEach(c => URL.revokeObjectURL(c.url))
    }
    resultsCacheRef.current.clear()
    for (const pr of prepCacheRef.current.values()) {
      if (pr.playUrl.startsWith("blob:")) URL.revokeObjectURL(pr.playUrl)
    }
    prepCacheRef.current.clear()
    frames.forEach(f => URL.revokeObjectURL(f.url))
    clips.forEach(c => URL.revokeObjectURL(c.url))
    setWorkingSet([]); setActive(null); setActivePlayUrl(null); setActiveDuration(0)
    setFrames([]); setClips([]); setSelected(new Set())
    try { localStorage.removeItem(WS_KEY) } catch {}
  }

  // ── Derived library view: filter → sort → page, all in memory ──
  const availableExts = useMemo(
    () => [...new Set(allItems.map(i => i.ext))].filter(Boolean).sort(),
    [allItems])

  const filtered = useMemo(() => {
    const min = parseFloat(fMinDur), max = parseFloat(fMaxDur)
    const out = allItems.filter(i => {
      if (fTypes.length > 0 && !fTypes.includes(i.ext)) return false
      // Unprobed items (dur === null) are kept — a length filter shouldn't
      // silently hide sources whose length simply isn't known yet
      if (!isNaN(min) && i.dur != null && i.dur < min) return false
      if (!isNaN(max) && i.dur != null && i.dur > max) return false
      if (fOnlyUnused && workingSet.some(w => w.id === i.id)) return false
      return true
    })
    const byName = (a: LibraryItem, b: LibraryItem) => a.name.localeCompare(b.name)
    const byDur = (a: LibraryItem, b: LibraryItem, dir: number) =>
      ((a.dur ?? Infinity) - (b.dur ?? Infinity)) * dir || byName(a, b)
    out.sort((a, b) =>
      fSort === "newest"   ? +new Date(b.createdAt) - +new Date(a.createdAt) :
      fSort === "oldest"   ? +new Date(a.createdAt) - +new Date(b.createdAt) :
      fSort === "shortest" ? byDur(a, b, 1) :
      fSort === "longest"  ? byDur(b, a, 1) :
      byName(a, b))
    return out
  }, [allItems, fTypes, fMinDur, fMaxDur, fSort, fOnlyUnused, workingSet])

  const libTotal = filtered.length
  const libTotalPages = Math.max(1, Math.ceil(filtered.length / LIB_PAGE_SIZE))
  const library = useMemo(
    () => filtered.slice((libPage - 1) * LIB_PAGE_SIZE, libPage * LIB_PAGE_SIZE),
    [filtered, libPage])

  // Page changes are now pure state — no fetch, no stall
  const goToPage = useCallback((n: number) => {
    const target = Math.min(Math.max(1, n), libTotalPages)
    setLibPage(target)
    setPageInput(String(target))
    try { localStorage.setItem(PAGE_KEY, String(target)) } catch {}
    libScrollRef.current?.scrollTo({ top: 0 })
  }, [libTotalPages])

  // A filter change can strand you past the end of the new result set
  useEffect(() => {
    if (libPage > libTotalPages) goToPage(libTotalPages)
  }, [libTotalPages, libPage, goToPage])

  const unprobedCount = allItems.filter(i => i.dur == null).length
  const activeFilterCount =
    (fTypes.length > 0 ? 1 : 0) + (fMinDur ? 1 : 0) + (fMaxDur ? 1 : 0) +
    (fSort !== "newest" ? 1 : 0) + (fOnlyUnused ? 1 : 0)
  const clearFilters = () => {
    setFTypes([]); setFMinDur(""); setFMaxDur(""); setFSort("newest"); setFOnlyUnused(false)
  }

  // Bring back an archived bench (merged, so nothing currently picked is lost)
  const restoreSnapshot = (sn: WsSnapshot) => {
    if (extracting || preparing) return
    pushWsHistory(workingSet)
    setWorkingSet(prev => {
      const seen = new Set(prev.map(i => i.id))
      return [...prev, ...sn.items.filter(i => !seen.has(i.id))]
    })
    setHistOpen(false)
  }

  // Close the filters popup when tapping anywhere outside it
  useEffect(() => {
    if (!filtersOpen) return
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && !t.closest("[data-filters-panel]")) setFiltersOpen(false)
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [filtersOpen])

  useEffect(() => {
    if (!histOpen) return
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && !t.closest("[data-hist-panel]")) setHistOpen(false)
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [histOpen])

  // ── Persist the working set across reloads ──
  const wsRestoredRef = useRef(false)
  useEffect(() => {
    if (!authed || !wsRestoredRef.current) return   // never write before restoring
    try {
      if (workingSet.length === 0) localStorage.removeItem(WS_KEY)
      else localStorage.setItem(WS_KEY, JSON.stringify({
        v: 1,
        items: workingSet,
        activeId: active?.id ?? null,
      } satisfies SavedWorkingSet))
    } catch {
      // Quota or private mode. Say so — a silently unsaved bench is exactly
      // the failure that lost sources before.
      setError("Couldn't save the working set to this browser — it won't survive a reload.")
    }
  }, [authed, workingSet, active])

  useEffect(() => {
    if (!authed || wsRestoredRef.current) return
    wsRestoredRef.current = true
    const saved = loadSavedWorkingSet()
    if (!saved) return
    setWorkingSet(saved.items)
    // Reopen whatever was on the bench, so you come back to the same workspace
    const reopen = saved.items.find(i => i.id === saved.activeId) ?? saved.items[0]
    if (reopen) void switchActive(reopen, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed])

  // Batch actions pool every source's results (active + cached)
  const pooledResults = () => {
    const fr = [...frames]
    const cl = [...clips]
    for (const [id, v] of resultsCacheRef.current.entries()) {
      if (id === active?.id) continue
      fr.push(...v.frames)
      cl.push(...v.clips)
    }
    return { frames: fr, clips: cl }
  }

  // ── Extraction settings ──
  const [extractMode, setExtractMode] = useState<"frames" | "clips" | "both">("frames")
  const [interval_, setInterval_] = useState(0.5)
  const [frameFormat, setFrameFormat] = useState<"jpeg" | "png">("png")
  const [clipLen, setClipLen] = useState(3)
  const [clipEvery, setClipEvery] = useState(0)
  const [clipFormat, setClipFormat] = useState<"mp4" | "gif">("mp4")

  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<string | null>(null)
  const [frames, setFrames] = useState<StudioFrame[]>([])
  const [clips, setClips] = useState<StudioClip[]>([])
  const [sortBy, setSortBy] = useState<"quality" | "time">("quality")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const cancelRef = useRef(false)

  const extractFrames = async (): Promise<StudioFrame[]> => {
    const url = activePlayUrl!
    const v = document.createElement("video")
    v.muted = true; v.playsInline = true; v.crossOrigin = "anonymous"
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error("decode failed")); v.src = url })
    const step = Math.max(interval_, v.duration / MAX_FRAMES)
    const full = document.createElement("canvas")
    full.width = v.videoWidth; full.height = v.videoHeight
    const fctx = full.getContext("2d")!
    const sw = 320, sh = Math.max(2, Math.round(320 * v.videoHeight / Math.max(1, v.videoWidth)))
    const small = document.createElement("canvas")
    small.width = sw; small.height = sh
    const sctx = small.getContext("2d", { willReadFrequently: true })!
    const out: StudioFrame[] = []
    const seekTo = (t: number) => new Promise<void>(res => {
      const on = () => { v.removeEventListener("seeked", on); res() }
      v.addEventListener("seeked", on)
      v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05))
    })
    for (let t = 0; t < v.duration; t += step) {
      if (cancelRef.current) break
      await seekTo(t)
      fctx.drawImage(v, 0, 0)
      sctx.drawImage(v, 0, 0, sw, sh)
      const score = laplacianVariance(sctx.getImageData(0, 0, sw, sh).data, sw, sh)
      const blob = await new Promise<Blob | null>(res =>
        frameFormat === "png" ? full.toBlob(res, "image/png") : full.toBlob(res, "image/jpeg", 0.92))
      if (blob) out.push({ t, url: URL.createObjectURL(blob), blob, score, norm: 0 })
      setProgress(Math.min(1, (t + step) / v.duration))
    }
    return out
  }

  const extractClips = async (): Promise<StudioClip[]> => {
    if (!active) return []
    setPhase("Slicing on the server…")
    const res = await fetch("/api/admin/frames-clips", {
      method: "POST", headers: { "Content-Type": "application/json", ...ah() },
      signal: AbortSignal.timeout(290_000),
      body: JSON.stringify({ sourceUrl: active.url, clipLen, every: clipEvery > 0 ? clipEvery : clipLen, format: clipFormat }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.zipUrl) throw new Error(data.error || `Slicing failed (${res.status})`)
    setPhase("Downloading clips…")
    const zipRes = await fetch(data.zipUrl)
    if (!zipRes.ok) throw new Error("Could not download the clips")
    const { default: JSZip } = await import("jszip")
    const zip = await JSZip.loadAsync(await zipRes.arrayBuffer())
    const out: StudioClip[] = []
    for (const m of (data.clips || []) as { name: string; t: number; dur: number }[]) {
      const entry = zip.file(m.name)
      if (!entry) continue
      const kind = m.name.endsWith(".gif") ? "gif" as const : "mp4" as const
      const blob = new Blob([await entry.async("arraybuffer")], { type: kind === "gif" ? "image/gif" : "video/mp4" })
      out.push({ t: m.t, dur: m.dur, url: URL.createObjectURL(blob), blob, name: m.name, kind, score: 0, norm: 0 })
    }
    fetch(`/api/admin/frames-clips?url=${encodeURIComponent(data.zipUrl)}`, { method: "DELETE", headers: ah() }).catch(() => {})
    // Score mid-clip frames on the same sharpness metric as stills
    setPhase("Scoring clips…")
    await Promise.all(out.map(c => new Promise<void>(done => {
      const finish = (score: number) => { c.score = score; done() }
      const guard = setTimeout(() => finish(0), 8000)
      const measure = (el: HTMLVideoElement | HTMLImageElement, w0: number, h0: number) => {
        try {
          const sw = 320, sh = Math.max(2, Math.round(320 * h0 / Math.max(1, w0)))
          const cv = document.createElement("canvas")
          cv.width = sw; cv.height = sh
          const cx = cv.getContext("2d", { willReadFrequently: true })!
          cx.drawImage(el, 0, 0, sw, sh)
          clearTimeout(guard)
          finish(laplacianVariance(cx.getImageData(0, 0, sw, sh).data, sw, sh))
        } catch { clearTimeout(guard); finish(0) }
      }
      if (c.kind === "gif") {
        const im = new window.Image()
        im.onload = () => measure(im, im.naturalWidth, im.naturalHeight)
        im.onerror = () => { clearTimeout(guard); finish(0) }
        im.src = c.url
      } else {
        const v = document.createElement("video")
        v.muted = true; v.playsInline = true; v.preload = "auto"
        v.onloadeddata = () => { v.currentTime = Math.min(c.dur / 2, Math.max(0, (v.duration || c.dur) - 0.05)) }
        v.onseeked = () => measure(v, v.videoWidth, v.videoHeight)
        v.onerror = () => { clearTimeout(guard); finish(0) }
        v.src = c.url
      }
    })))
    setPhase(null)
    return out
  }

  const extract = async () => {
    if (!active || !activePlayUrl || extracting) return
    cancelRef.current = false
    setExtracting(true)
    // Drop ONLY this source's outgoing results from the selection — picks made
    // on other sources stay put so a batch can be assembled across many videos
    const dropped = new Set<string>([...frames.map(f => f.url), ...clips.map(c => c.url)])
    frames.forEach(f => URL.revokeObjectURL(f.url))
    clips.forEach(c => URL.revokeObjectURL(c.url))
    setFrames([]); setClips([])
    if (dropped.size > 0) setSelected(prev => new Set([...prev].filter(u => !dropped.has(u))))
    setProgress(0); setError(null)
    try {
      let clipsOut: StudioClip[] = []
      if (extractMode !== "frames") {
        try { clipsOut = await extractClips() } catch (e) {
          setPhase(null)
          setError(e instanceof Error ? e.message : "Clip extraction failed.")
          if (extractMode === "clips") { setExtracting(false); return }
        }
      }
      let framesOut: StudioFrame[] = []
      if (extractMode !== "clips") framesOut = await extractFrames()
      const allMax = Math.max(1, ...framesOut.map(f => f.score), ...clipsOut.map(c => c.score))
      framesOut.forEach(f => { f.norm = Math.round((f.score / allMax) * 100) })
      clipsOut.forEach(c => { c.norm = Math.round((c.score / allMax) * 100) })
      setFrames(framesOut)
      setClips(clipsOut)
      if (active) resultsCacheRef.current.set(active.id, { frames: framesOut, clips: clipsOut })
    } catch {
      setError("Extraction failed — MP4 (H.264) sources are safest.")
    } finally { setExtracting(false) }
  }

  // ── Result actions ──
  const toggleSel = (url: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(url)) next.delete(url); else next.add(url)
    return next
  })
  const [saveState, setSaveState] = useState<"idle" | "saving" | "done">("idle")
  const saveSelectedToDataset = async () => {
    if (!bucketId || selected.size === 0 || saveState === "saving") return
    setSaveState("saving")
    try {
      const pool = pooledResults()
      const picked: { blob: Blob; filename: string; mime: string }[] = [
        ...pool.frames.filter(f => selected.has(f.url)).map((f, i) => ({
          blob: f.blob,
          filename: `${active?.name.replace(/\.[a-z0-9]+$/i, "") ?? "frame"}-f${String(i + 1).padStart(2, "0")}-${f.t.toFixed(2)}s.${f.blob.type === "image/png" ? "png" : "jpg"}`,
          mime: f.blob.type || "image/jpeg",
        })),
        ...pool.clips.filter(c => selected.has(c.url)).map(c => ({
          blob: c.blob,
          filename: `${active?.name.replace(/\.[a-z0-9]+$/i, "") ?? "clip"}-${c.name}`,
          mime: c.kind === "gif" ? "image/gif" : "video/mp4",
        })),
      ]
      for (const it of picked) {
        const pre = await fetch("/api/admin/dataset/presign", {
          method: "POST", headers: { "Content-Type": "application/json", ...ah() },
          body: JSON.stringify({ files: [{ filename: it.filename, mimeType: it.mime }] }),
        })
        const { results } = await pre.json()
        const slot = results?.[0]
        if (!slot) continue
        const put = await fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": slot.normalizedMime }, body: it.blob })
        if (!put.ok) continue
        await fetch("/api/admin/dataset/record", {
          method: "POST", headers: { "Content-Type": "application/json", ...ah() },
          body: JSON.stringify({ bucketId, records: [{ imageUrl: slot.publicUrl, mimeType: slot.normalizedMime, filename: it.filename, width: 0, height: 0, meta: {} }] }),
        })
      }
      setSaveState("done")
      void loadLibrary()
    } catch {
      setError("Saving to the dataset failed — retry.")
      setSaveState("idle")
      return
    }
    setTimeout(() => setSaveState("idle"), 3000)
  }
  const [dlState, setDlState] = useState<"idle" | "zipping" | "done">("idle")
  const downloadSelected = async () => {
    if (selected.size === 0 || dlState === "zipping") return
    setDlState("zipping")
    try {
      const { default: JSZip } = await import("jszip")
      const zip = new JSZip()
      const pool = pooledResults()
      let fi = 0
      for (const f of pool.frames.filter(fr => selected.has(fr.url))) {
        fi++
        zip.file(`frame-${String(fi).padStart(2, "0")}-${f.t.toFixed(2)}s.${f.blob.type === "image/png" ? "png" : "jpg"}`, f.blob)
      }
      let ci = 0
      for (const c of pool.clips.filter(cl => selected.has(cl.url))) {
        ci++
        zip.file(`${String(ci).padStart(2, "0")}-${c.name}`, c.blob)
      }
      const blob = await zip.generateAsync({ type: "blob" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = selectedSourceCount > 1
        ? `slicing-studio-batch-${selectedSourceCount}-sources.zip`
        : `${(active?.name ?? "slices").replace(/\.[a-z0-9]+$/i, "")}-slices.zip`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
      setDlState("done")
    } catch { setDlState("idle"); return }
    setTimeout(() => setDlState("idle"), 3000)
  }

  // ── Big viewer ──
  const [viewing, setViewing] = useState<{ kind: "frame" | "clip"; url: string; label: string; isGif?: boolean } | null>(null)

  const scoreColor = (n: number) => n >= 75 ? "text-emerald-300 bg-emerald-500/20" : n >= 45 ? "text-amber-300 bg-amber-500/20" : "text-red-300 bg-red-500/20"

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#05080f] flex items-center justify-center p-6">
        <div className="relative isolate w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a101d] p-6 space-y-4">
          <SilverRim />
          <div className="flex items-center gap-3">
            <SiteLogoBox size={34} rounded={11} />
            <div>
              <p className="text-sm font-bold text-white">Slicing Studio</p>
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">Admin only</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Lock size={13} className="text-slate-500 shrink-0" />
            <input type="password" value={gatePw} onChange={e => setGatePw(e.target.value)}
              onKeyDown={e => e.key === "Enter" && unlock()}
              placeholder="Admin password"
              className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30" />
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

  // How much of the running batch came from where — drives the strip badges
  // and the batch summary line
  const selectedBySource = (() => {
    const m = new Map<number, number>()
    const tally = (id: number, urls: string[]) => {
      const n = urls.filter(u => selected.has(u)).length
      if (n > 0) m.set(id, n)
    }
    if (active) tally(active.id, [...frames.map(f => f.url), ...clips.map(c => c.url)])
    for (const [id, v] of resultsCacheRef.current.entries()) {
      if (id === active?.id) continue
      tally(id, [...v.frames.map(f => f.url), ...v.clips.map(c => c.url)])
    }
    return m
  })()
  const selectedSourceCount = selectedBySource.size
  const selectedHere = active ? (selectedBySource.get(active.id) ?? 0) : 0

  const mixed = [
    ...clips.map(c => ({ kind: "clip" as const, t: c.t, norm: c.norm, c, f: null as StudioFrame | null })),
    ...frames.map(f => ({ kind: "frame" as const, t: f.t, norm: f.norm, c: null as StudioClip | null, f })),
  ].sort((a, b) => sortBy === "quality" ? b.norm - a.norm : a.t - b.t)

  return (
    <div className="min-h-screen bg-[#05080f] text-white">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#05080f]/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/admin" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-xs text-slate-400 hover:text-white transition-all">
            <ArrowLeft size={12} /> Admin
          </Link>
          <SiteLogoBox size={26} rounded={9} />
          <div className="min-w-0">
            <p className="text-sm font-bold leading-none">Slicing Studio</p>
            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mt-1">frames · clips · gifs → dataset</p>
          </div>
          <div className="flex-1" />
          <button onClick={() => void loadLibrary()} disabled={libLoading}
            className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40">
            <RefreshCw size={13} className={libLoading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {error && <p className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">{error}</p>}

        {/* ── Library ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
          <SilverRim />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Source Library — dataset uploads</p>
            <div className="flex items-center gap-2">
              {/* ── Filters ── */}
              <div className="relative" data-filters-panel>
                <button onClick={() => setFiltersOpen(o => !o)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${
                    activeFilterCount > 0 || filtersOpen
                      ? "bg-white/15 border-white/30 text-white"
                      : "border-white/10 text-slate-400 hover:text-white"}`}>
                  <SlidersHorizontal size={11} />
                  Filters
                  {activeFilterCount > 0 && (
                    <span className="min-w-[15px] h-[15px] px-1 rounded-full bg-white text-black text-[9px] font-bold flex items-center justify-center">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                {filtersOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-40 w-[290px] p-3 space-y-3 rounded-xl border border-white/15 bg-[#0a101d] shadow-2xl shadow-black/60">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Sort</p>
                      {activeFilterCount > 0 && (
                        <button onClick={clearFilters} className="text-[10px] text-slate-500 hover:text-white transition-colors">Reset all</button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {([
                        ["newest", "Newest"], ["oldest", "Oldest"],
                        ["shortest", "Shortest"], ["longest", "Longest"],
                        ["name", "Name A→Z"],
                      ] as const).map(([v, label]) => (
                        <button key={v} onClick={() => setFSort(v)}
                          className={`px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                            fSort === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                          {label}
                        </button>
                      ))}
                    </div>

                    <div>
                      <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1.5">File type</p>
                      <div className="flex flex-wrap gap-1">
                        {availableExts.map(ext => {
                          const on = fTypes.includes(ext)
                          const n = allItems.filter(i => i.ext === ext).length
                          return (
                            <button key={ext} onClick={() => setFTypes(prev => on ? prev.filter(x => x !== ext) : [...prev, ext])}
                              className={`px-2 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                                on ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                              {ext} <span className="text-slate-600">{n}</span>
                            </button>
                          )
                        })}
                        {availableExts.length === 0 && <span className="text-[11px] text-slate-600">—</span>}
                      </div>
                      {fTypes.length === 0 && <p className="text-[9px] text-slate-600 mt-1">All types</p>}
                    </div>

                    <div>
                      <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1.5">Length (seconds)</p>
                      <div className="flex items-center gap-2">
                        <input value={fMinDur} onChange={e => setFMinDur(e.target.value.replace(/[^0-9.]/g, ""))}
                          inputMode="decimal" placeholder="min"
                          className="w-full px-2 py-1.5 rounded-lg bg-black/40 border border-white/15 text-[11px] font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-white/40" />
                        <span className="text-slate-600 text-[11px]">to</span>
                        <input value={fMaxDur} onChange={e => setFMaxDur(e.target.value.replace(/[^0-9.]/g, ""))}
                          inputMode="decimal" placeholder="max"
                          className="w-full px-2 py-1.5 rounded-lg bg-black/40 border border-white/15 text-[11px] font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-white/40" />
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {([["", "3", "under 3s"], ["3", "15", "3–15s"], ["15", "60", "15–60s"], ["60", "", "over 1m"]] as const).map(([lo, hi, label]) => (
                          <button key={label} onClick={() => { setFMinDur(lo); setFMaxDur(hi) }}
                            className={`px-2 py-1 rounded-lg border text-[10px] transition-colors ${
                              fMinDur === lo && fMaxDur === hi ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      {unprobedCount > 0 && (
                        <p className="text-[9px] text-slate-600 mt-1">
                          {unprobedCount} item{unprobedCount === 1 ? "" : "s"} have no length recorded yet — length filters keep them.
                        </p>
                      )}
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={fOnlyUnused} onChange={e => setFOnlyUnused(e.target.checked)}
                        className="accent-white w-3.5 h-3.5" />
                      <span className="text-[11px] text-slate-300">Hide sources already in the working set</span>
                    </label>

                    <p className="text-[10px] text-slate-500 pt-1 border-t border-white/10">
                      {libTotal} of {allItems.length} sources match
                    </p>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="video/*,image/gif" multiple className="hidden"
                onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) void uploadFiles(fs); e.target.value = "" }} />
              <button onClick={() => fileInputRef.current?.click()} disabled={!!uploading || !bucketId}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[11px] font-bold text-white hover:bg-white/15 transition-all disabled:opacity-50">
                {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                {uploading ? uploading : "Upload videos / GIFs"}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-slate-600">
            Everything here is stored permanently in the dataset&apos;s {UPLOADS_BUCKET_NAME} bucket (visible on /admin/dataset). No length budget — slicing handles up to {MAX_CLIP_SOURCE_SEC / 60} min per video.
          </p>
          {library.length === 0 && !libLoading ? (
            <p className="text-[12px] text-slate-600 py-6 text-center">No videos or GIFs yet — upload some above.</p>
          ) : (
            <>
              {/* Compact SCROLLING masonry of lightweight cached thumbnails —
                  tap toggles an item into the working set below */}
              <div ref={libScrollRef} className={`max-h-[450px] overflow-y-auto overscroll-contain pr-1 transition-opacity duration-200 ${libLoading ? "opacity-60" : ""}`}>
                {/* Row-major masonry: items are dealt across the columns so
                    reading order runs LEFT TO RIGHT, not down each column */}
                <div className="flex gap-1.5 items-start">
                  {toColumns(library, libCols).map((col, ci) => (
                    <div key={ci} className="flex-1 min-w-0">
                      {col.map((item, ri) => {
                        const inSet = workingSet.some(x => x.id === item.id)
                        const order = ri * libCols + ci
                        return (
                          <button key={item.id} onClick={() => toggleSource(item)} disabled={extracting || preparing}
                            title={`${item.name}${item.dur != null ? ` · ${fmtDur(item.dur)}` : ""} — tap to ${inSet ? "remove from" : "add to"} the working set`}
                            className={`relative block w-full mb-1.5 rounded-md overflow-hidden border-2 transition-all ${
                              inSet ? "border-white ring-1 ring-white/40" : "border-white/10 hover:border-white/30"}`}>
                            <MotionThumb item={item} className="w-full" idx={order} />
                            <span className="absolute top-0.5 left-0.5 px-1 py-0.5 rounded bg-black/70 text-cyan-300 text-[7px] font-mono font-bold leading-none pointer-events-none uppercase">
                              {item.ext || (item.isGif ? "gif" : "vid")}
                            </span>
                            {item.dur != null && (
                              <span className="absolute bottom-0.5 right-0.5 px-1 py-0.5 rounded bg-black/70 text-slate-300 text-[7px] font-mono leading-none pointer-events-none">
                                {fmtDur(item.dur)}
                              </span>
                            )}
                            {inSet && (
                              <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-white flex items-center justify-center pointer-events-none">
                                <Check size={8} className="text-black" />
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
              {/* Pagination — arrows, jump-to-page box, and ends */}
              <div className="flex items-center justify-center flex-wrap gap-1.5 pt-1">
                <button onClick={() => goToPage(1)} disabled={libPage <= 1}
                  title="First page"
                  className="px-2 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-30">
                  «
                </button>
                <button onClick={() => goToPage(libPage - 1)} disabled={libPage <= 1}
                  className="px-3 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-30">
                  ‹ Prev
                </button>
                <form onSubmit={e => { e.preventDefault(); jumpToPage() }} className="flex items-center gap-1.5 px-1">
                  <input
                    value={pageInput}
                    onChange={e => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                    onFocus={e => e.currentTarget.select()}
                    onBlur={() => setPageInput(String(libPage))}
                    inputMode="numeric"
                    aria-label="Jump to page"
                    disabled={libLoading}
                    className="w-12 px-1.5 py-1 rounded-md bg-black/40 border border-white/15 text-center text-[11px] font-mono text-white
                               focus:outline-none focus:border-white/40 disabled:opacity-40"
                  />
                  <span className="text-[11px] font-mono text-slate-500">/ {libTotalPages}</span>
                  <button type="submit" disabled={libLoading || pageInput === "" || Number(pageInput) === libPage}
                    className="px-2 py-1 rounded-md border border-white/10 text-[10px] font-mono uppercase tracking-wide text-slate-400
                               hover:text-white hover:border-white/30 transition-colors disabled:opacity-30">
                    Go
                  </button>
                </form>
                <button onClick={() => goToPage(libPage + 1)} disabled={libPage >= libTotalPages}
                  className="px-3 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-30">
                  Next ›
                </button>
                <button onClick={() => goToPage(libTotalPages)} disabled={libPage >= libTotalPages}
                  title="Last page"
                  className="px-2 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-30">
                  »
                </button>
                <span className="text-[11px] font-mono text-slate-600 pl-1">{libTotal} items</span>
              </div>
            </>
          )}
        </div>

        {/* ── Workspace ── */}
        {workingSet.length > 0 && (
          <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
            <SilverRim />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider truncate">
                Working set — {workingSet.length} source{workingSet.length === 1 ? "" : "s"}{active ? ` · ${active.name}${activeDuration ? ` (${activeDuration.toFixed(1)}s)` : ""}` : ""}
              </p>
              <div className="flex items-center gap-1 shrink-0">
                <div className="relative" data-hist-panel>
                  <button onClick={() => { setHistory(readWsHistory()); setHistOpen(o => !o) }}
                    title="Restore a previous working set"
                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wide text-slate-400 hover:text-white transition-colors">
                    <History size={11} /> Restore
                  </button>
                  {histOpen && (
                    <div className="absolute right-0 top-full mt-1.5 z-40 w-[250px] p-2 rounded-xl border border-white/15 bg-[#0a101d] shadow-2xl shadow-black/60 space-y-1">
                      <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500 px-1 pb-1">Previous sets</p>
                      {history.length === 0 && <p className="text-[11px] text-slate-600 px-1 pb-1">Nothing archived yet.</p>}
                      {history.map(sn => (
                        <button key={sn.at} onClick={() => restoreSnapshot(sn)}
                          className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-300 hover:text-white hover:border-white/30 transition-colors">
                          <span className="font-bold">{sn.items.length} sources</span>
                          <span className="text-slate-500 text-[10px]">{new Date(sn.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                        </button>
                      ))}
                      <p className="text-[9px] text-slate-600 px-1 pt-1 border-t border-white/10">Restoring merges into the current set.</p>
                    </div>
                  )}
                </div>
                <button onClick={clearWorkingSet} disabled={extracting || preparing}
                  title="Clear the whole working set"
                  className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors"><X size={13} /></button>
              </div>
            </div>
            {/* Selected sources — tap to switch (each keeps its own results), X to drop */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {workingSet.map(item => {
                const hasResults = (resultsCacheRef.current.get(item.id)?.frames.length || resultsCacheRef.current.get(item.id)?.clips.length
                  || (item.id === active?.id && (frames.length || clips.length))) ? true : false
                const picked = selectedBySource.get(item.id) ?? 0
                return (
                  <div key={item.id} className="relative shrink-0 group">
                    <button onClick={() => void switchActive(item)} disabled={extracting || preparing} title={item.name}
                      className={`block rounded-lg overflow-hidden border-2 transition-all ${
                        item.id === active?.id ? "border-white ring-1 ring-white/40" : "border-white/10 hover:border-white/30"}`}>
                      <MotionThumb item={item} className="h-14" />
                    </button>
                    <span className="absolute bottom-0.5 left-0.5 right-4 px-1 rounded bg-black/70 text-white text-[7px] font-mono leading-3 truncate pointer-events-none">
                      {item.isGif ? "GIF" : "VID"}{hasResults ? " ✓" : ""}
                    </span>
                    {picked > 0 && (
                      <span title={`${picked} selected from this source`}
                        className="absolute top-0.5 left-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-emerald-500 text-black text-[9px] font-bold
                                   flex items-center justify-center pointer-events-none">
                        {picked}
                      </span>
                    )}
                    <button onClick={() => removeFromSet(item.id)} disabled={extracting || preparing}
                      className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/80 flex items-center justify-center text-slate-400 hover:text-white transition-colors">
                      <X size={9} />
                    </button>
                  </div>
                )
              })}
            </div>
            {preparing ? (
              <div className="flex items-center gap-2 py-8 justify-center text-slate-500 text-sm"><Loader2 size={15} className="animate-spin" /> Preparing…</div>
            ) : activePlayUrl && (
              <>
                <video key={activePlayUrl} src={activePlayUrl} autoPlay loop controls muted playsInline preload="auto"
                  className="block mx-auto max-w-full rounded-xl bg-black" style={{ maxHeight: "min(50vh, 720px)" }} />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Extract</span>
                  <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                    {(["frames", "clips", "both"] as const).map(m => (
                      <button key={m} onClick={() => setExtractMode(m)} disabled={extracting}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          extractMode === m ? "bg-white/15 text-white" : "text-slate-500 hover:text-white"}`}>
                        {m === "frames" ? "Frames" : m === "clips" ? "Clips/GIFs" : "Both"}
                      </button>
                    ))}
                  </div>
                </div>
                {extractMode !== "clips" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Frame every</span>
                    {[0.1, 0.25, 0.5, 1, 2, 3, 5].map(v => (
                      <button key={v} onClick={() => setInterval_(v)} disabled={extracting}
                        className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                          interval_ === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                        {v}s
                      </button>
                    ))}
                    <span className="px-2.5 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px] font-mono text-slate-300">
                      ≈ {activeDuration > 0 ? Math.max(1, Math.ceil(activeDuration / Math.max(interval_, activeDuration / MAX_FRAMES))) : 0} frames
                    </span>
                    <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                      {(["jpeg", "png"] as const).map(f => (
                        <button key={f} onClick={() => setFrameFormat(f)} disabled={extracting}
                          className={`px-2.5 py-1 text-[11px] font-mono uppercase transition-colors ${
                            frameFormat === f ? "bg-white/15 text-white" : "text-slate-500 hover:text-white"}`}>
                          {f === "jpeg" ? "JPG" : "PNG"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {extractMode !== "frames" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Clip length</span>
                    {[1.5, 2, 3, 4, 5].map(v => (
                      <button key={v} onClick={() => setClipLen(v)} disabled={extracting}
                        className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                          clipLen === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                        {v}s
                      </button>
                    ))}
                    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 ml-1">every</span>
                    {[0, 5, 10, 15, 30].map(v => (
                      <button key={v} onClick={() => setClipEvery(v)} disabled={extracting}
                        className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                          clipEvery === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                        {v === 0 ? "b2b" : `${v}s`}
                      </button>
                    ))}
                    <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                      {(["mp4", "gif"] as const).map(f => (
                        <button key={f} onClick={() => setClipFormat(f)} disabled={extracting}
                          className={`px-2.5 py-1 text-[11px] font-mono uppercase transition-colors ${
                            clipFormat === f ? "bg-white/15 text-white" : "text-slate-500 hover:text-white"}`}>
                          {f}
                        </button>
                      ))}
                    </div>
                    <span className="px-2.5 py-1 rounded-lg border border-white/10 bg-white/[0.04] text-[11px] font-mono text-slate-300">
                      ≈ {activeDuration > 0 ? Math.min(40, Math.max(1, Math.ceil((activeDuration - 0.9) / (clipEvery > 0 ? clipEvery : clipLen)))) : 0} clips
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => void extract()} disabled={extracting}
                    className="px-4 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[12px] font-bold text-white hover:bg-white/15 transition-all disabled:opacity-50 flex items-center gap-1.5">
                    {extracting ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                    {extracting ? (phase ?? `Extracting… ${Math.round(progress * 100)}%`) : "Extract"}
                  </button>
                  {extracting && extractMode !== "clips" && (
                    <button onClick={() => { cancelRef.current = true }} className="px-2.5 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-500 hover:text-white">Stop</button>
                  )}
                </div>
                {extracting && !phase && (
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-slate-400 to-white rounded-full transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
                  </div>
                )}
              </>
            )}

            {/* Results */}
            {(frames.length > 0 || clips.length > 0) && (
              <>
                {selected.size > 0 && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/10">
                    <Check size={12} className="text-emerald-300 shrink-0" />
                    <span className="text-[11px] text-slate-300">
                      <span className="font-bold text-white">{selected.size}</span> in the batch
                      {selectedSourceCount > 1 && <> across <span className="font-bold text-white">{selectedSourceCount}</span> sources</>}
                      {selectedHere > 0 && selectedSourceCount > 1 && <span className="text-slate-500"> · {selectedHere} from this one</span>}
                    </span>
                    <span className="text-[10px] text-slate-500 ml-auto hidden sm:inline">Download / Save takes the whole batch</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
                      {clips.length > 0 ? `${clips.length} clips` : ""}{clips.length > 0 && frames.length > 0 ? " · " : ""}{frames.length > 0 ? `${frames.length} frames` : ""} · sort</span>
                    {(["quality", "time"] as const).map(v => (
                      <button key={v} onClick={() => setSortBy(v)}
                        className={`px-2.5 py-1 rounded-lg border text-[11px] transition-colors ${
                          sortBy === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                        {v === "quality" ? "Sharpest first" : "Timeline"}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setSelected(prev => new Set([...prev, ...mixed.slice(0, 10).map(m => m.kind === "clip" ? m.c!.url : m.f!.url)]))}
                      className="px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors">+ Top 10</button>
                    <button onClick={() => setSelected(prev => {
                      // Clear THIS source only; the rest of the batch survives
                      const mine = new Set([...frames.map(f => f.url), ...clips.map(c => c.url)])
                      return new Set([...prev].filter(u => !mine.has(u)))
                    })} disabled={selectedHere === 0}
                      className="px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-40">Clear here</button>
                    <button onClick={() => setSelected(new Set())} disabled={selected.size === 0}
                      className="px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-40">Clear all</button>
                    <button onClick={() => void downloadSelected()} disabled={selected.size === 0 || dlState === "zipping"}
                      className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                        dlState === "done" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "bg-white/10 border-white/25 text-white hover:bg-white/15 disabled:opacity-40"}`}>
                      {dlState === "zipping" ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                      {dlState === "done" ? "Saved!" : dlState === "zipping" ? "Zipping…" : `Download ${selected.size || ""}`}
                    </button>
                    <button onClick={() => void saveSelectedToDataset()} disabled={selected.size === 0 || saveState === "saving"}
                      className={`px-3.5 py-1.5 rounded-lg border text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                        saveState === "done" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "bg-white/10 border-white/25 text-white hover:bg-white/15 disabled:opacity-40"}`}>
                      {saveState === "saving" && <Loader2 size={11} className="animate-spin" />}
                      {saveState === "done" ? "Saved to dataset!" : `Save ${selected.size || ""} to dataset`}
                    </button>
                  </div>
                </div>
                {/* Row-major: dealt across columns so newest/sharpest reads
                    left-to-right along the top row, not down column one */}
                <div className="flex gap-2 items-start">
                  {toColumns(mixed, resCols).map((col, ci) => (
                  <div key={ci} className="flex-1 min-w-0">
                  {col.map(item => {
                    if (item.kind === "clip" && item.c) {
                      const c = item.c
                      const isSel = selected.has(c.url)
                      return (
                        <div key={c.url} className="relative group mb-2 break-inside-avoid">
                          <button onClick={() => toggleSel(c.url)} onDoubleClick={() => setViewing({ kind: "clip", url: c.url, label: `${c.name} · ${c.dur.toFixed(1)}s`, isGif: c.kind === "gif" })}
                            title="Tap to select · double-tap for large view"
                            className={`w-full rounded-lg overflow-hidden border-2 transition-all ${
                              isSel ? "border-white ring-1 ring-white/40" : "border-transparent hover:border-white/30"}`}>
                            {c.kind === "gif" ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img src={c.url} alt="" className="w-full h-auto block" loading="lazy" decoding="async" />
                            ) : (
                              <video src={c.url} muted loop autoPlay playsInline preload="metadata" className="w-full h-auto block pointer-events-none" />
                            )}
                          </button>
                          <span className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold leading-none pointer-events-none ${scoreColor(c.norm)}`}>{c.norm}</span>
                          <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-cyan-300 text-[9px] font-mono leading-none pointer-events-none uppercase">{c.kind} · {c.dur.toFixed(1)}s</span>
                          {isSel && <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white flex items-center justify-center pointer-events-none"><Check size={9} className="text-black" /></span>}
                        </div>
                      )
                    }
                    const f = item.f!
                    const isSel = selected.has(f.url)
                    return (
                      <div key={f.url} className="relative group mb-2 break-inside-avoid">
                        <button onClick={() => toggleSel(f.url)} onDoubleClick={() => setViewing({ kind: "frame", url: f.url, label: `frame @ ${f.t.toFixed(2)}s · quality ${f.norm}` })}
                          title="Tap to select · double-tap for large view"
                          className={`w-full rounded-lg overflow-hidden border-2 transition-all ${
                            isSel ? "border-white ring-1 ring-white/40" : "border-transparent hover:border-white/30"}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={f.url} alt="" className="w-full h-auto block" loading="lazy" decoding="async" />
                        </button>
                        <span className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold leading-none pointer-events-none ${scoreColor(f.norm)}`}>{f.norm}</span>
                        <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[9px] font-mono leading-none pointer-events-none">{f.t.toFixed(1)}s</span>
                        {isSel && <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white flex items-center justify-center pointer-events-none"><Check size={9} className="text-black" /></span>}
                      </div>
                    )
                  })}
                  </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Large viewer */}
      {viewing && (
        <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="relative isolate max-w-5xl w-full rounded-2xl border border-white/10 bg-[#070b14]/98 p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <SilverRim />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-mono text-slate-400 truncate">{viewing.label}</p>
              <button onClick={() => setViewing(null)} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06] transition-colors"><X size={15} /></button>
            </div>
            {viewing.kind === "clip" && !viewing.isGif ? (
              <video src={viewing.url} controls autoPlay loop muted playsInline className="block mx-auto max-w-full rounded-xl bg-black" style={{ maxHeight: "min(72vh, 940px)" }} />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={viewing.url} alt="" className="block mx-auto max-w-full rounded-xl" style={{ maxHeight: "min(72vh, 940px)" }} />
            )}
          </div>
        </div>
      )}

      {/* subtle brand footer */}
      <div className="max-w-6xl mx-auto px-4 pb-8 pt-2 flex items-center gap-2 text-slate-700">
        <Film size={11} />
        <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Slicing Studio · admin</span>
      </div>
    </div>
  )
}
