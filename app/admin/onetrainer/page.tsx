"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft, Play, Square, Loader2, CheckCircle, AlertCircle,
  Plus, Trash2, FolderOpen, ChevronDown, RefreshCw, Cpu,
  Circle, Zap, Terminal, Settings2, BookOpen, X,
  Cloud, Upload, HardDrive, ExternalLink,
  Sparkles, Eye, Maximize2, Minimize2, ChevronLeft, ChevronRight, Check, Clock,
} from "lucide-react"
import { SiteLogoBox } from "@/components/SitePageHeader"
import { AUTOFILL_MODELS, autofillModelLabel } from '@/lib/autofill-models'

// Portal design system: animated silver rim used for selected/highlight chrome
const SILVER_RIM_CONIC =
  "conic-gradient(from 0deg, rgba(226,232,240,0.1), #f8fafc, #94a3b8, rgba(226,232,240,0.15), #cbd5e1, #64748b, rgba(226,232,240,0.1))"

// Solid silver ring with a travelling break — same as the portal-v2 popups
const SILVER_ORBIT_CONIC =
  "conic-gradient(from 0deg, #cbd5e1 0deg, #cbd5e1 330deg, rgba(203,213,225,0) 340deg, rgba(203,213,225,0) 350deg, #cbd5e1 360deg)"

// Silver orbit ring that hugs the RENDERED media box (copied from portal-v2):
// object-contain leaves letterbox bars, so the ring is measured to the picture
// itself, not the pane. Re-measures on pane/media resize.
function OrbitMediaFrame({ containerRef, mediaRef, deps }: {
  containerRef: { current: HTMLElement | null }
  mediaRef: { current: HTMLElement | null }
  deps: unknown[]
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useEffect(() => {
    const measure = () => {
      const c = containerRef.current, m = mediaRef.current
      if (!c || !m) { setRect(null); return }
      const cr = c.getBoundingClientRect(), mr = m.getBoundingClientRect()
      if (mr.width < 4 || mr.height < 4) { setRect(null); return }
      setRect({ left: mr.left - cr.left, top: mr.top - cr.top, width: mr.width, height: mr.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    if (mediaRef.current) ro.observe(mediaRef.current)
    window.addEventListener("resize", measure)
    return () => { ro.disconnect(); window.removeEventListener("resize", measure) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  // Wall-clock-anchored phase keeps every ring's travelling break in sync
  const phase = `-${Date.now() % 9000}ms`
  const ringMask = {
    padding: "2px",
    WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
    WebkitMaskComposite: "xor" as const,
    mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
    maskComposite: "exclude" as const,
  }
  const spinner = (
    <span
      className="absolute -inset-[75%] animate-spin"
      style={{ background: SILVER_ORBIT_CONIC, animationDuration: "9s", animationDelay: phase }}
    />
  )
  return (
    <>
      {/* Outer ring — frames the whole display pane */}
      <div className="absolute inset-0 pointer-events-none rounded overflow-hidden z-10" style={ringMask}>
        {spinner}
      </div>
      {/* Inner ring — hugs the rendered media box */}
      {rect && (
        <div className="absolute pointer-events-none rounded overflow-hidden z-10"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, ...ringMask }}>
          {spinner}
        </div>
      )}
    </>
  )
}

// Branded letterbox backdrop (copied from portal-v2): a diagonal step-and-repeat
// wall of the synced site logo + wordmark behind the media.
function BrandBackdrop() {
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/admin/config")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.logoUrl) setLogoUrl(d.logoUrl) })
      .catch(() => {})
  }, [])
  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden pointer-events-none select-none">
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(148,163,184,0.07), transparent 70%)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 18% 12%, rgba(248,250,252,0.08), transparent 45%)" }} />
      <div
        className="absolute -inset-[45%] flex flex-wrap items-center justify-center content-center opacity-[0.09]"
        style={{ transform: "rotate(-14deg)" }}
      >
        {Array.from({ length: 120 }).map((_, i) => (
          <span key={i} className="inline-flex items-center gap-2 mx-7 my-5 shrink-0">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="w-5 h-5 rounded-[5px] object-cover" />
            ) : (
              <Sparkles size={13} className="text-slate-200" />
            )}
            <span
              className="text-[11px] font-black tracking-[0.25em] uppercase whitespace-nowrap bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(100deg,#94a3b8,#f8fafc,#cbd5e1,#e2e8f0,#94a3b8)" }}
            >AI Design Studio</span>
          </span>
        ))}
      </div>
      <div
        className="absolute inset-y-0 left-0 w-1/2 pointer-events-none"
        style={{
          background: "linear-gradient(100deg, transparent, rgba(226,232,240,0.08), rgba(248,250,252,0.14), rgba(226,232,240,0.08), transparent)",
          animation: "sheen-sweep 9s ease-in-out infinite",
        }}
      />
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Preset {
  filename: string
  name:     string
  config:   Record<string, unknown>
}

interface Concept {
  id:             string
  name:           string
  path:           string   // local mode: folder path
  r2DatasetKey:   string   // cloud mode: R2 key of uploaded zip
  repeats:        number
  prompt_source:  'sample' | 'filename' | 'concept'
  prompt_path:    string
  uploadProgress?: number  // 0-100 during upload, undefined when idle
}

interface TrainStatus {
  status:     'idle' | 'running' | 'done' | 'error' | 'cancelled'
  pid:        number | null
  logs:       string[]
  returncode: number | null
  started_at: number | null
  run_name:   string | null
}

interface CloudStatus {
  status:        'idle' | 'running' | 'done' | 'error' | 'cancelled'
  job_id:        string | null
  runpod_status: string | null
  logs:          string[]
  output_r2_key: string | null
  success:       boolean | null
  error:         string | null
  elapsed_min:   number | null
  started_at:    number | null
  run_name:      string | null
}

interface R2Checkpoint {
  key:           string
  name:          string
  size_gb:       number
  last_modified: string | null
}

// A trained run's folder in R2 (training/loras/<folder>/)
interface RunInfo {
  folder:    string
  final:     R2Checkpoint | null
  epochs:    R2Checkpoint[]
  hasMeta:   boolean
  createdAt: string | null
}

// A cloud training run being tracked on the Monitor tab. Each RunPod submission
// is its own serverless worker, so multiple runs execute concurrently.
interface TrackedRun {
  jobId:     string
  runName:   string
  runFolder: string
  startedAt: number
}

// Dataset composition snapshot (what the composer had selected when the zip was built)
interface DatasetSnapshot {
  name:          string
  defaultSource: 'caption' | 'tags' | 'prompt'
  images:        DsImage[]
}

// run.json contents written by the train route
interface RunMeta {
  run_name?:          string
  folder?:            string
  created_at?:        string
  checkpoint_r2_key?: string | null
  config?:            Record<string, unknown> | null
  concepts?:          { name?: string; r2_dataset_key?: string; repeats?: number; prompt_source?: string; prompt_path?: string }[] | null
  dataset?:           Partial<DatasetSnapshot> | null
}

// ─── Quick-setup recipes ──────────────────────────────────────────────────────
// Tuned flux1-dev LoRA starting points. Subject picks LR/rank/regularization,
// dataset size picks epochs (so total steps land ~800–1,200 at batch 4), and
// the subject's multiplier stretches/shrinks that for styles vs clothing.

const RECIPE_SUBJECTS = {
  character: { label: 'Character', lr: '0.0003',  rank: '32', alpha: '32', dropout: '0.1',  sched: 'COSINE', warmup: '100', mult: 1,
    desc: 'One person or face. Higher rank + alpha locks the identity in hard.' },
  multichar: { label: 'Multi-Character', lr: '0.00025', rank: '64', alpha: '48', dropout: '0.1', sched: 'COSINE', warmup: '150', mult: 1.25,
    desc: 'Two or more people in one LoRA. Rank 64 gives each identity its own room — and caption every image with a unique trigger word per character (e.g. "ohwx man", "sks woman") so they don\'t blend together. Include some solo shots of each person, not only group shots.' },
  style:     { label: 'Style',     lr: '0.00015', rank: '32', alpha: '16', dropout: '0.05', sched: 'COSINE', warmup: '150', mult: 1.5,
    desc: 'An art style or aesthetic. Gentler learning rate over ~50% more steps so it absorbs the look without copying images.' },
  clothing:  { label: 'Clothing',  lr: '0.0002',  rank: '16', alpha: '16', dropout: '0.15', sched: 'COSINE', warmup: '100', mult: 0.75,
    desc: 'An outfit or garment. Extra dropout + fewer steps so it learns the clothes, not the person wearing them.' },
  object:    { label: 'Object',    lr: '0.00025', rank: '16', alpha: '16', dropout: '0.1',  sched: 'COSINE', warmup: '100', mult: 0.75,
    desc: 'A product, prop or logo. Compact rank — simple subjects overfit fast at high capacity.' },
  pose:      { label: 'Pose / Action', lr: '0.0002', rank: '16', alpha: '16', dropout: '0.15', sched: 'COSINE', warmup: '100', mult: 0.75,
    desc: 'A pose, gesture or action. Compact rank + high dropout learns the motion, not the people performing it — use as many different subjects as possible across the dataset.' },
  scene:     { label: 'Environment', lr: '0.0002', rank: '32', alpha: '16', dropout: '0.05', sched: 'COSINE', warmup: '150', mult: 1.25,
    desc: 'A place, backdrop or setting. Trains like a style — gentler and longer, capturing lighting, architecture and mood rather than a subject.' },
} as const
type RecipeSubject = keyof typeof RECIPE_SUBJECTS

// epochs × subject multiplier sets the pass count; cap is a max_steps safety
// net. lrMult gentles the learning rate on long runs; rankFloor raises LoRA
// capacity for huge, diverse sets; stepSnap switches snapshots to step-based
// (per-epoch is useless when the whole run is 1–3 epochs).
const RECIPE_SIZES = {
  s:    { label: '1–50 images', epochs: 80, cap: 1600, lrMult: 1,    rankFloor: 0,  stepSnap: 0,
    tip: 'Tiny sets overfit fast. Prune near-duplicates, and lean on the epoch snapshots — the best version is often halfway through the run, not the final.' },
  m:    { label: '51–100',      epochs: 40, cap: 2000, lrMult: 1,    rankFloor: 0,  stepSnap: 0,
    tip: 'The classic LoRA size. 80 varied images beat 100 with repeats — variety in angle, lighting and framing matters more than raw count.' },
  l:    { label: '101–250',     epochs: 20, cap: 2400, lrMult: 1,    rankFloor: 0,  stepSnap: 0,
    tip: 'Enough variety to generalize well. From here on, caption consistency matters more than adding images.' },
  xl:   { label: '251–1K',      epochs: 8,  cap: 3000, lrMult: 1,    rankFloor: 0,  stepSnap: 0,
    tip: 'Diversity is doing the heavy lifting now. Bad captions hurt more than bad images — spot-check a sample before spending GPU hours.' },
  xxl:  { label: '1K–5K',       epochs: 3,  cap: 4500, lrMult: 0.75, rankFloor: 32, stepSnap: 400,
    tip: 'Only 1–3 passes are needed — the dataset itself provides the repetition, so the learning rate is dialed down for the long run. Snapshots switch to step-based so you still get ~10 checkpoints.' },
  xxxl: { label: '5K–20K',      epochs: 2,  cap: 6000, lrMult: 0.6,  rankFloor: 64, stepSnap: 600,
    tip: 'Rank is raised to 64 so the LoRA can absorb this much variety. Expect a multi-hour run — watch the live logs for the loss flattening out. Note: the site composer caps at 5,000 images, so build datasets this big as an uploaded zip.' },
  huge: { label: '20K+',        epochs: 1,  cap: 8000, lrMult: 0.5,  rankFloor: 64, stepSnap: 800,
    tip: 'One pass is plenty at this scale. Half learning rate, rank 64, step snapshots every 800. Honest advice: past ~20K images a LoRA starts hitting its capacity ceiling — if results plateau, a full fine-tune of the base model captures more. Cancelling mid-run uploads nothing, so the step snapshots are your safety net.' },
} as const
type RecipeSize = keyof typeof RECIPE_SIZES

const recipeSizeForCount = (n: number): RecipeSize =>
  n <= 50 ? 's' : n <= 100 ? 'm' : n <= 250 ? 'l' : n <= 1000 ? 'xl' : n <= 5000 ? 'xxl' : n <= 20000 ? 'xxxl' : 'huge'

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getPass(): string {
  try { return sessionStorage.getItem('admin-password') || '' } catch { return '' }
}
function ah(): Record<string, string> {
  const p = getPass(); return p ? { 'x-admin-password': p } : {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }

function emptyConcept(): Concept {
  return { id: uid(), name: 'concept', path: '', r2DatasetKey: '', repeats: 1, prompt_source: 'sample', prompt_path: '' }
}

function statusColor(s: TrainStatus['status'] | CloudStatus['status']) {
  return { idle: 'text-slate-500', running: 'text-emerald-400', done: 'text-emerald-400', error: 'text-red-400', cancelled: 'text-amber-400' }[s]
}
function statusLabel(s: TrainStatus['status'] | CloudStatus['status']) {
  return { idle: 'Idle', running: 'Training…', done: 'Done', error: 'Error', cancelled: 'Cancelled' }[s]
}

// Run phases shown on the monitor timeline, in worker order
const PHASE_STEPS: [string, string][] = [
  ['model', 'Model'], ['aux', 'Assets'], ['dataset', 'Dataset'],
  ['cache', 'Cache'], ['train', 'Train'], ['upload', 'Upload'],
]
const fmtEta = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
  : s >= 60 ? `${Math.round(s / 60)}m`
  : `${Math.round(s)}s`

// ─── Preset parsing ────────────────────────────────────────────────────────────

type TrainMethod = 'LoRA' | 'Finetune' | 'Embedding' | 'Full'
interface ParsedPreset { family: string; method: TrainMethod; vram: string | null }

function parsePreset(filename: string): ParsedPreset {
  const raw = filename.replace(/^#/, '').replace(/\.json$/, '').toLowerCase()
  const vramMatch = raw.match(/(\d+)\s*gb/)
  const vram = vramMatch ? `${vramMatch[1]} GB` : null
  const method: TrainMethod =
    /\blora\b/.test(raw) ? 'LoRA' :
    /finetune/.test(raw) ? 'Finetune' :
    /embedding/.test(raw) ? 'Embedding' : 'Full'
  let family = 'Other'
  if      (raw.startsWith('flux2'))               family = 'FLUX 2'
  else if (raw.startsWith('flux'))                family = 'FLUX 1'
  else if (raw.startsWith('z-image deturbo'))     family = 'Z-Image DeTurbo'
  else if (raw.startsWith('z-image'))             family = 'Z-Image'
  else if (raw.startsWith('ernie'))               family = 'ERNIE'
  else if (raw.startsWith('sdxl'))                family = 'SDXL'
  else if (raw.startsWith('sd 3'))                family = 'SD 3'
  else if (raw.startsWith('sd 2'))                family = 'SD 2'
  else if (raw.startsWith('sd 1'))                family = 'SD 1.5'
  else if (raw.startsWith('chroma'))              family = 'Chroma'
  else if (raw.startsWith('hidream'))             family = 'HiDream'
  else if (raw.startsWith('wan 2.2'))             family = 'Wan 2.2 Video (fal)'
  else if (raw.startsWith('wan'))                 family = 'Wan 2.7 Video'
  else if (raw.startsWith('hunyuan'))             family = 'Hunyuan Video'
  else if (raw.startsWith('pixart alpha'))        family = 'PixArt-α'
  else if (raw.startsWith('pixart sigma'))        family = 'PixArt-Σ'
  else if (raw.startsWith('qwen'))                family = 'Qwen'
  else if (raw.startsWith('sana'))                family = 'Sana'
  else if (raw.startsWith('stable cascade'))      family = 'Stable Cascade'
  else if (raw.startsWith('wuerstchen'))          family = 'Würstchen'
  return { family, method, vram }
}

const FAMILY_ORDER = [
  'FLUX 1', 'FLUX 2', 'ERNIE', 'Z-Image', 'Z-Image DeTurbo',
  'SDXL', 'SD 3', 'SD 2', 'SD 1.5',
  'Chroma', 'HiDream', 'Wan 2.2 Video (fal)', 'Wan 2.7 Video', 'Hunyuan Video', 'PixArt-α', 'PixArt-Σ',
  'Qwen', 'Sana', 'Stable Cascade', 'Würstchen', 'Other',
]

const FAMILY_COLOR: Record<string, string> = {
  'FLUX 1':          'text-amber-400',
  'FLUX 2':          'text-amber-400',
  'ERNIE':           'text-blue-400',
  'Z-Image':         'text-cyan-400',
  'Z-Image DeTurbo': 'text-cyan-300',
  'SDXL':            'text-violet-400',
  'SD 3':            'text-fuchsia-400',
  'SD 2':            'text-slate-400',
  'SD 1.5':          'text-slate-400',
  'Chroma':          'text-purple-400',
  'HiDream':         'text-pink-400',
  'Hunyuan Video':   'text-rose-400',
  'Wan 2.2 Video (fal)': 'text-emerald-400',
  'Wan 2.7 Video':   'text-orange-400',
}

const METHOD_PILL: Record<TrainMethod, string> = {
  'LoRA':      'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  'Finetune':  'bg-amber-500/15   text-amber-300   border-amber-500/25',
  'Embedding': 'bg-violet-500/15  text-violet-300  border-violet-500/25',
  'Full':      'bg-slate-500/15   text-slate-400   border-slate-500/25',
}

const VRAM_PILL: Record<string, string> = {
  '8 GB':  'bg-red-500/10    text-red-400    border-red-500/20',
  '16 GB': 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  '24 GB': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
}

// ─── LoRA download block ───────────────────────────────────────────────────────

function LoraDownloadBlock({ r2Key, adminHeaders }: { r2Key: string; adminHeaders: Record<string, string> }) {
  const [downloading, setDownloading] = useState(false)
  const filename = r2Key.split('/').pop() ?? 'lora.safetensors'

  async function download() {
    setDownloading(true)
    try {
      const res = await fetch(`/api/admin/onetrainer/cloud/download?key=${encodeURIComponent(r2Key)}`, { headers: adminHeaders })
      if (!res.ok) { alert('Failed to get download URL'); return }
      const { url } = await res.json()
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    } catch { alert('Download error') }
    finally { setDownloading(false) }
  }

  return (
    <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
      <CheckCircle size={11} className="text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-slate-500 mb-0.5">LoRA saved to R2</p>
        <p className="text-[11px] text-emerald-300 font-mono truncate">{r2Key}</p>
      </div>
      <button
        onClick={download}
        disabled={downloading}
        className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
      >
        <ExternalLink size={10} />
        {downloading ? 'Getting link…' : 'Download'}
      </button>
    </div>
  )
}

function LoraListItem({ file, adminHeaders }: { file: R2Checkpoint; adminHeaders: Record<string, string> }) {
  const [downloading, setDownloading] = useState(false)

  async function download() {
    setDownloading(true)
    try {
      const res = await fetch(`/api/admin/onetrainer/cloud/download?key=${encodeURIComponent(file.key)}`, { headers: adminHeaders })
      if (!res.ok) { alert('Failed to get download URL'); return }
      const { url } = await res.json()
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
    } catch { alert('Download error') }
    finally { setDownloading(false) }
  }

  const date = file.last_modified
    ? new Date(file.last_modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] transition-colors">
      <Zap size={14} className="text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-white truncate">{file.name.replace(/\.(safetensors|ckpt|pt|zip|tar\.gz)$/i, '')}</p>
        <p className="text-[10px] text-slate-600 font-mono mt-0.5">
          {file.size_gb} GB · {file.name.split('.').pop()}{date ? ` · ${date}` : ''} · <span className="text-slate-700">{file.key}</span>
        </p>
      </div>
      <button
        onClick={download}
        disabled={downloading}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
      >
        <ExternalLink size={10} />
        {downloading ? 'Getting link…' : 'Download'}
      </button>
    </div>
  )
}

// ─── Trained run card (Saved LoRAs tab) ───────────────────────────────────────

function fmtGb(gb: number) { return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.max(1, Math.round(gb * 1000))} MB` }

function RunCard({ run, adminHeaders, onReload }: {
  run: RunInfo
  adminHeaders: Record<string, string>
  onReload: (meta: RunMeta) => void
}) {
  const [meta, setMeta]             = useState<RunMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showEpochs, setShowEpochs] = useState(false)
  const [busyKey, setBusyKey]       = useState<string | null>(null)
  const [reloadBusy, setReloadBusy] = useState(false)

  async function fetchMeta(): Promise<RunMeta | null> {
    if (meta) return meta
    setMetaLoading(true)
    try {
      const res = await fetch(`/api/admin/onetrainer/runs?meta=${encodeURIComponent(run.folder)}`, { headers: adminHeaders })
      if (!res.ok) return null
      const m = await res.json() as RunMeta
      setMeta(m)
      return m
    } catch { return null }
    finally { setMetaLoading(false) }
  }

  async function toggleConfig() {
    if (!showConfig && !meta) await fetchMeta()
    setShowConfig(v => !v)
  }

  async function handleReload() {
    setReloadBusy(true)
    const m = await fetchMeta()
    setReloadBusy(false)
    if (m) onReload(m)
    else alert('No run.json found for this run — it predates run metadata, so its settings can\'t be reloaded.')
  }

  async function download(file: R2Checkpoint) {
    setBusyKey(file.key)
    try {
      const res = await fetch(`/api/admin/onetrainer/cloud/download?key=${encodeURIComponent(file.key)}`, { headers: adminHeaders })
      if (!res.ok) { alert('Failed to get download URL'); return }
      const { url } = await res.json()
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
    } catch { alert('Download error') }
    finally { setBusyKey(null) }
  }

  const epochLabel = (name: string) => {
    // OneTrainer snapshots: <timestamp>-save-<step>-<epoch>-<n>.safetensors
    const s = name.match(/-save-(\d+)-(\d+)-\d+\.safetensors$/i)
    if (s) return `Epoch ${parseInt(s[2])} · step ${parseInt(s[1])}`
    const m = name.match(/(\d+)(?=\.safetensors$)/i)
    return m ? `Epoch ${parseInt(m[1])}` : name.replace(/\.safetensors$/i, '')
  }

  const date = run.createdAt ?? run.final?.last_modified
  const cfg = (meta?.config ?? {}) as Record<string, unknown>
  const opt = cfg.optimizer as Record<string, unknown> | undefined
  const te  = cfg.text_encoder as Record<string, unknown> | undefined
  const configRows: [string, string][] = meta
    ? ([
        ['Model type',    cfg.model_type],
        ['Learning rate', cfg.learning_rate],
        ['Batch size',    cfg.batch_size],
        ['Epochs',        cfg.epochs],
        ['Max steps',     cfg.max_steps],
        ['Resolution',    cfg.resolution],
        ['LoRA rank',     cfg.lora_rank],
        ['LoRA alpha',    cfg.lora_alpha],
        ['Dropout',       cfg.dropout_probability],
        ['LR scheduler',  cfg.learning_rate_scheduler],
        ['Warmup steps',  cfg.learning_rate_warmup_steps],
        ['Optimizer',     opt?.optimizer],
        ['Timesteps',     cfg.timestep_distribution],
        ['Snapshots',     cfg.save_after_unit === 'EPOCH' ? `every ${cfg.save_after ?? 1} epoch(s)`
                        : cfg.save_after_unit === 'STEP'  ? `every ${cfg.save_after ?? 1} steps` : 'off'],
        ['Train CLIP',    te?.train === true ? 'yes' : 'no'],
        ['Train dtype',   cfg.train_dtype],
      ] as [string, unknown][])
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    : []
  const ckptName = typeof meta?.checkpoint_r2_key === 'string' ? meta.checkpoint_r2_key.split('/').pop() : null
  const dsCount = Array.isArray(meta?.dataset?.images) ? meta!.dataset!.images!.length : null

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] transition-colors overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Zap size={14} className="text-emerald-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-white truncate">{run.folder}</p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
            {run.final ? fmtGb(run.final.size_gb) : 'no final file'}
            {run.epochs.length > 0 && ` · ${run.epochs.length} epoch snapshot${run.epochs.length === 1 ? '' : 's'}`}
            {date && ` · ${new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {run.hasMeta && (
            <button onClick={handleReload} disabled={reloadBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.12] text-white text-[10px] font-bold hover:bg-white/[0.12] transition-colors disabled:opacity-50">
              {reloadBusy ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              Reload
            </button>
          )}
          {run.hasMeta && (
            <button onClick={toggleConfig}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[10px] font-bold transition-colors ${
                showConfig ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-white/[0.04] border-white/[0.08] text-slate-400 hover:text-white'}`}>
              <Settings2 size={10} /> Config
            </button>
          )}
          {run.final && (
            <button onClick={() => download(run.final!)} disabled={busyKey === run.final.key}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[10px] font-bold hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
              <ExternalLink size={10} /> {busyKey === run.final.key ? 'Link…' : 'Download'}
            </button>
          )}
        </div>
      </div>

      {/* Epochs */}
      {run.epochs.length > 0 && (
        <div className="border-t border-white/[0.05]">
          <button onClick={() => setShowEpochs(v => !v)}
            className="w-full flex items-center gap-1.5 px-4 py-2 text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
            <ChevronDown size={11} className={`transition-transform ${showEpochs ? 'rotate-180' : ''}`} />
            {showEpochs ? 'Hide' : 'Show'} {run.epochs.length} epoch snapshot{run.epochs.length === 1 ? '' : 's'}
            <span className="text-slate-700">— each is a complete standalone LoRA</span>
          </button>
          {showEpochs && (
            <div className="px-4 pb-3 space-y-1">
              {run.epochs.map(f => (
                <div key={f.key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                  <span className="text-[11px] text-white font-medium flex-1 min-w-0 truncate">{epochLabel(f.name)}</span>
                  <span className="text-[9px] text-slate-600 font-mono shrink-0">{fmtGb(f.size_gb)}</span>
                  <button onClick={() => download(f)} disabled={busyKey === f.key}
                    className="shrink-0 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white text-[9px] font-bold transition-colors disabled:opacity-50">
                    {busyKey === f.key ? '…' : 'Download'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Config viewer */}
      {showConfig && (
        <div className="border-t border-white/[0.05] px-4 py-3">
          {metaLoading && <p className="text-[10px] text-slate-600 flex items-center gap-1.5"><Loader2 size={10} className="animate-spin" /> Loading config…</p>}
          {!metaLoading && !meta && <p className="text-[10px] text-slate-600">Config unavailable.</p>}
          {!metaLoading && meta && (
            <div className="space-y-2.5">
              {(ckptName || dsCount !== null) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {ckptName && <p className="text-[10px] text-slate-500">Base model: <span className="text-slate-300 font-mono">{ckptName}</span></p>}
                  {dsCount !== null && <p className="text-[10px] text-slate-500">Dataset: <span className="text-slate-300 font-mono">{dsCount} images{meta.dataset?.name ? ` · ${meta.dataset.name}` : ''}</span></p>}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                {configRows.map(([k, v]) => (
                  <div key={k} className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                    <p className="text-[8px] text-slate-600 uppercase tracking-wider">{k}</p>
                    <p className="text-[10px] text-white font-mono truncate mt-0.5">{v}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Completed run record (Completed Runs tab) ────────────────────────────────
// The full logged record of a finished training run: every config key, dataset
// composition, concepts, checkpoint, timing and output files.
function CompletedRunCard({ run, adminHeaders }: { run: RunInfo; adminHeaders: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<RunMeta | null>(null)
  const [loading, setLoading] = useState(false)
  // Fine-tune runs: promote the final full model into training/checkpoints/
  const [promoteBusy, setPromoteBusy] = useState(false)
  const [promoteDone, setPromoteDone] = useState<string | null>(null)
  const [promoteErr, setPromoteErr]   = useState<string | null>(null)
  async function promote() {
    if (promoteBusy) return
    setPromoteBusy(true); setPromoteErr(null)
    try {
      const res = await fetch('/api/admin/onetrainer/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ action: 'promote', folder: run.folder, name: run.folder }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setPromoteDone(d.checkpointKey ?? 'done')
    } catch (e: any) {
      setPromoteErr(e?.message || 'Promote failed')
    } finally { setPromoteBusy(false) }
  }

  async function toggle() {
    if (!open && !meta && run.hasMeta) {
      setLoading(true)
      try {
        const res = await fetch(`/api/admin/onetrainer/runs?meta=${encodeURIComponent(run.folder)}`, { headers: adminHeaders })
        if (res.ok) setMeta(await res.json())
      } catch {}
      finally { setLoading(false) }
    }
    setOpen(v => !v)
  }

  const started = meta?.created_at ? new Date(meta.created_at) : (run.createdAt ? new Date(run.createdAt) : null)
  const finished = run.final?.last_modified ? new Date(run.final.last_modified) : null
  const durationMin = started && finished ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 60000)) : null
  const fmtDurMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`)

  const cfg = (meta?.config ?? {}) as Record<string, unknown>
  const cfgEntries: [string, string][] = Object.entries(cfg)
    .filter(([k]) => !['base_model_name', 'output_model_destination', 'concept_file_name', 'samples', 'workspace_dir'].includes(k))
    .map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)] as [string, string])
    .filter(([, v]) => v !== '' && v !== 'undefined')
    .sort((a, b) => a[0].localeCompare(b[0]))

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <button onClick={toggle} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors">
        <CheckCircle size={14} className="text-emerald-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-white truncate">{run.folder}</p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5 truncate">
            {finished ? finished.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date unknown'}
            {durationMin !== null && ` · ${fmtDurMin(durationMin)}`}
            {run.final && ` · ${fmtGb(run.final.size_gb)}`}
            {run.epochs.length > 0 && ` · ${run.epochs.length} snapshots`}
          </p>
        </div>
        {loading
          ? <Loader2 size={12} className="animate-spin text-slate-600 shrink-0" />
          : <ChevronDown size={13} className={`text-slate-600 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && (
        <div className="border-t border-white/[0.05] px-4 py-3 space-y-3">
          {!run.hasMeta && <p className="text-[10px] text-slate-600">This run predates run metadata — no configuration was recorded.</p>}
          {meta && (
            <>
              {/* Run facts */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {([
                  ['Started',    started ? started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'],
                  ['Finished',   finished ? finished.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'],
                  ['Duration',   durationMin !== null ? fmtDurMin(durationMin) : '—'],
                  ['Base model', typeof meta.checkpoint_r2_key === 'string' ? (meta.checkpoint_r2_key.split('/').pop() ?? '—') : '—'],
                  ['Dataset',    meta.dataset?.images?.length ? `${meta.dataset.images.length} images${meta.dataset.name ? ` · ${meta.dataset.name}` : ''}` : '—'],
                  ['Concepts',   String(meta.concepts?.length ?? 1)],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} className="px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] min-w-0">
                    <p className="text-[8px] text-slate-600 uppercase tracking-wider">{k}</p>
                    <p className="text-[10px] text-white font-mono truncate mt-0.5" title={v}>{v}</p>
                  </div>
                ))}
              </div>
              {/* Fine-tune output → usable base checkpoint */}
              {String(cfg.training_method ?? '').toUpperCase() === 'FINE_TUNE' && run.final && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 space-y-1.5">
                  <p className="text-[10px] text-amber-300 leading-snug">
                    This was a <span className="font-bold">full fine-tune</span> — its output is a complete checkpoint, not a LoRA.
                  </p>
                  {promoteDone ? (
                    <p className="text-[10px] font-mono text-emerald-300 break-all">✓ Promoted — now selectable as a checkpoint: {promoteDone}</p>
                  ) : (
                    <button onClick={promote} disabled={promoteBusy}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold hover:bg-amber-500/25 transition-colors disabled:opacity-50">
                      {promoteBusy ? <Loader2 size={10} className="animate-spin" /> : <HardDrive size={10} />}
                      {promoteBusy ? 'Copying ~22GB in R2…' : 'Use as base checkpoint'}
                    </button>
                  )}
                  {promoteErr && <p className="text-[10px] text-red-400">{promoteErr}</p>}
                </div>
              )}
              {/* Full configuration dump */}
              <div>
                <p className="text-[9px] font-mono uppercase tracking-wider text-slate-600 mb-1.5">Full configuration ({cfgEntries.length} keys)</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                  {cfgEntries.map(([k, v]) => (
                    <div key={k} className="px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] min-w-0">
                      <p className="text-[8px] text-slate-600 tracking-wider truncate" title={k}>{k}</p>
                      <p className="text-[10px] text-slate-200 font-mono truncate mt-0.5" title={v}>{v}</p>
                    </div>
                  ))}
                </div>
              </div>
              {/* Output files */}
              <div>
                <p className="text-[9px] font-mono uppercase tracking-wider text-slate-600 mb-1.5">Output</p>
                <div className="space-y-1">
                  {run.final && (
                    <p className="text-[10px] font-mono text-slate-400 truncate">{run.final.key} · {fmtGb(run.final.size_gb)}</p>
                  )}
                  {run.epochs.map(e => (
                    <p key={e.key} className="text-[10px] font-mono text-slate-600 truncate">{e.key} · {fmtGb(e.size_gb)}</p>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Cloud run monitor card ───────────────────────────────────────────────────
// One card per concurrent RunPod training run: own status/log polling, parsed
// progress (epoch splits + streaming %), config + dataset viewer, cancel.

function CloudRunCard({ run, adminHeaders, onDismiss, onRename, onStatus, onRetry }: {
  run: TrackedRun
  adminHeaders: Record<string, string>
  onDismiss: () => void
  onRename?: (name: string) => void
  // Reports the live status up so the Monitor can filter completed runs
  onStatus?: (status: string) => void
  // Relaunch a failed run with its recorded config (from run.json)
  onRetry?: (meta: Record<string, unknown>, runName: string) => Promise<void> | void
}) {
  const [retrying, setRetrying] = useState(false)
  // Inline rename — updates the tracked entry + the run.json metadata in R2
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft]     = useState(run.runName)
  const commitRename = async () => {
    const name = nameDraft.trim().slice(0, 80)
    setEditingName(false)
    if (!name || name === run.runName) { setNameDraft(run.runName); return }
    // Optimistic local rename, then adopt the server's final name — it
    // auto-suffixes "v2"/"v3" when the name collides with another run
    onRename?.(name)
    try {
      const res = await fetch('/api/admin/onetrainer/runs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ folder: run.runFolder, run_name: name }),
      })
      if (res.ok) {
        const d = await res.json()
        if (typeof d.run_name === 'string' && d.run_name !== name) onRename?.(d.run_name)
      }
    } catch {}
  }
  const [status, setStatus]           = useState<'running' | 'done' | 'error' | 'cancelled' | 'idle'>('running')
  useEffect(() => { onStatus?.(status) }, [status]) // eslint-disable-line react-hooks/exhaustive-deps
  const [runpodStatus, setRunpodStatus] = useState('')
  const [logs, setLogs]               = useState<string[]>([])
  const [outputKey, setOutputKey]     = useState<string | null>(null)
  const [errMsg, setErrMsg]           = useState<string | null>(null)
  const [elapsedMin, setElapsedMin]   = useState<number | null>(null)
  const [meta, setMeta]               = useState<RunMeta | null>(null)
  const [showConfig, setShowConfig]   = useState(false)
  const [showLog, setShowLog]         = useState(false)
  const [cancelling, setCancelling]   = useState(false)
  const logBoxRef = useRef<HTMLDivElement | null>(null)

  // Status + live-log polling — per card, stops itself once the run finishes
  useEffect(() => {
    let stopped = false
    let t1: ReturnType<typeof setInterval> | null = null
    let t2: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (t1) clearInterval(t1); if (t2) clearInterval(t2); t1 = t2 = null }
    const statusTick = async () => {
      try {
        const res = await fetch(`/api/admin/onetrainer/cloud/status?job_id=${run.jobId}`, { headers: adminHeaders })
        if (!res.ok || stopped) return
        const s = await res.json()
        setStatus(s.status ?? 'running')
        setRunpodStatus(s.runpod_status ?? '')
        if (Array.isArray(s.logs) && s.logs.length > 0) setLogs(prev => s.logs.length >= prev.length ? s.logs : prev)
        if (s.output_r2_key) setOutputKey(s.output_r2_key)
        if (s.error) setErrMsg(s.error)
        if (s.elapsed_min) setElapsedMin(s.elapsed_min)
        if (s.status && s.status !== 'running') stop()
      } catch {}
    }
    const logTick = async () => {
      try {
        const res = await fetch(`/api/admin/onetrainer/cloud/logs?job_id=${run.jobId}`, { headers: adminHeaders })
        if (!res.ok || stopped) return
        const { logs: l } = await res.json()
        if (Array.isArray(l) && l.length > 0) setLogs(prev => l.length >= prev.length ? l : prev)
      } catch {}
    }
    statusTick(); logTick()
    t1 = setInterval(statusTick, 8000)
    t2 = setInterval(logTick, 10000)
    return () => { stopped = true; stop() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.jobId])

  // The run's recipe (config + dataset) from run.json
  useEffect(() => {
    fetch(`/api/admin/onetrainer/runs?meta=${encodeURIComponent(run.runFolder)}`, { headers: adminHeaders })
      .then(r => (r.ok ? r.json() : null))
      .then(m => { if (m) setMeta(m) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runFolder])

  // ── Fallback completion detection ───────────────────────────────────────────
  // RunPod expires a job's status after a while, so a card that reconnects late
  // can never learn the run finished and spins forever. The run's
  // final.safetensors in R2 is the ground truth — check it on mount and every
  // 60s while the card still believes it's running.
  useEffect(() => {
    if (status !== 'running') return
    let stopped = false
    const check = async () => {
      try {
        const r = await fetch(`/api/admin/onetrainer/runs?final=${encodeURIComponent(run.runFolder)}`, { headers: adminHeaders })
        if (!r.ok || stopped) return
        const d = await r.json()
        if (d?.exists) {
          setStatus('done')
          setOutputKey(prev => prev ?? `training/loras/${run.runFolder}/final.safetensors`)
        }
      } catch {}
    }
    check()
    const t = setInterval(check, 60_000)
    return () => { stopped = true; clearInterval(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, run.runFolder])

  // ── Phase detection + LIVE-measured ETAs (display only — parsed from logs) ──
  // Rates are measured client-side from progress deltas between log polls, so
  // ETAs reflect the actual worker/network speed instead of spec guesses.
  const phaseTrackRef = useRef<{ phase: string; t0: number; v0: number } | null>(null)
  const [eta, setEta] = useState<{ phase: string; etaSec: number | null; cur: number; tot: number; phaseElapsedSec: number } | null>(null)
  useEffect(() => {
    const now = Date.now()
    // Detect the current phase from the newest matching log line
    let phase = 'starting'
    outer: for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i]
      const checks: [string, RegExp][] = [
        ['upload', /Uploading (LoRA|\d+ epoch)/i],
        ['train', /(?:^|\s)(?:step|epoch):\s*\d+%/i],
        ['cache', /caching[^:]*:\s*\d+%/i],
        ['dataset', /Downloading dataset|Dataset '/i],
        ['aux', /Downloading (CLIP|T5|VAE)/i],
        ['model', /Downloading checkpoint/i],
      ]
      for (const [p, re] of checks) if (re.test(line)) { phase = p; break outer }
    }
    // Progress within the phase (tqdm counters)
    let cur = 0, tot = 0
    if (phase === 'cache') {
      for (let i = logs.length - 1; i >= 0; i--) {
        const m = logs[i].match(/caching[^:]*:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/i)
        if (m) { cur = +m[1]; tot = +m[2]; break }
      }
    } else if (phase === 'train' && progress) {
      if (progress.sTot > 0) { cur = progress.eCur * progress.sTot + progress.sCur; tot = progress.eTot * progress.sTot }
      else { cur = progress.eCur; tot = progress.eTot }
    }
    // Measure the rate from the start of the current phase
    if (!phaseTrackRef.current || phaseTrackRef.current.phase !== phase) {
      phaseTrackRef.current = { phase, t0: now, v0: cur }
    }
    const track = phaseTrackRef.current
    const elapsed = (now - track.t0) / 1000
    let etaSec: number | null = null
    if (tot > 0 && cur > track.v0 && elapsed > 5) {
      const rate = (cur - track.v0) / elapsed
      if (rate > 0) etaSec = Math.round((tot - cur) / rate)
    }
    setEta({ phase, etaSec, cur, tot, phaseElapsedSec: Math.round(elapsed) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.length, status])

  // Parse tqdm-style progress out of the log tail:
  //   "epoch: 40%|████     | 12/30 [..]"   "step: 53%|█▌  | 32/60 [..]"
  const progress = (() => {
    let eCur = 0, eTot = 0, sCur = 0, sTot = 0
    for (let i = logs.length - 1; i >= 0 && (eTot === 0 || sTot === 0); i--) {
      const line = logs[i]
      if (sTot === 0) {
        const m = line.match(/step:\s*\d+%.*?(\d+)\/(\d+)/i)
        if (m) { sCur = +m[1]; sTot = +m[2] }
      }
      if (eTot === 0) {
        const m = line.match(/epoch:\s*\d+%.*?(\d+)\/(\d+)/i)
        if (m) { eCur = +m[1]; eTot = +m[2] }
      }
    }
    const cfgEpochs = Number((meta?.config as Record<string, unknown> | null | undefined)?.epochs) || 0
    if (eTot === 0 && cfgEpochs > 0) eTot = cfgEpochs
    if (eTot === 0) return null
    const frac = Math.min(1, (eCur + (sTot > 0 ? sCur / sTot : 0)) / eTot)
    return { eCur, eTot, sCur, sTot, pct: Math.round(frac * 1000) / 10 }
  })()
  const pct = status === 'done' ? 100 : progress?.pct ?? 0

  // Collapse runs of consecutive tqdm progress lines — keep only the latest of
  // each burst so the log reads as a clean narrative
  const displayLogs = (() => {
    const out: string[] = []
    for (const line of logs) {
      const isProg = /\d+%\|/.test(line)
      if (isProg && out.length > 0 && /\d+%\|/.test(out[out.length - 1])) out[out.length - 1] = line
      else out.push(line)
    }
    return out.slice(-300)
  })()

  useEffect(() => {
    const el = logBoxRef.current
    if (el && showLog) el.scrollTop = el.scrollHeight
  }, [displayLogs.length, showLog])

  async function cancel() {
    setCancelling(true)
    try {
      await fetch('/api/admin/onetrainer/cloud/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ job_id: run.jobId }),
      })
      setStatus('cancelled')
    } finally { setCancelling(false) }
  }

  const active = status === 'running'
  const liveMin = active ? Math.max(0, Math.round((Date.now() - run.startedAt) / 60000)) : null
  const cfg = (meta?.config ?? {}) as Record<string, unknown>
  const opt = cfg.optimizer as Record<string, unknown> | undefined
  const configRows: [string, string][] = meta
    ? ([
        ['Model',        cfg.model_type],
        ['LR',           cfg.learning_rate],
        ['Batch',        cfg.batch_size],
        ['Epochs',       cfg.epochs],
        ['Max steps',    cfg.max_steps],
        ['Resolution',   cfg.resolution],
        ['Rank',         cfg.lora_rank],
        ['Alpha',        cfg.lora_alpha],
        ['Scheduler',    cfg.learning_rate_scheduler],
        ['Optimizer',    opt?.optimizer],
        ['Snapshots',    cfg.save_after_unit === 'EPOCH' ? `every ${cfg.save_after ?? 1} epoch(s)`
                       : cfg.save_after_unit === 'STEP'  ? `every ${cfg.save_after ?? 1} steps` : 'off'],
      ] as [string, unknown][])
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    : []
  const dsCount = Array.isArray(meta?.dataset?.images) ? meta!.dataset!.images!.length : null
  const ckptName = typeof meta?.checkpoint_r2_key === 'string' ? meta.checkpoint_r2_key.split('/').pop() : null

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0a101d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`flex items-center gap-2 text-[13px] font-semibold shrink-0 ${statusColor(status)}`}>
          {status === 'running'   && <Loader2 size={13} className="animate-spin" />}
          {status === 'done'      && <CheckCircle size={13} />}
          {status === 'error'     && <AlertCircle size={13} />}
          {status === 'cancelled' && <X size={13} />}
          {status === 'idle'      && <Cpu size={13} />}
        </div>
        <div className="flex-1 min-w-0">
          {editingName ? (
            <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setNameDraft(run.runName); setEditingName(false) } }}
              className="w-full max-w-[240px] px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-white/25 text-[12px] font-semibold text-white focus:outline-none" />
          ) : (
            <p className="text-[12px] font-semibold text-white truncate group/name flex items-center gap-1.5">
              {run.runName}
              {onRename && (
                <button onClick={() => { setNameDraft(run.runName); setEditingName(true) }} title="Rename run"
                  className="shrink-0 text-slate-600 hover:text-white transition-colors">
                  <Settings2 size={10} />
                </button>
              )}
            </p>
          )}
          <p className="text-[9px] text-slate-600 font-mono mt-0.5 truncate">
            {runpodStatus === 'IN_QUEUE' ? 'Queued on RunPod' : statusLabel(status)}
            {' · '}Job {run.jobId.slice(0, 10)}…
            {liveMin !== null && ` · ${liveMin} min`}
            {elapsedMin !== null && !active && ` · ${elapsedMin} min total`}
            {dsCount !== null && ` · ${dsCount} images`}
            {ckptName && ` · ${ckptName.replace(/\.(safetensors|ckpt|pt)$/i, '')}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {active && (
            <button onClick={cancel} disabled={cancelling}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] font-bold hover:bg-red-500/15 transition-all disabled:opacity-50">
              <Square size={9} /> {cancelling ? '…' : 'Cancel'}
            </button>
          )}
          {/* Retry — relaunch a failed run with the exact same recipe */}
          {!active && (status === 'error' || status === 'cancelled') && onRetry && meta && (
            <button
              onClick={async () => {
                setRetrying(true)
                try { await onRetry(meta as unknown as Record<string, unknown>, run.runName) }
                finally { setRetrying(false) }
              }}
              disabled={retrying}
              title="Relaunch this run with the same configuration"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-bold hover:bg-white/15 transition-all disabled:opacity-50">
              {retrying ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          )}
          {!active && (
            <button onClick={onDismiss} title="Remove from monitor"
              className="p-1.5 rounded-lg text-slate-600 hover:text-white hover:bg-white/[0.06] transition-colors">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Progress — epoch sub-splits + streaming percentage */}
      <div className="px-4 pb-3">
        <div className="relative h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-slate-400 via-slate-200 to-white transition-[width] duration-700 ease-out overflow-hidden"
            style={{ width: `${pct}%` }}
          >
            {active && (
              <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/60 to-transparent" style={{ animation: 'sheen-sweep 2.2s infinite' }} />
            )}
          </div>
          {/* epoch split ticks */}
          {progress && progress.eTot > 1 && progress.eTot <= 60 && Array.from({ length: progress.eTot - 1 }).map((_, i) => (
            <span key={i} className="absolute inset-y-0 w-px bg-black/60" style={{ left: `${((i + 1) / progress.eTot) * 100}%` }} />
          ))}
        </div>
        {/* Phase timeline — worker order, current phase live */}
        {active && (
          <div className="flex items-center gap-1 mt-2 flex-wrap">
            {PHASE_STEPS.map(([key, label], i) => {
              const curIdx = PHASE_STEPS.findIndex(([k]) => k === (eta?.phase ?? ''))
              const state = curIdx === -1 ? 'future' : i < curIdx ? 'done' : i === curIdx ? 'now' : 'future'
              return (
                <span key={key} className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[8px] font-mono uppercase tracking-wider ${
                  state === 'now' ? 'border-white/30 bg-white/[0.1] text-white'
                  : state === 'done' ? 'border-emerald-500/20 text-emerald-400/70'
                  : 'border-white/[0.06] text-slate-700'}`}>
                  {state === 'done' && <Check size={7} strokeWidth={3} />}
                  {state === 'now' && <Loader2 size={7} className="animate-spin" />}
                  {label}
                </span>
              )
            })}
          </div>
        )}
        <div className="flex items-center justify-between mt-1.5 gap-2">
          <p className="text-[9px] font-mono text-slate-500 min-w-0 truncate">
            {(() => {
              if (!active) {
                return progress
                  ? `Epoch ${Math.min(progress.eCur, progress.eTot)}/${progress.eTot}`
                  : statusLabel(status)
              }
              const p = eta?.phase
              if (p === 'train' && progress) {
                const base = `Epoch ${Math.min(progress.eCur + 1, progress.eTot)}/${progress.eTot}${progress.sTot > 0 ? ` · step ${progress.sCur}/${progress.sTot}` : ''}`
                return eta?.etaSec != null
                  ? `${base} · ~${fmtEta(eta.etaSec)} left · run ETA ~${fmtEta(eta.etaSec + 90)}`
                  : `${base} · measuring speed…`
              }
              if (p === 'cache') return `Caching latents ${eta!.cur}/${eta!.tot}${eta?.etaSec != null ? ` · ~${fmtEta(eta.etaSec)} left` : ' · measuring speed…'}`
              if (p === 'model') return `Downloading base model — ${fmtEta(eta?.phaseElapsedSec ?? 0)} elapsed, typically 2–6 min`
              if (p === 'aux') return `Downloading encoders & VAE — ${fmtEta(eta?.phaseElapsedSec ?? 0)} elapsed, typically 1–3 min`
              if (p === 'dataset') return 'Fetching & extracting dataset — typically under 2 min'
              if (p === 'upload') return 'Uploading LoRA + epoch snapshots to R2…'
              return runpodStatus === 'IN_QUEUE' ? 'Waiting for a worker…' : 'Starting up…'
            })()}
          </p>
          <p className={`shrink-0 text-[10px] font-mono font-bold tabular-nums ${status === 'done' ? 'text-emerald-400' : 'text-slate-300'}`}>{pct.toFixed(1)}%</p>
        </div>
      </div>

      {/* Error */}
      {errMsg && (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20">
          <p className="text-[10px] text-red-400 break-words">{errMsg}</p>
        </div>
      )}

      {/* Finished LoRA download */}
      {outputKey && (
        <div className="px-4 pb-3">
          <LoraDownloadBlock r2Key={outputKey} adminHeaders={adminHeaders} />
        </div>
      )}

      {/* Toggles */}
      <div className="flex items-center gap-1.5 px-4 pb-3">
        <button onClick={() => setShowConfig(v => !v)} disabled={!meta}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[10px] font-medium transition-colors disabled:opacity-40 ${
            showConfig ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white'}`}>
          <Settings2 size={10} /> Config &amp; dataset
        </button>
        <button onClick={() => setShowLog(v => !v)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
            showLog ? 'bg-white/[0.1] border-white/25 text-white' : 'bg-white/[0.03] border-white/[0.08] text-slate-400 hover:text-white'}`}>
          <Terminal size={10} /> Log <span className="text-slate-600">({displayLogs.length})</span>
        </button>
        <a href="https://www.runpod.io/console/serverless" target="_blank" rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 text-[10px] text-slate-600 hover:text-slate-400 transition-colors">
          <ExternalLink size={10} /> RunPod
        </a>
      </div>

      {/* Config + dataset panel */}
      {showConfig && meta && (
        <div className="border-t border-white/[0.05] px-4 py-3 space-y-2">
          {(ckptName || dsCount !== null) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ckptName && <p className="text-[10px] text-slate-500">Base: <span className="text-slate-300 font-mono">{ckptName}</span></p>}
              {dsCount !== null && <p className="text-[10px] text-slate-500">Dataset: <span className="text-slate-300 font-mono">{dsCount} images{meta.dataset?.name ? ` · ${meta.dataset.name}` : ''}</span></p>}
              {(meta.concepts?.length ?? 0) > 1 && <p className="text-[10px] text-slate-500">{meta.concepts!.length} concepts</p>}
            </div>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
            {configRows.map(([k, v]) => (
              <div key={k} className="px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                <p className="text-[8px] text-slate-600 uppercase tracking-wider">{k}</p>
                <p className="text-[10px] text-white font-mono truncate mt-0.5">{v}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Log panel */}
      {showLog && (
        <div className="border-t border-white/[0.05] bg-[#07070e]">
          <div ref={logBoxRef} className="max-h-64 overflow-y-auto px-4 py-3 space-y-0.5 font-mono text-[10px]">
            {displayLogs.length === 0 && (
              <p className="text-slate-700 text-center py-4">Waiting for first log flush — the worker uploads logs every ~30 seconds.</p>
            )}
            {displayLogs.map((line, i) => {
              const isErr  = /error|exception|traceback/i.test(line)
              const isWarn = /warn|warning/i.test(line)
              const isProg = /\d+%\|/.test(line)
              return (
                <p key={i} className={
                  isErr  ? 'text-red-400' :
                  isWarn ? 'text-amber-400' :
                  isProg ? 'text-emerald-400' :
                  line.startsWith('[runpod]') ? 'text-slate-300' :
                  'text-slate-500'
                }>{line}</p>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Dataset composer ──────────────────────────────────────────────────────────

interface PickerBucket { id: number; name: string; folderId: number | null; count: number; previewUrls: string[] }
interface PickerFolder { id: number; name: string; parentId: number | null; previewUrls?: string[] }
interface DsImage {
  id: number
  prompt: string
  caption: string
  tags: string
  override: 'default' | 'caption' | 'tags' | 'prompt' | 'custom'
  customText: string
  // Composable training-caption sections (GeneratedImage.captionSections):
  // when present, the txt = caption + toggled sections (clean paragraphs) —
  // takes precedence over the single-source override system above
  sections?: { prompt?: boolean; tags?: boolean; noteOn?: boolean; note?: string } | null
  // Viewer extras (optional — presets saved before these existed lack them)
  url?: string
  // Pre-generated R2 thumbnail — tiles load this directly (fast) instead of
  // the server thumb endpoint (fetch-original + sharp resize per request)
  thumb?: string
  model?: string
  refCount?: number
  // Aspect ratio ("2:3" / "1024x1536") — balances masonry Rows packing
  ar?: string
}

function resolveDsCaption(img: DsImage, defaultSource: 'caption' | 'tags' | 'prompt'): string {
  // Section composition wins when configured (mirrors lib/caption-compose):
  // base caption, then toggled sections as blank-line-separated paragraphs
  const s = img.sections
  if (s && (s.prompt || s.tags || (s.noteOn && s.note?.trim()))) {
    const parts: string[] = []
    const base = (img.caption || img.prompt || '').trim()
    if (base) parts.push(base)
    if (s.prompt && img.prompt.trim()) parts.push(img.prompt.trim())
    if (s.noteOn && s.note?.trim()) parts.push(s.note.trim())
    if (s.tags && img.tags.trim()) parts.push(img.tags.trim())
    return parts.join('\n\n')
  }
  const src = img.override === 'default' ? defaultSource : img.override
  if (src === 'custom') return img.customText
  if (src === 'tags')   return img.tags || img.caption || img.prompt || ''
  if (src === 'prompt') return img.prompt || img.caption || ''
  return img.caption || img.prompt || ''
}

const normTags = (t: unknown) => Array.isArray(t) ? t.join(', ') : String(t ?? '')

// Thumb <img> with automatic retry. Under load the dev server drops some thumb
// requests — the old onError handler hid the img, leaving a grey placeholder
// tile FOREVER. Now failures re-request with a cache-buster after 2s/5s/10s
// and only give up after the third miss.
function RetryImg({ src, className }: { src: string; className: string }) {
  const [attempt, setAttempt] = useState(0)
  const [dead, setDead] = useState(false)
  // Hide the element between a failure and the next retry — otherwise the
  // browser's broken-image "?" glyph shows for the whole 2-10s wait
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (dead) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`}
      alt="" loading="lazy" decoding="async"
      className={className}
      style={failed ? { visibility: 'hidden' } : undefined}
      onLoad={() => setFailed(false)}
      onError={() => {
        setFailed(true)
        if (attempt >= 3) { setDead(true); return }
        timer.current = setTimeout(() => { setFailed(false); setAttempt(a => a + 1) }, [2000, 5000, 10000][attempt] ?? 10000)
      }}
    />
  )
}

// Fullscreen-capable image viewer for the dataset composer — same treatment as
// the portal-v2 feed popups: brand-logo backdrop, silver orbit ring hugging the
// picture, fullscreen toggle. Shows the generation's dataset info (model,
// prompt, caption, tags) instead of generation controls.
// Composer persistence: in-progress dataset edits + whether the popup is open
// survive a page refresh
const PICKER_STATE_KEY = 'ot-picker-state'
const PICKER_OPEN_KEY  = 'ot-picker-open'

// ── Composer feed settings (per column: columns + grid/masonry) ──
const PICKER_GRID_COLS:    Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6', 8: 'grid-cols-8' }
const PICKER_MASONRY_COLS: Record<number, string> = { 2: 'columns-2',   3: 'columns-3',   4: 'columns-4',   5: 'columns-5',   6: 'columns-6',   8: 'columns-8' }

// Masonry "Rows" packing (mirrors portal-v2): estimate tile height from the
// stored aspect ratio, assign each item to the currently-shortest column —
// fills left-to-right and appending never moves existing tiles
const pickerArWeight = (ar?: string): number => {
  if (!ar || ar === 'auto') return 1
  const [w, h] = ar.replace(/x/i, ':').split(':').map(parseFloat)
  return w > 0 && h > 0 ? h / w : 1
}
function pickerDistribute<T extends { weight: number }>(items: T[], n: number): T[][] {
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

function PickerFeedPop({ cols, layout, mode, onCols, onLayout, onMode }: {
  cols: number
  layout: 'grid' | 'masonry'
  mode: 'rows' | 'flow'
  onCols: (n: number) => void
  onLayout: (l: 'grid' | 'masonry') => void
  onMode: (m: 'rows' | 'flow') => void
}) {
  return (
    <div className="absolute right-0 top-full mt-1.5 z-50 w-60 rounded-xl bg-[#070b14]/95 backdrop-blur-md border border-white/[0.08] shadow-2xl p-3 space-y-2.5" onClick={e => e.stopPropagation()}>
      <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.2em] text-slate-500">Feed settings</p>
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 w-14 shrink-0">Columns</span>
        <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
          {[2, 3, 4, 5, 6, 8].map(n => (
            <button key={n} onClick={() => onCols(n)}
              className={`px-2 py-1 text-[10px] transition-colors ${cols === n ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{n}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 w-14 shrink-0">Layout</span>
        <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
          {(['grid', 'masonry'] as const).map(l => (
            <button key={l} onClick={() => onLayout(l)}
              className={`px-2.5 py-1 text-[10px] capitalize transition-colors ${layout === l ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{l}</button>
          ))}
        </div>
        {layout === 'masonry' && (
          <div className="flex items-center rounded-lg border border-white/[0.08] overflow-hidden">
            {(['rows', 'flow'] as const).map(m => (
              <button key={m} onClick={() => onMode(m)}
                title={m === 'rows' ? 'Fills left-to-right, tiles never jump' : 'CSS columns — packs top-to-bottom'}
                className={`px-2.5 py-1 text-[10px] capitalize transition-colors ${mode === m ? 'bg-white/[0.12] text-white' : 'text-slate-500 hover:text-white'}`}>{m}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Multi-select filter chips for the All Media filter panel
function PickerMultiChips({ label, options, values, onChange }: {
  label: string
  options: { value: string; label: string }[]
  values: string[]
  onChange: (v: string[]) => void
}) {
  if (options.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-[9px] font-mono uppercase tracking-wider text-slate-600">{label}</p>
      <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
        {options.map(o => {
          const on = values.includes(o.value)
          return (
            <button key={o.value} onClick={() => onChange(on ? values.filter(v => v !== o.value) : [...values, o.value])}
              className={`px-1.5 py-0.5 rounded-md border text-[9px] transition-colors ${
                on ? 'bg-white/15 border-white/30 text-white' : 'border-white/[0.08] text-slate-500 hover:text-white'}`}>
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DatasetImageViewer({ images, index, onClose, onNav, isSelected, onToggleSelect, onSaveCaption, onPatchImage, onSaveSections, selectable = true }: {
  images: DsImage[]
  index: number
  onClose: () => void
  onNav: (i: number) => void
  isSelected: (id: number) => boolean
  onToggleSelect: (img: DsImage) => void
  // When provided, the info panel gains an editable caption box (saves to the
  // dataset composition AND the image's adminCaption in the DB)
  onSaveCaption?: (id: number, caption: string) => void
  // When provided, shows the per-image caption-source override controls
  // (moved here from the old Current Dataset list rows)
  onPatchImage?: (id: number, patch: Partial<DsImage>) => void
  // When provided, shows the composable-sections toggles (persists to the DB)
  onSaveSections?: (id: number, sections: DsImage['sections']) => void
  // false → read-only browsing (hides the Add-to-dataset button)
  selectable?: boolean
}) {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [fullErr, setFullErr] = useState(false)
  const [infoSrc, setInfoSrc] = useState<'prompt' | 'caption' | 'tags'>('prompt')
  const [capDraft, setCapDraft] = useState('')
  const [capSaved, setCapSaved] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && index > 0) onNav(index - 1)
      else if (e.key === 'ArrowRight' && index < images.length - 1) onNav(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onClose, onNav])

  useEffect(() => { setDims(null); setFullLoaded(false); setFullErr(false) }, [index])
  // Reset the caption draft ONLY when the displayed image actually changes
  // (keyed by id). Depending on the `images` ARRAY identity wiped in-progress
  // typing every time the parent re-rendered (AutoFill poll, progress ticks…)
  // — the array is rebuilt inline each render.
  const curImgId = images[index]?.id
  useEffect(() => { setCapDraft(images[index]?.caption ?? ''); setCapSaved(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [index, curImgId])

  const img = images[index]
  if (!img) return null
  const thumbSrc = img.thumb || `/api/admin/dataset/thumb/${img.id}`
  const src = img.url || thumbSrc
  const sel = isSelected(img.id)
  const infoText = infoSrc === 'prompt' ? img.prompt : infoSrc === 'caption' ? img.caption : img.tags

  return (
    <div className="fixed inset-0 z-[10010] bg-black/90 backdrop-blur-sm flex items-center justify-center p-3"
      onClick={e => { e.stopPropagation(); onClose() }}>
      <div onClick={e => e.stopPropagation()}
        className={fullscreen
          ? 'relative w-full h-full flex flex-col overflow-hidden rounded-xl'
          : 'relative w-full max-w-3xl h-[90vh] flex flex-col rounded-2xl border border-white/[0.08] bg-[#070b14]/95 shadow-2xl overflow-hidden'}>

        {/* Media pane — brand backdrop + silver orbit rings */}
        <div ref={paneRef} className="relative flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
          <BrandBackdrop />
          {/* Progressive load: the grid's (browser-cached) 400px thumb shows
              instantly underneath while the full-res image loads, then the full
              image fades in. If the full-res fetch fails, the thumb takes over. */}
          {!fullLoaded && !fullErr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbSrc} alt="" aria-hidden
              className="absolute inset-0 z-[4] w-full h-full object-contain pointer-events-none" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            key={img.id}
            src={fullErr ? thumbSrc : src}
            alt=""
            onLoad={e => { setFullLoaded(true); setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }) }}
            onError={() => { if (src !== thumbSrc) setFullErr(true) }}
            className={`relative z-[5] max-w-full max-h-full object-contain transition-opacity duration-200 ${fullLoaded ? 'opacity-100' : 'opacity-0'}`}
          />
          {!fullLoaded && (
            <span className="absolute z-[6] bottom-2.5 right-2.5 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 border border-white/10 text-[9px] font-mono text-slate-400">
              <Loader2 size={9} className="animate-spin" /> full res…
            </span>
          )}
          <OrbitMediaFrame containerRef={paneRef} mediaRef={imgRef} deps={[index, fullscreen, dims?.w, dims?.h]} />

          <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1.5">
            <button onClick={() => setFullscreen(v => !v)} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              className="w-8 h-8 rounded-lg bg-black/60 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition-colors">
              {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button onClick={onClose}
              className="w-8 h-8 rounded-lg bg-black/60 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition-colors">
              <X size={14} />
            </button>
          </div>
          {index > 0 && (
            <button onClick={() => onNav(index - 1)}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/60 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition-colors">
              <ChevronLeft size={16} />
            </button>
          )}
          {index < images.length - 1 && (
            <button onClick={() => onNav(index + 1)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/60 border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition-colors">
              <ChevronRight size={16} />
            </button>
          )}
          <span className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 px-2 py-0.5 rounded-full bg-black/60 border border-white/10 text-[9px] font-mono text-slate-400">
            {index + 1} / {images.length}
          </span>
        </div>

        {/* Info panel — hidden in fullscreen */}
        {!fullscreen && (
          <div className="shrink-0 border-t border-white/[0.06] px-4 py-3 space-y-2.5 max-h-[38%] overflow-y-auto">
            <div className="flex items-center gap-2 flex-wrap">
              {img.model && (
                <span className="px-2 py-0.5 rounded-full border border-white/15 bg-white/[0.05] text-[9px] font-mono uppercase tracking-wider text-slate-300">{img.model}</span>
              )}
              <span className="text-[9px] font-mono text-slate-600">
                #{img.id}{dims ? ` · ${dims.w}×${dims.h}${(fullErr || !img.url) ? ' (preview — original is larger)' : ''}` : ''}{(img.refCount ?? 0) > 0 ? ` · ${img.refCount} ref${img.refCount === 1 ? '' : 's'}` : ''}
              </span>
              {selectable && (
                <button onClick={() => onToggleSelect(img)}
                  className={`ml-auto px-2.5 py-1 rounded-lg border text-[10px] font-bold transition-colors ${
                    sel ? 'bg-white text-black border-white' : 'bg-white/10 border-white/25 text-white hover:bg-white/15'}`}>
                  {sel ? '✓ In dataset — remove' : 'Add to dataset'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              {(['prompt', 'caption', 'tags'] as const).map(k => (
                <button key={k} onClick={() => setInfoSrc(k)}
                  className={`px-2 py-0.5 rounded-full border text-[9px] font-mono uppercase tracking-wider transition-colors ${
                    infoSrc === k ? 'bg-white/15 border-white/30 text-white' : 'border-white/[0.08] text-slate-500 hover:text-white'}`}>
                  {k}
                  {!!(k === 'caption' ? img.caption : k === 'tags' ? img.tags : img.prompt) && (
                    <span className="ml-1 inline-block w-1 h-1 rounded-full bg-emerald-400/80 align-middle" />
                  )}
                </button>
              ))}
            </div>
            {infoText
              ? <p className="text-[11px] text-slate-300 leading-snug whitespace-pre-wrap break-words">{infoText}</p>
              : <p className="text-[10px] text-slate-600">No {infoSrc} saved for this image.</p>}
            {/* Editable caption — saves into the dataset AND the image record */}
            {onSaveCaption && (
              <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
                <p className="text-[9px] font-mono uppercase tracking-widest text-slate-600">Edit caption</p>
                <textarea value={capDraft} onChange={e => { setCapDraft(e.target.value); setCapSaved(false) }} rows={3}
                  placeholder="Training caption for this image…"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30 resize-none" />
                <button onClick={() => { onSaveCaption(img.id, capDraft.trim()); setCapSaved(true) }}
                  disabled={capSaved}
                  className={`px-3 py-1 rounded-lg border text-[10px] font-semibold transition-colors ${
                    capSaved ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'bg-white/10 border-white/25 text-white hover:bg-white/15'}`}>
                  {capSaved ? '✓ Saved' : 'Save caption'}
                </button>
              </div>
            )}
            {/* Per-image caption source for the training build */}
            {onPatchImage && (
              <div className="flex items-center gap-1 flex-wrap pt-1.5 border-t border-white/[0.06]">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600 mr-1">Caption source</span>
                {(['default', 'caption', 'tags', 'prompt', 'custom'] as const).map(v => (
                  <button key={v} onClick={() => onPatchImage(img.id, { override: v })}
                    className={`px-2 py-0.5 rounded-full border text-[9px] capitalize transition-colors ${
                      img.override === v ? 'bg-white/15 border-white/30 text-white' : 'border-white/[0.08] text-slate-500 hover:text-white'}`}>
                    {v}
                  </button>
                ))}
                {img.override === 'custom' && (
                  <textarea value={img.customText} onChange={e => onPatchImage(img.id, { customText: e.target.value })} rows={2}
                    placeholder="Custom training caption…"
                    className="w-full mt-1 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[10px] text-white placeholder:text-slate-700 resize-none focus:outline-none focus:border-white/30" />
                )}
              </div>
            )}
            {/* Composable txt sections — caption is always the base; toggles
                add clean paragraphs. Persisted on the image (shared with the
                dataset page) and takes precedence over Caption source. */}
            {onSaveSections && (
              <div className="space-y-1.5 pt-1.5 border-t border-white/[0.06]">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600">Txt sections (caption +)</span>
                <div className="flex items-center gap-1 flex-wrap">
                  {([['prompt', 'Original prompt'], ['tags', 'Tags'], ['noteOn', 'Curator note']] as const).map(([k, label]) => {
                    const on = !!img.sections?.[k]
                    return (
                      <button key={k}
                        onClick={() => onSaveSections(img.id, { ...(img.sections ?? {}), [k]: !on })}
                        className={`px-2 py-0.5 rounded-full border text-[9px] transition-colors ${
                          on ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300' : 'border-white/[0.08] text-slate-500 hover:text-white'}`}>
                        + {label}
                      </button>
                    )
                  })}
                </div>
                {img.sections?.noteOn && (
                  <textarea value={img.sections?.note ?? ''} rows={2}
                    onChange={e => onSaveSections(img.id, { ...(img.sections ?? {}), note: e.target.value })}
                    placeholder="Your natural phrasing for this image…"
                    className="w-full px-2 py-1.5 rounded-lg bg-white/[0.04] border border-cyan-500/20 text-[10px] text-white placeholder:text-slate-700 resize-none focus:outline-none focus:border-cyan-500/40" />
                )}
                {!!(img.sections && (img.sections.prompt || img.sections.tags || (img.sections.noteOn && img.sections.note?.trim()))) && (
                  <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/40 border border-white/[0.06] px-2 py-1.5 text-[9.5px] leading-relaxed text-slate-400 font-sans">
                    {resolveDsCaption(img, 'caption')}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BucketPickerModal({ onClose, onBuilt, adminHeaders, initialData }: {
  onClose: () => void
  onBuilt: (key: string, snapshot: DatasetSnapshot) => void
  adminHeaders: Record<string, string>
  initialData?: Partial<DatasetSnapshot> | null
}) {
  // Catalog
  const [buckets, setBuckets] = useState<PickerBucket[]>([])
  const [folders, setFolders] = useState<PickerFolder[]>([])
  const [loading, setLoading] = useState(true)
  // Navigation — album style: root → folders → buckets → image grid
  const [currentFolder, setCurrentFolder] = useState<number | null>(null)
  const [openBucket, setOpenBucket] = useState<PickerBucket | null>(null)
  const [bucketImages, setBucketImages] = useState<DsImage[]>([])
  const [bucketCursor, setBucketCursor] = useState<number | null>(0)
  const [bucketLoading, setBucketLoading] = useState(false)
  // Current dataset
  const [selected, setSelected] = useState<Map<number, DsImage>>(new Map())
  const [defaultSource, setDefaultSource] = useState<'caption' | 'tags' | 'prompt'>('caption')
  // Tap behavior in the image grids: add to dataset vs open the viewer popup
  const [tapMode, setTapMode] = useState<'select' | 'view'>('select')
  const [viewerIdx, setViewerIdx] = useState<number | null>(null)
  // Presets
  const [presets, setPresets] = useState<{ id: number; name: string }[]>([])
  const [presetName, setPresetName] = useState('')
  const [presetBusy, setPresetBusy] = useState(false)
  // Upload (iPad photos → permanent uploads bucket + this dataset)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  // Build
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [buildProgress, setBuildProgress] = useState<{ done: number; total: number; bytes: number; phase: string } | null>(null)
  // Active build's job id — lets the Cancel button stop it server-side
  const buildJobIdRef = useRef<number | null>(null)
  // Longest-side downscale applied server-side while zipping (0 = originals).
  // 1024 default: plenty for 768px training, and fits thousands of images
  // inside the 800MB zip cap instead of ~85 multi-MB originals.
  const [buildMaxDim, setBuildMaxDim] = useState<number>(1024)

  // ── Feed settings — independent per column, persisted ──
  const [feedPrefs, setFeedPrefs] = useState<{ lCols: number; lLayout: 'grid' | 'masonry'; lMode: 'rows' | 'flow'; rCols: number; rLayout: 'grid' | 'masonry'; rMode: 'rows' | 'flow' }>(() => {
    const def = { lCols: 6, lLayout: 'grid' as const, lMode: 'rows' as const, rCols: 4, rLayout: 'masonry' as const, rMode: 'rows' as const }
    try { return { ...def, ...JSON.parse(localStorage.getItem('ot-picker-feed') || '{}') } } catch { return def }
  })
  useEffect(() => { try { localStorage.setItem('ot-picker-feed', JSON.stringify(feedPrefs)) } catch {} }, [feedPrefs])
  const [leftFeedOpen, setLeftFeedOpen] = useState(false)
  const [rightFeedOpen, setRightFeedOpen] = useState(false)

  // ── All Media mode: the left pillar toggles between the folder album and a
  // filtered feed of EVERY generation/upload (same source + filters as the
  // admin/dataset page browser) ──
  const [browseMode, setBrowseMode] = useState<'folders' | 'media'>('folders')
  const [mediaImages, setMediaImages] = useState<DsImage[]>([])
  const [mediaPage, setMediaPage] = useState(1)
  const [mediaTotal, setMediaTotal] = useState(0)
  const [mediaTotalPages, setMediaTotalPages] = useState(1)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaFacets, setMediaFacets] = useState<{ models?: { value: string; count: number }[]; aspects?: { value: string; count: number }[]; qualities?: { value: string; count: number }[]; tags?: { value: string; count: number }[] } | null>(null)
  const [mediaFiltersOpen, setMediaFiltersOpen] = useState(false)
  // Filters (mirroring the dataset page's dropdown)
  const [mfSearch, setMfSearch] = useState('')
  const [mfSearchDeb, setMfSearchDeb] = useState('')
  const [mfModels, setMfModels] = useState<string[]>([])
  const [mfAspects, setMfAspects] = useState<string[]>([])
  const [mfQualities, setMfQualities] = useState<string[]>([])
  const [mfSort, setMfSort] = useState('newest')
  const [mfMediaType, setMfMediaType] = useState('image')
  const [mfHasCaption, setMfHasCaption] = useState('')
  const [mfHasTag, setMfHasTag] = useState('')
  const [mfTag, setMfTag] = useState('')
  const [mfMarkedOnly, setMfMarkedOnly] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMfSearchDeb(mfSearch), 400)
    return () => clearTimeout(t)
  }, [mfSearch])

  const mediaSeqRef = useRef(0)
  const buildMediaParams = () => {
    const params = new URLSearchParams()
    params.set('limit', '100')
    params.set('sort', mfSort)
    if (mfSearchDeb) params.set('search', mfSearchDeb)
    mfModels.forEach(m => params.append('model', m))
    mfAspects.forEach(a => params.append('aspectRatio', a))
    mfQualities.forEach(q => params.append('quality', q))
    if (mfMediaType) params.set('mediaType', mfMediaType)
    if (mfHasCaption) params.set('hasCaption', mfHasCaption)
    if (mfHasTag) params.set('hasTag', mfHasTag)
    if (mfTag) params.set('tagFilter', mfTag)
    if (mfMarkedOnly) params.set('markedOnly', 'true')
    return params
  }
  async function fetchMediaPage(page: number, append: boolean) {
    const seq = ++mediaSeqRef.current
    setMediaLoading(true)
    try {
      const params = buildMediaParams()
      params.set('page', String(page))
      // Facets power the Filters panel — global + heavy, fetch only once
      if (!mediaFacets) params.set('facets', '1')
      const res = await fetch(`/api/admin/dataset?${params}`, { headers: adminHeaders, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return
      const d = await res.json()
      if (seq !== mediaSeqRef.current) return
      const imgs: DsImage[] = (d.images ?? []).map((img: any) => ({
        id: img.id,
        prompt: img.prompt ?? '',
        caption: img.adminCaption ?? '',
        tags: Array.isArray(img.adminTags) ? img.adminTags.join(', ') : '',
        override: 'default' as const,
        customText: '',
        sections: img.captionSections ?? null,
        url: img.imageUrl ?? '',
        thumb: typeof img.thumbnailUrl === 'string' && img.thumbnailUrl ? img.thumbnailUrl : undefined,
        model: img.model ?? '',
        refCount: Array.isArray(img.referenceImageUrls) ? img.referenceImageUrls.length : 0,
        ar: img.aspectRatio ?? undefined,
      }))
      setMediaImages(prev => append ? [...prev, ...imgs] : imgs)
      setMediaPage(page)
      setMediaTotal(d.pagination?.total ?? imgs.length)
      setMediaTotalPages(d.pagination?.totalPages ?? 1)
      if (d.facets) setMediaFacets(d.facets)
    } catch {}
    finally { if (seq === mediaSeqRef.current) setMediaLoading(false) }
  }
  // Refetch page 1 whenever the mode opens or any filter changes
  useEffect(() => {
    if (browseMode !== 'media') return
    fetchMediaPage(1, false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseMode, mfSearchDeb, mfModels, mfAspects, mfQualities, mfSort, mfMediaType, mfHasCaption, mfHasTag, mfTag, mfMarkedOnly])
  // Infinite scroll for the media feed
  const mediaSentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = mediaSentinelRef.current
    if (!el || browseMode !== 'media' || mediaLoading || mediaPage >= mediaTotalPages) return
    const io = new IntersectionObserver(
      entries => { if (entries.some(x => x.isIntersecting)) fetchMediaPage(mediaPage + 1, true) },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseMode, mediaLoading, mediaPage, mediaTotalPages, mediaImages.length])

  // Add EVERY image matching the current filters (ids fetched in one call,
  // captions hydrated from the DB right after)
  const [mediaAddAllBusy, setMediaAddAllBusy] = useState(false)
  async function addAllMedia() {
    if (mediaAddAllBusy) return
    setMediaAddAllBusy(true)
    try {
      const params = buildMediaParams()
      params.set('idsOnly', 'true')
      const res = await fetch(`/api/admin/dataset?${params}`, { headers: adminHeaders })
      if (!res.ok) return
      const d = await res.json()
      const ids: number[] = (d.ids ?? []).slice(0, 5000)
      setSelected(prev => {
        const n = new Map(prev)
        for (const id of ids) if (!n.has(id)) n.set(id, { id, prompt: '', caption: '', tags: '', override: 'default', customText: '' })
        return n
      })
      refreshCaptionsFromDb(ids)
    } catch {}
    finally { setMediaAddAllBusy(false) }
  }
  // Viewer over the CURRENT DATASET column (left grid has its own viewerIdx)
  const [rightViewerIdx, setRightViewerIdx] = useState<number | null>(null)

  // ── Upload progress (chunked bulk uploads) ──
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)

  // ── AutoFill (same background jobs as the Dataset page's AutoFill) ──
  const [afOpen, setAfOpen]           = useState(false)
  const [afMode, setAfMode]           = useState<'flux' | 'caption' | 'tags' | 'append'>('flux')
  // Append mode: curated names/titles wanted (true) vs strict visual-only
  const [afNaming, setAfNaming]       = useState(true)
  const [afModel, setAfModel]         = useState<string>('flash') // key into AUTOFILL_MODELS
  const [afTrigger, setAfTrigger]     = useState('')
  const [afContext, setAfContext]     = useState('')
  const [afOverwrite, setAfOverwrite] = useState(false)
  const [afJob, setAfJob]             = useState<{ id: string; total: number; processed: number; skipped: number; failed: number; status: string } | null>(null)
  const afPollRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const afAppliedRef = useRef<Set<number>>(new Set())
  useEffect(() => () => { if (afPollRef.current) clearInterval(afPollRef.current) }, [])
  // AutoFill TARGETS: while the panel is open, tapping dataset tiles toggles
  // which images the run covers. Opening the panel pre-selects only the
  // UNCAPTIONED images — the usual job is filling gaps; Select all is one tap
  // away for full re-runs.
  const [afTargets, setAfTargets] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (afOpen) setAfTargets(new Set([...selected.values()].filter(i => !i.caption).map(i => i.id)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afOpen])
  const afTargetCount = afOpen ? [...afTargets].filter(id => selected.has(id)).length : selected.size

  // Refresh captions/tags from the DB for specific ids (AutoFill saves there;
  // the job's own results list only keeps the last 100 entries)
  async function refreshCaptionsFromDb(ids: number[]) {
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      try {
        const r = await fetch(`/api/admin/dataset?ids=${part.join(',')}`, { headers: adminHeaders })
        if (!r.ok) continue
        const d = await r.json()
        if (Array.isArray(d.images)) {
          setSelected(prev => {
            const n = new Map(prev)
            for (const row of d.images) {
              const cur = n.get(row.id)
              if (cur) n.set(row.id, {
                ...cur,
                caption: row.adminCaption ?? cur.caption,
                tags: Array.isArray(row.adminTags) && row.adminTags.length > 0 ? row.adminTags.join(', ') : cur.tags,
                sections: row.captionSections !== undefined ? (row.captionSections ?? null) : cur.sections,
                // prompt rides along too — restored snapshots store prompt: ''
                prompt: typeof row.prompt === 'string' && row.prompt ? row.prompt : cur.prompt,
              })
            }
            return n
          })
        }
      } catch {}
    }
  }

  const afRunning = afJob !== null && (afJob.status === 'running' || afJob.status === 'queued')
  async function startAutofill() {
    if (selected.size === 0 || afRunning) return
    setError(null)
    try {
      // Only the tapped targets (panel defaults to all on open)
      const ids = [...afTargets].filter(id => selected.has(id))
      if (ids.length === 0) { setError('No images selected for AutoFill — tap tiles or Select all'); return }
      if (afMode === 'append' && !afContext.trim()) {
        setError('Append Edit needs a description of the edit to apply'); return
      }
      const res = await fetch('/api/admin/auto-caption/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({
          ids, mode: afMode, model: afModel, overwrite: afOverwrite,
          advanced: afMode === 'append' ? afNaming : false,
          context:     afContext.trim() || undefined,
          contextTags: afTrigger.trim() ? [afTrigger.trim()] : undefined,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { jobId } = await res.json()
      afAppliedRef.current = new Set()
      setAfJob({ id: jobId, total: ids.length, processed: 0, skipped: 0, failed: 0, status: 'running' })
      if (afPollRef.current) clearInterval(afPollRef.current)
      afPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/admin/auto-caption/jobs/${jobId}`, { headers: adminHeaders })
          if (!r.ok) return
          const j = await r.json()
          setAfJob({ id: jobId, total: j.totalCount ?? ids.length, processed: j.processedCount ?? 0, skipped: j.skippedCount ?? 0, failed: j.failedCount ?? 0, status: j.status ?? 'running' })
          // Stream fresh results straight into the current dataset
          if (Array.isArray(j.results)) {
            const fresh = j.results.filter((x: any) => x?.type === 'result' && !afAppliedRef.current.has(x.id))
            if (fresh.length > 0) {
              fresh.forEach((x: any) => afAppliedRef.current.add(x.id))
              setSelected(prev => {
                const n = new Map(prev)
                for (const x of fresh) {
                  const cur = n.get(x.id)
                  if (!cur) continue
                  if (afMode === 'tags') n.set(x.id, { ...cur, tags: Array.isArray(x.tags) ? x.tags.join(', ') : String(x.value ?? '') })
                  else n.set(x.id, { ...cur, caption: String(x.value ?? '') })
                }
                return n
              })
            }
          }
          if (j.status !== 'running' && j.status !== 'queued') {
            if (afPollRef.current) { clearInterval(afPollRef.current); afPollRef.current = null }
            // Backfill anything the capped results list dropped
            refreshCaptionsFromDb(ids)
          }
        } catch {}
      }, 3000)
    } catch (e: any) {
      setError(`AutoFill failed to start: ${e?.message || 'error'}`)
    }
  }

  // ── Clear-all confirmation (wipes the whole composition — warn first) ──
  const [clearConfirm, setClearConfirm] = useState(false)
  function clearDataset() {
    setSelected(new Map())
    setRightViewerIdx(null)
    setClearConfirm(false)
  }

  // ── Find & Replace across the current dataset's text (captions, prompts,
  // custom captions). Case-insensitive; changed captions also sync to the DB.
  const [frOpen, setFrOpen]       = useState(false)
  const [frFind, setFrFind]       = useState('')
  const [frReplace, setFrReplace] = useState('')
  const [frBusy, setFrBusy]       = useState(false)
  const [frDone, setFrDone]       = useState<number | null>(null)
  const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const frMatchCount = (() => {
    if (!frOpen || !frFind.trim()) return null
    const rx = new RegExp(escapeRx(frFind.trim()), 'i')
    let images = 0
    for (const img of selected.values()) {
      if (rx.test(img.caption) || rx.test(img.prompt) || rx.test(img.customText)) images++
    }
    return images
  })()
  async function runFindReplace() {
    const find = frFind.trim()
    if (!find || frBusy) return
    setFrBusy(true); setFrDone(null)
    try {
      const rx = () => new RegExp(escapeRx(find), 'gi')
      const next = new Map(selected)
      const changedCaptions: { id: number; caption: string }[] = []
      let changed = 0
      for (const [id, img] of next) {
        const caption    = img.caption.replace(rx(), frReplace)
        const prompt     = img.prompt.replace(rx(), frReplace)
        const customText = img.customText.replace(rx(), frReplace)
        if (caption !== img.caption || prompt !== img.prompt || customText !== img.customText) {
          next.set(id, { ...img, caption, prompt, customText })
          changed++
          if (caption !== img.caption) changedCaptions.push({ id, caption })
        }
      }
      setSelected(next)
      // Persist changed captions to the image records (chunked bulk PATCH)
      for (let i = 0; i < changedCaptions.length; i += 300) {
        await fetch('/api/admin/dataset', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...adminHeaders },
          body: JSON.stringify({ captions: changedCaptions.slice(i, i + 300) }),
        }).catch(() => {})
      }
      setFrDone(changed)
    } finally { setFrBusy(false) }
  }

  // Manual caption edit from the viewer — dataset + DB + left grid dot
  function saveCaption(id: number, caption: string) {
    setSelected(prev => {
      const n = new Map(prev)
      const cur = n.get(id)
      if (cur) n.set(id, { ...cur, caption })
      return n
    })
    setBucketImages(prev => prev.map(i => i.id === id ? { ...i, caption } : i))
    fetch('/api/admin/dataset', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ ids: [id], caption: caption || null }),
    }).catch(() => {})
  }

  // Composable caption sections — updates local composer state AND persists to
  // the image record (shared with the dataset page's section toggles)
  function saveSections(id: number, sections: DsImage['sections']) {
    const clean = sections && (sections.prompt || sections.tags || sections.noteOn || sections.note?.trim())
      ? sections : null
    setSelected(prev => {
      const n = new Map(prev)
      const cur = n.get(id)
      if (cur) n.set(id, { ...cur, sections: clean })
      return n
    })
    setBucketImages(prev => prev.map(i => i.id === id ? { ...i, sections: clean } : i))
    fetch('/api/admin/dataset', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ ids: [id], captionSections: clean }),
    }).catch(() => {})
  }

  useEffect(() => {
    ;(async () => {
      try {
        // 1. FAST catalog (no preview thumbs — single query each): the browser
        //    renders and is fully navigable in one quick round trip
        const [bRes, fRes] = await Promise.all([
          fetch('/api/admin/buckets?fast=1', { headers: adminHeaders }),
          fetch('/api/admin/folders?fast=1', { headers: adminHeaders }),
        ])
        if (bRes.ok) setBuckets(await bRes.json())
        if (fRes.ok) setFolders(await fRes.json())
      } catch {}
      finally { setLoading(false) }
      // 2. Background hydration: presets + the full catalog with preview
      //    thumbnails — tiles fill in as they arrive, no blocking
      fetch('/api/admin/onetrainer/dataset-presets', { headers: adminHeaders })
        .then(async r => { if (r.ok) setPresets((await r.json()).presets ?? []) }).catch(() => {})
      fetch('/api/admin/buckets', { headers: adminHeaders })
        .then(async r => { if (r.ok) setBuckets(await r.json()) }).catch(() => {})
      fetch('/api/admin/folders', { headers: adminHeaders })
        .then(async r => { if (r.ok) setFolders(await r.json()) }).catch(() => {})
    })()
    // Prefill from a reloaded run's dataset composition — else restore the
    // last session's composer state (refresh must not lose in-progress work)
    if (initialData && Array.isArray(initialData.images) && initialData.images.length > 0) {
      const m0 = new Map<number, DsImage>(initialData.images.map((i: any) => [Number(i.id), {
        id: Number(i.id),
        prompt: String(i.prompt ?? ''),
        caption: String(i.caption ?? ''),
        tags: String(i.tags ?? ''),
        override: ['default', 'caption', 'tags', 'prompt', 'custom'].includes(i.override) ? i.override : 'default',
        customText: String(i.customText ?? ''),
      }]))
      setSelected(m0)
      void hydrateSelectedUrls(m0)
      if (initialData.defaultSource && ['caption', 'tags', 'prompt'].includes(initialData.defaultSource)) {
        setDefaultSource(initialData.defaultSource)
      }
      if (initialData.name) setPresetName(initialData.name)
    } else {
      try {
        const s = JSON.parse(localStorage.getItem(PICKER_STATE_KEY) || 'null')
        if (s && typeof s === 'object') {
          if (Array.isArray(s.images) && s.images.length > 0) {
            const ms = new Map<number, DsImage>(s.images.map((i: any) => [Number(i.id), {
              id: Number(i.id),
              prompt: String(i.prompt ?? ''),
              caption: String(i.caption ?? ''),
              tags: String(i.tags ?? ''),
              override: ['default', 'caption', 'tags', 'prompt', 'custom'].includes(i.override) ? i.override : 'default',
              customText: String(i.customText ?? ''),
              ar: typeof i.ar === 'string' ? i.ar : undefined,
              url: typeof i.url === 'string' ? i.url : '',
              thumb: typeof i.thumb === 'string' && i.thumb ? i.thumb : undefined,
            }]))
            setSelected(ms)
            // Items saved before url/thumb were persisted rehydrate them from the DB
            void hydrateSelectedUrls(ms)
          }
          if (['caption', 'tags', 'prompt'].includes(s.defaultSource)) setDefaultSource(s.defaultSource)
          if (typeof s.presetName === 'string') setPresetName(s.presetName)
          if (s.browseMode === 'folders' || s.browseMode === 'media') setBrowseMode(s.browseMode)
          if (s.tapMode === 'select' || s.tapMode === 'view') setTapMode(s.tapMode)
          if ([768, 1024, 1536, 2048, 0].includes(s.buildMaxDim)) setBuildMaxDim(s.buildMaxDim)
          if (typeof s.currentFolder === 'number') setCurrentFolder(s.currentFolder)
          if (typeof s.openBucketId === 'number') pendingOpenBucketRef.current = s.openBucketId
          const mf = s.mf
          if (mf && typeof mf === 'object') {
            if (typeof mf.s === 'string') setMfSearch(mf.s)
            if (Array.isArray(mf.mo)) setMfModels(mf.mo)
            if (Array.isArray(mf.a)) setMfAspects(mf.a)
            if (Array.isArray(mf.q)) setMfQualities(mf.q)
            if (typeof mf.so === 'string') setMfSort(mf.so)
            if (typeof mf.mt === 'string') setMfMediaType(mf.mt)
            if (typeof mf.hc === 'string') setMfHasCaption(mf.hc)
            if (typeof mf.ht === 'string') setMfHasTag(mf.ht)
            if (typeof mf.tg === 'string') setMfTag(mf.tg)
            if (typeof mf.mk === 'boolean') setMfMarkedOnly(mf.mk)
          }
        }
      } catch {}
    }
    pickerHydratedRef.current = true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-open the bucket that was open before the refresh (needs the catalog)
  const pendingOpenBucketRef = useRef<number | null>(null)
  useEffect(() => {
    const id = pendingOpenBucketRef.current
    if (id == null || buckets.length === 0) return
    const b = buckets.find(x => x.id === id)
    pendingOpenBucketRef.current = null
    if (b) openBucketView(b)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets])

  // Debounced persistence of every composer edit (selection, captions, name,
  // filters, navigation). Debounce keeps 1000+-image datasets from stringifying
  // on every keystroke; the unmount cleanup also prevents a StrictMode
  // double-mount from writing defaults over the stored state.
  const pickerHydratedRef = useRef(false)
  const pickerPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!pickerHydratedRef.current) return
    if (pickerPersistTimer.current) clearTimeout(pickerPersistTimer.current)
    pickerPersistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(PICKER_STATE_KEY, JSON.stringify({
          images: [...selected.values()].slice(0, 4000).map(i => ({
            id: i.id, prompt: i.prompt, caption: i.caption, tags: i.tags,
            override: i.override, customText: i.customText, ar: i.ar,
            // Full-res R2 URL — without it, rehydrated items fell back to the
            // 400px thumb in the viewer and reported thumbnail dimensions
            url: i.url, thumb: i.thumb,
          })),
          defaultSource, presetName, browseMode, tapMode, buildMaxDim,
          currentFolder, openBucketId: openBucket?.id ?? null,
          mf: { s: mfSearch, mo: mfModels, a: mfAspects, q: mfQualities, so: mfSort, mt: mfMediaType, hc: mfHasCaption, ht: mfHasTag, tg: mfTag, mk: mfMarkedOnly },
        }))
      } catch { /* quota — skip this write */ }
    }, 800)
    return () => { if (pickerPersistTimer.current) clearTimeout(pickerPersistTimer.current) }
  }, [selected, defaultSource, presetName, browseMode, tapMode, buildMaxDim, currentFolder, openBucket,
      mfSearch, mfModels, mfAspects, mfQualities, mfSort, mfMediaType, mfHasCaption, mfHasTag, mfTag, mfMarkedOnly])

  // ── Bucket image browsing (manifest pagination) ──
  // Load failures surface with a Retry (a hung request previously left the
  // "Loading more…" placeholder spinning forever)
  const [bucketError, setBucketError] = useState<string | null>(null)
  async function fetchManifestPage(bucketId: number, cursor: number, limit = 100) {
    // 100/page for browsing (fast first paint; the scroll sentinel streams the
    // rest); Add-all passes 500 to cut the round trips 5×.
    // Two attempts (15s then 30s) before surfacing the Retry error — a single
    // slow query under dev-server load shouldn't force a manual tap.
    const attemptFetch = async (ms: number) => {
      const res = await fetch(`/api/admin/buckets/${bucketId}/manifest?cursor=${cursor}&limit=${limit}`,
        { headers: adminHeaders, signal: AbortSignal.timeout(ms) })
      if (!res.ok) throw new Error(`Failed to load bucket (HTTP ${res.status})`)
      return res.json()
    }
    let data: any
    try {
      data = await attemptFetch(15_000)
    } catch (e: any) {
      if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') throw e
      data = await attemptFetch(30_000)
    }
    const imgs: DsImage[] = (data.images ?? []).map(mapManifestImg)
    return { imgs, nextCursor: data.hasMore ? data.nextCursor as number : null }
  }
  function mapManifestImg(img: any): DsImage {
    return {
      id: img.id,
      prompt: img.prompt ?? '',
      caption: img.adminCaption ?? '',
      tags: normTags(img.tags),
      override: 'default' as const,
      customText: '',
      sections: img.captionSections ?? null,
      url: img.url ?? '',
      thumb: typeof img.thumbnailUrl === 'string' && img.thumbnailUrl ? img.thumbnailUrl : undefined,
      model: img.model ?? '',
      refCount: Array.isArray(img.referenceImageUrls) ? img.referenceImageUrls.length : 0,
      ar: img.aspectRatio ?? undefined,
    }
  }

  async function openBucketView(b: PickerBucket) {
    setOpenBucket(b); setBucketImages([]); setBucketCursor(0); setBucketLoading(true); setBucketError(null)
    try {
      const { imgs, nextCursor } = await fetchManifestPage(b.id, 0)
      setBucketImages(imgs); setBucketCursor(nextCursor)
    } catch (e: any) {
      setBucketError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Loading timed out — tap Retry' : (e?.message || 'Failed to load'))
    }
    finally { setBucketLoading(false) }
  }

  async function loadMoreBucket(force = false) {
    if (!openBucket || bucketCursor === null || bucketLoading || (bucketError && !force)) return
    setBucketLoading(true)
    try {
      const { imgs, nextCursor } = await fetchManifestPage(openBucket.id, bucketCursor)
      setBucketImages(prev => [...prev, ...imgs]); setBucketCursor(nextCursor)
    } catch (e: any) {
      setBucketError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Loading timed out — tap Retry' : (e?.message || 'Failed to load'))
    }
    finally { setBucketLoading(false) }
  }
  function retryBucket() {
    if (!openBucket) return
    setBucketError(null)
    if (bucketImages.length === 0) openBucketView(openBucket)
    else loadMoreBucket(true)
  }

  // Infinite scroll: stream the next page in as the sentinel nears the viewport
  // (portal-v2 feed behavior — no tapping "Load more")
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = loadMoreSentinelRef.current
    if (!el || bucketCursor === null || bucketLoading) return
    const io = new IntersectionObserver(
      entries => { if (entries.some(x => x.isIntersecting)) loadMoreBucket() },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketCursor, bucketLoading, openBucket])

  // ── Selection ──
  const toggleImage = (img: DsImage) => setSelected(prev => {
    const n = new Map(prev)
    if (n.has(img.id)) n.delete(img.id); else n.set(img.id, { ...img })
    return n
  })
  const removeImage = (id: number) => setSelected(prev => { const n = new Map(prev); n.delete(id); return n })
  const patchImage = (id: number, patch: Partial<DsImage>) => setSelected(prev => {
    const n = new Map(prev)
    const cur = n.get(id)
    if (cur) n.set(id, { ...cur, ...patch })
    return n
  })

  const [addAllProgress, setAddAllProgress] = useState<{ done: number; total: number } | null>(null)
  // Shown right next to the Add-all button — the bucket view's error slot sits
  // BELOW the grid, off-screen, which made failures look silent
  const [addAllError, setAddAllError] = useState<string | null>(null)
  async function addWholeBucket(b: PickerBucket) {
    if (addAllProgress) return
    setAddAllError(null)
    setAddAllProgress({ done: 0, total: b.count })
    try {
      // ONE server round-trip for the whole bucket (up to 5000 rows) — Add all
      // doesn't page through the browsing feed. Two attempts (30s then 60s)
      // before surfacing an error.
      const attemptFetch = async (ms: number) => {
        const res = await fetch(`/api/admin/buckets/${b.id}/manifest?cursor=0&all=1`,
          { headers: adminHeaders, signal: AbortSignal.timeout(ms) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      }
      let data: any
      try {
        data = await attemptFetch(30_000)
      } catch (e: any) {
        if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') throw e
        data = await attemptFetch(60_000)
      }
      const imgs: DsImage[] = (data.images ?? []).map(mapManifestImg)
      if (imgs.length === 0) { setAddAllError('Bucket returned no usable images'); return }
      // Chunked application with yields → the counter counts up live
      let added = 0
      for (let ci = 0; ci < imgs.length; ci += 25) {
        const chunk = imgs.slice(ci, ci + 25)
        setSelected(prev => {
          const n = new Map(prev)
          for (const img of chunk) if (!n.has(img.id)) n.set(img.id, { ...img })
          return n
        })
        added += chunk.length
        setAddAllProgress({ done: Math.min(added, b.count), total: b.count })
        await new Promise(r => setTimeout(r, 0))
      }
    } catch (e: any) {
      setAddAllError(e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'Add all timed out twice — the server is busy, try again'
        : `Add all failed — ${e?.message || 'unknown error'}`)
    }
    finally { setAddAllProgress(null) }
  }

  // ── Upload from device (full quality → uploads bucket + dataset) ──
  // CHUNKED: big batches go up 8 files per request — one giant multipart body
  // would blow the request size limit and give no progress signal. The counter
  // ticks per chunk and images land in the dataset as they upload.
  async function handleUploadFiles(files: File[]) {
    const uploadsBucket = buckets.find(b => b.name.toLowerCase() === 'uploads') ?? buckets.find(b => /upload/i.test(b.name))
    if (!uploadsBucket) { setError('No "uploads" bucket found on the Dataset page — create one first.'); return }
    setUploadBusy(true); setError(null); setUploadProgress({ done: 0, total: files.length })
    const CHUNK = 8
    let uploadedTotal = 0
    try {
      for (let ci = 0; ci < files.length; ci += CHUNK) {
        const chunk = files.slice(ci, ci + CHUNK)
        const widths: number[] = [], heights: number[] = []
        for (const f of chunk) {
          try { const bmp = await createImageBitmap(f); widths.push(bmp.width); heights.push(bmp.height); bmp.close() }
          catch { widths.push(0); heights.push(0) }
        }
        const form = new FormData()
        form.append('bucketId', String(uploadsBucket.id))
        form.append('widths', JSON.stringify(widths))
        form.append('heights', JSON.stringify(heights))
        form.append('metadataJson', JSON.stringify(chunk.map(() => ({}))))
        for (const f of chunk) form.append('files', f)
        const res = await fetch('/api/admin/dataset/upload', { method: 'POST', headers: adminHeaders, body: form })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !Array.isArray(data.ids)) throw new Error(data.error || 'Upload failed')
        setSelected(prev => {
          const n = new Map(prev)
          data.ids.forEach((id: number, i: number) => {
            n.set(id, {
              id,
              prompt: (chunk[i]?.name ?? '').replace(/\.[^.]+$/, ''),
              caption: '', tags: '',
              override: 'default', customText: '',
            })
          })
          return n
        })
        uploadedTotal += data.ids.length
        // New uploads also live in the permanent uploads bucket — refresh its count
        setBuckets(prev => prev.map(b => b.id === uploadsBucket.id ? { ...b, count: b.count + data.ids.length } : b))
        setUploadProgress({ done: Math.min(ci + chunk.length, files.length), total: files.length })
      }
    } catch (e: any) {
      setError(`${e?.message || 'Upload failed'}${uploadedTotal > 0 ? ` — ${uploadedTotal} of ${files.length} made it into the dataset` : ''}`)
    } finally {
      setUploadBusy(false)
      setUploadProgress(null)
    }
  }

  // Restore paths (presets, run reload, older saved sessions) carry only ids +
  // captions — re-attach the full-res url + R2 thumb from the DB so previews
  // load sharp instead of falling back to the degraded 400px endpoint forever.
  async function hydrateSelectedUrls(map: Map<number, DsImage>) {
    const missing = [...map.values()].filter(i => !i.url || !i.thumb).map(i => i.id)
    for (let ci = 0; ci < missing.length; ci += 200) {
      const chunk = missing.slice(ci, ci + 200)
      try {
        const res = await fetch(`/api/admin/dataset?ids=${chunk.join(',')}`, { headers: adminHeaders, signal: AbortSignal.timeout(20_000) })
        if (!res.ok) continue
        const d = await res.json()
        const byId = new Map<number, any>((d.images ?? []).map((r: any) => [r.id, r]))
        setSelected(prev => {
          const n = new Map(prev)
          for (const [id, cur] of n) {
            const r = byId.get(id)
            if (!r) continue
            n.set(id, {
              ...cur,
              url: cur.url || (r.imageUrl ?? ''),
              thumb: cur.thumb || (typeof r.thumbnailUrl === 'string' && r.thumbnailUrl ? r.thumbnailUrl : undefined),
              ar: cur.ar ?? (r.aspectRatio ?? undefined),
            })
          }
          return n
        })
      } catch { /* transient — tiles keep the endpoint fallback */ }
    }
  }

  // ── Presets ──
  async function refreshPresets() {
    try {
      const res = await fetch('/api/admin/onetrainer/dataset-presets', { headers: adminHeaders })
      if (res.ok) setPresets((await res.json()).presets ?? [])
    } catch {}
  }
  async function savePreset() {
    if (selected.size === 0 || presetBusy) return
    setPresetBusy(true)
    setError(null)
    try {
      const name = presetName.trim() || `Dataset ${new Date().toLocaleDateString()}`
      // Slim payload: only what loadPreset restores. The viewer extras (url/
      // model/refCount) are re-fetched from the manifest and just bloat large
      // presets past the size cap.
      const images = [...selected.values()].map(i => ({
        id: i.id, prompt: i.prompt, caption: i.caption, tags: i.tags, override: i.override, customText: i.customText,
      }))
      const res = await fetch('/api/admin/onetrainer/dataset-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ name, data: { defaultSource, images } }),
      })
      if (res.ok) { setPresetName(''); refreshPresets() }
      else {
        const d = await res.json().catch(() => ({}))
        setError(`Preset save failed: ${d.error || `HTTP ${res.status}`}`)
      }
    } catch (e: any) {
      setError(`Preset save failed: ${e?.message || 'network error'}`)
    } finally { setPresetBusy(false) }
  }
  async function loadPreset(id: number) {
    setPresetBusy(true)
    try {
      const res = await fetch(`/api/admin/onetrainer/dataset-presets?id=${id}`, { headers: adminHeaders })
      if (!res.ok) return
      const { data } = await res.json()
      if (data && Array.isArray(data.images)) {
        const m = new Map<number, DsImage>(data.images.map((i: any) => [Number(i.id), {
          id: Number(i.id),
          prompt: String(i.prompt ?? ''),
          caption: String(i.caption ?? ''),
          tags: String(i.tags ?? ''),
          override: ['default', 'caption', 'tags', 'prompt', 'custom'].includes(i.override) ? i.override : 'default',
          customText: String(i.customText ?? ''),
        }]))
        setSelected(m)
        void hydrateSelectedUrls(m)
        if (['caption', 'tags', 'prompt'].includes(data.defaultSource)) setDefaultSource(data.defaultSource)
      }
    } finally { setPresetBusy(false) }
  }
  async function deletePreset(id: number) {
    await fetch(`/api/admin/onetrainer/dataset-presets?id=${id}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {})
    refreshPresets()
  }

  // ── Build ──
  // Builds are server-side BACKGROUND jobs: POST returns a jobId instantly and
  // the zip keeps building even if this popup/page/device goes away. We poll
  // the job here for the live bar; the main page (any device) also discovers
  // it via ?active=1 and can attach the result when it finishes.
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => { if (buildPollRef.current) clearInterval(buildPollRef.current) }, [])

  async function build() {
    if (selected.size === 0 || building) return
    setBuilding(true); setError(null); setBuildProgress(null)
    try {
      const items = [...selected.values()].map(i => ({ id: i.id, caption: resolveDsCaption(i, defaultSource) }))
      const res = await fetch('/api/admin/onetrainer/cloud/build-dataset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ items, name: presetName.trim() || 'dataset', maxDim: buildMaxDim }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.jobId) throw new Error(data.error || `Build failed (${res.status})`)
      buildJobIdRef.current = data.jobId
      const snapshot: DatasetSnapshot = { name: presetName.trim() || 'dataset', defaultSource, images: [...selected.values()] }
      const total = selected.size
      buildPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${data.jobId}`, { headers: adminHeaders })
          if (!r.ok) return
          const j = await r.json()
          if (!j) return
          setBuildProgress({ done: j.progressDone ?? 0, total: j.progressTotal ?? 0, bytes: j.progressBytes ?? 0, phase: j.phase ?? 'fetching' })
          if (j.status === 'completed') {
            if (buildPollRef.current) { clearInterval(buildPollRef.current); buildPollRef.current = null }
            fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${data.jobId}`, { method: 'PATCH', headers: adminHeaders }).catch(() => {})
            if (j.truncated || (j.resultSkipped ?? 0) > 0) {
              alert(
                `Dataset built with ${j.resultCount} of ${total} images (${j.resultSizeMb} MB).` +
                (j.truncated
                  ? `\n\nThe zip hit the 2 GB size cap — ${j.resultSkipped} image(s) were left out.`
                  : `\n\n${j.resultSkipped} image(s) failed to download and were skipped.`)
              )
            }
            onBuilt(j.resultKey, snapshot)
          } else if (j.status === 'failed') {
            if (buildPollRef.current) { clearInterval(buildPollRef.current); buildPollRef.current = null }
            buildJobIdRef.current = null
            setError(`Build failed: ${j.error || 'unknown error'}`)
            setBuilding(false)
            setBuildProgress(null)
          } else if (j.status === 'cancelled') {
            if (buildPollRef.current) { clearInterval(buildPollRef.current); buildPollRef.current = null }
            buildJobIdRef.current = null
            setBuilding(false)
            setBuildProgress(null)
          }
        } catch {}
      }, 2000)
    } catch (e: any) {
      setError(e?.message || 'Build failed')
      setBuilding(false)
      setBuildProgress(null)
    }
  }

  async function cancelBuild() {
    const jid = buildJobIdRef.current
    // Optimistic: stop polling + reset the UI immediately; the server-side
    // runner sees the cancelled status on its next progress tick and aborts
    if (buildPollRef.current) { clearInterval(buildPollRef.current); buildPollRef.current = null }
    buildJobIdRef.current = null
    setBuilding(false)
    setBuildProgress(null)
    if (jid != null) {
      fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${jid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ cancel: true }),
      }).catch(() => {})
    }
  }

  // ── Folder tree search: matches EVERY folder and bucket by name, from
  // anywhere in the tree — results jump straight to the folder/bucket ──
  const [folderSearch, setFolderSearch] = useState('')
  const folderPathOf = (fid: number | null): string => {
    const parts: string[] = []
    let cur = fid, guard = 0
    while (cur !== null && guard++ < 20) {
      const f = folders.find(x => x.id === cur)
      if (!f) break
      parts.unshift(f.name)
      cur = f.parentId ?? null
    }
    return parts.join(' / ')
  }
  const folderQuery = folderSearch.trim().toLowerCase()
  const searchFolders = folderQuery ? folders.filter(f => f.name.toLowerCase().includes(folderQuery)) : []
  const searchBuckets = folderQuery ? buckets.filter(b => b.name.toLowerCase().includes(folderQuery)) : []

  // ── Navigation data ──
  const subFolders = folders.filter(f => (f.parentId ?? null) === currentFolder)
  const levelBuckets = buckets.filter(b => (b.folderId ?? null) === currentFolder)
  const crumb: PickerFolder[] = []
  {
    let fid = currentFolder
    while (fid !== null) {
      const f = folders.find(x => x.id === fid)
      if (!f) break
      crumb.unshift(f)
      fid = f.parentId ?? null
    }
  }

  const OVERRIDES = [['default', 'Default'], ['caption', 'Caption'], ['tags', 'Tags'], ['prompt', 'Prompt'], ['custom', 'Custom']] as const

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3" onClick={onClose}>
      <div className="relative w-full h-[94vh] rounded-2xl border border-white/[0.08] bg-[#070b14]/95 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2.5">
            <SiteLogoBox size={26} rounded={9} />
            <div>
              <p className="text-sm font-bold text-white leading-none">Choose Training Data</p>
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 leading-none mt-1">Dataset composer</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors"><X size={15} /></button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* ── LEFT: album-style browser — equal pillar with the dataset ── */}
          <div className="flex-1 basis-0 min-w-0 flex flex-col">
            {/* Breadcrumb / bucket header */}
            {/* NOTE: flex-wrap, not overflow-x-auto — an overflowing container
                CLIPS the absolutely-positioned Feed/Filters popovers */}
            <div className="relative z-40 flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-white/[0.06] shrink-0">
              {openBucket ? (
                <>
                  <button onClick={() => { setOpenBucket(null); setBucketImages([]) }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0">
                    <ArrowLeft size={11} /> Back
                  </button>
                  <span className="text-[12px] font-semibold text-white shrink-0">{openBucket.name}</span>
                  <span className="text-[10px] text-slate-600 font-mono shrink-0">{openBucket.count} items</span>
                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {/* Feed settings for the browser grid */}
                    <div className="relative">
                      <button onClick={() => setLeftFeedOpen(v => !v)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                          leftFeedOpen ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                        <Settings2 size={10} /> Feed
                      </button>
                      {leftFeedOpen && (
                        <PickerFeedPop cols={feedPrefs.lCols} layout={feedPrefs.lLayout} mode={feedPrefs.lMode}
                          onCols={n => setFeedPrefs(p => ({ ...p, lCols: n }))}
                          onLayout={l => setFeedPrefs(p => ({ ...p, lLayout: l }))}
                          onMode={m => setFeedPrefs(p => ({ ...p, lMode: m }))} />
                      )}
                    </div>
                    {/* Tap-mode toggle: Select adds to the dataset, View opens the popup viewer */}
                    <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
                      <button onClick={() => setTapMode('select')}
                        title="Tapping an image adds/removes it from the dataset"
                        className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                          tapMode === 'select' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                        <CheckCircle size={10} /> Select
                      </button>
                      <button onClick={() => setTapMode('view')}
                        title="Tapping an image opens it in the viewer"
                        className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                          tapMode === 'view' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                        <Eye size={10} /> View
                      </button>
                    </div>
                    <button onClick={() => addWholeBucket(openBucket)} disabled={!!addAllProgress}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-medium hover:bg-white/15 transition-colors disabled:opacity-60">
                      {addAllProgress && <Loader2 size={10} className="animate-spin" />}
                      {addAllProgress ? `Adding ${addAllProgress.done}/${addAllProgress.total}…` : 'Add all'}
                    </button>
                    {addAllError && (
                      <span className="text-[10px] text-red-400 max-w-[200px] truncate" title={addAllError}>⚠ {addAllError}</span>
                    )}
                    <button onClick={() => setSelected(prev => { const n = new Map(prev); bucketImages.forEach(i => n.delete(i.id)); return n })}
                      className="px-2.5 py-1 rounded-lg border border-white/10 text-slate-400 text-[10px] hover:text-white transition-colors">
                      Remove all
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* Source toggle: folder album ⟷ every generation/upload */}
                  <div className="flex items-center rounded-lg border border-white/10 overflow-hidden shrink-0">
                    <button onClick={() => setBrowseMode('folders')}
                      className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${browseMode === 'folders' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                      All folders
                    </button>
                    <button onClick={() => setBrowseMode('media')}
                      className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${browseMode === 'media' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                      All media
                    </button>
                  </div>
                  {browseMode === 'folders' ? (
                    <>
                      {crumb.length > 0 && (
                        <button onClick={() => setCurrentFolder(null)}
                          className="px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0">
                          root
                        </button>
                      )}
                      {crumb.map(f => (
                        <span key={f.id} className="flex items-center gap-1.5 shrink-0">
                          <span className="text-slate-700 text-[10px]">/</span>
                          <button onClick={() => setCurrentFolder(f.id)}
                            className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${currentFolder === f.id ? 'text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'}`}>
                            {f.name}
                          </button>
                        </span>
                      ))}
                      {/* Whole-tree search — jumps to any folder/bucket */}
                      <div className="ml-auto relative shrink-0">
                        <input value={folderSearch} onChange={e => setFolderSearch(e.target.value)} placeholder="Search folders…"
                          className="w-44 pl-2.5 pr-6 py-1 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-600 focus:outline-none focus:border-white/30" />
                        {folderSearch && (
                          <button onClick={() => setFolderSearch('')}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
                            <X size={10} />
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="text-[10px] text-slate-600 font-mono shrink-0">{mediaTotal} items</span>
                      <div className="ml-auto flex items-center gap-1.5 shrink-0">
                        <div className="relative">
                          <button onClick={() => setMediaFiltersOpen(v => !v)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                              mediaFiltersOpen ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                            <Settings2 size={10} /> Filters
                          </button>
                          {mediaFiltersOpen && (
                            <div className="absolute right-0 top-full mt-1.5 z-50 w-[340px] rounded-xl bg-[#070b14]/95 backdrop-blur-md border border-white/[0.08] shadow-2xl p-3 space-y-2.5" onClick={e => e.stopPropagation()}>
                              <input value={mfSearch} onChange={e => setMfSearch(e.target.value)} placeholder="Search prompts…"
                                className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                              <div className="grid grid-cols-2 gap-1.5">
                                <select value={mfSort} onChange={e => setMfSort(e.target.value)}
                                  className="px-2 py-1.5 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none cursor-pointer">
                                  <option value="newest">Newest first</option>
                                  <option value="oldest">Oldest first</option>
                                  <option value="rating">Highest rated</option>
                                  <option value="cost">Highest cost</option>
                                </select>
                                <select value={mfMediaType} onChange={e => setMfMediaType(e.target.value)}
                                  className="px-2 py-1.5 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none cursor-pointer">
                                  <option value="image">Images only</option>
                                  <option value="">Images &amp; videos</option>
                                  <option value="video">Videos only</option>
                                </select>
                                <select value={mfHasCaption} onChange={e => setMfHasCaption(e.target.value)}
                                  className="px-2 py-1.5 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none cursor-pointer">
                                  <option value="">Caption: any</option>
                                  <option value="true">Has caption</option>
                                  <option value="false">No caption</option>
                                </select>
                                <select value={mfHasTag} onChange={e => setMfHasTag(e.target.value)}
                                  className="px-2 py-1.5 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none cursor-pointer">
                                  <option value="">Tags: any</option>
                                  <option value="true">Has tags</option>
                                  <option value="false">No tags</option>
                                </select>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <select value={mfTag} onChange={e => setMfTag(e.target.value)}
                                  className="flex-1 px-2 py-1.5 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none cursor-pointer">
                                  <option value="">Filter by tag…</option>
                                  {(mediaFacets?.tags ?? []).map(t => <option key={t.value} value={t.value}>#{t.value} ({t.count})</option>)}
                                </select>
                                <button onClick={() => setMfMarkedOnly(v => !v)}
                                  className={`px-2 py-1.5 rounded-lg border text-[10px] transition-colors ${
                                    mfMarkedOnly ? 'bg-white/15 border-white/30 text-white' : 'border-white/[0.08] text-slate-500 hover:text-white'}`}>
                                  Marked only
                                </button>
                              </div>
                              <PickerMultiChips label="Models" values={mfModels} onChange={setMfModels}
                                options={(mediaFacets?.models ?? []).map(m => ({ value: m.value, label: `${m.value.replace('fal-ai/', '')} (${m.count})` }))} />
                              <PickerMultiChips label="Aspect ratios" values={mfAspects} onChange={setMfAspects}
                                options={(mediaFacets?.aspects ?? []).map(a => ({ value: a.value, label: `${a.value} (${a.count})` }))} />
                              <PickerMultiChips label="Quality" values={mfQualities} onChange={setMfQualities}
                                options={(mediaFacets?.qualities ?? []).map(q => ({ value: q.value, label: `${q.value} (${q.count})` }))} />
                            </div>
                          )}
                        </div>
                        <div className="relative">
                          <button onClick={() => setLeftFeedOpen(v => !v)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                              leftFeedOpen ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                            <Settings2 size={10} /> Feed
                          </button>
                          {leftFeedOpen && (
                            <PickerFeedPop cols={feedPrefs.lCols} layout={feedPrefs.lLayout} mode={feedPrefs.lMode}
                              onCols={n => setFeedPrefs(p => ({ ...p, lCols: n }))}
                              onLayout={l => setFeedPrefs(p => ({ ...p, lLayout: l }))}
                              onMode={m => setFeedPrefs(p => ({ ...p, lMode: m }))} />
                          )}
                        </div>
                        {/* Tap-mode toggle (same as bucket view) */}
                        <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
                          <button onClick={() => setTapMode('select')}
                            className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                              tapMode === 'select' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                            <CheckCircle size={10} /> Select
                          </button>
                          <button onClick={() => setTapMode('view')}
                            className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                              tapMode === 'view' ? 'bg-white/15 text-white' : 'text-slate-500 hover:text-white'}`}>
                            <Eye size={10} /> View
                          </button>
                        </div>
                        <button onClick={addAllMedia} disabled={mediaAddAllBusy || mediaTotal === 0}
                          title="Add every image matching the current filters"
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-medium hover:bg-white/15 transition-colors disabled:opacity-60">
                          {mediaAddAllBusy && <Loader2 size={10} className="animate-spin" />}
                          {mediaAddAllBusy ? 'Adding…' : `Add all (${mediaTotal})`}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Browser body */}
            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-slate-600 text-xs gap-2"><Loader2 size={13} className="animate-spin" /> Loading…</div>
              ) : (openBucket || browseMode === 'media') ? (
                <>
                  {(() => {
                    const masonry = feedPrefs.lLayout === 'masonry'
                    const list = openBucket ? bucketImages : mediaImages
                    const tile = (img: DsImage, idx: number) => {
                      const isSel = selected.has(img.id)
                      return (
                        <button key={img.id} onClick={() => tapMode === 'view' ? setViewerIdx(idx) : toggleImage(img)}
                          className={`relative rounded-lg overflow-hidden border-2 bg-white/[0.04] transition-all ${
                            masonry ? 'w-full mb-1.5 break-inside-avoid block min-h-12' : 'aspect-square'} ${
                            isSel ? 'border-white ring-1 ring-white/40' : 'border-transparent hover:border-white/30'}`}>
                          <RetryImg src={img.thumb || `/api/admin/dataset/thumb/${img.id}`}
                            className={`${masonry ? 'w-full h-auto block' : 'w-full h-full object-cover'} ${isSel ? 'opacity-80' : ''}`} />
                          {/* Green check = has an admin caption (same as the Dataset page) */}
                          {!!img.caption && (
                            <span className="absolute bottom-1 left-1 w-4 h-4 rounded-full bg-emerald-500/80 flex items-center justify-center" title="Has caption">
                              <Check size={9} className="text-white" strokeWidth={3} />
                            </span>
                          )}
                          {isSel && (
                            <span className="absolute bottom-1 right-1 w-4 h-4 rounded-full bg-white flex items-center justify-center">
                              <CheckCircle size={10} className="text-black" />
                            </span>
                          )}
                          {tapMode === 'view' && (
                            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 border border-white/20 flex items-center justify-center">
                              <Eye size={9} className="text-slate-200" />
                            </span>
                          )}
                        </button>
                      )
                    }
                    if (masonry && feedPrefs.lMode === 'rows') {
                      // Rows: JS shortest-column packing — fills left-to-right,
                      // balanced by aspect ratio, appended pages never reflow
                      return (
                        <div className="flex gap-1.5 items-start">
                          {pickerDistribute(list.map((img, idx) => ({ img, idx, weight: pickerArWeight(img.ar) })), feedPrefs.lCols).map((col, ci) => (
                            <div key={ci} className="flex-1 min-w-0">
                              {col.map(({ img, idx }) => tile(img, idx))}
                            </div>
                          ))}
                        </div>
                      )
                    }
                    return masonry ? (
                      <div className={PICKER_MASONRY_COLS[feedPrefs.lCols] ?? 'columns-6'} style={{ columnGap: '0.375rem' }}>
                        {list.map((img, idx) => tile(img, idx))}
                      </div>
                    ) : (
                      <div className={`grid gap-1.5 ${PICKER_GRID_COLS[feedPrefs.lCols] ?? 'grid-cols-6'}`}>
                        {list.map((img, idx) => tile(img, idx))}
                      </div>
                    )
                  })()}
                  {openBucket ? (
                    <>
                      {bucketError && (
                        <div className="mt-3 flex flex-col items-center gap-2 py-4">
                          <p className="text-[11px] text-red-400">{bucketError}</p>
                          <button onClick={retryBucket}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-white text-[11px] font-medium hover:bg-white/15 transition-colors">
                            <RefreshCw size={11} /> Retry
                          </button>
                        </div>
                      )}
                      {!bucketError && bucketLoading && bucketImages.length === 0 && (
                        <div className="flex items-center justify-center py-10 text-slate-600 text-xs gap-2">
                          <Loader2 size={13} className="animate-spin" /> Loading {openBucket.count} items…
                        </div>
                      )}
                      {!bucketError && bucketImages.length > 0 && bucketCursor !== null && (
                        <div ref={loadMoreSentinelRef} className="mt-3 flex items-center justify-center py-3 text-slate-600 text-[11px] gap-2">
                          <Loader2 size={12} className="animate-spin" /> Loading more…
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {mediaImages.length === 0 && !mediaLoading && (
                        <p className="text-center text-slate-600 text-xs py-10">No media matches these filters.</p>
                      )}
                      {mediaLoading && mediaImages.length === 0 && (
                        <div className="flex items-center justify-center py-10 text-slate-600 text-xs gap-2"><Loader2 size={13} className="animate-spin" /> Loading…</div>
                      )}
                      {mediaPage < mediaTotalPages && (
                        <div ref={mediaSentinelRef} className="mt-3 flex items-center justify-center py-3 text-slate-600 text-[11px] gap-2">
                          <Loader2 size={12} className="animate-spin" /> Loading more…
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : folderQuery ? (
                /* Tree-wide search results */
                <div className="space-y-4">
                  {searchFolders.length === 0 && searchBuckets.length === 0 && (
                    <p className="text-center text-slate-600 text-xs py-10">Nothing matches &quot;{folderSearch.trim()}&quot;.</p>
                  )}
                  {searchFolders.length > 0 && (
                    <div>
                      <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-slate-500 mb-2">Folders</p>
                      <div className="space-y-1">
                        {searchFolders.map(f => (
                          <button key={f.id} onClick={() => { setCurrentFolder(f.id); setFolderSearch('') }}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/25 text-left transition-colors">
                            <FolderOpen size={12} className="text-slate-500 shrink-0" />
                            <span className="text-[11px] font-semibold text-white truncate">{f.name}</span>
                            {folderPathOf(f.parentId ?? null) && (
                              <span className="text-[9px] text-slate-600 font-mono truncate">in {folderPathOf(f.parentId ?? null)}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {searchBuckets.length > 0 && (
                    <div>
                      <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-slate-500 mb-2">Buckets</p>
                      <div className="space-y-1">
                        {searchBuckets.map(b => (
                          <button key={b.id} onClick={() => { openBucketView(b); setFolderSearch('') }}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/25 text-left transition-colors">
                            <span className="text-[11px] font-semibold text-white truncate">{b.name}</span>
                            {folderPathOf(b.folderId ?? null) && (
                              <span className="text-[9px] text-slate-600 font-mono truncate">in {folderPathOf(b.folderId ?? null)}</span>
                            )}
                            <span className="ml-auto text-[9px] text-slate-600 font-mono shrink-0">{b.count}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {subFolders.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                      {subFolders.map(f => (
                        <button key={f.id} onClick={() => setCurrentFolder(f.id)}
                          className="text-left rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/20 p-2 space-y-1.5 transition-colors">
                          <div className="grid grid-cols-2 gap-0.5 rounded-md overflow-hidden">
                            {[0, 1, 2, 3].map(i => (
                              <div key={i} className="aspect-square bg-black">
                                {f.previewUrls?.[i] && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={f.previewUrls[i]} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                                )}
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <FolderOpen size={11} className="text-slate-500 shrink-0" />
                            <p className="text-[11px] font-semibold text-white truncate">{f.name}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {levelBuckets.length > 0 && (
                    <div>
                      <p className="text-[9px] font-mono font-bold uppercase tracking-[0.2em] text-slate-500 mb-2">Buckets</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                        {levelBuckets.map(b => (
                          <button key={b.id} onClick={() => openBucketView(b)}
                            className="text-left rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/20 p-2 space-y-1.5 transition-colors">
                            <div className="grid grid-cols-2 gap-0.5 rounded-md overflow-hidden">
                              {[0, 1, 2, 3].map(i => (
                                <div key={i} className="aspect-square bg-black">
                                  {b.previewUrls[i] && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={b.previewUrls[i]} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                                  )}
                                </div>
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-1">
                              <p className="text-[11px] font-semibold text-white truncate">{b.name}</p>
                              <span className="text-[9px] text-slate-600 font-mono shrink-0">{b.count}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {subFolders.length === 0 && levelBuckets.length === 0 && (
                    <p className="text-center text-slate-600 text-xs py-10">Nothing here.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT: current dataset — equal pillar (stacks under the browser
              on phones; side-by-side from lg up) ── */}
          <div className="flex-1 basis-0 min-w-0 border-t lg:border-t-0 lg:border-l border-white/[0.06] flex flex-col min-h-0">
            <div className="relative z-40 px-4 py-2.5 border-b border-white/[0.06] shrink-0 flex items-center gap-2">
              <p className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-slate-400 shrink-0">Current Dataset</p>
              <span className="text-[10px] text-slate-500 font-mono shrink-0">{selected.size} images</span>
              <div className="ml-auto flex items-center gap-1.5">
                {/* Clear the whole composition (confirmation required) */}
                {selected.size > 0 && (
                  <button onClick={() => setClearConfirm(true)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-red-400 hover:border-red-500/30 text-[10px] font-medium transition-colors">
                    <Trash2 size={10} /> Clear
                  </button>
                )}
                {/* Find & Replace across all dataset text */}
                <div className="relative">
                  <button onClick={() => { setFrOpen(v => !v); setFrDone(null) }}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                      frOpen ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                    <RefreshCw size={10} /> Replace
                  </button>
                  {frOpen && (
                    <div className="absolute right-0 top-full mt-1.5 z-50 w-72 rounded-xl bg-[#070b14]/95 backdrop-blur-md border border-white/[0.08] shadow-2xl p-3 space-y-2" onClick={e => e.stopPropagation()}>
                      <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.2em] text-slate-500">Find &amp; replace</p>
                      <input value={frFind} onChange={e => { setFrFind(e.target.value); setFrDone(null) }} placeholder="Find… (e.g. forest)"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                      <input value={frReplace} onChange={e => { setFrReplace(e.target.value); setFrDone(null) }} placeholder="Replace with… (e.g. river)"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                      {frMatchCount !== null && frDone === null && (
                        <p className="text-[10px] font-mono text-slate-500">
                          Found in <span className="text-white">{frMatchCount}</span> of {selected.size} images
                        </p>
                      )}
                      {frDone !== null && (
                        <p className="text-[10px] font-mono text-emerald-300">
                          ✓ Updated {frDone} image{frDone === 1 ? '' : 's'} — caption changes saved to the images too
                        </p>
                      )}
                      <button onClick={runFindReplace} disabled={!frFind.trim() || frBusy || frMatchCount === 0}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-semibold hover:bg-white/15 transition-colors disabled:opacity-40">
                        {frBusy ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                        {frBusy ? 'Replacing…' : `Replace all${frMatchCount ? ` (${frMatchCount})` : ''}`}
                      </button>
                      <p className="text-[8px] text-slate-700 leading-relaxed">
                        Case-insensitive. Applies to captions, prompts and custom captions of every image in this dataset.
                      </p>
                    </div>
                  )}
                </div>
                {/* Captioned coverage — how many tiles carry the green check */}
                {selected.size > 0 && (() => {
                  const capped = [...selected.values()].filter(i => !!i.caption).length
                  return (
                    <span className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-mono shrink-0 ${
                      capped === selected.size ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-slate-400'}`}
                      title={`${capped} of ${selected.size} images have a caption`}>
                      <span className="w-3.5 h-3.5 rounded-full bg-emerald-500/80 flex items-center justify-center">
                        <Check size={8} className="text-white" strokeWidth={3} />
                      </span>
                      {capped}/{selected.size}
                    </span>
                  )
                })()}
                {/* AutoFill — flux captioning on everything in this dataset */}
                <button onClick={() => setAfOpen(v => !v)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                    afOpen || afRunning ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                  <Sparkles size={10} /> AutoFill{afRunning && afJob ? ` ${afJob.processed + afJob.skipped + afJob.failed}/${afJob.total}` : ''}
                </button>
                <div className="relative">
                  <button onClick={() => setRightFeedOpen(v => !v)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                      rightFeedOpen ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>
                    <Settings2 size={10} /> Feed
                  </button>
                  {rightFeedOpen && (
                    <PickerFeedPop cols={feedPrefs.rCols} layout={feedPrefs.rLayout} mode={feedPrefs.rMode}
                      onCols={n => setFeedPrefs(p => ({ ...p, rCols: n }))}
                      onLayout={l => setFeedPrefs(p => ({ ...p, rLayout: l }))}
                      onMode={m => setFeedPrefs(p => ({ ...p, rMode: m }))} />
                  )}
                </div>
              </div>
            </div>

            <div className="px-4 py-2.5 border-b border-white/[0.06] shrink-0 space-y-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-600 shrink-0">Default captions</span>
                {([['caption', 'Captions'], ['tags', 'Tags'], ['prompt', 'Prompts']] as const).map(([v, l]) => (
                  <button key={v} onClick={() => setDefaultSource(v)}
                    className={`px-2 py-0.5 rounded-md border text-[9px] font-medium transition-colors ${defaultSource === v ? 'bg-white/10 border-white/25 text-white' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => uploadInputRef.current?.click()} disabled={uploadBusy}
                  className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-medium hover:bg-white/15 transition-colors disabled:opacity-40">
                  {uploadBusy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                  {uploadBusy
                    ? (uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…` : 'Uploading…')
                    : 'Upload photos'}
                </button>
                <input ref={uploadInputRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={e => { const fl = Array.from(e.target.files ?? []); if (fl.length) handleUploadFiles(fl); e.target.value = '' }} />
              </div>
              <div className="flex items-center gap-1.5">
                <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="Dataset name…"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[10px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                <button onClick={savePreset} disabled={selected.size === 0 || presetBusy}
                  title="Save the current dataset as a preset"
                  className="px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-400 text-[10px] hover:text-white hover:border-white/25 transition-colors disabled:opacity-40 shrink-0">
                  Save
                </button>
              </div>
              {presets.length > 0 && (
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {presets.map(pr => (
                    <div key={pr.id} className="flex items-center gap-1.5">
                      <button onClick={() => loadPreset(pr.id)} disabled={presetBusy}
                        className="flex-1 min-w-0 text-left px-2 py-1 rounded-lg border border-white/[0.07] bg-white/[0.02] text-[10px] text-slate-300 hover:border-white/20 hover:text-white truncate transition-colors disabled:opacity-40">
                        {pr.name}
                      </button>
                      <button onClick={() => deletePreset(pr.id)} title="Delete preset"
                        className="p-1 rounded text-slate-700 hover:text-red-400 transition-colors shrink-0">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* AutoFill panel — flux captioning for the whole current dataset */}
            {afOpen && (
              <div className="px-4 py-2.5 border-b border-white/[0.06] shrink-0 space-y-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {([['flux', 'FLUX Caption'], ['caption', 'Caption'], ['tags', 'Tags'], ['append', 'Append Edit']] as const).map(([v, l]) => (
                    <button key={v} onClick={() => setAfMode(v)}
                      className={`px-2 py-1 rounded-md border text-[9px] font-medium transition-colors ${
                        afMode === v
                          ? v === 'flux' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                          : v === 'append' ? 'bg-violet-500/15 border-violet-500/30 text-violet-300'
                          : 'bg-white/10 border-white/25 text-white'
                          : 'border-white/10 text-slate-500 hover:text-slate-300'}`}>
                      {l}
                    </button>
                  ))}
                  <span className="w-px h-3 bg-white/10" />
                  <select value={afModel} onChange={e => setAfModel(e.target.value)}
                    className="px-1.5 py-1 rounded-md border border-white/10 bg-[#0a101d] text-[9px] text-white focus:outline-none focus:border-white/30 cursor-pointer">
                    {AUTOFILL_MODELS.map(m => (
                      <option key={m.key} value={m.key}>{m.label}</option>
                    ))}
                  </select>
                  {/* Append always rewrites the caption it revises */}
                  {afMode !== 'append' && (
                    <button onClick={() => setAfOverwrite(v => !v)}
                      title="Re-caption images that already have a caption"
                      className={`px-2 py-1 rounded-md border text-[9px] transition-colors ${
                        afOverwrite ? 'bg-white/10 border-white/25 text-white' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}>
                      Overwrite
                    </button>
                  )}
                </div>
                {afMode === 'append' && (
                  <>
                    <p className="text-[9px] text-violet-300/80 leading-relaxed">
                      Rewrites each image&apos;s <span className="text-violet-200">existing</span> caption using your description below. Uncaptioned images are skipped.
                    </p>
                    <button onClick={() => setAfNaming(v => !v)}
                      className={`w-full px-2 py-1 rounded-md border text-[9px] text-left transition-colors ${
                        afNaming ? 'bg-violet-500/10 border-violet-500/25 text-violet-200' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}>
                      {afNaming ? '✓ Curated naming — names + titles become prompt handles' : 'Strict visual only — no names or titles'}
                    </button>
                  </>
                )}
                <div className="flex items-center gap-1.5">
                  <input value={afTrigger} onChange={e => setAfTrigger(e.target.value)}
                    placeholder={afMode === 'append' ? 'Trigger word to preserve…' : 'Trigger word (e.g. myloRa)…'}
                    className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[10px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                </div>
                <textarea value={afContext} onChange={e => setAfContext(e.target.value)} rows={afMode === 'append' ? 4 : 2}
                  placeholder={afMode === 'append'
                    ? 'Describe the edit in your own words…\n\ne.g. Tony Bulgoni wearing his red and white super suit — call it "red and white super suit" every time'
                    : 'Extra context for the captioner (subject name, style notes…)'}
                  className={`w-full px-2 py-1.5 rounded-lg text-[10px] text-white placeholder:text-slate-700 focus:outline-none resize-none ${
                    afMode === 'append'
                      ? 'bg-violet-500/[0.04] border border-violet-500/25 focus:border-violet-500/50'
                      : 'bg-white/[0.04] border border-white/[0.08] focus:border-white/30'}`} />
                {afMode === 'append' && (
                  <p className="text-[9px] text-slate-600 leading-relaxed">
                    Your exact wording is adopted for anything <span className="text-slate-400">visible</span> in the image. Lore the model can&apos;t see (film titles, backstory) is left out rather than asserted.
                  </p>
                )}
                {/* Target picker — tap tiles below to choose which images run */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] font-mono text-amber-300/80">
                    {afTargetCount}/{selected.size} targeted — tap tiles below to pick
                  </span>
                  <button onClick={() => setAfTargets(new Set([...selected.values()].filter(i => !i.caption).map(i => i.id)))}
                    className="px-2 py-0.5 rounded-md border border-white/10 text-[9px] text-slate-400 hover:text-white transition-colors">
                    Uncaptioned
                  </button>
                  <button onClick={() => setAfTargets(new Set(selected.keys()))}
                    className="px-2 py-0.5 rounded-md border border-white/10 text-[9px] text-slate-400 hover:text-white transition-colors">
                    Select all
                  </button>
                  <button onClick={() => setAfTargets(new Set())}
                    className="px-2 py-0.5 rounded-md border border-white/10 text-[9px] text-slate-400 hover:text-white transition-colors">
                    Clear
                  </button>
                </div>
                <button onClick={startAutofill}
                  disabled={afTargetCount === 0 || afRunning || (afMode === 'append' && !afContext.trim())}
                  className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border text-[10px] font-semibold transition-colors disabled:opacity-40 ${
                    afMode === 'append'
                      ? 'bg-violet-500/15 border-violet-500/30 text-violet-300 hover:bg-violet-500/25'
                      : 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25'}`}>
                  {afRunning ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                  {afRunning && afJob
                    ? `${afMode === 'append' ? 'Revising' : 'Captioning'} ${afJob.processed + afJob.skipped + afJob.failed}/${afJob.total}…`
                    : afMode === 'append' && !afContext.trim()
                      ? 'Describe the edit above'
                      : `${afMode === 'append' ? 'Append Edit to' : 'AutoFill'} ${afTargetCount} image${afTargetCount === 1 ? '' : 's'}`}
                </button>
                {afJob && !afRunning && (
                  <p className="text-[9px] text-slate-500 font-mono">
                    Done — {afJob.processed} {afMode === 'append' ? 'revised' : 'captioned'}{afJob.skipped > 0 ? ` · ${afJob.skipped} skipped` : ''}{afJob.failed > 0 ? ` · ${afJob.failed} failed` : ''}. Captions saved to the images.
                  </p>
                )}
                {afRunning && (
                  <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-amber-500/60 to-amber-300 transition-[width] duration-500"
                      style={{ width: `${afJob ? ((afJob.processed + afJob.skipped + afJob.failed) / Math.max(1, afJob.total)) * 100 : 0}%` }} />
                  </div>
                )}
              </div>
            )}

            {/* Current dataset — feed grid (tap a tile to view/edit its caption) */}
            <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
              {selected.size === 0 ? (
                <p className="text-[10px] text-slate-600 text-center py-8 px-3 leading-relaxed">
                  Browse your folders on the left and tap images to add them — or upload photos directly.
                </p>
              ) : (() => {
                const arr = [...selected.values()]
                const tile = (img: DsImage, idx: number, masonry: boolean) => {
                  // AutoFill-target mode: while the panel is open, taps toggle
                  // whether this image is in the run (instead of opening the viewer)
                  const afSel = afOpen && afTargets.has(img.id)
                  return (
                  <div key={img.id}
                    onClick={() => afOpen
                      ? setAfTargets(prev => { const n = new Set(prev); if (n.has(img.id)) n.delete(img.id); else n.add(img.id); return n })
                      : setRightViewerIdx(idx)}
                    className={`relative rounded-lg overflow-hidden border bg-white/[0.03] cursor-pointer transition-all group ${
                      afOpen
                        ? (afSel ? 'border-amber-400 ring-1 ring-amber-400/50' : 'border-white/[0.07] opacity-45 hover:opacity-80')
                        : 'border-white/[0.07] hover:border-white/30'} ${
                      masonry ? 'w-full mb-1.5 break-inside-avoid min-h-12' : 'aspect-square'}`}>
                    <RetryImg src={img.thumb || `/api/admin/dataset/thumb/${img.id}`}
                      className={masonry ? 'w-full h-auto block' : 'w-full h-full object-cover'} />
                    {afOpen && (
                      <span className={`absolute top-1 left-1 w-4 h-4 rounded-full border flex items-center justify-center ${
                        afSel ? 'bg-amber-400 border-amber-400' : 'bg-black/60 border-white/40'}`}>
                        {afSel && <Check size={9} className="text-black" strokeWidth={3} />}
                      </span>
                    )}
                    {!!img.caption && (
                      <span className="absolute bottom-1 left-1 w-4 h-4 rounded-full bg-emerald-500/80 flex items-center justify-center" title="Has caption">
                        <Check size={9} className="text-white" strokeWidth={3} />
                      </span>
                    )}
                    {!afOpen && (
                      <button onClick={e => { e.stopPropagation(); removeImage(img.id) }} title="Remove from dataset"
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 border border-white/15 text-slate-400 hover:text-red-400 items-center justify-center hidden group-hover:flex">
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  )
                }
                if (feedPrefs.rLayout === 'masonry' && feedPrefs.rMode === 'rows') {
                  return (
                    <div className="flex gap-1.5 items-start">
                      {pickerDistribute(arr.map((img, idx) => ({ img, idx, weight: pickerArWeight(img.ar) })), feedPrefs.rCols).map((col, ci) => (
                        <div key={ci} className="flex-1 min-w-0">
                          {col.map(({ img, idx }) => tile(img, idx, true))}
                        </div>
                      ))}
                    </div>
                  )
                }
                return feedPrefs.rLayout === 'masonry' ? (
                  <div className={PICKER_MASONRY_COLS[feedPrefs.rCols] ?? 'columns-4'} style={{ columnGap: '0.375rem' }}>
                    {arr.map((img, idx) => tile(img, idx, true))}
                  </div>
                ) : (
                  <div className={`grid gap-1.5 ${PICKER_GRID_COLS[feedPrefs.rCols] ?? 'grid-cols-4'}`}>
                    {arr.map((img, idx) => tile(img, idx, false))}
                  </div>
                )
              })()}
            </div>

            {/* Build */}
            <div className="p-3 border-t border-white/[0.06] shrink-0 space-y-2">
              {error && <p className="text-[10px] text-red-400">{error}</p>}
              {/* Image size — server downscales while zipping so big datasets fit the 800MB cap */}
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-mono uppercase tracking-wider text-slate-600 shrink-0">Image size</span>
                <select value={buildMaxDim} onChange={e => setBuildMaxDim(parseInt(e.target.value))}
                  className="flex-1 px-2 py-1 rounded-lg bg-[#0d1322] border border-white/[0.08] text-[10px] text-white focus:outline-none focus:border-white/30 cursor-pointer">
                  <option value={768}>768px — smallest, matches training res</option>
                  <option value={1024}>1024px — recommended</option>
                  <option value={1536}>1536px — high detail</option>
                  <option value={2048}>2048px — very high detail</option>
                  <option value={0}>Original — full size (fits ~85 large images)</option>
                </select>
              </div>
              <button onClick={build} disabled={selected.size === 0 || building}
                className="relative overflow-hidden w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-white/10 border border-white/25 text-white text-xs font-bold hover:bg-white/15 transition-all disabled:opacity-40">
                {!building && selected.size > 0 && (
                  <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent pointer-events-none" style={{ animation: 'sheen-sweep 2.6s infinite' }} />
                )}
                {building ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                {building ? 'Building dataset zip…' : `Build dataset (${selected.size} images)`}
              </button>
              {building && buildProgress && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[9px] font-mono">
                    <span className="text-slate-500">
                      {buildProgress.phase === 'uploading'
                        ? 'Uploading zip to storage…'
                        : `Fetching & resizing ${buildProgress.done}/${buildProgress.total}`}
                    </span>
                    <span className="text-slate-400 tabular-nums">
                      {Math.round(buildProgress.bytes / 1024 / 1024)} MB · {Math.round((buildProgress.done / Math.max(1, buildProgress.total)) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-slate-400 to-white transition-[width] duration-500 ease-out overflow-hidden relative"
                      style={{ width: `${(buildProgress.done / Math.max(1, buildProgress.total)) * 100}%` }}
                    >
                      <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/60 to-transparent" style={{ animation: 'sheen-sweep 2.2s infinite' }} />
                    </div>
                  </div>
                  <button onClick={cancelBuild}
                    className="w-full py-1 rounded-lg border border-white/10 text-[10px] text-slate-500 hover:text-red-400 hover:border-red-500/30 transition-colors">
                    Cancel build
                  </button>
                </div>
              )}
              {building && selected.size > 500 && (
                <p className="text-[9px] text-slate-600 text-center leading-snug">
                  Large dataset — the server is downloading and zipping every image. Expect a few minutes; keep this tab open.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Clear-dataset warning */}
      {clearConfirm && (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setClearConfirm(false)}>
          <div className="relative w-full max-w-sm rounded-2xl border border-red-500/25 bg-[#070b14]/95 shadow-2xl p-5 space-y-3"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <Trash2 size={14} className="text-red-400" />
              </div>
              <p className="text-sm font-bold text-white">Clear the current dataset?</p>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This removes all <span className="text-white font-semibold">{selected.size} images</span> from
              this composition, including any caption-source overrides and custom captions you set here.
              The images themselves and captions saved to them (AutoFill, viewer edits) are NOT affected.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => setClearConfirm(false)}
                className="flex-1 py-2 rounded-lg border border-white/15 bg-white/[0.05] text-slate-300 text-[11px] font-semibold hover:text-white hover:bg-white/[0.08] transition-colors">
                Cancel
              </button>
              <button onClick={clearDataset}
                className="flex-1 py-2 rounded-lg border border-red-500/40 bg-red-500/15 text-red-300 text-[11px] font-bold hover:bg-red-500/25 transition-colors">
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image viewer popup — portal-v2-style display with fullscreen */}
      {viewerIdx !== null && (openBucket ? bucketImages : mediaImages).length > 0 && (
        <DatasetImageViewer
          images={openBucket ? bucketImages : mediaImages}
          index={Math.min(viewerIdx, (openBucket ? bucketImages : mediaImages).length - 1)}
          onClose={() => setViewerIdx(null)}
          onNav={setViewerIdx}
          isSelected={(id) => selected.has(id)}
          onToggleSelect={toggleImage}
          onSaveCaption={saveCaption}
          onSaveSections={saveSections}
        />
      )}
      {/* Current-dataset viewer — view/edit captions + per-image caption source */}
      {rightViewerIdx !== null && selected.size > 0 && (
        <DatasetImageViewer
          images={[...selected.values()]}
          index={Math.min(rightViewerIdx, selected.size - 1)}
          onClose={() => setRightViewerIdx(null)}
          onNav={setRightViewerIdx}
          isSelected={(id) => selected.has(id)}
          onToggleSelect={toggleImage}
          onSaveCaption={saveCaption}
          onSaveSections={saveSections}
          onPatchImage={patchImage}
        />
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function OneTrainerPage() {
  // ── Access gate: admin password (set by the /admin login) must be present
  // AND valid. null = checking, false = locked, true = in.
  const [accessOk, setAccessOk] = useState<boolean | null>(null)
  useEffect(() => {
    const pass = getPass()
    if (!pass) { setAccessOk(false); return }
    fetch('/api/admin/onetrainer/dataset-presets', { headers: ah() })
      .then(r => setAccessOk(r.status !== 401))
      .catch(() => setAccessOk(true)) // network hiccup — don't lock out a valid admin
  }, [])

  // Mode
  // Local/cloud toggle — persisted; hydrated in an effect (NOT a lazy
  // initializer: that runs during SSR too, where localStorage is missing, and
  // the server/client mismatch threw a React hydration error)
  const [mode, setMode] = useState<'local' | 'cloud' | 'fal'>('cloud')

  // Server (local mode)
  const [serverRunning, setServerRunning] = useState(false)
  const [serverLoading, setServerLoading] = useState(false)

  // Presets
  const [presets, setPresets]               = useState<Preset[]>([])
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null)

  // Overrides
  const [runName,    setRunName]    = useState('My Training Run')
  // fal API mode (Wan 2.2 Video via fal-ai/wan-22-trainer): trains on the
  // datasets composed below — clips + GIFs (GIFs auto-convert server-side)
  const [falCfg, setFalCfg] = useState({
    variant: 't2v-a14b' as 't2v-a14b' | 'i2v-a14b',
    steps: '400',
    learningRate: '0.0002',
    triggerPhrase: '',
    autoScale: true,
  })
  const [falJobId, setFalJobId] = useState<number | null>(null)
  const [lr,         setLr]         = useState('')
  const [batchSize,  setBatchSize]  = useState('')
  const [epochs,     setEpochs]     = useState('')
  const [maxSteps,   setMaxSteps]   = useState('')
  const [resolution, setResolution] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [loraRank,   setLoraRank]   = useState('')

  // Advanced overrides (empty = keep preset default)
  const [loraAlpha,        setLoraAlpha]        = useState('')
  const [loraDropout,      setLoraDropout]      = useState('')
  const [lrScheduler,      setLrScheduler]      = useState('')
  const [warmupSteps,      setWarmupSteps]      = useState('')
  const [optimizerName,    setOptimizerName]    = useState('')
  const [timestepDist,     setTimestepDist]     = useState('')
  const [trainTextEncoder, setTrainTextEncoder] = useState(false)

  // Snapshots — save intermediate LoRAs every N epochs OR every N steps
  // (step-based is the only useful mode when huge datasets run 1–3 epochs)
  const [saveEpochs,    setSaveEpochs]    = useState(true)
  const [saveEvery,     setSaveEvery]     = useState('1')
  const [saveEveryUnit, setSaveEveryUnit] = useState<'EPOCH' | 'STEP'>('EPOCH')

  // How many trained runs exist per base checkpoint — likeness quality varies
  // a LOT by base (same proven recipe learned perfectly on one checkpoint and
  // failed on another), so surface which bases are battle-tested
  const [baseRunCounts, setBaseRunCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    fetch('/api/admin/flux-inference/models')
      .then(r => r.json())
      .then((d: { r2?: { loraBaseModels?: Record<string, string> } }) => {
        const counts: Record<string, number> = {}
        for (const base of Object.values(d.r2?.loraBaseModels ?? {})) {
          counts[base] = (counts[base] ?? 0) + 1
        }
        setBaseRunCounts(counts)
      })
      .catch(() => {})
  }, [])

  // Training method: LoRA adapter vs FULL fine-tune of the checkpoint.
  // Fine-tune on the A40 requires Adafactor (AdamW's optimizer state alone
  // exceeds 48GB VRAM for a 12B model) and a much gentler LR.
  const [trainMethod, setTrainMethod] = useState<'lora' | 'finetune'>('lora')
  function applyTrainMethod(m: 'lora' | 'finetune') {
    setTrainMethod(m)
    if (m === 'finetune') {
      setLr('0.000008')            // ~1e-5 territory — LoRA LRs fry a full FT
      setLoraRank(''); setLoraAlpha(''); setLoraDropout('')
      setOptimizerName('ADAFACTOR')
      setSaveEpochs(false)         // each fine-tune snapshot is a full ~22GB model
    } else {
      setOptimizerName('')
      setSaveEpochs(true)
    }
  }

  // Quick-setup recipe chips — picking one fills every setting with tuned values
  const [recipeSubject, setRecipeSubject] = useState<RecipeSubject | null>(null)
  const [recipeSize,    setRecipeSize]    = useState<RecipeSize | null>(null)

  function applyRecipe(subject: RecipeSubject | null, size: RecipeSize | null) {
    setRecipeSubject(subject)
    setRecipeSize(size)
    // Missing half falls back to the most common case so one tap already helps
    const sub = RECIPE_SUBJECTS[subject ?? 'character']
    const sz  = RECIPE_SIZES[size ?? 'm']
    let ep    = Math.max(1, Math.round(sz.epochs * sub.mult))
    // STEP-BUDGET floor: identity learning needs ~500+ total optimizer steps
    // no matter the dataset size. Tier epochs alone under-provision tiny sets
    // (26 imgs × 20 epochs @ batch 4 = only ~130 steps — a run that learns
    // nothing). When a dataset is attached, raise epochs to hit the budget.
    const attachedCount = concepts.reduce((sum, c) => sum + (conceptSnapshots[c.id]?.images.length ?? 0), 0)
    if (attachedCount > 0) {
      const stepsPerEpoch = Math.max(1, Math.ceil(attachedCount / 4))
      const minSteps = Math.round(550 * Math.max(1, sub.mult))
      ep = Math.max(ep, Math.min(300, Math.ceil(minSteps / stepsPerEpoch)))
    }
    // Long runs get a gentler LR; huge diverse sets get a rank floor (alpha
    // keeps the subject's alpha:rank ratio when the floor kicks in)
    const lr    = parseFloat((parseFloat(sub.lr) * sz.lrMult).toFixed(6))
    const rank  = Math.max(parseInt(sub.rank), sz.rankFloor)
    const alpha = Math.max(1, Math.round(rank * (parseInt(sub.alpha) / parseInt(sub.rank))))
    // Fine-tune keeps its own LR/optimizer — recipe LRs are LoRA-scale and
    // would destroy a full fine-tune; rank/alpha don't apply at all
    setLr(trainMethod === 'finetune' ? '0.000008' : String(lr))
    setBatchSize('4')
    setEpochs(String(ep))
    setMaxSteps(String(Math.round(sz.cap * Math.max(1, sub.mult) / 100) * 100))
    setResolution('768')
    if (trainMethod === 'lora') {
      setLoraRank(String(rank))
      setLoraAlpha(String(alpha))
      setLoraDropout(sub.dropout)
    }
    setLrScheduler(sub.sched)
    setWarmupSteps(sub.warmup)
    setOptimizerName(trainMethod === 'finetune' ? 'ADAFACTOR' : '')
    setTimestepDist('LOGIT_NORMAL')
    setTrainTextEncoder(false)
    setSaveEpochs(trainMethod !== 'finetune')
    // ~10 snapshots per run: per-epoch for normal sizes, per-step for huge
    // datasets where the whole run is only 1–3 epochs
    if (sz.stepSnap > 0) {
      setSaveEveryUnit('STEP')
      setSaveEvery(String(sz.stepSnap))
    } else {
      setSaveEveryUnit('EPOCH')
      setSaveEvery(String(Math.max(1, Math.round(ep / 10))))
    }
  }

  // Local checkpoint scanner
  const [scanDir,           setScanDir]           = useState('C:\\Users\\Owner\\Downloads')
  const [checkpointFiles,   setCheckpointFiles]   = useState<{ name: string; path: string; size_gb: number }[]>([])
  const [scanLoading,       setScanLoading]       = useState(false)

  // R2 checkpoints (cloud mode)
  const [r2Checkpoints,        setR2Checkpoints]        = useState<R2Checkpoint[]>([])
  const [r2CheckpointsLoading, setR2CheckpointsLoading] = useState(false)

  // Shared: selected checkpoint (local path in local mode, R2 key in cloud mode)
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('')

  // Concepts
  const [concepts, setConcepts] = useState<Concept[]>([emptyConcept()])

  // Local training status
  const [trainStatus, setTrainStatus] = useState<TrainStatus>({
    status: 'idle', pid: null, logs: [], returncode: null, started_at: null, run_name: null,
  })

  // Cloud training status
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null)
  const [cloudJobId,  setCloudJobId]  = useState<string | null>(null)

  // Concurrent cloud runs tracked on the Monitor tab (each RunPod submission is
  // its own serverless worker). Persisted so a refresh keeps monitoring them.
  // SERVER-BACKED: the tracked list comes from each run's run.json in R2 (the
  // train route records job_id + started_at at launch), so every admin device
  // monitors the same runs. Previously this lived in localStorage, which meant
  // a run was only visible on the browser that launched it.
  const [cloudRuns, setCloudRuns] = useState<TrackedRun[]>([])
  const refreshTrackedRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/onetrainer/runs?tracked=1', { headers: ah(), signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return
      const d = await res.json()
      if (Array.isArray(d?.runs)) {
        setCloudRuns(prev => {
          // Keep any run this device just launched but the list hasn't caught
          // up to yet (R2 list is eventually consistent)
          const serverIds = new Set(d.runs.map((r: TrackedRun) => r.jobId))
          const pendingLocal = prev.filter(p => !serverIds.has(p.jobId) && Date.now() - p.startedAt < 120_000)
          return [...pendingLocal, ...d.runs]
        })
      }
    } catch {}
  }, [])
  useEffect(() => {
    refreshTrackedRuns()
    const t = setInterval(refreshTrackedRuns, 60_000)
    return () => clearInterval(t)
  }, [refreshTrackedRuns])
  // Relaunch a failed run from its recorded run.json — same config, concepts
  // (dataset zips already live in R2) and base checkpoint. The train route
  // auto-versions the display name, so the retry lands as "<name> v2" rather
  // than colliding with the failed run's folder.
  const retryCloudRun = async (meta: Record<string, unknown>, runName: string) => {
    const config = meta.config
    const concepts = meta.concepts
    const checkpoint = meta.checkpoint_r2_key
    if (!config || !Array.isArray(concepts) || concepts.length === 0 || !checkpoint) {
      alert('This run has no saved recipe to retry from (missing config, concepts or checkpoint).')
      return
    }
    try {
      const res = await fetch('/api/admin/onetrainer/cloud/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({
          run_name: runName,
          config,
          concepts,
          checkpoint_r2_key: checkpoint,
          ...(meta.dataset ? { run_meta: { dataset: meta.dataset } } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.job_id) { alert(d.error ?? `Retry failed (${res.status})`); return }
      trackRun({
        jobId: d.job_id,
        runName: d.run_name || runName,
        runFolder: d.run_folder || runName.replace(/[^a-z0-9_-]/gi, '_'),
        startedAt: Date.now(),
      })
    } catch (e) {
      alert(`Retry failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Optimistic local add on launch; the next server refresh confirms it
  const trackRun = (r: TrackedRun) => {
    setCloudRuns(prev => [r, ...prev.filter(x => x.jobId !== r.jobId)].slice(0, 20))
    setTimeout(() => { void refreshTrackedRuns() }, 3000)
  }
  // Dismiss persists to R2 so the run hides on every device
  const dismissRun = (jobId: string) => {
    setCloudRuns(prev => prev.filter(x => x.jobId !== jobId))
    fetch('/api/admin/onetrainer/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah() },
      body: JSON.stringify({ action: 'dismiss', jobId }),
    }).catch(() => {})
  }
  // Monitor "Show completed" toggle — each card reports its live status up so
  // finished runs can be hidden without unmounting the active pollers
  const [showCompleted, setShowCompleted] = useState<boolean>(() => {
    try { return localStorage.getItem('ot-monitor-show-completed') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ot-monitor-show-completed', showCompleted ? '1' : '0') } catch {} }, [showCompleted])
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({})

  const [launching, setLaunching] = useState(false)
  // Active section persists across refreshes. Hydrate + persist run in
  // effects with a gate flag (StrictMode-safe): lazy initializers reading
  // localStorage mismatch the SSR render and throw hydration errors.
  const [tab, setTab]             = useState<'config' | 'monitor' | 'loras' | 'history'>('config')
  const [uiPrefsHydrated, setUiPrefsHydrated] = useState(false)
  // Training-preset dropdown (replaced the permanent left column)
  const [presetDdOpen, setPresetDdOpen] = useState(false)
  const presetDdRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!presetDdOpen) return
    const onDown = (e: MouseEvent) => {
      if (presetDdRef.current && !presetDdRef.current.contains(e.target as Node)) setPresetDdOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [presetDdOpen])
  useEffect(() => {
    try {
      const t = localStorage.getItem('ot-active-tab')
      if (t === 'monitor' || t === 'loras' || t === 'history') {
        setTab(t)
        // Trigger the load the tab button's onClick would normally have fired
        if (t === 'loras' || t === 'history') loadRuns()
      }
    } catch {}
    try {
      const m = localStorage.getItem('ot-mode')
      if (m === 'local' || m === 'fal') setMode(m)
    } catch {}
    setUiPrefsHydrated(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (uiPrefsHydrated) { try { localStorage.setItem('ot-active-tab', tab) } catch {} } }, [tab, uiPrefsHydrated])
  useEffect(() => { if (uiPrefsHydrated) { try { localStorage.setItem('ot-mode', mode) } catch {} } }, [mode, uiPrefsHydrated])

  // Saved LoRAs (cloud mode) — grouped training runs + legacy flat files
  const [runsList,       setRunsList]       = useState<RunInfo[]>([])
  const [legacyLoras,    setLegacyLoras]    = useState<R2Checkpoint[]>([])
  const [r2LorasLoading, setR2LorasLoading] = useState(false)
  const [lorasError,     setLorasError]     = useState<string | null>(null)

  // Dataset composition snapshots per concept (stored in run.json for Reload)
  const [conceptSnapshots, setConceptSnapshots] = useState<Record<string, DatasetSnapshot>>({})

  // ── Pre-launch runtime estimate (cloud) — from config + attached datasets.
  // Tuned A40 priors; the Monitor's live-measured ETAs take over once running.
  const cloudEta = (() => {
    if (mode !== 'cloud') return null
    const imgs = concepts.reduce((sum, c) => {
      const snap = conceptSnapshots[c.id]
      return sum + (snap?.images?.length ?? 0) * (c.repeats > 0 ? c.repeats : 1)
    }, 0)
    if (imgs === 0) return null
    const bs  = Math.max(1, parseInt(batchSize) || 4)
    const ep  = Math.max(1, parseInt(epochs) || 1)
    const res = Math.max(256, parseInt(resolution) || 768)
    const cap = parseInt(maxSteps) || 0
    let steps = Math.ceil(imgs / bs) * ep
    if (cap > 0) steps = Math.min(steps, cap)
    const resFactor  = (res * res) / (768 * 768)
    const methodMult = trainMethod === 'finetune' ? 2.0 : 1  // full backprop through 12B weights
    const trainSec  = steps * bs * 0.55 * resFactor * methodMult // ~0.55 s/sample @768px on A40 (LoRA)
    const setupSec  = 5.5 * 60                        // cold boot + model/text-encoder downloads
    const cacheSec  = imgs * 0.35 * resFactor         // latent + text caching
    let saves = 0
    if (saveEpochs) {
      const every = Math.max(1, parseFloat(saveEvery) || 1)
      saves = saveEveryUnit === 'EPOCH' ? Math.floor(ep / every) : Math.floor(steps / every)
    }
    // Fine-tune outputs a full ~22GB checkpoint (and 22GB per snapshot)
    const perUpload = trainMethod === 'finetune' ? 200 : 20
    const uploadSec = (trainMethod === 'finetune' ? 200 : 30) + saves * perUpload
    return { imgs: Math.round(imgs), steps, setupSec, cacheSec, trainSec, uploadSec,
             total: setupSec + cacheSec + trainSec + uploadSec }
  })()
  const fmtEtaDur = (s: number) =>
    s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.max(1, Math.round(s / 60))}m`

  // Server-side dataset build jobs: polled from the DB so a build started on
  // ANY device/tab shows here, survives reloads, and can be attached when done
  interface BuildJob {
    id: number; status: string; name: string
    progressDone: number; progressTotal: number; progressBytes: number; phase: string
    resultKey: string | null; resultCount: number | null; resultSkipped: number | null
    resultSizeMb: number | null; truncated: boolean; error: string | null
  }
  const [activeBuild, setActiveBuild] = useState<BuildJob | null>(null)
  useEffect(() => {
    if (mode !== 'cloud') return
    const tick = async () => {
      try {
        const r = await fetch('/api/admin/onetrainer/cloud/build-dataset?active=1', { headers: ah() })
        if (r.ok) setActiveBuild(await r.json())
      } catch {}
    }
    tick()
    const t = setInterval(tick, 8000)
    return () => clearInterval(t)
  }, [mode])
  const consumeBuild = (id: number) => {
    setActiveBuild(null)
    fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${id}`, { method: 'PATCH', headers: ah() }).catch(() => {})
  }
  // Prefill for the composer after a run Reload
  const [pendingComposerData, setPendingComposerData] = useState<Partial<DatasetSnapshot> | null>(null)

  // Live log polling (cloud mode)
  const [liveLogs, setLiveLogs]     = useState<string[]>([])
  const liveLogPollRef              = useRef<ReturnType<typeof setInterval> | null>(null)

  // File input refs for dataset upload
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Bucket-sourced dataset picker (which concept it's building for).
  // Open-state persists: a refresh mid-composition reopens the popup (its
  // internal edits restore from their own stored state).
  const [bucketPickerFor, setBucketPickerFor] = useState<string | null>(null)
  // Skip the very first run — it fires with the initial null BEFORE the
  // restore effect reads the flag, and would delete it
  const pickerOpenInitRef = useRef(false)
  useEffect(() => {
    if (!pickerOpenInitRef.current) { pickerOpenInitRef.current = true; return }
    try {
      if (bucketPickerFor) localStorage.setItem(PICKER_OPEN_KEY, '1')
      else localStorage.removeItem(PICKER_OPEN_KEY)
    } catch {}
  }, [bucketPickerFor])
  useEffect(() => {
    try {
      if (localStorage.getItem(PICKER_OPEN_KEY) === '1') {
        setBucketPickerFor(prev => prev ?? (concepts[0]?.id ?? null))
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Built" library — every completed dataset build is reusable as a concept
  // without rebuilding (the zip already sits in R2)
  const [builtPickerFor, setBuiltPickerFor] = useState<string | null>(null)
  const [builtList, setBuiltList] = useState<Record<string, unknown>[] | null>(null)
  const [builtBusy, setBuiltBusy] = useState(false)
  // Inline rename inside the Built chooser (identical "dataset" names are useless)
  const [builtEditId, setBuiltEditId] = useState<number | null>(null)
  const [builtEditName, setBuiltEditName] = useState('')
  // Browse a built dataset's media + captions (read-only — the zip is baked)
  const [builtView, setBuiltView] = useState<{ name: string; images: DsImage[] } | null>(null)
  const [builtViewLoading, setBuiltViewLoading] = useState(false)
  const [builtViewError, setBuiltViewError] = useState<string | null>(null)
  const [builtViewerIdx, setBuiltViewerIdx] = useState<number | null>(null)
  const [builtDeleteConfirm, setBuiltDeleteConfirm] = useState<number | null>(null)
  // Item lists cached per build — reopening a dataset is instant, and a hung
  // first request can't wedge the eye button (15s timeout + visible error)
  const builtItemsCacheRef = useRef<Record<number, DsImage[]>>({})
  // Safari reports AbortSignal.timeout aborts as AbortError ("Fetch is
  // aborted"), not TimeoutError — treat both as a timeout
  const isTimeoutErr = (e: any) => e?.name === 'TimeoutError' || e?.name === 'AbortError'
  async function viewBuilt(job: Record<string, unknown>) {
    const jid = Number(job.id)
    const cached = builtItemsCacheRef.current[jid]
    if (cached) {
      setBuiltView({ name: String(job.name || 'dataset'), images: cached })
      return
    }
    if (builtViewLoading) return
    setBuiltViewLoading(true); setBuiltViewError(null)
    try {
      // Two attempts — a single slow moment (busy DB pool) shouldn't fail the tap
      let d: any = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${jid}&items=1`,
            { headers: ah(), signal: AbortSignal.timeout(attempt === 1 ? 15_000 : 25_000) })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          d = await r.json()
          break
        } catch (e) {
          if (attempt === 2 || !isTimeoutErr(e)) throw e
        }
      }
      const raw = typeof d?.itemsJson === 'string' ? JSON.parse(d.itemsJson) : d?.itemsJson
      if (!Array.isArray(raw)) throw new Error('No item list recorded for this build')
      const images: DsImage[] = raw.map((it: any) => ({
        id: Number(it.id) || 0, prompt: '', caption: String(it.caption ?? ''),
        tags: '', override: 'default' as const, customText: '', url: String(it.url ?? ''),
      }))
      builtItemsCacheRef.current[jid] = images
      setBuiltView({ name: String(job.name || 'dataset'), images })
    } catch (e: any) {
      setBuiltViewError(isTimeoutErr(e)
        ? 'Loading the dataset timed out — tap the eye again to retry'
        : (e?.message || 'Failed to load the dataset'))
    } finally { setBuiltViewLoading(false) }
  }
  async function deleteBuilt(jobId: number) {
    setBuiltDeleteConfirm(null)
    setBuiltList(prev => prev ? prev.filter(j => Number(j.id) !== jobId) : prev)
    fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${jobId}`, { method: 'DELETE', headers: ah() }).catch(() => {})
  }
  async function renameBuilt(jobId: number) {
    const name = builtEditName.trim().slice(0, 80)
    setBuiltEditId(null)
    if (!name) return
    setBuiltList(prev => prev ? prev.map(j => Number(j.id) === jobId ? { ...j, name } : j) : prev)
    fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...ah() },
      body: JSON.stringify({ name }),
    }).catch(() => {})
  }
  useEffect(() => {
    if (!builtPickerFor) return
    setBuiltList(null)
    setBuiltView(null)
    setBuiltViewerIdx(null)
    setBuiltDeleteConfirm(null)
    fetch('/api/admin/onetrainer/cloud/build-dataset?list=1', { headers: ah() })
      .then(async r => setBuiltList(r.ok ? await r.json() : []))
      .catch(() => setBuiltList([]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtPickerFor])

  async function attachBuiltDataset(job: Record<string, unknown>) {
    if (!builtPickerFor || builtBusy) return
    setBuiltBusy(true)
    try {
      // Pull the build's item list so the snapshot (captions + count for the
      // run estimate / run.json) travels with the concept
      let images: DatasetSnapshot['images'] = []
      try {
        const r = await fetch(`/api/admin/onetrainer/cloud/build-dataset?job=${job.id}&items=1`, { headers: ah() })
        if (r.ok) {
          const d = await r.json()
          const raw = typeof d?.itemsJson === 'string' ? JSON.parse(d.itemsJson) : d?.itemsJson
          if (Array.isArray(raw)) {
            images = raw.map((it: any) => ({
              id: Number(it.id) || 0, prompt: '', caption: String(it.caption ?? ''),
              tags: '', override: 'default' as const, customText: '',
            }))
          }
        }
      } catch {}
      updateConcept(builtPickerFor, { r2DatasetKey: String(job.resultKey), prompt_source: 'sample' })
      setConceptSnapshots(prev => ({
        ...prev,
        [builtPickerFor]: { name: String(job.name || 'built dataset'), defaultSource: 'caption', images },
      }))
      const detected = recipeSizeForCount(images.length || Number(job.resultCount) || 0)
      if (recipeSubject !== null || recipeSize !== null) applyRecipe(recipeSubject, detected)
      else setRecipeSize(detected)
      setBuiltPickerFor(null)
    } finally { setBuiltBusy(false) }
  }

  // Base-model (checkpoint) upload to R2 — Section 1, cloud mode
  const ckptFileInputRef = useRef<HTMLInputElement | null>(null)
  const [ckptUploadProgress, setCkptUploadProgress] = useState<number | null>(null)
  const [ckptUploadName, setCkptUploadName] = useState<string>('')

  const logEndRef = useRef<HTMLDivElement>(null)
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Server status (local mode) ─────────────────────────────────────────────

  const checkServer = useCallback(async () => {
    if (mode !== 'local') return
    try {
      const res = await fetch('/api/admin/onetrainer/server', { headers: ah() })
      if (res.ok) setServerRunning((await res.json()).running)
    } catch {}
  }, [mode])

  useEffect(() => {
    if (mode !== 'local') return
    checkServer()
    const t = setInterval(checkServer, 5000)
    return () => clearInterval(t)
  }, [mode, checkServer])

  async function toggleServer() {
    setServerLoading(true)
    try {
      if (serverRunning) {
        await fetch('/api/admin/onetrainer/server', { method: 'DELETE', headers: ah() })
        setServerRunning(false)
      } else {
        const res = await fetch('/api/admin/onetrainer/server', { method: 'POST', headers: ah() })
        const j   = await res.json()
        setServerRunning(j.started ?? false)
        if (j.started) loadPresets()
      }
    } finally { setServerLoading(false) }
  }

  // ── Presets ────────────────────────────────────────────────────────────────

  const loadPresets = useCallback(async () => {
    try {
      if (mode === 'cloud' || mode === 'fal') {
        const res = await fetch('/api/admin/onetrainer/presets-local', { headers: ah() })
        if (res.ok) setPresets(await res.json())
      } else {
        const res = await fetch('/api/admin/onetrainer/presets', { headers: ah() })
        if (res.ok) setPresets(await res.json())
      }
    } catch {}
  }, [mode])

  // Load presets immediately in cloud mode, or when server comes online in local mode
  useEffect(() => {
    if (mode === 'cloud' || mode === 'fal') { loadPresets() }
  }, [mode, loadPresets])

  useEffect(() => {
    if (mode === 'local' && serverRunning) loadPresets()
  }, [mode, serverRunning, loadPresets])

  function selectPreset(p: Preset) {
    setSelectedPreset(p)
    // The preset's method drives the Method toggle — picking a Finetune
    // preset must not submit as LORA (and vice versa)
    const parsed = parsePreset((p as { filename?: string }).filename ?? p.name)
    if (parsed.method === 'Finetune' || parsed.method === 'Full') {
      setTrainMethod('finetune')
      setSaveEpochs(false)   // fine-tune snapshots are full ~22GB models
      setOptimizerName('')   // preset carries its own optimizer (Adafactor)
    } else {
      setTrainMethod('lora')
      setSaveEpochs(true)
    }
    setLr(String(p.config.learning_rate ?? ''))
    setBatchSize(String(p.config.batch_size ?? ''))
    setResolution(String(p.config.resolution ?? ''))
    setOutputPath(String(p.config.output_model_destination ?? ''))
    setLoraRank('')
    setMaxSteps('')
    setSelectedCheckpoint('')
    setCheckpointFiles([])
    // Clear advanced overrides so a previous run's settings don't leak into the new preset
    setLoraAlpha(''); setLoraDropout(''); setLrScheduler(''); setWarmupSteps('')
    setOptimizerName(''); setTimestepDist(''); setTrainTextEncoder(false)
    setSaveEpochs(true); setSaveEvery('1'); setSaveEveryUnit('EPOCH')
    setRecipeSubject(null); setRecipeSize(null)
    if (String(p.config.base_model_name ?? '') === 'fal-ai/wan-22-trainer') {
      setFalCfg(f => ({
        ...f,
        variant: p.config.variant === 'i2v-a14b' ? 'i2v-a14b' : 't2v-a14b',
        steps: String(p.config.steps ?? 400),
        learningRate: String(p.config.learning_rate ?? 0.0002),
        triggerPhrase: String(p.config.trigger_phrase ?? ''),
        autoScale: p.config.auto_scale_input !== false,
      }))
    }
  }

  // ── Local checkpoint scan ──────────────────────────────────────────────────

  async function scanCheckpoints() {
    if (!scanDir.trim()) return
    setScanLoading(true)
    try {
      const res = await fetch(`/api/admin/onetrainer/scan-checkpoints?dir=${encodeURIComponent(scanDir.trim())}`, { headers: ah() })
      if (res.ok) setCheckpointFiles(await res.json())
      else setCheckpointFiles([])
    } catch { setCheckpointFiles([]) }
    finally { setScanLoading(false) }
  }

  // ── R2 checkpoint list ─────────────────────────────────────────────────────

  async function loadR2Checkpoints() {
    setR2CheckpointsLoading(true)
    try {
      const res = await fetch('/api/admin/onetrainer/cloud/checkpoints', { headers: ah() })
      if (res.ok) setR2Checkpoints(await res.json())
    } catch {}
    finally { setR2CheckpointsLoading(false) }
  }

  async function loadRuns() {
    setR2LorasLoading(true)
    setLorasError(null)
    try {
      const res = await fetch('/api/admin/onetrainer/runs', { headers: ah() })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      setRunsList(data.runs ?? [])
      setLegacyLoras(data.legacy ?? [])
    } catch (e) {
      setLorasError(e instanceof Error ? e.message : 'Failed to load runs')
    }
    finally { setR2LorasLoading(false) }
  }

  // ── Reload a past run: settings + checkpoint + dataset back into the composer ──

  function reloadRun(meta: RunMeta) {
    const cfg = (meta.config ?? {}) as Record<string, unknown>

    // vN auto-naming: strip any existing -vN, then bump past every existing folder
    const safe = (s: string) => s.replace(/[^a-z0-9_-]/gi, '_')
    const baseName = (meta.run_name ?? meta.folder ?? 'Training Run').replace(/-v\d+$/, '')
    const safeBase = safe(baseName)
    let maxV = 0
    for (const r of runsList) {
      if (r.folder === safeBase) maxV = Math.max(maxV, 1)
      else if (r.folder.startsWith(safeBase + '-v')) {
        const n = parseInt(r.folder.slice(safeBase.length + 2))
        if (!isNaN(n)) maxV = Math.max(maxV, n)
      }
    }
    setRunName(maxV > 0 ? `${baseName}-v${maxV + 1}` : baseName)

    // Settings — the pseudo-preset carries the run's full config as the new baseline
    setSelectedPreset({ filename: '', name: `Reloaded · ${meta.run_name ?? meta.folder ?? 'run'}`, config: cfg })
    setLr(cfg.learning_rate != null ? String(cfg.learning_rate) : '')
    setBatchSize(cfg.batch_size != null ? String(cfg.batch_size) : '')
    setEpochs(cfg.epochs != null ? String(cfg.epochs) : '')
    setMaxSteps(cfg.max_steps != null ? String(cfg.max_steps) : '')
    setResolution(cfg.resolution != null ? String(cfg.resolution) : '')
    setLoraRank(cfg.lora_rank != null ? String(cfg.lora_rank) : '')
    setOutputPath('')
    setLoraAlpha(cfg.lora_alpha != null ? String(cfg.lora_alpha) : '')
    setLoraDropout(cfg.dropout_probability != null ? String(cfg.dropout_probability) : '')
    setLrScheduler(typeof cfg.learning_rate_scheduler === 'string' ? cfg.learning_rate_scheduler : '')
    setWarmupSteps(cfg.learning_rate_warmup_steps != null ? String(cfg.learning_rate_warmup_steps) : '')
    const opt = cfg.optimizer as Record<string, unknown> | undefined
    setOptimizerName(opt && typeof opt.optimizer === 'string' ? opt.optimizer : '')
    setTimestepDist(typeof cfg.timestep_distribution === 'string' ? cfg.timestep_distribution : '')
    const te = cfg.text_encoder as Record<string, unknown> | undefined
    setTrainTextEncoder(te?.train === true)
    setSaveEpochs(cfg.save_after_unit === 'EPOCH' || cfg.save_after_unit === 'STEP')
    setSaveEveryUnit(cfg.save_after_unit === 'STEP' ? 'STEP' : 'EPOCH')
    setSaveEvery(cfg.save_after != null ? String(cfg.save_after) : '1')
    setRecipeSubject(null); setRecipeSize(null)

    // Checkpoint + concepts (original dataset zips are still in R2 → ready to train as-is)
    setMode('cloud')
    setSelectedCheckpoint(typeof meta.checkpoint_r2_key === 'string' ? meta.checkpoint_r2_key : '')
    const newConcepts: Concept[] = (meta.concepts ?? []).map(c => ({
      id: uid(),
      name: c.name || 'concept',
      path: '',
      r2DatasetKey: c.r2_dataset_key || '',
      repeats: c.repeats ?? 1,
      prompt_source: (['sample', 'filename', 'concept'].includes(c.prompt_source ?? '') ? c.prompt_source : 'sample') as Concept['prompt_source'],
      prompt_path: c.prompt_path || '',
    }))
    setConcepts(newConcepts.length > 0 ? newConcepts : [emptyConcept()])

    // Dataset composition → snapshot map (for the next run.json) + composer prefill
    const snaps: Record<string, DatasetSnapshot> = {}
    if (meta.dataset && Array.isArray(meta.dataset.images) && newConcepts.length > 0) {
      snaps[newConcepts[0].id] = {
        name: meta.dataset.name ?? 'dataset',
        defaultSource: (meta.dataset.defaultSource ?? 'caption') as DatasetSnapshot['defaultSource'],
        images: meta.dataset.images,
      }
      setPendingComposerData(meta.dataset)
    } else {
      setPendingComposerData(null)
    }
    setConceptSnapshots(snaps)

    setTab('config')
  }

  // ── Dataset upload (cloud mode) ────────────────────────────────────────────

  function triggerDatasetUpload(conceptId: string) {
    const input = fileInputRefs.current[conceptId]
    if (input) input.click()
  }

  async function handleDatasetFile(conceptId: string, file: File) {
    const CHUNK = 50 * 1024 * 1024  // 50 MB per part

    try {
      // 1. Initiate multipart upload — server creates the upload and returns per-part presigned URLs
      const initRes = await fetch('/api/admin/onetrainer/cloud/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ action: 'init', type: 'dataset', filename: file.name, contentType: 'application/zip', fileSize: file.size }),
      })
      if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`)
      const { uploadId, key, partUrls } = await initRes.json()

      updateConcept(conceptId, { uploadProgress: 0 })

      // 2. Upload each chunk directly to R2 using its presigned URL
      let uploadedBytes = 0
      for (let i = 0; i < partUrls.length; i++) {
        const start = i * CHUNK
        const end = Math.min(start + CHUNK, file.size)
        const chunk = file.slice(start, end)

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              const pct = Math.round((uploadedBytes + e.loaded) / file.size * 100)
              updateConcept(conceptId, { uploadProgress: Math.min(pct, 99) })
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              uploadedBytes += (end - start)
              resolve()
            } else {
              reject(new Error(`Part ${i + 1} upload failed: ${xhr.status}`))
            }
          }
          xhr.onerror = () => reject(new Error(`Part ${i + 1} network error`))
          xhr.open('PUT', partUrls[i])
          xhr.send(chunk)
        })
      }

      // 3. Tell the server to assemble the parts
      const completeRes = await fetch('/api/admin/onetrainer/cloud/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ action: 'complete', key, uploadId }),
      })
      if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.status}`)

      updateConcept(conceptId, { r2DatasetKey: key, uploadProgress: undefined })
    } catch (err: any) {
      updateConcept(conceptId, { uploadProgress: undefined })
      alert(`Dataset upload failed: ${err.message}`)
    }
  }

  async function handleCheckpointFile(file: File) {
    const CHUNK = 50 * 1024 * 1024
    setCkptUploadName(file.name)
    setCkptUploadProgress(0)
    try {
      const initRes = await fetch('/api/admin/onetrainer/cloud/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ action: 'init', type: 'checkpoint', filename: file.name, contentType: 'application/octet-stream', fileSize: file.size }),
      })
      if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`)
      const { uploadId, key, partUrls } = await initRes.json()

      let uploadedBytes = 0
      for (let i = 0; i < partUrls.length; i++) {
        const start = i * CHUNK
        const end = Math.min(start + CHUNK, file.size)
        const chunk = file.slice(start, end)
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              const pct = Math.round((uploadedBytes + e.loaded) / file.size * 100)
              setCkptUploadProgress(Math.min(pct, 99))
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { uploadedBytes += (end - start); resolve() }
            else reject(new Error(`Part ${i + 1} upload failed: ${xhr.status}`))
          }
          xhr.onerror = () => reject(new Error(`Part ${i + 1} network error`))
          xhr.open('PUT', partUrls[i])
          xhr.send(chunk)
        })
      }

      const completeRes = await fetch('/api/admin/onetrainer/cloud/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ action: 'complete', key, uploadId }),
      })
      if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.status}`)

      // Saved for future runs like the pre-existing checkpoints — select it now
      setSelectedCheckpoint(key)
      setCkptUploadProgress(null)
      setCkptUploadName('')
      loadR2Checkpoints()
    } catch (err: any) {
      setCkptUploadProgress(null)
      setCkptUploadName('')
      // An INSTANT "network error" on a part upload = the browser blocked the
      // direct PUT to R2 — almost always a missing bucket CORS policy
      const msg = /network error/i.test(err?.message ?? '')
        ? `${err.message}\n\nThe browser blocked the direct upload to R2. Add a CORS policy to the R2 bucket (Cloudflare → R2 → bucket → Settings → CORS) allowing PUT from this site's origin, then retry.`
        : err.message
      alert(`Checkpoint upload failed: ${msg}`)
    }
  }

  // ── Training status poll ───────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      if (mode === 'local') {
        const res = await fetch('/api/admin/onetrainer/status', { headers: ah() })
        if (res.ok) {
          const s: TrainStatus = await res.json()
          setTrainStatus(s)
          if (s.status !== 'running') stopPoll()
        }
      } else {
        if (!cloudJobId) return
        const res = await fetch(`/api/admin/onetrainer/cloud/status?job_id=${cloudJobId}`, { headers: ah() })
        if (res.ok) {
          const s = await res.json()
          setCloudStatus(prev => ({
            ...s,
            started_at: prev?.started_at ?? Date.now() / 1000,
            run_name:   prev?.run_name   ?? runName,
          }))
          if (s.status !== 'running') stopPoll()
        }
      }
    } catch {}
  }, [mode, cloudJobId, runName]) // eslint-disable-line react-hooks/exhaustive-deps

  function startPoll() {
    if (pollRef.current) return
    pollRef.current = setInterval(fetchStatus, mode === 'cloud' ? 5000 : 2000)
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const fetchLiveLogs = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/admin/onetrainer/cloud/logs?job_id=${jobId}`, { headers: ah() })
      if (res.ok) {
        const { logs } = await res.json()
        if (logs.length > 0) setLiveLogs(logs)
      }
    } catch {}
  }, [])

  function startLiveLogPoll(jobId: string) {
    if (liveLogPollRef.current) return
    fetchLiveLogs(jobId)
    liveLogPollRef.current = setInterval(() => fetchLiveLogs(jobId), 15000)
  }

  function stopLiveLogPoll() {
    if (liveLogPollRef.current) { clearInterval(liveLogPollRef.current); liveLogPollRef.current = null }
  }

  const activeStatus  = mode === 'local' ? trainStatus.status  : (cloudStatus?.status  ?? 'idle')
  const isTraining    = activeStatus === 'running'

  useEffect(() => {
    if (isTraining) { startPoll(); setTab('monitor') }
    return stopPoll
  }, [isTraining]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === 'cloud' && isTraining && cloudJobId) {
      startLiveLogPoll(cloudJobId)
    } else {
      stopLiveLogPoll()
    }
    return stopLiveLogPoll
  }, [mode, isTraining, cloudJobId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [
    trainStatus.logs, cloudStatus?.logs,
  ])

  // ── Start training ─────────────────────────────────────────────────────────

  async function startTraining() {
    if (!selectedPreset && mode !== 'fal') return
    setLaunching(true)
    setLiveLogs([])
    try {
      // ── fal API mode: submit the composed dataset's image IDs to the
      // existing fal LoRA pipeline (prepare converts GIFs, zips clips,
      // handles webhooks/finalize; jobs monitor on /admin/lora-training) ──
      if (mode === 'fal') {
        const snaps = concepts.map(c => conceptSnapshots[c.id]).filter((x): x is DatasetSnapshot => !!x)
        const ids = [...new Set(snaps.flatMap(sn => sn.images.map(i => i.id)))]
        if (ids.length === 0) { alert('Build a dataset below first — fal training uses the items selected in the dataset composer.'); return }
        const cfg = {
          variant: falCfg.variant,
          steps: Math.max(100, parseInt(falCfg.steps) || 400),
          learning_rate: Math.max(0.000001, parseFloat(falCfg.learningRate) || 0.0002),
          trigger_phrase: falCfg.triggerPhrase.trim(),
          auto_scale_input: falCfg.autoScale,
        }
        const res = await fetch('/api/admin/lora-training/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ah() },
          body: JSON.stringify({ imageIds: ids, modelId: 'fal-ai/wan-22-trainer', name: runName.trim(), config: cfg }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || !d.jobId) { alert(d.error ?? `Error ${res.status}`); return }
        setFalJobId(d.jobId)
        return
      }
      if (!selectedPreset) return // narrow: local/cloud always have one (guarded above)
      const config: Record<string, unknown> = { ...selectedPreset.config }
      if (lr)         config.learning_rate            = parseFloat(lr)
      if (batchSize)  config.batch_size               = parseInt(batchSize)
      if (epochs)     config.epochs                   = parseInt(epochs)
      if (maxSteps)   config.max_steps                = parseInt(maxSteps)
      if (resolution) config.resolution               = resolution
      if (outputPath) config.output_model_destination = outputPath
      if (loraRank)   config.lora_rank                = parseInt(loraRank)
      config.output_model_format = config.output_model_format ?? 'SAFETENSORS'

      // Advanced overrides
      if (loraAlpha)     config.lora_alpha                  = parseFloat(loraAlpha)
      if (loraDropout)   config.dropout_probability         = parseFloat(loraDropout)
      if (lrScheduler)   config.learning_rate_scheduler     = lrScheduler
      if (warmupSteps)   config.learning_rate_warmup_steps  = parseInt(warmupSteps)
      if (optimizerName) config.optimizer                   = { ...(typeof config.optimizer === 'object' && config.optimizer !== null ? config.optimizer as Record<string, unknown> : {}), optimizer: optimizerName }
      if (timestepDist)  config.timestep_distribution       = timestepDist
      if (trainTextEncoder) config.text_encoder = { ...(typeof config.text_encoder === 'object' && config.text_encoder !== null ? config.text_encoder as Record<string, unknown> : {}), train: true }

      // Training method — FULL fine-tune updates every transformer weight and
      // outputs a complete checkpoint; LoRA trains a small adapter
      if (trainMethod === 'finetune') {
        config.training_method = 'FINE_TUNE'
        delete config.lora_rank
        delete config.lora_alpha
        delete config.dropout_probability
        // Adafactor is mandatory on 48GB for a 12B full fine-tune
        config.optimizer = { ...(typeof config.optimizer === 'object' && config.optimizer !== null ? config.optimizer as Record<string, unknown> : {}), optimizer: optimizerName || 'ADAFACTOR' }
      } else {
        config.training_method = (config.training_method as string) ?? 'LORA'
      }

      // Snapshots — each intermediate save is a complete standalone LoRA
      if (saveEpochs) {
        config.save_after      = Math.max(1, parseInt(saveEvery) || 1)
        config.save_after_unit = saveEveryUnit === 'STEP' ? 'STEP' : 'EPOCH'
      } else {
        config.save_after_unit = 'NEVER'
      }

      if (mode === 'local') {
        if (selectedCheckpoint) config.base_model_name = selectedCheckpoint

        const conceptPayload = concepts
          .filter(c => c.path.trim())
          .map(c => ({
            name:    c.name,
            path:    c.path.trim(),
            repeats: c.repeats,
            text: { prompt_source: c.prompt_source, prompt_path: c.prompt_path || '' },
          }))

        const res = await fetch('/api/admin/onetrainer/train', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ah() },
          body: JSON.stringify({ name: runName, config, concepts: conceptPayload }),
        })

        if (res.ok) {
          await fetchStatus()
          setTab('monitor')
          startPoll()
        } else {
          const j = await res.json().catch(() => ({}))
          alert(j.error ?? `Error ${res.status}`)
        }
      } else {
        // Cloud mode — submit to RunPod
        // UNIQUE non-empty names — the worker keys extraction folders by name,
        // and duplicate/blank names merged two datasets into one folder (each
        // image then trained twice per epoch)
        const seenNames = new Set<string>()
        const cloudConcepts = concepts
          .filter(c => c.r2DatasetKey)
          .map((c, i) => {
            let name = c.name.trim() || `concept-${i + 1}`
            while (seenNames.has(name.toLowerCase())) name = `${name}-${i + 1}`
            seenNames.add(name.toLowerCase())
            return {
              name,
              r2_dataset_key: c.r2DatasetKey,
              repeats:        c.repeats,
              prompt_source:  c.prompt_source,
              prompt_path:    c.prompt_path || '',
            }
          })

        // The train route assigns the run its own R2 folder (training/loras/<name>/,
        // auto-suffixed -v2/-v3 on collision) and stores run.json for the config
        // viewer + Reload. The dataset snapshot travels along for run.json only.
        // Merge EVERY concept's snapshot — a multi-concept run (e.g. two
        // characters) previously recorded only the first dataset, so the
        // Monitor/Completed views under-reported the image count
        const snaps = concepts.map(c => conceptSnapshots[c.id]).filter((s): s is DatasetSnapshot => !!s)
        const firstSnapshot: DatasetSnapshot | null =
          snaps.length === 0 ? null
          : snaps.length === 1 ? snaps[0]
          : {
              name: snaps.map(s => s.name).join(' + '),
              defaultSource: snaps[0].defaultSource,
              images: snaps.flatMap(s => s.images),
            }

        const res = await fetch('/api/admin/onetrainer/cloud/train', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ah() },
          body: JSON.stringify({
            run_name:           runName,
            config,
            concepts:           cloudConcepts,
            checkpoint_r2_key:  selectedCheckpoint,
            run_meta:           { dataset: firstSnapshot },
          }),
        })

        if (res.ok) {
          const { job_id, run_folder, run_name } = await res.json() as { job_id: string; run_folder?: string; run_name?: string }
          // Each submission is its own worker — track it as a concurrent run.
          // The server may have auto-versioned a reused name ("… v3") — adopt it.
          trackRun({
            jobId: job_id,
            runName: run_name || runName,
            runFolder: run_folder || runName.replace(/[^a-z0-9_-]/gi, '_'),
            startedAt: Date.now(),
          })
          setTab('monitor')
        } else {
          const j = await res.json().catch(() => ({}))
          alert(j.error ?? `Error ${res.status}`)
        }
      }
    } finally { setLaunching(false) }
  }

  async function cancelTraining() {
    if (mode === 'local') {
      await fetch('/api/admin/onetrainer/cancel', { method: 'POST', headers: ah() })
      await fetchStatus()
    } else {
      if (cloudJobId) {
        await fetch('/api/admin/onetrainer/cloud/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ah() },
          body: JSON.stringify({ job_id: cloudJobId }),
        })
        setCloudStatus(prev => prev ? { ...prev, status: 'cancelled' } : prev)
        stopPoll()
      }
    }
  }

  // ── Concept helpers ────────────────────────────────────────────────────────

  function updateConcept(id: string, patch: Partial<Concept>) {
    setConcepts(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  // Cloud mode allows CONCURRENT runs (each is its own RunPod worker) — only
  // local mode is single-run
  // Wan 2.2 preset trains on fal's hosted trainer — no checkpoint, and the
  // run settings collapse to the trainer's own four knobs
  const isFalPreset = String(selectedPreset?.config?.base_model_name ?? '') === 'fal-ai/wan-22-trainer'
  const canTrain = mode === 'local'
    ? (serverRunning && !!selectedPreset && concepts.some(c => c.path.trim()) && !isTraining)
    : mode === 'fal'
      ? (isFalPreset && !!runName.trim() && concepts.some(c => (conceptSnapshots[c.id]?.images?.length ?? 0) > 0))
      : (!!selectedPreset && !!selectedCheckpoint && concepts.some(c => c.r2DatasetKey))

  const activeLogs    = mode === 'local' ? trainStatus.logs
    : cloudStatus?.status === 'running' ? liveLogs
    : (cloudStatus?.logs ?? [])
  const activeRunName = mode === 'local' ? trainStatus.run_name : cloudStatus?.run_name
  const activeStarted = mode === 'local' ? trainStatus.started_at : cloudStatus?.started_at

  // ── Render ─────────────────────────────────────────────────────────────────

  // Access gate (after every hook — rules of hooks): admins only. The page's
  // APIs all require the admin password anyway; without it, show a lock screen
  // instead of a dead skeleton UI that silently 401s.
  if (accessOk === false) {
    return (
      <div className="h-screen bg-[#05080f] text-white flex flex-col items-center justify-center gap-3">
        <div className="w-12 h-12 rounded-2xl border border-white/10 bg-white/[0.04] flex items-center justify-center">
          <Terminal size={20} className="text-slate-500" />
        </div>
        <p className="text-sm font-semibold text-slate-300">Admins only</p>
        <p className="text-[11px] text-slate-600 max-w-[260px] text-center leading-relaxed">
          This page requires an admin login. Sign in on the admin dashboard first.
        </p>
        <button onClick={() => (window.location.href = '/admin')}
          className="mt-1 px-4 py-1.5 rounded-lg bg-white/10 border border-white/25 text-xs font-medium hover:bg-white/15 transition-colors">
          Go to admin login
        </button>
      </div>
    )
  }

  return (
    <div className="h-screen bg-[#05080f] text-white flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="shrink-0 bg-[#05080f] border-b border-white/[0.06] px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 flex-wrap">
        <button onClick={() => window.location.href = '/admin'}
          className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-white transition-colors shrink-0">
          <ArrowLeft size={14} />
        </button>
        <SiteLogoBox size={26} rounded={9} />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold text-white leading-none truncate">OneTrainer</h1>
          {/* Subtitle is decorative — it ate a whole line on a phone */}
          <p className="hidden sm:block text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 mt-1 leading-none">Model Training · Studio</p>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
          <button onClick={() => { setMode('local'); try { localStorage.setItem('ot-mode', 'local') } catch {} }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              mode === 'local' ? 'bg-white/[0.08] text-white' : 'text-slate-500 hover:text-slate-300'
            }`}>
            <HardDrive size={10} /> Local
          </button>
          <button onClick={() => { setMode('cloud'); try { localStorage.setItem('ot-mode', 'cloud') } catch {} }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              mode === 'cloud' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}>
            <Cloud size={10} /> Cloud
          </button>
          <button onClick={() => { setMode('fal'); try { localStorage.setItem('ot-mode', 'fal') } catch {} }}
            title="Train on fal's hosted trainers (Wan 2.2 Video) using the datasets composed below"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              mode === 'fal' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}>
            <Sparkles size={10} /> API
          </button>
        </div>

        {/* Server status (local) / RunPod badge (cloud) */}
        {mode === 'local' ? (
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] ${
              serverRunning
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-white/[0.08] bg-white/[0.03] text-slate-500'
            }`}>
              <Circle size={6} className={serverRunning ? 'fill-emerald-400 text-emerald-400' : 'fill-slate-600 text-slate-600'} />
              {serverRunning ? 'Server online' : 'Server offline'}
            </div>
            <button onClick={toggleServer} disabled={serverLoading}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all disabled:opacity-50 ${
                serverRunning
                  ? 'border-red-500/25 bg-red-500/10 text-red-400 hover:bg-red-500/15'
                  : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15'
              }`}>
              {serverLoading ? <Loader2 size={11} className="animate-spin" /> : serverRunning ? <Square size={11} /> : <Zap size={11} />}
              {serverLoading ? 'Starting…' : serverRunning ? 'Stop Server' : 'Start Server'}
            </button>
          </div>
        ) : mode === 'cloud' ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/20 bg-white/[0.06] text-slate-300 text-[11px]">
            <Cloud size={9} />
            RunPod Cloud
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 text-[11px]">
            <Sparkles size={9} />
            fal API · Wan 2.2
          </div>
        )}
      </div>

      {/* ── Tabs — horizontally scrollable so all four stay reachable on a phone ── */}
      <div className="shrink-0 border-b border-white/[0.06] px-2 sm:px-4">
        <div className="flex overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {([['config', 'Configuration', Settings2], ['monitor', 'Monitor', Terminal], ['loras', 'Saved LoRAs', Zap], ['history', 'Completed Runs', CheckCircle]] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => { setTab(id); if (id === 'loras' || id === 'history') loadRuns() }}
              className={`flex items-center gap-2 px-3 sm:px-4 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                tab === id ? 'border-white text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}>
              <Icon size={12} /> {label}
              {id === 'monitor' && isTraining && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Config tab ──
          Phones get ONE scrolling column (preset list, then the config panel);
          lg+ keeps the original sidebar + main split. */}
      {tab === 'config' && (
        <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">

          {/* Single main panel — the preset picker is now a dropdown at the
              top (step 0) instead of a permanent left column */}
          <div className="flex-1 min-w-0 lg:overflow-y-auto">
            <div className="p-4 sm:p-6 space-y-5 max-w-3xl">

              {/* ── Step 0: Training Preset (dropdown) ── */}
              <div ref={presetDdRef} className="relative rounded-2xl border border-white/[0.08] bg-[#0a101d] p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Training Preset</p>
                  <button onClick={loadPresets} title="Reload presets"
                    className="p-1 rounded hover:bg-white/[0.06] text-slate-600 hover:text-slate-400 transition-colors">
                    <RefreshCw size={11} />
                  </button>
                </div>

                {mode === 'local' && !serverRunning ? (
                  <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 p-3 flex items-start gap-2.5">
                    <BookOpen size={12} className="text-amber-500 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-amber-600 space-y-0.5">
                      <p className="font-semibold text-amber-400">Server offline</p>
                      <p>Click <strong>Start Server</strong> above to load presets.</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setPresetDdOpen(v => !v)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-left transition-all ${
                        presetDdOpen ? 'border-white/30 bg-white/[0.08]' : 'border-white/10 bg-white/[0.03] hover:border-white/20'}`}>
                      {selectedPreset ? (() => {
                        const { family, method, vram } = parsePreset(selectedPreset.filename)
                        return (
                          <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                            <span className={`text-[10px] font-bold uppercase tracking-widest ${FAMILY_COLOR[family] ?? 'text-slate-400'}`}>{family}</span>
                            <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${METHOD_PILL[method]}`}>{method}</span>
                            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${vram ? (VRAM_PILL[vram] ?? 'bg-white/5 text-slate-400 border-white/10') : 'bg-white/5 text-slate-500 border-white/10'}`}>{vram || 'any'}</span>
                          </span>
                        )
                      })() : (
                        <span className="text-[12px] text-slate-500">
                          {presets.length === 0 ? 'No presets found' : 'Select a model + method…'}
                        </span>
                      )}
                      <ChevronDown size={13} className={`shrink-0 text-slate-500 transition-transform ${presetDdOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {presetDdOpen && presets.length > 0 && (
                      <div className="absolute left-4 right-4 sm:left-5 sm:right-5 z-40 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-white/[0.1] bg-[#070b14] shadow-2xl p-2 space-y-3">
                        {(() => {
                          const grouped: Record<string, Preset[]> = {}
                          for (const p of presets) {
                            // fal trainer presets only exist in API mode; the
                            // OneTrainer presets can't run there
                            const falP = String(p.config?.base_model_name ?? '') === 'fal-ai/wan-22-trainer'
                            if (mode === 'fal' ? !falP : falP) continue
                            const { family } = parsePreset(p.filename)
                            ;(grouped[family] ??= []).push(p)
                          }
                          const activeFamilies = FAMILY_ORDER.filter(f => grouped[f]?.length)
                          return activeFamilies.map(family => (
                            <div key={family}>
                              <div className="flex items-center gap-2 mb-1.5 px-1">
                                <span className={`text-[9px] font-bold uppercase tracking-widest ${FAMILY_COLOR[family] ?? 'text-slate-500'}`}>{family}</span>
                                <div className="flex-1 h-px bg-white/[0.05]" />
                              </div>
                              <div className="space-y-0.5">
                                {grouped[family].map(p => {
                                  const { method, vram } = parsePreset(p.filename)
                                  const isSelected = selectedPreset?.filename === p.filename
                                  const cfgLr  = p.config.learning_rate
                                  const cfgBs  = p.config.batch_size
                                  const cfgRes = p.config.resolution
                                  return (
                                    <button key={p.filename}
                                      onClick={() => { selectPreset(p); setPresetDdOpen(false) }}
                                      className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
                                        isSelected ? 'border-white/30 bg-white/[0.07]' : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.03]'}`}>
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${METHOD_PILL[method]}`}>{method}</span>
                                        {vram
                                          ? <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${VRAM_PILL[vram] ?? 'bg-white/5 text-slate-400 border-white/10'}`}>{vram}</span>
                                          : <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-white/5 text-slate-500 border-white/10">any</span>
                                        }
                                        {isSelected && <CheckCircle size={9} className="text-white ml-auto shrink-0" />}
                                      </div>
                                      <div className="flex gap-2 mt-1">
                                        {!!cfgRes && <span className="text-[9px] text-slate-600 font-mono">res <span className="text-slate-500">{String(cfgRes)}</span></span>}
                                        {!!cfgBs  && <span className="text-[9px] text-slate-600 font-mono">bs <span className="text-slate-500">{String(cfgBs)}</span></span>}
                                        {!!cfgLr  && <span className="text-[9px] text-slate-600 font-mono">lr <span className="text-slate-500">{Number(cfgLr).toExponential(0)}</span></span>}
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          ))
                        })()}
                      </div>
                    )}
                  </>
                )}
              </div>

              {!selectedPreset ? (
              <div className="flex items-center justify-center py-12 text-slate-700 text-sm px-6 text-center">
                {mode !== 'local' ? 'Choose a preset above to begin.' : serverRunning ? 'Choose a preset above to begin.' : 'Start the server, then choose a preset.'}
              </div>
            ) : (
              <div className="space-y-5">

                {/* ── Section 1: Base Model ── */}
                <div className="rounded-2xl border border-white/[0.08] bg-[#0a101d] p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">1 · Base Model</p>
                    {selectedCheckpoint && (
                      <button onClick={() => { setSelectedCheckpoint(''); setCheckpointFiles([]); setR2Checkpoints([]) }}
                        className="text-[10px] text-slate-500 hover:text-white transition-colors">
                        Reset
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                    <span className="text-[10px] text-slate-600 font-mono shrink-0">
                      {mode === 'cloud' ? 'r2_key:' : 'base_model_name:'}
                    </span>
                    <span className="text-[11px] text-slate-300 font-mono truncate flex-1">
                      {selectedCheckpoint || String(selectedPreset.config.base_model_name ?? '—')}
                    </span>
                    {selectedCheckpoint
                      ? <CheckCircle size={11} className="text-emerald-400 shrink-0" />
                      : <span className="text-[10px] text-slate-600 shrink-0">preset default</span>}
                  </div>

                  {isFalPreset ? (
                    <div className="space-y-2">
                      <label className="space-y-1 block max-w-xs">
                        <span className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Variant</span>
                        <select value={falCfg.variant} onChange={e => setFalCfg(f => ({ ...f, variant: e.target.value as 't2v-a14b' | 'i2v-a14b' }))}
                          className="w-full px-3 py-2 rounded-lg bg-[#0a101d] border border-white/[0.08] text-sm text-white focus:outline-none focus:border-white/30 cursor-pointer">
                          <option value="t2v-a14b">Text-to-video (t2v-a14b)</option>
                          <option value="i2v-a14b">Image-to-video (i2v-a14b)</option>
                        </select>
                      </label>
                      <p className="text-[10px] text-slate-600 leading-relaxed">
                        Hosted trainer on fal — no checkpoint to pick. Wan 2.2 A14B is the newest OPEN Wan;
                        the LoRA it produces serves through the portal's Wan 2.2 pickers automatically.
                      </p>
                    </div>
                  ) : mode === 'local' ? (
                    <>
                      <div className="flex gap-2">
                        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] focus-within:border-white/25 transition-colors">
                          <FolderOpen size={11} className="text-slate-600 shrink-0" />
                          <input
                            value={scanDir}
                            onChange={e => setScanDir(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && scanCheckpoints()}
                            placeholder="C:\Users\Owner\Downloads"
                            className="flex-1 bg-transparent text-[11px] text-white placeholder:text-slate-700 focus:outline-none font-mono"
                          />
                        </div>
                        <button onClick={scanCheckpoints} disabled={scanLoading || !scanDir.trim()}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20 text-[11px] transition-all disabled:opacity-40">
                          {scanLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                          Scan
                        </button>
                      </div>
                      {checkpointFiles.length > 0 ? (
                        <div className="space-y-1.5">
                          {checkpointFiles.map(f => (
                            <button key={f.path}
                              onClick={() => setSelectedCheckpoint(selectedCheckpoint === f.path ? '' : f.path)}
                              className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                                selectedCheckpoint === f.path
                                  ? 'border-white/30 bg-white/[0.07]'
                                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15'
                              }`}>
                              <div className="min-w-0">
                                <p className="text-[11px] font-medium text-white truncate">{f.name.replace(/\.(safetensors|ckpt|pt)$/i, '')}</p>
                                <p className="text-[10px] text-slate-600 font-mono mt-0.5">{f.size_gb} GB · {f.name.split('.').pop()?.toLowerCase()}</p>
                              </div>
                              {selectedCheckpoint === f.path
                                ? <CheckCircle size={12} className="text-white shrink-0" />
                                : <div className="w-3 h-3 rounded-full border border-white/20 shrink-0" />}
                            </button>
                          ))}
                        </div>
                      ) : !scanLoading && (
                        <p className="text-[10px] text-slate-700">
                          Enter a folder path and click Scan to find .safetensors / .ckpt files.
                        </p>
                      )}
                    </>
                  ) : (
                    /* Cloud: R2 checkpoint picker */
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={loadR2Checkpoints} disabled={r2CheckpointsLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20 text-[11px] transition-all disabled:opacity-40">
                          {r2CheckpointsLoading ? <Loader2 size={11} className="animate-spin" /> : <Cloud size={11} />}
                          Load checkpoints from R2
                        </button>
                        <button onClick={() => ckptFileInputRef.current?.click()} disabled={ckptUploadProgress !== null}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/25 text-white hover:bg-white/15 text-[11px] font-medium transition-all disabled:opacity-40">
                          <Upload size={11} />
                          Upload base model
                        </button>
                        <input
                          ref={ckptFileInputRef}
                          type="file"
                          accept=".safetensors,.ckpt,.pt"
                          className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleCheckpointFile(f); e.target.value = '' }}
                        />
                      </div>

                      {ckptUploadProgress !== null && (
                        <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] text-slate-400 truncate">Uploading {ckptUploadName}…</span>
                            <span className="text-[10px] text-slate-500 font-mono shrink-0">{ckptUploadProgress}%</span>
                          </div>
                          <div className="h-1 rounded-full bg-white/[0.08]">
                            <div className="h-full rounded-full bg-slate-200 transition-all" style={{ width: `${ckptUploadProgress}%` }} />
                          </div>
                          <p className="text-[9px] text-slate-600 mt-1.5">Saved to <span className="font-mono">training/checkpoints/</span> — it will appear in this list for future runs.</p>
                        </div>
                      )}

                      {r2Checkpoints.length > 0 && (
                        <div className="space-y-1.5">
                          {r2Checkpoints.map(f => (
                            <button key={f.key}
                              onClick={() => setSelectedCheckpoint(selectedCheckpoint === f.key ? '' : f.key)}
                              className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                                selectedCheckpoint === f.key
                                  ? 'border-white/30 bg-white/[0.07]'
                                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15'
                              }`}>
                              <div className="min-w-0">
                                <p className="text-[11px] font-medium text-white truncate">{f.name.replace(/\.(safetensors|ckpt|pt)$/i, '')}</p>
                                <p className="text-[10px] text-slate-600 font-mono mt-0.5">
                                  {f.size_gb} GB · {f.name.split('.').pop()?.toLowerCase()}
                                  {f.last_modified && ` · ${new Date(f.last_modified).toLocaleDateString()}`}
                                  {(() => {
                                    const base = f.name.replace(/\.[^.]+$/, '')
                                    const n = baseRunCounts[base] ?? 0
                                    return n > 0
                                      ? <span className="text-emerald-400/70"> · {n} trained run{n === 1 ? '' : 's'}</span>
                                      : <span className="text-amber-400/60"> · untested for training</span>
                                  })()}
                                </p>
                              </div>
                              {selectedCheckpoint === f.key
                                ? <CheckCircle size={12} className="text-white shrink-0" />
                                : <div className="w-3 h-3 rounded-full border border-white/20 shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}

                      {!r2CheckpointsLoading && r2Checkpoints.length === 0 && (
                        <p className="text-[10px] text-slate-700">
                          Click above to list checkpoints from R2. Upload checkpoints to <span className="font-mono text-slate-600">training/checkpoints/</span> in your R2 bucket.
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* ── Section 2: Run Settings ── */}
                <div className="rounded-2xl border border-white/[0.08] bg-[#0a101d] p-5 space-y-4">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">2 · Run Settings</p>
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">Run name</label>
                    <input value={runName} onChange={e => setRunName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white focus:outline-none focus:border-white/30" />
                    <p className="text-[9px] text-slate-600 leading-snug">Names this training run — and the saved LoRA file in R2.</p>
                  </div>

                  {isFalPreset ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">Steps</label>
                          <input type="number" value={falCfg.steps} onChange={e => setFalCfg(f => ({ ...f, steps: e.target.value }))} placeholder="400"
                            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                          <p className="text-[9px] text-slate-600 leading-snug">Total training steps. ~400 is the trainer default; more learns harder but risks overfitting motion.</p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">Learning Rate</label>
                          <input value={falCfg.learningRate} onChange={e => setFalCfg(f => ({ ...f, learningRate: e.target.value }))} placeholder="0.0002"
                            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                          <p className="text-[9px] text-slate-600 leading-snug">Trainer default 2e-4. Lower for subtle styles, higher fries motion fast.</p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">Trigger Phrase</label>
                          <input value={falCfg.triggerPhrase} onChange={e => setFalCfg(f => ({ ...f, triggerPhrase: e.target.value }))} placeholder="optional, e.g. TOK_MOTION"
                            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                          <p className="text-[9px] text-slate-600 leading-snug">Optional word to bind the concept to — use it in prompts when serving the LoRA.</p>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer select-none">
                        <input type="checkbox" checked={falCfg.autoScale} onChange={e => setFalCfg(f => ({ ...f, autoScale: e.target.checked }))} className="accent-emerald-400" />
                        Auto-scale clips to 81 frames @ 16fps (recommended)
                      </label>
                      <p className="text-[10px] text-slate-600 font-mono">
                        ~$0.005/step on the fal account — est. ${(Math.max(100, parseInt(falCfg.steps) || 400) * 0.005).toFixed(2)} at {Math.max(100, parseInt(falCfg.steps) || 400)} steps · typical run 30–90 min
                      </p>
                      {falJobId !== null && (
                        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
                          Job #{falJobId} started — dataset preparing &amp; submitting to fal.{' '}
                          <a href="/admin/lora-training" className="underline underline-offset-2 hover:text-white">Monitor on the LoRA Training page</a>.
                        </div>
                      )}
                    </div>
                  ) : (<>
                  {/* ── Training method: LoRA adapter vs full fine-tune ── */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">Method</label>
                    <div className="flex gap-1.5">
                      <button onClick={() => applyTrainMethod('lora')}
                        className={`flex-1 py-2 rounded-lg border text-[11px] font-semibold transition-all ${
                          trainMethod === 'lora' ? 'bg-white/[0.12] border-white/30 text-white' : 'bg-white/[0.03] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                        LoRA
                        <span className="block text-[8px] font-normal text-slate-600 mt-0.5">small adapter · 350-700MB · composable</span>
                      </button>
                      <button onClick={() => applyTrainMethod('finetune')}
                        className={`flex-1 py-2 rounded-lg border text-[11px] font-semibold transition-all ${
                          trainMethod === 'finetune' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' : 'bg-white/[0.03] border-white/[0.07] text-slate-500 hover:text-white'}`}>
                        Fine-tune
                        <span className="block text-[8px] font-normal text-slate-600 mt-0.5">full checkpoint · ~22GB output · max capacity</span>
                      </button>
                    </div>
                    {trainMethod === 'finetune' && (
                      <p className="text-[9px] text-amber-400/70 leading-snug">
                        Trains EVERY weight of the selected checkpoint and outputs a complete new model.
                        Adafactor + LR 8e-6 applied (required to fit the A40); rank/alpha don&apos;t apply; snapshots default off (each would be ~22GB).
                        Expect roughly 2× the training time of a LoRA on the same dataset.
                      </p>
                    )}
                  </div>

                  {/* ── Quick setup — beginner-friendly tuned recipes ── */}
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5 space-y-3">
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Quick setup</p>
                      <p className="text-[9px] text-slate-600 leading-snug mt-0.5">
                        Pick what you're training and roughly how many images you have — every setting below fills with tuned values. Tweak anything after.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">What are you training?</p>
                      <div className="flex flex-wrap gap-1.5">
                        {(Object.keys(RECIPE_SUBJECTS) as RecipeSubject[]).map(k => (
                          <button key={k} onClick={() => applyRecipe(k, recipeSize)}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                              recipeSubject === k
                                ? 'border-white/40 bg-white/[0.12] text-white'
                                : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-white hover:border-white/20'}`}>
                            {RECIPE_SUBJECTS[k].label}
                          </button>
                        ))}
                      </div>
                      {recipeSubject && (
                        <p className="text-[9px] text-slate-500 leading-snug">{RECIPE_SUBJECTS[recipeSubject].desc}</p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Dataset size <span className="normal-case font-sans text-slate-700">(auto-detected when you build one below)</span></p>
                      <div className="flex flex-wrap gap-1.5">
                        {(Object.keys(RECIPE_SIZES) as RecipeSize[]).map(k => (
                          <button key={k} onClick={() => applyRecipe(recipeSubject, k)}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                              recipeSize === k
                                ? 'border-white/40 bg-white/[0.12] text-white'
                                : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:text-white hover:border-white/20'}`}>
                            {RECIPE_SIZES[k].label}
                          </button>
                        ))}
                      </div>
                      {recipeSize && (
                        <p className="text-[9px] text-slate-500 leading-snug">{RECIPE_SIZES[recipeSize].tip}</p>
                      )}
                    </div>
                    {recipeSubject && (
                      <p className="text-[9px] text-emerald-400/80 leading-snug">
                        ✓ Recommended settings applied — LR {lr}, rank {loraRank}/α{loraAlpha}, {epochs} epoch{epochs === '1' ? '' : 's'} (max {maxSteps} steps), snapshot every {saveEvery} {saveEveryUnit === 'STEP' ? 'steps' : `epoch${saveEvery === '1' ? '' : 's'}`}.
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                    {([
                      ['Learning Rate', lr,         setLr,         'e.g. 0.0001',          'number', 'How hard each step pushes the weights. Too high fries the model (artifacts), too low never learns. LoRAs are usually happy at 1e-4 to 4e-4.'],
                      ['Batch Size',    batchSize,  setBatchSize,  'e.g. 2',                'number', 'Images processed together per step. Higher = smoother learning but much more VRAM — drop to 1–2 if you hit out-of-memory.'],
                      ['Epochs',        epochs,     setEpochs,     'e.g. 1',                'number', 'Full passes over your whole dataset. More = stronger learning, but too many overfits (outputs start copying your training images).'],
                      ['Max Steps',     maxSteps,   setMaxSteps,   'e.g. 1000',             'number', 'Hard cap on total steps regardless of epochs. Leave empty to let epochs decide — ~1,000–3,000 is typical for a LoRA.'],
                      ['Resolution',    resolution, setResolution, 'e.g. 768',              'text'  , 'Training image size in pixels. Higher captures finer detail but trains slower and eats VRAM. Match the base model: 512 / 768 / 1024.'],
                      ['LoRA Rank',     loraRank,   setLoraRank,   'e.g. 16',               'number', 'The LoRA\'s learning capacity. Higher rank = more detail captured but bigger files and easier overfitting. 8–32 typical; 16 is a solid default.'],
                      ['Output Path',   outputPath, setOutputPath, 'path/lora.safetensors', 'text'  , 'Where the trainer writes the finished file inside the run — it then gets uploaded to your R2 storage automatically.'],
                    ] as const).map(([label, val, setter, ph, type, desc]) => (
                      <div key={label} className="space-y-1.5">
                        <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono flex items-center gap-1">
                          {label}
                          <span className="text-slate-700 normal-case font-sans">
                            {val ? '' : `(preset: ${selectedPreset.config[
                              ({ 'Learning Rate': 'learning_rate', 'Batch Size': 'batch_size',
                                 'Epochs': 'epochs', 'Resolution': 'resolution',
                                 'Output Path': 'output_model_destination' } as Record<string, string>)[label] ?? ''
                            ] ?? '—'})`}
                          </span>
                        </label>
                        <input
                          type={type}
                          value={val}
                          onChange={e => setter(e.target.value)}
                          placeholder={ph}
                          className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30"
                        />
                        <p className="text-[9px] text-slate-600 leading-snug">{desc}</p>
                      </div>
                    ))}
                  </div>

                  {/* ── Advanced ── */}
                  <div className="pt-3 border-t border-white/[0.06] space-y-4">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Advanced</p>
                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                      {([
                        ['LoRA Alpha',    loraAlpha,   setLoraAlpha,   'e.g. 16',   'Scales how strongly the LoRA weights apply during training. Common practice: alpha = rank (neutral) or rank/2 (softer). Empty = preset default.'],
                        ['LoRA Dropout',  loraDropout, setLoraDropout, 'e.g. 0.1',  'Randomly drops part of the LoRA each step so it can\'t memorize your images. 0.05–0.15 helps small datasets; 0 = off.'],
                        ['Warmup Steps',  warmupSteps, setWarmupSteps, 'e.g. 100',  'Steps spent ramping the learning rate from 0 to full. Prevents the first noisy steps from wrecking the weights. ~50–200 typical.'],
                      ] as const).map(([label, val, setter, ph, desc]) => (
                        <div key={label} className="space-y-1.5">
                          <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">{label}</label>
                          <input type="number" value={val} onChange={e => setter(e.target.value)} placeholder={ph}
                            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30" />
                          <p className="text-[9px] text-slate-600 leading-snug">{desc}</p>
                        </div>
                      ))}
                      {([
                        ['LR Scheduler', lrScheduler, setLrScheduler,
                          [['CONSTANT', 'Constant'], ['COSINE', 'Cosine'], ['COSINE_WITH_RESTARTS', 'Cosine w/ restarts'], ['LINEAR', 'Linear'], ['REX', 'REX']],
                          'How the learning rate changes over the run. Constant is the safe default; Cosine gently decays it, which often gives cleaner late-training results.'],
                        ['Optimizer', optimizerName, setOptimizerName,
                          [['ADAMW', 'AdamW'], ['ADAMW_8BIT', 'AdamW 8-bit (less VRAM)'], ['ADAFACTOR', 'Adafactor'], ['PRODIGY', 'Prodigy (auto LR)']],
                          'The weight-update algorithm. AdamW is the standard. 8-bit saves VRAM with near-identical results. Prodigy self-tunes the learning rate (set LR to 1.0 with it).'],
                        ['Timesteps', timestepDist, setTimestepDist,
                          [['LOGIT_NORMAL', 'Logit-normal (Flux default)'], ['UNIFORM', 'Uniform'], ['SIGMOID', 'Sigmoid']],
                          'Which noise levels training focuses on. Logit-normal (the Flux paper\'s choice) emphasizes mid-noise steps where composition is learned.'],
                      ] as const).map(([label, val, setter, opts, desc]) => (
                        <div key={label} className="space-y-1.5">
                          <label className="text-[10px] text-slate-600 uppercase tracking-wider font-mono">{label}</label>
                          <select value={val} onChange={e => setter(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-[#0a101d] border border-white/[0.08] text-sm text-white focus:outline-none focus:border-white/30 cursor-pointer">
                            <option value="">Preset default</option>
                            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                          <p className="text-[9px] text-slate-600 leading-snug">{desc}</p>
                        </div>
                      ))}
                    </div>

                    {/* Toggles */}
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <button onClick={() => setSaveEpochs(v => !v)}
                          className={`shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors relative ${saveEpochs ? 'bg-white/80' : 'bg-white/[0.08]'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${saveEpochs ? 'left-[18px] bg-[#05080f]' : 'left-0.5 bg-slate-500'}`} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-[11px] font-semibold text-white">Save epoch snapshots</p>
                            {saveEpochs && (
                              <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                                every
                                <input type="number" min={1} value={saveEvery} onChange={e => setSaveEvery(e.target.value)}
                                  className="w-14 px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-[11px] text-white text-center focus:outline-none focus:border-white/30" />
                                <select value={saveEveryUnit} onChange={e => setSaveEveryUnit(e.target.value as 'EPOCH' | 'STEP')}
                                  className="px-1.5 py-0.5 rounded bg-[#0a101d] border border-white/[0.08] text-[10px] text-white focus:outline-none focus:border-white/30 cursor-pointer">
                                  <option value="EPOCH">epoch(s)</option>
                                  <option value="STEP">steps</option>
                                </select>
                              </span>
                            )}
                          </div>
                          <p className="text-[9px] text-slate-600 leading-snug mt-0.5">
                            Each snapshot is a complete standalone LoRA (like civitai's per-epoch files) — saved to the run's folder so you can pick the best epoch later from the portal's LoRA dropdown. Earlier epochs = subtler; later = stronger but risk overfitting.
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <button onClick={() => setTrainTextEncoder(v => !v)}
                          className={`shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors relative ${trainTextEncoder ? 'bg-white/80' : 'bg-white/[0.08]'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${trainTextEncoder ? 'left-[18px] bg-[#05080f]' : 'left-0.5 bg-slate-500'}`} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-semibold text-white">Train text encoder (CLIP)</p>
                          <p className="text-[9px] text-slate-600 leading-snug mt-0.5">
                            Also trains CLIP so trigger words bind harder to your concept. Uses more VRAM and overfits faster — usually unnecessary for Flux; leave off unless the concept won't stick.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                  </>)}
                </div>

                {/* ── Section 3: Training Concepts ── */}
                <div className="rounded-2xl border border-white/[0.08] bg-[#0a101d] p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">3 · Training Concepts</p>
                      <p className="text-[10px] text-slate-600 mt-0.5">
                        {mode === 'local' ? 'Each concept is a local folder of images.' : isFalPreset ? 'Compose datasets of CLIPS and GIFs (5–50 items total) — stills are rejected; GIFs auto-convert server-side.' : 'Upload a .zip of your image + caption pairs for each concept.'}
                      </p>
                    </div>
                    <button onClick={() => setConcepts(p => [...p, emptyConcept()])}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white text-[11px] transition-all">
                      <Plus size={11} /> Add concept
                    </button>
                  </div>

                  {/* Background dataset build — visible on every device/reload;
                      hidden while the composer popup is open (it shows its own bar) */}
                  {activeBuild && !bucketPickerFor && (
                    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-2">
                      {activeBuild.status === 'running' && (
                        <>
                          <div className="flex items-center justify-between text-[10px] font-mono">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <Loader2 size={10} className="animate-spin" />
                              Building “{activeBuild.name}” — {activeBuild.phase === 'uploading' ? 'uploading zip…' : `${activeBuild.progressDone}/${activeBuild.progressTotal}`}
                            </span>
                            <span className="text-slate-500 tabular-nums">
                              {Math.round((activeBuild.progressBytes ?? 0) / 1024 / 1024)} MB · {Math.round(((activeBuild.progressDone ?? 0) / Math.max(1, activeBuild.progressTotal ?? 1)) * 100)}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                            <div className="h-full rounded-full bg-gradient-to-r from-slate-400 to-white transition-[width] duration-500 ease-out relative overflow-hidden"
                              style={{ width: `${((activeBuild.progressDone ?? 0) / Math.max(1, activeBuild.progressTotal ?? 1)) * 100}%` }}>
                              <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/60 to-transparent" style={{ animation: 'sheen-sweep 2.2s infinite' }} />
                            </div>
                          </div>
                          <p className="text-[9px] text-slate-600">Server-side build — safe to leave this page; it finishes on its own.</p>
                        </>
                      )}
                      {activeBuild.status === 'completed' && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <CheckCircle size={13} className="text-emerald-400 shrink-0" />
                          <p className="flex-1 min-w-0 text-[11px] text-white">
                            Dataset “{activeBuild.name}” ready — {activeBuild.resultCount} images, {activeBuild.resultSizeMb} MB
                            {(activeBuild.truncated || (activeBuild.resultSkipped ?? 0) > 0) && (
                              <span className="text-amber-400/80"> · {activeBuild.resultSkipped} skipped{activeBuild.truncated ? ' (size cap)' : ''}</span>
                            )}
                          </p>
                          <button
                            onClick={() => {
                              if (activeBuild.resultKey && concepts.length > 0) {
                                updateConcept(concepts[0].id, { r2DatasetKey: activeBuild.resultKey, prompt_source: 'sample' })
                              }
                              consumeBuild(activeBuild.id)
                            }}
                            className="shrink-0 px-2.5 py-1 rounded-lg bg-white/10 border border-white/25 text-white text-[10px] font-bold hover:bg-white/15 transition-colors">
                            Use for concept
                          </button>
                          <button onClick={() => consumeBuild(activeBuild.id)}
                            className="shrink-0 p-1 rounded-lg text-slate-600 hover:text-white transition-colors"><X size={12} /></button>
                        </div>
                      )}
                      {activeBuild.status === 'failed' && (
                        <div className="flex items-center gap-2">
                          <AlertCircle size={13} className="text-red-400 shrink-0" />
                          <p className="flex-1 min-w-0 text-[10px] text-red-400 break-words">Build failed: {activeBuild.error || 'unknown error'}</p>
                          <button onClick={() => consumeBuild(activeBuild.id)}
                            className="shrink-0 p-1 rounded-lg text-slate-600 hover:text-white transition-colors"><X size={12} /></button>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-3">
                    {concepts.map((c, i) => (
                      <div key={c.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-600 font-mono shrink-0">#{i + 1}</span>
                          <input value={c.name} onChange={e => updateConcept(c.id, { name: e.target.value })}
                            placeholder="Concept name"
                            className="flex-1 bg-transparent text-xs font-medium text-white placeholder:text-slate-600 focus:outline-none" />
                          {concepts.length > 1 && (
                            <button onClick={() => setConcepts(p => p.filter(x => x.id !== c.id))}
                              className="p-1 rounded hover:bg-red-500/10 text-slate-700 hover:text-red-400 transition-colors">
                              <Trash2 size={10} />
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          {mode === 'local' ? (
                            <div className="space-y-1 col-span-2">
                              <label className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Image folder path</label>
                              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] focus-within:border-white/25 transition-colors">
                                <FolderOpen size={11} className="text-slate-600 shrink-0" />
                                <input value={c.path} onChange={e => updateConcept(c.id, { path: e.target.value })}
                                  placeholder="C:\Training\datasets\my-dataset"
                                  className="flex-1 bg-transparent text-[11px] text-white placeholder:text-slate-700 focus:outline-none font-mono" />
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1.5 col-span-2">
                              <label className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Dataset (.zip of images + captions)</label>
                              {c.r2DatasetKey ? (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                                  <CheckCircle size={11} className="text-emerald-400 shrink-0" />
                                  <span className="flex-1 text-[11px] text-emerald-300 font-mono truncate">{c.r2DatasetKey}</span>
                                  <button onClick={() => updateConcept(c.id, { r2DatasetKey: '' })}
                                    className="text-slate-600 hover:text-red-400 transition-colors">
                                    <X size={11} />
                                  </button>
                                </div>
                              ) : c.uploadProgress !== undefined ? (
                                <div className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] text-slate-400">Uploading…</span>
                                    <span className="text-[10px] text-slate-500 font-mono">{c.uploadProgress}%</span>
                                  </div>
                                  <div className="h-1 rounded-full bg-white/[0.08]">
                                    <div className="h-full rounded-full bg-slate-200 transition-all" style={{ width: `${c.uploadProgress}%` }} />
                                  </div>
                                </div>
                              ) : (
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() => triggerDatasetUpload(c.id)}
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-dashed border-white/[0.12] text-slate-500 hover:text-white hover:border-white/25 text-[11px] transition-all">
                                    <Upload size={11} />
                                    Upload .zip
                                  </button>
                                  <button
                                    onClick={() => setBucketPickerFor(c.id)}
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 border border-white/25 text-white hover:bg-white/15 text-[11px] font-medium transition-all">
                                    <FolderOpen size={11} />
                                    From site datasets
                                  </button>
                                  <button
                                    onClick={() => setBuiltPickerFor(c.id)}
                                    title="Reuse an already-built dataset zip — no rebuild needed"
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/15 text-slate-300 hover:text-white hover:border-white/30 text-[11px] font-medium transition-all">
                                    <HardDrive size={11} />
                                    Built
                                  </button>
                                </div>
                              )}
                              <input
                                type="file"
                                accept=".zip"
                                className="hidden"
                                ref={el => { fileInputRefs.current[c.id] = el }}
                                onChange={e => {
                                  const file = e.target.files?.[0]
                                  if (file) handleDatasetFile(c.id, file)
                                  e.target.value = ''
                                }}
                              />
                            </div>
                          )}

                          <div className="space-y-1">
                            <label className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Caption source</label>
                            <div className="relative">
                              <select value={c.prompt_source} onChange={e => updateConcept(c.id, { prompt_source: e.target.value as Concept['prompt_source'] })}
                                className="w-full appearance-none border border-white/[0.08] rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-white/30 pr-6"
                                style={{ backgroundColor: '#131320', color: '#cbd5e1' }}>
                                <option value="sample"   style={{ backgroundColor: '#131320', color: '#cbd5e1' }}>txt files (same name as image)</option>
                                <option value="filename" style={{ backgroundColor: '#131320', color: '#cbd5e1' }}>Image filename as prompt</option>
                                <option value="concept"  style={{ backgroundColor: '#131320', color: '#cbd5e1' }}>Single prompt file</option>
                              </select>
                              <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
                            </div>
                          </div>

                          <div className="space-y-1">
                            <label className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Repeats</label>
                            <input type="number" min="0.1" step="0.1" value={c.repeats}
                              onChange={e => updateConcept(c.id, { repeats: parseFloat(e.target.value) || 1 })}
                              className="w-full px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white focus:outline-none focus:border-white/30" />
                          </div>

                          {c.prompt_source === 'concept' && (
                            <div className="space-y-1 col-span-2">
                              <label className="text-[9px] text-slate-600 uppercase tracking-wider font-mono">Prompt file path</label>
                              <input value={c.prompt_path} onChange={e => updateConcept(c.id, { prompt_path: e.target.value })}
                                placeholder="C:\Training\prompts.txt"
                                className="w-full px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[11px] text-white placeholder:text-slate-700 focus:outline-none focus:border-white/30 font-mono" />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Launch guard: a run with these blank silently uses preset
                    defaults — the classic "trained but learned nothing" run */}
                {mode === 'cloud' && (!epochs || (trainMethod === 'lora' && !loraRank) || !lr) && (
                  <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5">
                    <p className="text-[10px] text-amber-300 leading-relaxed">
                      <span className="font-bold">Heads up:</span>{' '}
                      {[!lr && 'learning rate', trainMethod === 'lora' && !loraRank && 'rank', !epochs && 'epochs'].filter(Boolean).join(', ')} not set —
                      the preset&apos;s defaults will be used, which usually won&apos;t learn your subject.
                      Tap a Quick Setup recipe (subject + size) to fill tuned values.
                    </p>
                  </div>
                )}

                {/* Pre-launch runtime estimate — live-updates as config changes */}
                {mode === 'cloud' && cloudEta && (
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-600 flex items-center gap-1.5">
                        <Clock size={10} className="text-slate-600" /> Estimated run time
                      </span>
                      <span className="text-[13px] font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-white/85 to-white/55">
                        ~{fmtEtaDur(cloudEta.total)}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 font-mono">
                      {cloudEta.imgs} imgs · {cloudEta.steps} steps — setup ~{fmtEtaDur(cloudEta.setupSec)} · caching ~{fmtEtaDur(cloudEta.cacheSec)} · training ~{fmtEtaDur(cloudEta.trainSec)} · uploads ~{fmtEtaDur(cloudEta.uploadSec)}
                    </p>
                    <p className="text-[9px] text-slate-700 leading-relaxed">
                      Rough A40 estimate — a warm worker skips most of setup. The Monitor shows live measured ETAs once the run starts.
                    </p>
                  </div>
                )}

                {/* Start button */}
                <button onClick={startTraining} disabled={!canTrain || launching}
                  className="relative overflow-hidden w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-white/10 border border-white/25 text-white text-sm font-bold hover:bg-white/15 hover:border-white/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  {canTrain && !launching && !isTraining && (
                    <span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent pointer-events-none" style={{ animation: 'sheen-sweep 2.6s infinite' }} />
                  )}
                  {launching ? <Loader2 size={15} className="animate-spin" /> : mode === 'cloud' ? <Cloud size={15} /> : mode === 'fal' ? <Sparkles size={15} /> : <Play size={15} />}
                  {launching ? 'Launching…' : isTraining ? 'Training in progress…' : mode === 'cloud' ? 'Train on RunPod' : mode === 'fal' ? 'Train on fal (Wan 2.2 Video)' : 'Start Training'}
                </button>

              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Bucket dataset picker modal */}
      {/* Built-datasets chooser — reuse a finished build as a concept */}
      {builtPickerFor && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={() => setBuiltPickerFor(null)}>
          <div className="relative w-full max-w-2xl max-h-[85vh] rounded-2xl border border-white/[0.08] bg-[#070b14]/95 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center gap-2.5">
                <HardDrive size={14} className="text-slate-400" />
                <div>
                  <p className="text-sm font-bold text-white leading-none">Built Datasets</p>
                  <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 leading-none mt-1">Reuse without rebuilding</p>
                </div>
              </div>
              <button onClick={() => setBuiltPickerFor(null)} className="text-slate-500 hover:text-white transition-colors"><X size={15} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
              {builtViewError && !builtView && (
                <p className="text-[10px] text-red-400 px-1">{builtViewError}</p>
              )}
              {builtView ? (
                <>
                  {/* Browse a build's media + captions (read-only — the zip is baked) */}
                  <div className="flex items-center gap-2 pb-1.5">
                    <button onClick={() => setBuiltView(null)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0">
                      <ArrowLeft size={11} /> Back
                    </button>
                    <p className="text-[12px] font-semibold text-white truncate">{builtView.name}</p>
                    <span className="text-[10px] text-slate-600 font-mono shrink-0">{builtView.images.length} images · tap one for its caption</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {builtView.images.map((img, idx) => (
                      <button key={`${img.id}-${idx}`} onClick={() => setBuiltViewerIdx(idx)}
                        className="relative aspect-square rounded-lg overflow-hidden border border-white/[0.07] bg-white/[0.03] hover:border-white/30 transition-colors">
                        <RetryImg src={`/api/admin/dataset/thumb/${img.id}`}
                          className="w-full h-full object-cover" />
                        {!!img.caption && (
                          <span className="absolute bottom-1 left-1 w-4 h-4 rounded-full bg-emerald-500/80 flex items-center justify-center" title="Has caption">
                            <Check size={9} className="text-white" strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              ) : builtList === null ? (
                <div className="flex items-center justify-center py-8 text-slate-600 text-xs gap-2"><Loader2 size={13} className="animate-spin" /> Loading…</div>
              ) : builtList.length === 0 ? (
                <p className="text-center text-slate-600 text-xs py-8 px-4 leading-relaxed">
                  No built datasets yet — build one from &quot;From site datasets&quot; and it will show up here for reuse.
                </p>
              ) : builtList.map(job => {
                const jid = Number(job.id)
                return (
                <div key={String(job.id)}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-white/25 p-3 transition-colors">
                  <div className="flex items-center gap-1.5">
                    {builtEditId === jid ? (
                      <input autoFocus value={builtEditName} onChange={e => setBuiltEditName(e.target.value)}
                        onBlur={() => renameBuilt(jid)}
                        onKeyDown={e => { if (e.key === 'Enter') renameBuilt(jid); if (e.key === 'Escape') setBuiltEditId(null) }}
                        onClick={e => e.stopPropagation()}
                        className="flex-1 min-w-0 px-2 py-1 rounded-md bg-white/[0.06] border border-white/25 text-[12px] font-semibold text-white focus:outline-none" />
                    ) : (
                      <p className="flex-1 min-w-0 text-[12px] font-semibold text-white truncate">{String(job.name || 'dataset')}</p>
                    )}
                    <button onClick={() => { setBuiltEditId(jid); setBuiltEditName(String(job.name || '')) }}
                      title="Rename this built dataset"
                      className="shrink-0 p-1 rounded text-slate-600 hover:text-white transition-colors">
                      <Settings2 size={11} />
                    </button>
                    <button onClick={() => viewBuilt(job)} title="View the dataset's media and captions"
                      className="shrink-0 p-1 rounded text-slate-600 hover:text-white transition-colors">
                      {builtViewLoading ? <Loader2 size={11} className="animate-spin" /> : <Eye size={11} />}
                    </button>
                    <button
                      onClick={() => builtDeleteConfirm === jid ? deleteBuilt(jid) : setBuiltDeleteConfirm(jid)}
                      onBlur={() => setBuiltDeleteConfirm(null)}
                      title={builtDeleteConfirm === jid ? 'Tap again to permanently delete' : 'Delete this built dataset'}
                      className={`shrink-0 p-1 rounded transition-colors ${
                        builtDeleteConfirm === jid ? 'text-red-400 bg-red-500/10' : 'text-slate-600 hover:text-red-400'}`}>
                      <Trash2 size={11} />
                    </button>
                    <span className="text-[9px] text-slate-600 font-mono shrink-0">
                      {job.createdAt ? new Date(String(job.createdAt)).toLocaleDateString() : ''}
                    </span>
                  </div>
                  {builtDeleteConfirm === jid && (
                    <p className="text-[9px] text-red-400 mt-1">Tap the trash again to delete — removes the zip from storage too. Past runs that used it are unaffected.</p>
                  )}
                  <button onClick={() => attachBuiltDataset(job)} disabled={builtBusy}
                    className="w-full text-left mt-1 disabled:opacity-50">
                    <p className="text-[10px] text-slate-500 font-mono">
                      {String(job.resultCount ?? '?')} images · {String(job.resultSizeMb ?? '?')} MB
                      {Number(job.maxDim) > 0 ? ` · ${job.maxDim}px` : ' · original size'}
                      {job.truncated ? ' · truncated' : ''}
                      <span className="text-slate-300"> — tap to use</span>
                    </p>
                  </button>
                </div>
              )})}
            </div>
          </div>
        </div>
      )}

      {/* Read-only viewer over a built dataset's images + captions */}
      {builtView && builtViewerIdx !== null && builtView.images.length > 0 && (
        <DatasetImageViewer
          images={builtView.images}
          index={Math.min(builtViewerIdx, builtView.images.length - 1)}
          onClose={() => setBuiltViewerIdx(null)}
          onNav={setBuiltViewerIdx}
          isSelected={() => false}
          onToggleSelect={() => {}}
          selectable={false}
        />
      )}

      {bucketPickerFor && (
        <BucketPickerModal
          adminHeaders={ah()}
          initialData={pendingComposerData}
          onClose={() => setBucketPickerFor(null)}
          onBuilt={(key, snapshot) => {
            updateConcept(bucketPickerFor, { r2DatasetKey: key, prompt_source: 'sample' })
            setConceptSnapshots(prev => ({ ...prev, [bucketPickerFor]: snapshot }))
            setPendingComposerData(null)
            setBucketPickerFor(null)
            // Auto-pick the dataset-size chip from the freshly built dataset
            // (re-applies the recipe when a subject is already chosen)
            const detected = recipeSizeForCount(snapshot.images.length)
            if (recipeSubject !== null || recipeSize !== null) applyRecipe(recipeSubject, detected)
            else setRecipeSize(detected)
          }}
        />
      )}

      {/* ── Monitor tab ── */}
      {/* ── Monitor tab — cloud: concurrent runs, one self-polling card each ── */}
      {tab === 'monitor' && mode === 'cloud' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-3 max-w-3xl mx-auto">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-white">Training Runs</p>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Each run is its own RunPod worker — start as many as your endpoint&apos;s max-worker limit allows; they train in parallel.
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {(() => {
                  const doneCount = cloudRuns.filter(r => runStatuses[r.jobId] === 'done').length
                  return doneCount > 0 || !showCompleted ? (
                    <button onClick={() => setShowCompleted(v => !v)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] transition-all ${
                        showCompleted ? 'bg-white/10 border-white/25 text-white' : 'bg-white/[0.04] border-white/[0.08] text-slate-400 hover:text-white'}`}>
                      <CheckCircle size={11} />
                      {showCompleted ? `Hide completed (${doneCount})` : `Show completed (${doneCount})`}
                    </button>
                  ) : null
                })()}
                <button onClick={() => setTab('config')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20 text-[11px] transition-all">
                  <Plus size={11} /> New run
                </button>
              </div>
            </div>

            {cloudRuns.length === 0 && (
              <div className="text-center py-14 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                <Cpu size={28} className="mx-auto text-slate-700 mb-3" />
                <p className="text-sm text-slate-600">No training runs being monitored</p>
                <p className="text-[11px] text-slate-700 mt-1">Start a run from the Configure tab and it appears here with live progress.</p>
              </div>
            )}

            {cloudRuns.map(r => (
              /* Hidden via CSS, not unmounted — the card's poller must keep
                 running so a hidden run's status stays current */
              <div key={r.jobId} className={!showCompleted && runStatuses[r.jobId] === 'done' ? 'hidden' : undefined}>
                <CloudRunCard run={r} adminHeaders={ah()} onDismiss={() => dismissRun(r.jobId)}
                  onRetry={retryCloudRun}
                  onStatus={s => setRunStatuses(prev => prev[r.jobId] === s ? prev : { ...prev, [r.jobId]: s })}
                  onRename={name => setCloudRuns(prev => {
                    const next = prev.map(x => x.jobId === r.jobId ? { ...x, runName: name } : x)
                    try { localStorage.setItem('ot-cloud-runs-v1', JSON.stringify(next)) } catch {}
                    return next
                  })} />
              </div>
            ))}
            {!showCompleted && cloudRuns.length > 0 && cloudRuns.every(r => runStatuses[r.jobId] === 'done') && (
              <p className="text-center text-[11px] text-slate-600 py-6">
                All {cloudRuns.length} run{cloudRuns.length === 1 ? ' is' : 's are'} completed — tap &quot;Show completed&quot; to see them.
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'monitor' && mode === 'local' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4 max-w-3xl mx-auto">

            <div className="rounded-2xl border border-white/[0.08] bg-[#0a101d] p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex items-center gap-2 text-sm font-semibold ${statusColor(activeStatus)}`}>
                    {activeStatus === 'running'   && <Loader2 size={14} className="animate-spin" />}
                    {activeStatus === 'done'      && <CheckCircle size={14} />}
                    {activeStatus === 'error'     && <AlertCircle size={14} />}
                    {activeStatus === 'idle'      && <Cpu size={14} />}
                    {activeStatus === 'cancelled' && <X size={14} />}
                    {statusLabel(activeStatus)}
                  </div>
                  {activeRunName && <span className="text-xs text-slate-500">{activeRunName}</span>}
                  {trainStatus.pid && (
                    <span className="text-[10px] text-slate-700 font-mono">PID {trainStatus.pid}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={fetchStatus} className="p-1.5 rounded hover:bg-white/[0.06] text-slate-600 hover:text-slate-400 transition-colors">
                    <RefreshCw size={11} />
                  </button>
                  {isTraining && (
                    <button onClick={cancelTraining}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs hover:bg-red-500/15 transition-all">
                      <Square size={10} /> Cancel
                    </button>
                  )}
                </div>
              </div>

              {activeStarted && (
                <p className="text-[10px] text-slate-600 mt-2">
                  Started {new Date(activeStarted * 1000).toLocaleTimeString()}
                  {activeStatus !== 'running' && trainStatus.returncode !== null && ` · Exit code ${trainStatus.returncode}`}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-[#07070e] p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] text-slate-600 uppercase tracking-wider font-mono flex items-center gap-1.5">
                  <Terminal size={10} /> Training Log
                </p>
                <span className="text-[10px] text-slate-700">{activeLogs.length} lines</span>
              </div>
              {activeLogs.length === 0 ? (
                <p className="text-xs text-slate-700 font-mono text-center py-8">No logs yet — start a training run.</p>
              ) : (
                <div className="space-y-0.5 font-mono text-[11px]">
                  {activeLogs.map((line, i) => {
                    const isErr  = /error|exception|traceback/i.test(line)
                    const isWarn = /warn|warning/i.test(line)
                    const isStep = /step|epoch|loss/i.test(line)
                    return (
                      <p key={i} className={
                        isErr  ? 'text-red-400' :
                        isWarn ? 'text-amber-400' :
                        isStep ? 'text-emerald-400' :
                        line.startsWith('[server]') || line.startsWith('[runpod]') ? 'text-violet-400' :
                        'text-slate-400'
                      }>{line}</p>
                    )
                  })}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>

            {!isTraining && (
              <button onClick={() => setTab('config')}
                className="flex items-center gap-2 text-xs text-slate-600 hover:text-slate-400 transition-colors">
                <Settings2 size={11} /> Configure a new run
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Saved LoRAs tab ── */}
      {tab === 'loras' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto space-y-4">

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-white">Saved LoRAs</p>
                <p className="text-[11px] text-slate-600 mt-0.5">Your trained runs in R2 under <span className="font-mono">training/loras/</span> — final LoRA + per-epoch snapshots + config</p>
              </div>
              <button onClick={loadRuns} disabled={r2LorasLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20 text-[11px] transition-all disabled:opacity-40">
                {r2LorasLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Refresh
              </button>
            </div>

            {lorasError && <p className="text-[10px] text-red-400">{lorasError}</p>}

            {r2LorasLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-slate-600" />
              </div>
            )}

            {!r2LorasLoading && runsList.length === 0 && legacyLoras.length === 0 && (
              <div className="text-center py-12 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                <Zap size={28} className="mx-auto text-slate-700 mb-3" />
                <p className="text-sm text-slate-600">No trained LoRAs yet</p>
                <p className="text-[11px] text-slate-700 mt-1">Completed training runs will appear here automatically.</p>
              </div>
            )}

            {!r2LorasLoading && runsList.length > 0 && (
              <div className="space-y-2">
                {runsList.map(r => (
                  <RunCard key={r.folder} run={r} adminHeaders={ah()} onReload={reloadRun} />
                ))}
              </div>
            )}

            {!r2LorasLoading && legacyLoras.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Older LoRAs (before run folders)</p>
                {legacyLoras.map(f => (
                  <LoraListItem key={f.key} file={f} adminHeaders={ah()} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Completed Runs tab ── */}
      {tab === 'history' && (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-white">Completed Training Runs</p>
                <p className="text-[11px] text-slate-600 mt-0.5">The full logged record of every finished run — settings, dataset, timing and outputs</p>
              </div>
              <button onClick={loadRuns} disabled={r2LorasLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:text-white hover:border-white/20 text-[11px] transition-all disabled:opacity-40">
                {r2LorasLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Refresh
              </button>
            </div>

            {r2LorasLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-slate-600" />
              </div>
            )}

            {!r2LorasLoading && runsList.filter(r => r.final).length === 0 && (
              <div className="text-center py-12 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                <CheckCircle size={28} className="mx-auto text-slate-700 mb-3" />
                <p className="text-sm text-slate-600">No completed runs yet</p>
                <p className="text-[11px] text-slate-700 mt-1">Finished training runs appear here with their full configuration record.</p>
              </div>
            )}

            {!r2LorasLoading && runsList.filter(r => r.final).map(r => (
              <CompletedRunCard key={r.folder} run={r} adminHeaders={ah()} />
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
