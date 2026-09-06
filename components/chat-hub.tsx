"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Marked } from "marked"
import { markedHighlight } from "marked-highlight"
import hljs from "highlight.js/lib/common"
import "highlight.js/styles/github-dark.css"
import {
  Plus, Trash2, Pencil, Check, X, ChevronDown, ChevronRight,
  Send, Square, FolderPlus, FolderInput, MessageSquarePlus, PanelLeft,
  Bot, Sparkles, BookOpen, Upload, Image as ImageIcon, Clapperboard, Ticket, KeyRound,
  PanelRight, PanelBottom, ZoomIn, ZoomOut, BookMarked,
  Crop, Globe, Save, RotateCcw, Search, HelpCircle, ListChecks, Brain, Eye,
  Users, Palette, PenTool,
  Megaphone, Smartphone, Camera, SwatchBook, Video, ScrollText, Film,
  Brush, UserCheck, Type, LayoutTemplate, MousePointerClick, MessageSquareText,
  Instagram, User as UserIcon, ExternalLink, Pipette,
  Lightbulb, Landmark, Aperture, Gem, PersonStanding, UsersRound, Layers, EyeOff, Copy, RotateCw, Eraser, GripVertical, Pin, PinOff, Star,
  Maximize2,
} from "lucide-react"
import {
  CHAT_HUB_MODELS, CHAT_HUB_PROVIDERS, CHAT_CREATE_MODELS, CHAT_CREATE_GROUPS, usableCreateModels,
  DEFAULT_CHAT_MODEL, CUSTOM_MODEL_ID_RE, MAX_CUSTOM_MODELS, AGENT_CAPABILITIES,
  appStyleInstructions, getCreateModel, resolveCreateSettings, computeCreateCost,
  type ChatHubProvider, type ChatHubRoute, type ChatCreateModel, type ChatCreateSettings,
  type CustomChatModel,
} from "@/lib/chat-hub-models"
// Type-only imports — the agent lib itself is server-only (prisma/crypto/fal)
import type { AgentStep, StreamEvent, PendingCall, AgentMode } from "@/lib/chat-hub-agent"
import {
  ALL_SCOPES, DEFAULT_PERMISSIONS, modelCatalogForKeys, type ApiKeyPermissions,
} from "@/lib/api-key-permissions"
import { SiteLogoBox } from "@/components/SitePageHeader"
import {
  AGENT_SKILLS, ALL_SKILL_IDS, BUILT_IN_EMPLOYEES, SKILL_CATEGORIES, estimateRunCost,
  MOVIE_FORMATS, DEFAULT_MOVIE_FORMAT,
} from "@/lib/chat-hub-skills"

const ROUTING_LS_KEY = "chat-hub-routing"
const ROUTING_EVENT = "chat-hub-routing-changed"

// ── Chat layout preferences (width + text size), set in Profile → Chat Settings ──
const LAYOUT_LS_KEY = "chat-hub-layout"
const LAYOUT_EVENT = "chat-hub-layout-changed"

interface ChatLayout {
  width: "narrow" | "wide"
  textSize: "sm" | "md" | "lg"
  // cards = bounded step/text cards (original); floating = Higgsfield/Claude
  // style — text and steps float on the background with expand chevrons
  style: "cards" | "floating"
}
const DEFAULT_LAYOUT: ChatLayout = { width: "narrow", textSize: "md", style: "cards" }
// md is a step up from the original 13px — the default read small on iPad
const CHAT_TEXT_PX: Record<ChatLayout["textSize"], number> = { sm: 13, md: 15, lg: 17 }

function readLayoutFromStorage(): ChatLayout {
  const next = { ...DEFAULT_LAYOUT }
  try {
    const raw = localStorage.getItem(LAYOUT_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.width === "narrow" || parsed.width === "wide") next.width = parsed.width
      if (parsed.textSize === "sm" || parsed.textSize === "md" || parsed.textSize === "lg") next.textSize = parsed.textSize
      if (parsed.style === "cards" || parsed.style === "floating") next.style = parsed.style
    }
  } catch {}
  return next
}

type RoutingMap = Record<ChatHubProvider, ChatHubRoute>
const DEFAULT_ROUTING: RoutingMap = { Anthropic: "gateway", OpenAI: "gateway", Google: "gateway", xAI: "gateway" }

function readRoutingFromStorage(): RoutingMap {
  const next = { ...DEFAULT_ROUTING }
  try {
    const raw = localStorage.getItem(ROUTING_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      for (const p of CHAT_HUB_PROVIDERS) {
        if (parsed[p] === "gateway" || parsed[p] === "direct") next[p] = parsed[p]
      }
    }
  } catch {}
  return next
}

interface KeyStatus {
  gateway: boolean                          // AI_GATEWAY_API_KEY env present
  direct: Record<ChatHubProvider, boolean>  // per-provider env keys present
  saved: Record<string, string | null>      // masked hints of the user's own stored keys
  canSaveKeys: boolean
}

// Saved instruction presets ("personas"), stored in account preferences.
// modelId set = auto-applied to NEW chats started with that model.
// Sitewide design system: animated silver rim (masked spinning band) hugging
// a rounded container — the same chrome as the portal popups and SiteLogoBox
const SILVER_RIM_CONIC =
  "conic-gradient(from 0deg, rgba(226,232,240,0.1), #f8fafc, #94a3b8, rgba(226,232,240,0.15), #cbd5e1, #64748b, rgba(226,232,240,0.1))"
function SilverRim({ rounded = 16, inset = 1.5, opacity = 0.55 }: { rounded?: number; inset?: number; opacity?: number }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{
        borderRadius: rounded,
        padding: inset,
        opacity,
        WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        maskComposite: "exclude",
      } as React.CSSProperties}
    >
      <span className="absolute -inset-[75%] animate-spin" style={{ background: SILVER_RIM_CONIC, animationDuration: "6s" }} />
    </span>
  )
}

interface Persona {
  id: string
  name: string
  text: string
  modelId: string | null
  skills?: string[] | null // enabled skill ids (null/absent = all — legacy presets)
  emoji?: string | null    // avatar shown on the employee card
  agentMode?: AgentMode | null // default permission mode applied with the employee
}

// Icon per skill for the skill cards
const SKILL_ICONS: Record<string, typeof ImageIcon> = {
  "image-generation": ImageIcon,
  "video-production": Clapperboard,
  "prompting-guides": BookOpen,
  "graphic-design": Palette,
  "color-theory": Pipette,
  "lighting-design": Lightbulb,
  "style-lexicon": Landmark,
  "photography-craft": Aperture,
  "materials-surfaces": Gem,
  "figure-anatomy": PersonStanding,
  "photoshop": Crop,
  "sketching": PenTool,
  "ad-creative-director": Megaphone,
  "ugc-content": Smartphone,
  "product-photography": Camera,
  "brand-kit": SwatchBook,
  "cinematic-direction": Video,
  "script-storyboard": ScrollText,
  "montage-sequencing": Film,
  "cartoon-anime": Brush,
  "character-consistency": UserCheck,
  "character-fusion": UsersRound,
  "typography-poster": Type,
  "platform-formats": LayoutTemplate,
  "thumbnail-design": MousePointerClick,
  "copywriting-captions": MessageSquareText,
  "instagram-publishing": Instagram,
  "delegation": Bot,
  "web-research": Globe,
  "reference-library": BookMarked,
  "project-memory": Save,
}

// Skill cards grid, grouped by category — used for the chat's live skills AND
// the employee editor. Cards show the always-on cost; skills with an
// on-demand playbook get a faint "+N.Nk on demand" hint.
function SkillCards({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const filtered = q
    ? AGENT_SKILLS.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    : AGENT_SKILLS
  return (
    <div className="space-y-2">
      {AGENT_SKILLS.length > 15 && (
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-7 pr-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-white/25"
          />
        </div>
      )}
      {SKILL_CATEGORIES.map(cat => {
        const skills = filtered.filter(s => s.category === cat.id)
        if (!skills.length) return null
        const selSum = skills.filter(s => selected.includes(s.id)).reduce((t, s) => t + s.summaryTokens, 0)
        return (
          <div key={cat.id}>
            <div className="flex items-center justify-between px-0.5 pb-1">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{cat.label}</span>
              {selSum > 0 && (
                <span className="text-[8px] tabular-nums text-slate-600">{(selSum / 1000).toFixed(1)}k on</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {skills.map(s => {
                const on = selected.includes(s.id)
                const Icon = SKILL_ICONS[s.id] ?? Sparkles
                return (
                  <button
                    key={s.id}
                    onClick={() => onToggle(s.id)}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      on
                        ? "border-emerald-500/40 bg-emerald-500/[0.08]"
                        : "border-white/10 bg-white/[0.03] opacity-60 hover:opacity-100"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 pb-1">
                      <Icon size={11} className={on ? "text-emerald-300" : "text-slate-500"} />
                      <span className={`flex-1 min-w-0 truncate text-[10px] font-medium ${on ? "text-emerald-200" : "text-slate-400"}`}>
                        {s.name}
                      </span>
                      <span className={`shrink-0 text-[8px] tabular-nums ${on ? "text-emerald-400/70" : "text-slate-600"}`}>
                        {(s.summaryTokens / 1000).toFixed(1)}k
                      </span>
                    </div>
                    <div
                      className="text-[9px] leading-snug text-slate-500"
                      style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                    >
                      {s.description}
                    </div>
                    {s.playbookTokens > 0 && (
                      <div className={`pt-0.5 text-[8px] tabular-nums ${on ? "text-emerald-500/50" : "text-slate-700"}`}>
                        +{(s.playbookTokens / 1000).toFixed(1)}k on demand
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const MAX_PERSONAS = 20

function newPersonaId(): string {
  try { return crypto.randomUUID() } catch { return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
}

interface ChatSummary {
  id: number
  title: string
  model: string
  updatedAt: string
}

interface Project {
  id: number
  name: string
  chats: ChatSummary[]
}

interface Msg {
  id: number | string
  role: "user" | "assistant" | "system"
  content: string
  model?: string | null
  imageUrls?: string[]
  agentSteps?: AgentStep[]
  pendingApproval?: { calls: PendingCall[] } | null
  runMs?: number // cumulative orchestrator runtime across all rounds
  canceled?: boolean // run was stopped by the user mid-flight
  errored?: boolean  // stream died mid-run (watchdog/provider error) — partial reply
  // Distinct text sub-cards: initial announcement, post-approval continuations…
  textSegments?: string[]
  // Create-mode generations: config recorded at generation time
  createInfo?: { settings?: Record<string, string>; ticketCost?: number; kind?: string } | null
}

// Everything the media viewer popup needs about one clicked item
interface MediaViewerState {
  url: string
  isVideo: boolean
  modelId?: string | null
  kind?: string
  prompt?: string
  settings?: Record<string, string>
  cost?: number
  isRef?: boolean
  // edit_image layer recipe → the viewer becomes a layer editor
  recipe?: { image_url?: string; canvas?: { width: number; height: number; color?: string }; operations: any[] }
  messageId?: number
  stepId?: string
}

// Map GET payload rows (with metadata) into Msg
function mapServerMessages(rows: any[]): Msg[] {
  return (rows ?? []).map((m: any) => {
    const meta = m.metadata ?? {}
    return {
      id: m.id, role: m.role, content: m.content, model: m.model, imageUrls: m.imageUrls,
      agentSteps: Array.isArray(meta.agentSteps) ? meta.agentSteps : undefined,
      pendingApproval: meta.pendingApproval ?? null,
      runMs: typeof meta.runMs === "number" ? meta.runMs : undefined,
      canceled: meta.canceled === true ? true : undefined,
      errored: meta.streamErrored === true ? true : undefined,
      textSegments: Array.isArray(meta.textSegments) && meta.textSegments.length
        ? meta.textSegments
        : (m.content ? [m.content] : []),
      createInfo: meta.createModel
        ? { settings: meta.settings, ticketCost: meta.ticketCost, kind: meta.kind }
        : null,
    }
  })
}

// A "[LAYERED EDIT …]" message carries a big recipe JSON for the model — show
// the user only what they actually typed (the "Requested change") in the bubble.
const LAYERED_EDIT_RE = /^\[LAYERED EDIT[^\]]*\]\nRequested change: ([\s\S]*?)\n\nThe attached image was BUILT/
function displayUserContent(content: string): { text: string; isLayeredEdit: boolean } {
  const m = content.match(LAYERED_EDIT_RE)
  return m ? { text: m[1].trim(), isLayeredEdit: true } : { text: content, isLayeredEdit: false }
}

// Provider color identities — make it obvious which model produced what
const PROVIDER_ACCENT: Record<string, { text: string; border: string; chip: string }> = {
  Anthropic: { text: "text-orange-300",  border: "border-l-orange-400/60",  chip: "bg-orange-500/10 border-orange-500/30 text-orange-300" },
  OpenAI:    { text: "text-emerald-300", border: "border-l-emerald-400/60", chip: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" },
  Google:    { text: "text-blue-300",    border: "border-l-blue-400/60",    chip: "bg-blue-500/10 border-blue-500/30 text-blue-300" },
  xAI:       { text: "text-rose-300",    border: "border-l-rose-400/60",    chip: "bg-rose-500/10 border-rose-500/30 text-rose-300" },
  custom:    { text: "text-cyan-300",    border: "border-l-cyan-400/60",    chip: "bg-cyan-500/10 border-cyan-500/30 text-cyan-300" },
}

function providerOfModelId(id: string | null | undefined): string {
  if (!id) return "custom"
  const builtin = CHAT_HUB_MODELS.find(m => m.id === id)
  if (builtin) return builtin.provider
  const prefix = id.split("/")[0]?.toLowerCase()
  if (prefix === "anthropic") return "Anthropic"
  if (prefix === "openai") return "OpenAI"
  if (prefix === "google") return "Google"
  if (prefix === "xai") return "xAI"
  return "custom"
}

function accentFor(id: string | null | undefined) {
  return PROVIDER_ACCENT[providerOfModelId(id)] ?? PROVIDER_ACCENT.custom
}

const AGENT_MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Plan — proposes steps, never executes tools" },
  { id: "accept", label: "Ask", hint: "Ask — pauses for your approval before running tools" },
  { id: "approved", label: "Auto", hint: "Auto — delegates and runs tools freely" },
]

// Active reference images passed down from the portal's Refs dropdown
interface ChatRef {
  id: string
  url: string
}

// Small thumbnails via the Next image optimizer (prod accepts only q=75 and
// whitelisted widths — 128/256/384 verified). Anything that isn't a plain
// https URL (data:, blob:, transient upload states) passes through untouched.
function refThumb(url: string, w: 128 | 256 | 384 = 128): string {
  if (!url.startsWith("https://")) return url
  return `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=75`
}

// If the optimizer request fails for any reason, fall back to the raw image
function thumbFallback(e: React.SyntheticEvent<HTMLImageElement>, rawUrl: string) {
  const img = e.currentTarget
  if (img.src !== rawUrl) img.src = rawUrl
}

function modelLabel(id: string | null | undefined): string {
  if (!id) return ""
  return CHAT_HUB_MODELS.find(m => m.id === id)?.label
    ?? CHAT_CREATE_MODELS.find(m => m.id === id)?.label
    ?? id
}

function isVideoUrl(u: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(u)
}

// Stopwatch formatting for orchestrator runtimes: "42s" / "3m 07s"
function fmtRun(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Proper markdown: GFM tables, lists, headings, fenced code with syntax
// highlighting. Raw HTML in model output is escaped, never rendered (XSS).
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const markdownEngine = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      try {
        return lang && hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang }).value
          : hljs.highlightAuto(code).value
      } catch { return escapeHtml(code) }
    },
  }),
)
markdownEngine.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: any) {
      const raw = typeof token === "string" ? token : (token?.text ?? token?.raw ?? "")
      return escapeHtml(String(raw))
    },
    // Never render <img> from model text: models sometimes hallucinate media
    // URLs, and a dead src draws a broken "?" box whose zero→intrinsic size
    // flips make the whole transcript stutter. Real generated media renders
    // from message.imageUrls, not markdown — so text images become links.
    image(token: any) {
      const href = String(token?.href ?? "")
      const label = String(token?.text || token?.title || "image link")
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">🖼 ${escapeHtml(label)}</a>`
    },
  } as any,
})

function renderMarkdown(text: string): string {
  try {
    return markdownEngine.parse(text, { async: false }) as string
  } catch {
    return escapeHtml(text).replace(/\n/g, "<br/>")
  }
}

// Live "thinking" status shown while the model hasn't produced anything yet —
// stage text evolves with elapsed time, plus a timer and shimmer so a slow
// model (long reasoning, cold start) never looks stalled.
const ThinkingIndicator = memo(function ThinkingIndicator({
  modelLabel, routeText, modeLabel,
}: { modelLabel: string; routeText: string; modeLabel: string }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const stage =
    elapsed < 2 ? `Contacting ${modelLabel}…`
    : elapsed < 8 ? `${modelLabel} is thinking…`
    : elapsed < 20 ? "Thinking — reasoning through your request…"
    : elapsed < 45 ? "Still working — composing a longer reply…"
    : "Deep in it — long replies and tool planning can take a minute…"
  const mm = Math.floor(elapsed / 60)
  const ss = String(elapsed % 60).padStart(2, "0")
  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex gap-1 items-center shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
        </span>
        <span className="text-[12px] text-slate-300">{stage}</span>
        <span className="text-[10px] text-slate-600 tabular-nums shrink-0">{mm}:{ss}</span>
      </div>
      <div className="h-0.5 w-44 max-w-full rounded-full overflow-hidden bg-white/5">
        <div
          className="h-full w-1/3 rounded-full bg-cyan-400/60"
          style={{ animation: "chat-thinking-slide 1.8s ease-in-out infinite" }}
        />
      </div>
      <div className="text-[10px] text-slate-600">
        {modelLabel} · {routeText} · {modeLabel} mode
      </div>
    </div>
  )
})

// Video tile for the mini media feed: muted looping autoplay while on screen,
// paused when scrolled away (IntersectionObserver). The #t=0.001 fragment
// forces Safari to paint the first frame instead of a grey box — iOS renders
// nothing for preload="metadata" until user interaction otherwise.
// CSS approximations of the server's filter recipes (scaled by strength) —
// close twins for the live preview; Save bakes the exact sharp version
const FILTER_CSS: Record<string, (s: number) => string> = {
  noir: s => `grayscale(${s}) contrast(${1 + 0.18 * s}) brightness(${1 - 0.04 * s})`,
  bw: s => `grayscale(${s}) contrast(${1 + 0.3 * s})`,
  vivid: s => `saturate(${1 + 0.42 * s}) brightness(${1 + 0.02 * s})`,
  matte: s => `saturate(${1 - 0.1 * s}) brightness(${1 + 0.05 * s}) contrast(${1 - 0.1 * s})`,
  warm: s => `saturate(${1 + 0.08 * s}) sepia(${0.22 * s}) brightness(${1 + 0.03 * s})`,
  cool: s => `saturate(${1 + 0.05 * s}) hue-rotate(${10 * s}deg)`,
  vintage: s => `saturate(${1 - 0.28 * s}) sepia(${0.35 * s}) brightness(${1 + 0.02 * s}) contrast(${1 - 0.06 * s})`,
  golden: s => `saturate(${1 + 0.15 * s}) sepia(${0.3 * s}) brightness(${1 + 0.05 * s})`,
  dreamy: s => `brightness(${1 + 0.05 * s}) saturate(${1 + 0.05 * s}) contrast(${1 - 0.06 * s})`,
  cinematic: s => `saturate(${1 + 0.12 * s}) contrast(${1 + 0.1 * s}) hue-rotate(${-5 * s}deg)`,
}

// Deterministic procedural starfield — IDENTICAL algorithm to the server's
// computeStarfield in lib/chat-hub-agent.ts (keep byte-for-byte in sync, or
// the live preview drifts from the baked render)
type StarPrim =
  | { t: "c"; x: number; y: number; r: number; o: number }
  | { t: "l"; x1: number; y1: number; x2: number; y2: number; w: number; o: number }
function computeStarfieldClient(
  op: { density?: number; seed?: number; region?: { x: number; y: number; width: number; height: number } },
  w: number, h: number,
): StarPrim[] {
  const nn = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const rx = Math.max(0, Math.round(nn(op.region?.x, 0)))
  const ry = Math.max(0, Math.round(nn(op.region?.y, 0)))
  const rw = Math.max(1, Math.min(w - rx, Math.round(nn(op.region?.width, w))))
  const rh = Math.max(1, Math.min(h - ry, Math.round(nn(op.region?.height, h))))
  const density = Math.min(3, Math.max(0.2, nn(op.density, 1)))
  let a = (Math.round(nn(op.seed, 42)) >>> 0) || 42
  const rand = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const sc = Math.max(1, Math.min(w, h) / 1200)
  const count = Math.min(600, Math.round((rw * rh) / 6000 * density))
  const R = (v: number) => Math.round(v * 10) / 10
  const R2 = (v: number) => Math.round(v * 100) / 100
  const out: StarPrim[] = []
  for (let i = 0; i < count; i++) {
    const x = R(rx + rand() * rw), y = R(ry + rand() * rh)
    const k = rand()
    const r = R((k < 0.9 ? 0.5 + rand() * 1.1 : k < 0.98 ? 1.7 + rand() * 1.3 : 2.8 + rand() * 1.7) * sc)
    const o = R2(0.25 + rand() * 0.75)
    out.push({ t: "c", x, y, r, o })
    if (k >= 0.98) {
      out.push({ t: "c", x, y, r: R(r * 3), o: 0.1 })
      const f = R(r * 5)
      const fw = R(Math.max(0.8, r * 0.25))
      out.push({ t: "l", x1: R(x - f), y1: y, x2: R(x + f), y2: y, w: fw, o: R2(o * 0.5) })
      out.push({ t: "l", x1: x, y1: R(y - f), x2: x, y2: R(y + f), w: fw, o: R2(o * 0.5) })
    }
  }
  return out
}

// Overlay image with eraser strokes applied — drawn into a canvas with
// destination-out so the live preview matches the server's dest-out bake.
// Strokes are normalized (0..1) to the fitted overlay box.
const ErasedOverlay = memo(function ErasedOverlay({ src, w, h, erase, style, srcRect, flip }: {
  src: string; w: number; h: number
  erase: { size: number; opacity?: number; points: string }[]
  style: React.CSSProperties
  srcRect?: { sx: number; sy: number; sw: number; sh: number }
  flip?: "horizontal" | "vertical"
}) {
  const cvRef = useRef<HTMLCanvasElement | null>(null)
  const imgElRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const cv = cvRef.current
    const ctx = cv?.getContext("2d")
    if (!cv || !ctx) return
    const draw = (image: HTMLImageElement) => {
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = "source-over"
      ctx.save()
      if (flip === "horizontal") { ctx.translate(w, 0); ctx.scale(-1, 1) }
      else if (flip === "vertical") { ctx.translate(0, h); ctx.scale(1, -1) }
      if (srcRect) ctx.drawImage(image, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh, 0, 0, w, h)
      else ctx.drawImage(image, 0, 0, w, h)
      ctx.restore()
      ctx.globalCompositeOperation = "destination-out"
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      for (const s of erase) {
        const pts = String(s.points ?? "").trim().split(/\s+/)
          .map(p => p.split(",").map(Number))
          .filter(a => a.length === 2 && a.every(Number.isFinite))
        if (!pts.length) continue
        ctx.strokeStyle = `rgba(0,0,0,${Math.min(1, Math.max(0.05, s.opacity ?? 1))})`
        ctx.lineWidth = Math.max(1, (Number(s.size) || 0.05) * w)
        ctx.beginPath()
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h)
        if (pts.length === 1) ctx.lineTo(pts[0][0] * w + 0.01, pts[0][1] * h)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * w, pts[i][1] * h)
        ctx.stroke()
      }
    }
    const cached = imgElRef.current
    if (cached && cached.src === src && cached.complete && cached.naturalWidth) { draw(cached); return }
    const im = new window.Image()
    imgElRef.current = im
    im.onload = () => { if (imgElRef.current === im) draw(im) }
    im.src = src
  }, [src, w, h, erase, srcRect, flip])
  return <canvas ref={cvRef} width={w} height={h} className="absolute pointer-events-none" style={style} />
})

/**
 * What a still-rendering tile says it is doing.
 *
 * Everything used to read "Generating image", including video: a batch shot
 * from render_shots carries no `kind` on its step, so it fell through to the
 * image wording. The phrase is picked by a STABLE index (the placeholder's own
 * key), never at random — a label that reshuffles on every re-render is worse
 * than a dull one.
 */
const PLACEHOLDER_LABELS: Record<string, string[]> = {
  video: ["Rolling camera\u2026", "Shooting the take\u2026", "Generating video\u2026"],
  image: ["Generating image\u2026", "Painting the frame\u2026", "Composing the shot\u2026"],
  edit: ["Editing\u2026", "Working the layers\u2026"],
  film: ["Cutting the film\u2026", "Assembling the edit\u2026"],
  audio: ["Scoring\u2026", "Writing the music\u2026"],
}

function placeholderLabel(step: AgentStep): string {
  const bucket =
    step.tool === "edit_image" ? "edit"
    : step.tool === "assemble_film" ? "film"
    : step.tool === "create_audio" ? "audio"
    : (step.tool === "render_shots" || step.kind === "video") ? "video"
    : "image"
  const list = PLACEHOLDER_LABELS[bucket]
  // the "#N" suffix on a batch placeholder keeps each tile on its own phrase
  const n = Number(String(step.id).split("#")[1] ?? 0)
  return list[Math.abs(n) % list.length]
}

/**
 * The render hand-back the client posts when a batch of shots settles.
 *
 * It has to be a user turn for the model, but it is machinery, not the user
 * talking \u2014 shown in their own bubble it looked like the app was writing
 * messages on their behalf.
 */
/**
 * Does this step still owe shots?
 *
 * Keyed on the RESULTS, not on `status`. A render_shots step written with
 * status "done" while carrying nine queue ids used to be skipped by both the
 * poller and the settler, so the shots rendered at fal and never reached the
 * chat. A shot is outstanding until its own result lands.
 */
function shotsOutstanding(st: any): boolean {
  if (!st || st.status === "error" || st.status === "denied" || st.status === "superseded") return false
  if (Array.isArray(st.queueIds) && st.queueIds.length > 0) {
    const done = st.shotResults ?? {}
    return st.queueIds.some((q: number) => done[String(q)] === undefined)
  }
  return typeof st.queueId === "number" && !st.imageUrl
}

function isShotHandback(content: string | null | undefined): boolean {
  return typeof content === "string" && content.startsWith("[SHOTS SETTLED")
}

/** The status line, minus the instructions aimed at the model. */
function shotHandbackSummary(content: string): string {
  return content
    .split("\n")
    .filter(l => /^\[SHOTS SETTLED|^Shot queue #/.test(l.trim()))
    .join("\n")
    .replace(/^\[|\]$/gm, "")
    .trim() || "Shots settled."
}

const VideoTile = memo(function VideoTile({ src, className, onExpand, modelLabel }: { src: string; className?: string; onExpand?: () => void; modelLabel?: string | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) el.play().catch(() => {})
        else el.pause()
      }
    }, { threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const expand = (e: React.MouseEvent) => {
    e.stopPropagation()
    const el = ref.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void
      webkitSupportsFullscreen?: boolean
    }) | null
    // iPad: the video element owns fullscreen, not the page
    if (el?.webkitSupportsFullscreen && typeof el.webkitEnterFullscreen === 'function') {
      el.webkitEnterFullscreen()
      return
    }
    if (el?.requestFullscreen) { void el.requestFullscreen().catch(() => onExpand?.()); return }
    onExpand?.()
  }
  return (
    <div className={`relative group/vid ${className ?? ''}`}>
      <video
        ref={ref}
        src={`${src}#t=0.001`}
        muted
        loop
        autoPlay
        playsInline
        controls
        preload="metadata"
        className="w-full h-auto block rounded-[inherit]"
      />
      <button
        onClick={expand}
        title="View fullscreen"
        aria-label="View fullscreen"
        className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-md bg-black/60 border border-white/15 text-white/90 hover:bg-black/80 hover:text-white transition-colors"
      >
        <Maximize2 size={13} />
      </button>
      {/* Which engine shot this. A film mixes models per shot by design, so
          "why does that one look different" is answerable at a glance. Sits
          bottom-left, clear of the fullscreen button and the scrub bar. */}
      {modelLabel && (
        <span
          className="absolute bottom-9 left-1.5 z-10 px-1.5 py-0.5 rounded-md bg-black/65 border border-white/10 text-[9px] font-medium tracking-wide text-white/85 pointer-events-none max-w-[calc(100%-1rem)] truncate"
          title={`Rendered with ${modelLabel}`}
        >
          {modelLabel}
        </span>
      )}
    </div>
  )
})

// Memoized markdown block: the parsed HTML is cached per text and the DOM node
// is never re-written on unrelated re-renders (streaming ticks, polls, parent
// refreshes) — re-setting innerHTML made embedded media re-request and flash.
const MarkdownBlock = memo(function MarkdownBlock({ text, px }: { text: string; px: number }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      style={{ fontSize: px }}
      className="chat-md leading-relaxed text-slate-200 break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

export default function ChatHub({
  activeRefs = [],
  onRemoveRef,
  onUploadRefs,
  onAddRefUrl,
  onRefCapChange,
  onOpenMedia,
  actionRequest,
}: {
  activeRefs?: ChatRef[]
  onRemoveRef?: (id: string) => void
  onUploadRefs?: (files: File[]) => Promise<{ added: number; failed: number; limitHit: boolean }>
  // Save a generated image URL into the user's reference library
  onAddRefUrl?: (url: string) => Promise<{ added: number; failed: number; limitHit: boolean }>
  // Reports the current model's ref limit up to the taskbar Refs dropdown so
  // activation there is capped exactly like the image/video scanners
  onRefCapChange?: (cap: number) => void
  // Open media in the parent's editor modal (preferred over the built-in
  // fallback viewer). recipe carries the edit_image chain that produced the
  // image so the parent can decompose it into editable layers.
  onOpenMedia?: (info: { url: string; prompt?: string; modelId?: string | null; settings?: Record<string, string>; cost?: number; recipe?: { image_url?: string; canvas?: { width: number; height: number; color?: string }; operations: unknown[] } | null }) => void
  // Actions coming back from that modal: Edit (send prompt + image into the
  // chat) or Use Prompt (fill the composer)
  actionRequest?: { kind: "edit" | "useprompt"; text: string; url?: string; nonce: number } | null
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [looseChats, setLooseChats] = useState<ChatSummary[]>([])
  const [sidebarLoaded, setSidebarLoaded] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [moveMenuChatId, setMoveMenuChatId] = useState<number | null>(null)

  // Sidebar collapse persists across visits; phones always start closed
  // (the drawer overlays the whole chat there)
  useEffect(() => {
    try {
      if (window.innerWidth < 640 || localStorage.getItem("chat-hub-sidebar") === "closed") {
        setSidebarOpen(false)
      }
    } catch {}
  }, [])

  const closeSidebarOnMobile = () => {
    if (typeof window !== "undefined" && window.innerWidth < 640) setSidebarOpen(false)
  }
  const toggleSidebar = () => {
    setSidebarOpen(o => {
      try { localStorage.setItem("chat-hub-sidebar", o ? "closed" : "open") } catch {}
      return !o
    })
  }

  const [activeChatId, setActiveChatId] = useState<number | null>(null)
  const [activeChatTitle, setActiveChatTitle] = useState("")
  const [messages, setMessages] = useState<Msg[]>([])
  const [chatLoading, setChatLoading] = useState(false)

  const [model, setModel] = useState(DEFAULT_CHAT_MODEL)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  // Per-chat enabled skills (null = all = Full Studio / legacy)
  const [chatSkills, setChatSkills] = useState<string[] | null>(null)
  const [movieFormat, setMovieFormatState] = useState<string>(DEFAULT_MOVIE_FORMAT)
  const patchChatSkills = (next: string[] | null) => {
    setChatSkills(next)
    if (activeChatId) {
      fetch(`/api/chat-hub/chats/${activeChatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills: next }),
      }).catch(() => {})
    }
  }
  const toggleSkill = (id: string) => {
    const base = chatSkills ?? [...ALL_SKILL_IDS]
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id]
    patchChatSkills(next.length === ALL_SKILL_IDS.length ? null : next)
  }

  // Per-chat agent permission mode (plan / accept="Ask" / approved="Auto")
  const [agentMode, setAgentModeState] = useState<AgentMode>("accept")
  const setAgentMode = (mode: AgentMode) => {
    setAgentModeState(mode)
    if (activeChatId) {
      fetch(`/api/chat-hub/chats/${activeChatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentMode: mode }),
      }).catch(() => {})
    }
  }

  // User-added custom gateway models (Profile → Chat Settings → Agent)
  const [customModels, setCustomModels] = useState<CustomChatModel[]>([])
  // Locally-served Ollama models (synced in Chat Settings → Providers)
  const [ollamaModels, setOllamaModels] = useState<{ id: string; label: string }[]>([])
  // Rented-GPU RunPod models (synced in Chat Settings → Providers)
  const [runpodModels, setRunpodModels] = useState<{ id: string; label: string }[]>([])
  // OpenRouter models (added in Chat Settings → Providers)
  const [openrouterModels, setOpenrouterModels] = useState<{ id: string; label: string }[]>([])
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && Array.isArray(detail.customModels)) setCustomModels(detail.customModels)
      if (detail && Array.isArray(detail.ollamaModels)) setOllamaModels(detail.ollamaModels)
      if (detail && Array.isArray(detail.runpodModels)) setRunpodModels(detail.runpodModels)
      if (detail && Array.isArray(detail.openrouterModels)) setOpenrouterModels(detail.openrouterModels)
    }
    window.addEventListener("chat-hub-agent-settings-changed", onChange)
    return () => window.removeEventListener("chat-hub-agent-settings-changed", onChange)
  }, [])
  const labelFor = (id: string | null | undefined): string => {
    if (!id) return ""
    return CHAT_HUB_MODELS.find(m => m.id === id)?.label
      ?? customModels.find(m => m.id === id)?.label
      ?? openrouterModels.find(m => m.id === id)?.label
      ?? runpodModels.find(m => m.id === id)?.label
      ?? ollamaModels.find(m => m.id === id)?.label
      ?? modelLabel(id)
  }

  // Per-provider routing: Vercel AI Hub vs the provider's own API key.
  // The controls live in the taskbar Profile dropdown (Chat Settings) —
  // changes arrive here via localStorage + a custom event.
  const [routing, setRouting] = useState<RoutingMap>(DEFAULT_ROUTING)

  useEffect(() => {
    setRouting(readRoutingFromStorage())
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && typeof detail === "object") setRouting(prev => ({ ...prev, ...detail }))
    }
    window.addEventListener(ROUTING_EVENT, onChange)
    return () => window.removeEventListener(ROUTING_EVENT, onChange)
  }, [])

  // Layout preferences (width / text size) — set in Profile → Chat Settings
  const [layout, setLayout] = useState<ChatLayout>(DEFAULT_LAYOUT)
  useEffect(() => {
    setLayout(readLayoutFromStorage())
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && typeof detail === "object") setLayout(prev => ({ ...prev, ...detail }))
    }
    window.addEventListener(LAYOUT_EVENT, onChange)
    return () => window.removeEventListener(LAYOUT_EVENT, onChange)
  }, [])
  const chatTextPx = CHAT_TEXT_PX[layout.textSize]
  const chatWidthClass = layout.width === "wide" ? "max-w-none" : "max-w-3xl"
  // Floating (Higgsfield/Claude) style: replies and steps float on the
  // background — no card boxes, slim rows with expand chevrons
  const floating = layout.style === "floating"

  // ── Composer drafts, per chat, on the account ────────────────────────────
  // An unsent message is work the user did. Losing it to a refresh (or to
  // opening the chat on another device) is the same class of bug as losing a
  // generation: it lived only in React state. Drafts live in
  // portalPreferences.chatHubDrafts, keyed by chat id, so they survive a
  // reload and follow the account.
  const draftsRef = useRef<Record<string, string>>({})
  const draftsLoadedRef = useRef(false)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Key for the chat being composed into — "new" before a chat exists. */
  const draftKey = useCallback(
    (id: number | null) => (typeof id === "number" && id > 0 ? String(id) : "new"),
    [],
  )

  /**
   * Write the draft map back. Debounced, because this fires on every keystroke
   * and portalPreferences is a whole-row JSON update. Empty drafts are dropped
   * and the map is capped so a year of chats cannot grow the column unbounded.
   */
  const persistDrafts = useCallback((immediate = false) => {
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    const write = () => {
      const entries = Object.entries(draftsRef.current)
        .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
        .slice(-40)
      const next = Object.fromEntries(entries)
      draftsRef.current = next
      fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatHubDrafts: next }),
      }).catch(() => {})
    }
    if (immediate) write()
    else draftSaveTimer.current = setTimeout(write, 900)
  }, [])

  /** The message left the composer — drop its draft immediately. */
  const clearDraft = useCallback((id: number | null) => {
    delete draftsRef.current[draftKey(id)]
    persistDrafts(true)
  }, [draftKey, persistDrafts])

  /** Record what is in the composer for a chat, then schedule a save. */
  const noteDraft = useCallback((id: number | null, text: string) => {
    if (!draftsLoadedRef.current) return // don't overwrite before the load lands
    const k = draftKey(id)
    if (text.trim()) draftsRef.current[k] = text
    else delete draftsRef.current[k]
    persistDrafts()
  }, [draftKey, persistDrafts])

  // Two holes the debounce leaves open:
  //  - a refresh inside the 900ms window loses the last keystrokes, which is
  //    exactly the case this feature exists for, so flush on the way out;
  //  - another device may have edited the draft since this tab loaded, so
  //    re-read when the tab comes back rather than trusting stale state.
  useEffect(() => {
    const flush = () => {
      if (!draftsLoadedRef.current) return
      const typed = inputRef.current?.value ?? ""
      const k = draftKey(activeChatIdRef.current)
      if (typed.trim()) draftsRef.current[k] = typed
      else delete draftsRef.current[k]
      const body = JSON.stringify({ chatHubDrafts: draftsRef.current })
      // keepalive: a normal fetch is cancelled when the page goes away
      try {
        fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {})
      } catch {}
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { flush(); return }
      // Back in view — pick up a draft written on another device
      fetch("/api/user/preferences", { cache: "no-store" })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          const drafts = d?.preferences?.chatHubDrafts
          if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return
          draftsRef.current = Object.fromEntries(
            Object.entries(drafts as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
              .map(([k, v]) => [k, v as string]),
          )
          const mine = draftsRef.current[draftKey(activeChatIdRef.current)] ?? ""
          // Only adopt the remote draft when this tab's box is empty — never
          // overwrite something the user is in the middle of typing here.
          setInput(prev => (prev.trim() ? prev : mine))
        })
        .catch(() => {})
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [draftKey])

  // Load saved personas + custom models from account preferences
  useEffect(() => {
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const raw = d?.preferences?.chatHubPersonas
        if (Array.isArray(raw)) {
          setPersonas(raw.filter((p: any) =>
            p && typeof p.id === "string" && typeof p.name === "string" && typeof p.text === "string"
          ).map((p: any) => ({
            id: p.id, name: p.name, text: p.text,
            modelId: typeof p.modelId === "string" ? p.modelId : null,
            skills: Array.isArray(p.skills) ? p.skills.filter((s: any) => typeof s === "string" && ALL_SKILL_IDS.includes(s)) : null,
            emoji: typeof p.emoji === "string" ? p.emoji.slice(0, 4) : null,
            agentMode: p.agentMode === "plan" || p.agentMode === "accept" || p.agentMode === "approved" ? p.agentMode : null,
          })))
        }
        const de = d?.preferences?.chatHubDefaultEmployee
        setDefaultEmployeeId(typeof de === "string" && de ? de : null)
        const mf = d?.preferences?.chatHubMovieFormat
        if (typeof mf === "string" && MOVIE_FORMATS.some(f => f.id === mf)) setMovieFormatState(mf)
        // Unsent composer text, per chat. Restore the one for whatever chat is
        // open (or the "new chat" draft when none is).
        const drafts = d?.preferences?.chatHubDrafts
        if (drafts && typeof drafts === "object" && !Array.isArray(drafts)) {
          draftsRef.current = Object.fromEntries(
            Object.entries(drafts as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
              .map(([k, v]) => [k, v as string]),
          )
        }
        draftsLoadedRef.current = true
        const mine = draftsRef.current[draftKey(activeChatIdRef.current)]
        // Never clobber something typed while this request was in flight
        if (mine) setInput(prev => (prev.trim() ? prev : mine))
        const customs = d?.preferences?.chatHubCustomModels
        if (Array.isArray(customs)) {
          setCustomModels(customs.filter((m: any) =>
            m && typeof m.id === "string" && typeof m.label === "string" && CUSTOM_MODEL_ID_RE.test(m.id)))
        }
        const oll = d?.preferences?.chatHubOllamaModels
        if (Array.isArray(oll)) {
          setOllamaModels(oll.filter((m: any) =>
            m && typeof m.id === "string" && m.id.startsWith("ollama/") && typeof m.label === "string"))
        }
        const rp = d?.preferences?.chatHubRunpodModels
        if (Array.isArray(rp)) {
          setRunpodModels(rp.filter((m: any) =>
            m && typeof m.id === "string" && m.id.startsWith("runpod/") && typeof m.label === "string"))
        }
        const or = d?.preferences?.chatHubOpenrouterModels
        if (Array.isArray(or)) {
          setOpenrouterModels(or.filter((m: any) =>
            m && typeof m.id === "string" && m.id.startsWith("openrouter/") && typeof m.label === "string"))
        }
        // Routing is authoritative in account preferences — Safari evicts
        // localStorage on LAN-IP origins, silently resetting routes to Hub
        const rt = d?.preferences?.chatHubRouting
        if (rt && typeof rt === "object") {
          const next = { ...DEFAULT_ROUTING }
          for (const p of CHAT_HUB_PROVIDERS) {
            if (rt[p] === "gateway" || rt[p] === "direct") next[p] = rt[p]
          }
          setRouting(next)
          try { localStorage.setItem(ROUTING_LS_KEY, JSON.stringify(next)) } catch {}
        }
      })
      .catch(() => {})
  }, [])

  const persistDefaultEmployee = (id: string | null) => {
    setDefaultEmployeeId(id)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubDefaultEmployee: id }),
    }).catch(() => {})
  }

  const persistPersonas = (next: Persona[]) => {
    setPersonas(next)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubPersonas: next }),
    }).catch(() => {})
  }

  const saveChatInstructions = async (text: string) => {
    if (!activeChatId) return
    const res = await fetch(`/api/chat-hub/chats/${activeChatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: text }),
    })
    if (!res.ok) { await apiError(res, "Saving instructions"); return }
    setSpSaved(text.trim())
  }

  // Employee editor (create / edit a user employee)
  type EmpDraft = {
    id: string | null
    name: string
    emoji: string
    text: string
    skills: string[]
    modelId: string
    agentMode: "" | AgentMode
  }
  const [empDraft, setEmpDraft] = useState<EmpDraft | null>(null)

  const saveEmployee = () => {
    if (!empDraft || !empDraft.name.trim() || !empDraft.text.trim()) return
    const entry: Persona = {
      id: empDraft.id ?? newPersonaId(),
      name: empDraft.name.trim().slice(0, 40),
      text: empDraft.text.slice(0, 4000),
      modelId: empDraft.modelId || null,
      skills: empDraft.skills.length === ALL_SKILL_IDS.length ? null : empDraft.skills,
      emoji: empDraft.emoji.trim().slice(0, 4) || null,
      agentMode: empDraft.agentMode || null,
    }
    const rest = personas.filter(p => p.id !== entry.id)
    if (!empDraft.id && rest.length >= MAX_PERSONAS) return
    persistPersonas([entry, ...rest])
    setEmpDraft(null)
  }

  // Apply an employee/preset: instructions text + skill set in one PATCH
  const applyEmployee = (text: string, skills: string[] | null) => {
    setSpDraft(text)
    setSpSaved(text.trim())
    setChatSkills(skills)
    if (activeChatId) {
      fetch(`/api/chat-hub/chats/${activeChatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: text, skills }),
      }).catch(() => {})
    }
  }

  const applyPersona = (p: Persona) => {
    applyEmployee(p.text, p.skills && p.skills.length ? p.skills : null)
    if (p.modelId && (CHAT_HUB_MODELS.some(m => m.id === p.modelId) || customModels.some(m => m.id === p.modelId))) {
      setModel(p.modelId)
    }
    if (p.agentMode) setAgentMode(p.agentMode)
  }

  const routeForModel = (modelId: string): ChatHubRoute => {
    const provider = CHAT_HUB_MODELS.find(m => m.id === modelId)?.provider
    return provider ? routing[provider] : "gateway" // customs are gateway-only
  }

  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  // Per-call approve/deny choices in the pinned approval bar (default approve)
  const [approvalChoices, setApprovalChoices] = useState<Record<string, boolean>>({})
  // Per-call media settings overrides edited in the approval bar
  const [approvalSettings, setApprovalSettings] = useState<Record<string, Record<string, string>>>({})

  // Message queueing during approvals (Chat Settings → Agent). When ON, a new
  // message typed while a tool approval is pending waits its turn instead of
  // auto-denying the request.
  const [queueMode, setQueueMode] = useState(false)
  const [queued, setQueued] = useState<{ content: string; extraImages: string[] }[]>([])
  useEffect(() => {
    try { setQueueMode(localStorage.getItem("chat-hub-queue-mode") === "on") } catch {}
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (d && typeof d.queueMode === "boolean") setQueueMode(d.queueMode)
    }
    window.addEventListener("chat-hub-agent-settings-changed", onChange)
    return () => window.removeEventListener("chat-hub-agent-settings-changed", onChange)
  }, [])

  // Retry an assistant reply with a different model
  const [retryMenuMsgId, setRetryMenuMsgId] = useState<number | string | null>(null)

  // Run stopwatch: counts the orchestrator's active runtime, resuming from the
  // persisted total across approval rounds (pauses while waiting on the user)
  const [runElapsedMs, setRunElapsedMs] = useState(0)
  const runBaseRef = useRef(0)      // runtime accumulated in earlier rounds
  const runStartRef = useRef(0)     // wall-clock start of the current stream

  // Sidebar chat search (filters the CHATS feed by title / model / project)
  const [chatSearch, setChatSearch] = useState("")

  // ask_user quiz selections in the approval bar:
  // toolCallId → question index → selected option indexes
  const [quizAnswers, setQuizAnswers] = useState<Record<string, Record<number, number[]>>>({})
  // Plan-approval edits: adjustable ticket budget + free-text tweaks
  const [planEdits, setPlanEdits] = useState<Record<string, { budget: string; note: string }>>({})

  // Chats with a run in flight (client stream, background continuation, or
  // reconnect poll) — sidebar rows show a pulsing indicator
  const [runningChats, setRunningChats] = useState<Set<number>>(new Set())
  const markRunning = useCallback((id: number, on: boolean) => {
    setRunningChats(prev => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Background sweep: chats that kept generating server-side after we
  // navigated away — clear their indicator once the reply has landed
  useEffect(() => {
    if (runningChats.size === 0) return
    const t = setInterval(async () => {
      for (const id of runningChats) {
        if (id === activeChatIdRef.current && streaming) continue
        try {
          const r = await fetch(`/api/chat-hub/chats/${id}`, { cache: "no-store" })
          if (!r.ok) continue
          const d = await r.json()
          const rows: any[] = d.messages ?? []
          const last = rows[rows.length - 1]
          if (!last || last.role === "assistant") {
            markRunning(id, false)
            loadSidebar()
            if (activeChatIdRef.current === id) reloadMessages(id)
          }
        } catch {}
      }
    }, 8000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningChats, streaming])

  // Batches already handed back, so a re-run of the poll cannot send twice.
  const continuedRef = useRef<Set<string>>(new Set())

  // A film that has all its footage and no run in flight must be picked back
  // up, whatever happened earlier.
  //
  // The hand-back used to be sent only on the exact poll tick where the last
  // shot settled. Miss that tick \u2014 the page was closed, another poll marked
  // the run finished first, the settle happened server-side \u2014 and the film
  // sat there with every shot rendered and nothing to assemble it. This checks
  // the STATE instead of the moment: shots all landed, nothing pending, no
  // assembly yet, so resume.
  useEffect(() => {
    if (!activeChatId || streaming) return
    if (messages.some(m => m.pendingApproval?.calls?.length)) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant") return

    // Every shot this film submitted, and whether its result has landed
    let submitted = 0
    let landed = 0
    let assembled = false
    for (const m of messages) {
      for (const st of (m.agentSteps ?? []) as any[]) {
        if (st?.tool === "assemble_film" && st.status === "done") assembled = true
        if (Array.isArray(st?.queueIds)) {
          const res = st.shotResults ?? {}
          for (const q of st.queueIds) {
            submitted++
            if (res[String(q)] !== undefined) landed++
          }
        }
      }
    }
    if (assembled || submitted === 0 || landed < submitted) return

    const key = `resume:${activeChatId}:${last.id}:${landed}`
    if (continuedRef.current.has(key)) return
    continuedRef.current.add(key)
    void sendMessage(
      activeChatId,
      "[SHOTS SETTLED \u2014 all " + landed + " rendered]"
      + String.fromCharCode(10)
      + "Every shot you submitted has finished and the footage is in this conversation. "
      + "Continue the production: check the shots, judge them from their frames, then ASSEMBLE the film "
      + "with assemble_film and score it. Do not stop here and do not re-submit shots that already rendered \u2014 "
      + "the remaining work is the cut itself.",
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, messages, streaming])

  // Shots submitted to the render queue outlive the turn that ordered them:
  // create_media returns a queue id and the reply finishes while fal is still
  // working. Poll until every shot in the newest reply has settled, then
  // refresh so the finished clips appear in the reply that ordered them.
  // Server-side state, so this survives a reload or a second device.
  useEffect(() => {
    if (!activeChatId || streaming) return
    // render_shots submits a BATCH and stores queueIds; a single video stores
    // queueId. Watching only the singular field meant a batch-rendered film
    // never started polling, so the shots never came back into the chat.
    const hasPendingShots = messages.some(m =>
      (m.agentSteps ?? []).some((st: any) => shotsOutstanding(st)))
    if (!hasPendingShots) return
    // NEVER auto-continue while an approval is on screen. A reply that paused
    // for approval has emitted tool calls the model still owes results for;
    // injecting a user message in front of them breaks the message sequence
    // outright ("the messages do not match the ModelMessage[] schema") and
    // steals a decision that belongs to the user. Wait for them to answer.
    if (messages.some(m => m.pendingApproval?.calls?.length)) return

    let stop = false
    const tick = async () => {
      try {
        const r = await fetch(`/api/chat-hub/chats/${activeChatId}/film-status`, { cache: "no-store" })
        if (!r.ok || stop) return
        const d = await r.json()
        // Only re-read the thread when something actually changed
        const settledNow = Array.isArray(d.shots)
          && d.shots.some((x: any) => x.status === "completed" || x.status === "failed")
        if (settledNow) reloadMessages(activeChatId)

        if (d.done) {
          stop = true
          // One continuation per settled batch. The effect re-runs whenever
          // `messages` changes, so without this a second poll could fire the
          // same hand-back again and the user watches messages they did not
          // write pile up in their own thread.
          const sentKey = `${activeChatId}:${(d.shots ?? []).map((x: any) => x.queueId).join(",")}`
          if (continuedRef.current.has(sentKey)) return
          continuedRef.current.add(sentKey)
          // The run paused because the renders outlive the request, not because
          // the work is finished. Hand the results back so the employee judges
          // the frames, cuts the film and scores it — the user asked for a
          // movie, not a pile of clips.
          // Two steps can carry the same queue id (a re-submitted shot list),
          // and reporting a shot twice made the employee think it had twice the
          // footage it does. One line per shot, first status wins.
          const seenShot = new Set<number>()
          const uniq = (d.shots ?? []).filter((x: any) => {
            if (seenShot.has(x.queueId)) return false
            seenShot.add(x.queueId); return true
          })
          const ok = uniq.filter((x: any) => x.status === "completed")
          const bad = uniq.filter((x: any) => x.status === "failed")
          // A stalled shot is not a failure to retry blindly — it is a render
          // that never came back. The cut proceeds without it, and the employee
          // has to say so rather than quietly delivering a short film.
          const stalled = uniq.filter((x: any) => x.status === "stalled")
          if (ok.length || bad.length || stalled.length) {
            const trouble = bad.length + stalled.length
            const lines = [
              `[SHOTS SETTLED — ${ok.length} rendered${trouble ? `, ${trouble} missing` : ""}]`,
              ...ok.map((x: any) => `Shot queue #${x.queueId}: ready`),
              ...bad.map((x: any) => `Shot queue #${x.queueId}: FAILED — ${x.error ?? "unknown"}`),
              ...stalled.map((x: any) => `Shot queue #${x.queueId}: NEVER RETURNED — still rendering long past the expected time`),
              trouble
                ? "Assemble the film from the shots that DID land, then tell the user plainly which shot numbers are missing and offer to re-render them. Do not silently deliver a short cut."
                : "Call check_shots on these ids, judge each shot from its frames, then assemble and score the film.",
            ]
            void sendMessage(activeChatId, lines.join(String.fromCharCode(10)))
          }
        }
      } catch {}
    }
    void tick()
    const t = setInterval(() => { if (!stop) void tick(); else clearInterval(t) }, 8000)
    return () => { stop = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, messages, streaming])

  // Reconnect-after-reload: a send's stream dies with the page, but the server
  // keeps generating and persists the reply. When a chat opens with a user
  // message as its last row, poll until the assistant row lands.
  const [awaitingReply, setAwaitingReply] = useState(false)
  const awaitPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopAwaitPoll = useCallback(() => {
    if (awaitPollRef.current) { clearInterval(awaitPollRef.current); awaitPollRef.current = null }
    setAwaitingReply(false)
  }, [])

  // Run stopwatch tick: during live streams AND poll-rendered runs
  // (awaitingReply) — a stalled stream falling back to the liveRun poll (slow
  // local models can sit silent for minutes) must not stop the clock
  useEffect(() => {
    if (!streaming && !awaitingReply) return
    const t = setInterval(() => {
      setRunElapsedMs(runBaseRef.current + (Date.now() - runStartRef.current))
    }, 1000)
    return () => clearInterval(t)
  }, [streaming, awaitingReply])
  useEffect(() => () => { if (awaitPollRef.current) clearInterval(awaitPollRef.current) }, [])

  // Right-click (desktop) / tap (touch) menu on the user's own messages
  // (Copy · Retry). Tap tracking guards against scroll-drags registering as taps.
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; content: string; imageUrls: string[] } | null>(null)
  const msgTapRef = useRef<{ x: number; y: number } | null>(null)
  const openMsgMenu = (x: number, y: number, m: Msg) => {
    setMsgMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 180)),
      y: Math.max(8, Math.min(y, window.innerHeight - 110)),
      content: m.content ?? "",
      imageUrls: (m.imageUrls ?? []).filter(u => u.startsWith("https://")),
    })
  }
  // navigator.clipboard needs a secure context — LAN-IP http gets the
  // hidden-textarea fallback
  const copyToClipboard = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true } catch {}
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }

  // Lightbox for generated media / reference images
  const [mediaViewer, setMediaViewer] = useState<MediaViewerState | null>(null)
  const [viewerZoom, setViewerZoom] = useState(1)
  // Full view: the image takes the ENTIRE popup — all chrome hidden, toggled
  // back via the floating eye button (mirrors the portal feed modal)
  const [viewerFull, setViewerFull] = useState(false)

  // Escape closes the media viewer. The header is a wrapping flex row, so on a
  // narrow tablet the X can end up somewhere awkward, and a viewer that cannot
  // be dismissed forces a page reload — which is how a mid-run generation got
  // lost. A keyboard escape hatch costs nothing and always works.
  useEffect(() => {
    if (!mediaViewer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMediaViewer(null); setViewerFull(false) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mediaViewer])

  const [viewerPanel, setViewerPanel] = useState<"left" | "right" | "bottom" | "hidden">("right")
  const [addRefState, setAddRefState] = useState<"idle" | "saving" | "done" | "error">("idle")
  // "Edit" from the media viewer arms the composer instead of an inline prompt:
  // the next message you send edits this image/canvas. recipeJson is the layer
  // recipe snapshot (null = plain image edit). Removable via the composer chip.
  const [pendingEdit, setPendingEdit] = useState<{ url: string; recipeJson: string | null; isVideo: boolean } | null>(null)

  useEffect(() => {
    try {
      const v = localStorage.getItem("chat-hub-viewer-panel")
      // "hidden" retired — the eye's Full View replaced it; map old prefs to right
      if (v === "left" || v === "right" || v === "bottom") setViewerPanel(v)
    } catch {}
  }, [])
  const setPanel = (p: "left" | "right" | "bottom" | "hidden") => {
    setViewerPanel(p)
    try { localStorage.setItem("chat-hub-viewer-panel", p) } catch {}
  }
  // ── Layer editor (edit_image recipes) ──────────────────────────────────
  const [layerOps, setLayerOps] = useState<any[]>([])
  const [layerDisabled, setLayerDisabled] = useState<Set<number>>(new Set())
  const [layerSel, setLayerSel] = useState<number | null>(null)
  const [layerBusy, setLayerBusy] = useState(false)
  const [layerErr, setLayerErr] = useState<string | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)

  // A run starting while the layer editor is open would let an edit be applied
  // into a reply the run is still writing. Shut it, leaving the image visible.
  useEffect(() => {
    if (streaming && layersOpen) setLayersOpen(false)
  }, [streaming, layersOpen])

  // Cursor tool for the layer editor: select (move/resize), brush (paint color
  // onto the selected layer), erase (knock pixels out of the selected layer)
  const [cursorMode, setCursorMode] = useState<"select" | "brush" | "erase">("select")
  const [brushSize, setBrushSize] = useState(48)      // px, final-canvas space
  const [brushOpacity, setBrushOpacity] = useState(1) // 0.05..1
  const [brushColor, setBrushColor] = useState("#ffffff")
  const paintMode = cursorMode === "brush" || cursorMode === "erase"
  const layerErasable = (o: any) => o && (o.op === "overlay" || o.op === "text" || o.op === "shape")
  const viewerImgRef = useRef<HTMLImageElement | null>(null)

  // ── Undo / redo: snapshots of layerOps — one step per canvas gesture,
  // coalesced for rapid typed edits. Cleared on open and on Save (Save
  // becomes the new baseline).
  const [layerPast, setLayerPast] = useState<any[][]>([])
  const [layerFuture, setLayerFuture] = useState<any[][]>([])
  const histKeyRef = useRef<{ key: string | null; at: number }>({ key: null, at: 0 })
  const pushHistory = (coalesceKey?: string) => {
    const now = Date.now()
    if (coalesceKey && histKeyRef.current.key === coalesceKey && now - histKeyRef.current.at < 900) {
      histKeyRef.current.at = now
      return
    }
    histKeyRef.current = { key: coalesceKey ?? null, at: now }
    const snap = layerOps.map(o => ({ ...o }))
    setLayerPast(p => [...p.slice(-49), snap])
    setLayerFuture([])
  }
  const undoLayers = () => {
    if (!layerPast.length) return
    const prev = layerPast[layerPast.length - 1]
    setLayerFuture(f => [...f, layerOps.map(o => ({ ...o }))])
    setLayerOps(prev.map(o => ({ ...o })))
    setLayerPast(p => p.slice(0, -1))
    setLayerSel(s => (s != null && s < prev.length ? s : null))
    histKeyRef.current = { key: null, at: 0 }
  }
  const redoLayers = () => {
    if (!layerFuture.length) return
    const next = layerFuture[layerFuture.length - 1]
    setLayerPast(p => [...p, layerOps.map(o => ({ ...o }))])
    setLayerOps(next.map(o => ({ ...o })))
    setLayerFuture(f => f.slice(0, -1))
    setLayerSel(s => (s != null && s < next.length ? s : null))
    histKeyRef.current = { key: null, at: 0 }
  }
  useEffect(() => {
    if (!layersOpen) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redoLayers(); else undoLayers()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault()
        redoLayers()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layersOpen, layerPast, layerFuture, layerOps])

  const patchLayer = (i: number, patch: Record<string, any>) => {
    pushHistory(`field:${i}:${Object.keys(patch).join(",")}`)
    setLayerOps(prev => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  }

  const layerLabel = (o: any) =>
    o.op === "text" ? `text “${String(o.text ?? "").slice(0, 16)}${String(o.text ?? "").length > 16 ? "…" : ""}”`
    : o.op === "shape" ? `shape · ${o.shape}`
    : o.op === "overlay" ? "overlay image"
    : o.op === "silhouette" ? "silhouette"
    : o.op === "starfield" ? "starfield"
    : o.op === "filter" ? `filter · ${o.name ?? ""}`
    : String(o.op)

  // Spatial ops can be selected/moved/resized directly on the canvas
  const layerSpatial = (o: any) =>
    o && (o.op === "text" || o.op === "overlay" || o.op === "region_blur" || o.op === "shape")

  // ── Interactive canvas: tap to select, drag to move, pinch/handle to resize ──
  // Displayed-image geometry (position inside its wrapper + natural px) so the
  // selection overlay can map canvas coordinates ↔ screen coordinates
  const [imgBox, setImgBox] = useState<{ left: number; top: number; w: number; h: number; natW: number; natH: number } | null>(null)
  const measureViewerImg = useCallback(() => {
    const img = viewerImgRef.current
    if (!img || !img.naturalWidth || !img.clientWidth) { setImgBox(null); return }
    setImgBox({
      left: img.offsetLeft, top: img.offsetTop,
      w: img.clientWidth, h: img.clientHeight,
      natW: img.naturalWidth, natH: img.naturalHeight,
    })
  }, [])
  useEffect(() => {
    if (!mediaViewer || mediaViewer.isVideo || viewerZoom !== 1 || !layersOpen) return
    measureViewerImg()
    const img = viewerImgRef.current
    if (!img || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measureViewerImg)
    ro.observe(img)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaViewer?.url, mediaViewer?.isVideo, viewerZoom, layersOpen, viewerPanel, measureViewerImg])

  // Natural dims of overlay images (keyed by URL) — needed to mirror the
  // server's overlay AUTO-FIT (resize to op.width → shrink to fit canvas →
  // clamp position inside it) in the live preview and selection boxes
  const [ovlNat, setOvlNat] = useState<Record<string, { w: number; h: number }>>({})
  const fitOverlay = (o: any, cw: number, ch: number): { x: number; y: number; w: number; h: number; sx: number; sy: number; sw: number; sh: number } | null => {
    const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const nat = ovlNat[String(o.image_url ?? "")]
    if (!nat || !nat.w) return null
    // Source rect: op.crop trims the overlay source before placement
    let sx = 0, sy = 0, sw = nat.w, sh = nat.h
    if (o.crop && typeof o.crop === "object") {
      sx = Math.min(nat.w - 1, Math.max(0, Math.round(n(o.crop.x))))
      sy = Math.min(nat.h - 1, Math.max(0, Math.round(n(o.crop.y))))
      sw = Math.max(1, Math.min(nat.w - sx, Math.round(n(o.crop.width, nat.w))))
      sh = Math.max(1, Math.min(nat.h - sy, Math.round(n(o.crop.height, nat.h))))
    }
    const hasW = n(o.width, 0) > 0
    let ow = hasW ? Math.round(n(o.width)) : sw
    let oh = n(o.height, 0) > 0 ? Math.round(n(o.height)) : Math.max(1, Math.round(ow * (sh / sw)))
    // Server parity: auto-shrink only when width was NOT given explicitly
    if (!hasW && (ow > cw || oh > ch)) {
      const k = Math.min(cw / ow, ch / oh)
      ow = Math.max(1, Math.round(ow * k))
      oh = Math.max(1, Math.round(oh * k))
    }
    // NO position clamp — off-canvas placement crops at the canvas edge
    return { x: Math.round(n(o.x)), y: Math.round(n(o.y)), w: ow, h: oh, sx, sy, sw, sh }
  }

  const parsePoly = (s: any): number[][] =>
    String(s ?? "").trim().split(/\s+/).map(p => p.split(",").map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite))
  const fmtPoly = (pts: number[][]) => pts.map(p => `${Math.round(p[0])},${Math.round(p[1])}`).join(" ")

  // Estimated canvas-space bounding box of a spatial op — drives the selection
  // box, tap hit-testing and resize math. Matches the executor's anchors:
  // SVG text y = BASELINE, circle/ellipse = center, rect/overlay = top-left.
  const opBounds = (o: any): { x: number; y: number; w: number; h: number } | null => {
    if (!o) return null
    const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    if (o.op === "text") {
      const size = n(o.size, imgBox ? Math.round(imgBox.natH / 12) : 48)
      const w = Math.max(size * 0.6, String(o.text ?? "").length * size * 0.56)
      const x = o.align === "center" ? n(o.x) - w / 2 : n(o.x)
      return { x, y: n(o.y) - size * 0.85, w, h: size * 1.15 }
    }
    if (o.op === "overlay") {
      const cw = imgBox?.natW ?? 1024, ch = imgBox?.natH ?? 1024
      const fit = fitOverlay(o, cw, ch)
      if (fit) return fit
      const w = n(o.width, 0) || Math.round(cw / 3)
      return { x: n(o.x), y: n(o.y), w, h: w }
    }
    if (o.op === "region_blur") return { x: n(o.x), y: n(o.y), w: Math.max(4, n(o.width, 100)), h: Math.max(4, n(o.height, 100)) }
    if (o.op !== "shape") return null
    if (o.shape === "circle") {
      const r0 = Math.max(2, n(o.r, 50))
      return { x: n(o.cx ?? o.x) - r0, y: n(o.cy ?? o.y) - r0, w: r0 * 2, h: r0 * 2 }
    }
    if (o.shape === "ellipse") {
      const w = Math.max(4, n(o.width, 120)), h = Math.max(4, n(o.height, 80))
      return { x: n(o.cx ?? o.x) - w / 2, y: n(o.cy ?? o.y) - h / 2, w, h }
    }
    if (o.shape === "line") {
      const x1 = n(o.x), y1 = n(o.y), x2 = n(o.x2), y2 = n(o.y2)
      const pad = Math.max(6, n(o.stroke_width, 2))
      return { x: Math.min(x1, x2) - pad, y: Math.min(y1, y2) - pad, w: Math.abs(x2 - x1) + pad * 2, h: Math.abs(y2 - y1) + pad * 2 }
    }
    if (o.shape === "polygon") {
      const pts = parsePoly(o.points)
      if (!pts.length) return null
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
      const x = Math.min(...xs), y = Math.min(...ys)
      return { x, y, w: Math.max(4, Math.max(...xs) - x), h: Math.max(4, Math.max(...ys) - y) }
    }
    return { x: n(o.x), y: n(o.y), w: Math.max(4, n(o.width, 100)), h: Math.max(4, n(o.height, 100)) }
  }

  // Patch that moves a snapshotted op by (dx, dy) canvas px
  const movePatch = (snap: any, dx: number, dy: number): Record<string, any> => {
    const r = Math.round
    if (snap.op === "shape" && (snap.shape === "circle" || snap.shape === "ellipse"))
      return { cx: r(Number(snap.cx ?? snap.x ?? 0) + dx), cy: r(Number(snap.cy ?? snap.y ?? 0) + dy) }
    if (snap.op === "shape" && snap.shape === "line")
      return { x: r(Number(snap.x ?? 0) + dx), y: r(Number(snap.y ?? 0) + dy), x2: r(Number(snap.x2 ?? 0) + dx), y2: r(Number(snap.y2 ?? 0) + dy) }
    if (snap.op === "shape" && snap.shape === "polygon")
      return { points: fmtPoly(parsePoly(snap.points).map(p => [p[0] + dx, p[1] + dy])) }
    return { x: r(Number(snap.x ?? 0) + dx), y: r(Number(snap.y ?? 0) + dy) }
  }

  // Patch that scales a snapshotted op by factor f around its own center
  const scalePatch = (snap: any, f: number): Record<string, any> => {
    const r = Math.round
    if (snap.op === "text") return { size: Math.max(8, r(Number(snap.size ?? 48) * f)) }
    if (snap.op === "shape" && snap.shape === "circle") return { r: Math.max(2, r(Number(snap.r ?? 50) * f)) }
    if (snap.op === "shape" && snap.shape === "ellipse")
      return { width: Math.max(4, r(Number(snap.width ?? 120) * f)), height: Math.max(4, r(Number(snap.height ?? 80) * f)) }
    if (snap.op === "shape" && snap.shape === "line") {
      const mx = (Number(snap.x ?? 0) + Number(snap.x2 ?? 0)) / 2, my = (Number(snap.y ?? 0) + Number(snap.y2 ?? 0)) / 2
      return {
        x: r(mx + (Number(snap.x ?? 0) - mx) * f), y: r(my + (Number(snap.y ?? 0) - my) * f),
        x2: r(mx + (Number(snap.x2 ?? 0) - mx) * f), y2: r(my + (Number(snap.y2 ?? 0) - my) * f),
      }
    }
    const b = opBounds(snap)
    if (!b) return {}
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    if (snap.op === "shape" && snap.shape === "polygon")
      return { points: fmtPoly(parsePoly(snap.points).map(p => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f])) }
    const w = Math.max(8, r(b.w * f)), h = Math.max(8, r(b.h * f))
    if (snap.op === "overlay") {
      return {
        width: w, x: r(cx - w / 2), y: r(cy - h / 2),
        // stretched overlays (explicit height) scale both axes
        ...(Number(snap.height) > 0 ? { height: h } : {}),
      }
    }
    return { width: w, height: h, x: r(cx - w / 2), y: r(cy - h / 2) } // rect / region_blur
  }

  // Multi-pointer gesture state for the canvas overlay
  const gesRef = useRef({
    pts: new Map<number, { x: number; y: number }>(),
    start: new Map<number, { x: number; y: number }>(),
    snap: null as any,
    idx: null as number | null,
    mode: "idle" as "idle" | "move" | "pinch" | "erase",
    moved: false,
    scale: 1,
    sDisp: 1,
    xfAll: null as null | { s: number; dx: number; dy: number }[],
    frames: null as null | { w: number; h: number }[],
    origin: { x: 0, y: 0 },
    startDist: 1,
    startAngle: 0,
    eraseBox: null as null | { x: number; y: number; w: number; h: number },
    lastEr: { x: 0, y: 0 },
    paintKey: "erase" as "erase" | "draw",
  })

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!imgBox) return
    e.preventDefault()
    const g = gesRef.current
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    g.origin = { x: rect.left, y: rect.top }
    // Map screen px → the selected op's own coordinate space (crop/resize
    // ops later in the chain shift/scale it)
    const geom = computeGeom()
    g.xfAll = geom?.xf ?? null
    g.frames = geom?.frames ?? null
    g.sDisp = imgBox.w / (canLivePreview && geom ? geom.w : imgBox.natW) || 1
    g.scale = g.sDisp * ((layerSel != null ? g.xfAll?.[layerSel]?.s : 1) ?? 1) || 1
    // ── BRUSH / ERASER: single pointer paints a stroke onto the selected layer.
    // brush = colored source-over (draw[]), erase = dest-out (erase[]) ──
    if (g.pts.size === 1 && paintMode && canLivePreview && layerSel != null && layerErasable(layerOps[layerSel])) {
      const op = layerOps[layerSel]
      const frame = g.frames?.[layerSel] ?? { w: imgBox.natW, h: imgBox.natH }
      const box = op.op === "overlay" ? fitOverlay(op, frame.w, frame.h) : { x: 0, y: 0, w: frame.w, h: frame.h }
      if (!box) { g.pts.delete(e.pointerId); return } // overlay dims not measured yet
      pushHistory()
      g.mode = "erase"
      g.paintKey = cursorMode === "brush" ? "draw" : "erase"
      g.idx = layerSel
      g.eraseBox = box
      g.moved = false
      g.lastEr = { x: e.clientX, y: e.clientY }
      const t = g.xfAll?.[layerSel] ?? { s: 1, dx: 0, dy: 0 }
      const fx = (e.clientX - g.origin.x) / (g.sDisp || 1), fy = (e.clientY - g.origin.y) / (g.sDisp || 1)
      const ox = (fx - t.dx) / t.s, oy = (fy - t.dy) / t.s
      const u = ((ox - box.x) / box.w).toFixed(4), v = ((oy - box.y) / box.h).toFixed(4)
      const sizeFrac = Number(Math.max(0.002, (brushSize / t.s) / box.w).toFixed(5))
      const idx = layerSel, opac = brushOpacity, key = g.paintKey
      const stroke: any = key === "draw"
        ? { size: sizeFrac, opacity: opac, color: brushColor, points: `${u},${v}` }
        : { size: sizeFrac, opacity: opac, points: `${u},${v}` }
      setLayerOps(prev => prev.map((o, j) => j === idx
        ? { ...o, [key]: [...(Array.isArray(o[key]) ? o[key] : []), stroke] }
        : o))
      return
    }
    if (g.pts.size === 1) {
      g.moved = false
      g.idx = layerSel
      g.snap = layerSel != null ? { ...layerOps[layerSel] } : null
      g.start = new Map(g.pts)
      g.mode = layerSel != null && layerSpatial(layerOps[layerSel]) ? "move" : "idle"
    } else if (g.pts.size === 2 && g.idx != null && g.snap) {
      if (!g.moved) pushHistory()
      const [a, b] = [...g.pts.values()]
      g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      g.startAngle = Math.atan2(b.y - a.y, b.x - a.x)
      g.snap = { ...layerOps[g.idx] } // bake in any move-so-far before scaling
      g.mode = "pinch"
    }
  }

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const g = gesRef.current
    if (!g.pts.has(e.pointerId)) return
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.mode === "erase" && g.idx != null && g.eraseBox) {
      // Thin the point stream (~3 screen px) to keep strokes compact
      if (Math.hypot(e.clientX - g.lastEr.x, e.clientY - g.lastEr.y) < 3) return
      g.lastEr = { x: e.clientX, y: e.clientY }
      g.moved = true
      const box = g.eraseBox
      const t = g.xfAll?.[g.idx] ?? { s: 1, dx: 0, dy: 0 }
      const fx = (e.clientX - g.origin.x) / (g.sDisp || 1), fy = (e.clientY - g.origin.y) / (g.sDisp || 1)
      const ox = (fx - t.dx) / t.s, oy = (fy - t.dy) / t.s
      const u = Math.max(-0.25, Math.min(1.25, (ox - box.x) / box.w)).toFixed(4)
      const v = Math.max(-0.25, Math.min(1.25, (oy - box.y) / box.h)).toFixed(4)
      const idx = g.idx, key = g.paintKey
      setLayerOps(prev => prev.map((o, j) => {
        if (j !== idx || !Array.isArray(o[key]) || !o[key].length) return o
        const arr = [...o[key]]
        const last = { ...arr[arr.length - 1] }
        if (String(last.points).length > 7000) return o
        last.points = `${last.points} ${u},${v}`
        arr[arr.length - 1] = last
        return { ...o, [key]: arr }
      }))
      return
    }
    if (g.mode === "pinch" && g.pts.size >= 2 && g.idx != null && g.snap) {
      const [a, b] = [...g.pts.values()]
      const f = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.startDist
      g.moved = true
      const idx = g.idx, patch: Record<string, any> = scalePatch(g.snap, f)
      // Two-finger TWIST rotates the layer (overlay/text/shape)
      if (g.snap.op === "overlay" || g.snap.op === "text" || g.snap.op === "shape") {
        const aNow = Math.atan2(b.y - a.y, b.x - a.x)
        let deg = (Number(g.snap.rotate) || 0) + (aNow - g.startAngle) * 180 / Math.PI
        const stop = Math.round(deg / 15) * 15
        if (Math.abs(deg - stop) < 3) deg = stop
        patch.rotate = Math.round(((deg % 360) + 360) % 360)
      }
      setLayerOps(prev => prev.map((o, j) => (j === idx ? { ...o, ...patch } : o)))
    } else if (g.mode === "move" && g.pts.size === 1 && g.idx != null && g.snap) {
      const s = g.start.get(e.pointerId)
      if (!s) return
      if (!g.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return
      if (!g.moved) pushHistory()
      g.moved = true
      const idx = g.idx, patch = movePatch(g.snap, (e.clientX - s.x) / g.scale, (e.clientY - s.y) / g.scale)
      setLayerOps(prev => prev.map((o, j) => (j === idx ? { ...o, ...patch } : o)))
    }
  }

  const onCanvasPointerUp = (e: React.PointerEvent) => {
    const g = gesRef.current
    const wasTap = g.pts.size === 1 && !g.moved && g.mode !== "erase"
    g.pts.delete(e.pointerId)
    g.start.delete(e.pointerId)
    if (g.pts.size === 0) {
      if (wasTap && imgBox) {
        // Tap: select the topmost visible spatial layer under the finger —
        // mapped through each op's own coordinate space (crops shift it)
        const sD = g.sDisp || g.scale || 1
        const fx = (e.clientX - g.origin.x) / sD
        const fy = (e.clientY - g.origin.y) / sD
        let hit: number | null = null
        for (let i = layerOps.length - 1; i >= 0; i--) {
          if (layerDisabled.has(i) || !layerSpatial(layerOps[i])) continue
          const b = opBounds(layerOps[i])
          if (!b) continue
          const t = g.xfAll?.[i] ?? { s: 1, dx: 0, dy: 0 }
          const cx = (fx - t.dx) / t.s
          const cy = (fy - t.dy) / t.s
          const pad = 8 / (sD * t.s)
          if (cx >= b.x - pad && cx <= b.x + b.w + pad && cy >= b.y - pad && cy <= b.y + b.h + pad) { hit = i; break }
        }
        setLayerSel(hit)
      }
      g.mode = "idle"; g.moved = false; g.idx = null; g.snap = null; g.eraseBox = null
    } else if (g.pts.size === 1 && g.mode === "pinch") {
      // One finger lifted mid-pinch → continue as a move from the new state
      const remaining = [...g.pts.keys()][0]
      g.start = new Map([[remaining, g.pts.get(remaining)!]])
      if (g.idx != null) g.snap = { ...layerOps[g.idx] }
      g.mode = "move"
    }
  }

  // Handle resize: 8 handles — 4 corners + 4 edges. The side/corner OPPOSITE
  // the handle stays anchored (standard editor behavior). Edge handles squeeze
  // one axis; corners scale both (aspect-locked where the op demands it).
  const beginHandleResize = (e: React.PointerEvent, kind: string) => {
    if (!imgBox || layerSel == null) return
    e.stopPropagation()
    e.preventDefault()
    const snap = { ...layerOps[layerSel] }
    const b = opBounds(snap)
    if (!b) return
    pushHistory()
    const geom = computeGeom()
    const sDisp = imgBox.w / (canLivePreview && geom ? geom.w : imgBox.natW) || 1
    const t = geom?.xf?.[layerSel] ?? { s: 1, dx: 0, dy: 0 }
    const unit = sDisp * t.s || 1 // screen px per op-space px
    const startX = e.clientX, startY = e.clientY
    const idx = layerSel
    const hasW = kind.includes("w"), hasE = kind.includes("e")
    const hasN = kind.includes("n"), hasS = kind.includes("s")
    const corner = (hasW || hasE) && (hasN || hasS)
    const R = Math.round
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / unit
      const dy = (ev.clientY - startY) / unit
      const newW = Math.max(8, b.w + (hasE ? dx : 0) + (hasW ? -dx : 0))
      const newH = Math.max(8, b.h + (hasS ? dy : 0) + (hasN ? -dy : 0))
      const o = snap
      let patch: Record<string, any> | null = null
      if (o.op === "text") {
        const f = corner ? Math.max(newW / b.w, newH / b.h) : (hasW || hasE ? newW / b.w : newH / b.h)
        patch = { size: Math.max(8, R(Number(o.size ?? 48) * f)) }
      } else if (o.op === "shape" && o.shape === "circle") {
        const f = corner ? Math.max(newW / b.w, newH / b.h) : (hasW || hasE ? newW / b.w : newH / b.h)
        patch = { r: Math.max(2, R(Number(o.r ?? 50) * f)) }
      } else if (o.op === "shape" && o.shape === "line") {
        const f = corner ? Math.max(newW / b.w, newH / b.h) : (hasW || hasE ? newW / b.w : newH / b.h)
        const mx = (Number(o.x ?? 0) + Number(o.x2 ?? 0)) / 2, my = (Number(o.y ?? 0) + Number(o.y2 ?? 0)) / 2
        patch = {
          x: R(mx + (Number(o.x ?? 0) - mx) * f), y: R(my + (Number(o.y ?? 0) - my) * f),
          x2: R(mx + (Number(o.x2 ?? 0) - mx) * f), y2: R(my + (Number(o.y2 ?? 0) - my) * f),
        }
      } else if (o.op === "shape" && o.shape === "polygon") {
        const f = corner ? Math.max(newW / b.w, newH / b.h) : (hasW || hasE ? newW / b.w : newH / b.h)
        const cx0 = b.x + b.w / 2, cy0 = b.y + b.h / 2
        patch = { points: fmtPoly(parsePoly(o.points).map(p => [cx0 + (p[0] - cx0) * f, cy0 + (p[1] - cy0) * f])) }
      } else if (o.op === "shape" && o.shape === "ellipse") {
        const w2 = corner || hasW || hasE ? newW : b.w
        const h2 = corner || hasN || hasS ? newH : b.h
        const nx = hasW ? b.x + (b.w - w2) : b.x
        const ny = hasN ? b.y + (b.h - h2) : b.y
        patch = { cx: R(nx + w2 / 2), cy: R(ny + h2 / 2), width: R(w2), height: R(h2) }
      } else if (o.op === "overlay") {
        if (corner) {
          // Corners keep the current aspect (stretched or natural)
          const f = Math.max(newW / b.w, newH / b.h)
          const w2 = Math.max(8, R(b.w * f))
          const h2 = Math.max(8, R(b.h * f))
          patch = {
            width: w2,
            x: R(hasW ? b.x + (b.w - w2) : b.x),
            y: R(hasN ? b.y + (b.h - h2) : b.y),
            ...(Number(o.height) > 0 ? { height: h2 } : {}),
          }
        } else if (hasW || hasE) {
          // Horizontal squeeze: lock the current height explicitly
          const w2 = Math.max(8, R(newW))
          patch = { width: w2, height: R(b.h), x: R(hasW ? b.x + (b.w - w2) : b.x) }
        } else {
          // Vertical squeeze: lock the current width explicitly
          const h2 = Math.max(8, R(newH))
          patch = { height: h2, width: R(b.w), y: R(hasN ? b.y + (b.h - h2) : b.y) }
        }
      } else {
        // rect / region_blur — free resize, opposite side anchored
        const w2 = corner || hasW || hasE ? newW : b.w
        const h2 = corner || hasN || hasS ? newH : b.h
        patch = {
          x: R(hasW ? b.x + (b.w - w2) : b.x),
          y: R(hasN ? b.y + (b.h - h2) : b.y),
          width: R(w2), height: R(h2),
        }
      }
      if (patch) setLayerOps(prev => prev.map((o2, j) => (j === idx ? { ...o2, ...patch } : o2)))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // Drag-to-rotate via the grip above the selection box — angle measured from
  // the box center; soft-snaps to 15° stops
  const beginRotate = (e: React.PointerEvent) => {
    if (!imgBox || layerSel == null) return
    e.stopPropagation()
    e.preventDefault()
    const snap = { ...layerOps[layerSel] }
    const b = opBounds(snap)
    const overlayEl = (e.currentTarget as HTMLElement).parentElement
    if (!b || !overlayEl) return
    pushHistory()
    const geom = computeGeom()
    const sDisp = imgBox.w / (canLivePreview && geom ? geom.w : imgBox.natW) || 1
    const t = geom?.xf?.[layerSel] ?? { s: 1, dx: 0, dy: 0 }
    const rect = overlayEl.getBoundingClientRect()
    const cX = rect.left + (t.s * (b.x + b.w / 2) + t.dx) * sDisp
    const cY = rect.top + (t.s * (b.y + b.h / 2) + t.dy) * sDisp
    const a0 = Math.atan2(e.clientY - cY, e.clientX - cX)
    const r0 = Number(snap.rotate) || 0
    const idx = layerSel
    const move = (ev: PointerEvent) => {
      const a1 = Math.atan2(ev.clientY - cY, ev.clientX - cX)
      let deg = r0 + (a1 - a0) * 180 / Math.PI
      const stop = Math.round(deg / 15) * 15
      if (Math.abs(deg - stop) < 3) deg = stop
      const norm = Math.round(((deg % 360) + 360) % 360)
      setLayerOps(prev => prev.map((o2, j) => (j === idx ? { ...o2, rotate: norm } : o2)))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // ── LIVE canvas preview: rebuild the recipe client-side (base image + one
  // DOM/SVG element per op, with crop/resize/pad re-framing the stack exactly
  // like sharp does) so layers actually move while you drag. Only rotate/flip/
  // patch and the AI-masking ops (silhouette, remove_background — server-side
  // segmentation model) can't be reproduced → box-only preview + Save.
  const LIVE_PREVIEW_OPS = ["text", "shape", "overlay", "region_blur", "grayscale", "blur", "adjust", "tint", "vignette", "rounded", "crop", "resize", "pad", "starfield", "filter"]
  // Natural dims of the recipe's SOURCE image (≠ final render dims once
  // crop/resize are in the chain) — captured via a hidden preload img
  const [baseDims, setBaseDims] = useState<{ w: number; h: number } | null>(null)
  const canLivePreview = !!mediaViewer?.recipe
    && layerOps.length > 0
    && layerOps.every((o, i) => layerDisabled.has(i) || LIVE_PREVIEW_OPS.includes(String(o?.op)))
    && (!mediaViewer.recipe.image_url || !!baseDims)

  // Per-op affine transform (uniform scale + offset) from the coordinate
  // space an op draws in → the FINAL canvas, accounting for crop/resize/pad
  // later in the chain. Keeps the selection box and drag math accurate.
  // (crop mirrors sharp extract, resize mirrors fit:'inside' uniform scale.)
  const computeGeom = (): { w: number; h: number; xf: { s: number; dx: number; dy: number }[]; frames: { w: number; h: number }[] } | null => {
    const rec = mediaViewer?.recipe
    if (!rec) return null
    const nn = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const px = (v: any) => Math.min(2000, Math.max(0, Math.round(nn(v))))
    let w: number, h: number
    if (rec.image_url) {
      if (baseDims) { w = baseDims.w; h = baseDims.h }
      else if (imgBox && !layerOps.some((o, i) => !layerDisabled.has(i) && (o?.op === "crop" || o?.op === "resize" || o?.op === "pad"))) {
        w = imgBox.natW; h = imgBox.natH
      } else return null
    } else {
      w = Math.min(4096, Math.max(64, Math.round(rec.canvas?.width || 1024)))
      h = Math.min(4096, Math.max(64, Math.round(rec.canvas?.height || 1024)))
    }
    const dimsBefore: { w: number; h: number }[] = []
    for (let i = 0; i < layerOps.length; i++) {
      dimsBefore.push({ w, h })
      if (layerDisabled.has(i)) continue
      const o = layerOps[i]
      if (o.op === "crop") {
        w = Math.max(1, Math.round(nn(o.width, w))); h = Math.max(1, Math.round(nn(o.height, h)))
      } else if (o.op === "resize") {
        const tw = nn(o.width, 0), th = nn(o.height, 0)
        const k = tw && th ? Math.min(tw / w, th / h) : tw ? tw / w : th ? th / h : 1
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k))
      } else if (o.op === "pad") {
        w += px(o.left) + px(o.right); h += px(o.top) + px(o.bottom)
      }
    }
    const xf: { s: number; dx: number; dy: number }[] = new Array(layerOps.length)
    let ts = 1, tdx = 0, tdy = 0
    for (let i = layerOps.length - 1; i >= 0; i--) {
      xf[i] = { s: ts, dx: tdx, dy: tdy }
      if (layerDisabled.has(i)) continue
      const o = layerOps[i]
      if (o.op === "crop") {
        tdx -= ts * Math.max(0, Math.round(nn(o.x))); tdy -= ts * Math.max(0, Math.round(nn(o.y)))
      } else if (o.op === "resize") {
        const dw = dimsBefore[i]
        const tw = nn(o.width, 0), th = nn(o.height, 0)
        ts *= tw && th ? Math.min(tw / dw.w, th / dw.h) : tw ? tw / dw.w : th ? th / dw.h : 1
      } else if (o.op === "pad") {
        tdx += ts * px(o.left); tdy += ts * px(o.top)
      }
    }
    return { w, h, xf, frames: dimsBefore }
  }

  // Same stacks the server's SVG rasterizer uses
  const CLIENT_FONTS: Record<string, string> = {
    sans: "Arial, Helvetica, sans-serif",
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"Courier New", monospace',
    impact: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
    script: '"Segoe Script", "Brush Script MT", cursive',
    condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
  }

  // Eraser strokes as an SVG luminance mask (white keeps, black removes) —
  // mirrors the server's dest-out compositing for text/shape layers
  const eraseMaskEl = (strokes: any[], id: string, fw: number, fh: number): ReactNode => (
    <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={fw} height={fh}>
      <rect x={0} y={0} width={fw} height={fh} fill="#fff" />
      {strokes.map((s, j) => {
        const pts = String(s.points ?? "").trim().split(/\s+/)
          .map(p => p.split(",").map(Number))
          .filter(a => a.length === 2 && a.every(Number.isFinite))
          .map(([u, v]) => `${(u * fw).toFixed(1)},${(v * fh).toFixed(1)}`)
        if (!pts.length) return null
        return (
          <polyline key={j} points={pts.length === 1 ? `${pts[0]} ${pts[0]}` : pts.join(" ")} fill="none"
            stroke="#000" strokeOpacity={Math.min(1, Math.max(0.05, typeof s.opacity === "number" ? s.opacity : 1))}
            strokeWidth={Math.max(1, (Number(s.size) || 0.05) * fw)} strokeLinecap="round" strokeLinejoin="round" />
        )
      })}
    </mask>
  )

  // Brush strokes as colored polylines painted OVER the layer content —
  // mirrors the server's source-over applyDrawStrokes (same normalized coords)
  const drawStrokesEl = (strokes: any[], fw: number, fh: number): ReactNode =>
    strokes.map((s, j) => {
      const pts = String(s.points ?? "").trim().split(/\s+/)
        .map(p => p.split(",").map(Number))
        .filter(a => a.length === 2 && a.every(Number.isFinite))
        .map(([u, v]) => `${(u * fw).toFixed(1)},${(v * fh).toFixed(1)}`)
      if (!pts.length) return null
      return (
        <polyline key={j} points={pts.length === 1 ? `${pts[0]} ${pts[0]}` : pts.join(" ")} fill="none"
          stroke={typeof s.color === "string" && s.color ? s.color : "#ffffff"}
          strokeOpacity={Math.min(1, Math.max(0.05, typeof s.opacity === "number" ? s.opacity : 1))}
          strokeWidth={Math.max(1, (Number(s.size) || 0.05) * fw)} strokeLinecap="round" strokeLinejoin="round" />
      )
    })

  // One element per op, in canvas pixel space (the parent container is scaled).
  // Mirrors the executor's SVG semantics: text y = baseline, circle/ellipse =
  // center, paint-order stroke, gradient rects.
  const liveOpEl = (o: any, key: number, natW: number, natH: number): ReactNode => {
    const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const opac = typeof o.opacity === "number" ? Math.min(1, Math.max(0.05, o.opacity)) : 1
    if (o.op === "text") {
      const size = Math.min(natH, Math.max(8, Math.round(n(o.size, natH / 12))))
      const strokeW = o.stroke ? Math.max(1, Math.round(n(o.stroke_width, Math.max(2, size / 16)))) : 0
      const erase: any[] = Array.isArray(o.erase) ? o.erase : []
      const maskId = `er-t-${key}`
      // Same pivot arithmetic as the server (estimate, not font metrics)
      const rotT = Number(o.rotate) ? Math.round(Number(o.rotate)) : 0
      const rawLen = String(o.text ?? "").slice(0, 200).length || 1
      const estW = Math.max(size * 0.6, rawLen * size * 0.56)
      const pcx = o.align === "center" ? Math.round(n(o.x)) : Math.round(n(o.x)) + estW / 2
      const pcy = Math.round(n(o.y)) - size * 0.275
      return (
        <svg key={key} width={natW} height={natH} className="absolute left-0 top-0 pointer-events-none" style={{ overflow: "visible" }}>
          {erase.length > 0 && eraseMaskEl(erase, maskId, natW, natH)}
          <text
            {...(rotT ? { transform: `rotate(${rotT} ${pcx.toFixed(1)} ${pcy.toFixed(1)})` } : {})}
            x={Math.round(n(o.x))} y={Math.round(n(o.y))}
            fontFamily={CLIENT_FONTS[o.font ?? "sans"] ?? CLIENT_FONTS.sans}
            fontSize={size} fontWeight={o.weight === "bold" ? "bold" : "normal"}
            fill={o.color || "#ffffff"}
            {...(o.stroke ? { stroke: o.stroke, strokeWidth: strokeW, paintOrder: "stroke" } : {})}
            opacity={opac} textAnchor={o.align === "center" ? "middle" : "start"}
            mask={erase.length ? `url(#${maskId})` : undefined}
          >
            {String(o.text ?? "").slice(0, 200)}
          </text>
          {Array.isArray(o.draw) && o.draw.length > 0 && drawStrokesEl(o.draw, natW, natH)}
        </svg>
      )
    }
    if (o.op === "shape") {
      const fill = o.fill === "none" || (!o.fill && o.stroke) ? "none" : (o.fill || "#000000")
      const sw = Math.max(1, Math.round(n(o.stroke_width, 2)))
      // A transparent layer (fill "none", no stroke) bakes to nothing — give it
      // a faint dashed outline in the EDITOR only so it stays visible/movable.
      const emptyShape = fill === "none" && !o.stroke
      const strokeAttrs = o.stroke
        ? { stroke: o.stroke, strokeWidth: sw }
        : emptyShape
          ? { stroke: "#67e8f9", strokeWidth: 1.5, strokeDasharray: "6 5", strokeOpacity: 0.6 }
          : {}
      const g = o.gradient
      const hasGrad = o.shape === "rect" && g && g.from && g.to
      const gradId = `live-lg-${key}`
      const [gx1, gy1, gx2, gy2] =
        g?.direction === "up" ? [0, 1, 0, 0]
        : g?.direction === "left" ? [1, 0, 0, 0]
        : g?.direction === "right" ? [0, 0, 1, 0]
        : [0, 0, 0, 1]
      const so = (v: any, d: number) => Math.min(1, Math.max(0, typeof v === "number" ? v : d))
      let el: ReactNode = null
      if (o.shape === "rect")
        el = <rect x={n(o.x)} y={n(o.y)} width={Math.max(1, n(o.width))} height={Math.max(1, n(o.height))}
          rx={o.corner_radius ? Math.max(0, n(o.corner_radius)) : undefined}
          fill={hasGrad ? `url(#${gradId})` : fill} {...strokeAttrs} opacity={opac} />
      else if (o.shape === "circle")
        el = <circle cx={n(o.cx ?? o.x)} cy={n(o.cy ?? o.y)} r={Math.max(1, n(o.r, 50))} fill={fill} {...strokeAttrs} opacity={opac} />
      else if (o.shape === "ellipse")
        el = <ellipse cx={n(o.cx ?? o.x)} cy={n(o.cy ?? o.y)} rx={Math.max(1, n(o.width) / 2 || 60)} ry={Math.max(1, n(o.height) / 2 || 40)}
          fill={fill} {...strokeAttrs} opacity={opac} />
      else if (o.shape === "line")
        el = <line x1={n(o.x)} y1={n(o.y)} x2={n(o.x2)} y2={n(o.y2)}
          stroke={o.stroke || (fill === "none" ? "#ffffff" : fill)} strokeWidth={sw} opacity={opac} />
      else if (o.shape === "polygon")
        el = <polygon points={String(o.points ?? "")} fill={fill} {...strokeAttrs} opacity={opac} />
      const erase: any[] = Array.isArray(o.erase) ? o.erase : []
      const maskId = `er-s-${key}`
      // Shape rotation around its center — same pivot math as the server
      const rotS = Number(o.rotate) ? Math.round(Number(o.rotate)) : 0
      if (rotS) {
        let pcx = 0, pcy = 0
        if (o.shape === "rect") { pcx = n(o.x) + Math.max(1, n(o.width)) / 2; pcy = n(o.y) + Math.max(1, n(o.height)) / 2 }
        else if (o.shape === "circle" || o.shape === "ellipse") { pcx = n(o.cx ?? o.x); pcy = n(o.cy ?? o.y) }
        else if (o.shape === "line") { pcx = (n(o.x) + n(o.x2)) / 2; pcy = (n(o.y) + n(o.y2)) / 2 }
        else {
          const pts = parsePoly(o.points)
          if (pts.length) {
            const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
            pcx = (Math.min(...xs) + Math.max(...xs)) / 2
            pcy = (Math.min(...ys) + Math.max(...ys)) / 2
          }
        }
        el = <g transform={`rotate(${rotS} ${pcx.toFixed(1)} ${pcy.toFixed(1)})`}>{el}</g>
      }
      return (
        <svg key={key} width={natW} height={natH} className="absolute left-0 top-0 pointer-events-none" style={{ overflow: "visible" }}>
          {hasGrad && (
            <defs>
              <linearGradient id={gradId} x1={gx1} y1={gy1} x2={gx2} y2={gy2}>
                <stop offset="0%" stopColor={g.from} stopOpacity={so(g.from_opacity, 1)} />
                <stop offset="100%" stopColor={g.to} stopOpacity={so(g.to_opacity, 1)} />
              </linearGradient>
            </defs>
          )}
          {erase.length > 0 && eraseMaskEl(erase, maskId, natW, natH)}
          {erase.length > 0 ? <g mask={`url(#${maskId})`}>{el}</g> : el}
          {Array.isArray(o.draw) && o.draw.length > 0 && drawStrokesEl(o.draw, natW, natH)}
        </svg>
      )
    }
    if (o.op === "starfield") {
      const col = typeof o.color === "string" && o.color ? o.color : "#ffffff"
      return (
        <svg key={key} width={natW} height={natH} className="absolute left-0 top-0 pointer-events-none">
          {computeStarfieldClient(o, natW, natH).map((p, j) => p.t === "c"
            ? <circle key={j} cx={p.x} cy={p.y} r={p.r} fill={col} opacity={p.o} />
            : <line key={j} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={col} strokeWidth={p.w} opacity={p.o} strokeLinecap="round" />)}
        </svg>
      )
    }
    if (o.op === "overlay") {
      const blend = ["multiply", "screen", "overlay", "soft-light"].includes(o.blend) ? o.blend : "normal"
      // Same AUTO-FIT the server applies — raw coords would shift the whole
      // composition vs the baked render whenever the server had to clamp
      const fit = fitOverlay(o, natW, natH)
      // CSS rotate around center matches the server's center-preserving spin
      const rotStyle: React.CSSProperties = Number(o.rotate)
        ? { transform: `rotate(${Math.round(Number(o.rotate))}deg)` } : {}
      const place: React.CSSProperties = fit
        ? { left: fit.x, top: fit.y, width: fit.w, height: fit.h, ...rotStyle }
        : { left: n(o.x), top: n(o.y), ...(n(o.width, 0) > 0 ? { width: n(o.width) } : { maxWidth: Math.max(8, natW - Math.max(0, n(o.x))) }), ...rotStyle }
      // Brush strokes painted over the overlay's placed rect (matches the
      // server, which paints them onto the overlay buffer before placement)
      const ovlDraw = fit && Array.isArray(o.draw) && o.draw.length > 0 ? (
        <svg key={`${key}-draw`} width={fit.w} height={fit.h}
          className="absolute pointer-events-none" style={{
            left: fit.x, top: fit.y, ...rotStyle, overflow: "visible",
            opacity: typeof o.opacity === "number" ? Math.min(1, Math.max(0, o.opacity)) : 1,
            mixBlendMode: blend as any,
          }}>
          {drawStrokesEl(o.draw, fit.w, fit.h)}
        </svg>
      ) : null
      // Erased, cropped, and/or flipped overlays render through a canvas
      // (dest-out strokes + source-rect crop + mirror, same as the server bake)
      if (fit && ((Array.isArray(o.erase) && o.erase.length > 0) || o.crop || o.flip)) {
        return (
          <Fragment key={key}>
          <ErasedOverlay src={o.image_url} w={fit.w} h={fit.h}
            erase={Array.isArray(o.erase) ? o.erase : []}
            srcRect={{ sx: fit.sx, sy: fit.sy, sw: fit.sw, sh: fit.sh }}
            flip={o.flip === "horizontal" || o.flip === "vertical" ? o.flip : undefined}
            style={{
              left: fit.x, top: fit.y, width: fit.w, height: fit.h,
              ...rotStyle,
              opacity: typeof o.opacity === "number" ? Math.min(1, Math.max(0, o.opacity)) : 1,
              mixBlendMode: blend as any,
            }} />
          {ovlDraw}
          </Fragment>
        )
      }
      return (
        <Fragment key={key}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={o.image_url} alt="" className="absolute pointer-events-none"
          onLoad={e => {
            const el = e.currentTarget
            const u = String(o.image_url ?? "")
            if (u && el.naturalWidth) {
              setOvlNat(prev => (prev[u] ? prev : { ...prev, [u]: { w: el.naturalWidth, h: el.naturalHeight } }))
            }
          }}
          style={{
            ...place,
            opacity: typeof o.opacity === "number" ? Math.min(1, Math.max(0, o.opacity)) : 1,
            mixBlendMode: blend as any,
          }} />
        {ovlDraw}
        </Fragment>
      )
    }
    if (o.op === "region_blur")
      return <div key={key} className="absolute pointer-events-none"
        style={{ left: n(o.x), top: n(o.y), width: Math.max(1, n(o.width, 100)), height: Math.max(1, n(o.height, 100)),
          backdropFilter: `blur(${Math.min(50, Math.max(0.3, n(o.sigma, 12)))}px)` }} />
    if (o.op === "vignette")
      return <div key={key} className="absolute left-0 top-0 pointer-events-none"
        style={{ width: natW, height: natH,
          background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,${Math.min(0.95, Math.max(0.05, n(o.strength, 0.45)))}) 100%)` }} />
    return null // grayscale/blur/adjust/tint/rounded/crop/resize/pad are pipeline wrappers
  }

  // Full client-side rebuild of the edit pipeline, same order sharp runs it:
  // drawing ops append into the current frame; crop clips + shifts, resize
  // scales, pad extends the frame; filter ops wrap the accumulated stack.
  const buildLiveCanvas = (): { node: ReactNode; w: number; h: number } | null => {
    const rec = mediaViewer?.recipe
    if (!rec) return null
    const nn = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    let w: number, h: number
    let children: ReactNode[]
    if (rec.image_url) {
      if (!baseDims) return null
      w = baseDims.w; h = baseDims.h
      children = [
        /* eslint-disable-next-line @next/next/no-img-element */
        <img key="base" src={rec.image_url} alt="" style={{ position: "absolute", left: 0, top: 0, width: w, height: h, maxWidth: "none" }} />,
      ]
    } else {
      w = Math.min(4096, Math.max(64, Math.round(rec.canvas?.width || 1024)))
      h = Math.min(4096, Math.max(64, Math.round(rec.canvas?.height || 1024)))
      children = [<div key="base" style={{ position: "absolute", left: 0, top: 0, width: w, height: h, background: rec.canvas?.color || "#ffffff" }} />]
    }
    const frame = (fw: number, fh: number): React.CSSProperties => ({ position: "absolute", left: 0, top: 0, width: fw, height: fh })
    for (let i = 0; i < layerOps.length; i++) {
      if (layerDisabled.has(i)) continue
      const o = layerOps[i]
      if (o.op === "crop") {
        const cx = Math.max(0, Math.round(nn(o.x))), cy = Math.max(0, Math.round(nn(o.y)))
        const cw = Math.max(1, Math.round(nn(o.width, w))), ch = Math.max(1, Math.round(nn(o.height, h)))
        children = [
          <div key={`crop${i}`} style={{ ...frame(cw, ch), overflow: "hidden" }}>
            <div style={{ ...frame(w, h), left: -cx, top: -cy }}>{children}</div>
          </div>,
        ]
        w = cw; h = ch
      } else if (o.op === "resize") {
        const tw = nn(o.width, 0), th = nn(o.height, 0)
        const k = tw && th ? Math.min(tw / w, th / h) : tw ? tw / w : th ? th / h : 1
        const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k))
        children = [
          <div key={`rs${i}`} style={{ ...frame(w, h), transform: `scale(${nw / w}, ${nh / h})`, transformOrigin: "top left" }}>{children}</div>,
        ]
        w = nw; h = nh
      } else if (o.op === "pad") {
        const px = (v: any) => Math.min(2000, Math.max(0, Math.round(nn(v))))
        const t = px(o.top), bm = px(o.bottom), l = px(o.left), r = px(o.right)
        const nw = w + l + r, nh = h + t + bm
        children = [
          <div key={`pad${i}`} style={{ ...frame(nw, nh), background: o.color || "#000000" }} />,
          <div key={`padc${i}`} style={{ ...frame(w, h), left: l, top: t }}>{children}</div>,
        ]
        w = nw; h = nh
      } else if (o.op === "grayscale" || o.op === "blur" || o.op === "adjust") {
        const f =
          o.op === "grayscale" ? "grayscale(1)"
          : o.op === "blur" ? `blur(${Math.min(50, Math.max(0.3, nn(o.sigma, 5)))}px)`
          : [
              typeof o.brightness === "number" ? `brightness(${o.brightness})` : "",
              typeof o.saturation === "number" ? `saturate(${o.saturation})` : "",
              typeof o.hue === "number" ? `hue-rotate(${Math.round(o.hue)}deg)` : "",
            ].filter(Boolean).join(" ")
        if (f) children = [<div key={`f${i}`} style={{ ...frame(w, h), filter: f }}>{children}</div>]
      } else if (o.op === "filter") {
        const fn = FILTER_CSS[String(o.name ?? "")]
        if (fn) {
          const s = typeof o.strength === "number" ? Math.min(1, Math.max(0, o.strength)) : 1
          children = [<div key={`flt${i}`} style={{ ...frame(w, h), filter: fn(s) }}>{children}</div>]
        }
      } else if (o.op === "tint") {
        // CSS 'color' blend ≈ sharp tint (recolor keeping luminance)
        children = [
          <div key={`tint${i}`} style={{ ...frame(w, h), isolation: "isolate" }}>
            {children}
            <div style={{ ...frame(w, h), background: o.color || "#888888", mixBlendMode: "color" }} />
          </div>,
        ]
      } else if (o.op === "rounded") {
        const r = Math.min(Math.min(w, h) / 2, Math.max(1, Math.round(nn(o.radius, Math.min(w, h) * 0.06))))
        children = [<div key={`rd${i}`} style={{ ...frame(w, h), borderRadius: r, overflow: "hidden" }}>{children}</div>]
      } else {
        const el = liveOpEl(o, i, w, h)
        if (el) children.push(el)
      }
    }
    return { node: <>{children}</>, w, h }
  }

  // ── Layer management: reorder (drag), duplicate, merge ─────────────────
  const remapAfterMove = (idx: number, from: number, to: number) => {
    if (idx === from) return to
    if (from < to) return idx > from && idx <= to ? idx - 1 : idx
    return idx >= to && idx < from ? idx + 1 : idx
  }
  const moveLayer = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return
    pushHistory()
    setLayerOps(prev => {
      const arr = [...prev]
      const [it] = arr.splice(from, 1)
      arr.splice(to, 0, it)
      return arr
    })
    setLayerDisabled(prev => new Set([...prev].map(x => remapAfterMove(x, from, to))))
    setLayerSel(sel => (sel == null ? sel : remapAfterMove(sel, from, to)))
  }
  const duplicateLayer = (i: number) => {
    pushHistory()
    setLayerOps(prev => {
      const arr = [...prev]
      arr.splice(i + 1, 0, JSON.parse(JSON.stringify(arr[i])))
      return arr
    })
    setLayerDisabled(prev => new Set([...prev].map(x => (x > i ? x + 1 : x))))
    setLayerSel(i + 1)
  }
  // Remove a layer entirely, remapping hidden-set + selection around the gap.
  const deleteLayer = (i: number) => {
    pushHistory()
    setLayerOps(prev => prev.filter((_, j) => j !== i))
    setLayerDisabled(prev => new Set([...prev].filter(x => x !== i).map(x => (x > i ? x - 1 : x))))
    setLayerSel(sel => (sel == null ? null : sel === i ? null : sel > i ? sel - 1 : sel))
  }

  // ── Insert new layers (top of the stack = painted last) ──────────────────
  const [insertMenuOpen, setInsertMenuOpen] = useState(false)
  const layerImageInputRef = useRef<HTMLInputElement>(null)
  const canvasDims = (): { w: number; h: number } | null => {
    const geom = computeGeom()
    const w = geom?.w ?? imgBox?.natW, h = geom?.h ?? imgBox?.natH
    return w && h ? { w, h } : null
  }
  const insertLayer = (make: (d: { w: number; h: number }) => any) => {
    const d = canvasDims()
    if (!d) { setLayerErr("Open the image first, then add a layer"); return }
    pushHistory()
    setLayerOps(prev => { setLayerSel(prev.length); return [...prev, make(d)] })
    setLayerErr(null)
    setInsertMenuOpen(false)
  }
  // Solid color fill covering the whole canvas (recolor via the fill field)
  const insertColorLayer = () =>
    insertLayer(d => ({ op: "shape", shape: "rect", x: 0, y: 0, width: d.w, height: d.h, fill: "#808080", opacity: 1 }))
  // Empty transparent region — fill "none" bakes nothing; a centered box so it's
  // a visible, movable placeholder (dashed outline in the editor). Give it a
  // color via the fill field to turn it into a solid layer.
  const insertTransparentLayer = () =>
    insertLayer(d => ({
      op: "shape", shape: "rect",
      x: Math.round(d.w * 0.2), y: Math.round(d.h * 0.2),
      width: Math.round(d.w * 0.6), height: Math.round(d.h * 0.6), fill: "none",
    }))
  // Upload an image and drop it in as an overlay layer at half-canvas width
  const insertImageLayer = async (file: File) => {
    const d = canvasDims()
    if (!d) { setLayerErr("Open the image first, then add a layer"); return }
    setLayerBusy(true); setLayerErr(null); setInsertMenuOpen(false)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/upload-reference", { method: "POST", body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.url) { setLayerErr(data.error || "Image upload failed"); return }
      pushHistory()
      const op = { op: "overlay", image_url: data.url as string, x: Math.round(d.w * 0.25), y: Math.round(d.h * 0.25), width: Math.round(d.w * 0.5) }
      setLayerOps(prev => { setLayerSel(prev.length); return [...prev, op] })
    } catch {
      setLayerErr("Image upload failed")
    } finally {
      setLayerBusy(false)
    }
  }
  // Drag a row grip to reorder — paint order IS the ops order, so this is
  // the direct "move layer up/down the stack" control
  const [dragRow, setDragRow] = useState<{ from: number; to: number } | null>(null)
  const beginLayerRowDrag = (e: React.PointerEvent, from: number) => {
    e.preventDefault()
    e.stopPropagation()
    const rowEl = (e.currentTarget as HTMLElement).closest("[data-lrow]") as HTMLElement | null
    const rowH = (rowEl?.offsetHeight ?? 30) + 4
    const startY = e.clientY
    const count = layerOps.length
    let to = from
    setDragRow({ from, to: from })
    const move = (ev: PointerEvent) => {
      const t = Math.max(0, Math.min(count - 1, from + Math.round((ev.clientY - startY) / rowH)))
      if (t !== to) { to = t; setDragRow({ from, to: t }) }
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setDragRow(null)
      if (to !== from) moveLayer(from, to)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  // Merge = rasterize this layer + the previous one (painted beneath it)
  // into ONE overlay image via a transparent-canvas server bake. This layer
  // stays on top inside the baked result.
  const MERGEABLE_OPS = ["text", "shape", "overlay", "starfield"]
  const mergeWithPrevious = async (i: number) => {
    if (i <= 0 || layerBusy || !activeChatId || typeof mediaViewer?.messageId !== "number") return
    const below = layerOps[i - 1], top = layerOps[i]
    if (!MERGEABLE_OPS.includes(String(below?.op)) || !MERGEABLE_OPS.includes(String(top?.op))) {
      setLayerErr("Merge works between drawable layers (text, shape, overlay, starfield)")
      return
    }
    if (layerOps.some((o, j) => !layerDisabled.has(j) && ["crop", "resize", "pad", "rotate", "flip"].includes(String(o?.op)))) {
      setLayerErr("Merge isn't available while the recipe crops/resizes the canvas")
      return
    }
    const geom = computeGeom()
    const w = geom?.w ?? imgBox?.natW, h = geom?.h ?? imgBox?.natH
    if (!w || !h) return
    setLayerBusy(true)
    setLayerErr(null)
    try {
      const res = await fetch(`/api/chat-hub/chats/${activeChatId}/merge-layers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: mediaViewer.messageId, width: w, height: h,
          operations: [below, top].map(o => (o?.op === "overlay" ? { ...o, bleed: true, stretch: true } : o)),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setLayerErr(d.error || "Merge failed"); return }
      pushHistory()
      setLayerOps(prev => {
        const arr = [...prev]
        arr.splice(i - 1, 2, { op: "overlay", image_url: d.imageUrl, x: 0, y: 0, width: w })
        return arr
      })
      setLayerDisabled(prev => new Set([...prev].filter(x => x !== i - 1 && x !== i).map(x => (x > i ? x - 1 : x))))
      setLayerSel(i - 1)
    } catch {
      setLayerErr("Network error")
    } finally {
      setLayerBusy(false)
    }
  }

  // Snapshot the viewer's current layer recipe as compact JSON (null when the
  // image has no recipe or the recipe is too large to inline). Captured at the
  // moment "Edit" is pressed, since the viewer closes right after.
  const snapshotViewerRecipe = (): string | null => {
    const rec = mediaViewer?.recipe
    if (!rec) return null
    let json = ""
    try {
      json = JSON.stringify({
        ...(rec.image_url ? { image_url: rec.image_url } : {}),
        ...(rec.canvas ? { canvas: rec.canvas } : {}),
        operations: layerOps.length ? layerOps : rec.operations,
      })
    } catch {}
    return json && json.length <= 7000 ? json : null
  }

  // Build the message text for an armed edit: a recipe RESUMES the layered
  // composition (re-run edit_image on the ORIGINAL base with the full updated
  // op list, so layers stack across runs instead of piling onto flattened
  // pixels); no recipe = a plain edit of the attached image.
  const buildLayeredEditMessage = (userText: string, recipeJson: string | null): string => {
    if (!recipeJson) return userText
    return `[LAYERED EDIT — continue the existing composition]\nRequested change: ${userText}\n\n`
      + `The attached image was BUILT from the layer recipe below. Do NOT paste new ops onto the flattened image — `
      + `re-run edit_image on the ORIGINAL base from the recipe with the FULL updated operations list `
      + `(modify/add/remove/reorder layers as the change requires; keep every untouched layer identical):\n`
      + "```json\n" + recipeJson + "\n```"
  }

  // "Edit" from the viewer → close it and arm the composer with this image.
  const armEditFromViewer = () => {
    if (!mediaViewer) return
    setPendingEdit({ url: mediaViewer.url, recipeJson: snapshotViewerRecipe(), isVideo: !!mediaViewer.isVideo })
    setMediaViewer(null)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  const applyLayers = async () => {
    if (!mediaViewer?.recipe || typeof mediaViewer.messageId !== "number" || !mediaViewer.stepId || !activeChatId) return
    // A human placed these layers — off-canvas positions are deliberate, so
    // stamp bleed:true to pass the server's coordinate-mistake guard
    const ops = layerOps
      .filter((_, i) => !layerDisabled.has(i))
      .map(o => (o?.op === "overlay" ? { ...o, bleed: true, stretch: true } : o))
    if (ops.length === 0) { setLayerErr("At least one layer must stay visible"); return }
    setLayerBusy(true)
    setLayerErr(null)
    try {
      const res = await fetch(`/api/chat-hub/chats/${activeChatId}/edit-rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: mediaViewer.messageId, stepId: mediaViewer.stepId, operations: ops }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setLayerErr(d.error || "Re-render failed"); return }
      setMediaViewer(v => (v ? { ...v, url: d.imageUrl, recipe: { ...v.recipe!, operations: ops } } : v))
      setLayerOps(ops.map(o => ({ ...o })))
      setLayerDisabled(new Set())
      setLayerSel(null)
      setLayerPast([])
      setLayerFuture([])
      reloadMessages(activeChatId)
    } catch {
      setLayerErr("Network error")
    } finally {
      setLayerBusy(false)
    }
  }

  const resetViewerExtras = () => {
    setViewerZoom(1)
    setViewerFull(false)
    setAddRefState("idle")
    setLayersOpen(false)
    setLayerSel(null)
    setLayerDisabled(new Set())
    setLayerErr(null)
    setLayerBusy(false)
    setBaseDims(null)
    setLayerPast([])
    setLayerFuture([])
    setCursorMode("select")
    setInsertMenuOpen(false)
  }

  const openMediaViewer = (m: Msg, url: string) => {
    const step = m.agentSteps?.find(s => s.imageUrl === url)
    const info = step
      ? {
          url, modelId: step.model, prompt: step.prompt ?? step.task,
          settings: step.settings, cost: step.cost,
        }
      : {
          url, modelId: m.model, prompt: m.createInfo ? undefined : (m.content || undefined),
          settings: m.createInfo?.settings, cost: m.createInfo?.ticketCost,
        }
    // Prefer the parent's editor modal for ALL images — the portal mounts the
    // full Edit Reference canvas (draw/blur/crop/mask/cut/layers) there. The
    // built-in viewer remains the fallback for videos and standalone embeds.
    if (onOpenMedia && !isVideoUrl(url)) {
      onOpenMedia({ ...info, recipe: step?.editRecipe ?? null })
      return
    }
    // Edit-recipe images open in the BUILT-IN viewer — it has the layer editor
    if (step?.editRecipe && typeof m.id === "number" && !isVideoUrl(url)) {
      resetViewerExtras()
      setLayerOps(JSON.parse(JSON.stringify(step.editRecipe.operations ?? [])))
      // NOTE: layers editor NOT auto-opened — a fresh click must show the
      // exact baked render (identical to the chat tile); the live client
      // rebuild only appears once the user taps Layers.
      setMediaViewer({
        ...info, isVideo: false, kind: "image",
        recipe: step.editRecipe as MediaViewerState["recipe"],
        messageId: m.id, stepId: step.id,
      })
      return
    }
    resetViewerExtras()
    setMediaViewer({ ...info, isVideo: isVideoUrl(url), kind: step?.kind ?? m.createInfo?.kind ?? (isVideoUrl(url) ? "video" : "image") })
  }

  // Actions coming back from the parent modal (Edit / Use Prompt)
  const lastActionNonceRef = useRef(0)
  useEffect(() => {
    if (!actionRequest || actionRequest.nonce === lastActionNonceRef.current) return
    lastActionNonceRef.current = actionRequest.nonce
    if (actionRequest.kind === "edit" && actionRequest.url) {
      if (activeChatIdRef.current && !streaming) {
        sendMessage(activeChatIdRef.current, actionRequest.text, [actionRequest.url])
      }
    } else if (actionRequest.kind === "useprompt") {
      setInput(actionRequest.text)
      requestAnimationFrame(() => {
        const ta = inputRef.current
        if (ta) { autoGrow(ta); ta.focus() }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionRequest?.nonce])

  // "+" menu (upload refs / create image / create video) + active create mode
  const [plusMenu, setPlusMenu] = useState<"root" | "image" | "video" | null>(null)
  const [createMode, setCreateMode] = useState<ChatCreateModel | null>(null)
  // Per-model generation settings (aspect / quality / duration / audio…),
  // reset to the model's defaults whenever a create mode is armed
  const [createSettings, setCreateSettings] = useState<ChatCreateSettings>({})

  const armCreateMode = (m: ChatCreateModel) => {
    setCreateMode(m)
    setCreateSettings(resolveCreateSettings(m, {}))
  }
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!plusMenu) return
    const onDown = (e: MouseEvent) => {
      if (!plusMenuRef.current?.contains(e.target as Node)) setPlusMenu(null)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [plusMenu])

  const handleUploadFiles = async (files: File[]) => {
    if (!onUploadRefs || files.length === 0) return
    setUploadingRefs(true)
    setError(null)
    try {
      const res = await onUploadRefs(files)
      if (res.limitHit) setError("Reference library is full — some images were not added")
      else if (res.failed > 0) setError(`${res.failed} image(s) failed to upload`)
    } catch {
      setError("Upload failed")
    } finally {
      setUploadingRefs(false)
    }
  }

  // Per-chat instructions + saved presets
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  // Click-away: a pointer down anywhere outside the Employees popup (and its
  // toggle) closes it — except while an employee is being edited, where an
  // accidental tap must not discard the draft (use X / Cancel there)
  useEffect(() => {
    if (!instructionsOpen || empDraft) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.("[data-employees-panel],[data-employees-toggle]")) return
      setInstructionsOpen(false)
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [instructionsOpen, empDraft])
  const [spDraft, setSpDraft] = useState("")       // instructions editor draft
  const [spSaved, setSpSaved] = useState("")       // last saved value for the active chat
  const [personas, setPersonas] = useState<Persona[]>([])
  // Employee applied to every NEW chat (id of a built-in or saved employee)
  const [defaultEmployeeId, setDefaultEmployeeId] = useState<string | null>(null)

  // ── Global memory manager (Employees panel → Memory tab) ──────────────────
  type MemoryEntry = { id: number; content: string; category: string | null; source: string; createdAt: string }
  const [panelTab, setPanelTab] = useState<"employees" | "memory">("employees")
  const [memEntries, setMemEntries] = useState<MemoryEntry[]>([])
  const [memLimit, setMemLimit] = useState(60)
  const [memLoaded, setMemLoaded] = useState(false)
  const [memNew, setMemNew] = useState("")
  const [memNewCat, setMemNewCat] = useState("")
  const [memEditId, setMemEditId] = useState<number | null>(null)
  const [memEditText, setMemEditText] = useState("")

  const fetchMemory = async () => {
    try {
      const res = await fetch("/api/chat-hub/memory")
      if (!res.ok) return
      const data = await res.json()
      setMemEntries(Array.isArray(data.entries) ? data.entries : [])
      if (typeof data.limit === "number") setMemLimit(data.limit)
      setMemLoaded(true)
    } catch {}
  }
  const addMemory = async () => {
    const content = memNew.trim()
    if (!content) return
    try {
      const res = await fetch("/api/chat-hub/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, category: memNewCat.trim() || undefined }),
      })
      const data = await res.json()
      if (res.ok && data.entry) {
        setMemEntries(prev => [data.entry, ...prev])
        setMemNew(""); setMemNewCat("")
      }
    } catch {}
  }
  const saveMemoryEdit = async (id: number) => {
    const content = memEditText.trim()
    if (!content) return
    try {
      const res = await fetch(`/api/chat-hub/memory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })
      if (res.ok) {
        setMemEntries(prev => prev.map(m => (m.id === id ? { ...m, content } : m)))
        setMemEditId(null)
      }
    } catch {}
  }
  const deleteMemory = async (id: number) => {
    try {
      const res = await fetch(`/api/chat-hub/memory/${id}`, { method: "DELETE" })
      if (res.ok) setMemEntries(prev => prev.filter(m => m.id !== id))
    } catch {}
  }

  // Instagram connection status — fetched lazily the first time a
  // publish_instagram approval appears (shows "→ @username" on the card)
  const [igUsername, setIgUsername] = useState<string | null>(null)
  const igStatusRequested = useRef(false)
  useEffect(() => {
    const hasPublish = messages.some(m =>
      m.pendingApproval?.calls?.some(c => c.toolName === "publish_instagram"))
    if (!hasPublish || igStatusRequested.current) return
    igStatusRequested.current = true
    fetch("/api/chat-hub/instagram")
      .then(r => r.json())
      .then(d => setIgUsername(typeof d?.username === "string" && d.username ? d.username : null))
      .catch(() => {})
  }, [messages])

  // rename / delete UI state — key format "p-<id>" | "c-<id>"
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const activeChatIdRef = useRef<number | null>(null)
  useEffect(() => { activeChatIdRef.current = activeChatId }, [activeChatId])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Fit the hub exactly to the visible space below the taskbar and lock the
  // page itself: only the chat (and sidebar) scroll. Measuring the shell's
  // real offset + the visual viewport handles wrapped/taller taskbars and
  // iPad Safari's toolbars/keyboard, where a fixed "100vh - 48px" guess
  // let the whole document scroll (header slid behind the taskbar,
  // Providers dropped off-screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellHeight, setShellHeight] = useState("calc(100dvh - 48px)")
  useEffect(() => {
    window.scrollTo(0, 0)
    const prevBody = document.body.style.overflow
    const prevHtml = document.documentElement.style.overflow
    const prevOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = "hidden"
    document.documentElement.style.overflow = "hidden"
    document.body.style.overscrollBehavior = "none"
    const measure = () => {
      const top = shellRef.current?.getBoundingClientRect().top ?? 48
      const viewport = window.visualViewport?.height ?? window.innerHeight
      setShellHeight(`${Math.max(240, Math.round(viewport - top))}px`)
    }
    // iOS Safari ignores body overflow:hidden for rubber-band scrolls and
    // keyboard-focus pans — the document creeps upward (taskbar + chat header
    // slide behind the Safari chrome) and, with the page "unscrollable",
    // nothing brings it back. Snap the window back to the top whenever any
    // document-level scroll sneaks in, then re-measure the shell.
    let snapQueued = false
    const snapBack = () => {
      if (snapQueued) return
      snapQueued = true
      requestAnimationFrame(() => {
        snapQueued = false
        if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) {
          window.scrollTo(0, 0)
        }
        measure()
      })
    }
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", snapBack, { passive: true })
    window.visualViewport?.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("scroll", snapBack)
    return () => {
      document.body.style.overflow = prevBody
      document.documentElement.style.overflow = prevHtml
      document.body.style.overscrollBehavior = prevOverscroll
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", snapBack)
      window.visualViewport?.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("scroll", snapBack)
    }
  }, [])
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadSidebar = useCallback(async () => {
    try {
      const res = await fetch("/api/chat-hub/projects", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      setProjects(data.projects ?? [])
      setLooseChats(data.looseChats ?? [])
    } catch { /* ignore — sidebar keeps last state */ }
    finally { setSidebarLoaded(true) }
  }, [])

  useEffect(() => { loadSidebar() }, [loadSidebar])

  // The server auto-titles a chat a few seconds after its FIRST reply lands
  // (flash-lite call after the stream closes) — refetch the sidebar once
  // more shortly after a run ends and sync the header title if still open
  const syncTitlesLater = useCallback((chatId: number) => {
    setTimeout(async () => {
      try {
        const res = await fetch("/api/chat-hub/projects", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()
        const projects: Project[] = data.projects ?? []
        const loose: ChatSummary[] = data.looseChats ?? []
        setProjects(projects)
        setLooseChats(loose)
        const found = loose.find(c => c.id === chatId) ?? projects.flatMap(p => p.chats).find(c => c.id === chatId)
        if (found && activeChatIdRef.current === chatId) setActiveChatTitle(found.title)
      } catch { /* sidebar keeps last state */ }
    }, 4500)
  }, [])

  const openChat = useCallback(async (chatId: number) => {
    abortRef.current?.abort()
    stopAwaitPoll()
    // Carry the composer with the chat it belongs to: bank what is in the box
    // for the chat being left, then restore whatever was pending in the one
    // being opened.
    if (draftsLoadedRef.current) {
      const leaving = draftKey(activeChatIdRef.current)
      const typed = inputRef.current?.value ?? ""
      if (typed.trim()) draftsRef.current[leaving] = typed
      else delete draftsRef.current[leaving]
      persistDrafts(true)
      const incoming = draftsRef.current[draftKey(chatId)] ?? ""
      setInput(incoming)
      if (inputRef.current) inputRef.current.style.height = "auto"
    }
    setActiveChatId(chatId)
    setChatLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/chat-hub/chats/${chatId}`, { cache: "no-store" })
      if (!res.ok) {
        setActiveChatId(null)
        try { localStorage.removeItem("chat-hub-active-chat") } catch {}
        return
      }
      // Survive refreshes: reopen this chat on the next mount
      try { localStorage.setItem("chat-hub-active-chat", String(chatId)) } catch {}
      const data = await res.json()
      setActiveChatTitle(data.chat.title)
      // Accept built-ins, custom gateway ids, or self-hosted / OpenRouter ids
      // (ollama/, runpod/, openrouter/ — these can carry a second slash, which
      // CUSTOM_MODEL_ID_RE rejects, so match the prefix explicitly)
      const known = data.chat.model && (
        CHAT_HUB_MODELS.some(m => m.id === data.chat.model)
        || CUSTOM_MODEL_ID_RE.test(data.chat.model)
        || /^(ollama|runpod|openrouter)\//.test(data.chat.model)
      )
      setModel(known ? data.chat.model : DEFAULT_CHAT_MODEL)
      setAgentModeState(data.chat.agentMode === "plan" || data.chat.agentMode === "approved" ? data.chat.agentMode : "accept")
      setChatSkills(Array.isArray(data.chat.skills)
        ? data.chat.skills.filter((s: any) => typeof s === "string" && ALL_SKILL_IDS.includes(s))
        : null)
      setMessages(mapServerMessages(data.messages))
      setSpDraft(data.chat.systemPrompt ?? "")
      setSpSaved(data.chat.systemPrompt ?? "")
      historyIndexRef.current = null // history recall is per-chat
      stickToBottomRef.current = true

      // A run was cut off by a reload/tab close but the server keeps going and
      // now also persists LIVE progress (liveRun on the triggering row). Poll
      // and render the reply as it happens — no static "reconnecting" state.
      const raw: any[] = data.messages ?? []
      const lastRaw = raw[raw.length - 1]
      const lastAge = lastRaw?.createdAt ? Date.now() - new Date(lastRaw.createdAt).getTime() : Infinity
      const lrOf = (r: any) =>
        r?.metadata?.liveRun && typeof r.metadata.liveRun.updatedAt === "number" ? r.metadata.liveRun : null
      // The driver refreshes updatedAt at least every ~20s (heartbeats), so
      // 90s of silence means the run is dead
      const lrFresh = (lr: any) => !!lr && Date.now() - lr.updatedAt < 90_000
      const liveMsgFrom = (lr: any): Msg => ({
        id: "live-run",
        role: "assistant",
        content: typeof lr.text === "string" ? lr.text : "",
        textSegments: Array.isArray(lr.textSegments) ? lr.textSegments : (lr.text ? [String(lr.text)] : []),
        agentSteps: Array.isArray(lr.steps) ? lr.steps : [],
        model: typeof lr.model === "string" ? lr.model : undefined,
        imageUrls: [],
      } as Msg)
      const startLr = lrOf(lastRaw)
      if ((lastRaw?.role === "user" && lastAge < 6 * 60_000)
          || (lastRaw?.role === "assistant" && lrFresh(startLr))) {
        setAwaitingReply(true)
        markRunning(chatId, true)
        // Anchor the stopwatch to the run's true start (the triggering row's
        // createdAt) so the reconnect timer shows real elapsed time, not 0:00
        runBaseRef.current = 0
        runStartRef.current = lastRaw?.createdAt ? new Date(lastRaw.createdAt).getTime() : Date.now()
        setRunElapsedMs(Math.max(0, Date.now() - runStartRef.current))
        if (lastRaw.role === "user" && startLr) {
          setMessages(prev => [...prev, liveMsgFrom(startLr)])
        }
        let polls = 0
        awaitPollRef.current = setInterval(async () => {
          if (activeChatIdRef.current !== chatId) { stopAwaitPoll(); return }
          if (++polls > 240) { stopAwaitPoll(); markRunning(chatId, false); return }
          try {
            const r = await fetch(`/api/chat-hub/chats/${chatId}`, { cache: "no-store" })
            if (!r.ok) return
            const d = await r.json()
            const rows: any[] = d.messages ?? []
            const last = rows[rows.length - 1]
            const lr = lrOf(last)
            if (last?.role === "assistant" && !lr) {
              // Final reply landed → swap in the persisted truth
              stopAwaitPoll()
              markRunning(chatId, false)
              if (activeChatIdRef.current === chatId) {
                setMessages(mapServerMessages(rows))
                setActiveChatTitle(d.chat.title)
                loadSidebar()
              }
              return
            }
            if (last?.role === "assistant" && lr) {
              // Approval-continuation in flight: the row itself carries live
              // steps/segments — render it directly
              setMessages(mapServerMessages(rows))
              if (!lrFresh(lr)) { stopAwaitPoll(); markRunning(chatId, false) }
              return
            }
            if (last?.role === "user") {
              const l2 = lrOf(last)
              if (l2) {
                // Fresh-send run in flight: synthesize the streaming bubble
                const lm = liveMsgFrom(l2)
                setMessages([...mapServerMessages(rows), lm])
                if (!lrFresh(l2)) { stopAwaitPoll(); markRunning(chatId, false) }
              }
              // no liveRun yet → keep waiting (first write lands within ~2s)
            }
          } catch {}
        }, 2500)
      }
    } catch { setActiveChatId(null) }
    finally { setChatLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh survival: reopen the chat that was active before the reload
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chat-hub-active-chat")
      if (saved) {
        const id = parseInt(saved)
        if (!isNaN(id)) openChat(id)
      }
    } catch {}
  }, [openChat])

  // ── Auto-scroll (sticky unless the user scrolled up) ─────────────────────

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, chatLoading])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // ── Model menu outside-click ─────────────────────────────────────────────

  useEffect(() => {
    if (!modelMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [modelMenuOpen])

  // ── Project / chat CRUD ──────────────────────────────────────────────────

  const apiError = async (res: Response, action: string) => {
    const data = await res.json().catch(() => ({}))
    setError(`${action} failed: ${data.error || `HTTP ${res.status}`}`)
  }

  const createProject = async (name = "New project"): Promise<Project | null> => {
    const res = await fetch("/api/chat-hub/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) { await apiError(res, "Creating the project"); return null }
    const { project } = await res.json()
    const withChats = { ...project, chats: [] as ChatSummary[] }
    setProjects(prev => [withChats, ...prev])
    return withChats
  }

  const handleNewProject = async () => {
    setError(null)
    const project = await createProject()
    if (!project) return
    setRenamingKey(`p-${project.id}`)
    setRenameDraft("New project")
  }

  const createChat = async (projectId: number | null): Promise<ChatSummary | null> => {
    // The pinned default employee applies to every new chat (instructions,
    // skills, permission mode, and its bound model if it has one); without
    // one, a preset bound to the selected model still auto-applies
    const def = resolveDefaultEmployee()
    const boundPersona = def ? null : personas.find(p => p.modelId === model)
    const defModelOk = !!def?.modelId && (CHAT_HUB_MODELS.some(m => m.id === def.modelId) || customModels.some(m => m.id === def.modelId))
    const chatModel = def && defModelOk ? def.modelId! : model
    const res = await fetch("/api/chat-hub/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        model: chatModel,
        systemPrompt: def?.text || boundPersona?.text,
        agentMode: def?.agentMode ?? agentMode,
        ...(def ? { skills: def.skills ?? null } : {}),
      }),
    })
    if (!res.ok) { await apiError(res, "Creating the chat"); return null }
    const { chat } = await res.json()
    if (def) {
      if (defModelOk) setModel(chatModel)
      if (def.agentMode) setAgentMode(def.agentMode)
    }
    const summary = { id: chat.id, title: chat.title, model: chat.model, updatedAt: chat.updatedAt }
    if (projectId === null) {
      setLooseChats(prev => [summary, ...prev])
    } else {
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, chats: [summary, ...p.chats] } : p))
    }
    return chat
  }

  const handleNewChat = async (projectId: number | null) => {
    setError(null)
    const chat = await createChat(projectId)
    if (chat) {
      openChat(chat.id)
      closeSidebarOnMobile()
    }
  }

  const moveChat = async (chatId: number, targetProjectId: number | null) => {
    setMoveMenuChatId(null)
    const res = await fetch(`/api/chat-hub/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: targetProjectId }),
    })
    if (!res.ok) { await apiError(res, "Moving the chat"); return }
    loadSidebar()
  }

  const commitRename = async () => {
    if (!renamingKey) return
    const name = renameDraft.trim()
    const [kind, idStr] = renamingKey.split("-")
    const id = parseInt(idStr)
    setRenamingKey(null)
    if (!name) return
    if (kind === "p") {
      setProjects(prev => prev.map(p => (p.id === id ? { ...p, name } : p)))
      const res = await fetch(`/api/chat-hub/projects/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      })
      if (!res.ok) await apiError(res, "Renaming the project")
    } else {
      setProjects(prev => prev.map(p => ({ ...p, chats: p.chats.map(c => (c.id === id ? { ...c, title: name } : c)) })))
      setLooseChats(prev => prev.map(c => (c.id === id ? { ...c, title: name } : c)))
      if (id === activeChatId) setActiveChatTitle(name)
      const res = await fetch(`/api/chat-hub/chats/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: name }),
      })
      if (!res.ok) await apiError(res, "Renaming the chat")
    }
  }

  const requestDelete = (key: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmKey(key)
    confirmTimerRef.current = setTimeout(() => setConfirmKey(null), 3000)
  }

  const confirmDelete = async (key: string) => {
    setConfirmKey(null)
    const [kind, idStr] = key.split("-")
    const id = parseInt(idStr)
    if (kind === "p") {
      const project = projects.find(p => p.id === id)
      if (project?.chats.some(c => c.id === activeChatId)) {
        abortRef.current?.abort()
        setActiveChatId(null)
        setMessages([])
        try { localStorage.removeItem("chat-hub-active-chat") } catch {}
      }
      setProjects(prev => prev.filter(p => p.id !== id))
      const res = await fetch(`/api/chat-hub/projects/${id}`, { method: "DELETE" })
      if (!res.ok) { await apiError(res, "Deleting the project"); loadSidebar() }
    } else {
      if (id === activeChatId) {
        abortRef.current?.abort()
        setActiveChatId(null)
        setMessages([])
        try { localStorage.removeItem("chat-hub-active-chat") } catch {}
      }
      setProjects(prev => prev.map(p => ({ ...p, chats: p.chats.filter(c => c.id !== id) })))
      setLooseChats(prev => prev.filter(c => c.id !== id))
      const res = await fetch(`/api/chat-hub/chats/${id}`, { method: "DELETE" })
      if (!res.ok) { await apiError(res, "Deleting the chat"); loadSidebar() }
    }
  }

  // ── Send / stream ────────────────────────────────────────────────────────

  // Quietly re-sync the transcript from the DB (no loading flicker) — picks up
  // tool-generated images and server-side auto-titles after a stream completes
  const reloadMessages = async (chatId: number) => {
    try {
      const res = await fetch(`/api/chat-hub/chats/${chatId}`, { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (activeChatIdRef.current === chatId) {
        setMessages(mapServerMessages(data.messages))
        // Instructions may have changed server-side (agent edit_instructions);
        // keep the panel in sync unless the user has an unsaved draft
        const sp = (data.chat?.systemPrompt ?? "") as string
        if (sp.trim() !== spSaved.trim()) {
          if (spDraft.trim() === spSaved.trim()) setSpDraft(sp)
          setSpSaved(sp.trim())
        }
      }
    } catch {}
  }

  // Shared NDJSON event-stream reader: applies agent events (text deltas,
  // step cards, approval requests) to the message bubble identified by
  // `targetId`, swapping its id to the real DB id when known.
  const streamInto = async (res: Response, targetId: number | string) => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let currentId: number | string = targetId
    let segments: string[] = []
    let steps: AgentStep[] = []
    let startedSegment = false

    // Seed accumulators from the existing bubble (approval continuations)
    setMessages(prev => {
      const m = prev.find(x => x.id === targetId)
      if (m) {
        segments = m.textSegments ? [...m.textSegments] : (m.content ? [m.content] : [])
        steps = m.agentSteps ? [...m.agentSteps] : []
      }
      return prev
    })

    const patch = (fn: (m: Msg) => Msg) =>
      setMessages(prev => prev.map(m => (m.id === currentId ? fn(m) : m)))

    const applyEvent = (ev: StreamEvent) => {
      switch (ev.t) {
        case "text": {
          // Each stream (initial send / each approval continuation) is its own
          // text segment — rendered as a distinct sub-card
          if (!startedSegment) { segments.push(""); startedSegment = true }
          segments[segments.length - 1] += ev.d
          const joined = segments.join("\n\n")
          const segsCopy = [...segments]
          patch(m => ({ ...m, content: joined, textSegments: segsCopy }))
          break
        }
        case "step":
          steps = steps.some(s => s.id === ev.s.id)
            ? steps.map(s => (s.id === ev.s.id ? ev.s : s))
            : [...steps, ev.s]
          patch(m => ({
            ...m,
            agentSteps: steps,
            ...(ev.s.imageUrl && !(m.imageUrls ?? []).includes(ev.s.imageUrl)
              ? { imageUrls: [...(m.imageUrls ?? []), ev.s.imageUrl] }
              : {}),
          }))
          break
        case "approval":
          patch(m => ({ ...m, pendingApproval: { calls: ev.calls } }))
          setMessages(prev => prev.map(m => (m.id === currentId ? { ...m, id: ev.messageId } : m)))
          currentId = ev.messageId
          break
        case "done":
          if (ev.messageId !== null && ev.messageId !== currentId) {
            setMessages(prev => prev.map(m => (m.id === currentId ? { ...m, id: ev.messageId! } : m)))
            currentId = ev.messageId
          }
          break
        case "error":
          setError(ev.message)
          break
      }
    }

    // Stall guard: the server heartbeats every 20s, so >75s of total silence
    // means the connection is dead (Safari on LAN IPs drops streams without
    // erroring — the read then hangs forever and the composer stays locked
    // until a manual refresh). Abort → the existing reconnect logic reloads
    // the persisted reply.
    let lastChunkAt = Date.now()
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > 75_000) {
        try { abortRef.current?.abort() } catch {}
        try { reader.cancel() } catch {}
      }
    }, 15_000)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lastChunkAt = Date.now()
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          try { applyEvent(JSON.parse(line)) } catch {}
        }
      }
    } finally {
      clearInterval(stallTimer)
    }
    return { text: segments.join("\n\n"), steps }
  }

  const sendMessage = async (chatId: number, content: string, extraImages: string[] = [], modelOverride?: string) => {
    if (streaming) return
    stopAwaitPoll()
    const mdl = modelOverride ?? model
    if (modelOverride) setModel(modelOverride)
    setError(null)
    runBaseRef.current = 0
    runStartRef.current = Date.now()
    setRunElapsedMs(0)
    markRunning(chatId, true)
    setStreaming(true)
    stickToBottomRef.current = true

    // Attached refs: permanent https URLs only, clamped to the model's cap.
    // extraImages (e.g. viewer "Edit" flow) take priority over active refs.
    const maxImages = CHAT_HUB_MODELS.find(m => m.id === mdl)?.maxImages ?? 8
    const attachedUrls = [
      ...extraImages,
      ...activeRefs.map(r => r.url).filter(u => u.startsWith("https://") && !extraImages.includes(u)),
    ].slice(0, maxImages)

    // Auto-clear mode: refs detach the moment the message leaves (they stay
    // in the refs library) — the pin toggle keeps them attached instead
    if (!keepRefsOnSend && onRemoveRef && activeRefs.length > 0) {
      for (const r of activeRefs) onRemoveRef(r.id)
    }

    const assistantKey = `pending-${Date.now()}`
    setMessages(prev => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content, imageUrls: attachedUrls },
      { id: assistantKey, role: "assistant", content: "", model: mdl },
    ])

    const controller = new AbortController()
    abortRef.current = controller
    let aborted = false

    try {
      const res = await fetch(`/api/chat-hub/chats/${chatId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content, model: mdl,
          route: routeForModel(mdl),     // back-compat single route
          routes: routing,               // full per-provider map (sub-delegations)
          imageUrls: attachedUrls,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      const { text, steps } = await streamInto(res, assistantKey)
      if (!text.trim() && steps.length === 0) {
        setMessages(prev => prev.map(m => (m.id === assistantKey
          ? { ...m, content: "*(no response — the model returned nothing; check the gateway logs)*" } : m)))
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        aborted = true
      } else {
        setMessages(prev => prev.filter(m => m.id !== assistantKey))
        setError(err?.message || "Something went wrong")
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      // Aborted-by-navigation streams keep generating server-side — leave the
      // running indicator on; the background sweep clears it when done
      if (!aborted) markRunning(chatId, false)
      // Sidebar picks up auto-title + reordering; an aborted stream still
      // persists server-side, so reconcile the transcript from the DB.
      if (aborted && activeChatIdRef.current === chatId) {
        setTimeout(() => openChat(chatId), 700)
      } else {
        loadSidebar()
        // Reconcile ids/steps/images from the DB
        reloadMessages(chatId)
      }
    }
  }

  // Ask-mode approvals: run/deny the paused tool calls; the continuation
  // streams into the SAME assistant bubble.
  const respondToApprovals = async (
    messageId: number,
    approvals: {
      toolCallId: string
      approved: boolean
      settings?: Record<string, string>
      answers?: { question: string; answer: string }[]
      budget_override?: number
      note?: string
    }[],
    extra?: { autoApproveEdits?: boolean },
  ) => {
    if (streaming || !activeChatId) return
    stopAwaitPoll()
    const chatId = activeChatId
    setError(null)
    // Resume the stopwatch from this reply's persisted runtime
    runBaseRef.current = messages.find(x => x.id === messageId)?.runMs ?? 0
    runStartRef.current = Date.now()
    setRunElapsedMs(runBaseRef.current)
    markRunning(chatId, true)
    setStreaming(true)
    stickToBottomRef.current = true
    // Clear the approval UI immediately
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, pendingApproval: null } : m)))
    try {
      const res = await fetch(`/api/chat-hub/chats/${chatId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, approvals, routes: routing, ...(extra?.autoApproveEdits ? { autoApproveEdits: true } : {}) }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      await streamInto(res, messageId)
    } catch (err: any) {
      setError(err?.message || "Continuation failed")
    } finally {
      setStreaming(false)
      markRunning(chatId, false)
      loadSidebar()
      syncTitlesLater(chatId)
      reloadMessages(chatId)
    }
  }

  // Queue auto-flush: once nothing is streaming and no approval is pending,
  // send the next queued message
  useEffect(() => {
    if (streaming || queued.length === 0 || !activeChatId) return
    if (messages.some(m => m.pendingApproval?.calls?.length)) return
    const [next, ...rest] = queued
    setQueued(rest)
    sendMessage(activeChatId, next.content, next.extraImages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, queued, messages, activeChatId])

  // Queued messages don't survive switching chats
  useEffect(() => { setQueued([]) }, [activeChatId])

  // Re-send the user turn that produced this assistant reply, on another model
  const retryWith = (assistantId: number | string, modelId: string) => {
    setRetryMenuMsgId(null)
    if (!activeChatId || streaming) return
    const idx = messages.findIndex(m => m.id === assistantId)
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content) {
        sendMessage(
          activeChatId,
          messages[i].content,
          (messages[i].imageUrls ?? []).filter(u => u.startsWith("https://")),
          modelId,
        )
        return
      }
    }
  }

  // Direct media generation (create mode) — no LLM involved: prompt + model
  // straight into the studio's FAL pipeline via the create route
  const sendCreate = async (chatId: number, prompt: string, spec: ChatCreateModel) => {
    if (streaming) return
    // Clamp to the model's own reference limit (0 = model takes no refs)
    const refs = activeRefs
      .map(r => r.url)
      .filter(u => u.startsWith("https://"))
      .slice(0, spec.maxRefs)
    if (spec.needsRef && refs.length === 0) {
      setError(`${spec.label} needs a reference image attached (it animates a start image)`)
      return
    }
    setError(null)
    // Same auto-clear behavior as regular sends (pin toggle keeps refs)
    if (!keepRefsOnSend && onRemoveRef && activeRefs.length > 0) {
      for (const r of activeRefs) onRemoveRef(r.id)
    }
    setStreaming(true)
    stickToBottomRef.current = true

    markRunning(chatId, true)
    const pendingKey = `pending-${Date.now()}`
    setMessages(prev => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content: prompt, imageUrls: refs },
      { id: pendingKey, role: "assistant", content: "", model: spec.id },
    ])

    try {
      const res = await fetch(`/api/chat-hub/chats/${chatId}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, createModelId: spec.id, imageUrls: refs, settings: createSettings }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${res.status})`)
      }
      const { url } = await res.json()
      setMessages(prev => prev.map(m => (m.id === pendingKey ? { ...m, imageUrls: [url] } : m)))
    } catch (err: any) {
      setMessages(prev => prev.filter(m => m.id !== pendingKey))
      setError(err?.message || "Generation failed")
    } finally {
      setStreaming(false)
      markRunning(chatId, false)
      loadSidebar()
      syncTitlesLater(chatId)
      if (activeChatIdRef.current === chatId) reloadMessages(chatId)
    }
  }

  // Composer send for the currently open chat. With queue mode on, sending
  // while an approval is pending (or something is streaming) queues the
  // message instead of denying the pending request.
  const send = () => {
    const content = input.trim()
    if (!content || !activeChatId) return
    // Armed edit: this message edits the viewer image/canvas (overrides createMode)
    if (pendingEdit) {
      if (streaming) return
      const msg = buildLayeredEditMessage(content, pendingEdit.recipeJson)
      const url = pendingEdit.url
      setPendingEdit(null)
      setInput("")
      clearDraft(activeChatId)
      if (inputRef.current) inputRef.current.style.height = "auto"
      sendMessage(activeChatId, msg, [url])
      return
    }
    const pendingApprovalExists = messages.some(m => m.pendingApproval?.calls?.length)
    if (queueMode && !createMode && (pendingApprovalExists || streaming)) {
      setQueued(prev => [...prev, { content, extraImages: [] }])
      setInput("")
      clearDraft(activeChatId)
      if (inputRef.current) inputRef.current.style.height = "auto"
      return
    }
    if (streaming) return
    setInput("")
    clearDraft(activeChatId)
    if (inputRef.current) inputRef.current.style.height = "auto"
    if (createMode) sendCreate(activeChatId, content, createMode)
    else sendMessage(activeChatId, content)
  }

  // Empty-state send: no chat selected yet — spin up (project +) chat, then send.
  // Uses the most recent project, or creates a default one on first ever use.
  const startNewChat = async () => {
    const content = input.trim()
    if (!content || streaming) return
    setError(null)
    // Starts as a standalone chat — movable into a project later
    const chat = await createChat(null)
    if (!chat) return
    setInput("")
    // The "new chat" draft became this chat's first message
    clearDraft(null)
    if (inputRef.current) inputRef.current.style.height = "auto"
    setActiveChatId(chat.id)
    activeChatIdRef.current = chat.id
    setActiveChatTitle(chat.title)
    setMessages([])
    setChatSkills(null) // fresh chats start as Full Studio
    const boundPersona = personas.find(p => p.modelId === model)
    setSpDraft(boundPersona?.text ?? "")
    setSpSaved(boundPersona?.text ?? "")
    if (pendingEdit) {
      const msg = buildLayeredEditMessage(content, pendingEdit.recipeJson)
      const url = pendingEdit.url
      setPendingEdit(null)
      sendMessage(chat.id, msg, [url])
    } else if (createMode) sendCreate(chat.id, content, createMode)
    else sendMessage(chat.id, content)
  }

  // Auto-deactivate reference images after each send (composer pin toggle;
  // the refs stay in the library either way — only activation clears)
  const [keepRefsOnSend, setKeepRefsOnSend] = useState(false)
  useEffect(() => {
    try { setKeepRefsOnSend(localStorage.getItem("chat-hub-keep-refs") === "on") } catch {}
  }, [])
  const toggleKeepRefs = () => setKeepRefsOnSend(v => {
    const next = !v
    try { localStorage.setItem("chat-hub-keep-refs", next ? "on" : "off") } catch {}
    return next
  })

  // Stop = GRACEFUL server-side cancel: the run flag is set, any in-flight
  // generation/edit finishes, then the model gets no further rounds and the
  // reply persists marked "Canceled". We keep reading the stream so the
  // wind-down renders live (aborting the reader would just disconnect us —
  // the old behavior, which let the server run to completion anyway).
  const [cancelPending, setCancelPending] = useState(false)
  const stopStreaming = () => {
    const id = activeChatIdRef.current
    if (!id) { abortRef.current?.abort(); return }
    setCancelPending(true)
    fetch(`/api/chat-hub/chats/${id}/cancel`, { method: "POST" }).catch(() => {})
  }
  useEffect(() => { if (!streaming) setCancelPending(false) }, [streaming])

  // ── Sent-message history recall (shell-style) ────────────────────────────
  // Up from an EMPTY composer loads your last sent message; while browsing,
  // Up/Down walk older/newer. Down past the newest restores the stashed draft.
  // Typing anything exits browsing (handled in the textarea onChange).
  const historyIndexRef = useRef<number | null>(null)
  const historyDraftRef = useRef("")

  const applyHistoryText = (text: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      const ta = inputRef.current
      if (!ta) return
      autoGrow(ta)
      ta.setSelectionRange(text.length, text.length)
    })
  }

  const handleComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      historyIndexRef.current = null
      if (activeChatId) send()
      else startNewChat()
      return
    }

    const browsing = historyIndexRef.current !== null
    // Up enters/continues history whenever the caret sits on the FIRST line of
    // the draft (always true for single-line input). Below the first line it
    // stays a normal cursor key for editing multiline text.
    const ta = e.currentTarget
    const caretOnFirstLine = !ta.value.slice(0, ta.selectionStart ?? 0).includes("\n")
    if (e.key === "ArrowUp" && (browsing || caretOnFirstLine)) {
      const sent = messages.filter(m => m.role === "user" && m.content).map(m => m.content)
      if (sent.length === 0) return
      e.preventDefault()
      if (!browsing) historyDraftRef.current = input // preserve the typed draft
      const idx = browsing ? Math.max(0, historyIndexRef.current! - 1) : sent.length - 1
      historyIndexRef.current = idx
      applyHistoryText(sent[idx])
      return
    }
    if (e.key === "ArrowDown" && browsing) {
      const sent = messages.filter(m => m.role === "user" && m.content).map(m => m.content)
      e.preventDefault()
      const idx = historyIndexRef.current! + 1
      if (idx >= sent.length) {
        historyIndexRef.current = null
        applyHistoryText(historyDraftRef.current)
      } else {
        historyIndexRef.current = idx
        applyHistoryText(sent[idx])
      }
    }
  }

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 320) + "px"
  }

  const toggleProject = (id: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── Render helpers ───────────────────────────────────────────────────────

  const renameInput = (
    <input
      autoFocus
      value={renameDraft}
      onChange={e => setRenameDraft(e.target.value)}
      onBlur={commitRename}
      onKeyDown={e => {
        if (e.key === "Enter") commitRename()
        if (e.key === "Escape") setRenamingKey(null)
      }}
      maxLength={80}
      className="flex-1 min-w-0 bg-black/40 border border-cyan-500/40 rounded px-1.5 py-0.5 text-xs text-white outline-none"
      onClick={e => e.stopPropagation()}
    />
  )

  const rowActions = (key: string, onRename: () => void) => (
    <span className="flex items-center gap-0.5 shrink-0">
      {confirmKey === key ? (
        <button
          onClick={e => { e.stopPropagation(); confirmDelete(key) }}
          className="p-1 rounded text-red-400 hover:bg-red-500/20"
          title="Confirm delete"
        >
          <Check size={12} />
        </button>
      ) : (
        <>
          <button
            onClick={e => { e.stopPropagation(); onRename() }}
            className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10"
            title="Rename"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); requestDelete(key) }}
            className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </>
      )}
    </span>
  )

  const activeModel = CHAT_HUB_MODELS.find(m => m.id === model)
  // The employee to auto-apply to a new chat: built-in, app-style, or saved
  const resolveDefaultEmployee = (): Persona | null => {
    if (!defaultEmployeeId) return null
    const b = BUILT_IN_EMPLOYEES.find(e => e.id === defaultEmployeeId)
    if (b) return { id: b.id, name: b.name, text: b.text, modelId: null, skills: b.skills.length === ALL_SKILL_IDS.length ? null : b.skills, agentMode: null }
    if (defaultEmployeeId === "emp-app-style") {
      return { id: "emp-app-style", name: "App-Style Chat", text: activeModel ? appStyleInstructions(activeModel) : "", modelId: null, skills: null, agentMode: null }
    }
    return personas.find(p => p.id === defaultEmployeeId) ?? null
  }
  const providers = CHAT_HUB_PROVIDERS
  // Ref limit follows whatever will consume the next message: the armed create
  // model's scanner cap, or the LLM's vision input cap
  const maxImagesForModel = createMode ? createMode.maxRefs : (activeModel?.maxImages ?? 8)

  useEffect(() => {
    onRefCapChange?.(maxImagesForModel)
  }, [maxImagesForModel, onRefCapChange])

  // "+" menu: upload refs into the library, or arm a create-image/video mode
  const renderPlusMenu = (dir: "up" | "down") => (
    <div className="relative" ref={plusMenuRef}>
      <button
        onClick={() => setPlusMenu(m => (m ? null : "root"))}
        className={`p-1.5 rounded-lg border transition-all ${
          plusMenu
            ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300 rotate-45"
            : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
        }`}
        title="Add references or create media"
      >
        <Plus size={14} />
      </button>
      {plusMenu && (
        <div className={`absolute left-0 w-60 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-50 py-1.5 max-h-[40vh] overflow-y-auto ${
          dir === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}>
          {plusMenu === "root" ? (
            <>
              <button
                onClick={() => { setPlusMenu(null); fileInputRef.current?.click() }}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white text-left"
              >
                <Upload size={13} className="text-cyan-400 shrink-0" />
                <span className="flex-1">Upload references</span>
              </button>
              <button
                onClick={() => setPlusMenu("image")}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white text-left"
              >
                <ImageIcon size={13} className="text-fuchsia-400 shrink-0" />
                <span className="flex-1">Create image</span>
                <ChevronRight size={12} className="text-slate-600" />
              </button>
              <button
                onClick={() => setPlusMenu("video")}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white text-left"
              >
                <Clapperboard size={13} className="text-amber-400 shrink-0" />
                <span className="flex-1">Create video</span>
                <ChevronRight size={12} className="text-slate-600" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setPlusMenu("root")}
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] text-slate-500 hover:text-white text-left"
              >
                <ChevronRight size={11} className="rotate-180" /> Back
              </button>
              {/* Grouped by provider, mirroring the taskbar Image/Video dropdowns */}
              {[...new Set(usableCreateModels(true).filter(m => m.kind === plusMenu).map(m => m.group))].map(group => {
                const meta = CHAT_CREATE_GROUPS[group] ?? { accent: "text-slate-400", dot: "bg-slate-400" }
                return (
                  <div key={group}>
                    <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${meta.accent}`}>{group}</span>
                    </div>
                    {usableCreateModels(true).filter(m => m.kind === plusMenu && m.group === group).map(m => (
                      <button
                        key={m.id}
                        disabled={!!m.disabled}
                        onClick={() => { if (!m.disabled) { armCreateMode(m); setPlusMenu(null) } }}
                        title={m.disabled ? `Not available in chat yet — ${m.disabled}` : undefined}
                        className={`flex items-center gap-2 w-full pl-6 pr-3 py-1.5 text-xs text-left ${
                          m.disabled
                            ? "text-slate-600 cursor-not-allowed"
                            : createMode?.id === m.id
                              ? "text-cyan-300 bg-cyan-500/10"
                              : "text-slate-300 hover:bg-white/5 hover:text-white"
                        }`}
                      >
                        <span className="flex-1 truncate">{m.label}</span>
                        {m.disabled ? (
                          <span className="shrink-0 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] text-slate-600">
                            {m.disabled}
                          </span>
                        ) : (
                          <>
                            <span className="shrink-0 flex items-center gap-0.5 text-[9px] text-cyan-400/80 tabular-nums" title={`${m.ticketCost} tickets per generation`}>
                              <Ticket size={9} />{m.ticketCost}
                            </span>
                            {m.needsRef && (
                              <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[9px] text-amber-300">
                                needs ref
                              </span>
                            )}
                            {m.noRefs && (
                              <span className="shrink-0 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] text-slate-500">
                                no refs
                              </span>
                            )}
                            {createMode?.id === m.id && <Check size={12} className="shrink-0" />}
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )

  // Live cost for the armed create mode at the current settings
  const createCost = createMode ? computeCreateCost(createMode, createSettings) : 0

  // Armed create mode — chip + the model's own settings (mirrors its scanner
  // prompt box: aspect ratio, quality, duration, audio, …)
  const createChip = createMode ? (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
      <span className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-fuchsia-500/10 border border-fuchsia-500/30 text-[11px] text-fuchsia-300">
        {createMode.kind === "image" ? <ImageIcon size={11} /> : <Clapperboard size={11} />}
        Creating {createMode.kind} · {createMode.label}
        <span className="flex items-center gap-0.5 text-[10px] text-cyan-300 tabular-nums" title={`${createCost} tickets at these settings`}>
          <Ticket size={10} />{createCost}
        </span>
        <button
          onClick={() => setCreateMode(null)}
          className="p-0.5 rounded hover:bg-white/10 text-fuchsia-300/70 hover:text-white"
          title="Back to chat mode"
        >
          <X size={10} />
        </button>
      </span>
      {(createMode.fields ?? []).map(f => (
        <label key={f.key} className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          {f.label}
          <select
            value={createSettings[f.key] ?? f.def}
            onChange={e => setCreateSettings(prev => ({ ...prev, [f.key]: e.target.value }))}
            className="bg-slate-900 border border-white/10 rounded-md px-1.5 py-1 text-[11px] font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-cyan-500/40"
          >
            {f.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ))}
    </div>
  ) : null

  // Armed-edit chip — shows the image being edited; removable to cancel.
  const editChip = pendingEdit ? (
    <div className="flex items-center gap-1.5 pb-1.5">
      <span className="flex items-center gap-2 pl-1 pr-1 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-[11px] text-cyan-300">
        {pendingEdit.isVideo ? (
          <span className="w-6 h-6 rounded-md bg-black/40 border border-white/10 flex items-center justify-center shrink-0">
            <Clapperboard size={12} />
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pendingEdit.url} alt="Editing" className="w-6 h-6 rounded-md object-cover border border-white/10 shrink-0" />
        )}
        <span className="flex items-center gap-1">
          <Pencil size={11} />
          {pendingEdit.recipeJson ? "Editing this canvas" : "Editing this image"}
        </span>
        <button
          onClick={() => setPendingEdit(null)}
          className="p-0.5 rounded hover:bg-white/10 text-cyan-300/70 hover:text-white"
          title="Cancel edit — send a normal message instead"
        >
          <X size={11} />
        </button>
      </span>
    </div>
  ) : null

  const composerPlaceholder = pendingEdit
    ? `Describe the edit to ${pendingEdit.recipeJson ? "this canvas" : "this image"}…`
    : createMode
      ? `Describe the ${createMode.kind} to create with ${createMode.label}…`
      : `Message ${activeModel?.label ?? "the model"}…`

  // Movie runtime for the Movie Studio employee. Only rendered when this chat
  // has the movie-production skill on, so it never clutters the composer for
  // anyone else. Persisted per account (no per-chat column exists) through the
  // same shallow-merge preferences endpoint the rest of the hub uses.
  const movieSkillOn = chatSkills === null || chatSkills.includes("movie-production")
  const setMovieFormat = (id: string) => {
    setMovieFormatState(id)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubMovieFormat: id }),
    }).catch(() => {})
  }
  const movieFormatChip = movieSkillOn ? (
    <label className="flex items-center gap-1 shrink-0" title="How long a film the Movie Studio plans for">
      <span className="text-[10px] text-slate-500">🎞️</span>
      <select
        value={movieFormat}
        onChange={e => setMovieFormat(e.target.value)}
        className="rounded-lg border border-white/10 bg-slate-950 px-1.5 py-1.5 text-[10px] text-slate-300 focus:outline-none focus:border-white/30"
      >
        {MOVIE_FORMATS.map(f => (
          <option key={f.id} value={f.id}>
            {f.id === "ask" ? f.label : `${f.label} · ${f.seconds}`}
          </option>
        ))}
      </select>
    </label>
  ) : null

  // Agent permission mode — plan / ask-before-tools / auto. Shown on both
  // composers; on the starter box the choice is applied to the new chat.
  const agentModeChip = (
    <div className="flex rounded-lg border border-white/10 overflow-hidden shrink-0">
      {AGENT_MODES.map((am, i) => (
        <button
          key={am.id}
          onClick={() => setAgentMode(am.id)}
          title={am.hint}
          className={`px-2 py-1.5 text-[10px] transition-colors ${i > 0 ? "border-l border-white/10" : ""} ${
            agentMode === am.id
              ? am.id === "plan"
                ? "bg-violet-500/15 text-violet-300"
                : am.id === "accept"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-emerald-500/15 text-emerald-300"
              : "text-slate-500 hover:text-white hover:bg-white/5"
          }`}
        >
          {am.label}
        </button>
      ))}
    </div>
  )

  // Refs toggled on in the taskbar Refs dropdown ride along with the next
  // message. Over-cap refs are dimmed and not sent.
  const refStrip = activeRefs.length > 0 ? (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
      {activeRefs.map((r, i) => (
        <div
          key={r.id}
          className={`relative w-9 h-9 rounded-md overflow-hidden border shrink-0 ${
            i < maxImagesForModel ? "border-cyan-500/30" : "border-red-500/40 opacity-40"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={refThumb(r.url)} alt="" className="w-full h-full object-cover" decoding="async"
            onError={e => thumbFallback(e, r.url)} />
          {onRemoveRef && (
            <button
              onClick={() => onRemoveRef(r.id)}
              className="absolute top-0 right-0 p-0.5 bg-black/70 rounded-bl-md text-white/70 hover:text-white"
              title="Remove from selection"
            >
              <X size={8} />
            </button>
          )}
        </div>
      ))}
      {maxImagesForModel === 0 ? (
        <span className="text-[9px] text-amber-400">
          {createMode?.label ?? "this model"} doesn&apos;t use reference images — none will be sent
        </span>
      ) : (
        <span className={`text-[9px] ${activeRefs.length > maxImagesForModel ? "text-amber-400" : "text-slate-600"}`}>
          {Math.min(activeRefs.length, maxImagesForModel)}/{maxImagesForModel} refs
          {activeRefs.length > maxImagesForModel && ` — only the first ${maxImagesForModel} are sent`}
        </span>
      )}
      <button
        onClick={toggleKeepRefs}
        className={`shrink-0 flex items-center gap-1 px-1.5 py-1 rounded-md border text-[9px] transition-colors ${
          keepRefsOnSend
            ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
            : "border-white/10 text-slate-500 hover:text-white hover:bg-white/10"
        }`}
        title={keepRefsOnSend
          ? "Refs stay attached after sending — tap to auto-clear after each send"
          : "Refs auto-clear after each send (they stay in your library) — tap to keep them attached"}
      >
        {keepRefsOnSend ? <Pin size={10} /> : <PinOff size={10} />}
        {keepRefsOnSend ? "keep" : "auto-clear"}
      </button>
      {uploadingRefs && <span className="text-[9px] text-cyan-400 animate-pulse">Uploading…</span>}
    </div>
  ) : uploadingRefs ? (
    <div className="pb-1.5 text-[10px] text-cyan-400 animate-pulse">Uploading references…</div>
  ) : null

  // Every chat across projects + standalone, newest activity first
  const feedChats = [
    ...looseChats.map(c => ({ ...c, projectName: null as string | null })),
    ...projects.flatMap(p => p.chats.map(c => ({ ...c, projectName: p.name as string | null }))),
  ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  // Target of a live stream = the last message (send appends it; approval
  // continuations stream into the trailing assistant row)
  const lastMsgId = messages.length ? messages[messages.length - 1].id : null

  // Sidebar search filters across every chat (title / model / project name)
  const searchQ = chatSearch.trim().toLowerCase()
  const visibleFeedChats = searchQ
    ? feedChats.filter(c =>
        c.title.toLowerCase().includes(searchQ)
        || labelFor(c.model).toLowerCase().includes(searchQ)
        || (c.projectName ?? "").toLowerCase().includes(searchQ))
    : feedChats

  // Single dropdown instance — rendered on the active-chat composer, or inside
  // the centered new-chat box otherwise (never both at once). "up" opens the
  // menu above the trigger (for the bottom composer).
  const renderModelDropdown = (dir: "up" | "down") => (
    <div className="relative" ref={modelMenuRef}>
      <button
        onClick={() => setModelMenuOpen(o => !o)}
        className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-lg text-xs border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 transition-colors"
      >
        <Sparkles size={12} className="text-cyan-400" />
        <span className="max-w-[120px] truncate">{labelFor(model)}</span>
        {/* Current provider route for this chat's model: Hub vs the provider's own API */}
        <span
          className={`shrink-0 px-1 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider border ${
            model.startsWith("ollama/")
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : model.startsWith("runpod/")
                ? "bg-violet-500/10 border-violet-500/30 text-violet-300"
                : model.startsWith("openrouter/")
                  ? "bg-sky-500/10 border-sky-500/30 text-sky-300"
                  : routeForModel(model) === "direct"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
          }`}
          title={model.startsWith("ollama/")
            ? "Served by your local Ollama — free, private"
            : model.startsWith("runpod/")
              ? "Served by your RunPod endpoint (rented GPU)"
              : model.startsWith("openrouter/")
                ? "Served via your OpenRouter key"
                : routeForModel(model) === "direct"
                  ? `Direct ${activeModel?.provider ?? ""} API (your key)`
                  : "Vercel AI Hub"}
        >
          {model.startsWith("ollama/") ? "Local" : model.startsWith("runpod/") ? "Pod" : model.startsWith("openrouter/") ? "OR" : routeForModel(model) === "direct" ? "API" : "Hub"}
        </span>
        {dir === "up" ? <ChevronDown size={12} className="text-slate-500 rotate-180" /> : <ChevronDown size={12} className="text-slate-500" />}
      </button>
      {modelMenuOpen && (
        <div className={`absolute left-0 w-60 max-h-[40vh] overflow-y-auto rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-50 py-1.5 ${
          dir === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}>
          {providers.map(provider => (
            <div key={provider}>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {provider}
              </div>
              {CHAT_HUB_MODELS.filter(m => m.provider === provider).map(m => (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setModelMenuOpen(false) }}
                  className={`flex items-center w-full px-3 py-1.5 text-xs text-left ${
                    m.id === model ? "text-cyan-300 bg-cyan-500/10" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="flex-1">{m.label}</span>
                  {m.id === model && <Check size={12} />}
                </button>
              ))}
            </div>
          ))}
          {ollamaModels.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Ollama (local)
              </div>
              {ollamaModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setModelMenuOpen(false) }}
                  title={`${m.id} — served by your local Ollama, free`}
                  className={`flex items-center w-full px-3 py-1.5 text-xs text-left ${
                    m.id === model ? "text-cyan-300 bg-cyan-500/10" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  <span className="text-[9px] text-emerald-400/70 pr-1.5">local</span>
                  {m.id === model && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
          {runpodModels.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                RunPod (rented GPU)
              </div>
              {runpodModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setModelMenuOpen(false) }}
                  title={`${m.id} — served by your RunPod endpoint`}
                  className={`flex items-center w-full px-3 py-1.5 text-xs text-left ${
                    m.id === model ? "text-cyan-300 bg-cyan-500/10" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  <span className="text-[9px] text-violet-400/80 pr-1.5">pod</span>
                  {m.id === model && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
          {openrouterModels.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                OpenRouter
              </div>
              {openrouterModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setModelMenuOpen(false) }}
                  title={`${m.id} — via your OpenRouter key`}
                  className={`flex items-center w-full px-3 py-1.5 text-xs text-left ${
                    m.id === model ? "text-cyan-300 bg-cyan-500/10" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  <span className="text-[9px] text-sky-400/80 pr-1.5">OR</span>
                  {m.id === model && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
          {customModels.length > 0 && (
            <div>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Custom
              </div>
              {customModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => { setModel(m.id); setModelMenuOpen(false) }}
                  title={`${m.id} — via Vercel AI Hub`}
                  className={`flex items-center w-full px-3 py-1.5 text-xs text-left ${
                    m.id === model ? "text-cyan-300 bg-cyan-500/10" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  {m.id === model && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={shellRef}
      style={{ height: shellHeight }}
      className="flex overflow-hidden relative"
    >
      {/* Hidden picker for the "+ → Upload references" flow */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ""
          handleUploadFiles(files)
        }}
      />
      {/* ── Sidebar: projects + chats ── */}
      {/* On phones it's a slide-over drawer above the chat (with backdrop);
          on sm+ it's the usual side-by-side column */}
      {sidebarOpen && (
        <>
          <div className="absolute inset-0 z-30 bg-black/60 sm:hidden" onClick={toggleSidebar} />
          <div className="absolute sm:static inset-y-0 left-0 z-40 sm:z-auto w-[85vw] max-w-[300px] sm:max-w-none sm:w-72 shrink-0 border-r border-white/5 bg-slate-950 sm:bg-slate-950/60 flex flex-col shadow-2xl sm:shadow-none">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Projects</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleNewChat(null)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cyan-300 border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
                title="New chat (outside projects)"
              >
                <MessageSquarePlus size={12} /> Chat
              </button>
              <button
                onClick={handleNewProject}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-slate-300 border border-white/10 bg-white/5 hover:bg-white/10 hover:text-white transition-colors"
                title="New project"
              >
                <FolderPlus size={12} /> Project
              </button>
            </div>
          </div>
          <div className="shrink-0 max-h-[36%] overflow-y-auto overscroll-contain py-1.5 border-b border-white/5">
            {!sidebarLoaded ? (
              <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
            ) : projects.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-slate-600 leading-relaxed">
                No projects yet — chats can live outside projects too.
              </div>
            ) : (
              projects.map(p => (
                <div key={p.id} className="mb-0.5">
                  <div
                    onClick={() => toggleProject(p.id)}
                    className="group flex items-center gap-1 px-2 py-1.5 mx-1.5 rounded-md cursor-pointer text-slate-300 hover:bg-white/5"
                  >
                    {collapsed.has(p.id)
                      ? <ChevronRight size={12} className="shrink-0 text-slate-500" />
                      : <ChevronDown size={12} className="shrink-0 text-slate-500" />}
                    {renamingKey === `p-${p.id}` ? renameInput : (
                      <span className="flex-1 min-w-0 truncate text-xs font-medium">{p.name}</span>
                    )}
                    {renamingKey !== `p-${p.id}` && rowActions(`p-${p.id}`, () => {
                      setRenamingKey(`p-${p.id}`); setRenameDraft(p.name)
                    })}
                  </div>
                  {!collapsed.has(p.id) && (
                    <div className="ml-4 mr-1.5 border-l border-white/5 pl-1.5">
                      {p.chats.map(c => (
                        <div
                          key={c.id}
                          onClick={() => { openChat(c.id); closeSidebarOnMobile() }}
                          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer ${
                            c.id === activeChatId
                              ? "bg-cyan-500/10 text-white border-l-2 border-cyan-400 -ml-[calc(0.375rem+2px)] pl-[calc(0.5rem+0.375rem)]"
                              : "text-slate-400 hover:text-white hover:bg-white/5"
                          }`}
                        >
                          {renamingKey === `c-${c.id}` ? renameInput : (
                            <span className="flex-1 min-w-0 flex items-center gap-1.5 truncate text-xs">
                              {runningChats.has(c.id) && (
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0" title="Run in progress" />
                              )}
                              <span className="truncate">{c.title}</span>
                            </span>
                          )}
                          {renamingKey !== `c-${c.id}` && rowActions(`c-${c.id}`, () => {
                            setRenamingKey(`c-${c.id}`); setRenameDraft(c.title)
                          })}
                        </div>
                      ))}
                      <button
                        onClick={() => handleNewChat(p.id)}
                        className="flex items-center gap-1.5 px-2 py-1.5 w-full rounded-md text-[11px] text-slate-500 hover:text-cyan-300 hover:bg-white/5"
                      >
                        <Plus size={11} /> New chat
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* ── Chats feed: every chat, newest first ── */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Chats
            </div>
            {/* Search across every chat (title, model, project) */}
            <div className="px-3 pb-1.5">
              <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 focus-within:border-cyan-500/40 transition-colors">
                <Search size={11} className="text-slate-500 shrink-0" />
                <input
                  value={chatSearch}
                  onChange={e => setChatSearch(e.target.value)}
                  placeholder="Search chats…"
                  className="flex-1 min-w-0 bg-transparent text-[11px] text-white placeholder:text-slate-600 outline-none"
                />
                {chatSearch && (
                  <button onClick={() => setChatSearch("")} className="p-0.5 text-slate-500 hover:text-white" title="Clear search">
                    <X size={10} />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain pb-1.5">
              {sidebarLoaded && feedChats.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-slate-600 leading-relaxed">
                  No chats yet — send a message on the right to start one.
                </div>
              )}
              {searchQ && visibleFeedChats.length === 0 && feedChats.length > 0 && (
                <div className="px-3 py-2 text-[11px] text-slate-600 leading-relaxed">
                  No chats match &ldquo;{chatSearch.trim()}&rdquo;.
                </div>
              )}
              {visibleFeedChats.map(c => (
                <div key={c.id} className="mx-1.5 mb-0.5">
                  <div
                    // Feed opens go fullscreen: collapse the sidebar for this
                    // session only (the explicit toggle is what persists)
                    onClick={() => { openChat(c.id); setSidebarOpen(false) }}
                    className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer ${
                      c.id === activeChatId
                        ? "bg-cyan-500/10 border-l-2 border-cyan-400"
                        : "hover:bg-white/5"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      {renamingKey === `c-${c.id}` ? renameInput : (
                        <>
                          <div className={`flex items-center gap-1.5 text-xs ${c.id === activeChatId ? "text-white" : "text-slate-300"}`}>
                            {runningChats.has(c.id) && (
                              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0" title="Run in progress" />
                            )}
                            <span className="truncate">{c.title}</span>
                          </div>
                          <div className="truncate text-[9px] text-slate-600">
                            {modelLabel(c.model)} · {c.projectName ?? "No project"} · {timeAgo(c.updatedAt)}
                          </div>
                        </>
                      )}
                    </div>
                    {renamingKey !== `c-${c.id}` && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={e => { e.stopPropagation(); setMoveMenuChatId(moveMenuChatId === c.id ? null : c.id) }}
                          className={`p-1 rounded ${moveMenuChatId === c.id ? "text-cyan-300 bg-cyan-500/10" : "text-slate-500 hover:text-white hover:bg-white/10"}`}
                          title="Move to project"
                        >
                          <FolderInput size={11} />
                        </button>
                        {rowActions(`c-${c.id}`, () => { setRenamingKey(`c-${c.id}`); setRenameDraft(c.title) })}
                      </span>
                    )}
                  </div>
                  {moveMenuChatId === c.id && (
                    <div className="ml-3 mr-1 mt-0.5 mb-1 rounded-lg border border-white/10 bg-black/30 py-1">
                      <div className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600">Move to</div>
                      <button
                        onClick={e => { e.stopPropagation(); moveChat(c.id, null) }}
                        className={`block w-full px-2.5 py-1 text-left text-[11px] ${c.projectName === null ? "text-cyan-300" : "text-slate-400 hover:text-white hover:bg-white/5"}`}
                      >
                        No project
                      </button>
                      {projects.map(p => (
                        <button
                          key={p.id}
                          onClick={e => { e.stopPropagation(); moveChat(c.id, p.id) }}
                          className={`block w-full px-2.5 py-1 text-left text-[11px] truncate ${c.projectName === p.name ? "text-cyan-300" : "text-slate-400 hover:text-white hover:bg-white/5"}`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Providers routing moved to the taskbar Profile dropdown → Chat Settings */}
          </div>
        </>
      )}

      {/* ── Chat area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-slate-950/40">
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-white/10"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            <PanelLeft size={14} />
          </button>
          <SiteLogoBox size={22} rounded={7} />
          <span className="flex-1 min-w-0 truncate text-sm text-white font-medium">
            {activeChatId ? activeChatTitle : "AI Chat Hub"}
          </span>

          {/* Per-chat instructions (system prompt) + saved presets */}
          {activeChatId !== null && (
            <div className="relative">
              <button
                data-employees-toggle
                onClick={() => setInstructionsOpen(o => !o)}
                className={`flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-lg text-xs border transition-colors ${
                  spSaved
                    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                    : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
                title="Employees — role, skills & instructions for this chat"
              >
                <Users size={12} />
                Employees
              </button>
              {instructionsOpen && (
                <div data-employees-panel className="absolute right-0 top-full mt-1.5 w-[min(420px,92vw)] max-h-[74vh] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-50 p-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      <Users size={12} className="text-cyan-400" /> {empDraft ? (empDraft.id ? "Edit employee" : "New employee") : panelTab === "memory" ? "Memory" : "Employees"}
                    </span>
                    <button onClick={() => { setInstructionsOpen(false); setEmpDraft(null) }} className="p-0.5 text-slate-500 hover:text-white"><X size={12} /></button>
                  </div>

                  {/* Live cost readout for THIS chat's setup — the purple chip
                      that used to live in the taskbar, now part of the panel */}
                  {!empDraft && (() => {
                    const est = estimateRunCost(chatSkills, model)
                    if (!est) return null
                    return (
                      <div
                        className="flex items-center gap-2 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] px-2.5 py-1.5"
                        title="Rough instruction cost for this chat's current employee/skills — history & images add on top"
                      >
                        <Brain size={12} className="shrink-0 text-violet-400/80" />
                        <span className="flex-1 min-w-0 text-[10px] leading-snug text-violet-200/90">
                          <span className="font-medium tabular-nums">{(est.tokens / 1000).toFixed(1)}k</span> tok/step always-on
                          {est.playbookTokens > 0 && (
                            <span className="text-violet-300/60"> · up to +{(est.playbookTokens / 1000).toFixed(1)}k on demand</span>
                          )}
                          {est.perStepUSD > 0 && (
                            <span className="block text-violet-300/60 tabular-nums">
                              ≈${est.perStepUSD.toFixed(3)}/step · ${est.perRunUSD.toFixed(2)}–${est.perRunMaxUSD.toFixed(2)} per 12-step run on {labelFor(model)}
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })()}

                  {!empDraft && (
                    <div className="flex rounded-lg border border-white/10 bg-black/20 p-0.5">
                      {([["employees", "Employees"], ["memory", "Memory"]] as const).map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => {
                            setPanelTab(id)
                            if (id === "memory" && !memLoaded) fetchMemory()
                          }}
                          className={`flex-1 rounded-md py-1 text-[10px] font-medium transition-colors ${
                            panelTab === id ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}

                  {empDraft ? (
                    /* ── EMPLOYEE EDITOR ─────────────────────────────── */
                    <>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={empDraft.emoji}
                          onChange={e => setEmpDraft({ ...empDraft, emoji: e.target.value })}
                          maxLength={4}
                          placeholder="🎨"
                          className="w-12 text-center bg-black/30 border border-white/10 rounded-md px-1 py-1.5 text-sm outline-none focus:border-cyan-500/40"
                          title="Avatar emoji"
                        />
                        <input
                          value={empDraft.name}
                          onChange={e => setEmpDraft({ ...empDraft, name: e.target.value })}
                          maxLength={40}
                          placeholder="Employee name — e.g. Logo Specialist"
                          className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={empDraft.modelId}
                          onChange={e => setEmpDraft({ ...empDraft, modelId: e.target.value })}
                          className="flex-1 min-w-0 bg-slate-900 border border-white/10 rounded-md px-1.5 py-1.5 text-[11px] text-slate-200 outline-none focus:border-cyan-500/40"
                          title="Chat model applied with this employee (optional)"
                        >
                          <option value="">Any chat model</option>
                          {[...CHAT_HUB_MODELS.map(m => ({ id: m.id, label: m.label })), ...customModels].map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                        <select
                          value={empDraft.agentMode}
                          onChange={e => setEmpDraft({ ...empDraft, agentMode: e.target.value as EmpDraft["agentMode"] })}
                          className="bg-slate-900 border border-white/10 rounded-md px-1.5 py-1.5 text-[11px] text-slate-200 outline-none focus:border-cyan-500/40"
                          title="Default permission mode (optional)"
                        >
                          <option value="">Keep mode</option>
                          <option value="plan">Plan</option>
                          <option value="accept">Ask</option>
                          <option value="approved">Auto</option>
                        </select>
                      </div>
                      <textarea
                        value={empDraft.text}
                        onChange={e => setEmpDraft({ ...empDraft, text: e.target.value })}
                        rows={4}
                        maxLength={4000}
                        placeholder={'This employee\'s instructions — e.g. "You are a senior logo designer. Minimal, geometric, timeless…"'}
                        className="w-full bg-black/30 border border-white/10 rounded-lg px-2.5 py-2 text-xs leading-relaxed text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40 resize-y"
                      />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Skills</span>
                      <SkillCards
                        selected={empDraft.skills}
                        onToggle={id => setEmpDraft({
                          ...empDraft,
                          skills: empDraft.skills.includes(id)
                            ? empDraft.skills.filter(x => x !== id)
                            : [...empDraft.skills, id],
                        })}
                      />
                      {(() => {
                        const est = estimateRunCost(
                          empDraft.skills.length === ALL_SKILL_IDS.length ? null : empDraft.skills,
                          empDraft.modelId || model)
                        return est ? (
                          <div className="text-[10px] text-slate-600">
                            ≈{(est.tokens / 1000).toFixed(1)}k always-on/step
                            {est.playbookTokens > 0 && <> · up to +{(est.playbookTokens / 1000).toFixed(1)}k when playbooks load</>}
                            {est.perStepUSD > 0 && <> · ≈${est.perStepUSD.toFixed(3)}/step · ${est.perRunUSD.toFixed(2)}–${est.perRunMaxUSD.toFixed(2)}/run on {labelFor(empDraft.modelId || model)}</>}
                          </div>
                        ) : null
                      })()}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={saveEmployee}
                          disabled={!empDraft.name.trim() || !empDraft.text.trim()}
                          className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 transition-colors"
                        >
                          {empDraft.id ? "Save changes" : "Create employee"}
                        </button>
                        <button
                          onClick={() => setEmpDraft(null)}
                          className="px-2.5 py-1.5 rounded-md text-[11px] text-slate-400 border border-white/10 hover:text-white hover:bg-white/5 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : panelTab === "memory" ? (
                    /* ── GLOBAL MEMORY MANAGER ───────────────────────── */
                    <>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                          <Brain size={11} className="text-violet-400" /> Account-wide memory — every chat sees these
                        </span>
                        <span className="text-[9px] tabular-nums text-slate-600">{memEntries.length}/{memLimit}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          value={memNew}
                          onChange={e => setMemNew(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") addMemory() }}
                          maxLength={500}
                          placeholder="Add a memory — e.g. Brand color is #0EA5E9"
                          className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-violet-500/40"
                        />
                        <input
                          value={memNewCat}
                          onChange={e => setMemNewCat(e.target.value)}
                          maxLength={30}
                          placeholder="label"
                          className="w-16 bg-black/30 border border-white/10 rounded-md px-1.5 py-1.5 text-[10px] text-slate-300 placeholder:text-slate-700 outline-none focus:border-violet-500/40"
                          title="Optional category label (brand, preference, …)"
                        />
                        <button
                          onClick={addMemory}
                          disabled={!memNew.trim() || memEntries.length >= memLimit}
                          className="p-1.5 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 transition-colors"
                          title="Add memory"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      {memEntries.length === 0 ? (
                        <div className="py-4 text-center text-[10px] leading-relaxed text-slate-600">
                          {memLoaded
                            ? "No memories yet. Add durable facts here, or tell the agent to remember something — it saves entries with the remember tool."
                            : "Loading…"}
                        </div>
                      ) : (
                        memEntries.map(m => (
                          <div key={m.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5">
                            {memEditId === m.id ? (
                              <div className="flex flex-col gap-1.5">
                                <textarea
                                  value={memEditText}
                                  onChange={e => setMemEditText(e.target.value)}
                                  rows={2}
                                  maxLength={500}
                                  className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] leading-relaxed text-white outline-none focus:border-violet-500/40 resize-y"
                                />
                                <div className="flex items-center gap-1.5">
                                  <button onClick={() => saveMemoryEdit(m.id)} className="px-2 py-1 rounded text-[10px] bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25">Save</button>
                                  <button onClick={() => setMemEditId(null)} className="px-2 py-1 rounded text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-start gap-2">
                                {m.source === "agent"
                                  ? <Bot size={11} className="mt-0.5 shrink-0 text-violet-400/70" aria-label="Saved by the agent" />
                                  : <UserIcon size={11} className="mt-0.5 shrink-0 text-slate-500" aria-label="Added by you" />}
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] leading-relaxed text-slate-200 break-words">{m.content}</div>
                                  {m.category && (
                                    <span className="mt-0.5 inline-block rounded bg-white/5 border border-white/10 px-1 py-px text-[8px] text-slate-500">{m.category}</span>
                                  )}
                                </div>
                                <span className="flex items-center gap-0.5 shrink-0">
                                  <button
                                    onClick={() => { setMemEditId(m.id); setMemEditText(m.content) }}
                                    className="p-1 rounded text-slate-600 hover:text-white hover:bg-white/10"
                                    title="Edit"
                                  >
                                    <Pencil size={10} />
                                  </button>
                                  <button
                                    onClick={() => deleteMemory(m.id)}
                                    className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                                    title="Delete"
                                  >
                                    <Trash2 size={10} />
                                  </button>
                                </span>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </>
                  ) : (
                    /* ── EMPLOYEE LIST + THIS CHAT ───────────────────── */
                    <>
                      {[...BUILT_IN_EMPLOYEES.map(e => ({
                        id: e.id, name: e.name, text: e.text, modelId: null as string | null,
                        skills: e.skills.length === ALL_SKILL_IDS.length ? null : e.skills,
                        emoji: e.id === "emp-full-studio" ? "🎛️"
                          : e.id === "emp-art-director" ? "🎨"
                          : e.id === "emp-art-director-editor" ? "🖌️"
                          : e.id === "emp-face-swap" ? "🎭"
                          : e.id === "emp-video-producer" ? "🎬"
                          : e.id === "emp-marketing-studio" ? "📣"
                          : e.id === "emp-film-director" ? "🎥"
                          : e.id === "emp-social-manager" ? "📱"
                          : e.id === "emp-movie-studio" ? "🎞️"
                          : "🤖",
                        agentMode: null as AgentMode | null, builtIn: true,
                      })),
                      // App-style default as a full employee: consumer-app tone
                      // for whatever model this chat runs (text computed live)
                      {
                        id: "emp-app-style", name: "App-Style Chat",
                        text: activeModel ? appStyleInstructions(activeModel) : "",
                        modelId: null as string | null, skills: null as string[] | null,
                        emoji: "💬", agentMode: null as AgentMode | null, builtIn: true,
                      },
                      ...personas.map(p => ({ ...p, builtIn: false }))].map(e => {
                        const skillCount = (e.skills ?? ALL_SKILL_IDS).length
                        const tok = estimateRunCost(e.skills ?? null, e.modelId || model)?.tokens ?? 0
                        const active = spSaved === e.text.trim()
                          && JSON.stringify([...(chatSkills ?? ALL_SKILL_IDS)].sort()) === JSON.stringify([...(e.skills ?? ALL_SKILL_IDS)].sort())
                        return (
                          <div key={e.id} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                            active ? "border-cyan-500/40 bg-cyan-500/[0.07]" : "border-white/10 bg-white/[0.03]"
                          }`}>
                            <button
                              onClick={() => applyPersona(e as Persona)}
                              className="flex-1 min-w-0 flex items-center gap-2 text-left"
                              title={e.text.slice(0, 300)}
                            >
                              <span className="text-base shrink-0">{e.emoji || "🤖"}</span>
                              <span className="min-w-0 flex-1">
                                <span className={`block truncate text-[12px] font-medium ${active ? "text-cyan-200" : "text-slate-200"}`}>
                                  {e.name}
                                </span>
                                <span className="block truncate text-[9px] text-slate-500">
                                  {skillCount}/{ALL_SKILL_IDS.length} skills · ~{(tok / 1000).toFixed(1)}k tok
                                  {e.modelId ? ` · ${labelFor(e.modelId)}` : ""}
                                  {e.agentMode ? ` · ${e.agentMode === "approved" ? "Auto" : e.agentMode === "plan" ? "Plan" : "Ask"}` : ""}
                                  {defaultEmployeeId === e.id ? " · default for new chats" : ""}
                                </span>
                              </span>
                            </button>
                            <button
                              onClick={() => persistDefaultEmployee(defaultEmployeeId === e.id ? null : e.id)}
                              className={`p-1 rounded shrink-0 ${defaultEmployeeId === e.id ? "text-amber-300 hover:bg-white/10" : "text-slate-600 hover:text-amber-300 hover:bg-white/10"}`}
                              title={defaultEmployeeId === e.id ? "Default for new chats — click to clear" : "Set as default for new chats"}
                            >
                              <Star size={11} fill={defaultEmployeeId === e.id ? "currentColor" : "none"} />
                            </button>
                            {e.builtIn ? (
                              <span className="shrink-0 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[8px] text-slate-500">built-in</span>
                            ) : (
                              <span className="flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={() => setEmpDraft({
                                    id: e.id, name: e.name, emoji: e.emoji ?? "",
                                    text: e.text, skills: [...(e.skills ?? ALL_SKILL_IDS)],
                                    modelId: e.modelId ?? "", agentMode: (e.agentMode ?? "") as EmpDraft["agentMode"],
                                  })}
                                  className="p-1 rounded text-slate-600 hover:text-white hover:bg-white/10"
                                  title="Edit employee"
                                >
                                  <Pencil size={11} />
                                </button>
                                <button
                                  onClick={() => persistPersonas(personas.filter(x => x.id !== e.id))}
                                  className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-red-500/10"
                                  title="Delete employee"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </span>
                            )}
                          </div>
                        )
                      })}
                      {personas.length < MAX_PERSONAS && (
                        <button
                          onClick={() => setEmpDraft({
                            id: null, name: "", emoji: "", text: spDraft,
                            skills: [...(chatSkills ?? ALL_SKILL_IDS)],
                            modelId: "", agentMode: "",
                          })}
                          className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg border border-dashed border-white/15 text-[11px] text-slate-400 hover:text-cyan-300 hover:border-cyan-500/30 transition-colors"
                        >
                          <Plus size={12} /> Create employee
                        </button>
                      )}

                      {/* Skills: this chat's live modules (instructions come
                          from the applied employee) */}
                      <div className="border-t border-white/5 pt-2 flex flex-col gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Skills</span>
                        <SkillCards selected={chatSkills ?? [...ALL_SKILL_IDS]} onToggle={toggleSkill} />
                        <div className="text-[9px] text-slate-700">
                          Core (always on): planning · quiz · summary · evaluation ≈ 1.6k · skill playbooks load on demand via load_skill · live cost shown in the purple bar above
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          {!activeChatId ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
              <SiteLogoBox size={56} rounded={16} />
              <div className="text-center">
                <div className="text-sm text-white font-medium mb-1">AI Chat Hub</div>
                <div className="text-xs text-slate-500 max-w-sm leading-relaxed">
                  Chat with Claude, GPT, Gemini and Grok side by side — pick a model,
                  type below, and a new chat starts automatically.
                </div>
              </div>
              {/* Centered starter composer — sends the first message and creates the chat */}
              <div className="relative isolate w-full max-w-xl rounded-2xl border border-white/10 bg-slate-900/80 backdrop-blur px-3.5 pt-3 pb-2.5 focus-within:border-cyan-500/40 transition-colors">
                <SilverRim rounded={16} />
                {editChip}
                {createChip}
                {refStrip}
                <textarea
                  ref={inputRef}
                  rows={3}
                  value={input}
                  onChange={e => { setInput(e.target.value); noteDraft(activeChatId, e.target.value); autoGrow(e.target); historyIndexRef.current = null }}
                  onKeyDown={handleComposerKey}
                  placeholder={composerPlaceholder}
                  className="w-full bg-transparent resize-none outline-none text-[13px] leading-relaxed text-white placeholder:text-slate-500 max-h-[320px]"
                />
                <div className="flex items-center gap-1.5 pt-1.5 flex-wrap">
                  {renderPlusMenu("down")}
                  {renderModelDropdown("down")}
                  {agentModeChip}
                  {movieFormatChip}
                  <div className="flex-1" />
                  <button
                    onClick={startNewChat}
                    disabled={!input.trim() || streaming}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title={createMode ? `Generate (${createCost} tickets)` : undefined}
                  >
                    <Send size={13} /> Start chat
                    {createMode && (
                      <span className="flex items-center gap-0.5 text-[11px] tabular-nums">
                        <Ticket size={11} />{createCost}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : chatLoading ? (
            <div className="text-xs text-slate-500 px-1 py-2">Loading conversation…</div>
          ) : (
            <div className={`${chatWidthClass} mx-auto flex flex-col gap-3`}>
              {messages.map(m => m.role === "user" ? (
                // The render hand-back is stored as a user turn because the model
                // needs it in that slot, but it is NOT something the user wrote.
                // Showing it in their own bubble read as the app sending messages
                // on their behalf, so it renders as the status line it actually is.
                // The render hand-back is how the run survives the 300s
                // function limit — it is machinery, and showing it made one
                // film read as a stop-start conversation in the user's own
                // voice. Hidden: a film should look like a single run.
                isShotHandback(m.content) ? null : (
                <div key={m.id} className="self-end max-w-[85%] flex flex-col items-end gap-1">
                  {(m.imageUrls?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap justify-end gap-1">
                      {m.imageUrls!.map((u, i) => (
                        <button key={i} onClick={() => {
                          if (onOpenMedia) { onOpenMedia({ url: u }) }
                          else { resetViewerExtras(); setMediaViewer({ url: u, isVideo: false, isRef: true }) }
                        }} title="View">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={refThumb(u, 128)} alt="" decoding="async"
                            onError={e => thumbFallback(e, u)}
                            className="w-14 h-14 object-cover rounded-lg border border-cyan-500/20 hover:border-cyan-400/60 transition-colors" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div
                    style={{ fontSize: chatTextPx }}
                    className="rounded-2xl rounded-br-md bg-cyan-500/10 border border-cyan-500/20 px-3.5 py-2.5 leading-relaxed text-slate-100 whitespace-pre-wrap break-words transition-all duration-100 active:scale-[0.97] active:bg-cyan-500/20 cursor-pointer"
                    onContextMenu={e => { e.preventDefault(); openMsgMenu(e.clientX, e.clientY, m) }}
                    onPointerDown={e => {
                      if (e.pointerType === "touch") msgTapRef.current = { x: e.clientX, y: e.clientY }
                    }}
                    onPointerUp={e => {
                      if (e.pointerType !== "touch" || !msgTapRef.current) return
                      const dx = Math.abs(e.clientX - msgTapRef.current.x)
                      const dy = Math.abs(e.clientY - msgTapRef.current.y)
                      msgTapRef.current = null
                      // Scroll-drags don't count as taps
                      if (dx < 10 && dy < 10) openMsgMenu(e.clientX, e.clientY, m)
                    }}
                    onPointerCancel={() => { msgTapRef.current = null }}
                  >
                    {(() => {
                      const { text, isLayeredEdit } = displayUserContent(m.content ?? "")
                      return <>
                        {isLayeredEdit && (
                          <span className="flex items-center gap-1 text-[10px] text-cyan-300/80 mb-1">
                            <Pencil size={10} /> Editing canvas
                          </span>
                        )}
                        {text}
                      </>
                    })()}
                  </div>
                </div>
                )
              ) : (
                /* Assistant reply = one bounded "model section": colored edge +
                   model header on top, steps/images/text inside — clear start
                   and end for each model in mixed-model chats */
                <div
                  key={m.id}
                  className={floating
                    ? "self-start w-full"
                    : `self-start max-w-[92%] min-w-[280px] rounded-2xl rounded-bl-md border border-white/10 border-l-2 ${accentFor(m.model).border} bg-white/5 overflow-hidden`}
                >
                  <div className={floating
                    ? "flex items-center gap-1.5 px-0.5 py-1.5 border-b border-white/[0.06]"
                    : "flex items-center gap-1.5 px-3.5 py-1.5 border-b border-white/5 bg-black/20"}>
                    <Bot size={11} className={accentFor(m.model).text} />
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${accentFor(m.model).text}`}>
                      {labelFor(m.model) || "Assistant"}
                    </span>
                    <div className="flex-1" />
                    {/* Retry the same user turn with a different model */}
                    {!streaming && typeof m.id === "number" && !m.pendingApproval && (
                      <div className="relative">
                        <button
                          onClick={() => setRetryMenuMsgId(retryMenuMsgId === m.id ? null : m.id)}
                          className={`p-1 rounded-md transition-colors ${
                            retryMenuMsgId === m.id ? "text-cyan-300 bg-cyan-500/10" : "text-slate-600 hover:text-white hover:bg-white/10"
                          }`}
                          title="Retry with a different model"
                        >
                          <RotateCcw size={11} />
                        </button>
                        {retryMenuMsgId === m.id && (
                          <div className="fixed inset-0 z-30" onClick={() => setRetryMenuMsgId(null)} />
                        )}
                        {retryMenuMsgId === m.id && (
                          <div className="absolute right-0 top-full mt-1 w-52 max-h-60 overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-40 py-1">
                            <div className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600">
                              Retry with…
                            </div>
                            {[...CHAT_HUB_MODELS.map(x => ({ id: x.id, label: x.label })), ...customModels].map(x => (
                              <button
                                key={x.id}
                                onClick={() => retryWith(m.id, x.id)}
                                className={`flex items-center w-full px-2.5 py-1.5 text-[11px] text-left ${
                                  x.id === m.model ? "text-cyan-300" : "text-slate-300 hover:bg-white/5 hover:text-white"
                                }`}
                              >
                                <span className="flex-1 truncate">{x.label}</span>
                                {x.id === m.model && <span className="shrink-0 text-[9px] text-slate-600">current</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={floating ? "px-0.5 py-2.5 flex flex-col gap-1.5" : "px-3.5 py-2.5 flex flex-col gap-2"}>
                  {(() => {
                    // Interleaved chronological flow: each text segment (round)
                    // is followed by the tool cards CALLED during that round —
                    // steps stay at the point in the reply where they happened
                    const segs = (m.textSegments && m.textSegments.length ? m.textSegments : (m.content ? [m.content] : []))
                    const steps = m.agentSteps ?? []
                    const structured = steps.length > 0 || segs.length > 1
                    // The closing summary is its own card at the BOTTOM of the
                    // reply — pulled out of the chronological flow entirely
                    const summaryStep = [...steps].reverse().find(s => s.tool === "write_summary" && s.task)
                    const flowSteps = steps.filter(s => s.tool !== "write_summary")
                    const renderStep = (s: AgentStep) => {
                        // Private thinking (Anthropic adaptive): nothing to expand —
                        // render a slim one-liner instead of a redundant dropdown.
                        // Models that DO share reasoning keep the full card below.
                        if (s.tool === "reasoning" && !s.resultPreview) {
                          return (
                            <div key={s.id} className={floating
                              ? "flex items-center gap-2 px-0.5 py-1"
                              : "flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/5 bg-white/[0.02]"}>
                              <Brain size={11} className="text-indigo-400/60 shrink-0" />
                              <span className="text-[10px] text-slate-500">
                                {s.status === "running"
                                  ? "Thinking…"
                                  : typeof s.ms === "number" && s.ms > 0
                                    ? `Thought for ${(s.ms / 1000).toFixed(1)}s`
                                    : "Thought it through"}
                              </span>
                              {s.status === "running" && <span className="w-1 h-1 rounded-full bg-indigo-400 animate-pulse shrink-0" />}
                            </div>
                          )
                        }
                        const key = `${m.id}:${s.id}`
                        const expanded = expandedSteps.has(key)
                        const dot =
                          s.status === "running" ? "bg-cyan-400 animate-pulse"
                          : s.status === "done" ? "bg-emerald-400"
                          : s.status === "error" ? "bg-red-400"
                          : s.status === "pending" ? "bg-amber-400"
                          : "bg-slate-500"
                        const accent = s.tool === "delegate_task" ? accentFor(s.model) : PROVIDER_ACCENT.custom
                        const edge =
                          s.tool === "delegate_task" ? accent.border
                          : s.tool === "search_refs" ? "border-l-cyan-400/60"
                          : s.tool === "dataset" || s.tool === "dataset_edit" ? "border-l-orange-400/60"
                          : s.tool === "web_search" ? "border-l-blue-400/60"
                          : s.tool === "save_memory" ? "border-l-emerald-400/60"
                          : s.tool === "edit_instructions" ? "border-l-violet-400/60"
                          : s.tool === "ask_user" ? "border-l-amber-400/60"
                          : s.tool === "propose_plan" ? "border-l-amber-400/60"
                          : s.tool === "reasoning" ? "border-l-indigo-400/50"
                          : s.tool === "record_evaluation" ? "border-l-teal-400/60"
                          : "border-l-fuchsia-400/60"
                        return (
                          <div key={s.id} className={floating ? "" : `rounded-lg border border-white/10 border-l-2 ${edge} bg-white/[0.03]`}>
                            <button
                              onClick={() => setExpandedSteps(prev => {
                                const next = new Set(prev)
                                if (next.has(key)) next.delete(key)
                                else next.add(key)
                                return next
                              })}
                              className={floating
                                ? "flex items-center gap-2 w-full px-0.5 py-1 text-left rounded-md hover:bg-white/[0.03] transition-colors"
                                : "flex items-center gap-2 w-full px-2.5 py-1.5 text-left"}
                            >
                              {s.tool === "delegate_task"
                                ? <Bot size={12} className={`${accent.text} shrink-0`} />
                                : s.tool === "edit_image"
                                  ? <Crop size={12} className="text-fuchsia-400 shrink-0" />
                                : s.tool === "search_refs"
                                  ? <BookMarked size={12} className="text-cyan-400 shrink-0" />
                                : s.tool === "dataset" || s.tool === "dataset_edit"
                                  ? <FolderInput size={12} className="text-orange-400 shrink-0" />
                                : s.tool === "web_search"
                                  ? <Globe size={12} className="text-blue-400 shrink-0" />
                                : s.tool === "save_memory"
                                  ? <Save size={12} className="text-emerald-400 shrink-0" />
                                : s.tool === "edit_instructions"
                                  ? <BookOpen size={12} className="text-violet-400 shrink-0" />
                                : s.tool === "ask_user"
                                  ? <HelpCircle size={12} className="text-amber-400 shrink-0" />
                                : s.tool === "propose_plan"
                                  ? <ListChecks size={12} className="text-amber-400 shrink-0" />
                                : s.tool === "reasoning"
                                  ? <Brain size={12} className="text-indigo-400 shrink-0" />
                                : s.tool === "record_evaluation"
                                  ? <Eye size={12} className="text-teal-400 shrink-0" />
                                : s.kind === "video"
                                  ? <Clapperboard size={12} className="text-fuchsia-400 shrink-0" />
                                  : <ImageIcon size={12} className="text-fuchsia-400 shrink-0" />}
                              <span className={floating
                                ? "min-w-0 truncate text-[11px] text-slate-300"
                                : "flex-1 min-w-0 truncate text-[11px] text-slate-300"}>
                                {s.status === "superseded" ? (
                                  <>
                                    {s.tool === "propose_plan" ? "Plan set aside" : "Set aside"}
                                    <span className="text-slate-500"> — you replied with new context</span>
                                  </>
                                ) : s.tool === "delegate_task" ? (
                                  <>
                                    {s.status === "pending" ? "Wants to delegate to " : s.status === "denied" ? "Denied: delegate to " : "Delegated to "}
                                    <span className={`font-medium ${accent.text}`}>{labelFor(s.model)}</span>
                                  </>
                                ) : s.tool === "create_media" ? (
                                  <>
                                    {s.status === "pending" ? "Wants to create " : s.status === "denied" ? "Denied: create " : s.status === "running" ? "Creating " : "Created "}
                                    {s.kind ?? "media"} with{" "}
                                    <span className="font-medium text-fuchsia-300">{labelFor(s.model)}</span>
                                  </>
                                ) : s.tool === "edit_image" ? (
                                  s.status === "pending" ? "Wants to edit an image" : s.status === "denied" ? "Denied: edit image" : s.status === "running" ? "Editing image…" : "Edited image"
                                ) : s.tool === "search_refs" ? (
                                  s.status === "running" ? "Searching the reference library…" : "Searched the reference library"
                                ) : s.tool === "dataset" ? (
                                  <>
                                    {s.status === "running" ? "Browsing the dataset" : "Browsed the dataset"}
                                    {s.task && <span className="text-orange-300/90 normal-case"> · {s.task}</span>}
                                  </>
                                ) : s.tool === "dataset_edit" ? (
                                  <>
                                    {s.status === "pending" ? "Wants to change the dataset"
                                      : s.status === "denied" ? "Denied: dataset change"
                                      : s.status === "running" ? "Applying dataset change…"
                                      : "Dataset updated"}
                                    {s.task && <span className="text-orange-300/90 normal-case"> · {s.task}</span>}
                                  </>
                                ) : s.tool === "web_search" ? (
                                  s.status === "running" ? "Searching the web…" : "Searched the web"
                                ) : s.tool === "save_memory" ? (
                                  s.status === "running" ? "Updating project memory…" : "Updated project memory"
                                ) : s.tool === "remember" ? (
                                  s.status === "running" ? "Saving to memory…" : "Saved to memory"
                                ) : s.tool === "load_skill" ? (
                                  <>
                                    {s.status === "running" ? "Loading " : "Loaded "}
                                    <span className="font-medium text-emerald-300">{AGENT_SKILLS.find(x => x.id === s.task)?.name ?? s.task}</span>
                                    {" playbook"}
                                  </>
                                ) : s.tool === "publish_instagram" ? (
                                  s.status === "pending" ? "Wants to publish to Instagram"
                                    : s.status === "denied" ? "Denied: publish to Instagram"
                                    : s.status === "running" ? "Publishing to Instagram…"
                                    : "Published to Instagram"
                                ) : s.tool === "edit_instructions" ? (
                                  s.status === "pending" ? "Wants to edit instructions" : s.status === "denied" ? "Denied: edit instructions" : s.status === "running" ? "Saving instructions…" : "Instructions saved"
                                ) : s.tool === "ask_user" ? (
                                  s.status === "pending" ? "Has questions for you" : s.status === "denied" ? "Questions skipped" : "Questions answered"
                                ) : s.tool === "propose_plan" ? (
                                  s.status === "pending" ? "Proposed a plan" : s.status === "denied" ? "Plan denied" : "Plan approved"
                                ) : s.tool === "render_shots" ? (
                                  s.status === "pending" ? "Wants to render the shot list"
                                    : s.status === "denied" ? "Shot list denied"
                                    : s.status === "running" ? "Shots rendering…"
                                    : "Shot list submitted"
                                ) : s.tool === "check_shots" ? (
                                  s.status === "running" ? "Checking shots…" : "Shots checked"
                                ) : s.tool === "assemble_film" ? (
                                  s.status === "running" ? "Cutting the film…" : "Film assembled"
                                ) : s.tool === "create_audio" ? (
                                  s.status === "pending" ? "Wants to generate audio"
                                    : s.status === "denied" ? "Audio denied"
                                    : s.status === "running" ? "Generating audio…"
                                    : "Audio generated"
                                ) : s.tool === "reasoning" ? (
                                  s.status === "running" ? "Thinking it through…" : "Thought it through"
                                ) : s.tool === "record_evaluation" ? (
                                  s.status === "running" ? "Evaluating image…"
                                    : s.resultPreview?.startsWith("PASS") ? "Image evaluation — passed"
                                    : s.resultPreview?.startsWith("REVISE") ? "Image evaluation — needs revision"
                                    : "Image evaluation"
                                ) : (
                                  s.status === "pending" ? "Wants to generate an image" : s.status === "denied" ? "Denied: generate image" : "Generate image"
                                )}
                              </span>
                              {typeof s.cost === "number" && (
                                <span className="shrink-0 flex items-center gap-0.5 text-[9px] text-cyan-300 tabular-nums">
                                  <Ticket size={9} />{s.cost}
                                </span>
                              )}
                              {typeof s.ms === "number" && s.ms > 0 && (
                                <span className="shrink-0 text-[9px] text-slate-600 tabular-nums">{(s.ms / 1000).toFixed(1)}s</span>
                              )}
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                              <ChevronDown size={11} className={`shrink-0 text-slate-600 transition-transform ${expanded ? "rotate-180" : ""}`} />
                            </button>
                            {expanded && (
                              <div className={floating
                                ? "ml-2 mt-0.5 mb-1 pl-4 border-l border-white/10 text-[11px] text-slate-400 space-y-1.5"
                                : "px-2.5 pb-2 text-[11px] text-slate-400 space-y-1.5"}>
                                {s.status === "running" && (
                                  <div className="flex items-center gap-1.5 text-[10px] text-cyan-400">
                                    <span className="inline-flex gap-1 items-center">
                                      <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                                      <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
                                      <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
                                    </span>
                                    {s.tool === "delegate_task" ? `Waiting for ${labelFor(s.model)}'s reply…`
                                      : s.tool === "web_search" ? "Searching the web…"
                                      : s.tool === "search_refs" ? "Searching your reference library…"
                                      : s.tool === "dataset" ? "Browsing the dataset…"
                                      : s.tool === "dataset_edit" ? "Applying the dataset change…"
                                      : s.tool === "save_memory" ? "Saving to project memory…"
                                      : s.tool === "edit_image" ? "Applying image edits…"
                                      : s.tool === "reasoning" ? "Thinking…"
                                      : s.tool === "record_evaluation" ? "Evaluating…"
                                      : "Waiting for the image model…"}
                                  </div>
                                )}
                                {s.settings && Object.keys(s.settings).length > 0 && (
                                  <div className="text-[10px] text-slate-500">
                                    Settings: {Object.entries(s.settings).map(([k, v]) => `${k} ${v}`).join(" · ")}
                                  </div>
                                )}
                                {s.tool === "create_media" && (
                                  <div>
                                    <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-0.5">
                                      Reference images
                                    </div>
                                    {s.refs && s.refs.length > 0 ? (
                                      <div className="flex flex-wrap gap-1.5">
                                        {s.refs.map((u, ri) => (
                                          <a key={`${u}-${ri}`} href={u} target="_blank" rel="noopener noreferrer" title={u}>
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                              src={u}
                                              alt={`Reference ${ri + 1}`}
                                              loading="lazy"
                                              decoding="async"
                                              onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = "none" }}
                                              className="w-10 h-10 object-cover rounded-md border border-white/10 hover:border-fuchsia-500/50 transition-colors"
                                            />
                                          </a>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-[10px] text-slate-600">None — generated from the prompt only</div>
                                    )}
                                  </div>
                                )}
                                {(s.task ?? s.prompt) && (
                                  <div>
                                    <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-0.5">
                                      {s.tool === "delegate_task" ? "Task sent"
                                        : s.tool === "web_search" ? "Query"
                                        : s.tool === "search_refs" ? "Search"
                                        : s.tool === "save_memory" ? "Saved note"
                                        : s.tool === "edit_image" ? "Operations"
                                        : s.tool === "edit_instructions" ? "Proposed instructions"
                                        : s.tool === "ask_user" ? "Questions"
                                        : s.tool === "propose_plan" ? "Plan"
                                        : s.tool === "record_evaluation" ? "Evaluation"
                                        : "Prompt"}
                                    </div>
                                    <div className="whitespace-pre-wrap break-words">{s.task ?? s.prompt}</div>
                                  </div>
                                )}
                                {s.resultPreview && (
                                  <div>
                                    <div className={`text-[9px] font-semibold uppercase tracking-wider pb-0.5 ${accent.text}`}>
                                      {s.tool === "delegate_task" ? `Reply · ${labelFor(s.model)}`
                                        : s.tool === "web_search" ? "Answer · web search"
                                        : s.tool === "search_refs" ? "Results · reference library"
                                        : s.tool === "ask_user" ? "Your answers"
                                        : s.tool === "reasoning" ? "Reasoning"
                                        : s.tool === "record_evaluation" ? "Verdict"
                                        : s.tool === "save_memory" || s.tool === "edit_image" || s.tool === "edit_instructions" ? "Result"
                                        : "Reply · image model"}
                                    </div>
                                    <div className="max-h-40 overflow-y-auto overscroll-contain rounded-md bg-black/30 border border-white/5 p-2 text-slate-300 whitespace-pre-wrap break-words">
                                      {s.resultPreview}
                                      {s.resultPreview.length >= 4000 && (
                                        <span className="text-slate-500"> … (preview truncated — the orchestrator received the full reply)</span>
                                      )}
                                    </div>
                                  </div>
                                )}
                                {s.error && <div className="text-red-400 break-words">{s.error}</div>}
                              </div>
                            )}
                          </div>
                        )
                      }

                    // Consecutive load_skill steps collapse into ONE "Playbooks"
                    // row (expand to see which) — keeps runs readable instead of
                    // stacking five "Loaded X playbook" cards
                    const renderPlaybookGroup = (grp: AgentStep[]) => {
                      const key = `${m.id}:pbgrp:${grp[0].id}`
                      const expanded = expandedSteps.has(key)
                      const names = grp.map(s => AGENT_SKILLS.find(x => x.id === s.task)?.name ?? s.task ?? "playbook")
                      const running = grp.some(s => s.status === "running")
                      return (
                        <div key={key} className={floating ? "" : "rounded-lg border border-white/10 border-l-2 border-l-emerald-400/60 bg-white/[0.03]"}>
                          <button
                            onClick={() => setExpandedSteps(prev => {
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })}
                            className={floating
                              ? "flex items-center gap-2 w-full px-0.5 py-1 text-left rounded-md hover:bg-white/[0.03] transition-colors"
                              : "flex items-center gap-2 w-full px-2.5 py-1.5 text-left"}
                          >
                            <BookOpen size={12} className="text-emerald-400 shrink-0" />
                            <span className={floating ? "min-w-0 truncate text-[11px] text-slate-300" : "flex-1 min-w-0 truncate text-[11px] text-slate-300"}>
                              Playbooks
                              <span className="text-emerald-300/90"> · {names.length} loaded</span>
                            </span>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${running ? "bg-cyan-400 animate-pulse" : "bg-emerald-400"}`} />
                            <ChevronDown size={11} className={`shrink-0 text-slate-600 transition-transform ${expanded ? "rotate-180" : ""}`} />
                          </button>
                          {expanded && (
                            <div className={floating
                              ? "ml-2 mt-0.5 mb-1 pl-4 border-l border-white/10 text-[11px] text-slate-400 space-y-0.5"
                              : "px-2.5 pb-2 text-[11px] text-slate-400 space-y-0.5"}>
                              {names.map((n, j) => (
                                <div key={j} className="flex items-center gap-1.5">
                                  <span className="w-1 h-1 rounded-full bg-emerald-400/60 shrink-0" />
                                  {n}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    }
                    // Steps → nodes, folding load_skill runs into playbook groups
                    const renderStepList = (list: AgentStep[]): ReactNode[] => {
                      const nodes: ReactNode[] = []
                      let idx = 0
                      while (idx < list.length) {
                        if (list[idx].tool === "load_skill") {
                          const grp: AgentStep[] = []
                          while (idx < list.length && list[idx].tool === "load_skill") { grp.push(list[idx]); idx++ }
                          nodes.push(renderPlaybookGroup(grp))
                          continue
                        }
                        nodes.push(renderStep(list[idx]))
                        idx++
                      }
                      return nodes
                    }

                    // ONE dedicated media masonry section per reply, anchored at
                    // the round where the FIRST media generation happened (falls
                    // back to just before the Summary when no step claims it)
                    const isMediaTool = (s: AgentStep) =>
                      s.tool === "create_media" || s.tool === "generate_image" || s.tool === "edit_image"
                      || s.tool === "render_shots" || s.tool === "assemble_film"
                    const mediaSteps = steps.filter(isMediaTool)
                    // A render_shots step is N shots in one step, so it gets N
                    // placeholder tiles — the film shows up as it renders
                    // instead of the reply looking empty until every shot lands.
                    // A queue id belongs to ONE tile no matter how many steps
                    // mention it. Two steps claiming the same shots (a retry, a
                    // guarded re-submit) drew a placeholder each, so four shots
                    // showed as eight.
                    const claimedShots = new Set<number>()
                    const pendingMedia = mediaSteps.flatMap(s => {
                      if (s.status !== "running") return []
                      const ids = (s as any).queueIds
                      if (Array.isArray(ids) && ids.length) {
                        const results = (s as any).shotResults ?? {}
                        const mine = ids.filter((id: number) => {
                          if (claimedShots.has(id)) return false
                          claimedShots.add(id)
                          return results[String(id)] === undefined // not landed yet
                        })
                        // Each placeholder needs its OWN key: the tiles are keyed
                        // on the step id, and repeating one object N times gave
                        // N tiles the same key.
                        //
                        // A batch step has no single `model` — the shots mix
                        // engines — so the video placeholders showed no model
                        // while the image ones did. Give each tile the model
                        // that is actually rendering it.
                        const shotModels = (s as any).shotModels as Record<string, string> | undefined
                        return mine.map((id: number) => ({
                          ...s,
                          id: `${s.id}#${id}`,
                          model: shotModels?.[String(id)] ?? s.model,
                        }))
                      }
                      return s.imageUrl ? [] : [s]
                    })
                    // url -> the model that produced it. Two sources: a single
                    // create_media step (its own model + imageUrl) and a
                    // render_shots batch, which mixes models across shots and
                    // records them per queue id.
                    const modelByUrl = new Map<string, string>()
                    for (const st of mediaSteps) {
                      const shotResults = (st as any).shotResults as Record<string, string> | undefined
                      const shotModels = (st as any).shotModels as Record<string, string> | undefined
                      if (shotResults) {
                        for (const [qid, url] of Object.entries(shotResults)) {
                          const mid = shotModels?.[qid]
                          if (mid && typeof url === "string" && !url.startsWith("ERROR:")) {
                            modelByUrl.set(url, getCreateModel(mid)?.label ?? mid)
                          }
                        }
                      }
                      if (st.imageUrl && st.model) {
                        modelByUrl.set(st.imageUrl, getCreateModel(st.model)?.label ?? st.model)
                      }
                    }

                    const firstMediaSeg = mediaSteps.length
                      ? Math.min(...mediaSteps.map(s => s.seg ?? 0))
                      : null
                    const tileGrid = (rawUrls: string[], pendingSteps: AgentStep[]) => {
                      // Replies saved before the producer was fixed can carry an
                      // empty string here; <img src=""> re-downloads the page.
                      // Replies saved before the write-side fixes can carry an
                      // empty string (a pending video) or the same url twice (two
                      // overlapping settle polls) — neither should reach a tile.
                      const urls = [...new Set(rawUrls.filter(u => typeof u === "string" && u.length > 0))]
                      const total = urls.length + pendingSteps.length
                      if (total === 0) return null
                      return (
                        <div className={total === 1
                          ? "max-w-[340px]"
                          : total === 2
                            // grid (not CSS columns) GUARANTEES side-by-side —
                            // column balancing can stack two tall tiles
                            ? "grid grid-cols-2 gap-2 items-start max-w-[600px]"
                            : total === 3
                              ? "grid grid-cols-3 gap-2 items-start max-w-[760px]"
                              : "columns-2 sm:columns-3 md:columns-4 gap-2"}>
                          {urls.map((u, i) => isVideoUrl(u) ? (
                            <VideoTile key={i} src={u}
                              modelLabel={modelByUrl.get(u) ?? null}
                              onExpand={() => openMediaViewer(m, u)}
                              className="w-full mb-2 break-inside-avoid rounded-lg border border-white/10" />
                          ) : (
                            <button
                              key={i}
                              onClick={() => openMediaViewer(m, u)}
                              className="block w-full mb-2 break-inside-avoid group min-h-[120px] rounded-lg bg-white/[0.03]"
                              title="View details"
                            >
                              {/* Skeleton until loaded — a big file with height 0
                                  reads as "the image is GONE from the chat" */}
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={u} alt="Generated image" decoding="async"
                                ref={el => { if (el?.complete && el.naturalWidth) el.style.opacity = "1" }}
                                onLoad={e => { e.currentTarget.style.opacity = "1" }}
                                onError={e => {
                                  const btn = e.currentTarget.closest("button") as HTMLElement | null
                                  if (btn) btn.style.display = "none"
                                }}
                                style={{ opacity: 0, transition: "opacity 0.25s" }}
                                className="w-full rounded-lg border border-white/10 group-hover:border-cyan-500/40 transition-colors" />
                            </button>
                          ))}
                          {pendingSteps.map(s => {
                            const rawAspect = s.settings?.aspect
                            const aspect = rawAspect && /^\d+:\d+$/.test(rawAspect)
                              ? rawAspect.replace(":", " / ")
                              : s.kind === "video" ? "16 / 9" : "1 / 1"
                            return (
                              <div
                                key={`ph-${s.id}`}
                                style={{ aspectRatio: aspect }}
                                className="relative w-full mb-2 break-inside-avoid rounded-lg border border-fuchsia-500/20 bg-white/[0.03] overflow-hidden"
                              >
                                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-fuchsia-500/[0.08] via-transparent to-cyan-500/[0.08]" />
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-center">
                                  {(s.kind === "video" || s.tool === "render_shots" || s.tool === "assemble_film")
                                    ? <Clapperboard size={16} className="text-fuchsia-400/80 animate-pulse" />
                                    : <ImageIcon size={16} className="text-fuchsia-400/80 animate-pulse" />}
                                  <span className="text-[9px] text-slate-400">
                                    {placeholderLabel(s)}
                                  </span>
                                  {s.model && (
                                    <span className="text-[8px] text-slate-600 truncate max-w-full">
                                      {/* these are MEDIA models, so resolve
                                          against the create catalog first */}
                                      {getCreateModel(s.model)?.label ?? labelFor(s.model)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    }
                    const mediaNode = ((m.imageUrls?.length ?? 0) + pendingMedia.length) > 0 ? (() => {
                      const doneMedia = mediaSteps.filter(s => s.imageUrl)
                      const spentTickets = doneMedia.length
                        ? doneMedia.reduce((sum, s) => sum + (typeof s.cost === "number" ? s.cost : 0), 0)
                        : (m.createInfo?.ticketCost ?? 0)
                      const modelsUsed = doneMedia.length
                        ? [...new Set(doneMedia.map(s => labelFor(s.model)).filter(Boolean))]
                        : (m.createInfo && m.model ? [labelFor(m.model)] : [])
                      // Superseded = edits the model itself judged REVISE via
                      // record_evaluation (verdict steps carry the judged URL).
                      // Cutouts and good intermediates stay in the main grid.
                      const revisedUrls = new Set(
                        steps
                          .filter(s => s.tool === "record_evaluation" && s.imageUrl && s.resultPreview?.startsWith("REVISE"))
                          .map(s => s.imageUrl!))
                      const editUrls = mediaSteps.filter(s => s.tool === "edit_image" && s.imageUrl).map(s => s.imageUrl!)
                      // Current-canvas view: only the LATEST edit stays in the
                      // grid — every earlier edit is an intermediate canvas
                      // state and collapses into the history drawer below.
                      const draftEditUrls = new Set(editUrls.slice(0, -1))
                      for (const u of editUrls) if (revisedUrls.has(u)) draftEditUrls.add(u)
                      const latestEdit = editUrls[editUrls.length - 1]
                      if (latestEdit) draftEditUrls.delete(latestEdit)
                      // Images a FINISHED step produced but the row has not
                      // recorded yet. imageUrls is written when the reply is
                      // finalized; mid-run (or after a reload mid-run) the only
                      // record is the step itself, so a generated image
                      // vanished from the chat until the whole run ended.
                      const fromSteps = mediaSteps
                        .filter(st => st.status === "done" && typeof st.imageUrl === "string" && st.imageUrl)
                        .map(st => st.imageUrl as string)
                      const mainUrls = [...new Set([...(m.imageUrls ?? []), ...fromSteps])]
                        .filter(u => !draftEditUrls.has(u))
                      return (
                        <div className={floating ? "py-1" : "rounded-lg border border-white/10 bg-black/20 p-2"}>
                          <div className="flex items-center gap-1.5 pb-0.5">
                            <ImageIcon size={10} className="text-fuchsia-400" />
                            <span className="flex-1 min-w-0 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                              Media · {mainUrls.length}
                              {pendingMedia.length > 0 && (
                                <span className="text-cyan-400/80">
                                  {" · "}{pendingMedia.length}{" "}
                                  {pendingMedia.every(s => s.tool === "edit_image") ? "editing"
                                    : pendingMedia.every(s => s.tool === "assemble_film") ? "cutting"
                                    : pendingMedia.some(s => s.tool === "render_shots" || s.kind === "video") ? "shooting"
                                    : "generating"}
                                </span>
                              )}
                            </span>
                            {spentTickets > 0 && (
                              <span className="shrink-0 flex items-center gap-0.5 text-[9px] text-cyan-300 tabular-nums" title="Tickets spent on this media">
                                <Ticket size={9} />{spentTickets}
                              </span>
                            )}
                          </div>
                          {modelsUsed.length > 0 && (
                            <div className="pb-1.5 text-[9px] text-slate-600 truncate">
                              {modelsUsed.join(" · ")}
                            </div>
                          )}
                          {tileGrid(mainUrls, pendingMedia)}
                          {draftEditUrls.size > 0 && (
                            <details className="mt-1.5 group/attempts">
                              <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-400 transition-colors">
                                <ChevronRight size={10} className="transition-transform group-open/attempts:rotate-90" />
                                Edit history · {draftEditUrls.size}
                              </summary>
                              <div className="pt-1.5 columns-3 gap-1.5 max-w-[420px]">
                                {[...draftEditUrls].map((u, i) => (
                                  <button
                                    key={i}
                                    onClick={() => openMediaViewer(m, u)}
                                    className="block w-full mb-1.5 break-inside-avoid opacity-50 hover:opacity-100 transition-opacity"
                                    title="Superseded edit attempt"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={u} alt="Edit attempt" decoding="async"
                                      onError={e => {
                                        const btn = e.currentTarget.closest("button") as HTMLElement | null
                                        if (btn) btn.style.display = "none"
                                      }}
                                      className="w-full rounded border border-white/10" />
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      )
                    })() : null

                    // Simple reply: plain text (no sub-card chrome)
                    if (!structured) {
                      if (segs.length > 0) {
                        return <>
                          <MarkdownBlock text={segs[0]} px={chatTextPx} />
                          {mediaNode}
                        </>
                      }
                      if (!(m.imageUrls?.length)) {
                        return typeof m.id === "string" && (streaming || awaitingReply) ? (
                          <ThinkingIndicator
                            modelLabel={labelFor(m.model) || "The model"}
                            routeText={(m.model ?? model).startsWith("ollama/")
                              ? "Local Ollama"
                              : (m.model ?? model).startsWith("runpod/")
                                ? "RunPod GPU"
                                : (m.model ?? model).startsWith("openrouter/")
                                  ? "OpenRouter"
                                : routeForModel(m.model ?? model) === "direct"
                                  ? `${providerOfModelId(m.model)} API`
                                  : "Vercel AI Hub"}
                            modeLabel={AGENT_MODES.find(a => a.id === agentMode)?.label ?? "Ask"}
                          />
                        ) : (
                          <span className="italic text-slate-500 text-xs">(empty response)</span>
                        )
                      }
                      return mediaNode
                    }

                    // Chronological rounds: segment i, then the steps called in it
                    const maxSeg = flowSteps.length ? Math.max(...flowSteps.map(s => s.seg ?? 0)) : 0
                    const rounds = Math.max(segs.length, maxSeg + 1)
                    const out: ReactNode[] = []
                    let mediaPlaced = false
                    for (let i = 0; i < rounds; i++) {
                      const roundStepsAll = flowSteps.filter(s => (s.seg ?? 0) === i)
                      // TRUE CHRONOLOGY: each step carries textAt = how much of
                      // the round's text existed when it started. Slice the text
                      // into sections around the tool runs — words written AFTER
                      // an edit render BELOW it, in their own section. Older
                      // messages without stamps fall back to the preText hoist.
                      const segText = segs[i] ?? ""
                      type RoundItem = { kind: "text"; body: string } | { kind: "steps"; list: AgentStep[] }
                      const items: RoundItem[] = []
                      if (roundStepsAll.some(s => typeof s.textAt === "number")) {
                        let cut = 0
                        let bucket: AgentStep[] = []
                        const flush = () => { if (bucket.length) { items.push({ kind: "steps", list: bucket }); bucket = [] } }
                        for (const s of roundStepsAll) {
                          const at = Math.min(Math.max(typeof s.textAt === "number" ? s.textAt : cut, cut), segText.length)
                          if (at > cut) {
                            const chunk = segText.slice(cut, at)
                            cut = at
                            if (chunk.trim()) { flush(); items.push({ kind: "text", body: chunk }) }
                          }
                          bucket.push(s)
                        }
                        flush()
                        const rest = segText.slice(cut)
                        if (rest.trim()) items.push({ kind: "text", body: rest })
                      } else {
                        const hasPreText = roundStepsAll.some(s => s.preText)
                        let lead = 0
                        if (hasPreText) {
                          while (lead < roundStepsAll.length && roundStepsAll[lead].preText) lead++
                        } else {
                          while (lead < roundStepsAll.length && roundStepsAll[lead].tool === "reasoning") lead++
                        }
                        if (lead) items.push({ kind: "steps", list: roundStepsAll.slice(0, lead) })
                        if (segText.trim()) items.push({ kind: "text", body: segText })
                        if (roundStepsAll.length > lead) items.push({ kind: "steps", list: roundStepsAll.slice(lead) })
                      }
                      let textCount = 0
                      items.forEach((it, k) => {
                        if (it.kind === "text") {
                          const label = i === 0 && textCount === 0 ? "Initial message" : "Continued"
                          textCount++
                          out.push(
                            floating ? (
                              <div key={`seg-${i}-${k}`} className="px-0.5 py-1">
                                <MarkdownBlock text={it.body} px={chatTextPx} />
                              </div>
                            ) : (
                              <div key={`seg-${i}-${k}`} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                                <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-1">
                                  {label}
                                </div>
                                <MarkdownBlock text={it.body} px={chatTextPx} />
                              </div>
                            )
                          )
                          return
                        }
                        // Steps group — the media masonry section mounts right
                        // after the group's first media-producing step
                        if (i === firstMediaSeg && mediaNode && !mediaPlaced && it.list.some(isMediaTool)) {
                          const cutIdx = it.list.findIndex(isMediaTool) + 1
                          out.push(
                            <div key={`steps-${i}-${k}a`} className="flex flex-col gap-1 w-full">
                              {renderStepList(it.list.slice(0, cutIdx))}
                            </div>
                          )
                          out.push(<div key="media">{mediaNode}</div>)
                          mediaPlaced = true
                          if (cutIdx < it.list.length) {
                            out.push(
                              <div key={`steps-${i}-${k}b`} className="flex flex-col gap-1 w-full">
                                {renderStepList(it.list.slice(cutIdx))}
                              </div>
                            )
                          }
                        } else {
                          out.push(
                            <div key={`steps-${i}-${k}`} className="flex flex-col gap-1 w-full">
                              {renderStepList(it.list)}
                            </div>
                          )
                        }
                      })
                    }
                    if (mediaNode && !mediaPlaced) out.push(<div key="media">{mediaNode}</div>)
                    // Closing Summary card — always the last content in the reply
                    if (summaryStep?.task) {
                      out.push(
                        <div key="summary" className={floating
                          ? "border-l-2 border-emerald-500/40 pl-3 py-1"
                          : "rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2"}>
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-emerald-300/80 pb-1">
                            Summary
                          </div>
                          <MarkdownBlock text={summaryStep.task} px={chatTextPx} />
                        </div>
                      )
                    }
                    return <>{out}</>
                  })()}
                  {/* Completion strip — unambiguous end-of-run marker once the
                      reply has settled (nothing streaming, nothing pending) */}
                  {(() => {
                    // Shots that outlive the reply keep it unsettled: stamping
                    // "Done" on a run whose renders have not landed reads as a
                    // finished job that never happened.
                    const shotsRendering = (m.agentSteps ?? []).some((st: any) => shotsOutstanding(st))
                    // A film runs across several replies: shots settle, the
                    // queue hands them back, the run picks up again. Stamping
                    // "Done" on the reply that happens to end first says the job
                    // is finished when the next pass has not even started.
                    const lastRow = messages[messages.length - 1]
                    // Shots submitted in an EARLIER reply are still this film's
                    // work. A later reply that only re-checked them (or was
                    // blocked by the in-flight guard) has no running step of its
                    // own, so it used to stamp "Done - no media" while four
                    // shots were still on the render farm.
                    const filmStillRunning = messages.some(mm =>
                      (mm.agentSteps ?? []).some((st: any) => shotsOutstanding(st)))
                    const continuationPending =
                      m.id === lastMsgId
                      && ((!!lastRow && lastRow.role === "user" && isShotHandback(lastRow.content))
                        || filmStillRunning)
                    const settled = !m.pendingApproval && !shotsRendering && !continuationPending
                      && !((streaming || awaitingReply) && m.id === lastMsgId)
                    // "Done" requires SUBSTANTIVE work — playbook loads and
                    // browsing alone are prep, and a prep-only reply stamped
                    // "Done" reads as a completed job that never happened
                    const SUBSTANTIVE = ["create_media", "generate_image", "edit_image", "delegate_task", "publish_instagram", "dataset_edit", "record_evaluation", "write_summary", "render_shots", "assemble_film", "create_audio"]
                    const hasWork = (m.agentSteps?.some(s => SUBSTANTIVE.includes(s.tool)) ?? false)
                      || (m.imageUrls?.length ?? 0) > 0
                    if (shotsRendering || continuationPending) {
                      return (
                        <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-violet-500/15">
                          <span className="w-4 h-4 rounded-full bg-violet-500/15 border border-violet-500/40 flex items-center justify-center shrink-0">
                            <span className="w-2 h-2 rounded-full border-2 border-violet-400/40 border-t-violet-300 animate-spin" />
                          </span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-300/90">
                            {shotsRendering ? "Shots rendering" : "Still working"}
                          </span>
                          <span className="text-[9px] text-slate-600">
                            {shotsRendering
                              ? "they land here on their own, then the run continues"
                              : filmStillRunning
                                ? "shots from this film are still rendering — the run continues when they land"
                                : "the render queue reported back — picking the film up again"}
                          </span>
                        </div>
                      )
                    }
                    if (!settled || !hasWork) return null
                    const doneMedia = (m.agentSteps ?? []).filter(s =>
                      (s.tool === "create_media" || s.tool === "generate_image" || s.tool === "edit_image") && s.imageUrl)
                    const spent = doneMedia.length
                      ? doneMedia.reduce((sum, s) => sum + (typeof s.cost === "number" ? s.cost : 0), 0)
                      : (m.createInfo?.ticketCost ?? 0)
                    const mediaCount = m.imageUrls?.length ?? 0
                    // A settled reply that ENDS on a question is awaiting the
                    // user, not "Done" (small models ask in prose instead of
                    // the ask_user quiz — honest strip either way)
                    const lastText = (m.textSegments?.length ? m.textSegments[m.textSegments.length - 1] : m.content ?? "").trim()
                    const awaitingAnswer = !m.canceled && !m.errored && /[?？][\s*_)"']*$/.test(lastText.slice(-40))
                    return awaitingAnswer ? (
                      <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-cyan-500/15">
                        <span className="w-4 h-4 rounded-full bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center shrink-0">
                          <HelpCircle size={9} className="text-cyan-400" />
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300/90">Waiting for your reply</span>
                        <span className="text-[9px] text-slate-600">answer in the chat below to continue</span>
                      </div>
                    ) : m.errored && !m.canceled ? (
                      <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-red-500/15">
                        <span className="w-4 h-4 rounded-full bg-red-500/15 border border-red-500/40 flex items-center justify-center shrink-0">
                          <X size={9} className="text-red-400" />
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-red-300/90">Stopped — error</span>
                        <span className="text-[9px] text-slate-600">
                          the run died mid-flight · {typeof m.runMs === "number" && m.runMs > 0 ? `ran ${fmtRun(m.runMs)} · ` : ""}
                          partial work kept{spent > 0 ? ` · ${spent} tickets` : ""}
                        </span>
                      </div>
                    ) : m.canceled ? (
                      <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-amber-500/15">
                        <span className="w-4 h-4 rounded-full bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shrink-0">
                          <X size={9} className="text-amber-400" />
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">Canceled</span>
                        <span className="text-[9px] text-slate-600">
                          stopped by you · {typeof m.runMs === "number" && m.runMs > 0 ? `ran ${fmtRun(m.runMs)} · ` : ""}
                          {mediaCount > 0 ? `${mediaCount} media kept` : "no media"}{spent > 0 ? ` · ${spent} tickets` : ""}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-emerald-500/15">
                        <span className="w-4 h-4 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center shrink-0">
                          <Check size={9} className="text-emerald-400" />
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90">Done</span>
                        <span className="text-[9px] text-slate-600">
                          {typeof m.runMs === "number" && m.runMs > 0 ? `ran ${fmtRun(m.runMs)} · ` : ""}
                          {mediaCount > 0 ? `${mediaCount} media` : "no media"}{spent > 0 ? ` · ${spent} tickets` : ""}
                        </span>
                      </div>
                    )
                  })()}
                  {/* Always-on working row: while this message is the live stream
                      target, never leave the card without a status — text pauses,
                      tool runs, and post-tool composition all keep it visible */}
                  {(streaming || awaitingReply) && m.id === lastMsgId
                    && (m.content || (m.agentSteps?.length ?? 0) > 0 || (m.imageUrls?.length ?? 0) > 0) && (() => {
                    const running = m.agentSteps?.find(s => s.status === "running")
                    const label = running
                      ? running.tool === "delegate_task" ? `Delegating to ${labelFor(running.model)}…`
                        : running.tool === "create_media" ? `Generating ${running.kind ?? "media"} with ${labelFor(running.model)}… (this can take a while)`
                        : running.tool === "web_search" ? "Searching the web…"
                        : running.tool === "search_refs" ? "Searching the reference library…"
                        : running.tool === "dataset" ? "Browsing the dataset…"
                        : running.tool === "dataset_edit" ? "Applying dataset change…"
                        : running.tool === "save_memory" ? "Updating project memory…"
                        : running.tool === "remember" ? "Saving to memory…"
                        : running.tool === "load_skill" ? "Loading a skill playbook…"
                        : running.tool === "publish_instagram" ? "Publishing to Instagram…"
                        : running.tool === "edit_image" ? "Editing image…"
                        : running.tool === "reasoning" ? "Thinking it through…"
                        : running.tool === "record_evaluation" ? "Evaluating image…"
                        : "Working…"
                      : m.model?.startsWith("ollama/")
                        ? `${labelFor(m.model)} is crunching locally — big prompts take minutes on local hardware, and this model doesn't stream a thinking view…`
                        : m.model?.startsWith("runpod/")
                          ? `${labelFor(m.model)} is running on your RunPod GPU — cold starts and big prompts can take a minute…`
                          : `${labelFor(m.model) || "The model"} is working…`
                    return (
                      <div className="flex items-center gap-2 pt-0.5">
                        <span className="inline-flex gap-1 items-center shrink-0">
                          <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                          <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
                          <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
                        </span>
                        <span className="text-[10px] text-cyan-400/90">{label}</span>
                        <span className="text-[10px] text-slate-500 tabular-nums shrink-0">{fmtRun(runElapsedMs)}</span>
                      </div>
                    )
                  })()}
                  </div>
                </div>
              ))}
              {/* Reloaded mid-run before any live progress arrived — plain
                  typing dots, exactly like a normal in-flight reply */}
              {awaitingReply && !streaming && messages[messages.length - 1]?.role === "user" && (
                <div className="self-start flex items-center gap-2 rounded-2xl rounded-bl-md border border-white/10 bg-white/5 px-3.5 py-2.5">
                  <span className="inline-flex gap-1 items-center">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse [animation-delay:300ms]" />
                  </span>
                  <span className="text-[11px] text-slate-400">Working…</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="p-0.5 hover:text-white"><X size={12} /></button>
          </div>
        )}

        {/* Pinned approval bar — per-call approve/deny, can't get lost behind
            a long streamed reply */}
        {(() => {
          const pendingMsg = [...messages].reverse().find(m => m.pendingApproval?.calls?.length && typeof m.id === "number")
          if (!pendingMsg || streaming) return null
          const calls = pendingMsg.pendingApproval!.calls
          // For media calls: the model's spec + the effective settings
          // (model-recommended, overridable via the selects below)
          const mediaInfo = (c: PendingCall) => {
            const input = (c.input ?? {}) as Record<string, unknown>
            if (c.toolName !== "create_media" || typeof input.model !== "string") return null
            const spec = getCreateModel(input.model)
            if (!spec) return null
            const settings = resolveCreateSettings(spec, {
              ...(input.settings && typeof input.settings === "object" ? input.settings : {}),
              ...(approvalSettings[c.toolCallId] ?? {}),
            })
            return { spec, settings, cost: computeCreateCost(spec, settings) }
          }
          const describe = (c: PendingCall): { text: string; cost?: number } => {
            const input = (c.input ?? {}) as Record<string, unknown>
            if (c.toolName === "delegate_task") {
              return { text: `Delegate to ${labelFor(typeof input.model === "string" ? input.model : undefined)}` }
            }
            if (c.toolName === "edit_image") {
              const ops = Array.isArray(input.operations)
                ? (input.operations as any[]).map(o => o?.op).filter(Boolean).join(" → ")
                : ""
              return { text: `Edit an image${ops ? ` (${ops})` : ""} — free, no tickets` }
            }
            if (c.toolName === "edit_instructions") {
              return {
                text: input.action === "save_preset"
                  ? `Save instructions preset${typeof input.preset_name === "string" && input.preset_name ? ` "${input.preset_name}"` : ""}`
                  : "Update this chat's instructions",
              }
            }
            if (c.toolName === "ask_user") {
              const n = Array.isArray(input.questions) ? input.questions.length : 0
              return { text: `Answer ${n} quick question${n === 1 ? "" : "s"} below` }
            }
            if (c.toolName === "publish_instagram") {
              return { text: `Publish ${input.media_type === "reel" ? "a reel" : "an image"} to Instagram — check the caption below` }
            }
            if (c.toolName === "dataset_edit") {
              const a = String(input.action ?? "")
              const ids = Array.isArray(input.image_ids) ? input.image_ids.length : 0
              const label =
                a === "create_bucket" ? `Create bucket "${input.name ?? ""}"`
                : a === "create_folder" ? `Create folder "${input.name ?? ""}"`
                : a === "add_to_bucket" ? `Add ${ids} image${ids === 1 ? "" : "s"} to bucket "${input.bucket ?? ""}"`
                : a === "remove_from_bucket" ? `Remove ${ids} image${ids === 1 ? "" : "s"} from bucket "${input.bucket ?? ""}"`
                : a === "mark_training" ? `${input.marked === false ? "Unmark" : "Mark"} ${ids} image${ids === 1 ? "" : "s"} for training`
                : a === "move_bucket" ? `Move bucket "${input.bucket ?? ""}" to ${input.folder === "root" ? "root" : `folder "${input.folder ?? ""}"`}`
                : "Edit the dataset"
              return { text: `Dataset change: ${label}` }
            }
            if (c.toolName === "propose_plan") {
              const requested = typeof input.ticket_budget === "number" ? Math.max(0, Math.round(input.ticket_budget)) : 0
              const edited = parseInt(planEdits[c.toolCallId]?.budget ?? "")
              const total = !isNaN(edited) && edited >= 0 ? edited : requested
              return {
                text: input.is_update
                  ? `Plan update — needs ${total} more ticket${total === 1 ? "" : "s"}`
                  : `Approve the whole plan below — one approval covers every step`,
                cost: total,
              }
            }
            // The film tools pause for approval too. Without these branches
            // they fell through to the generic label below and the card read
            // "Generate an image" for a shot list or a music cue, priced at a
            // made-up 7 tickets.
            if (c.toolName === "render_shots") {
              const shots = Array.isArray(input.shots) ? (input.shots as any[]) : []
              const cost = shots.reduce((sum, sh) => {
                const spec = typeof sh?.model === "string" ? getCreateModel(sh.model) : null
                return sum + (spec ? computeCreateCost(spec, resolveCreateSettings(spec, sh?.settings)) : 0)
              }, 0)
              const models = [...new Set(shots.map((sh: any) => {
                const spec = typeof sh?.model === "string" ? getCreateModel(sh.model) : null
                return spec?.label ?? sh?.model
              }).filter(Boolean))]
              return {
                text: `Shoot ${shots.length} shot${shots.length === 1 ? "" : "s"}${models.length ? ` — ${models.join(", ")}` : ""}`,
                cost,
              }
            }
            if (c.toolName === "create_audio") {
              const kind = String(input.kind ?? "music")
              return { text: `Generate ${kind === "speech" ? "dialogue audio" : `a ${kind} track`} for the film` }
            }
            if (c.toolName === "assemble_film") return { text: "Cut the film together — free, no tickets" }
            if (c.toolName === "check_shots") return { text: "Check the rendered shots — free, no tickets" }
            if (c.toolName === "extract_frames") return { text: "Pull frames out of a shot — free, no tickets" }
            const mi = mediaInfo(c)
            if (mi) return { text: `Create ${mi.spec.kind} with ${mi.spec.label}`, cost: mi.cost }
            // Unknown tool: name it rather than guessing a price for it.
            return { text: `Run ${String(c.toolName).replace(/_/g, " ")}` }
          }
          const hasFreeEdits = calls.some(c => c.toolName === "edit_image")
          const submit = (autoApproveEdits = false) => {
            respondToApprovals(pendingMsg.id as number,
              calls.map(c => {
                const mi = mediaInfo(c)
                const cin = (c.input ?? {}) as Record<string, any>
                const answers = c.toolName === "ask_user" && Array.isArray(cin.questions)
                  ? cin.questions.slice(0, 4).map((q: any, qi: number) => {
                      const sel = quizAnswers[c.toolCallId]?.[qi] ?? []
                      const answer = sel.map(oi => String(q?.options?.[oi] ?? "")).filter(Boolean).join(", ")
                      return { question: String(q?.question ?? ""), answer: answer || "(no answer)" }
                    })
                  : undefined
                // Plan edits: send the budget only when actually changed
                const pe = c.toolName === "propose_plan" ? planEdits[c.toolCallId] : undefined
                const requested = Math.max(0, Math.round(Number(cin.ticket_budget) || 0))
                const editedBudget = pe ? parseInt(pe.budget) : NaN
                return {
                  toolCallId: c.toolCallId,
                  approved: approvalChoices[c.toolCallId] ?? true,
                  ...(mi ? { settings: mi.settings } : {}),
                  ...(answers ? { answers } : {}),
                  ...(pe && !isNaN(editedBudget) && editedBudget >= 0 && editedBudget !== requested
                    ? { budget_override: editedBudget } : {}),
                  ...(pe?.note?.trim() ? { note: pe.note.trim() } : {}),
                }
              }),
              autoApproveEdits ? { autoApproveEdits: true } : undefined)
            setApprovalChoices({})
            setApprovalSettings({})
            setQuizAnswers({})
            setPlanEdits({})
          }
          const approvedCount = calls.filter(c => approvalChoices[c.toolCallId] ?? true).length
          const quizOnly = calls.every(c => c.toolName === "ask_user")
          const planOnly = calls.every(c => c.toolName === "propose_plan")
          return (
            <div className="px-4 pb-2">
              <div className={`${chatWidthClass} mx-auto rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 shadow-lg shadow-amber-500/5`}>
                <div className="flex items-center gap-2 pb-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  <span className="text-[11px] text-amber-200 font-medium">
                    {planOnly
                      ? `${labelFor(pendingMsg.model)} proposed a plan for your approval`
                      : quizOnly
                        ? `${labelFor(pendingMsg.model)} has a few quick questions`
                        : `${labelFor(pendingMsg.model)} is asking to run ${calls.length} task${calls.length > 1 ? "s" : ""}`}
                  </span>
                </div>
                {calls.map(c => {
                  const d = describe(c)
                  const mi = mediaInfo(c)
                  const cin = (c.input ?? {}) as Record<string, any>
                  const on = approvalChoices[c.toolCallId] ?? true
                  return (
                    <div key={c.toolCallId} className="py-1 border-b border-white/5 last:border-b-0">
                      <div className="flex items-center gap-2">
                        <span className={`flex-1 min-w-0 truncate text-[11px] ${on ? "text-slate-200" : "text-slate-500 line-through"}`} title={d.text}>
                          {d.text}
                        </span>
                        {typeof d.cost === "number" && (
                          <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-cyan-300 tabular-nums">
                            <Ticket size={10} />{d.cost}
                          </span>
                        )}
                        <div className="flex rounded-md border border-white/10 overflow-hidden shrink-0">
                          <button
                            onClick={() => setApprovalChoices(prev => ({ ...prev, [c.toolCallId]: true }))}
                            className={`px-2 py-1 text-[10px] transition-colors ${on ? "bg-emerald-500/20 text-emerald-300" : "text-slate-500 hover:text-white"}`}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => setApprovalChoices(prev => ({ ...prev, [c.toolCallId]: false }))}
                            className={`px-2 py-1 text-[10px] border-l border-white/10 transition-colors ${!on ? "bg-red-500/20 text-red-300" : "text-slate-500 hover:text-white"}`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      {/* Proposed plan — summary, steps, and the summed total */}
                      {c.toolName === "propose_plan" && on && (
                        <div className="mt-1 ml-1 rounded-md bg-black/30 border border-white/10 p-2 space-y-1.5">
                          {typeof cin.summary === "string" && cin.summary && (
                            <div className="text-[11px] text-slate-200 leading-relaxed">{cin.summary}</div>
                          )}
                          {Array.isArray(cin.steps) && cin.steps.length > 0 && (
                            <ol className="space-y-0.5">
                              {cin.steps.slice(0, 12).map((st: any, si: number) => (
                                <li key={si} className="text-[10px] text-slate-400 leading-relaxed">
                                  <span className="text-slate-600">{si + 1}.</span> {String(st)}
                                </li>
                              ))}
                            </ol>
                          )}
                          <div className="flex items-center gap-1 pt-0.5 text-[10px] text-cyan-300">
                            <Ticket size={10} />
                            {cin.is_update
                              ? `+${Math.max(0, Math.round(Number(cin.ticket_budget) || 0))} additional tickets for this change`
                              : `${Math.max(0, Math.round(Number(cin.ticket_budget) || 0))} tickets total — approving covers all steps, no further approvals`}
                          </div>
                          {/* Adjust before approving: budget up/down + free-text tweaks */}
                          <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-white/5">
                            <label className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                              Budget
                              <input
                                type="number"
                                min={0}
                                value={planEdits[c.toolCallId]?.budget ?? String(Math.max(0, Math.round(Number(cin.ticket_budget) || 0)))}
                                onChange={e => setPlanEdits(prev => ({
                                  ...prev,
                                  [c.toolCallId]: { budget: e.target.value, note: prev[c.toolCallId]?.note ?? "" },
                                }))}
                                className="w-16 bg-slate-900 border border-white/10 rounded-md px-1.5 py-1 text-[11px] font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-cyan-500/40 tabular-nums"
                              />
                              <span className="normal-case font-normal text-slate-600">tickets</span>
                            </label>
                            <input
                              value={planEdits[c.toolCallId]?.note ?? ""}
                              onChange={e => setPlanEdits(prev => ({
                                ...prev,
                                [c.toolCallId]: { budget: prev[c.toolCallId]?.budget ?? "", note: e.target.value },
                              }))}
                              maxLength={300}
                              placeholder='Adjustments — e.g. "use 4k" or "swap video to Kling"'
                              className="flex-1 min-w-[160px] bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[10px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
                            />
                          </div>
                        </div>
                      )}
                      {/* Instagram publish — media preview + full caption + destination */}
                      {c.toolName === "publish_instagram" && on && (
                        <div className="mt-1 ml-1 rounded-md bg-black/30 border border-amber-500/20 p-2 space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[10px] text-amber-300">
                            <Instagram size={11} />
                            Publishing to {igUsername ? `@${igUsername}` : "your Instagram account"} — this posts publicly
                          </div>
                          {typeof cin.media_url === "string" && cin.media_url && (
                            cin.media_type === "reel" || /\.(mp4|webm|mov)(\?|$)/i.test(cin.media_url) ? (
                              <video src={cin.media_url} muted playsInline controls className="max-h-40 rounded-md border border-white/10" />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={cin.media_url} alt="Media to publish" className="max-h-40 rounded-md border border-white/10" />
                            )
                          )}
                          {typeof cin.caption === "string" && (
                            <div className="max-h-28 overflow-y-auto overscroll-contain rounded-md bg-black/40 border border-white/10 p-2 text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words">
                              {cin.caption}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Proposed instructions text — review before approving */}
                      {c.toolName === "edit_instructions" && on && typeof cin.text === "string" && (
                        <div className="mt-1 ml-1 max-h-32 overflow-y-auto overscroll-contain rounded-md bg-black/30 border border-white/10 p-2 text-[10px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">
                          {cin.text}
                        </div>
                      )}
                      {/* ask_user quiz — clickable options per question */}
                      {c.toolName === "ask_user" && on && Array.isArray(cin.questions) && (
                        <div className="flex flex-col gap-2 pt-1.5 pl-1">
                          {cin.questions.slice(0, 4).map((q: any, qi: number) => {
                            const sel = quizAnswers[c.toolCallId]?.[qi] ?? []
                            const multi = !!q?.allow_multiple
                            return (
                              <div key={qi}>
                                <div className="text-[11px] text-slate-200 pb-1">
                                  {qi + 1}. {String(q?.question ?? "")}
                                  {multi && <span className="text-slate-500 text-[9px]"> (pick any)</span>}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {(Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((opt: any, oi: number) => {
                                    const active = sel.includes(oi)
                                    return (
                                      <button
                                        key={oi}
                                        onClick={() => setQuizAnswers(prev => {
                                          const cur = prev[c.toolCallId]?.[qi] ?? []
                                          const next = multi
                                            ? (cur.includes(oi) ? cur.filter(x => x !== oi) : [...cur, oi])
                                            : (cur.includes(oi) ? [] : [oi])
                                          return { ...prev, [c.toolCallId]: { ...(prev[c.toolCallId] ?? {}), [qi]: next } }
                                        })}
                                        className={`px-2 py-1 rounded-md border text-[10px] transition-colors ${
                                          active
                                            ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-200"
                                            : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                                        }`}
                                      >
                                        {String(opt)}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {/* Editable media configuration — tweak before approving; cost updates live */}
                      {mi && on && (mi.spec.fields?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap pt-1 pl-1">
                          {mi.spec.fields!.map(f => (
                            <label key={f.key} className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                              {f.label}
                              <select
                                value={mi.settings[f.key] ?? f.def}
                                onChange={e => setApprovalSettings(prev => ({
                                  ...prev,
                                  [c.toolCallId]: { ...(prev[c.toolCallId] ?? {}), [f.key]: e.target.value },
                                }))}
                                className="bg-slate-900 border border-white/10 rounded-md px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-cyan-500/40"
                              >
                                {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                              </select>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center gap-2 flex-wrap pt-1.5">
                  <button
                    onClick={() => submit(false)}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                  >
                    {planOnly ? "Approve plan" : quizOnly ? "Submit answers" : `Run ${approvedCount}/${calls.length}`}
                  </button>
                  {hasFreeEdits && (
                    <button
                      onClick={() => submit(true)}
                      className="px-3 py-1.5 rounded-lg text-[11px] bg-emerald-500/10 border border-emerald-500/25 text-emerald-300/90 hover:bg-emerald-500/20 transition-colors"
                      title="Approve, and stop asking for further free image edits in this run (generations that cost tickets still ask)"
                    >
                      Run + don&apos;t ask for edits again
                    </button>
                  )}
                  <button
                    onClick={() => {
                      respondToApprovals(pendingMsg.id as number,
                        calls.map(c => ({ toolCallId: c.toolCallId, approved: false })))
                      setApprovalChoices({})
                      setQuizAnswers({})
                    }}
                    className="px-3 py-1.5 rounded-lg text-[11px] border border-white/10 text-slate-400 hover:text-red-400 hover:border-red-500/30 transition-colors"
                  >
                    {planOnly ? "Deny plan" : quizOnly ? "Skip questions" : "Deny all"}
                  </button>
                  <span className="text-[9px] text-amber-400/60">
                    {queueMode
                      ? "Replies typed below are queued and send after you resolve this request."
                      : "Or just reply below to add context — this request is cancelled and the model can re-ask."}
                  </span>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Queued messages — waiting for approvals/stream to clear */}
        {activeChatId && queued.length > 0 && (
          <div className="px-4 pb-1.5">
            <div className={`${chatWidthClass} mx-auto flex flex-col gap-1`}>
              {queued.map((q, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.06] px-2.5 py-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60 animate-pulse shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300" title={q.content}>
                    {q.content}
                  </span>
                  <span className="shrink-0 text-[9px] text-slate-600 uppercase tracking-wider">Queued #{i + 1}</span>
                  <button
                    onClick={() => setQueued(prev => prev.filter((_, j) => j !== i))}
                    className="p-0.5 rounded text-slate-500 hover:text-red-400"
                    title="Remove from queue"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Composer */}
        {activeChatId && (
          <div className="px-4 pb-4 pt-1">
            <div className={`relative isolate ${chatWidthClass} mx-auto rounded-2xl border border-white/10 bg-slate-900/80 backdrop-blur px-3.5 pt-3 pb-2 focus-within:border-cyan-500/40 transition-colors`}>
              <SilverRim rounded={16} />
              {editChip}
              {createChip}
              {refStrip}
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={e => { setInput(e.target.value); noteDraft(activeChatId, e.target.value); autoGrow(e.target); historyIndexRef.current = null }}
                onKeyDown={handleComposerKey}
                placeholder={composerPlaceholder}
                style={{ fontSize: chatTextPx, minHeight: 72 }}
                className="w-full bg-transparent resize-none outline-none leading-relaxed text-white placeholder:text-slate-500 max-h-[320px]"
              />
              <div className="flex items-center gap-1.5 pt-1.5 flex-wrap">
                {renderPlusMenu("up")}
                {renderModelDropdown("up")}
                {agentModeChip}
                {movieFormatChip}
                <div className="flex-1" />
                {streaming ? (
                  <>
                    {queueMode && input.trim() && (
                      <button
                        onClick={send}
                        className="shrink-0 flex items-center gap-1 px-2.5 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-[10px] hover:bg-cyan-500/20 transition-colors"
                        title="Queue this message — it sends when the current run finishes"
                      >
                        <Send size={12} /> Queue
                      </button>
                    )}
                    <button
                      onClick={stopStreaming}
                      disabled={cancelPending}
                      className={`shrink-0 flex items-center gap-1.5 p-2 rounded-xl border transition-colors ${
                        cancelPending
                          ? "bg-amber-500/15 border-amber-500/30 text-amber-300 cursor-default"
                          : "bg-red-500/15 border-red-500/30 text-red-300 hover:bg-red-500/25"
                      }`}
                      title={cancelPending
                        ? "Canceling — letting the current step finish, then stopping"
                        : "Cancel the run (in-flight generations finish, then it stops)"}
                    >
                      <Square size={14} />
                      {cancelPending && <span className="text-[10px]">Canceling…</span>}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={send}
                    disabled={!input.trim()}
                    className="shrink-0 flex items-center gap-1.5 p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title={createMode ? `Generate (${createCost} tickets)` : "Send"}
                  >
                    <Send size={14} />
                    {createMode && (
                      <span className="flex items-center gap-0.5 text-[11px] tabular-nums pr-0.5">
                        <Ticket size={11} />{createCost}
                      </span>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Message context menu (right-click / long-press on user bubbles) ── */}
      {msgMenu && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[100000]"
          onClick={() => setMsgMenu(null)}
          onContextMenu={e => { e.preventDefault(); setMsgMenu(null) }}
        >
          <div
            style={{ left: msgMenu.x, top: msgMenu.y }}
            className="absolute w-44 rounded-xl border border-white/10 bg-[#12121f] shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={async () => { await copyToClipboard(msgMenu.content); setMsgMenu(null) }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-slate-200 hover:bg-white/10 active:bg-white/15 text-left transition-colors"
            >
              <Copy size={13} className="text-slate-400 shrink-0" /> Copy message
            </button>
            <button
              disabled={streaming || !activeChatId}
              onClick={() => {
                const mm = msgMenu
                setMsgMenu(null)
                if (mm && activeChatId) sendMessage(activeChatId, mm.content, mm.imageUrls)
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-slate-200 hover:bg-white/10 active:bg-white/15 text-left border-t border-white/5 disabled:opacity-40 transition-colors"
              title="Send this message again with the same reference images"
            >
              <RotateCcw size={13} className="text-slate-400 shrink-0" /> Retry
              {(msgMenu.imageUrls.length > 0) && (
                <span className="ml-auto text-[9px] text-slate-500">{msgMenu.imageUrls.length} ref{msgMenu.imageUrls.length > 1 ? "s" : ""}</span>
              )}
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ── Media viewer popup — zoomable preview, movable info panel,
             Add-to-refs / Edit actions (portal-v2 session-feed style) ── */}
      {mediaViewer && typeof document !== "undefined" && createPortal(
        <div
          className={`fixed inset-0 z-[99999] flex items-center justify-center ${viewerFull ? "p-0" : "p-3 sm:p-6"}`}
          onClick={() => setMediaViewer(null)}
          onPointerUp={e => {
            // Touch: close on pointerup and swallow the ghost click, the same
            // way the header's X does — a tap on the backdrop that only fired
            // `click` could be eaten by the element underneath.
            if (e.pointerType !== "touch" || e.target !== e.currentTarget) return
            setMediaViewer(null)
            const swallow = (ev: MouseEvent) => { ev.preventDefault(); ev.stopPropagation() }
            window.addEventListener("click", swallow, { capture: true, once: true })
            setTimeout(() => window.removeEventListener("click", swallow, { capture: true } as any), 400)
          }}
        >
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
          <div
            className={viewerFull
              ? "relative w-full h-full flex flex-col bg-black overflow-hidden"
              : "relative w-[96vw] max-w-[1700px] h-[94vh] flex flex-col rounded-2xl border border-white/10 bg-[#0e0e18] shadow-2xl overflow-hidden"}
            onClick={e => e.stopPropagation()}
          >
            {/* Full view: floating eye/close controls over the bare image */}
            {viewerFull && (
              <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
                <button onClick={() => setViewerFull(false)}
                  className="p-2.5 rounded-full bg-black/60 backdrop-blur border border-white/15 text-white/90 hover:bg-black/80 transition-colors"
                  title="Show controls">
                  <Eye size={16} />
                </button>
                <button onClick={() => setMediaViewer(null)}
                  className="p-2.5 rounded-full bg-black/60 backdrop-blur border border-white/15 text-white/90 hover:bg-black/80 transition-colors">
                  <X size={16} />
                </button>
              </div>
            )}
            {/* Header: identity + zoom + layout controls */}
            {!viewerFull && (
            <div className="relative z-20 flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-white/5 shrink-0 flex-wrap">
              {mediaViewer.isRef ? (
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Reference image</span>
              ) : (
                <>
                  <span className={`text-[11px] px-2 py-0.5 rounded-md border ${accentFor(mediaViewer.modelId).chip}`}>
                    {labelFor(mediaViewer.modelId) || "Generated media"}
                  </span>
                  {mediaViewer.kind && (
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">{mediaViewer.kind}</span>
                  )}
                  {typeof mediaViewer.cost === "number" && (
                    <span className="flex items-center gap-0.5 text-[11px] text-cyan-300 tabular-nums">
                      <Ticket size={11} />{mediaViewer.cost}
                    </span>
                  )}
                </>
              )}
              <div className="flex-1" />
              {!mediaViewer.isVideo && (
                <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
                  <button
                    onClick={() => setViewerZoom(z => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10"
                    title="Zoom out"
                  >
                    <ZoomOut size={13} />
                  </button>
                  <span className="px-1.5 text-[10px] text-slate-500 tabular-nums min-w-[38px] text-center">
                    {Math.round(viewerZoom * 100)}%
                  </span>
                  <button
                    onClick={() => setViewerZoom(z => Math.min(4, Math.round((z + 0.5) * 2) / 2))}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 border-l border-white/10"
                    title="Zoom in"
                  >
                    <ZoomIn size={13} />
                  </button>
                </div>
              )}
              {/* Editing is disabled while the model is working: re-rendering a
                  layer mid-run competes with the run for the same conversation
                  and the result lands in a reply that has already moved on.
                  The viewer stays open as display-only. */}
              {mediaViewer.recipe && !streaming && (
                <button
                  onClick={() => {
                    setLayersOpen(o => {
                      const next = !o
                      // Opening the editor while the panel is hidden brings it back
                      if (next && viewerPanel === "hidden") setPanel("right")
                      return next
                    })
                  }}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[10px] transition-colors ${
                    layersOpen && viewerPanel !== "hidden"
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                      : "border-white/10 text-slate-400 hover:text-white hover:bg-white/10"
                  }`}
                  title="Layer editor — tweak the model's edit ops and re-render"
                >
                  <Layers size={12} /> Layers
                </button>
              )}
              {!mediaViewer.isRef && (
                <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
                  <button onClick={() => setPanel("left")} title="Info panel left"
                    className={`p-1.5 ${viewerPanel === "left" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-400 hover:text-white hover:bg-white/10"}`}>
                    <PanelLeft size={13} />
                  </button>
                  <button onClick={() => setPanel("right")} title="Info panel right"
                    className={`p-1.5 border-l border-white/10 ${viewerPanel === "right" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-400 hover:text-white hover:bg-white/10"}`}>
                    <PanelRight size={13} />
                  </button>
                  <button onClick={() => setPanel("bottom")} title="Info panel below"
                    className={`p-1.5 border-l border-white/10 ${viewerPanel === "bottom" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-400 hover:text-white hover:bg-white/10"}`}>
                    <PanelBottom size={13} />
                  </button>
                  <button onClick={() => setViewerFull(true)} title="Full view — image only, no controls"
                    className="p-1.5 border-l border-white/10 text-slate-400 hover:text-white hover:bg-white/10">
                    <Eye size={13} />
                  </button>
                </div>
              )}
              <a href={mediaViewer.url} target="_blank" rel="noreferrer"
                className="text-[10px] text-slate-500 hover:text-cyan-300 transition-colors">
                Original ↗
              </a>
              <button onClick={() => setMediaViewer(null)}
                onPointerUp={e => {
                  if (e.pointerType !== "touch") return
                  // Closing on pointerup unmounts the popup BEFORE the browser
                  // fires the follow-up click — which then lands on whatever
                  // sits underneath (the taskbar!). Swallow that ghost click.
                  const swallow = (ev: MouseEvent) => { ev.preventDefault(); ev.stopPropagation() }
                  document.addEventListener("click", swallow, { capture: true, once: true })
                  setTimeout(() => document.removeEventListener("click", swallow, true), 400)
                  setMediaViewer(null)
                }}
                className="relative z-30 shrink-0 p-2.5 rounded-md text-slate-400 hover:text-white hover:bg-white/10">
                <X size={15} />
              </button>
            </div>
            )}

            {/* Body: media + info panel (right / bottom / hidden) */}
            <div className={`flex-1 min-h-0 flex ${(viewerPanel === "right" || viewerPanel === "left") && !mediaViewer.isRef ? "flex-row" : "flex-col"}`}>
              <div className="flex-1 min-w-0 min-h-0 overflow-auto overscroll-contain bg-black/40 flex">
                {mediaViewer.isVideo ? (
                  <video src={mediaViewer.url} controls autoPlay playsInline className="m-auto max-w-full max-h-full" />
                ) : viewerZoom === 1 ? (
                  /* Definite-size wrapper: a bare m-auto img inside a scroll
                     flex container collapses to a thumbnail on Safari.
                     `relative` so the canvas-edit overlay can sit exactly on
                     the displayed image. */
                  <div className="relative w-full h-full flex items-center justify-center p-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      ref={viewerImgRef}
                      src={mediaViewer.url}
                      alt=""
                      onLoad={measureViewerImg}
                      className="max-w-full max-h-full object-contain"
                    />
                    {/* ── Canvas editing overlay: tap to select a layer, drag
                        to move it, pinch (or corner handle) to resize ── */}
                    {/* Hidden preload: captures the SOURCE image's natural
                        dims (≠ final dims once crop/resize are in the chain) */}
                    {layersOpen && mediaViewer.recipe?.image_url && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={mediaViewer.recipe.image_url} alt="" className="hidden"
                        onLoad={e => setBaseDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                    )}
                    {mediaViewer.recipe && layersOpen && imgBox && (() => {
                      const geom = computeGeom()
                      const lp = canLivePreview ? buildLiveCanvas() : null
                      const sDisp = lp ? (imgBox.w / lp.w || 1) : (imgBox.w / imgBox.natW || 1)
                      const selOp = layerSel != null ? layerOps[layerSel] : null
                      const b0 = selOp && layerSpatial(selOp) ? opBounds(selOp) : null
                      const t = (layerSel != null ? geom?.xf?.[layerSel] : null) ?? { s: 1, dx: 0, dy: 0 }
                      // Selection box mapped op-space → final canvas → screen
                      const b = b0 ? { x: b0.x * t.s + t.dx, y: b0.y * t.s + t.dy, w: b0.w * t.s, h: b0.h * t.s } : null
                      return (
                        <div
                          className="absolute"
                          style={{
                            left: imgBox.left, top: imgBox.top, width: imgBox.w, height: imgBox.h,
                            touchAction: "none",
                            cursor: paintMode && selOp && layerErasable(selOp) && canLivePreview
                              ? "crosshair" : b ? "move" : "default",
                          }}
                          onPointerDown={onCanvasPointerDown}
                          onPointerMove={onCanvasPointerMove}
                          onPointerUp={onCanvasPointerUp}
                          onPointerCancel={onCanvasPointerUp}
                        >
                          {/* LIVE canvas: the full pipeline rebuilt client-side
                              (crop/resize/pad included) — layers move WITH the
                              drag. Covers the baked img beneath 1:1. */}
                          {lp && (
                            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                              <div className="absolute left-0 top-0"
                                style={{ width: lp.w, height: lp.h, transform: `scale(${sDisp})`, transformOrigin: "top left" }}>
                                {lp.node}
                              </div>
                            </div>
                          )}
                          {b && (
                            <div
                              className="absolute border-2 border-dashed border-emerald-400/90 bg-emerald-400/10 rounded-sm pointer-events-none"
                              style={{
                                left: b.x * sDisp, top: b.y * sDisp,
                                width: Math.max(10, b.w * sDisp), height: Math.max(10, b.h * sDisp),
                                // The rotation pivot IS the box center on both
                                // sides, so rotating the box visual makes it hug
                                // rotated text/shapes/overlays exactly
                                ...(Number(selOp?.rotate)
                                  ? { transform: `rotate(${Math.round(Number(selOp.rotate))}deg)` }
                                  : {}),
                              }}
                            >
                              <div className="absolute -top-5 left-0 text-[9px] px-1 py-px rounded bg-emerald-500/90 text-black font-semibold whitespace-nowrap">
                                {layerSel! + 1} · {layerLabel(selOp)}
                              </div>
                            </div>
                          )}
                          {b && (() => {
                            const handles = [
                              { k: "nw", hx: b.x, hy: b.y, cur: "nwse-resize" },
                              { k: "ne", hx: b.x + b.w, hy: b.y, cur: "nesw-resize" },
                              { k: "sw", hx: b.x, hy: b.y + b.h, cur: "nesw-resize" },
                              { k: "se", hx: b.x + b.w, hy: b.y + b.h, cur: "nwse-resize" },
                              { k: "n", hx: b.x + b.w / 2, hy: b.y, cur: "ns-resize" },
                              { k: "s", hx: b.x + b.w / 2, hy: b.y + b.h, cur: "ns-resize" },
                              { k: "w", hx: b.x, hy: b.y + b.h / 2, cur: "ew-resize" },
                              { k: "e", hx: b.x + b.w, hy: b.y + b.h / 2, cur: "ew-resize" },
                            ]
                            const rotatable = selOp && (selOp.op === "overlay" || selOp.op === "text" || selOp.op === "shape")
                            return (
                              <>
                                {handles.map(h => (
                                  <div key={h.k}
                                    onPointerDown={e => beginHandleResize(e, h.k)}
                                    className={`absolute rounded-sm bg-emerald-400 border border-black/60 shadow-md ${
                                      h.k.length === 2 ? "w-3.5 h-3.5" : "w-3 h-3"
                                    }`}
                                    style={{
                                      left: h.hx * sDisp - (h.k.length === 2 ? 7 : 6),
                                      top: h.hy * sDisp - (h.k.length === 2 ? 7 : 6),
                                      touchAction: "none", cursor: h.cur,
                                    }}
                                    title="Drag to resize"
                                  />
                                ))}
                                {rotatable && (
                                  <>
                                    {/* stem + round rotation grip above the box */}
                                    <div className="absolute w-px bg-emerald-400/60 pointer-events-none"
                                      style={{ left: (b.x + b.w / 2) * sDisp, top: b.y * sDisp - 22, height: 22 }} />
                                    <div
                                      onPointerDown={beginRotate}
                                      className="absolute w-4 h-4 rounded-full bg-emerald-400 border border-black/60 shadow-md"
                                      style={{
                                        left: (b.x + b.w / 2) * sDisp - 8,
                                        top: b.y * sDisp - 30,
                                        touchAction: "none", cursor: "grab",
                                      }}
                                      title="Drag to rotate (snaps at 15° stops)"
                                    />
                                  </>
                                )}
                              </>
                            )
                          })()}
                        </div>
                      )
                    })()}
                  </div>
                ) : (
                  /* zoomed: image wider than the container — scroll to pan */
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={mediaViewer.url} alt="" style={{ width: `${viewerZoom * 100}%`, maxWidth: "none" }}
                    className="m-auto h-auto" />
                )}
              </div>
              {/* "Hide the GUI" wins over everything — the image gets the whole
                  popup; the Layers header button brings the panel back */}
              {!mediaViewer.isRef && viewerPanel !== "hidden" && !viewerFull && (
                <div className={`shrink-0 overflow-y-auto overscroll-contain bg-black/20 ${
                  viewerPanel === "left" ? "order-first w-60 sm:w-80 border-r border-white/5"
                  : viewerPanel === "right" ? "w-60 sm:w-80 border-l border-white/5"
                  : "max-h-[40%] border-t border-white/5"
                } px-3.5 py-3 space-y-2.5`}>
                  {/* ── LAYER EDITOR: the model's edit ops, re-editable ── */}
                  {mediaViewer.recipe && layersOpen && (
                    <div className="space-y-2 pb-2 border-b border-white/10">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                          <Layers size={11} /> Layers
                        </span>
                        <div className="flex items-center gap-1">
                          <div className="relative">
                            <button
                              onClick={() => setInsertMenuOpen(v => !v)}
                              disabled={layerBusy}
                              className={`p-1.5 rounded-md border transition-colors disabled:opacity-30 ${
                                insertMenuOpen
                                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                                  : "border-white/10 text-slate-400 hover:text-white hover:bg-white/10"
                              }`}
                              title="Add a layer"
                            >
                              <Plus size={11} />
                            </button>
                            {insertMenuOpen && (
                              <>
                              <div className="fixed inset-0 z-10" onClick={() => setInsertMenuOpen(false)} />
                              <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl py-1">
                                <button
                                  onClick={() => { setInsertMenuOpen(false); layerImageInputRef.current?.click() }}
                                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5 hover:text-white"
                                >
                                  <ImageIcon size={12} className="text-cyan-400" /> Image…
                                </button>
                                <button
                                  onClick={insertColorLayer}
                                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5 hover:text-white"
                                >
                                  <span className="w-3 h-3 rounded-sm bg-slate-400 border border-white/20" /> Color fill
                                </button>
                                <button
                                  onClick={insertTransparentLayer}
                                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5 hover:text-white"
                                >
                                  <span className="w-3 h-3 rounded-sm border border-dashed border-white/40" /> Transparent
                                </button>
                              </div>
                              </>
                            )}
                          </div>
                          <button
                            onClick={undoLayers}
                            disabled={!layerPast.length}
                            className="p-1.5 rounded-md border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
                            title="Undo (Ctrl+Z)"
                          >
                            <RotateCcw size={11} />
                          </button>
                          <button
                            onClick={redoLayers}
                            disabled={!layerFuture.length}
                            className="p-1.5 rounded-md border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
                            title="Redo (Ctrl+Shift+Z)"
                          >
                            <RotateCw size={11} />
                          </button>
                          <button
                            onClick={applyLayers}
                            disabled={layerBusy}
                            className="px-2.5 py-1 rounded-md text-[10px] font-semibold bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                          >
                            {layerBusy ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </div>
                      {layerErr && <div className="text-[10px] text-red-400">{layerErr}</div>}
                      <input
                        ref={layerImageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0]
                          e.target.value = ""
                          if (f) insertImageLayer(f)
                        }}
                      />
                      <div className="space-y-1">
                        {layerOps.map((o, i) => {
                          const off = layerDisabled.has(i)
                          const sel = layerSel === i
                          const dragTarget = dragRow && dragRow.to === i && dragRow.from !== i
                          const dragging = dragRow && dragRow.from === i
                          return (
                            <div key={i} data-lrow className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${
                              sel ? "border-emerald-500/40 bg-emerald-500/10" : "border-white/10 bg-white/[0.03]"
                            } ${off ? "opacity-40" : ""} ${dragging ? "opacity-60 border-cyan-400/50" : ""} ${
                              dragTarget ? "ring-1 ring-cyan-400/70" : ""}`}>
                              <span
                                onPointerDown={e => beginLayerRowDrag(e, i)}
                                className="shrink-0 text-slate-600 hover:text-slate-300 cursor-grab"
                                style={{ touchAction: "none" }}
                                title="Drag to reorder (paint order: top of list = painted first = bottom layer)"
                              >
                                <GripVertical size={11} />
                              </span>
                              <button
                                onClick={() => setLayerDisabled(prev => {
                                  const next = new Set(prev)
                                  if (next.has(i)) next.delete(i)
                                  else next.add(i)
                                  return next
                                })}
                                className="shrink-0 text-slate-500 hover:text-white"
                                title={off ? "Show layer" : "Hide layer"}
                              >
                                {off ? <EyeOff size={11} /> : <Eye size={11} />}
                              </button>
                              <button
                                onClick={() => setLayerSel(sel ? null : i)}
                                className={`flex-1 min-w-0 truncate text-left text-[10px] ${sel ? "text-emerald-200" : "text-slate-300"}`}
                              >
                                {i + 1} · {layerLabel(o)}
                              </button>
                              <button
                                onClick={() => deleteLayer(i)}
                                className="shrink-0 text-slate-600 hover:text-red-400 transition-colors"
                                title="Delete layer"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                      {layerSel != null && layerOps[layerSel] && (() => {
                        const o = layerOps[layerSel]
                        const i = layerSel
                        const num = (label: string, key: string, fallback = 0) => (
                          <label key={key} className="flex flex-col gap-0.5 text-[9px] text-slate-500 uppercase tracking-wider">
                            {label}
                            <input
                              type="number"
                              value={Number.isFinite(Number(o[key])) ? Number(o[key]) : fallback}
                              onChange={e => patchLayer(i, { [key]: Number(e.target.value) })}
                              className="w-full bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] normal-case tracking-normal text-white outline-none focus:border-emerald-500/40 tabular-nums"
                            />
                          </label>
                        )
                        const hex = (label: string, key: string, def: string) => (
                          <label key={key} className="flex flex-col gap-0.5 text-[9px] text-slate-500 uppercase tracking-wider">
                            {label}
                            <input
                              value={typeof o[key] === "string" ? o[key] : def}
                              onChange={e => patchLayer(i, { [key]: e.target.value })}
                              placeholder={def}
                              className="w-full bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] normal-case tracking-normal text-white outline-none focus:border-emerald-500/40 font-mono"
                            />
                          </label>
                        )
                        return (
                          <div className="space-y-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] p-2">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => duplicateLayer(i)}
                                className="px-1.5 py-0.5 rounded text-[10px] border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
                              >
                                Duplicate
                              </button>
                              <button
                                onClick={() => mergeWithPrevious(i)}
                                disabled={i === 0 || layerBusy}
                                className="px-1.5 py-0.5 rounded text-[10px] border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
                                title="Bake this layer + the previous one into a single image layer (this one stays on top)"
                              >
                                {layerBusy ? "Merging…" : "Merge into previous"}
                              </button>
                            </div>
                            {layerSpatial(o) && viewerZoom === 1 && (
                              <div className="text-[9px] text-emerald-400/70">
                                {canLivePreview
                                  ? "Edit right on the image: drag to move, pinch or the corner handle to resize — the canvas updates live. Save when you're happy."
                                  : "This recipe uses ops the live preview can't render (rotate, flip, patch, AI masking) — drag the box to position things, then Save to see the result."}
                              </div>
                            )}
                            {canLivePreview && layerErasable(o) && viewerZoom === 1 && (
                              <div className="space-y-1.5 rounded-md border border-white/10 bg-black/20 p-1.5">
                                <div className="flex items-center justify-between gap-1">
                                  <div className="flex rounded-md border border-white/10 overflow-hidden">
                                    {([
                                      ["select", "Select", MousePointerClick],
                                      ["brush", "Brush", Brush],
                                      ["erase", "Erase", Eraser],
                                    ] as const).map(([mode, label, Icon], k) => (
                                      <button
                                        key={mode}
                                        onClick={() => setCursorMode(mode)}
                                        className={`flex items-center gap-1 px-1.5 py-1 text-[10px] transition-colors ${k > 0 ? "border-l border-white/10" : ""} ${
                                          cursorMode === mode
                                            ? mode === "brush" ? "bg-cyan-500/20 text-cyan-300"
                                              : mode === "erase" ? "bg-rose-500/20 text-rose-300"
                                              : "bg-emerald-500/20 text-emerald-300"
                                            : "text-slate-500 hover:text-white hover:bg-white/5"
                                        }`}
                                        title={mode === "select" ? "Move & resize" : mode === "brush" ? "Paint onto this layer" : "Erase from this layer"}
                                      >
                                        <Icon size={10} /> {label}
                                      </button>
                                    ))}
                                  </div>
                                  {cursorMode === "brush" && Array.isArray(o.draw) && o.draw.length > 0 && (
                                    <button onClick={() => patchLayer(i, { draw: [] })}
                                      className="text-[9px] text-slate-500 hover:text-cyan-300 transition-colors shrink-0">
                                      Clear ({o.draw.length})
                                    </button>
                                  )}
                                  {cursorMode === "erase" && Array.isArray(o.erase) && o.erase.length > 0 && (
                                    <button onClick={() => patchLayer(i, { erase: [] })}
                                      className="text-[9px] text-slate-500 hover:text-rose-300 transition-colors shrink-0">
                                      Clear ({o.erase.length})
                                    </button>
                                  )}
                                </div>
                                {paintMode && (() => {
                                  const accent = cursorMode === "brush" ? "accent-cyan-400" : "accent-rose-400"
                                  return (
                                    <>
                                      {cursorMode === "brush" && (
                                        <label className="flex items-center gap-1.5 text-[9px] text-slate-500 uppercase tracking-wider">
                                          Color
                                          <input type="color" value={brushColor}
                                            onChange={e => setBrushColor(e.target.value)}
                                            className="h-6 w-8 rounded bg-transparent border border-white/10 cursor-pointer" />
                                          <input value={brushColor} onChange={e => setBrushColor(e.target.value)}
                                            className="flex-1 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] normal-case tracking-normal text-white outline-none focus:border-cyan-500/40 font-mono" />
                                        </label>
                                      )}
                                      <label className="flex items-center gap-1.5 text-[9px] text-slate-500 uppercase tracking-wider">
                                        Size
                                        <input type="range" min={4} max={200} value={brushSize}
                                          onChange={e => setBrushSize(Number(e.target.value))} className={`flex-1 ${accent}`} />
                                        <span className="w-9 text-right text-slate-300 normal-case tabular-nums">{brushSize}px</span>
                                      </label>
                                      <label className="flex items-center gap-1.5 text-[9px] text-slate-500 uppercase tracking-wider">
                                        Opacity
                                        <input type="range" min={5} max={100} value={Math.round(brushOpacity * 100)}
                                          onChange={e => setBrushOpacity(Number(e.target.value) / 100)} className={`flex-1 ${accent}`} />
                                        <span className="w-9 text-right text-slate-300 normal-case tabular-nums">{Math.round(brushOpacity * 100)}%</span>
                                      </label>
                                      <div className={`text-[9px] ${cursorMode === "brush" ? "text-cyan-300/70" : "text-rose-300/70"}`}>
                                        {cursorMode === "brush"
                                          ? "Draw on the image to paint onto this layer. Strokes follow the layer when you move/resize it; Undo removes the last stroke."
                                          : "Draw on the image to erase from this layer. Strokes follow the layer when you move/resize it; Undo removes the last stroke."}
                                      </div>
                                    </>
                                  )
                                })()}
                              </div>
                            )}
                            {o.op === "text" && (
                              <>
                                <input
                                  value={String(o.text ?? "")}
                                  onChange={e => patchLayer(i, { text: e.target.value })}
                                  className="w-full bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-emerald-500/40"
                                />
                                <div className="grid grid-cols-3 gap-1.5">{num("x", "x")}{num("y", "y")}{num("size", "size", 48)}</div>
                                <div className="grid grid-cols-3 gap-1.5">
                                  {hex("color", "color", "#ffffff")}
                                  {hex("stroke", "stroke", "")}
                                  {num("rotate (deg)", "rotate", 0)}
                                </div>
                                <div className="grid grid-cols-2 gap-1.5">
                                  <select value={o.font ?? "sans"} onChange={e => patchLayer(i, { font: e.target.value })}
                                    className="bg-slate-900 border border-white/10 rounded px-1 py-1 text-[10px] text-slate-200">
                                    {["sans", "serif", "mono", "impact", "script", "condensed"].map(f => <option key={f} value={f}>{f}</option>)}
                                  </select>
                                  <select value={o.align ?? "left"} onChange={e => patchLayer(i, { align: e.target.value })}
                                    className="bg-slate-900 border border-white/10 rounded px-1 py-1 text-[10px] text-slate-200">
                                    <option value="left">left</option><option value="center">center</option>
                                  </select>
                                </div>
                              </>
                            )}
                            {o.op === "shape" && (
                              <>
                                <div className="grid grid-cols-3 gap-1.5">
                                  {hex("fill", "fill", "#000000")}
                                  {num("opacity (0-1)", "opacity", 1)}
                                  {num("rotate (deg)", "rotate", 0)}
                                </div>
                                {o.shape === "circle" ? (
                                  <div className="grid grid-cols-3 gap-1.5">{num("cx", "cx")}{num("cy", "cy")}{num("r", "r", 50)}</div>
                                ) : o.shape === "line" ? (
                                  <div className="grid grid-cols-4 gap-1.5">{num("x", "x")}{num("y", "y")}{num("x2", "x2")}{num("y2", "y2")}</div>
                                ) : (
                                  <>
                                    <div className="grid grid-cols-2 gap-1.5">{num("x", "x")}{num("y", "y")}</div>
                                    <div className="grid grid-cols-2 gap-1.5">{num("width", "width", 100)}{num("height", "height", 100)}</div>
                                  </>
                                )}
                              </>
                            )}
                            {o.op === "overlay" && (
                              <>
                                <div className="grid grid-cols-2 gap-1.5">{num("x", "x")}{num("y", "y")}</div>
                                <div className="grid grid-cols-2 gap-1.5">{num("width", "width", 0)}{num("height (0=auto)", "height", 0)}</div>
                                <div className="grid grid-cols-2 gap-1.5">{num("rotate (deg)", "rotate", 0)}{num("opacity (0-1)", "opacity", 1)}</div>
                                <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
                                  <input type="checkbox" checked={o.flip === "horizontal"}
                                    onChange={e => patchLayer(i, { flip: e.target.checked ? "horizontal" : undefined })} />
                                  mirror horizontally
                                </label>
                              </>
                            )}
                            {o.op === "silhouette" && (
                              <>
                                {hex("color", "color", "#ffffff")}
                                <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
                                  <input type="checkbox" checked={o.on_original !== false}
                                    onChange={e => patchLayer(i, { on_original: e.target.checked })} />
                                  composite over original
                                </label>
                              </>
                            )}
                            {o.op === "starfield" && (
                              <>
                                <div className="grid grid-cols-2 gap-1.5">
                                  {num("density (0.2-3)", "density", 1)}
                                  {num("seed (re-roll sky)", "seed", 42)}
                                </div>
                                {hex("color", "color", "#ffffff")}
                              </>
                            )}
                            {o.op === "filter" && (
                              <>
                                <select value={o.name ?? "vivid"} onChange={e => patchLayer(i, { name: e.target.value })}
                                  className="w-full bg-slate-900 border border-white/10 rounded px-1 py-1 text-[10px] text-slate-200">
                                  {Object.keys(FILTER_CSS).map(f => <option key={f} value={f}>{f}</option>)}
                                </select>
                                {num("strength (0-1)", "strength", 1)}
                              </>
                            )}
                            {!["text", "shape", "overlay", "silhouette", "starfield", "filter"].includes(o.op) && (
                              <div className="text-[10px] text-slate-500">No hand-editable fields — toggle visibility, then Apply.</div>
                            )}
                          </div>
                        )
                      })()}
                      <div className="text-[9px] text-slate-600 leading-relaxed">
                        These are the exact ops the model ran. Coordinates are in the image&apos;s real pixels; hidden layers are dropped when you Save.
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-1">Model</div>
                    <span className={`inline-block text-[11px] px-2 py-0.5 rounded-md border ${accentFor(mediaViewer.modelId).chip}`}>
                      {labelFor(mediaViewer.modelId) || "Unknown"}
                    </span>
                  </div>
                  {mediaViewer.settings && Object.keys(mediaViewer.settings).length > 0 && (
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-1">Settings</div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {Object.entries(mediaViewer.settings).map(([k, v]) => (
                          <span key={k} className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-slate-400">
                            {k}: <span className="text-slate-200">{v}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {typeof mediaViewer.cost === "number" && (
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-1">Cost</div>
                      <span className="flex items-center gap-1 text-[11px] text-cyan-300 tabular-nums">
                        <Ticket size={11} />{mediaViewer.cost} tickets
                      </span>
                    </div>
                  )}
                  {mediaViewer.prompt && (
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 pb-1">Prompt</div>
                      <div className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
                        {mediaViewer.prompt}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer: actions + AI-generated note */}
            {!mediaViewer.isRef && !viewerFull && (
              <div className="shrink-0 border-t border-white/5 px-3 sm:px-4 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {onAddRefUrl && !mediaViewer.isVideo && (
                    <button
                      onClick={async () => {
                        if (addRefState === "saving" || addRefState === "done") return
                        setAddRefState("saving")
                        try {
                          const r = await onAddRefUrl(mediaViewer.url)
                          setAddRefState(r.added > 0 ? "done" : "error")
                        } catch { setAddRefState("error") }
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] border transition-colors ${
                        addRefState === "done"
                          ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                          : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <BookMarked size={12} />
                      {addRefState === "saving" ? "Adding…" : addRefState === "done" ? "Added to refs ✓" : addRefState === "error" ? "Failed — retry" : "Add to refs"}
                    </button>
                  )}
                  <button
                    onClick={armEditFromViewer}
                    disabled={!activeChatId || streaming}
                    title="Close the viewer and edit this in chat"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    <Pencil size={12} />
                    Edit
                  </button>
                  <div className="flex-1" />
                  <span className="text-[9px] text-slate-600">AI-generated content</span>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Provider routing controls (Vercel AI Hub vs own API keys) ───────────────
// Rendered inside the taskbar Profile dropdown → Settings → Chat Settings.
// Self-contained: persists to localStorage and broadcasts changes so a mounted
// ChatHub picks them up immediately.
// ── Desktop-app link: personal API keys (Profile → Chat Settings → API Keys) ──

type ApiKeyRow = {
  id: string
  name: string
  keyPrefix: string
  permissions: ApiKeyPermissions
  disabled: boolean
  lastUsedAt: string | null
  createdAt: string
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString()
}

function clonePermissions(p: ApiKeyPermissions): ApiKeyPermissions {
  return {
    scopes: [...(p.scopes ?? [])],
    models: {
      image: p.models?.image === "*" ? "*" : [...(p.models?.image ?? [])],
      video: p.models?.video === "*" ? "*" : [...(p.models?.video ?? [])],
    },
  }
}

export function ChatApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Create/edit form — editingId === "new" means the create form
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState("")
  const [permDraft, setPermDraft] = useState<ApiKeyPermissions>(() => clonePermissions(DEFAULT_PERMISSIONS))
  // Show-once modal: the plaintext key, returned exactly once at creation
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const catalog = useMemo(() => modelCatalogForKeys(), [])

  useEffect(() => {
    fetch("/api/chat-hub/api-keys", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.keys) setKeys(d.keys) })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const openCreate = () => {
    setEditingId("new")
    setNameDraft("")
    setPermDraft(clonePermissions(DEFAULT_PERMISSIONS))
    setError(null)
  }
  const openEdit = (k: ApiKeyRow) => {
    setEditingId(k.id)
    setNameDraft(k.name)
    setPermDraft(clonePermissions(k.permissions))
    setError(null)
  }

  const toggleScope = (id: string) => {
    setPermDraft(p => ({
      ...p,
      scopes: p.scopes.includes(id) ? p.scopes.filter(s => s !== id) : [...p.scopes, id],
    }))
  }
  const setAllModels = (kind: "image" | "video", all: boolean) => {
    setPermDraft(p => ({
      ...p,
      models: { ...p.models, [kind]: all ? "*" : catalog[kind].map(m => m.id) },
    }))
  }
  const toggleModel = (kind: "image" | "video", id: string) => {
    setPermDraft(p => {
      const cur = p.models[kind]
      const list = cur === "*" ? catalog[kind].map(m => m.id) : [...cur]
      const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id]
      return { ...p, models: { ...p.models, [kind]: next } }
    })
  }
  const modelOn = (kind: "image" | "video", id: string) => {
    const cur = permDraft.models[kind]
    return cur === "*" || cur.includes(id)
  }

  const saveForm = async () => {
    const name = nameDraft.trim()
    if (!name) { setError("Key name required"); return }
    setBusy(true)
    setError(null)
    try {
      if (editingId === "new") {
        const res = await fetch("/api/chat-hub/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, permissions: permDraft }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setError(data.error || "Create failed"); return }
        const { key, ...row } = data
        setKeys(prev => [row, ...prev])
        setCreatedKey({ key, name: row.name })
        setCopied(false)
        setEditingId(null)
      } else if (editingId) {
        const res = await fetch(`/api/chat-hub/api-keys/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, permissions: permDraft }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setError(data.error || "Save failed"); return }
        setKeys(prev => prev.map(k => (k.id === editingId ? data : k)))
        setEditingId(null)
      }
    } catch {
      setError("Request failed")
    } finally {
      setBusy(false)
    }
  }

  const toggleDisabled = async (k: ApiKeyRow) => {
    // Optimistic — revoke should feel instant
    setKeys(prev => prev.map(x => (x.id === k.id ? { ...x, disabled: !k.disabled } : x)))
    const res = await fetch(`/api/chat-hub/api-keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !k.disabled }),
    }).catch(() => null)
    if (!res?.ok) setKeys(prev => prev.map(x => (x.id === k.id ? { ...x, disabled: k.disabled } : x)))
  }

  const deleteKey = async (id: string) => {
    setConfirmDeleteId(null)
    const prev = keys
    setKeys(p => p.filter(k => k.id !== id))
    if (editingId === id) setEditingId(null)
    const res = await fetch(`/api/chat-hub/api-keys/${id}`, { method: "DELETE" }).catch(() => null)
    if (!res?.ok) setKeys(prev)
  }

  const copyKey = async () => {
    if (!createdKey) return
    try {
      await navigator.clipboard.writeText(createdKey.key)
      setCopied(true)
    } catch {
      // Clipboard API can fail on LAN-IP origins — leave the key selectable
    }
  }

  const modelGrid = (kind: "image" | "video", title: string) => {
    const all = permDraft.models[kind] === "*"
    const groups: Record<string, typeof catalog.image> = {}
    for (const m of catalog[kind]) (groups[m.group] ??= []).push(m)
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-300">{title}</span>
          <button
            onClick={() => setAllModels(kind, !all)}
            className={`px-2 py-0.5 rounded-md border text-[10px] transition-colors ${
              all
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
            }`}
          >
            {all ? "All models ✓" : "All models"}
          </button>
        </div>
        {!all && Object.entries(groups).map(([group, models]) => (
          <div key={group}>
            <div className={`text-[10px] mb-1 ${CHAT_CREATE_GROUPS[group]?.accent ?? "text-slate-500"}`}>{group}</div>
            <div className="flex flex-wrap gap-1">
              {models.map(m => (
                <button
                  key={m.id}
                  onClick={() => toggleModel(kind, m.id)}
                  className={`px-1.5 py-0.5 rounded-md border text-[10px] transition-colors ${
                    modelOn(kind, m.id)
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-white/10 bg-white/5 text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const permissionEditor = (
    <div className="space-y-2">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 space-y-1">
        <div className="text-[11px] font-semibold text-slate-300 mb-1">Permissions</div>
        {ALL_SCOPES.map(s => (
          <label key={s.id} className="flex items-start gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={permDraft.scopes.includes(s.id)}
              onChange={() => toggleScope(s.id)}
              className="mt-0.5 accent-cyan-500"
            />
            <span className="text-[11px] text-slate-300 group-hover:text-white">
              {s.label}
              {s.adminOnly && (
                <span className="ml-1.5 px-1 py-px rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[9px] align-middle">Admin</span>
              )}
              <span className="block text-[10px] text-slate-500">{s.description}</span>
            </span>
          </label>
        ))}
      </div>
      {modelGrid("image", "Image models")}
      {modelGrid("video", "Video models")}
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
            <KeyRound size={12} className="text-cyan-400" /> Desktop App Keys
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            Link the desktop app to this account with bearer API keys. Disabling or deleting a key cuts off the app instantly.
          </div>
        </div>
        {editingId === null && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1 px-2 py-1 rounded-md border border-cyan-500/40 bg-cyan-500/15 text-cyan-300 text-[11px] hover:bg-cyan-500/25 transition-colors"
          >
            <Plus size={11} /> New key
          </button>
        )}
      </div>

      {/* Show-once modal (inline panel) */}
      {createdKey && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-3 space-y-2">
          <div className="text-[11px] font-semibold text-emerald-300">
            “{createdKey.name}” created — copy the key now
          </div>
          <div className="font-mono text-[11px] text-slate-100 bg-black/40 border border-white/10 rounded-md px-2 py-1.5 break-all select-all">
            {createdKey.key}
          </div>
          <div className="text-[10px] text-amber-300/90">
            This key will never be shown again. Store it in the desktop app now.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyKey}
              className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] transition-colors ${
                copied
                  ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300"
                  : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
              }`}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy key"}
            </button>
            <button
              onClick={() => setCreatedKey(null)}
              className="px-2 py-1 rounded-md border border-white/10 bg-white/5 text-slate-400 text-[11px] hover:text-white transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Create / edit form */}
      {editingId !== null && (
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <input
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              placeholder="Key name (e.g. Studio PC)"
              maxLength={60}
              className="flex-1 bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
            />
            <button
              onClick={saveForm}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-[11px] hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
            >
              <Check size={11} /> {editingId === "new" ? "Create" : "Save"}
            </button>
            <button
              onClick={() => { setEditingId(null); setError(null) }}
              className="p-1 rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white transition-colors"
            >
              <X size={11} />
            </button>
          </div>
          {error && <div className="text-[10px] text-red-400">{error}</div>}
          {permissionEditor}
        </div>
      )}

      {/* Key list */}
      {!loaded ? (
        <div className="text-[11px] text-slate-500">Loading keys…</div>
      ) : keys.length === 0 && editingId === null ? (
        <div className="text-[11px] text-slate-500">No keys yet. Create one to link the desktop app.</div>
      ) : (
        <div className="space-y-1.5">
          {keys.map(k => (
            <div
              key={k.id}
              className={`rounded-lg border p-2 flex items-center gap-2 flex-wrap ${
                k.disabled ? "border-white/5 bg-white/[0.02] opacity-60" : "border-white/10 bg-white/[0.04]"
              }`}
            >
              <div className="flex-1 min-w-[140px]">
                <div className="text-[11px] text-slate-200 font-medium flex items-center gap-1.5">
                  {k.name}
                  {k.disabled && (
                    <span className="px-1 py-px rounded bg-red-500/15 border border-red-500/30 text-red-300 text-[9px]">Disabled</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {k.keyPrefix}…{" "}
                  <span className="font-sans">
                    · created {new Date(k.createdAt).toLocaleDateString()} · used {relativeTime(k.lastUsedAt)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleDisabled(k)}
                  className={`px-1.5 py-1 rounded-md border text-[10px] transition-colors ${
                    k.disabled
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                  }`}
                >
                  {k.disabled ? "Enable" : "Disable"}
                </button>
                <button
                  onClick={() => openEdit(k)}
                  className="p-1 rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white transition-colors"
                  title="Edit name & permissions"
                >
                  <Pencil size={11} />
                </button>
                {confirmDeleteId === k.id ? (
                  <>
                    <button
                      onClick={() => deleteKey(k.id)}
                      className="px-1.5 py-1 rounded-md border border-red-500/40 bg-red-500/15 text-red-300 text-[10px] hover:bg-red-500/25 transition-colors"
                    >
                      Delete?
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="p-1 rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-white transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(k.id)}
                    className="p-1 rounded-md border border-white/10 bg-white/5 text-slate-400 hover:text-red-300 transition-colors"
                    title="Delete key"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ChatProviderSettings() {
  const [routing, setRouting] = useState<RoutingMap>(DEFAULT_ROUTING)
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)

  useEffect(() => {
    setRouting(readRoutingFromStorage())
    fetch("/api/chat-hub/settings", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setKeyStatus(d) })
      .catch(() => {})
    // Account preferences are the source of truth (localStorage is just a
    // cache Safari may evict on LAN-IP origins)
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const rt = d?.preferences?.chatHubRouting
        if (rt && typeof rt === "object") {
          const next = { ...DEFAULT_ROUTING }
          for (const p of CHAT_HUB_PROVIDERS) {
            if (rt[p] === "gateway" || rt[p] === "direct") next[p] = rt[p]
          }
          setRouting(next)
          try { localStorage.setItem(ROUTING_LS_KEY, JSON.stringify(next)) } catch {}
        }
      })
      .catch(() => {})
  }, [])

  const setProviderRoute = (provider: ChatHubProvider, route: ChatHubRoute) => {
    // Side effects stay OUTSIDE the state updater: dispatching the event from
    // inside it runs the ChatHub listener's setState during THIS component's
    // render phase ("Cannot update a component while rendering another")
    const next = { ...routing, [provider]: route }
    setRouting(next)
    try { localStorage.setItem(ROUTING_LS_KEY, JSON.stringify(next)) } catch {}
    try { window.dispatchEvent(new CustomEvent(ROUTING_EVENT, { detail: next })) } catch {}
    // Persist to the account so it survives Safari storage eviction
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubRouting: next }),
    }).catch(() => {})
  }

  // Inline key editor state — one provider ('gateway' | ChatHubProvider) at a time
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState("")
  const [keySaving, setKeySaving] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)

  const submitKey = async (provider: string, key: string) => {
    setKeySaving(true)
    setKeyError(null)
    try {
      const res = await fetch("/api/chat-hub/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setKeyError(data.error || "Saving failed"); return }
      setKeyStatus(prev => prev ? { ...prev, saved: { ...prev.saved, [provider]: data.saved ?? null } } : prev)
      setEditingKey(null)
      setKeyDraft("")
    } catch {
      setKeyError("Saving failed")
    } finally {
      setKeySaving(false)
    }
  }

  // Key affordance for one provider row. "Connected" = a key exists at all,
  // whether the user linked their own OR the site has one configured (env) —
  // connected rows offer "Change key" instead of "Link key".
  const keyControls = (provider: string) => {
    const savedHint = keyStatus?.saved?.[provider] ?? null
    const envLinked = provider === "gateway"
      ? (keyStatus?.gateway ?? false)
      : (keyStatus?.direct?.[provider as ChatHubProvider] ?? false)
    const connected = !!savedHint || envLinked
    const isEditing = editingKey === provider
    return (
      <>
        <button
          onClick={() => {
            setKeyError(null)
            setKeyDraft("")
            setEditingKey(isEditing ? null : provider)
          }}
          className={`flex items-center gap-1 px-1.5 py-1 rounded-md border text-[10px] transition-colors ${
            connected
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
              : isEditing
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300"
                : "border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10"
          }`}
          title={
            savedHint
              ? `Connected with your key ${savedHint} — tap to change or remove`
              : envLinked
                ? "Connected with the site's built-in key — tap to link your own instead"
                : "Link your own API key"
          }
        >
          <KeyRound size={10} />
          {connected ? (savedHint ? `${savedHint} · Change` : "Connected · Change key") : "Link key"}
        </button>
        {isEditing && (
          <div className="w-full flex flex-col gap-1 pt-1">
            {envLinked && !savedHint && (
              <div className="text-[10px] text-emerald-400/80">
                Already connected via the site&apos;s built-in key — linking your own will override it.
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                value={keyDraft}
                onChange={e => setKeyDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && keyDraft.trim()) submitKey(provider, keyDraft.trim()) }}
                placeholder={connected ? "Paste a new key…" : "Paste your API key…"}
                autoComplete="off"
                className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
              />
              <button
                onClick={() => submitKey(provider, keyDraft.trim())}
                disabled={!keyDraft.trim() || keySaving}
                className="shrink-0 px-2 py-1.5 rounded-md text-[10px] bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 transition-colors"
              >
                {keySaving ? "…" : "Save"}
              </button>
              {savedHint && (
                <button
                  onClick={() => submitKey(provider, "")}
                  disabled={keySaving}
                  className="shrink-0 px-2 py-1.5 rounded-md text-[10px] border border-white/10 text-slate-400 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40 transition-colors"
                  title="Remove your linked key (falls back to the site's key if one exists)"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
      </>
    )
  }

  const gatewayLinked = (keyStatus?.gateway ?? false) || !!keyStatus?.saved?.gateway

  return (
    <div className="flex flex-col gap-2">
      {/* Vercel AI Hub — one key covers every model routed through the Hub */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${gatewayLinked ? "bg-emerald-400" : "bg-red-400"}`}
          title={gatewayLinked ? "AI Hub key linked" : "No AI Hub key yet"}
        />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Vercel AI Hub</span>
        {keyControls("gateway")}
      </div>

      {CHAT_HUB_PROVIDERS.map(p => {
        const hasKey = (keyStatus?.direct?.[p] ?? false) || !!keyStatus?.saved?.[p]
        const route = routing[p]
        return (
          <div key={p} className="flex items-center gap-2 flex-wrap">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                route === "gateway"
                  ? (gatewayLinked ? "bg-emerald-400" : "bg-red-400")
                  : (hasKey ? "bg-emerald-400" : "bg-amber-400")
              }`}
              title={route === "direct" && !hasKey ? "No API key linked for this provider" : undefined}
            />
            <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">{p}</span>
            <div className="flex rounded-md border border-white/10 overflow-hidden">
              <button
                onClick={() => setProviderRoute(p, "gateway")}
                className={`px-2 py-1 text-[10px] transition-colors ${
                  route === "gateway" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"
                }`}
              >
                Hub
              </button>
              <button
                onClick={() => setProviderRoute(p, "direct")}
                className={`px-2 py-1 text-[10px] border-l border-white/10 transition-colors ${
                  route === "direct" ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"
                }`}
              >
                API
              </button>
            </div>
            {keyControls(p)}
          </div>
        )
      })}

      {keyError && <div className="text-[10px] text-red-400">{keyError}</div>}
      <div className="text-[10px] text-slate-600 leading-relaxed pt-0.5">
        Hub = one Vercel AI Gateway key for every model. API = that provider&apos;s own key
        (billed to your account with them). Your linked keys are stored encrypted and
        take priority over the site&apos;s keys; green = ready, amber = key needed.
      </div>

      <OllamaConnector />
      <RunPodConnector />
      <OpenRouterConnector />
      <InstagramConnector />
    </div>
  )
}

// ── Ollama (local models) ────────────────────────────────────────────────────
// The Next.js server talks to Ollama at localhost (OLLAMA_BASE_URL to
// override). "Sync" pulls the installed model list and saves it to account
// preferences — the chat model dropdown then shows an "Ollama (local)" group.
function OllamaConnector() {
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const oll = d?.preferences?.chatHubOllamaModels
        if (Array.isArray(oll)) {
          setModels(oll.filter((m: any) => m && typeof m.id === "string" && typeof m.label === "string"))
        }
      })
      .catch(() => {})
  }, [])

  const sync = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/ollama/models", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || "Ollama unreachable" }); return }
      const next: { id: string; label: string }[] = (data.models ?? []).map((m: any) => ({ id: m.id, label: m.label }))
      setModels(next)
      fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatHubOllamaModels: next }),
      }).catch(() => {})
      try {
        window.dispatchEvent(new CustomEvent("chat-hub-agent-settings-changed", { detail: { ollamaModels: next } }))
      } catch {}
      setMsg({ ok: true, text: next.length ? `Synced ${next.length} local model${next.length === 1 ? "" : "s"}.` : "Ollama is running but has no models — `ollama pull llama3.2` to grab one." })
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${models.length ? "bg-emerald-400" : "bg-slate-600"}`} />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Ollama (local models)</span>
        <button
          onClick={sync}
          disabled={busy}
          className="px-2 py-1 rounded-md text-[10px] border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors"
        >
          {busy ? "Syncing…" : models.length ? "Re-sync models" : "Sync models"}
        </button>
      </div>
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map(m => (
            <span key={m.id} className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] text-slate-400">
              {m.label}
            </span>
          ))}
        </div>
      )}
      {msg && <div className={`text-[10px] ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
      <div className="text-[10px] text-slate-600 leading-relaxed">
        Free, private, runs on this PC — the site&apos;s server talks to Ollama at localhost.
        Synced models appear in the chat model dropdown under &quot;Ollama (local)&quot;.
        Tool-calling (the agent) needs a tool-capable model (llama3.1+, qwen2.5, mistral-small…);
        smaller chat-only models still work for plain conversation.
      </div>
      <div className="text-[10px] leading-relaxed rounded-md border border-amber-500/20 bg-amber-500/[0.06] text-amber-300/90 px-2 py-1.5">
        <span className="font-semibold">Required for agent mode:</span> Ollama&apos;s default context is ~4k tokens —
        the studio&apos;s instructions + tools get silently truncated and the model acts like a bare chatbot
        (no persona, no edits). Set the environment variable <span className="font-mono">OLLAMA_CONTEXT_LENGTH=16384</span> for
        the Ollama app/service and restart it. 24B-class models then run the employees properly (slower than cloud, but free).
      </div>
    </div>
  )
}

// ── OpenRouter (aggregator via API key) ──────────────────────────────────────
// One API key (stored encrypted server-side) unlocks OpenRouter's OpenAI-
// compatible catalog. Models are added by id (from openrouter.ai/models) and
// appear in the chat model dropdown under an "OpenRouter" group.
function OpenRouterConnector() {
  const [status, setStatus] = useState<{ connected: boolean; hint: string | null } | null>(null)
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [editing, setEditing] = useState(false)
  const [keyDraft, setKeyDraft] = useState("")
  const [newModelId, setNewModelId] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch("/api/chat-hub/openrouter", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setStatus({ connected: !!d.connected, hint: d.hint ?? null }) })
      .catch(() => {})
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const or = d?.preferences?.chatHubOpenrouterModels
        if (Array.isArray(or)) setModels(or.filter((m: any) => m && typeof m.id === "string" && typeof m.label === "string"))
      })
      .catch(() => {})
  }, [])

  const saveModels = (next: { id: string; label: string }[]) => {
    setModels(next)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubOpenrouterModels: next }),
    }).catch(() => {})
    try {
      window.dispatchEvent(new CustomEvent("chat-hub-agent-settings-changed", { detail: { openrouterModels: next } }))
    } catch {}
  }

  const saveKey = async () => {
    if (!keyDraft.trim()) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: keyDraft.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || "Saving failed" }); return }
      setStatus({ connected: true, hint: data.hint ?? null })
      setEditing(false); setKeyDraft("")
      setMsg({ ok: true, text: "OpenRouter key linked — add model ids below." })
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetch("/api/chat-hub/openrouter", { method: "DELETE" })
      setStatus({ connected: false, hint: null })
      setEditing(false); setKeyDraft("")
      setMsg({ ok: true, text: "Unlinked — OpenRouter models stop working." })
    } finally { setBusy(false) }
  }

  const addModel = () => {
    setMsg(null)
    // Accept "vendor/model" or a pasted "openrouter/vendor/model" — normalize.
    const raw = newModelId.trim().replace(/^openrouter\//, "")
    if (!raw) return
    if (!/^[\w.-]+\/[\w.:-]+$/.test(raw)) { setMsg({ ok: false, text: "Model id must look like vendor/model-name" }); return }
    const id = `openrouter/${raw}`
    if (models.some(m => m.id === id)) { setMsg({ ok: false, text: "That model is already added" }); return }
    if (models.length >= 30) { setMsg({ ok: false, text: "Limit of 30 OpenRouter models" }); return }
    saveModels([...models, { id, label: raw.split("/").pop()!.slice(0, 40) }])
    setNewModelId("")
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${status?.connected ? "bg-sky-400" : "bg-slate-600"}`} />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">
          OpenRouter
          {status?.connected && status.hint && (
            <span className="ml-1.5 font-mono text-[9px] text-slate-500">{status.hint}</span>
          )}
        </span>
        <button
          onClick={() => { setEditing(e => !e); setMsg(null); setKeyDraft("") }}
          className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
            editing ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300" : "border-white/10 text-slate-300 hover:text-white hover:bg-white/10"
          }`}
        >
          {status?.connected ? "Change key" : "Connect"}
        </button>
      </div>
      {editing && (
        <div className="flex flex-col gap-1.5 pt-1">
          <input
            type="password"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") saveKey() }}
            placeholder="OpenRouter API key (sk-or-…)"
            className="bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] font-mono text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={saveKey}
              disabled={busy || !keyDraft.trim()}
              className="px-2 py-1 rounded-md text-[10px] border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 transition-colors"
            >
              Save key
            </button>
            {status?.connected && (
              <button
                onClick={unlink}
                disabled={busy}
                className="px-2 py-1 rounded-md text-[10px] border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
              >
                Unlink
              </button>
            )}
          </div>
        </div>
      )}
      {status?.connected && (
        <div className="flex items-center gap-1.5">
          <input
            value={newModelId}
            onChange={e => setNewModelId(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addModel() }}
            placeholder="Add model id — e.g. anthropic/claude-3.5-sonnet"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] font-mono text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <button
            onClick={addModel}
            className="shrink-0 px-2 py-1.5 rounded-md text-[10px] border border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 transition-colors"
          >
            Add
          </button>
        </div>
      )}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map(m => (
            <span key={m.id} className="group flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] text-slate-400">
              {m.id.slice("openrouter/".length)}
              <button onClick={() => saveModels(models.filter(x => x.id !== m.id))} className="text-slate-600 hover:text-red-400" title="Remove">
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      {msg && <div className={`text-[10px] ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
      <div className="text-[10px] text-slate-600 leading-relaxed">
        Paste your key from <span className="font-mono">openrouter.ai/keys</span>, then add model ids from
        {" "}<span className="font-mono">openrouter.ai/models</span> (e.g. <span className="font-mono">anthropic/claude-3.5-sonnet</span>,
        {" "}<span className="font-mono">meta-llama/llama-3.3-70b-instruct</span>). Added models appear in the chat
        model dropdown under &quot;OpenRouter&quot; with an <span className="text-sky-300">OR</span> badge. You pay OpenRouter directly.
      </div>
    </div>
  )
}

// ── RunPod (rented-GPU models) ───────────────────────────────────────────────
// Connect any OpenAI-compatible endpoint (vLLM on a RunPod pod or serverless
// endpoint). URL + optional key are stored encrypted server-side; "Sync"
// pulls the served model list into the chat model dropdown ("RunPod" group).
function RunPodConnector() {
  const [status, setStatus] = useState<{ connected: boolean; baseUrl: string | null; keySet: boolean } | null>(null)
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [editing, setEditing] = useState(false)
  const [urlDraft, setUrlDraft] = useState("")
  const [keyDraft, setKeyDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Pod power state (start/stop the GPU to avoid idle billing)
  const [pod, setPod] = useState<{ controllable: boolean; status: string; costPerHr?: number | null } | null>(null)
  const [podBusy, setPodBusy] = useState(false)
  const podPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshPod = useCallback(async () => {
    try {
      const r = await fetch("/api/chat-hub/runpod/pod", { cache: "no-store" })
      const d = await r.json().catch(() => null)
      if (d) setPod({ controllable: !!d.controllable, status: String(d.status ?? "unknown"), costPerHr: d.costPerHr })
      return d?.status as string | undefined
    } catch { return undefined }
  }, [])

  useEffect(() => {
    fetch("/api/chat-hub/runpod", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d) {
          setStatus({ connected: !!d.connected, baseUrl: d.baseUrl ?? null, keySet: !!d.keySet })
          if (d.connected) refreshPod()
        }
      })
      .catch(() => {})
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const rp = d?.preferences?.chatHubRunpodModels
        if (Array.isArray(rp)) {
          setModels(rp.filter((m: any) => m && typeof m.id === "string" && typeof m.label === "string"))
        }
      })
      .catch(() => {})
    return () => { if (podPollRef.current) clearInterval(podPollRef.current) }
  }, [refreshPod])

  // Poll a few times after a start/stop so the badge settles on the new state
  const pollPodUntilSettled = () => {
    if (podPollRef.current) clearInterval(podPollRef.current)
    let n = 0
    podPollRef.current = setInterval(async () => {
      n++
      await refreshPod()
      if (n >= 12 && podPollRef.current) { clearInterval(podPollRef.current); podPollRef.current = null }
    }, 5000)
  }

  const setPodPower = async (action: "start" | "stop") => {
    setPodBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/runpod/pod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || `Could not ${action} the pod` }); return }
      setMsg({ ok: true, text: action === "start" ? "Starting pod — model reloads in ~2-3 min." : "Pod stopping — GPU billing stops." })
      await refreshPod()
      pollPodUntilSettled()
    } finally { setPodBusy(false) }
  }

  const saveModels = (next: { id: string; label: string }[]) => {
    setModels(next)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatHubRunpodModels: next }),
    }).catch(() => {})
    try {
      window.dispatchEvent(new CustomEvent("chat-hub-agent-settings-changed", { detail: { runpodModels: next } }))
    } catch {}
  }

  const save = async () => {
    if (!urlDraft.trim()) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/runpod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: urlDraft.trim(), apiKey: keyDraft.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || "Saving failed" }); return }
      setStatus({ connected: true, baseUrl: data.baseUrl, keySet: !!data.keySet })
      setEditing(false); setUrlDraft(""); setKeyDraft("")
      setMsg({ ok: true, text: `Linked ${data.baseUrl} — now sync the models.` })
    } finally { setBusy(false) }
  }

  const sync = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/runpod/models", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || "Endpoint unreachable" }); return }
      const next: { id: string; label: string }[] = (data.models ?? []).map((m: any) => ({ id: m.id, label: m.label }))
      saveModels(next)
      setMsg({
        ok: true,
        text: next.length
          ? `Synced ${next.length} pod model${next.length === 1 ? "" : "s"} — pick ${next.length === 1 ? "it" : "one"} in the chat model dropdown.`
          : "Endpoint reachable but serving no models yet.",
      })
    } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetch("/api/chat-hub/runpod", { method: "DELETE" })
      setStatus({ connected: false, baseUrl: null, keySet: false })
      saveModels([])
      setMsg({ ok: true, text: "Unlinked — pod models removed from the dropdown." })
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${status?.connected ? "bg-violet-400" : "bg-slate-600"}`} />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">
          RunPod (rented GPU)
          {status?.connected && status.baseUrl && (
            <span className="ml-1.5 font-mono text-[9px] text-slate-500">{status.baseUrl.replace(/^https?:\/\//, "").slice(0, 34)}…</span>
          )}
        </span>
        {status?.connected && (
          <button
            onClick={sync}
            disabled={busy}
            className="px-2 py-1 rounded-md text-[10px] border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors"
          >
            {busy ? "Working…" : models.length ? "Re-sync models" : "Sync models"}
          </button>
        )}
        <button
          onClick={() => { setEditing(e => !e); setMsg(null); setUrlDraft(status?.baseUrl ?? "") }}
          className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
            editing ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-300" : "border-white/10 text-slate-300 hover:text-white hover:bg-white/10"
          }`}
        >
          {status?.connected ? "Change" : "Connect"}
        </button>
      </div>
      {editing && (
        <div className="flex flex-col gap-1.5 pt-1">
          <input
            value={urlDraft}
            onChange={e => setUrlDraft(e.target.value)}
            placeholder="Endpoint URL — e.g. https://abc123-8000.proxy.runpod.net"
            className="bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] font-mono text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <input
            type="password"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            placeholder={status?.keySet ? "API key (leave blank only if endpoint is open)" : "API key (optional — set if your server requires one)"}
            className="bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] font-mono text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={save}
              disabled={busy || !urlDraft.trim()}
              className="px-2 py-1 rounded-md text-[10px] border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 transition-colors"
            >
              Save & link
            </button>
            {status?.connected && (
              <button
                onClick={unlink}
                disabled={busy}
                className="px-2 py-1 rounded-md text-[10px] border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
              >
                Unlink
              </button>
            )}
          </div>
        </div>
      )}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map(m => (
            <span key={m.id} className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] text-slate-400">
              {m.label}
            </span>
          ))}
        </div>
      )}
      {/* Pod power: start/stop the GPU so it isn't billed while idle */}
      {status?.connected && pod?.controllable && (() => {
        const st = pod.status.toUpperCase()
        const running = st === "RUNNING"
        const stopped = st === "EXITED" || st === "STOPPED"
        const label = running ? "Running" : stopped ? "Stopped" : st === "UNKNOWN" ? "—" : pod.status
        const dot = running ? "bg-emerald-400" : stopped ? "bg-slate-500" : "bg-amber-400 animate-pulse"
        return (
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
            <span className="flex-1 min-w-0 text-[10px] text-slate-300">
              GPU pod: <span className={running ? "text-emerald-300" : "text-slate-400"}>{label}</span>
              {running && typeof pod.costPerHr === "number" && (
                <span className="text-slate-500"> · ${pod.costPerHr}/hr</span>
              )}
            </span>
            <button
              onClick={() => refreshPod()}
              disabled={podBusy}
              className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors"
              title="Refresh status"
            >
              <RotateCw size={10} />
            </button>
            <button
              onClick={() => setPodPower(running ? "stop" : "start")}
              disabled={podBusy}
              className={`px-2 py-1 rounded-md text-[10px] border transition-colors disabled:opacity-40 ${
                running
                  ? "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
                  : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              }`}
            >
              {podBusy ? "…" : running ? "Stop pod" : "Start pod"}
            </button>
          </div>
        )
      })()}
      {msg && <div className={`text-[10px] ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
      <div className="text-[10px] text-slate-600 leading-relaxed">
        Rent an H100/H200-class GPU on runpod.io, serve a model with vLLM (OpenAI-compatible),
        and paste the endpoint here — pod proxy URLs (<span className="font-mono">https://&lt;podId&gt;-8000.proxy.runpod.net</span>)
        and serverless endpoints (<span className="font-mono">https://api.runpod.ai/v2/&lt;id&gt;/openai</span>) both work.
        Synced models appear in the chat dropdown under &quot;RunPod&quot; with a <span className="text-violet-300">pod</span> badge.
        Use <span className="text-emerald-300">Start</span>/<span className="text-red-300">Stop pod</span> above to power the GPU on only when you need it — stopped pods keep the model on disk (no re-download) and cost only pennies for storage. After Start, give vLLM ~2-3 min to reload before chatting. If Start fails with &quot;not enough free GPUs,&quot; that host is temporarily full — retry shortly.
      </div>
    </div>
  )
}

// ── Instagram connector (first external connector) ──────────────────────────
// Long-lived token + IG user id, stored encrypted server-side. The agent's
// publish_instagram tool uses these; publishing always pauses for approval.
function InstagramConnector() {
  const [status, setStatus] = useState<{ connected: boolean; username?: string | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState("")
  const [igId, setIgId] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    fetch("/api/chat-hub/instagram", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setStatus({ connected: !!d.connected, username: d.username ?? null }) })
      .catch(() => {})
  }, [])

  const save = async () => {
    if (!token.trim() || !igId.trim()) return
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/instagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token.trim(), igUserId: igId.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: data.error || "Saving failed" }); return }
      setToken(""); setIgId(""); setEditing(false)
      setMsg({ ok: true, text: "Saved — test the connection to verify." })
      setStatus({ connected: true, username: null })
    } finally { setBusy(false) }
  }
  const test = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch("/api/chat-hub/instagram/test", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        setMsg({ ok: true, text: `Connected as @${data.username}` })
        setStatus({ connected: true, username: data.username })
      } else {
        setMsg({ ok: false, text: data.error || "Connection test failed" })
      }
    } finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetch("/api/chat-hub/instagram", { method: "DELETE" })
      setStatus({ connected: false }); setMsg(null)
    } finally { setBusy(false) }
  }

  return (
    <div className="border-t border-white/5 pt-2 flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Connectors</span>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status?.connected ? "bg-emerald-400" : "bg-slate-600"}`} />
        <Instagram size={12} className="text-slate-400 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">
          Instagram{status?.connected && status.username ? <span className="text-emerald-400/80"> · @{status.username}</span> : ""}
        </span>
        {status?.connected ? (
          <>
            <button onClick={test} disabled={busy} className="px-1.5 py-1 rounded-md border border-white/10 bg-white/5 text-[10px] text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors">
              Test
            </button>
            <button onClick={() => setEditing(e => !e)} className="px-1.5 py-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300 hover:bg-emerald-500/20 transition-colors">
              Change
            </button>
            <button onClick={disconnect} disabled={busy} className="px-1.5 py-1 rounded-md border border-white/10 text-[10px] text-slate-500 hover:text-red-400 hover:border-red-500/30 disabled:opacity-40 transition-colors">
              Disconnect
            </button>
          </>
        ) : (
          <button onClick={() => setEditing(e => !e)} className="px-1.5 py-1 rounded-md border border-white/10 bg-white/5 text-[10px] text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
            Connect
          </button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-1.5">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Long-lived access token…"
            autoComplete="off"
            className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <div className="flex items-center gap-1.5">
            <input
              value={igId}
              onChange={e => setIgId(e.target.value)}
              placeholder="Instagram user ID (numeric)"
              className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
            />
            <button
              onClick={save}
              disabled={!token.trim() || !igId.trim() || busy}
              className="shrink-0 px-2 py-1.5 rounded-md text-[10px] bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 transition-colors"
            >
              {busy ? "…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {msg && <div className={`text-[10px] ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
      <button onClick={() => setHelpOpen(o => !o)} className="self-start text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
        {helpOpen ? "▾" : "▸"} How to get a token
      </button>
      {helpOpen && (
        <ol className="list-decimal list-inside space-y-0.5 text-[9px] leading-relaxed text-slate-500">
          <li>Your Instagram must be a professional account (Business or Creator — free switch in the IG app).</li>
          <li>At developers.facebook.com create an app (type Business), then add the product &quot;Instagram&quot; → &quot;API setup with Instagram Login&quot;.</li>
          <li>Add your own IG account as an Instagram Tester and accept the invite in the IG app.</li>
          <li>In the app dashboard&apos;s token generator, generate a long-lived access token (60 days) for your account.</li>
          <li>Copy the token and the Instagram user ID shown next to it into the fields above, then Test.</li>
        </ol>
      )}
      <div className="text-[9px] text-slate-700 leading-relaxed">
        The agent gets a publish_instagram tool — every publish shows the exact media + caption and waits for your approval. Tokens last ~60 days; reconnect when the test fails.
      </div>
    </div>
  )
}

// ── Chat layout controls (width + text size) ────────────────────────────────
// Rendered inside the taskbar Profile dropdown → Settings → Chat Settings.
// Persists to localStorage and broadcasts so a mounted ChatHub updates live.
export function ChatLayoutSettings() {
  const [layout, setLayoutState] = useState<ChatLayout>(DEFAULT_LAYOUT)

  useEffect(() => { setLayoutState(readLayoutFromStorage()) }, [])

  const update = (patch: Partial<ChatLayout>) => {
    // Same rule as setProviderRoute: never dispatch from inside the updater
    const next = { ...layout, ...patch }
    setLayoutState(next)
    try { localStorage.setItem(LAYOUT_LS_KEY, JSON.stringify(next)) } catch {}
    try { window.dispatchEvent(new CustomEvent(LAYOUT_EVENT, { detail: next })) } catch {}
  }

  const seg = (active: boolean) =>
    `px-2.5 py-1 text-[10px] transition-colors ${
      active ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"
    }`

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Chat width</span>
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button onClick={() => update({ width: "narrow" })} className={seg(layout.width === "narrow")}>Narrow</button>
          <button onClick={() => update({ width: "wide" })} className={`border-l border-white/10 ${seg(layout.width === "wide")}`}>Wide</button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Text size</span>
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button onClick={() => update({ textSize: "sm" })} className={seg(layout.textSize === "sm")}>Small</button>
          <button onClick={() => update({ textSize: "md" })} className={`border-l border-white/10 ${seg(layout.textSize === "md")}`}>Medium</button>
          <button onClick={() => update({ textSize: "lg" })} className={`border-l border-white/10 ${seg(layout.textSize === "lg")}`}>Large</button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Chat style</span>
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button onClick={() => update({ style: "cards" })} className={seg(layout.style === "cards")}>Cards</button>
          <button onClick={() => update({ style: "floating" })} className={`border-l border-white/10 ${seg(layout.style === "floating")}`}>Floating</button>
        </div>
      </div>
      <div className="text-[10px] text-slate-600 leading-relaxed pt-0.5">
        Wide fills the whole page; Narrow keeps the conversation centered.
        Cards puts replies and agent steps in bounded boxes; Floating lets them
        sit directly on the background with slim expandable rows (Higgsfield-style).
        Changes apply instantly to an open chat.
      </div>
    </div>
  )
}

// ── Agent settings (roster + custom models) ─────────────────────────────────
// Rendered inside the taskbar Profile dropdown → Settings → Chat Settings.
// Persists to account preferences; broadcasts so a mounted ChatHub updates.
export function ChatAgentSettings() {
  const [roster, setRoster] = useState<string[] | null>(null) // null = auto (all usable models)
  const [customs, setCustoms] = useState<CustomChatModel[]>([])
  const [newId, setNewId] = useState("")
  const [newLabel, setNewLabel] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [queueMode, setQueueModeState] = useState(false)
  // Preferred media models the orchestrator defaults to in its plans
  const [modelPrefs, setModelPrefs] = useState<{ video: string; image: string; notes: string }>({ video: "", image: "", notes: "" })

  useEffect(() => {
    try { setQueueModeState(localStorage.getItem("chat-hub-queue-mode") === "on") } catch {}
  }, [])

  const setQueueMode = (on: boolean) => {
    // Side effects outside the state updater (same rule as the other settings)
    setQueueModeState(on)
    try { localStorage.setItem("chat-hub-queue-mode", on ? "on" : "off") } catch {}
    try {
      window.dispatchEvent(new CustomEvent("chat-hub-agent-settings-changed", { detail: { queueMode: on } }))
    } catch {}
  }

  useEffect(() => {
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const r = d?.preferences?.chatHubAgentRoster
        setRoster(Array.isArray(r) && r.length > 0 ? r.filter((x: any) => typeof x === "string") : null)
        const c = d?.preferences?.chatHubCustomModels
        if (Array.isArray(c)) {
          setCustoms(c.filter((m: any) => m && typeof m.id === "string" && typeof m.label === "string" && CUSTOM_MODEL_ID_RE.test(m.id)))
        }
        const mp = d?.preferences?.chatHubModelPrefs
        if (mp && typeof mp === "object") {
          setModelPrefs({
            video: typeof mp.video === "string" ? mp.video : "",
            image: typeof mp.image === "string" ? mp.image : "",
            notes: typeof mp.notes === "string" ? mp.notes : "",
          })
        }
      })
      .catch(() => {})
  }, [])

  const saveModelPrefs = (next: { video: string; image: string; notes: string }) => {
    setModelPrefs(next)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatHubModelPrefs: {
          ...(next.video ? { video: next.video } : {}),
          ...(next.image ? { image: next.image } : {}),
          ...(next.notes.trim() ? { notes: next.notes.trim().slice(0, 600) } : {}),
        },
      }),
    }).catch(() => {})
  }

  const persist = (patch: Record<string, unknown>, nextCustoms?: CustomChatModel[]) => {
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {})
    try {
      window.dispatchEvent(new CustomEvent("chat-hub-agent-settings-changed", {
        detail: { customModels: nextCustoms ?? customs },
      }))
    } catch {}
  }

  const allIds = [...CHAT_HUB_MODELS.map(m => m.id), ...customs.map(m => m.id)]

  const toggleRosterId = (id: string) => {
    // From auto: start a manual list with everything EXCEPT the toggled-off id
    const base = roster ?? allIds
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id]
    setRoster(next)
    persist({ chatHubAgentRoster: next })
  }

  const setAuto = () => {
    setRoster(null)
    persist({ chatHubAgentRoster: null })
  }

  const addCustom = () => {
    setErr(null)
    const id = newId.trim()
    if (!CUSTOM_MODEL_ID_RE.test(id)) { setErr("Model id must look like provider/model-name"); return }
    if (customs.some(m => m.id === id) || CHAT_HUB_MODELS.some(m => m.id === id)) { setErr("That model is already in the list"); return }
    if (customs.length >= MAX_CUSTOM_MODELS) { setErr(`Limit of ${MAX_CUSTOM_MODELS} custom models reached`); return }
    const label = newLabel.trim() || id.split("/").pop()!
    const next = [...customs, { id, label: label.slice(0, 40) }]
    setCustoms(next)
    setNewId(""); setNewLabel("")
    persist({ chatHubCustomModels: next }, next)
  }

  const removeCustom = (id: string) => {
    const next = customs.filter(m => m.id !== id)
    setCustoms(next)
    if (roster?.includes(id)) {
      const nextRoster = roster.filter(x => x !== id)
      setRoster(nextRoster.length ? nextRoster : null)
      persist({ chatHubCustomModels: next, chatHubAgentRoster: nextRoster.length ? nextRoster : null }, next)
    } else {
      persist({ chatHubCustomModels: next }, next)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Message queueing during approvals */}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-slate-300">Queue messages during approvals</span>
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button
            onClick={() => setQueueMode(false)}
            className={`px-2 py-1 text-[10px] transition-colors ${!queueMode ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"}`}
          >
            Off
          </button>
          <button
            onClick={() => setQueueMode(true)}
            className={`px-2 py-1 text-[10px] border-l border-white/10 transition-colors ${queueMode ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"}`}
          >
            On
          </button>
        </div>
      </div>
      <div className="text-[10px] text-slate-600 leading-relaxed -mt-1">
        On: messages typed while a tool approval is pending (or a reply is streaming)
        wait in a queue and send in order. Off: sending during a pending approval
        cancels it (the model can re-ask).
      </div>

      {/* Preferred media models — the orchestrator defaults to these in plans */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 py-1.5">Preferred models</div>
        <div className="flex items-center gap-2 pb-1.5">
          <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Video</span>
          <select
            value={modelPrefs.video}
            onChange={e => saveModelPrefs({ ...modelPrefs, video: e.target.value })}
            className="bg-slate-900 border border-white/10 rounded-md px-1.5 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500/40 max-w-[55%]"
          >
            <option value="">No preference</option>
            {usableCreateModels(true).filter(m => m.kind === "video" && !m.disabled).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 pb-1.5">
          <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300">Image</span>
          <select
            value={modelPrefs.image}
            onChange={e => saveModelPrefs({ ...modelPrefs, image: e.target.value })}
            className="bg-slate-900 border border-white/10 rounded-md px-1.5 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500/40 max-w-[55%]"
          >
            <option value="">No preference</option>
            {usableCreateModels(true).filter(m => m.kind === "image" && !m.disabled).map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <input
          value={modelPrefs.notes}
          onChange={e => setModelPrefs(prev => ({ ...prev, notes: e.target.value }))}
          onBlur={() => saveModelPrefs(modelPrefs)}
          maxLength={600}
          placeholder='Nuances, e.g. "NanoBanana 2 for skin texture, GPT Images for text"'
          className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
        />
        <div className="text-[10px] text-slate-600 leading-relaxed pt-1">
          The orchestrator defaults to these in its plans (and says why when it
          deviates). You can still override models when approving a plan.
        </div>
      </div>

      {/* Agent roster */}
      <div className="flex items-center gap-2 pt-1 border-t border-white/5">
        <span className="flex-1 text-[11px] text-slate-300">Agent roster</span>
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          <button
            onClick={setAuto}
            className={`px-2 py-1 text-[10px] transition-colors ${roster === null ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"}`}
          >
            Auto
          </button>
          <button
            onClick={() => { if (roster === null) { setRoster(allIds); persist({ chatHubAgentRoster: allIds }) } }}
            className={`px-2 py-1 text-[10px] border-l border-white/10 transition-colors ${roster !== null ? "bg-cyan-500/15 text-cyan-300" : "text-slate-500 hover:text-white hover:bg-white/5"}`}
          >
            Manual
          </button>
        </div>
      </div>
      {roster === null ? (
        <div className="text-[10px] text-slate-600 leading-relaxed">
          Auto: the orchestrating model can delegate to every model that currently has a working key.
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-44 overflow-y-auto overscroll-contain pr-1">
          {[...CHAT_HUB_MODELS.map(m => ({ id: m.id, label: m.label })), ...customs].map(m => (
            <label key={m.id} className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={roster.includes(m.id)}
                onChange={() => toggleRosterId(m.id)}
                className="accent-cyan-500"
              />
              <span className="truncate">{m.label}</span>
            </label>
          ))}
        </div>
      )}

      {/* Custom models */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 py-1.5">Custom models</div>
        {customs.length === 0 && (
          <div className="text-[10px] text-slate-600 leading-relaxed pb-1">
            Add any model id from the Vercel AI Hub catalog — it appears in your
            model dropdown and the agent roster. Needs a Hub key.
          </div>
        )}
        {customs.map(m => (
          <div key={m.id} className="flex items-center gap-1.5 py-0.5">
            <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300" title={m.id}>
              {m.label} <span className="text-slate-600">· {m.id}</span>
            </span>
            <button
              onClick={() => removeCustom(m.id)}
              className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-red-500/10"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1.5 pt-1">
          <input
            value={newId}
            onChange={e => setNewId(e.target.value)}
            placeholder="provider/model-id"
            className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="Label"
            maxLength={40}
            className="w-20 bg-black/30 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white placeholder:text-slate-600 outline-none focus:border-cyan-500/40"
          />
          <button
            onClick={addCustom}
            disabled={!newId.trim()}
            className="shrink-0 px-2 py-1.5 rounded-md text-[10px] bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
        {err && <div className="text-[10px] text-red-400 pt-1">{err}</div>}
      </div>
    </div>
  )
}

// ── Agent tools & capabilities (read-only catalog) ──────────────────────────
// Rendered inside the taskbar Profile dropdown → Settings → Chat Settings.
// Data lives in AGENT_CAPABILITIES (lib/chat-hub-models) — the single source
// of truth, updated whenever the orchestrator gains or loses a tool.
export function ChatAgentCapabilities() {
  const badge = (approval: string) =>
    approval === "always-ask"
      ? { cls: "bg-amber-500/10 border-amber-500/30 text-amber-300", label: "Always asks" }
      : approval === "ask-mode"
        ? { cls: "bg-violet-500/10 border-violet-500/30 text-violet-300", label: "Asks in Ask mode" }
        : { cls: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300", label: "Automatic" }

  // Connector status strip — existing integrations + Instagram (live status)
  const [igConnected, setIgConnected] = useState<boolean | null>(null)
  useEffect(() => {
    fetch("/api/chat-hub/instagram", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setIgConnected(!!d?.connected))
      .catch(() => setIgConnected(null))
  }, [])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 flex-wrap pb-1">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-600">Connectors:</span>
        {["Web search", "Reference library", "Memory"].map(n => (
          <span key={n} className="px-1.5 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-[9px] text-slate-400">{n}</span>
        ))}
        <span className={`px-1.5 py-0.5 rounded-full border text-[9px] ${
          igConnected ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.04] text-slate-500"
        }`}>
          Instagram {igConnected === null ? "" : igConnected ? "· connected" : "· not connected"}
        </span>
      </div>
      {AGENT_CAPABILITIES.map(c => {
        const b = badge(c.approval)
        return (
          <div key={c.id} className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[11px] text-slate-200 font-medium">{c.name}</span>
              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[9px] ${b.cls}`}>{b.label}</span>
            </div>
            <div className="text-[10px] text-slate-500 leading-relaxed pt-0.5">{c.description}</div>
            {c.cost && <div className="text-[9px] text-cyan-400/80 pt-0.5">{c.cost}</div>}
          </div>
        )
      })}
      <div className="text-[10px] text-slate-600 leading-relaxed pt-0.5">
        What the orchestrating model can do on its own. &ldquo;Always asks&rdquo; pauses
        for your approval in every mode; &ldquo;Asks in Ask mode&rdquo; runs freely in
        Auto; &ldquo;Automatic&rdquo; never needs approval. Plan mode disables all tools.
        Which capabilities actually load for a chat follows that chat&apos;s enabled
        Skills (chat header → Instructions → Skills).
      </div>
    </div>
  )
}
