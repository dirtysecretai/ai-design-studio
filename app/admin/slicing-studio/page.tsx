"use client"

// ── Slicing Studio (ADMIN ONLY) ──────────────────────────────────────────────
// The Frame Extractor grown into a page: upload any number of videos/GIFs
// (no 2-minute budget), stored PERMANENTLY as dataset uploads (they appear on
// /admin/dataset in the __uploads__ bucket), then slice any of them into
// still frames and/or short clips/GIFs. Results save back into the dataset
// or download as a ZIP. Uploads ride presigned R2 PUTs (Vercel bodies cap at
// ~4.5MB) and slicing runs on the existing /api/admin/frames-clips route.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  ArrowLeft, Check, Download, Film, Loader2, Lock, Plus, RefreshCw, Trash2,
  Upload, X, Zap,
  SlidersHorizontal,
  History,
  ChevronDown,
  ChevronRight,
  Scissors,
  Play,
  Sparkles,
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
  kind?: "dataset" | "local"   // local = a movie file read in place off a drive
  path?: string                // absolute path, local sources only
  w?: number
  h?: number
  fps?: number
}

// Auto mode cuts several sizes of the same medium in one pass — e.g. ten 5s
// GIFs plus ten 3s GIFs — so each length is its own spec.
interface MediaSpec { id: string; count: number; len: number }

const isLocal = (i: { kind?: string } | null | undefined) => i?.kind === "local"

// Deterministic id from a path so the same movie keeps its identity across
// reloads (dataset rows are positive; local sources are negative)
function hashPath(p: string): number {
  let h = 2166136261
  for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 2_000_000_000
}

// A movie is sliced by SECTIONS: pick several ranges out of a two-hour film and
// extract each one with its own settings.
interface SectionCfg {
  mode: "frames" | "clips" | "both"
  every: number
  format: "jpeg" | "png"
  clipLen: number
  clipEvery: number
  clipFormat: "mp4" | "gif"
}

interface MovieSection {
  id: string
  start: number
  end: number
  label: string
  cfg: SectionCfg
  chosen?: boolean      // queued for "Extract selected"
  open?: boolean        // settings panel expanded
  busy?: boolean
  done?: { frames: number; clips: number }
}

const parseTime = (v: string): number | null => {
  // accepts 90 | 1:30 | 01:02:03(.5)
  const t = v.trim()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  const parts = t.split(":").map(x => x.trim())
  if (parts.length < 2 || parts.length > 3 || parts.some(x => x === "" || isNaN(Number(x)))) return null
  const nums = parts.map(Number)
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
}
// H:MM:SS.FF — the trailing pair is the frame within that second
const clockFrames = (sec: number, fps: number) => {
  const s = Math.max(0, sec)
  const whole = Math.floor(s)
  const f = Math.min(Math.round(fps) - 1, Math.floor((s - whole) * fps))
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), r = whole % 60
  const base = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`
  return `${base}.${String(f).padStart(2, "0")}`
}

const clockOf = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`
}
const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`

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
const LIB_OPEN_KEY = "slicing-studio-lib-open-v1"
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
      <img
        src={isLocal(item)
          ? `/api/admin/movies/poster?path=${encodeURIComponent(item.path || "")}&t=${Math.max(1, (item.dur ?? 60) * 0.15)}&w=320`
          : `/api/admin/dataset/thumb/${item.id}`}
        alt="" className={MEDIA_CLASS} loading="lazy" decoding="async" />
      {live && !failed && !isLocal(item) && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img key={seg} src={previewSrc(item.id, seg)} alt="" onError={onPreviewError}
          className={MEDIA_CLASS} decoding="async" />
      )}
    </span>
  )
}

function MovieTimeline({
  path, duration, fps, at, onAt, sections, selectedId, onSelect, onSectionChange, onScrubbing, snap, posterUrl, clock,
}: {
  path: string
  duration: number
  fps: number
  at: number
  onAt: (t: number) => void
  sections: MovieSection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onSectionChange: (id: string, patch: { start?: number; end?: number }) => void
  onScrubbing: (v: boolean) => void
  snap: (t: number) => number
  posterUrl: (p: string, t: number, w: number) => string
  clock: (t: number) => string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(0)
  const DEFAULT_ZOOM = 200
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)   // 1 = whole film fits the width
  const [scrollX, setScrollX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const tapRef = useRef<{ x: number; y: number } | null>(null)
  const zoomRef = useRef(1)
  const drag = useRef<
    | { kind: "playhead" }
    | { kind: "edge"; id: string; edge: "start" | "end" }
    | { kind: "move"; id: string; grab: number; span: number }
    | null
  >(null)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  // High enough that a thumbnail can be a single frame: at 8000s and 24fps
  // that needs a few thousand times magnification, and only the thumbnails in
  // view are ever mounted.
  const MAX_ZOOM = 4000
  const THUMB_W = 84
  const frameStep = 1 / Math.max(1, fps)
  const toFrame = (t: number) => Math.round(t / frameStep) * frameStep
  const contentW = Math.max(1, viewW * zoom)
  const contentWRef = useRef(contentW)
  useEffect(() => { contentWRef.current = contentW }, [contentW])
  const count = Math.max(6, Math.floor(contentW / THUMB_W))
  const step = duration / Math.max(1, count)
  const px = (t: number) => (t / Math.max(1e-6, duration)) * contentW

  useEffect(() => {
    setZoom(DEFAULT_ZOOM)
    pendingAnchor.current = null
    const el = scrollRef.current
    if (el) { el.scrollLeft = 0; setScrollX(0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(es => setViewW(es[0].contentRect.width))
    ro.observe(el)
    setViewW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // Only the frames near the viewport are mounted. At 40x a two-hour film is
  // thousands of thumbnails wide; rendering them all would ask the server for
  // every one of them.
  const first = Math.max(0, Math.floor((scrollX - viewW) / THUMB_W))
  const last = Math.min(count - 1, Math.ceil((scrollX + viewW * 2) / THUMB_W))

  const timeAtClientX = (clientX: number) => {
    const el = scrollRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const x = clientX - r.left + el.scrollLeft
    return Math.max(0, Math.min(duration, (x / Math.max(1, contentWRef.current)) * duration))
  }

  // Zoom about a fixed moment: whatever time sits under the cursor/pinch centre
  // stays put, so you magnify what you are looking at rather than the start.
  const pendingAnchor = useRef<{ time: number; clientX: number } | null>(null)
  const zoomAround = (next: number, anchorTime: number, clientX: number) => {
    const z = Math.max(1, Math.min(MAX_ZOOM, next))
    pendingAnchor.current = { time: anchorTime, clientX }
    setZoom(z)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = pendingAnchor.current
    if (!el || !a) return
    pendingAnchor.current = null
    const r = el.getBoundingClientRect()
    const w = Math.max(1, r.width * zoom)          // width is already applied here
    el.scrollLeft = (a.time / Math.max(1e-6, duration)) * w - (a.clientX - r.left)
    setScrollX(el.scrollLeft)
  }, [zoom, duration])

  // Pinch (iPad) and ctrl/⌘+wheel (trackpads). Touch listeners are non-passive
  // so a two-finger pinch zooms the strip instead of the page.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let startDist = 0, startZoom = 1, anchorTime = 0, anchorX = 0
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      drag.current = null
      onScrubbing(false)
      startDist = spread(e.touches)
      startZoom = zoomRef.current
      anchorX = (e.touches[0].clientX + e.touches[1].clientX) / 2
      anchorTime = timeAtClientX(anchorX)
    }
    const onTouchMove = (e: TouchEvent) => {
      // A handle drag must not also pan the strip — that tug of war is why a
      // section could only be stretched a little before the view ran away.
      if (drag.current && e.touches.length === 1) { e.preventDefault(); return }
      if (e.touches.length !== 2 || !startDist) return
      e.preventDefault()
      const ratio = spread(e.touches) / startDist
      if (Math.abs(ratio - 1) < 0.04) return                  // deadzone
      const damped = Math.pow(ratio, 0.8)                     // close to 1:1, minus the jitter
      const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2
      zoomAround(startZoom * damped, anchorTime, mid)
    }
    const onTouchEnd = () => { startDist = 0 }
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomAround(zoomRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12), timeAtClientX(e.clientX), e.clientX)
    }
    el.addEventListener("touchstart", onTouchStart, { passive: false })
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    el.addEventListener("touchend", onTouchEnd)
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("wheel", onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, viewW])

  // Keep the playhead on screen when it moves from outside (nudges, watch mode)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || drag.current) return
    const x = px(at)
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2)
      setScrollX(el.scrollLeft)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, zoom])

  const onDown = (e: React.PointerEvent) => {
    if (e.isPrimary === false) return          // second finger = pinch, not drag
    const el = e.target as HTMLElement
    tapRef.current = null
    if (el.dataset.playhead) {
      drag.current = { kind: "playhead" }
      setDragging(true)
      onScrubbing(true)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }
    const handle = el.dataset.handle
    const secId = el.dataset.sec
    if (handle && secId) {
      onSelect(secId)
      drag.current = { kind: "edge", id: secId, edge: handle as "start" | "end" }
      setDragging(true)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }
    if (el.dataset.move && secId) {
      const sec = sections.find(x => x.id === secId)
      if (sec) {
        onSelect(secId)
        drag.current = { kind: "move", id: secId, grab: timeAtClientX(e.clientX) - sec.start, span: sec.end - sec.start }
        setDragging(true)
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
    }
    // Tapping inside a section selects it, then falls through to seeking
    if (el.dataset.body && secId) onSelect(secId)
    // Bare strip: remember where the press landed. If the finger doesn't move,
    // it's a tap and we seek on release; if it does, it was a pan and the
    // playhead is left alone.
    tapRef.current = { x: e.clientX, y: e.clientY }
  }

  const onMove = (e: React.PointerEvent) => {
    const tap = tapRef.current
    if (tap && (Math.abs(e.clientX - tap.x) > 6 || Math.abs(e.clientY - tap.y) > 6)) {
      tapRef.current = null          // became a pan
    }
    const d = drag.current
    if (!d) return
    // Ease the view along only when a handle reaches the very edge, at a speed
    // that scales with how far past the margin you are — so extending a section
    // tracks your finger instead of racing ahead of it.
    const el = scrollRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const MARGIN = 32
      if (e.clientX < r.left + MARGIN) {
        el.scrollLeft -= Math.min(10, (r.left + MARGIN - e.clientX) / 4)
      } else if (e.clientX > r.right - MARGIN) {
        el.scrollLeft += Math.min(10, (e.clientX - (r.right - MARGIN)) / 4)
      }
    }
    const t = timeAtClientX(e.clientX)
    if (d.kind === "playhead") { onAt(toFrame(t)); return }
    const sec = sections.find(x => x.id === d.id)
    if (!sec) return
    if (d.kind === "edge") {
      if (d.edge === "start") onSectionChange(d.id, { start: Math.min(t, sec.end - 0.5) })
      else onSectionChange(d.id, { end: Math.max(t, sec.start + 0.5) })
    } else {
      const start = Math.max(0, Math.min(duration - d.span, t - d.grab))
      onSectionChange(d.id, { start, end: start + d.span })
    }
  }

  const onUp = (e: React.PointerEvent) => {
    if (tapRef.current) {
      onAt(toFrame(timeAtClientX(e.clientX)))
      tapRef.current = null
    }
    if (drag.current?.kind === "playhead") onScrubbing(false)
    // (dragging is cleared below for every drag kind)
    drag.current = null
    setDragging(false)
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const sel = sections.find(x => x.id === selectedId) ?? null
  // Zoomed in, thumbnails are closer together than the prefetched ladder, so
  // ask for the exact second instead of the nearest rung
  const frameTime = (i: number) => {
    const t = i * step + step / 2
    if (step >= 20) return snap(t)                 // far out: reuse the cached ladder
    if (step <= frameStep * 1.5) return toFrame(t) // frame-for-frame
    return Math.round(t * 10) / 10
  }
  const visibleSpan = duration / Math.max(1, zoom)

  return (
    <div className="select-none space-y-1">
      <div className="flex items-center gap-1.5">
        <button onClick={() => zoomAround(zoom / 2, at, (scrollRef.current?.getBoundingClientRect().left ?? 0) + (viewW / 2))}
          disabled={zoom <= 1}
          className="px-2 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors disabled:opacity-30">−</button>
        <button onClick={() => zoomAround(zoom * 2, at, (scrollRef.current?.getBoundingClientRect().left ?? 0) + (viewW / 2))}
          disabled={zoom >= MAX_ZOOM}
          className="px-2 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors disabled:opacity-30">+</button>
        <button onClick={() => { setZoom(1); requestAnimationFrame(() => { if (scrollRef.current) { scrollRef.current.scrollLeft = 0; setScrollX(0) } }) }}
          disabled={zoom === 1}
          className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wide text-slate-400 hover:text-white transition-colors disabled:opacity-30">Fit</button>
        {sel && (
          <button onClick={() => {
            const span = Math.max(1, sel.end - sel.start)
            zoomAround(Math.min(MAX_ZOOM, (duration / span) * 0.8), (sel.start + sel.end) / 2,
              (scrollRef.current?.getBoundingClientRect().left ?? 0) + viewW / 2)
          }}
            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wide text-slate-400 hover:text-white transition-colors">
            Fit section
          </button>
        )}
        <button
          onClick={() => {
            // one thumbnail per frame: contentW = frames * THUMB_W
            const z = Math.min(MAX_ZOOM, Math.max(1, (duration * fps * THUMB_W) / Math.max(1, viewW)))
            zoomAround(z, at, (scrollRef.current?.getBoundingClientRect().left ?? 0) + viewW / 2)
          }}
          title="Zoom until every frame is its own thumbnail"
          className="px-1.5 py-1 rounded-lg border border-white/10 text-[10px] font-mono text-slate-400 hover:text-white transition-colors">
          frames
        </button>
        {([5, 20, 60, 200, 600] as const).map(z => (
          <button key={z} onClick={() => zoomAround(z, at, (scrollRef.current?.getBoundingClientRect().left ?? 0) + viewW / 2)}
            title={`Zoom to ${z}× around the playhead`}
            className={`px-1.5 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
              Math.abs(zoom - z) < 0.5 ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
            {z}×
          </button>
        ))}
        <span className="text-[10px] font-mono text-slate-600">
          {zoom.toFixed(zoom < 10 ? 1 : 0)}× · {visibleSpan < 3 ? `${Math.round(visibleSpan * fps)} frames` : clock(visibleSpan)} across
        </span>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-slate-300">{clockFrames(at, fps)}</span>
      </div>

      <div ref={scrollRef}
        onScroll={e => setScrollX((e.currentTarget as HTMLDivElement).scrollLeft)}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        className="relative w-full h-[86px] rounded-lg overflow-x-auto overflow-y-hidden overscroll-x-contain bg-black cursor-pointer"
        style={{ touchAction: dragging ? "none" : "pan-x" }}>
        <div className="relative h-full" style={{ width: contentW }}>
          {/* Frames (windowed) */}
          {Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => {
            const i = first + k
            return (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img key={i} src={posterUrl(path, frameTime(i), 240)} alt=""
                className="absolute top-0 h-full object-cover pointer-events-none"
                style={{ left: (i * contentW) / count, width: contentW / count }}
                loading="lazy" decoding="async" draggable={false} />
            )
          })}
          {/* Sprocket holes, purely to read as film */}
          <div className="absolute inset-x-0 top-0 h-[7px] bg-black/85 pointer-events-none"
            style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent 0 6px, rgba(255,255,255,.5) 6px 11px, transparent 11px 17px)" }} />
          <div className="absolute inset-x-0 bottom-0 h-[7px] bg-black/85 pointer-events-none"
            style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent 0 6px, rgba(255,255,255,.5) 6px 11px, transparent 11px 17px)" }} />

          {/* Everything outside the selected section is dimmed */}
          {sel && (
            <>
              <div className="absolute top-0 bottom-0 left-0 bg-black/65 pointer-events-none" style={{ width: px(sel.start) }} />
              <div className="absolute top-0 bottom-0 bg-black/65 pointer-events-none"
                style={{ left: px(sel.end), width: Math.max(0, contentW - px(sel.end)) }} />
            </>
          )}

          {/* Sections */}
          {sections.map(secn => {
            const isSel = secn.id === selectedId
            return (
              <div key={secn.id} data-sec={secn.id} data-body="1"
                className={`absolute top-0 bottom-0 border-y-2 ${
                  isSel ? "border-white/80 bg-white/[0.06]" : "border-emerald-400/50 bg-emerald-400/[0.06] hover:bg-emerald-400/10"}`}
                style={{ left: px(secn.start), width: Math.max(2, px(secn.end) - px(secn.start)) }}>
                <span data-sec={secn.id} data-handle="start"
                  className={`absolute left-0 top-0 bottom-0 w-5 -ml-2.5 cursor-ew-resize flex items-center justify-center rounded-sm ${
                    isSel ? "bg-white" : "bg-emerald-400"}`}>
                  <span data-sec={secn.id} data-handle="start" className="w-[2px] h-5 bg-black/40 rounded" />
                </span>
                <span data-sec={secn.id} data-handle="end"
                  className={`absolute right-0 top-0 bottom-0 w-5 -mr-2.5 cursor-ew-resize flex items-center justify-center rounded-sm ${
                    isSel ? "bg-white" : "bg-emerald-400"}`}>
                  <span data-sec={secn.id} data-handle="end" className="w-[2px] h-5 bg-black/40 rounded" />
                </span>
                {isSel && (
                  <>
                    {/* Grab bar: the only way to slide a section, so the body
                        underneath stays free for panning and seeking */}
                    <span data-sec={secn.id} data-move="1" title="Drag to move this section"
                      className="absolute top-0 left-0 right-0 h-3 bg-white/70 hover:bg-white cursor-grab active:cursor-grabbing" />
                    <span className="absolute top-3 left-1/2 -translate-x-1/2 px-1.5 rounded-b bg-white text-black text-[9px] font-mono font-bold pointer-events-none whitespace-nowrap">
                      {clock(secn.start)} – {clock(secn.end)}
                    </span>
                  </>
                )}
              </div>
            )
          })}

          {/* Playhead — draggable. The line itself is thin, so the grab area
              around it is deliberately much wider than it looks. */}
          <div data-playhead="1"
            className="absolute top-0 bottom-0 w-7 -ml-3.5 cursor-ew-resize flex justify-center"
            style={{ left: px(at) }}>
            <span data-playhead="1" className="w-[2px] h-full bg-red-500" />
            <span data-playhead="1"
              className="absolute top-0 left-1/2 -translate-x-1/2 w-4 h-4 rounded-b-md bg-red-500 shadow-md shadow-black/50" />
          </div>
        </div>
      </div>
      <div className="flex justify-between text-[9px] font-mono text-slate-600">
        <span>{clock((scrollX / Math.max(1, contentW)) * duration)}</span>
        <span className="text-slate-500">{zoom > 1 ? "pinch to zoom · drag to pan" : "pinch to zoom in"}</span>
        <span>{clock(Math.min(duration, ((scrollX + viewW) / Math.max(1, contentW)) * duration))}</span>
      </div>
    </div>
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
  // Collapsing UNMOUNTS the grid, which is the point: every tile's observer,
  // preview request and animation goes with it, so the workspace below gets
  // the whole browser to itself.
  const [libOpen, setLibOpen] = useState(true)
  useEffect(() => {
    try { setLibOpen(localStorage.getItem(LIB_OPEN_KEY) !== "0") } catch {}
  }, [])
  const toggleLib = () => setLibOpen(o => {
    try { localStorage.setItem(LIB_OPEN_KEY, o ? "0" : "1") } catch {}
    return !o
  })
  const libCols = useColumnCount({ base: 3, sm: 5, lg: 8 })
  const resCols = useColumnCount({ base: 2, sm: 3, lg: 5 })
  const wsCols = useColumnCount({ base: 4, sm: 7, lg: 10 })
  const wsScrollRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const cancelBatchRef = useRef(false)
  const [wsOpen, setWsOpen] = useState(true)
  const [wsPickedOnly, setWsPickedOnly] = useState(false)

  // ── Movies: browse an attached drive, slice in place ──
  const MOVIE_DIR_KEY = "slicing-studio-movie-dir-v1"
  // Preferred home for movies, with a fallback for when the drive is detached
  const MOVIE_HOME = "F:\\Movies"
  const MOVIE_FALLBACK = "C:\\"
  const [moviesOpen, setMoviesOpen] = useState(false)
  const [movieDir, setMovieDir] = useState("")
  const [movieDirInput, setMovieDirInput] = useState("")
  const [movieRoots, setMovieRoots] = useState<string[]>([])
  const [movieFolders, setMovieFolders] = useState<{ name: string; path: string }[]>([])
  const [movieFiles, setMovieFiles] = useState<{ name: string; path: string; size: number; ext: string }[]>([])
  const [movieParent, setMovieParent] = useState<string | null>(null)
  const [movieBusy, setMovieBusy] = useState(false)
  const [scanned, setScanned] = useState<{ title: string; path: string; size: number; ext: string; duration: number; width: number; height: number; extras: number }[]>([])
  const [browseMode, setBrowseMode] = useState<"grid" | "files">("grid")
  const [movieErr, setMovieErr] = useState<string | null>(null)
  const [sections, setSections] = useState<Record<string, MovieSection[]>>({})
  const [scrubAt, setScrubAt] = useState(0)
  // Watching happens through short transcoded windows: the originals are MKV
  // with DTS audio, which no browser can play, and nobody should stream 40GB
  // to pick a moment.
  const [scrubbing, setScrubbing] = useState(false)
  const [selectedSection, setSelectedSection] = useState<string | null>(null)
  // Auto mode: survey a whole film and propose the moments worth pulling
  const [autoOpen, setAutoOpen] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoPhase, setAutoPhase] = useState<string | null>(null)
  const [autoProgress, setAutoProgress] = useState(0)
  const [autoNote, setAutoNote] = useState<string | null>(null)
  const [autoTarget, setAutoTarget] = useState(60)
  const [autoGap, setAutoGap] = useState(8)
  const [autoLook, setAutoLook] = useState<string[]>([])
  const [autoChars, setAutoChars] = useState("")
  const [autoStills, setAutoStills] = useState(true)
  const [clipSpecs, setClipSpecs] = useState<MediaSpec[]>([])
  const [gifSpecs, setGifSpecs] = useState<MediaSpec[]>([])
  const newId = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`
  const patchSpec = (
    set: React.Dispatch<React.SetStateAction<MediaSpec[]>>,
    id: string, patch: Partial<MediaSpec>,
  ) => set(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x))
  const [settledAt, setSettledAt] = useState(0)      // debounced position for the sharp frame
  const coarseLoaded = useRef<Set<number>>(new Set())
  const [watchAt, setWatchAt] = useState<number | null>(null)
  const [watchLen, setWatchLen] = useState(20)
  const [watchQuality, setWatchQuality] = useState(540)
  const watchRef = useRef<HTMLVideoElement>(null)
  // Absolute position in the FILM of whatever the preview window is showing
  const absNow = () => (watchAt ?? 0) + (watchRef.current?.currentTime ?? 0)


  const browseMovies = useCallback(async (dir: string, quiet = false): Promise<boolean> => {
    setMovieBusy(true)
    if (!quiet) setMovieErr(null)
    try {
      const res = await fetch(`/api/admin/movies?dir=${encodeURIComponent(dir)}`, { headers: ah() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Browse failed (${res.status})`)
      setMovieDir(data.dir); setMovieDirInput(data.dir)
      setMovieParent(data.parent ?? null)
      setMovieFolders(data.folders || []); setMovieFiles(data.files || [])
      setMovieErr(null)
      try { localStorage.setItem(MOVIE_DIR_KEY, data.dir) } catch {}
      return true
    } catch (e) {
      if (!quiet) {
        setMovieErr(e instanceof Error ? e.message : "Browse failed")
        setMovieFolders([]); setMovieFiles([])
      }
      return false
    } finally { setMovieBusy(false) }
  }, [])

  // Start where the movies actually live. If the external drive isn't plugged
  // in — or the last-used folder was on it — fall through to the next
  // candidate rather than opening on an error.
  const openFirstAvailable = useCallback(async (candidates: string[]) => {
    for (const dir of candidates.filter(Boolean)) {
      if (await browseMovies(dir, true)) return
    }
    setMovieErr("Couldn't open a starting folder — pick a drive above")
  }, [browseMovies])

  useEffect(() => {
    if (!authed || !moviesOpen || movieRoots.length > 0) return
    void (async () => {
      try {
        const r = await fetch("/api/admin/movies?roots=1", { headers: ah() })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || "Movie mode unavailable")
        setMovieRoots(d.roots || [])
        let saved = ""
        try { saved = localStorage.getItem(MOVIE_DIR_KEY) || "" } catch {}
        // The grid is the default view: scan the movies home (or wherever you
        // last were), and only fall back to file browsing if that root is gone.
        const home = saved || MOVIE_HOME
        void (async () => {
          const res = await fetch(`/api/admin/movies?scan=${encodeURIComponent(home)}`, { headers: ah() })
          if (res.ok) { const j = await res.json(); setScanned(j.movies || []); setMovieDir(j.root); setMovieDirInput(j.root); return }
          void openFirstAvailable([MOVIE_HOME, "F:\\", MOVIE_FALLBACK, (d.roots || [])[0] || ""])
          setBrowseMode("files")
        })()
      } catch (e) { setMovieErr(e instanceof Error ? e.message : "Movie mode unavailable") }
    })()
  }, [authed, moviesOpen, movieRoots.length, openFirstAvailable])

  const scanMovies = useCallback(async (root: string) => {
    setMovieBusy(true); setMovieErr(null)
    try {
      const res = await fetch(`/api/admin/movies?scan=${encodeURIComponent(root)}`, { headers: ah() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`)
      setScanned(data.movies || [])
      setMovieDir(data.root); setMovieDirInput(data.root)
      try { localStorage.setItem(MOVIE_DIR_KEY, data.root) } catch {}
    } catch (e) {
      setMovieErr(e instanceof Error ? e.message : "Scan failed")
      setScanned([])
    } finally { setMovieBusy(false) }
  }, [])

  // Adding a movie probes it for length/dimensions, then puts it on the bench
  // like any other source — the file itself never moves.
  const addMovie = async (f: { name: string; path: string; size: number; ext: string }) => {
    setMovieBusy(true); setMovieErr(null)
    try {
      const res = await fetch(`/api/admin/movies?probe=${encodeURIComponent(f.path)}`, { headers: ah() })
      const info = await res.json()
      if (!res.ok) throw new Error(info.error || "Could not read that file")
      const item: LibraryItem = {
        // Local sources need a stable id that can't collide with dataset rows
        id: -Math.abs(hashPath(f.path)),
        url: "", path: f.path, kind: "local",
        name: f.name,
        isGif: false,
        createdAt: new Date().toISOString(),
        ar: info.width && info.height ? info.width / info.height : 16 / 9,
        w: info.width || undefined,
        h: info.height || undefined,
        fps: info.fps || undefined,
        dur: info.duration || null,
        ext: f.ext,
        segs: 1,
      }
      setWorkingSet(prev => prev.some(x => x.id === item.id) ? prev : [...prev, item])
      setSections(prev => prev[item.id] ? prev : { ...prev, [item.id]: [] })
      void switchActive(item)
    } catch (e) {
      setMovieErr(e instanceof Error ? e.message : "Could not add that movie")
    } finally { setMovieBusy(false) }
  }
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

  // ~90 rungs across the film: fine enough that dragging feels continuous,
  // coarse enough that the whole ladder is cheap to prefetch.
  const COARSE_STEPS = 90
  const coarseStep = Math.max(1, Math.round((activeDuration || 1) / COARSE_STEPS))
  const snapCoarse = (t: number) => Math.max(0, Math.round(t / coarseStep) * coarseStep)
  const posterUrl = (pathStr: string, t: number, w: number) =>
    `/api/admin/movies/poster?path=${encodeURIComponent(pathStr)}&t=${t}&w=${w}`

  // Warm the ladder in the background whenever a movie is opened. Small frames,
  // a few at a time, so this never competes with what you actually asked for.
  useEffect(() => {
    if (!active || !isLocal(active) || !active.path || !activeDuration) return
    coarseLoaded.current = new Set()
    let cancelled = false
    // Warm a sparse ladder only — enough for instant scrub previews, few
    // enough that opening a movie doesn't spawn dozens of ffmpeg jobs and
    // stall the page. The timeline loads its own visible frames anyway.
    const RUNGS = 24
    const times = Array.from({ length: RUNGS }, (_, i) => snapCoarse((activeDuration / RUNGS) * i))
    let cursor = 0
    const pump = () => {
      if (cancelled || cursor >= times.length) return
      const t = times[cursor++]
      const im = new window.Image()
      im.onload = im.onerror = () => { coarseLoaded.current.add(t); setTimeout(pump, 120) }
      im.src = posterUrl(active.path!, t, 240)
    }
    pump()                                   // one at a time, gently
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, activeDuration])

  // The sharp frame follows the slider once it stops moving
  useEffect(() => {
    const id = setTimeout(() => setSettledAt(scrubAt), 140)
    return () => clearTimeout(id)
  }, [scrubAt])

  // …and a coarse frame keeps up WHILE it moves. Throttled to ~8/sec at one
  // second of granularity so a drag across the film asks for a manageable
  // number of small posters instead of one per pointer event.
  const [dragAt, setDragAt] = useState(0)
  const dragTick = useRef(0)
  useEffect(() => {
    const now = Date.now()
    if (now - dragTick.current < 120) return
    dragTick.current = now
    setDragAt(Math.round(scrubAt))
  }, [scrubAt])
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
    if (isLocal(item)) {
      // A movie is read in place by ffmpeg; there is nothing to download,
      // decode, or convert up front.
      setActiveDuration(item.dur ?? 0)
      setScrubAt(0)
      setWatchAt(null)
      // Start with the entire film as one section, so the strip is lit end to
      // end and you can slice it down rather than build sections from nothing.
      const full = item.dur ?? 0
      if (full > 0) {
        setSections(prev => {
          if (prev[item.id] && prev[item.id].length > 0) return prev
          const id = `full-${item.id}`
          setSelectedSection(id)
          return {
            ...prev,
            [item.id]: [{
              id, start: 0, end: full, label: "Whole film", chosen: true,
              cfg: { mode: extractMode, every: interval_, format: frameFormat, clipLen, clipEvery, clipFormat },
            }],
          }
        })
      }
      prepCacheRef.current.set(item.id, { playUrl: "", duration: item.dur ?? 0 })
      return
    }
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
      const wasAt = workingSet.findIndex(x => x.id === id)
      setActive(null); setActivePlayUrl(null); setActiveDuration(0)
      setFrames([]); setClips([])
      if (rest.length > 0) {
        const neighbour = rest[Math.min(Math.max(0, wasAt), rest.length - 1)]
        void switchActive(neighbour, false)
      }
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

  useEffect(() => {
    if (!active || !wsOpen) return
    const el = wsScrollRef.current?.querySelector(`[data-ws-tile="${active.id}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [active, wsOpen])

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
  const framesRef = useRef<StudioFrame[]>([])
  const clipsRef = useRef<StudioClip[]>([])
  useEffect(() => { framesRef.current = frames }, [frames])
  useEffect(() => { clipsRef.current = clips }, [clips])

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

  // Totals for the auto panel's calculators
  const clipTotals = clipSpecs.reduce((a, x) => ({ n: a.n + x.count, sec: a.sec + x.count * x.len }), { n: 0, sec: 0 })
  const gifTotals = gifSpecs.reduce((a, x) => ({ n: a.n + x.count, sec: a.sec + x.count * x.len }), { n: 0, sec: 0 })
  const activeItemIs4K = (active?.h ?? 0) >= 1400
  const autoTotals = (() => {
    // Rough per-file sizes: stills at source resolution, clips re-encoded to
    // 720p-ish (~0.18MB/s measured), GIFs at 480px/12fps (~0.8MB/s measured)
    const stillMb = frameFormat === "png" ? (activeItemIs4K ? 10 : 3) : (activeItemIs4K ? 2 : 0.5)
    const mb = (autoStills ? autoTarget * stillMb : 0) + clipTotals.sec * 0.18 + gifTotals.sec * 0.8
    return {
      items: (autoStills ? autoTarget : 0) + clipTotals.n + gifTotals.n,
      gb: mb / 1024,
    }
  })()

  // Pull a list of still timestamps in batches, straight into the feed
  const extractStills = async (movie: LibraryItem, times: number[]) => {
    const BATCH = 60
    for (let i = 0; i < times.length; i += BATCH) {
      if (cancelBatchRef.current) return
      const chunk = times.slice(i, i + BATCH)
      setPhase(`Stills ${i + 1}–${Math.min(i + BATCH, times.length)} of ${times.length}…`)
      const res = await fetch("/api/admin/movies/extract", {
        method: "POST", headers: { "Content-Type": "application/json", ...ah() },
        signal: AbortSignal.timeout(295_000),
        body: JSON.stringify({ path: movie.path, times: chunk, format: frameFormat }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.zipToken) throw new Error(data.error || `Stills failed (${res.status})`)
      const zipRes = await fetch(`/api/admin/movies/extract?zip=${data.zipToken}`, { headers: ah() })
      if (!zipRes.ok) throw new Error("Could not download the stills")
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(await zipRes.arrayBuffer())
      const batch: StudioFrame[] = []
      for (const m of (data.frames || []) as { name: string; t: number }[]) {
        const entry = zip.file(m.name)
        if (!entry) continue
        const type = m.name.endsWith(".png") ? "image/png" : "image/jpeg"
        // Hold the real blob: Download and Save to dataset both send it
        const blob = new Blob([await entry.async("arraybuffer")], { type })
        batch.push({ t: m.t, url: URL.createObjectURL(blob), blob, score: 0, norm: 0 })
      }
      fetch(`/api/admin/movies/extract?zip=${data.zipToken}`, { method: "DELETE", headers: ah() }).catch(() => {})
      setFrames(prev => {
        const merged = [...prev, ...batch]
        resultsCacheRef.current.set(movie.id, { frames: merged, clips: clipsRef.current })
        return merged
      })
    }
  }

  const runAuto = async (movie: LibraryItem) => {
    if (autoBusy || !movie.path) return
    setAutoBusy(true); setAutoNote(null); setError(null); setAutoProgress(0)
    setAutoPhase("Starting…")
    try {
      const res = await fetch("/api/admin/movies/auto", {
        method: "POST", headers: { "Content-Type": "application/json", ...ah() },
        body: JSON.stringify({
          path: movie.path,
          opts: {
            targetFrames: autoTarget, minGapSec: autoGap,
            look: autoLook, characters: autoChars,
          },
        }),
      })
      const started = await res.json()
      if (!res.ok || !started.jobId) throw new Error(started.error || "Could not start the scan")

      // Poll until it finishes — a feature-length scan runs for minutes
      for (;;) {
        await new Promise(r => setTimeout(r, 2000))
        const jr = await fetch(`/api/admin/movies/auto?job=${started.jobId}`, { headers: ah() })
        const j = await jr.json()
        if (!jr.ok) throw new Error(j.error || "Scan lost")
        setAutoPhase(j.phase); setAutoProgress(j.progress || 0)
        if (!j.done) continue
        if (j.error) throw new Error(j.error)
        if (j.note) setAutoNote(j.note)
        const moments: { t: number; tags: string[] }[] = j.result?.moments ?? []
        if (moments.length === 0) { setError("The scan found nothing to propose — try a wider filter."); break }

        const dur = movie.dur ?? Infinity
        const labelFor = (m: { tags: string[] }, kind: string, n: number) =>
          m.tags.length ? `${kind} ${n} · ${m.tags.slice(0, 2).join(", ")}` : `${kind} ${n}`
        // Clips and GIFs draw from a shared pool so two specs never land on
        // the same moment; stills still cover every proposal.
        const pool = [...moments]
        const takeSpread = (n: number) => {
          const want = Math.min(n, pool.length)
          if (want <= 0) return []
          const step = pool.length / want
          const idxs = Array.from({ length: want }, (_, i) => Math.floor(i * step))
          const picks = idxs.map(i => pool[i])
          for (const i of [...idxs].reverse()) pool.splice(i, 1)
          return picks
        }

        const built: MovieSection[] = []
        if (autoStills) {
          moments.forEach((m, i) => built.push({
            id: `auto-${started.jobId}-s${i}`,
            start: Math.max(0, m.t - 0.75),
            end: Math.min(dur, m.t + 0.75),
            label: labelFor(m, "Still", i + 1),
            chosen: true,
            cfg: { mode: "frames", every: 1, format: frameFormat, clipLen: 3, clipEvery: 0, clipFormat: "mp4" },
          }))
        }
        clipSpecs.forEach((spec, si) => {
          takeSpread(spec.count).forEach((m, i) => built.push({
            id: `auto-${started.jobId}-c${si}-${i}`,
            start: Math.max(0, m.t),
            end: Math.min(dur, m.t + spec.len),
            label: labelFor(m, `Clip ${spec.len}s`, i + 1),
            chosen: true,
            // span === clipLen, so the section yields exactly one clip
            cfg: { mode: "clips", every: 1, format: frameFormat, clipLen: spec.len, clipEvery: 0, clipFormat: "mp4" },
          }))
        })
        gifSpecs.forEach((spec, si) => {
          takeSpread(spec.count).forEach((m, i) => built.push({
            id: `auto-${started.jobId}-g${si}-${i}`,
            start: Math.max(0, m.t),
            end: Math.min(dur, m.t + spec.len),
            label: labelFor(m, `GIF ${spec.len}s`, i + 1),
            chosen: true,
            cfg: { mode: "clips", every: 1, format: frameFormat, clipLen: spec.len, clipEvery: 0, clipFormat: "gif" },
          }))
        })
        if (built.length === 0) { setError("Nothing to build — turn on stills, clips or GIFs."); break }
        built.sort((a, b) => a.start - b.start)
        // The placeholder whole-film section can't be extracted in one run —
        // take it out of the queue so it doesn't block the batch
        setSectionsFor(movie.id, list => [
          ...list.map(x => x.id.startsWith("full-") ? { ...x, chosen: false } : x),
          ...built,
        ])
        setAutoOpen(false)
        setAutoBusy(false); setAutoPhase(null)

        // Auto means auto: extract everything it proposed and land on the feed
        cancelBatchRef.current = false
        setExtracting(true)
        try {
          const stillTimes = moments.map(m => m.t)
          if (autoStills && stillTimes.length > 0) await extractStills(movie, stillTimes)
          const cuts = built.filter(b => b.cfg.mode === "clips")
          for (const [i, sec] of cuts.entries()) {
            if (cancelBatchRef.current) break
            setPhase(`${sec.label} — ${i + 1} of ${cuts.length}…`)
            await extractSection(movie, sec, true)
          }
        } finally {
          setExtracting(false); setPhase(null)
          resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
        break
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Auto scan failed")
    } finally {
      setAutoBusy(false); setAutoPhase(null); setAutoProgress(0)
    }
  }

  // Renumber plain sections after a split; auto-generated ones keep their names
  const renumber = (list: MovieSection[]) => {
    let n = 0
    return list.map(x => /^(Section \d+|Whole film)$/.test(x.label) ? { ...x, label: `Section ${++n}` } : x)
  }

  // Cut the section under the playhead in two, at the playhead
  const sliceAtPlayhead = (movie: LibraryItem) => {
    const list = sections[movie.id] ?? []
    const at = watchAt != null ? absNow() : scrubAt
    const inside = (x: MovieSection) => at > x.start + 0.2 && at < x.end - 0.2
    const target = list.find(x => x.id === selectedSection && inside(x)) ?? list.find(inside)
    if (!target) return
    const leftId = `${target.id}-a${Math.round(at)}`
    const rightId = `${target.id}-b${Math.round(at)}`
    setSectionsFor(movie.id, l => renumber(
      l.flatMap(x => x.id !== target.id ? [x] : [
        { ...x, id: leftId, end: at, done: undefined },
        { ...x, id: rightId, start: at, done: undefined },
      ]).sort((a, b) => a.start - b.start),
    ))
    setSelectedSection(leftId)
  }

  const setSectionsFor = (id: number, fn: (list: MovieSection[]) => MovieSection[]) =>
    setSections(prev => ({ ...prev, [id]: fn(prev[id] ?? []) }))

  // Runs ONE section. Results are appended, so several sections of the same
  // movie accumulate into one batch you can pick from and download together.
  // Runs every queued section back to back. Sequential on purpose: each run
  // already saturates ffmpeg, and results append in timeline order.
  const extractChosenSections = async (movie: LibraryItem) => {
    const queue = (sections[movie.id] ?? []).filter(x => x.chosen)
    if (queue.length === 0 || extracting) return
    cancelBatchRef.current = false
    for (const [i, sec] of queue.entries()) {
      if (cancelBatchRef.current) break
      setPhase(`Section ${i + 1} of ${queue.length}…`)
      await extractSection(movie, sec, true)
    }
    setPhase(null)
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const extractSection = async (movie: LibraryItem, sec: MovieSection, partOfBatch = false) => {
    if (extracting && !partOfBatch) return
    setExtracting(true); setError(null); setProgress(0)
    setSectionsFor(movie.id, list => list.map(x => x.id === sec.id ? { ...x, busy: true } : x))
    let tick: ReturnType<typeof setInterval> | undefined
    try {
      const t0 = Date.now()
      tick = setInterval(() => {
        setPhase(`Extracting ${sec.label}… ${Math.round((Date.now() - t0) / 1000)}s`)
      }, 1000)
      setPhase(`Extracting ${sec.label}…`)
      const res = await fetch("/api/admin/movies/extract", {
        method: "POST", headers: { "Content-Type": "application/json", ...ah() },
        signal: AbortSignal.timeout(295_000),
        body: JSON.stringify({
          path: movie.path, start: sec.start, end: sec.end,
          mode: sec.cfg.mode, every: sec.cfg.every, format: sec.cfg.format,
          clipLen: sec.cfg.clipLen,
          clipEvery: sec.cfg.clipEvery > 0 ? sec.cfg.clipEvery : sec.cfg.clipLen,
          clipFormat: sec.cfg.clipFormat,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.zipToken) throw new Error(data.error || `Extraction failed (${res.status})`)

      setPhase(`Downloading ${data.zipBytes ? `${Math.round(data.zipBytes / (1 << 20))}MB` : "results"}…`)
      const zipRes = await fetch(`/api/admin/movies/extract?zip=${data.zipToken}`, { headers: ah() })
      if (!zipRes.ok) throw new Error("Could not download the results")
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(await zipRes.arrayBuffer())

      const newFrames: StudioFrame[] = []
      for (const m of (data.frames || []) as { name: string; t: number }[]) {
        const entry = zip.file(m.name)
        if (!entry) continue
        const type = m.name.endsWith(".png") ? "image/png" : "image/jpeg"
        const blob = new Blob([await entry.async("arraybuffer")], { type })
        newFrames.push({ t: m.t, url: URL.createObjectURL(blob), blob, score: 0, norm: 0 })
      }
      const newClips: StudioClip[] = []
      for (const m of (data.clips || []) as { name: string; t: number; dur: number }[]) {
        const entry = zip.file(m.name)
        if (!entry) continue
        const kind = m.name.endsWith(".gif") ? "gif" as const : "mp4" as const
        const blob = new Blob([await entry.async("arraybuffer")], { type: kind === "gif" ? "image/gif" : "video/mp4" })
        newClips.push({ t: m.t, dur: m.dur, url: URL.createObjectURL(blob), blob, name: m.name, kind, score: 0, norm: 0 })
      }
      fetch(`/api/admin/movies/extract?zip=${data.zipToken}`, { method: "DELETE", headers: ah() }).catch(() => {})

      // Sharpness scoring is worth it on a normal haul but not on hundreds of
      // 1080p stills — past that, rank by time and skip the decode pass.
      if (newFrames.length > 0 && newFrames.length <= 120) {
        setPhase("Scoring frames…")
        await Promise.all(newFrames.map(f => new Promise<void>(done => {
          const im = new window.Image()
          const guard = setTimeout(() => done(), 8000)
          im.onload = () => {
            try {
              const sw = 320, sh = Math.max(2, Math.round(320 * im.naturalHeight / Math.max(1, im.naturalWidth)))
              const cv = document.createElement("canvas")
              cv.width = sw; cv.height = sh
              const cx = cv.getContext("2d", { willReadFrequently: true })!
              cx.drawImage(im, 0, 0, sw, sh)
              f.score = laplacianVariance(cx.getImageData(0, 0, sw, sh).data, sw, sh)
            } catch { /* leave unscored */ }
            clearTimeout(guard); done()
          }
          im.onerror = () => { clearTimeout(guard); done() }
          im.src = f.url
        })))
      }

      setFrames(prevF => {
        const merged = [...prevF, ...newFrames]
        const max = Math.max(1, ...merged.map(x => x.score))
        merged.forEach(x => { x.norm = Math.round((x.score / max) * 100) })
        resultsCacheRef.current.set(movie.id, { frames: merged, clips: clipsRef.current })
        return merged
      })
      setClips(prevC => {
        const merged = [...prevC, ...newClips]
        resultsCacheRef.current.set(movie.id, { frames: framesRef.current, clips: merged })
        return merged
      })
      setSectionsFor(movie.id, list => list.map(x => x.id === sec.id
        ? { ...x, busy: false, done: { frames: newFrames.length, clips: newClips.length } } : x))
      if (!partOfBatch) resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Section extraction failed")
      setSectionsFor(movie.id, list => list.map(x => x.id === sec.id ? { ...x, busy: false } : x))
    } finally {
      if (tick) clearInterval(tick)
      setExtracting(false); setPhase(null)
    }
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
  const durById = new Map(allItems.map(i => [i.id, i.dur]))
  const wsVisible = wsPickedOnly
    ? workingSet.filter(i => (selectedBySource.get(i.id) ?? 0) > 0)
    : workingSet

  const mixed = [
    ...clips.map(c => ({ kind: "clip" as const, t: c.t, norm: c.norm, c, f: null as StudioFrame | null })),
    ...frames.map(f => ({ kind: "frame" as const, t: f.t, norm: f.norm, c: null as StudioClip | null, f })),
  ].sort((a, b) => sortBy === "quality" ? b.norm - a.norm : a.t - b.t)

  return (
    <div className="min-h-screen bg-[#05080f] text-white overflow-x-hidden overscroll-x-none">
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
        {/* ── Movies: slice files on an attached drive, in place ── */}
        <div className="relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3">
          <SilverRim />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button onClick={() => setMoviesOpen(o => !o)} className="flex items-center gap-1.5 min-w-0 group">
              {moviesOpen
                ? <ChevronDown size={13} className="text-slate-500 group-hover:text-white transition-colors shrink-0" />
                : <ChevronRight size={13} className="text-slate-500 group-hover:text-white transition-colors shrink-0" />}
              <span className="text-xs font-semibold text-slate-400 group-hover:text-white uppercase tracking-wider transition-colors">
                Movies — slice from a drive
              </span>
              <span className="text-[10px] font-mono text-slate-600 shrink-0">no upload · no length limit</span>
            </button>
          </div>
          {moviesOpen && (
            <>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button onClick={() => { setBrowseMode(m => m === "grid" ? "files" : "grid"); if (browseMode === "files") void scanMovies(movieDir || MOVIE_HOME) }}
                  title="Switch between the movie grid and raw file browsing"
                  className="px-2 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors">
                  {browseMode === "grid" ? "Browse files" : "Movie grid"}
                </button>
                <button onClick={() => { setBrowseMode("grid"); void scanMovies(MOVIE_HOME) }}
                  title={`Scan ${MOVIE_HOME}`}
                  className={`px-2 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                    movieDir === MOVIE_HOME ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                  ★ Movies
                </button>
                {browseMode === "files" && movieRoots.map(r => (
                  <button key={r} onClick={() => void browseMovies(r)}
                    className={`px-2 py-1 rounded-lg border text-[11px] font-mono transition-colors ${
                      movieDir.startsWith(r) ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                    {r.replace(/\\$/, "")}
                  </button>
                ))}
                <form onSubmit={e => { e.preventDefault(); if (browseMode === "grid") void scanMovies(movieDirInput); else void browseMovies(movieDirInput) }}
                  className="flex-1 min-w-0 basis-[160px] flex items-center gap-1.5">
                  <input value={movieDirInput} onChange={e => setMovieDirInput(e.target.value)}
                    placeholder="F:\Movies"
                    className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-black/40 border border-white/15 text-[11px] font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-white/40" />
                  <button type="submit" disabled={movieBusy}
                    className="px-2.5 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-400 hover:text-white transition-colors disabled:opacity-40">
                    {movieBusy ? <Loader2 size={11} className="animate-spin" /> : "Go"}
                  </button>
                </form>
              </div>
              {movieErr && <p className="text-[11px] text-red-400">{movieErr}</p>}

              {browseMode === "grid" ? (
                <>
                  {/* One card per movie — the folder name is the title, and the
                      poster is pulled from a third of the way in, past logos */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                    {scanned.map(m => {
                      const onBench = workingSet.some(x => x.path === m.path)
                      return (
                        <button key={m.path}
                          onClick={() => {
                            const existing = workingSet.find(x => x.path === m.path)
                            if (existing) removeFromSet(existing.id)
                            else void addMovie({ name: m.title, path: m.path, size: m.size, ext: m.ext })
                          }}
                          disabled={movieBusy || extracting || preparing}
                          title={`${m.title} · ${fmtBytes(m.size)}${m.extras ? ` · ${m.extras} other file${m.extras === 1 ? "" : "s"} in folder` : ""} — tap to ${workingSet.some(x => x.path === m.path) ? "remove from" : "add to"} the working set`}
                          className={`group relative rounded-xl overflow-hidden border-2 text-left transition-all ${
                            onBench ? "border-emerald-400/70" : "border-white/10 hover:border-white/40"}`}>
                          <span className="relative block w-full bg-black" style={{ aspectRatio: "16/9" }}>
                            {m.duration > 0 && (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img src={`/api/admin/movies/poster?path=${encodeURIComponent(m.path)}&t=${Math.round(m.duration * 0.33)}&w=480`}
                                alt="" className="absolute inset-0 w-full h-full object-cover"
                                loading="lazy" decoding="async" />
                            )}
                            <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-mono text-slate-300">
                              {m.height >= 2000 ? "4K" : m.height >= 1000 ? "1080p" : `${m.height}p`}
                            </span>
                            {onBench && (
                              <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-emerald-400 flex items-center justify-center">
                                <Check size={10} className="text-black" />
                              </span>
                            )}
                          </span>
                          <span className="block px-2 py-1.5 bg-[#070c16]">
                            <span className="block text-[11px] font-bold text-white truncate group-hover:text-white">{m.title}</span>
                            <span className="block text-[9px] font-mono text-slate-500">
                              {m.duration ? `${Math.round(m.duration / 60)} min` : "—"} · {fmtBytes(m.size)} · {m.ext}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {scanned.length === 0 && !movieBusy && !movieErr && (
                    <p className="text-[11px] text-slate-600 py-4 text-center">
                      No movies found under {movieDir || MOVIE_HOME}. Try Browse files, or point the box above at another folder.
                    </p>
                  )}
                  {movieBusy && (
                    <p className="flex items-center justify-center gap-2 text-[11px] text-slate-500 py-4">
                      <Loader2 size={12} className="animate-spin" /> Reading folders…
                    </p>
                  )}
                </>
              ) : (
              <div className="max-h-[220px] overflow-y-auto overscroll-contain pr-1 space-y-1">
                {movieParent && (
                  <button onClick={() => void browseMovies(movieParent)}
                    className="w-full text-left px-2 py-1.5 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors">
                    ↑ ..
                  </button>
                )}
                {movieFolders.map(f => (
                  <button key={f.path} onClick={() => void browseMovies(f.path)}
                    className="w-full text-left px-2 py-1.5 rounded-lg border border-white/10 text-[11px] text-slate-300 hover:text-white hover:border-white/30 transition-colors truncate">
                    📁 {f.name}
                  </button>
                ))}
                {movieFiles.map(f => {
                  const onBench = workingSet.some(x => x.path === f.path)
                  return (
                    <button key={f.path} onClick={() => void addMovie(f)} disabled={movieBusy || onBench}
                      className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                        onBench ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-white/10 text-slate-300 hover:text-white hover:border-white/30"}`}>
                      <span className="truncate">🎬 {f.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">
                        {fmtBytes(f.size)}{onBench ? " · on bench" : ""}
                      </span>
                    </button>
                  )
                })}
                {!movieBusy && movieFolders.length === 0 && movieFiles.length === 0 && !movieErr && (
                  <p className="text-[11px] text-slate-600 py-3 text-center">Nothing here — pick a drive or type a folder.</p>
                )}
              </div>
              )}
              <p className="text-[10px] text-slate-600">
                {browseMode === "grid"
                  ? `${scanned.length} movie${scanned.length === 1 ? "" : "s"} under ${movieDir || MOVIE_HOME} — one card per folder, however deep the file sits. Read straight off the drive; nothing is uploaded or copied.`
                  : "Browsing raw folders. Read straight off the drive; nothing is uploaded or copied."}
              </p>
            </>
          )}
        </div>

        <div className={`relative isolate rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 space-y-3 ${filtersOpen ? "z-50" : ""}`}>
          <SilverRim />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button onClick={toggleLib}
              title={libOpen ? "Minimize the library — stops loading every tile" : "Expand the library"}
              className="flex items-center gap-1.5 min-w-0 group">
              {libOpen
                ? <ChevronDown size={13} className="text-slate-500 group-hover:text-white transition-colors shrink-0" />
                : <ChevronRight size={13} className="text-slate-500 group-hover:text-white transition-colors shrink-0" />}
              <span className="text-xs font-semibold text-slate-400 group-hover:text-white uppercase tracking-wider transition-colors truncate">
                Source Library{libOpen ? " — dataset uploads" : ""}
              </span>
              {!libOpen && (
                <span className="text-[10px] font-mono text-slate-600 shrink-0">
                  {libTotal}{activeFilterCount > 0 ? `/${allItems.length}` : ""} sources · minimized
                </span>
              )}
            </button>
            <div className="flex items-center gap-2">
              {/* ── Filters ── */}
              <div className={`relative ${libOpen ? "" : "hidden"}`} data-filters-panel>
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
                  <div className="absolute right-0 top-full mt-1.5 z-40 w-[min(290px,calc(100vw-2rem))] max-h-[min(70vh,520px)] overflow-y-auto overscroll-contain p-3 space-y-3 rounded-xl border border-white/15 bg-[#0a101d] shadow-2xl shadow-black/60">
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
          {libOpen && (
          <p className="text-[10px] text-slate-600">
            Everything here is stored permanently in the dataset&apos;s {UPLOADS_BUCKET_NAME} bucket (visible on /admin/dataset). No length budget — slicing handles up to {MAX_CLIP_SOURCE_SEC / 60} min per video.
          </p>
          )}
          {!libOpen ? null : library.length === 0 && !libLoading ? (
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
                    <div className="absolute right-0 top-full mt-1.5 z-40 w-[min(250px,calc(100vw-2rem))] p-2 rounded-xl border border-white/15 bg-[#0a101d] shadow-2xl shadow-black/60 space-y-1">
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
            {/* Selected sources — a scrolling mini-library rather than one long
                row: a 400-source bench is unusable as a horizontal strip. Same
                row-major masonry as the source library, denser tiles. */}
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => setWsOpen(o => !o)}
                className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500 hover:text-white transition-colors">
                {wsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {wsOpen ? "Sources" : `Sources · ${workingSet.length} hidden`}
              </button>
              {wsOpen && (
                <div className="flex items-center gap-2">
                  {/* Narrow the bench to sources you have picks from, so the
                      download batch can be reviewed source by source */}
                  <button onClick={() => setWsPickedOnly(v => !v)} disabled={selectedSourceCount === 0 && !wsPickedOnly}
                    title={wsPickedOnly ? "Show every source on the bench" : "Show only sources you have picked frames or clips from"}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors disabled:opacity-30 ${
                      wsPickedOnly ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300" : "border-white/10 text-slate-400 hover:text-white"}`}>
                    <Check size={10} />
                    Picked{selectedSourceCount > 0 ? ` ${selectedSourceCount}` : ""}
                  </button>
                  {wsVisible.length > wsCols * 3 && (
                    <span className="text-[10px] font-mono text-slate-600 hidden sm:inline">scroll for more</span>
                  )}
                </div>
              )}
            </div>
            {wsOpen && (
            <div ref={wsScrollRef} className="max-h-[260px] overflow-y-auto overscroll-contain pr-1">
              {wsVisible.length === 0 && (
                <p className="text-[11px] text-slate-600 py-4 text-center">
                  Nothing picked yet — select frames or clips and they will group here.
                </p>
              )}
              <div className="flex gap-1.5 items-start">
                {toColumns(wsVisible, wsCols).map((col, ci) => (
                  <div key={ci} className="flex-1 min-w-0">
                    {col.map((item, ri) => {
                      const hasResults = (resultsCacheRef.current.get(item.id)?.frames.length || resultsCacheRef.current.get(item.id)?.clips.length
                        || (item.id === active?.id && (frames.length || clips.length))) ? true : false
                      const picked = selectedBySource.get(item.id) ?? 0
                      return (
                        <div key={item.id} data-ws-tile={item.id} className="relative group mb-1.5">
                          <button onClick={() => void switchActive(item)} disabled={extracting || preparing}
                            title={`${item.name}${item.dur != null ? ` · ${fmtDur(item.dur)}` : ""}`}
                            className={`block w-full rounded-md overflow-hidden border-2 transition-all ${
                              item.id === active?.id ? "border-white ring-1 ring-white/40" : "border-white/10 hover:border-white/30"}`}>
                            <MotionThumb item={item} className="w-full" idx={ri * wsCols + ci} />
                          </button>
                          <span className="absolute bottom-0.5 left-0.5 right-0.5 px-1 rounded bg-black/70 text-white text-[7px] font-mono leading-3 truncate pointer-events-none">
                            {item.isGif ? "GIF" : "VID"}
                            {(item.dur ?? durById.get(item.id)) != null && (
                              <span className="text-slate-300"> · {fmtDur(item.dur ?? durById.get(item.id) ?? null)}</span>
                            )}
                            {hasResults ? " ✓" : ""}
                          </span>
                          {picked > 0 && (
                            <span title={`${picked} selected from this source`}
                              className="absolute top-0.5 left-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-emerald-500 text-black text-[9px] font-bold
                                         flex items-center justify-center pointer-events-none">
                              {picked}
                            </span>
                          )}
                          <button onClick={() => removeFromSet(item.id)} disabled={extracting || preparing}
                            title="Remove from the working set"
                            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/80 flex items-center justify-center text-slate-300
                                       hover:text-white transition-colors">
                            <X size={9} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
            )}
            {isLocal(active) && active ? (
              <div className="space-y-3">
                {/* Scrubber: server-rendered stills, because a 2-hour MKV can't
                    play in a browser and shouldn't need to */}
                <div className="relative rounded-xl overflow-hidden bg-black w-full"
                  style={{ height: "min(64vh, 780px)" }}>
                  {watchAt != null ? (
                    <video ref={watchRef} key={`${active.path}-${watchAt}-${watchLen}`}
                      src={`/api/admin/movies/preview?path=${encodeURIComponent(active.path || "")}&t=${watchAt}&len=${watchLen}&h=${watchQuality}`}
                      controls autoPlay playsInline
                      className="absolute inset-0 w-full h-full object-contain" />
                  ) : (
                    <>
                      {/* Tracking layer: small, one-second granularity, so it
                          follows the marker as you drag instead of jumping
                          between distant rungs */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={posterUrl(active.path || "", dragAt, 240)}
                        alt="" className="absolute inset-0 w-full h-full object-contain" />
                      {/* Exact frame, once you settle */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img key={settledAt} src={posterUrl(active.path || "", settledAt, 1280)}
                        alt="" className="absolute inset-0 w-full h-full object-contain"
                        style={{ opacity: scrubbing ? 0 : 1, transition: "opacity 90ms" }}
                        onLoad={e => { (e.currentTarget as HTMLImageElement).style.opacity = scrubbing ? "0" : "1" }} />
                    </>
                  )}
                  <span className="absolute bottom-1.5 left-1.5 px-2 py-1 rounded bg-black/75 text-white text-[11px] font-mono pointer-events-none">
                    {watchAt != null
                      ? `watching from ${clockOf(watchAt)}`
                      : `${clockFrames(scrubAt, active.fps || 24)} / ${clockOf(activeDuration)}`}
                  </span>
                  {watchAt != null && (
                    <button onClick={() => setWatchAt(null)}
                      className="absolute top-1.5 right-1.5 px-2 py-1 rounded-lg bg-black/75 text-[10px] font-mono text-slate-300 hover:text-white transition-colors">
                      stills
                    </button>
                  )}
                </div>


                <MovieTimeline
                  path={active.path || ""}
                  duration={activeDuration}
                  at={scrubAt}
                  onAt={t => { setWatchAt(null); setScrubAt(t) }}
                  sections={sections[active.id] ?? []}
                  selectedId={selectedSection}
                  onSelect={setSelectedSection}
                  onSectionChange={(id, patch) =>
                    setSectionsFor(active.id, list => list.map(x => x.id === id ? { ...x, ...patch } : x))}
                  onScrubbing={setScrubbing}
                  fps={active.fps || 24}
                  snap={snapCoarse}
                  posterUrl={posterUrl}
                  clock={clockOf}
                />
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[-1, 1].map(d => (
                    <button key={`f${d}`}
                      onClick={() => setScrubAt(v => {
                        const step = 1 / (active.fps || 24)
                        return Math.max(0, Math.min(activeDuration, Math.round((v + d * step) / step) * step))
                      })}
                      title={`${d > 0 ? "Next" : "Previous"} frame`}
                      className="px-2 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors">
                      {d > 0 ? "+1f" : "−1f"}
                    </button>
                  ))}
                  {[-60, -10, -1, 1, 10, 60].map(d => (
                    <button key={d} onClick={() => setScrubAt(v => Math.max(0, Math.min(activeDuration, v + d)))}
                      className="px-2 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-slate-400 hover:text-white transition-colors">
                      {d > 0 ? `+${d}s` : `${d}s`}
                    </button>
                  ))}
                  <button onClick={() => { setWatchAt(scrubAt) }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[11px] text-slate-300 hover:text-white transition-colors">
                    <Play size={10} /> Watch {watchLen}s
                  </button>
                  {([10, 20, 40] as const).map(l => (
                    <button key={l} onClick={() => setWatchLen(l)}
                      className={`px-1.5 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                        watchLen === l ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                      {l}s
                    </button>
                  ))}
                  {([360, 540, 720] as const).map(q => (
                    <button key={q} onClick={() => setWatchQuality(q)}
                      title={`Preview at ${q}p — higher takes a little longer to build`}
                      className={`px-1.5 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                        watchQuality === q ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-500 hover:text-white"}`}>
                      {q}p
                    </button>
                  ))}
                  {watchAt != null && (
                    <button onClick={() => { const a = absNow(); setWatchAt(null); setScrubAt(Math.round(a)) }}
                      title="Move the playhead to what you're watching"
                      className="px-2 py-1 rounded-lg border border-white/10 text-[10px] text-slate-400 hover:text-white transition-colors">
                      playhead = here
                    </button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => sliceAtPlayhead(active)}
                    disabled={!(sections[active.id] ?? []).some(x => {
                      const at = watchAt != null ? absNow() : scrubAt
                      return at > x.start + 0.2 && at < x.end - 0.2
                    })}
                    title="Split the section under the playhead in two, at the playhead"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-[11px] font-bold text-slate-200 hover:text-white hover:border-white/40 transition-all disabled:opacity-30">
                    <Scissors size={11} /> Slice here
                  </button>
                  <button onClick={() => {
                    const from = watchAt != null ? Math.round(absNow()) : scrubAt
                    const id = `${Date.now()}-${(sections[active.id] ?? []).length}`
                    setSectionsFor(active.id, list => [...list, {
                      id,
                      start: from,
                      end: Math.min(activeDuration, from + 30),
                      label: `Section ${list.length + 1}`,
                      chosen: true,
                      cfg: {
                        mode: extractMode, every: interval_, format: frameFormat,
                        clipLen, clipEvery, clipFormat,
                      },
                    }])
                    setSelectedSection(id)
                  }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[11px] font-bold text-white hover:bg-white/15 transition-all">
                    <Scissors size={11} /> Add section here
                  </button>
                </div>

                {/* ── Auto mode ── */}
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => setAutoOpen(o => !o)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-white">
                      {autoOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Sparkles size={11} /> Auto — survey the whole film
                    </button>
                    <span className="text-[10px] font-mono text-slate-500">
                      finds shots, drops duplicates{autoLook.length || autoChars ? `, keeps ${[...autoLook, autoChars].filter(Boolean).join(" / ")}` : ""}
                    </span>
                    <div className="flex-1" />
                    {autoBusy || extracting ? (
                      <>
                        <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                          <Loader2 size={11} className="animate-spin" />
                          {autoPhase || phase} {autoProgress > 0 && autoBusy ? `${Math.round(autoProgress * 100)}%` : ""}
                        </span>
                        <button onClick={() => { cancelBatchRef.current = true }}
                          className="px-2 py-1 rounded-lg border border-white/15 text-[10px] font-mono uppercase tracking-wide text-slate-300 hover:text-white transition-colors">
                          Stop
                        </button>
                      </>
                    ) : (
                      <button onClick={() => void runAuto(active)} disabled={extracting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[11px] font-bold text-white hover:bg-white/15 transition-all disabled:opacity-40">
                        <Sparkles size={11} /> Run auto
                      </button>
                    )}
                  </div>
                  {autoNote && <p className="text-[10px] text-amber-300/80">{autoNote}</p>}
                  {autoOpen && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">Moments</span>
                        {([25, 60, 120, 250, 400, 500] as const).map(v => (
                          <button key={v} onClick={() => setAutoTarget(v)}
                            className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                              autoTarget === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                            {v}
                          </button>
                        ))}
                        <input value={String(autoTarget)}
                          onChange={e => setAutoTarget(Math.min(500, Math.max(1, parseInt(e.target.value.replace(/\D/g, "")) || 1)))}
                          inputMode="numeric" title="Any number up to 500"
                          className="w-14 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 ml-2">Min gap</span>
                        {([0, 2, 4, 8, 20, 60] as const).map(v => (
                          <button key={v} onClick={() => setAutoGap(v)}
                            title={v === 0 ? "No spacing rule — keeps back-to-back cuts, like a shot/reverse-shot exchange" : `At least ${v}s between proposals`}
                            className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                              autoGap === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                            {v === 0 ? "none" : `${v}s`}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">Look for</span>
                        {(["characters", "landscape", "action", "closeup"] as const).map(w => (
                          <button key={w} onClick={() => setAutoLook(prev => prev.includes(w) ? prev.filter(x => x !== w) : [...prev, w])}
                            className={`px-2 py-1 rounded-lg border text-[10px] transition-colors ${
                              autoLook.includes(w) ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                            {w}
                          </button>
                        ))}
                        {autoLook.length === 0 && <span className="text-[9px] text-slate-600">nothing selected = keep every distinct shot</span>}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">Characters</span>
                        <input value={autoChars} onChange={e => setAutoChars(e.target.value)}
                          placeholder="e.g. Darth Vader, Yoda — only frames it recognises"
                          className="flex-1 min-w-0 basis-[140px] px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px] text-white placeholder:text-slate-600 focus:outline-none focus:border-white/40" />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">Stills</span>
                        <button onClick={() => setAutoStills(v => !v)}
                          className={`px-2 py-1 rounded-lg border text-[10px] transition-colors ${
                            autoStills ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                          {autoStills ? `on · ${autoTarget}` : "off"}
                        </button>
                        <span className="text-[9px] text-slate-600">one frame per proposed moment</span>
                      </div>

                      {/* Clips: whole scenes, 30s to 4 minutes — one row per size */}
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">Clips</span>
                          <button onClick={() => setClipSpecs(p => [...p, { id: newId(), count: 10, len: 60 }])}
                            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono text-slate-400 hover:text-white transition-colors">
                            + add size
                          </button>
                          {clipSpecs.length > 0 && (
                            <span className="text-[10px] font-mono text-slate-400">
                              = {clipTotals.n} clip{clipTotals.n === 1 ? "" : "s"} · {clockOf(clipTotals.sec)} of video
                            </span>
                          )}
                          {clipSpecs.length === 0 && <span className="text-[9px] text-slate-600">off — add a size to cut scenes</span>}
                        </div>
                        {clipSpecs.map(spec => (
                          <div key={spec.id} className="flex items-center gap-1.5 flex-wrap pl-20">
                            <input value={String(spec.count)}
                              onChange={e => patchSpec(setClipSpecs, spec.id, { count: Math.min(60, Math.max(1, parseInt(e.target.value.replace(/\D/g, "")) || 1)) })}
                              inputMode="numeric"
                              className="w-12 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                            <span className="text-[9px] text-slate-500">clips ×</span>
                            {([30, 60, 120, 240] as const).map(v => (
                              <button key={v} onClick={() => patchSpec(setClipSpecs, spec.id, { len: v })}
                                className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                                  spec.len === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                {v >= 60 ? `${v / 60}m` : `${v}s`}
                              </button>
                            ))}
                            <input value={String(spec.len)}
                              onChange={e => patchSpec(setClipSpecs, spec.id, { len: Math.min(240, Math.max(30, parseInt(e.target.value.replace(/\D/g, "")) || 30)) })}
                              inputMode="numeric" title="30–240 seconds"
                              className="w-12 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                            <span className="text-[9px] text-slate-600">sec</span>
                            <button onClick={() => setClipSpecs(p => p.filter(x => x.id !== spec.id))}
                              className="p-1 rounded-lg text-slate-500 hover:text-white transition-colors"><X size={10} /></button>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-20">GIFs</span>
                          <button onClick={() => setGifSpecs(p => [...p, { id: newId(), count: 10, len: 5 }])}
                            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono text-slate-400 hover:text-white transition-colors">
                            + add size
                          </button>
                          {gifSpecs.length > 0 && (
                            <span className="text-[10px] font-mono text-slate-400">
                              = {gifTotals.n} GIF{gifTotals.n === 1 ? "" : "s"} · {clockOf(gifTotals.sec)} of video
                            </span>
                          )}
                          {gifSpecs.length === 0 && <span className="text-[9px] text-slate-600">off — add a size to cut loops</span>}
                        </div>
                        {gifSpecs.map(spec => (
                          <div key={spec.id} className="flex items-center gap-1.5 flex-wrap pl-20">
                            <input value={String(spec.count)}
                              onChange={e => patchSpec(setGifSpecs, spec.id, { count: Math.min(60, Math.max(1, parseInt(e.target.value.replace(/\D/g, "")) || 1)) })}
                              inputMode="numeric"
                              className="w-12 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                            <span className="text-[9px] text-slate-500">GIFs ×</span>
                            {([2, 5, 10, 20] as const).map(v => (
                              <button key={v} onClick={() => patchSpec(setGifSpecs, spec.id, { len: v })}
                                className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                                  spec.len === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                {v}s
                              </button>
                            ))}
                            <input value={String(spec.len)}
                              onChange={e => patchSpec(setGifSpecs, spec.id, { len: Math.min(30, Math.max(1, parseInt(e.target.value.replace(/\D/g, "")) || 1)) })}
                              inputMode="numeric" title="1–30 seconds"
                              className="w-12 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                            <span className="text-[9px] text-slate-600">sec</span>
                            <button onClick={() => setGifSpecs(p => p.filter(x => x.id !== spec.id))}
                              className="p-1 rounded-lg text-slate-500 hover:text-white transition-colors"><X size={10} /></button>
                          </div>
                        ))}
                      </div>

                      {/* Grand total for the whole run */}
                      <div className="rounded-lg border border-white/15 bg-black/40 p-2 space-y-0.5">
                        <p className="text-[11px] text-white font-bold">
                          {autoStills ? `${autoTarget} stills` : "no stills"}
                          {clipTotals.n > 0 ? ` · ${clipTotals.n} clips` : ""}
                          {gifTotals.n > 0 ? ` · ${gifTotals.n} GIFs` : ""}
                          <span className="font-normal text-slate-400"> = {autoTotals.items} files</span>
                        </p>
                        <p className="text-[9px] font-mono text-slate-500">
                          ≈ {autoTotals.gb >= 1 ? `${autoTotals.gb.toFixed(1)} GB` : `${Math.round(autoTotals.gb * 1024)} MB`} to transfer
                          {" · "}{clockOf(clipTotals.sec + gifTotals.sec)} of video re-encoded
                          {" · "}{activeItemIs4K ? "4K source" : "1080p source"}, {frameFormat.toUpperCase()} stills
                        </p>
                        {autoTotals.gb > 8 && (
                          <p className="text-[9px] text-amber-300/80">
                            That is a lot to pull over the network — JPEG stills or fewer moments would cut it sharply.
                          </p>
                        )}
                      </div>

                      <p className="text-[9px] text-slate-600">
                        Scans at about 40× realtime — roughly {activeDuration ? Math.max(1, Math.round(activeDuration / 60 / 40)) : 3}–{activeDuration ? Math.max(2, Math.round(activeDuration / 60 / 15)) : 8} min for this film. Proposals land as sections you can review, trim, or delete before extracting.
                      </p>
                      <p className="text-[9px] text-slate-600">
                        {autoLook.length > 0 || autoChars.trim()
                          ? "Content filter ON — a sample of frames is sent to Gemini Flash-Lite for labelling (about 20 requests per film, fractions of a cent). Everything else runs locally."
                          : "Runs entirely on this machine — ffmpeg and image maths only, no API calls, no cost."}
                      </p>
                    </div>
                  )}
                </div>

                {(sections[active.id] ?? []).length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap px-0.5">
                    <button onClick={() => setSectionsFor(active.id, list => {
                      const allOn = list.every(x => x.chosen)
                      return list.map(x => ({ ...x, chosen: !allOn }))
                    })}
                      className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wide text-slate-400 hover:text-white transition-colors">
                      {(sections[active.id] ?? []).every(x => x.chosen) ? "Select none" : "Select all"}
                    </button>
                    <span className="text-[10px] font-mono text-slate-500">
                      {(sections[active.id] ?? []).filter(x => x.chosen).length} of {(sections[active.id] ?? []).length} queued
                    </span>
                    {(frames.length > 0 || clips.length > 0) && (
                      <button onClick={() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                        className="px-2 py-1 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wide text-emerald-300 hover:text-white transition-colors">
                        ↓ {frames.length + clips.length} results
                      </button>
                    )}
                    <div className="flex-1" />
                    <button onClick={() => void extractChosenSections(active)}
                      disabled={extracting || (sections[active.id] ?? []).filter(x => x.chosen).length === 0}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[11px] font-bold text-white hover:bg-white/15 transition-all disabled:opacity-40">
                      {extracting ? <Loader2 size={11} className="animate-spin" /> : <Scissors size={11} />}
                      Extract selected ({(sections[active.id] ?? []).filter(x => x.chosen).length})
                    </button>
                  </div>
                )}

                {/* Each section carries its own settings and can run alone.
                    Scrolls internally: auto mode can propose hundreds, and the
                    results feed below must stay reachable. */}
                <div className={`space-y-2 ${(sections[active.id] ?? []).length > 6 ? "max-h-[460px] overflow-y-auto overscroll-contain pr-1" : ""}`}>
                  {(sections[active.id] ?? []).length === 0 && (
                    <p className="text-[11px] text-slate-600 py-2 text-center">
                      No sections yet — scrub to a moment and add one. Extract as many as you like; the results pool into one batch.
                    </p>
                  )}
                  {(sections[active.id] ?? []).map(sec => {
                    const span = Math.max(0, sec.end - sec.start)
                    const est = sec.cfg.mode === "clips" ? 0 : Math.floor(span / Math.max(0.05, sec.cfg.every))
                    const patchCfg = (patch: Partial<SectionCfg>) =>
                      setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, cfg: { ...x.cfg, ...patch } } : x))
                    return (
                      <div key={sec.id} onPointerDown={() => setSelectedSection(sec.id)}
                        className={`rounded-xl border p-2.5 space-y-2 transition-colors ${
                          sec.id === selectedSection ? "border-white/40 bg-white/[0.07]" : "border-white/10 bg-white/[0.03]"}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <input type="checkbox" checked={!!sec.chosen}
                            onChange={e => setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, chosen: e.target.checked } : x))}
                            title="Include this section when running all selected"
                            className="accent-white w-3.5 h-3.5" />
                          <span className="text-[11px] font-bold text-white truncate max-w-[45%]">{sec.label}</span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {clockOf(sec.start)} → {clockOf(sec.end)} · {span >= 60 ? `${(span / 60).toFixed(1)} min` : `${Math.round(span)}s`}
                            {est > 0 ? ` · ~${est} frames` : ""}
                            {sec.cfg.mode !== "frames" ? ` · ${sec.cfg.clipFormat}` : ""}
                          </span>
                          <div className="flex-1" />
                          {sec.done && (
                            <span className="text-[10px] font-mono text-emerald-300">
                              +{sec.done.frames}f{sec.done.clips ? ` +${sec.done.clips}c` : ""}
                            </span>
                          )}
                          <button onClick={() => setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, open: !x.open } : x))}
                            title="Extraction settings for this section"
                            className={`px-2 py-1 rounded-lg border text-[10px] font-mono uppercase tracking-wide transition-colors ${
                              sec.open ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                            {sec.cfg.mode === "both" ? "frames+clips" : sec.cfg.mode} · {sec.cfg.every}s
                          </button>
                          <button onClick={() => setSectionsFor(active.id, list => list.filter(x => x.id !== sec.id))}
                            disabled={sec.busy}
                            className="p-1 rounded-lg text-slate-500 hover:text-white transition-colors"><X size={11} /></button>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <input defaultValue={clockOf(sec.start)} onBlur={e => {
                            const v = parseTime(e.target.value)
                            if (v == null) { e.target.value = clockOf(sec.start); return }
                            setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, start: Math.min(v, x.end - 0.5) } : x))
                          }}
                            className="w-[86px] px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[11px] font-mono text-white focus:outline-none focus:border-white/40" />
                          <span className="text-slate-600 text-[11px]">→</span>
                          <input defaultValue={clockOf(sec.end)} onBlur={e => {
                            const v = parseTime(e.target.value)
                            if (v == null) { e.target.value = clockOf(sec.end); return }
                            setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, end: Math.max(v, x.start + 0.5) } : x))
                          }}
                            className="w-[86px] px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[11px] font-mono text-white focus:outline-none focus:border-white/40" />
                          <button onClick={() => { const at = watchAt != null ? Math.round(absNow()) : scrubAt
                            setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, start: Math.min(at, x.end - 0.5) } : x)) }}
                            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] text-slate-400 hover:text-white transition-colors">start = here</button>
                          <button onClick={() => { const at = watchAt != null ? Math.round(absNow()) : scrubAt
                            setSectionsFor(active.id, list => list.map(x => x.id === sec.id ? { ...x, end: Math.max(at, x.start + 0.5) } : x)) }}
                            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] text-slate-400 hover:text-white transition-colors">end = here</button>
                          <button onClick={() => { setWatchAt(null); setScrubAt(sec.start) }}
                            className="px-2 py-1 rounded-lg border border-white/10 text-[10px] text-slate-400 hover:text-white transition-colors">go to</button>
                          <button onClick={() => setWatchAt(sec.start)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-white/10 text-[10px] text-slate-400 hover:text-white transition-colors">
                            <Play size={9} /> watch
                          </button>
                          <div className="flex-1" />
                          {(span > 3600 || est > 1500) && (
                            <span className="text-[9px] text-amber-300/80">
                              {span > 3600 ? "over 60 min — slice it smaller" : `${est} frames — raise the interval or slice it`}
                            </span>
                          )}
                          <button onClick={() => void extractSection(active, sec)}
                            disabled={extracting || span <= 0 || span > 3600 || est > 1500}
                            title={span > 3600 || est > 1500 ? "Too much for one run — slice this section or widen the frame interval" : "Extract this section"}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-[11px] font-bold text-white hover:bg-white/15 transition-all disabled:opacity-40">
                            {sec.busy ? <Loader2 size={11} className="animate-spin" /> : <Scissors size={11} />}
                            {sec.busy ? "Extracting…" : "Extract"}
                          </button>
                        </div>

                        {/* Per-section settings — the same knobs a normal
                            source gets, so each range can be pulled
                            differently (stills here, gifs there) */}
                        {sec.open && (
                          <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-16">Extract</span>
                              {(["frames", "clips", "both"] as const).map(m => (
                                <button key={m} onClick={() => patchCfg({ mode: m })}
                                  className={`px-2 py-1 rounded-lg border text-[10px] transition-colors ${
                                    sec.cfg.mode === m ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                  {m === "both" ? "frames + clips" : m}
                                </button>
                              ))}
                            </div>
                            {sec.cfg.mode !== "clips" && (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-16">Frame every</span>
                                {([0.1, 0.25, 0.5, 1, 2, 5] as const).map(v => (
                                  <button key={v} onClick={() => patchCfg({ every: v })}
                                    className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                                      sec.cfg.every === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                    {v}s
                                  </button>
                                ))}
                                <input value={String(sec.cfg.every)}
                                  onChange={e => patchCfg({ every: Math.max(0.05, parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 1) })}
                                  inputMode="decimal"
                                  className="w-14 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                                {(["png", "jpeg"] as const).map(f => (
                                  <button key={f} onClick={() => patchCfg({ format: f })}
                                    className={`px-2 py-1 rounded-lg border text-[10px] font-mono uppercase transition-colors ${
                                      sec.cfg.format === f ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                    {f}
                                  </button>
                                ))}
                              </div>
                            )}
                            {sec.cfg.mode !== "frames" && (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[9px] font-mono uppercase tracking-wider text-slate-500 w-16">Clips</span>
                                <span className="text-[10px] text-slate-500">length</span>
                                <input value={String(sec.cfg.clipLen)}
                                  onChange={e => patchCfg({ clipLen: Math.max(0.5, parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 3) })}
                                  inputMode="decimal"
                                  className="w-14 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                                <span className="text-[10px] text-slate-500">every</span>
                                {([0, 5, 10, 15, 30] as const).map(v => (
                                  <button key={v} onClick={() => patchCfg({ clipEvery: v })}
                                    title={v === 0 ? "Back to back — no gap between clips" : `A clip every ${v}s`}
                                    className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                                      sec.cfg.clipEvery === v ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                    {v === 0 ? "b2b" : `${v}s`}
                                  </button>
                                ))}
                                <input value={String(sec.cfg.clipEvery)}
                                  onChange={e => patchCfg({ clipEvery: Math.max(0, parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 0) })}
                                  inputMode="decimal"
                                  className="w-12 px-1.5 py-1 rounded-lg bg-black/40 border border-white/15 text-center text-[10px] font-mono text-white focus:outline-none focus:border-white/40" />
                                {(["mp4", "gif"] as const).map(f => (
                                  <button key={f} onClick={() => patchCfg({ clipFormat: f })}
                                    className={`px-2 py-1 rounded-lg border text-[10px] font-mono uppercase transition-colors ${
                                      sec.cfg.clipFormat === f ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-slate-400 hover:text-white"}`}>
                                    {f}
                                  </button>
                                ))}
                              </div>
                            )}
                            {(() => {
                              const nClips = sec.cfg.mode === "frames" ? 0
                                : Math.min(60, Math.max(1, Math.floor(span / Math.max(sec.cfg.clipLen, sec.cfg.clipEvery || sec.cfg.clipLen))))
                              const nFrames = sec.cfg.mode === "clips" ? 0 : est
                              // 1080p: PNG lands around 3MB a frame, JPEG about 0.4MB
                              const mb = Math.round(nFrames * (sec.cfg.format === "png" ? 3 : 0.4) + nClips * 1.2)
                              return (
                                <p className="text-[9px] text-slate-600">
                                  ≈ {nFrames > 0 ? `${nFrames} ${sec.cfg.format.toUpperCase()} frames` : ""}
                                  {nFrames > 0 && nClips > 0 ? " + " : ""}
                                  {nClips > 0 ? `${nClips} ${sec.cfg.clipFormat.toUpperCase()} clips${sec.cfg.clipEvery === 0 ? " (back to back)" : ""}` : ""}
                                  {` · ~${mb}MB to transfer`}
                                  {mb > 400 ? " — consider JPEG or a wider interval" : ""}
                                </p>
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : preparing ? (
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
            <div ref={resultsRef} />
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
