"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Clapperboard, Loader2, Plus, X, Check, HelpCircle, Scissors, RefreshCw, ChevronLeft, ChevronRight, ListChecks, AlertTriangle, Wand2, RotateCw } from "lucide-react"
import { SilverRimOverlay } from "@/components/home/SilverRimOverlay"
import { Dropdown } from "@/components/employees/Dropdown"
import { matchPlan, extraOf, type Gen, type PlanRow } from "@/components/employees/plan-progress"
import { SiteLogoBox } from "@/components/SitePageHeader"
import { MOVIE_FORMATS, movieFormatById, AUDIO_PLANS, DEFAULT_AUDIO_PLAN } from "@/lib/chat-hub-skills"


/**
 * Movie Studio, as a production tool rather than a chat.
 *
 * The employee behind this is the same one the hub runs (emp-movie-studio, Ask
 * mode) — only the surface changes. References and a logline go in on the left,
 * the two feeds fill the rest, and the conversation is reduced to a status rail:
 * what it is doing, the questions it needs answered, and the plan to approve.
 * No transcript, no bubbles.
 */

type Question = { question: string; options?: string[] }

/**
 * A reference is a VIDEO if its file says so.
 *
 * The reference library has no kind column and cannot get one without a
 * migration, so the extension is the marker — the same test the rest of the
 * codebase already uses to tell a clip from a still.
 */
function isVideoRef(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)
}

/**
 * What a paused tool call is asking for, in the user's language.
 *
 * "Send 5 shots to the render queue" is a description of the MACHINERY, and it
 * told the user nothing about what they were agreeing to. So each request gets
 * a headline, the actual items underneath it, and a plain statement of what
 * pressing the button does.
 */
function approvalSummary(call: { toolName?: string; input?: Record<string, unknown> }): {
  headline: string
  items: string[]
  effect: string
} {
  const t = String(call.toolName ?? "")
  const i = (call.input ?? {}) as Record<string, any>
  const line = (v: unknown, n = 150) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n)
  const list = (arr: unknown, pick: (x: any) => string) =>
    Array.isArray(arr) ? arr.slice(0, 8).map(pick).filter(Boolean) : []

  switch (t) {
    case "create_media":
      return {
        headline: "Generate one image",
        items: [line(i.prompt, 220)].filter(Boolean),
        effect: `Renders it on ${line(i.model) || "the chosen model"} and spends tickets.`,
      }
    case "edit_image":
      return {
        headline: "Edit an existing image",
        items: [line(i.instruction, 220)].filter(Boolean),
        effect: "Re-renders that image with the change and spends tickets.",
      }
    case "render_plates": {
      const items = list(i.plates, (p: any) => line(p?.prompt ?? p?.description, 130))
      return {
        headline: `Render ${items.length || 1} master still${items.length === 1 ? "" : "s"}`,
        items,
        effect: "Stills only — no video yet. These become the start frames for the shots.",
      }
    }
    case "render_shots": {
      const items = list(i.shots, (sh: any) =>
        `${sh?.n ? `Shot ${sh.n} — ` : ""}${line(sh?.prompt, 120)}${sh?.model ? `  (${sh.model})` : ""}`)
      return {
        headline: `Shoot ${items.length || 1} clip${items.length === 1 ? "" : "s"}`,
        items,
        effect: "Sends them to the render queue and spends tickets. They keep rendering if you leave.",
      }
    }
    case "create_audio":
      return {
        headline: i.kind === "voice" ? "Record narration" : i.kind === "sfx" ? "Make sound effects" : "Score the film",
        items: [line(i.prompt ?? i.text, 220)].filter(Boolean),
        effect: "Generates the audio so it can be mixed under the cut.",
      }
    case "assemble_film":
      return {
        headline: "Cut the film together",
        items: [],
        effect: "Free — this is ffmpeg, not a model. It stitches the finished shots into one video.",
      }
    case "check_shots":
      return { headline: "Look at the takes", items: [], effect: "Free — it reads the finished shots and their frames." }
    case "extract_frames":
      return { headline: "Pull frames from a shot", items: [], effect: "Free — frames are used to chain the next shot." }
    case "delegate_task":
      return {
        headline: "Hand work to another employee",
        items: [line(i.task, 220)].filter(Boolean),
        effect: "That employee runs its own steps, which may spend tickets.",
      }
    default:
      return { headline: t.replace(/_/g, " ") || "Run a step", items: [], effect: "" }
  }
}

/** One tab: a film that persists in the database. */
type Film = {
  id: number
  title: string
  filmUrl: string | null
  shotsSubmitted: number
  shotsLanded: number
  awaitingUser: boolean
}

/** A shot in the assembled cut, with where it sits on the timeline. */
type Shot = {
  queueId: number
  index: number
  url: string
  model: string
  /** What was asked for. The inspector is useless without it. */
  prompt?: string
  seconds: number
  startSec: number
}

/** One line of "what the studio just did", for the stage panel. */
type Activity = { id: string; text: string }

type RailState = {
  chatId: number | null
  /** Has this film actually been given a brief yet? */
  hasRun: boolean
  /** The assembled cut, once assemble_film has returned one. */
  filmUrl: string | null
  /** The reply holding the pending approval \u2014 the approve route needs it. */
  pausedMessageId: number | null
  busy: boolean
  status: string
  /** ask_user, awaiting answers */
  questions: { toolCallId: string; questions: Question[] } | null
  /** propose_plan, awaiting approval */
  plan: { toolCallId: string; summary: string; steps: string[]; tickets: number } | null
  /** The film as stills, waiting for sign-off before any video is paid for. */
  storyboard: {
    toolCallId: string
    note: string
    frames: {
      n: number
      plateUrl?: string
      /** render_plates returns ids, not urls \u2014 the picture is resolved here. */
      plateQueueId?: number
      description: string
      model?: string
      seconds?: number
      feeling?: string
    }[]
  } | null
  /**
   * Everything else the run is waiting to be allowed to do.
   *
   * The agent pauses on ANY tool that spends money — create_media, create_audio,
   * assemble_film — not only questions and plans. This panel rendered cards for
   * the latter two alone, so a pause on any other tool showed "Waiting for you"
   * with no way to answer, and the run sat there forever.
   */
  /**
   * How many shots had landed when the CURRENT cut was made.
   *
   * Footage that lands after the cut is footage the cut does not contain —
   * which is how a 30s film ended up delivered while the shots that would have
   * taken it to 60s sat finished and unused. Comparing this against the live
   * shot count is what makes that visible instead of silent.
   */
  cutShots: number | null
  approvals: {
    toolCallId: string
    toolName: string
    headline: string
    items: string[]
    effect: string
  }[]
  error: string | null
}

const MAX_REFS = 16
/**
 * Clips the user supplies themselves.
 *
 * Capped well below the images because these are CUT INTO the film rather than
 * shown to a model — assemble_film takes 16 clips and 120s in total, and the
 * user's own footage has to leave room for the shots the studio renders.
 */
const MAX_VIDEO_REFS = 4
/**
 * The ceiling one assemble can produce.
 *
 * ffmpeg runs inside a 300s function with a 512MB /tmp, so the stitch is
 * capped at 16 clips and about two minutes. That is a hard fact about the
 * pipeline, not a preference, and the extend control has to respect it or it
 * offers the user a film that cannot be built.
 */
const MAX_FILM_SECONDS = 120

export function MovieStudioWorkspace({
  signedIn,
  renderFeed,
  activeRefs,
  onRemoveRef,
  onUploadRefs,
  onEditRef,
}: {
  signedIn: boolean
  /** Active references from the account library, driven by the Refs dropdown. */
  activeRefs: { id: string; url: string }[]
  onRemoveRef: (id: string) => void
  onUploadRefs: (items: { id: string; url: string }[]) => void
  /** Tapping a thumbnail opens the site's Edit Reference canvas on it. */
  onEditRef: (id: string, url: string) => void
  /**
   * The portal's OWN session feed, handed down by the page.
   *
   * Rendering a second feed component here meant a paginated grid with page
   * numbers while the rest of the site scrolls continuously, and none of the
   * user's feed settings (masonry, columns, tile size, borders) applied. The
   * page passes its ImageGrid instead, so these are the same feed.
   */
  renderFeed: (
    kind: "image" | "video",
    nonce?: number,
    /** Shots still rendering, shown as live placeholders in the feed. */
    pending?: { queueId: number; prompt: string; at: number; model: string; aspect?: string; quality?: string; refs?: string[] }[],
  ) => React.ReactNode
}) {
  // No local ref list: the account's active references ARE the film's
  // references, so the taskbar dropdown and this panel can never disagree.
  const refs = activeRefs
  const [prompt, setPrompt] = useState("")
  const [uploading, setUploading] = useState(false)
  const [feedKey, setFeedKey] = useState(0)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  // One question at a time: a wall of them is a form, not a conversation
  const [qIndex, setQIndex] = useState(0)
  // Typed answers, per question index. A quiz that only accepts its own
  // options cannot hear an idea the employee did not think of.
  const [custom, setCustom] = useState<Record<number, string>>({})
  // Overrides applied when approving the plan. They ride along as a note, which
  // the approve route already forwards to the employee.
  // Output settings the user fixes up front. They are part of the brief, so
  // the employee plans and renders to them instead of guessing — and they are
  // the answer to "my references are low quality, make the film better".
  const [imgQuality, setImgQuality] = useState("4k")
  const [imgAspect, setImgAspect] = useState("16:9")
  const [vidRes, setVidRes] = useState("1080p")
  const [vidAspect, setVidAspect] = useState("16:9")
  // The FINISHED CUT length. Server-side it drives assemble_film's shortfall
  // check, so it has to be written to preferences, not only into the brief.
  const [runtime, setRuntime] = useState("standard")
  // Sound was the one production decision with no setting, so the employee
  // guessed and two runs of the same brief came back with different
  // soundtracks. The default adds no spend beyond the shots themselves.
  const [audio, setAudio] = useState(DEFAULT_AUDIO_PLAN)
  /**
   * A hard ceiling the user sets before anything is planned.
   *
   * The employee has always stated a budget; the user has never been able to
   * SET one. "" means no cap \u2014 the studio proposes what the film needs.
   */
  const [capTickets, setCapTickets] = useState("")
  /**
   * Edit-mode settings.
   *
   * The production dropdowns are dead once a film exists \u2014 quality and aspect
   * are fixed by the footage already shot, and re-picking a runtime mid-edit
   * would silently invalidate the cut. What an edit actually needs is
   * different: how much longer, and what to do about the sound.
   */
  const [extendBy, setExtendBy] = useState("0")
  const [editSound, setEditSound] = useState("keep")
  const [planRes, setPlanRes] = useState("4k")
  const [planAspect, setPlanAspect] = useState("16:9")
  const [rail, setRail] = useState<RailState>({
    chatId: null, hasRun: false, filmUrl: null, pausedMessageId: null, busy: false, status: "", questions: null, plan: null, storyboard: null, approvals: [], cutShots: null, error: null,
  })
  const [films, setFilms] = useState<Film[]>([])
  // Which tab is being renamed, and which is asking to be closed
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null)
  const [confirmClose, setConfirmClose] = useState<number | null>(null)
  const [shots, setShots] = useState<Shot[]>([])
  // Shots submitted but not yet settled — the film is shooting, and these
  // are the tiles the videos feed should show as generating.
  const [pendingShots, setPendingShots] = useState<
    { queueId: number; prompt: string; at: number; model: string; aspect?: string; quality?: string; refs?: string[] }[]
  >([])
  // The readable half of the run: what it said and what it built
  const [activity, setActivity] = useState<Activity[]>([])
  // The approved plan, and what the run has actually made against it.
  // pendingApproval is cleared the moment the plan is approved, so the steps
  // have to be caught while the card is on screen or there is nothing left to
  // check the run against.
  const [planSteps, setPlanSteps] = useState<string[]>([])
  const [genPools, setGenPools] = useState<Record<string, Gen[]>>({})
  // Once the cut exists the panel shows the film; this puts the checklist
  // back, which is when comparing it to the plan is most worth doing.
  /**
   * Which face of the panel is showing.
   *
   * The panel does six jobs and used to choose between them purely by
   * priority, which meant you could not look at the plan while it was
   * shooting \u2014 the running state always won. Tabs make that a choice. What
   * BLOCKS the run (a question, an approval) still takes the panel over,
   * because those are not something to browse away from.
   */
  const [panelTab, setPanelTab] = useState<"now" | "film" | "plan" | "activity">("film")
  // Auto-follow the work until the user picks a tab themselves; after that,
  // stop moving the view under them.
  const tabPinnedRef = useRef(false)
  const [autofilling, setAutofilling] = useState(false)
  /**
   * Which character each reference IS.
   *
   * Sixteen untagged thumbnails is not a cast, it is a pile, and the employee
   * has been inferring who is who from the grid \u2014 which is exactly where
   * likeness errors start. Keyed by reference url and stored on the ACCOUNT,
   * not the film: a picture of Lori is Lori in every production she is in.
   */
  const [cast, setCast] = useState<Record<string, string>>({})
  const [castingRef, setCastingRef] = useState<string | null>(null)
  const [castDraft, setCastDraft] = useState("")
  const [boardNote, setBoardNote] = useState("")
  /**
   * An approval is in flight.
   *
   * respond() streams, so the screen did not change until the first token came
   * back \u2014 several seconds of a button that looked untouched. Pressing it
   * again sent a SECOND approval for a call the server had already consumed,
   * which is what produced the error popup.
   */
  const [answering, setAnswering] = useState(false)
  /** Settled generations by queue id, so the board can show its plates. */
  const [plateUrls, setPlateUrls] = useState<Record<number, string>>({})
  /** Queue ids whose generation failed, so the board can say so. */
  const [deadPlates, setDeadPlates] = useState<Set<number>>(new Set())
  /** Plates still rendering \u2014 the images feed shows these as generating. */
  const [pendingPlates, setPendingPlates] = useState<
    { queueId: number; prompt: string; at: number; model: string; aspect?: string; quality?: string; refs?: string[] }[]
  >([])
  /** The shot being looked at, and what to do about it. */
  const [inspect, setInspect] = useState<number | null>(null)
  const [inspectNote, setInspectNote] = useState("")
  /**
   * The plan as the user has amended it.
   *
   * Approve-or-deny meant rejecting eleven good shots to fix the twelfth, and
   * a denial throws away the whole proposal rather than correcting it. null =
   * untouched, so the studio's own list is what gets approved.
   */
  const [planEdits, setPlanEdits] = useState<string[] | null>(null)
  /** Characters built in Character Design, available to cast into this film. */
  const [castPool, setCastPool] = useState<
    { chatId: number; name: string; descriptor: string; master: string | null; images: string[] }[]
  >([])
  const [castPicker, setCastPicker] = useState(false)
  /** Descriptors for imported characters, so the employee gets the canon text. */
  const [castDescriptors, setCastDescriptors] = useState<Record<string, string>>({})
  /** What this film has cost so far, against what the plan said it would. */
  const [spent, setSpent] = useState<{ tickets: number; jobs: number }>({ tickets: 0, jobs: 0 })
  const [budget, setBudget] = useState(0)
  const castRef = useRef<Record<string, string>>({})
  /**
   * Stretches of the film marked for a change, in SECONDS.
   *
   * These used to be shot indexes, which meant a mark could only ever be a
   * whole clip — fine for the machinery, wrong for the user, who is looking at
   * a film and wants the bit from 0:12 to 0:19. Assembly can trim a clip at
   * either end, so an arbitrary span IS actionable: the shots it overlaps get
   * trimmed back and replacement footage covers the middle.
   */
  const [marks, setMarks] = useState<{ start: number; end: number }[]>([])

  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // What the feeds were last refreshed for: "<shots landed>:<film url>"
  const feedSigRef = useRef("")
  // Content fingerprints, so a poll that found nothing new writes no state
  const shotSigRef = useRef("")
  const actSigRef = useRef("")
  const filmSigRef = useRef("")
  const waitSigRef = useRef("")
  const poolSigRef = useRef("")
  const plateSigRef = useRef("")
  const platesSigRef = useRef("")
  const planStepsRef = useRef<Record<string, string[]>>({})
  const cutRef = useRef<Map<number, { url: string; shots: number }>>(new Map())
  // The playing element itself, so the strip below it is a scrubber for THIS
  // film rather than a separate picture of it.
  const filmVideoRef = useRef<HTMLVideoElement | null>(null)
  /**
   * How long each shot ACTUALLY runs, read from the footage.
   *
   * The shot list carries the duration that was requested when the shot was
   * submitted, and the two are not the same number \u2014 eleven shots requested
   * at 5s made a strip claiming 55 seconds over a film that runs 29. Every
   * timecode in this panel, and the edit message built from them, has to come
   * from the file rather than the order form.
   */
  const [measured, setMeasured] = useState<Record<number, number>>({})
  const noteDuration = useCallback((queueId: number, secs: number) => {
    if (!Number.isFinite(secs) || secs <= 0) return
    setMeasured(cur => (Math.abs((cur[queueId] ?? 0) - secs) < 0.05 ? cur : { ...cur, [queueId]: secs }))
  }, [])
  const staleCutRef = useRef(false)
  // Films already nudged back to work, so the check fires once per state
  const resumeTriesRef = useRef<Map<number, { n: number; at: number }>>(new Map())
  // Highest stage this film has reached — the pipeline only moves forward
  const stageHighRef = useRef(0)
  // Read by the draft flush, which must not re-subscribe on every keystroke
  const promptRef = useRef("")
  const chatIdRef = useRef<number | null>(null)
  // filmId -> question index -> chosen option
  const answersRef = useRef<Record<string, Record<number, number>>>({})
  // Titles the user typed that the server has not confirmed back yet
  const renamedRef = useRef<Map<number, string>>(new Map())

  // ── the brief is work, so it persists like everything else ────────────────
  // Unsent text lived only in React state, so a refresh threw it away. Drafts
  // are keyed per FILM and stored on the account, which also means the brief
  // you started on the iPad is there on the desktop.
  const draftsRef = useRef<Record<string, string>>({})
  const draftsLoadedRef = useRef(false)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftKey = useCallback((id: number | null) => (id && id > 0 ? String(id) : "new"), [])

  const persistDrafts = useCallback((immediate = false) => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    const write = () => {
      // Empty drafts are dropped and the map is capped, so this cannot grow
      // the preferences column without bound as films accumulate.
      const kept = Object.fromEntries(
        Object.entries(draftsRef.current).filter(([, v]) => v.trim().length > 0).slice(-40),
      )
      draftsRef.current = kept
      fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieStudioDrafts: kept }),
      }).catch(() => {})
    }
    if (immediate) write()
    else draftTimer.current = setTimeout(write, 900)
  }, [])

  const noteDraft = useCallback((id: number | null, text: string) => {
    if (!draftsLoadedRef.current) return // never overwrite before the load lands
    const k = draftKey(id)
    if (text.trim()) draftsRef.current[k] = text
    else delete draftsRef.current[k]
    persistDrafts()
  }, [draftKey, persistDrafts])

  const clearDraft = useCallback((id: number | null) => {
    delete draftsRef.current[draftKey(id)]
    persistDrafts(true)
  }, [draftKey, persistDrafts])

  // Load once, then restore whatever belongs to the film that is open
  useEffect(() => {
    fetch("/api/user/preferences", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const raw = d?.preferences?.movieStudioDrafts
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          draftsRef.current = Object.fromEntries(
            Object.entries(raw as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
              .map(([k, v]) => [k, v as string]),
          )
        }
        // Part-answered questions are progress too: losing which options were
        // already chosen is the same annoyance as losing the typed brief.
        const fmt = d?.preferences?.chatHubMovieFormat
        if (typeof fmt === "string" && MOVIE_FORMATS.some(f => f.id === fmt)) setRuntime(fmt)
        const savedCast = d?.preferences?.movieStudioCast
        if (savedCast && typeof savedCast === "object" && !Array.isArray(savedCast)) {
          castRef.current = savedCast as Record<string, string>
          setCast(castRef.current)
        }
        const cap = d?.preferences?.movieStudioBudgetCap
        if (typeof cap === "number" && cap > 0) setCapTickets(String(cap))
        const snd = d?.preferences?.chatHubAudioPlan
        if (typeof snd === "string" && AUDIO_PLANS.some(a => a.id === snd)) setAudio(snd)
        const cfg = d?.preferences?.movieStudioOutput
        if (cfg && typeof cfg === "object") {
          if (typeof cfg.imgQuality === "string") setImgQuality(cfg.imgQuality)
          if (typeof cfg.imgAspect === "string") setImgAspect(cfg.imgAspect)
          if (typeof cfg.vidRes === "string") setVidRes(cfg.vidRes)
          if (typeof cfg.vidAspect === "string") setVidAspect(cfg.vidAspect)
        }
        const savedPlans = d?.preferences?.movieStudioPlanSteps
        if (savedPlans && typeof savedPlans === "object" && !Array.isArray(savedPlans)) {
          planStepsRef.current = savedPlans as Record<string, string[]>
        }
        const savedAnswers = d?.preferences?.movieStudioAnswers
        if (savedAnswers && typeof savedAnswers === "object") answersRef.current = savedAnswers as Record<string, Record<number, number>>
        draftsLoadedRef.current = true

        // The film this account had open, whatever device it was opened on
        const activeFilm = Number(d?.preferences?.movieStudioActiveFilm ?? 0)
        const openId = chatIdRef.current ?? (activeFilm > 0 ? activeFilm : null)
        if (!chatIdRef.current && openId) setRail(r => ({ ...r, chatId: openId }))
        if (openId) {
          setAnswers(answersRef.current[String(openId)] ?? {})
          setPlanSteps(planStepsRef.current[String(openId)] ?? [])
        }

        const mine = draftsRef.current[draftKey(openId)]
        // Never clobber something typed while this request was in flight
        if (mine) setPrompt(prev => (prev.trim() ? prev : mine))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A refresh inside the debounce window is exactly the case this exists for,
  // so flush on the way out; keepalive survives the page going away.
  useEffect(() => {
    const flush = () => {
      if (!draftsLoadedRef.current) return
      const k = draftKey(chatIdRef.current)
      const typed = promptRef.current
      if (typed.trim()) draftsRef.current[k] = typed
      else delete draftsRef.current[k]
      try {
        fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ movieStudioDrafts: draftsRef.current }),
          keepalive: true,
        }).catch(() => {})
      } catch {}
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush()
    })
    return () => window.removeEventListener("pagehide", flush)
  }, [draftKey])

  /**
   * Start a run and hold the connection open until it ends.
   *
   * These routes answer with an SSE stream. `await fetch()` resolves as soon as
   * the headers arrive, and a response body nobody reads is a client that has
   * stopped listening \u2014 so the server cancelled the run seconds after it
   * began. This workspace does not render the stream, but it still has to DRAIN
   * it, and the end of the stream is also the most reliable "now go look at the
   * result" signal there is.
   */
  const runStream = useCallback(async (url: string, body: unknown) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error || `Request failed (${res.status})`)
      }
      const reader = res.body?.getReader()
      if (reader) {
        // Read to completion; the bytes themselves are not needed here.
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      return null
    } catch (e: any) {
      return String(e?.message || e)
    }
  }, [])

  // ── the tab strip: every film this account has going ──────────────────────
  const loadFilms = useCallback(async () => {
    const res = await fetch("/api/employees/films", { cache: "no-store" })
    if (!res.ok) return
    const d = await res.json()
    if (!Array.isArray(d.films)) return
    // A name the user just typed WINS over anything this response carries. The
    // poll runs every few seconds, so a request that left before the rename
    // committed would otherwise land after it and flick the old name back.
    // The override is dropped once the server itself reports the new name.
    const next = d.films.map((f: Film) => {
      const mine = renamedRef.current.get(f.id)
      if (mine === undefined) return f
      if (f.title === mine) { renamedRef.current.delete(f.id); return f }
      return { ...f, title: mine }
    })
    const filmSig = next.map((f: Film) => `${f.id}:${f.title}:${f.filmUrl ?? ""}:${f.shotsLanded}/${f.shotsSubmitted}:${f.awaitingUser}`).join("|")
    if (filmSig !== filmSigRef.current) {
      filmSigRef.current = filmSig
      setFilms(next)
    }
  }, [])

  useEffect(() => { void loadFilms() }, [loadFilms])

  // Guards the auto-open so it runs once, not on every films refresh
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current || !draftsLoadedRef.current) return
    if (rail.chatId) { autoOpenedRef.current = true; return }
    if (films.length > 0) {
      autoOpenedRef.current = true
      openFilm(films[0].id)
      return
    }
    // No films at all: start one so the workspace is never empty.
    autoOpenedRef.current = true
    void newFilm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [films, rail.chatId])

  const newFilm = async () => {
    const res = await fetch("/api/employees/films", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    if (!res.ok) return
    const { film } = await res.json()
    setFilms(prev => [film, ...prev])
    openFilm(film.id)
  }

  const openFilm = (id: number) => {
    // A film that exists but has never been briefed is IDLE. Opening a tab used
    // to set busy=true, so an untouched film showed a spinner and a "Working"
    // panel with nothing running.
    setRail({
      chatId: id, hasRun: false, filmUrl: null, pausedMessageId: null,
      busy: false, status: "", questions: null, plan: null, storyboard: null, approvals: [], cutShots: null, error: null,
    })
    setShots([]); setMarks([])
    setAnswers(answersRef.current[String(id)] ?? {})
    setQIndex(0)
    stageHighRef.current = 0
    setActivity([])
    setPendingShots([])
    setPlanSteps(planStepsRef.current[String(id)] ?? [])
    setSpent({ tickets: 0, jobs: 0 })
    setBudget(0)
    setGenPools({})
    poolSigRef.current = ""
    // Each film keeps its own unsent brief
    if (draftsLoadedRef.current) {
      const leaving = draftKey(chatIdRef.current)
      const typed = promptRef.current
      if (typed.trim()) draftsRef.current[leaving] = typed
      else delete draftsRef.current[leaving]
      persistDrafts(true)
    }
    setPrompt(draftsRef.current[draftKey(id)] ?? "")
  }

  const renameFilm = async (id: number, title: string) => {
    const clean = title.trim().slice(0, 80)
    setRenaming(null)
    if (!clean) return
    renamedRef.current.set(id, clean)
    setFilms(prev => prev.map(f => (f.id === id ? { ...f, title: clean } : f)))
    const res = await fetch("/api/employees/films", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: clean }),
    }).catch(() => null)
    // The save failed — stop pretending it stuck, and let the server's name
    // come back on the next poll rather than showing a name nobody has.
    if (!res || !res.ok) renamedRef.current.delete(id)
  }

  const closeFilm = async (id: number) => {
    setConfirmClose(null)
    await fetch(`/api/employees/films?id=${id}`, { method: "DELETE" }).catch(() => {})
    const rest = films.filter(f => f.id !== id)
    setFilms(rest)
    if (rail.chatId === id) {
      setShots([])
      // Never land on an empty workspace: fall through to the next film, or
      // start a new one if that was the last.
      if (rest.length > 0) openFilm(rest[0].id)
      else void newFilm()
    }
  }

  // A film runs for many minutes across several passes, so the workspace has to
  // survive a refresh the way every other page does: remember which chat is the
  // production and re-attach to it on mount.
  // sessionStorage is the fast local hint; the account preference is the one
  // that follows the user to another device. Whichever answers first wins, and
  // the account value corrects it if they disagree.
  useEffect(() => {
    try {
      const saved = Number(sessionStorage.getItem("movie-studio-chat") ?? 0)
      if (saved > 0) setRail(r => ({ ...r, chatId: saved }))
    } catch {}
  }, [])
  useEffect(() => {
    try {
      if (rail.chatId) sessionStorage.setItem("movie-studio-chat", String(rail.chatId))
      else sessionStorage.removeItem("movie-studio-chat")
    } catch {}
    if (!draftsLoadedRef.current) return
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieStudioActiveFilm: rail.chatId ?? null }),
    }).catch(() => {})
  }, [rail.chatId])

  // ── references ───────────────────────────────────────────────────────────
  // Uploading here is the same act as uploading from the Refs dropdown: the
  // page files it into the account library and activates it, so it appears in
  // both places at once.
  const addFiles = useCallback(async (files: File[]) => {
    // Stills and clips have separate budgets, so a dropped folder of both
    // fills each one independently instead of one crowding the other out.
    let imgRoom = MAX_REFS - refs.filter(r => !isVideoRef(r.url)).length
    let vidRoom = MAX_VIDEO_REFS - refs.filter(r => isVideoRef(r.url)).length
    if (files.length === 0 || (imgRoom <= 0 && vidRoom <= 0)) return
    setUploading(true)
    try {
      const uploaded: { id: string; url: string }[] = []
      for (const file of files) {
        const isVid = file.type.startsWith("video/")
        if (isVid ? vidRoom <= 0 : imgRoom <= 0) continue
        const fd = new FormData()
        fd.append("file", file)
        // Video goes through the media endpoint: /api/upload-reference is an
        // image path, and a 60MB clip needs the streaming route's ceiling.
        const up = await fetch(isVid ? "/api/upload-video-media" : "/api/upload-reference", {
          method: "POST",
          body: fd,
        })
        if (!up.ok) continue
        const { url } = await up.json()
        if (typeof url !== "string") continue
        uploaded.push({ id: url, url })
        if (isVid) vidRoom--
        else imgRoom--
      }
      if (uploaded.length) onUploadRefs(uploaded)
    } finally {
      setUploading(false)
    }
  }, [refs, onUploadRefs])

  // ── read the run's state out of the chat, no streaming ────────────────────
  const readChat = useCallback(async (chatId: number) => {
    // Settle first: this is what turns a shot that finished at fal into a
    // saved generation with a url. Without it the chat never changes and the
    // feed never gets the video. Failures are ignored — the next tick retries.
    // The settle call already walks every step of the run, so it returns the
    // running spend too rather than this needing a poll of its own.
    await fetch(`/api/chat-hub/chats/${chatId}/film-status`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && typeof d.spent === "number") {
          setSpent(prev => (prev.tickets === d.spent && prev.jobs === d.spentJobs
            ? prev
            : { tickets: d.spent, jobs: d.spentJobs ?? 0 }))
        }
      })
      .catch(() => {})
    const res = await fetch(`/api/chat-hub/chats/${chatId}`, { cache: "no-store" })
    if (!res.ok) return
    const d = await res.json()
    const rows: any[] = d.messages ?? []
    const last = [...rows].reverse().find(m => m.role === "assistant")
    const meta = last?.metadata ?? {}
    const steps: any[] = meta.agentSteps ?? []
    const pending: any[] = meta.pendingApproval?.calls ?? []

    // The newest running step is the honest answer to "what is it doing"
    const running = [...steps].reverse().find(s => s.status === "running")
    const lastDone = [...steps].reverse().find(s => s.status === "done" && s.tool !== "reasoning")
    const label =
      running ? STEP_LABEL[running.tool] ?? "Working…"
      : pending.length ? "Waiting for you"
      : lastDone ? STEP_LABEL[lastDone.tool] ?? "Working…"
      : "Working…"

    const ask = pending.find(c => c.toolName === "ask_user")
    const plan = pending.find(c => c.toolName === "propose_plan")
    // Anything else it is asking permission for. Without this the run pauses
    // on a tool the panel has no card for and nothing can move it again.
    const board = pending.find(c => c.toolName === "present_storyboard")
    const otherCalls = pending.filter(c =>
      c.toolName !== "ask_user" && c.toolName !== "propose_plan" && c.toolName !== "present_storyboard")

    // The shot map: every landed shot in submission order. Durations come from
    // the shot's own settings, which is what assemble_film cut with, so the
    // timeline lines up with the film without probing the video.
    const built: Shot[] = []
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        // render_plates returns queueIds too — those are STILLS, not shots in
        // the cut. Counting them here put plates on the timeline and made the
        // film look like it had more coverage than it actually did.
        if (st?.tool !== "render_shots") continue
        if (!Array.isArray(st?.queueIds)) continue
        const res = st.shotResults ?? {}
        const models = st.shotModels ?? {}
        for (const q of st.queueIds) {
          const url = res[String(q)]
          if (typeof url !== "string" || url.startsWith("ERROR:")) continue
          built.push({
            queueId: q,
            index: built.length + 1,
            url,
            model: models[String(q)] ?? "",
            prompt: typeof st.prompt === "string" ? st.prompt : undefined,
            // What was ASKED FOR, which is not what came back: a model
            // routinely returns less than the duration requested, and where
            // the setting was never recorded this is a flat 5. Real lengths
            // are measured from the footage; this is only the placeholder
            // until that lands.
            seconds: Number(st.settings?.duration) || 5,
            startSec: 0,
          })
        }
      }
    }
    let t = 0
    for (const sh of built) { sh.startSec = t; t += sh.seconds }

    // Everything submitted whose result has not arrived. Ordered by queue id so
    // the feed shows them in the order they were sent.
    const waiting: { queueId: number; prompt: string; at: number; model: string; aspect?: string; quality?: string; refs?: string[] }[] = []
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        // render_plates returns queueIds too — those are STILLS, not shots in
        // the cut. Counting them here put plates on the timeline and made the
        // film look like it had more coverage than it actually did.
        if (st?.tool !== "render_shots") continue
        if (!Array.isArray(st?.queueIds)) continue
        const res = st.shotResults ?? {}
        const models = st.shotModels ?? {}
        for (const q of st.queueIds) {
          if (typeof q === "number" && res[String(q)] === undefined) {
            waiting.push({
              queueId: q,
              prompt: String(st.prompt ?? "Shot"),
              at: Date.parse(m.createdAt ?? "") || Date.now(),
              model: String(models[String(q)] ?? st.model ?? ""),
              aspect: st.settings?.aspect,
              quality: st.settings?.resolution ?? st.settings?.quality,
              refs: Array.isArray(st.refs) ? st.refs : undefined,
            })
          }
        }
      }
    }
    waiting.sort((a, b) => a.queueId - b.queueId)
    const waitSig = waiting.map(w => w.queueId).join(",")
    if (waitSig !== waitSigRef.current) {
      waitSigRef.current = waitSig
      setPendingShots(waiting)
    }
    // Identity matters: an unchanged array that is merely NEW re-renders the
    // entire page, and the taskbar's shimmer animation restarts with it.
    const shotSig = built.map(b => `${b.queueId}:${b.url}`).join("|")
    if (shotSig !== shotSigRef.current) {
      shotSigRef.current = shotSig
      setShots(built)
    }

    // The finished cut: the newest assemble_film result anywhere in the run.
    // Later passes replace earlier ones, so the viewer always holds the current
    // version of the film rather than the first one made.
    let film: string | null = null
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        if (st?.tool === "assemble_film" && st.status === "done" && typeof st.imageUrl === "string" && st.imageUrl) {
          film = st.imageUrl
        }
      }
    }

    // EVERY settled generation in this film, by queue id.
    //
    // render_plates returns ids because the images are still rendering when it
    // returns, so the storyboard can only ever name ids \u2014 and without this map
    // every frame on the board showed "no plate" even after the pictures had
    // landed in the feed.
    const urlById: Record<number, string> = {}
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        const res = st?.shotResults
        if (res && typeof res === "object") {
          for (const [q, v] of Object.entries(res)) {
            if (typeof v === "string" && v && !v.startsWith("ERROR:")) urlById[Number(q)] = v
          }
        }
        if (typeof st?.queueId === "number" && typeof st?.imageUrl === "string" && st.imageUrl) {
          urlById[st.queueId] = st.imageUrl
        }
      }
    }
    // Plates that DIED. Without these a failed frame spins "rendering"
    // forever, because a failure never produces a url to resolve to.
    const deadIds: number[] = []
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        const res = st?.shotResults
        if (!res || typeof res !== "object") continue
        for (const [q, v] of Object.entries(res)) {
          if (typeof v === "string" && v.startsWith("ERROR:")) deadIds.push(Number(q))
        }
      }
    }
    const plateSig = Object.entries(urlById).map(([k, v]) => k + v).join("|") + "!" + deadIds.join(",")
    if (plateSig !== plateSigRef.current) {
      plateSigRef.current = plateSig
      setPlateUrls(urlById)
      setDeadPlates(new Set(deadIds))
    }

    // Plates still rendering, so the images feed can show them the way the
    // video feed already shows shots. Employee generations never appeared as
    // GENERATING tiles at all \u2014 they simply materialised when they finished.
    const platesWaiting: { queueId: number; prompt: string; at: number; model: string; aspect?: string; quality?: string; refs?: string[] }[] = []
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        if (st?.tool !== "render_plates" || !Array.isArray(st?.queueIds)) continue
        const res = st.shotResults ?? {}
        const models = st.shotModels ?? {}
        for (const q of st.queueIds) {
          if (typeof q === "number" && res[String(q)] === undefined) {
            platesWaiting.push({
              queueId: q,
              prompt: String(st.prompt ?? "Plate"),
              at: Date.parse(m.createdAt ?? "") || Date.now(),
              model: String(models[String(q)] ?? st.model ?? ""),
              aspect: st.settings?.aspect,
              quality: st.settings?.quality ?? st.settings?.resolution,
              refs: Array.isArray(st.refs) ? st.refs : undefined,
            })
          }
        }
      }
    }
    platesWaiting.sort((a, b) => a.queueId - b.queueId)
    const platesSig = platesWaiting.map(w => w.queueId).join(",")
    if (platesSig !== platesSigRef.current) {
      platesSigRef.current = platesSig
      setPendingPlates(platesWaiting)
    }

    // Footage the current cut could not have contained.
    let cutShots: number | null = null
    if (film) {
      const prev = cutRef.current.get(chatId)
      if (!prev || prev.url !== film) {
        cutRef.current.set(chatId, { url: film, shots: built.length })
        cutShots = built.length
      } else {
        cutShots = prev.shots
      }
    }

    // ── the plan, and what the run actually did about it ───────────────
    const planKey = String(chatId)
    if (plan && Array.isArray(plan.input?.steps)) {
      const fresh = (plan.input.steps as unknown[]).map(String)
      if (JSON.stringify(planStepsRef.current[planKey] ?? []) !== JSON.stringify(fresh)) {
        planStepsRef.current[planKey] = fresh
        setPlanSteps(fresh)
        const b = Number(plan.input?.ticket_budget ?? 0)
        if (b > 0) setBudget(b)
        // A fresh proposal supersedes any edits to the previous one.
        setPlanEdits(null)
        // On the account, so the checklist survives a reload mid-shoot.
        fetch("/api/user/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            movieStudioPlanSteps: Object.fromEntries(
              Object.entries(planStepsRef.current).slice(-30),
            ),
          }),
        }).catch(() => {})
      }
    }

    // The record of what HAPPENED, bucketed the same way the plan reads.
    // A queue id with no result yet is still rendering; an ERROR: result is a
    // failure, and it has to show as one — a shot that died silently is the
    // exact drift this panel exists to catch.
    const pools: Record<string, Gen[]> = { image: [], video: [], audio: [], assemble: [], board: [], check: [] }
    for (const m of rows) {
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        if (Array.isArray(st?.queueIds)) {
          const bucket = st.tool === "render_shots" ? "video" : "image"
          const res = st.shotResults ?? {}
          for (const q of st.queueIds) {
            const r = res[String(q)]
            pools[bucket].push({
              id: `q${q}`,
              state: r === undefined ? "running" : String(r).startsWith("ERROR:") ? "failed" : "done",
            })
          }
          continue
        }
        const bucket =
          st?.tool === "create_media" || st?.tool === "edit_image" ? "image"
          : st?.tool === "create_audio" ? "audio"
          : st?.tool === "assemble_film" ? "assemble"
          : st?.tool === "check_shots" ? "check"
          : st?.tool === "present_storyboard" ? "board"
          : null
        if (!bucket) continue
        // Only these three say anything about a generation. "pending" (waiting
        // on approval), "denied" and "superseded" produced nothing, and
        // treating them as finished would tick a plan step that never ran.
        const state =
          st.status === "error" ? "failed"
          : st.status === "running" ? "running"
          : st.status === "done" ? "done"
          : null
        if (!state) continue
        pools[bucket].push({ id: `s${m.id}-${st.id}`, state })
      }
    }
    const poolSig = Object.entries(pools)
      .map(([k, v]) => k + v.map(g => g.id + g.state).join(","))
      .join("|")
    if (poolSig !== poolSigRef.current) {
      poolSigRef.current = poolSig
      setGenPools(pools)
    }

    // ── the activity feed ──────────────────────────────────────────────
    // Deliberately NOT every step: thinking, playbook loads and bookkeeping are
    // machinery, and showing them buries the few lines that actually say what
    // the studio is doing.
    const SKIP = new Set(["reasoning", "load_skill", "record_evaluation", "remember", "save_memory", "film_notes"])
    const VERB: Record<string, string> = {
      create_media: "Generated a plate",
      edit_image: "Edited an image",
      render_shots: "Sent shots to the render queue",
      check_shots: "Reviewed the takes",
      extract_frames: "Pulled frames",
      create_audio: "Made the score",
      assemble_film: "Cut the film together",
      ask_user: "Asked you some questions",
      propose_plan: "Put a plan together",
      write_summary: "Wrapped up",
      search_refs: "Looked through your references",
      web_search: "Looked something up",
    }
    const acts: Activity[] = []
    for (const m of rows) {
      if (m?.role !== "assistant") continue
      const meta = m.metadata ?? {}
      // The employee's own words, one entry per round it wrote in
      for (const [si, seg] of ((meta.textSegments ?? []) as string[]).entries()) {
        const line = String(seg).replace(/\s+/g, " ").trim()
        if (line) acts.push({ id: `t${m.id}-${si}`, text: line.slice(0, 240) })
      }
      for (const st of ((meta.agentSteps ?? []) as any[])) {
        if (!st?.tool || SKIP.has(st.tool) || st.status === "error") continue
        const label = VERB[st.tool]
        if (!label) continue
        const n = Array.isArray(st.queueIds) ? st.queueIds.length : 0
        acts.push({ id: `s${m.id}-${st.id}`, text: n > 0 ? `${label} (${n})` : label })
      }
    }
    const trimmed = acts.slice(-40)
    const actSig = trimmed.map(a => a.id + a.text).join("|")
    if (actSig !== actSigRef.current) {
      actSigRef.current = actSig
      setActivity(trimmed)
    }

    // No messages yet = nothing is happening, whatever the step scan says.
    const everRan = rows.length > 0
    const died = last?.metadata?.streamErrored === true

    // A step still marked running whose shots have ALL settled is stale, not
    // live — that staleness is why the rail kept saying "Shooting the film"
    // over a finished cut.
    const inFlight = steps.some((st: any) => {
      if (st?.status !== "running") return false
      if (!Array.isArray(st.queueIds)) return true
      const res = st.shotResults ?? {}
      return st.queueIds.some((q: number) => res[String(q)] === undefined)
    })
    // The headline has to agree with the picture underneath it. Nothing
    // running, nothing queued, nothing to answer and a cut on screen is a
    // FINISHED film, whatever the last step record happens to say.
    const settled = !inFlight && pending.length === 0 && waiting.length === 0
    const headline =
      pending.length ? "Waiting for you"
      : film && settled ? "Your film is ready"
      : label

    setRail(r => ({
      ...r,
      hasRun: everRan,
      pausedMessageId: pending.length ? (last?.id ?? null) : null,
      filmUrl: film ?? r.filmUrl,
      cutShots: cutShots ?? r.cutShots,
      status: died ? "The run stopped" : everRan ? headline : "",
      error: died
        ? "The last run ended early. Nothing was lost — press Send to pick it back up."
        : r.error,
      // BUSY MEANS A RUN IS IN FLIGHT. It used to mean "this film has messages
      // and nothing pending", which is true of every idle film — so the
      // status said "Working" forever and the resume check, which bails when
      // busy, could never fire.
      busy: inFlight,
      questions: ask
        ? { toolCallId: ask.toolCallId, questions: (ask.input?.questions ?? []) as Question[] }
        : null,
      storyboard: board
        ? {
            toolCallId: board.toolCallId,
            note: String(board.input?.note ?? ""),
            frames: (Array.isArray(board.input?.frames) ? board.input.frames : []).map((f: any) => ({
              n: Number(f?.n) || 0,
              plateUrl: typeof f?.plate_url === "string" ? f.plate_url : undefined,
              plateQueueId: Number(f?.plate_queue_id) || undefined,
              description: String(f?.description ?? ""),
              model: typeof f?.model === "string" ? f.model : undefined,
              seconds: Number(f?.seconds) || undefined,
              feeling: typeof f?.feeling === "string" ? f.feeling : undefined,
            })),
          }
        : null,
      approvals: otherCalls.map((c: any) => ({
        toolCallId: c.toolCallId,
        toolName: String(c.toolName ?? ""),
        ...approvalSummary(c),
      })),
      // propose_plan is { summary, steps[], ticket_budget }. Reading a
      // non-existent `plan`/`task` field is why the card came up empty.
      plan: plan
        ? {
            toolCallId: plan.toolCallId,
            summary: String(plan.input?.summary ?? ""),
            steps: Array.isArray(plan.input?.steps) ? (plan.input.steps as string[]).map(String) : [],
            tickets: Number(plan.input?.ticket_budget ?? 0),
          }
        : null,
    }))
    // Reload the feeds only when this film actually gained something. The poll
    // runs every few seconds; remounting the grids on each tick would throw the
    // user's scroll position away for nothing.
    // Count the IMAGES too. The signature only tracked shots and the cut, so a
    // finished plate never bumped the key and the images feed sat stale —
    // the placeholder vanished and nothing replaced it.
    let madeImages = 0
    for (const m of rows) {
      madeImages += Array.isArray(m?.imageUrls) ? m.imageUrls.length : 0
      for (const st of ((m?.metadata?.agentSteps ?? []) as any[])) {
        if (st?.imageUrl && st.status === "done") madeImages++
      }
    }
    const signature = `${built.length}:${madeImages}:${film ?? ""}`
    if (signature !== feedSigRef.current) {
      feedSigRef.current = signature
      setFeedKey(k => k + 1)
    }
    void loadFilms()
  }, [loadFilms])

  useEffect(() => {
    if (!rail.chatId) return
    if (pollRef.current) clearInterval(pollRef.current)
    void readChat(rail.chatId)
    pollRef.current = setInterval(() => { void readChat(rail.chatId!) }, 6000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [rail.chatId, readChat])

  // Footage that landed after the cut was made. The cut cannot contain it,
  // so the film is not finished and the run has to come back for it.
  // Stills teach the models what things look like; clips are footage the user
  // already owns. They are not interchangeable, so they are never pooled.
  const imageRefs = useMemo(() => refs.filter(r => !isVideoRef(r.url)), [refs])
  const videoRefs = useMemo(() => refs.filter(r => isVideoRef(r.url)), [refs])

  /**
   * The user's own clips, explained to the employee.
   *
   * Worth being exact about, because there are two things a clip CANNOT be:
   * no video model in this catalog takes a video input, so a clip is never a
   * style or motion reference, and it is never passed in
   * reference_image_urls. What it CAN be is footage in the cut, or a source of
   * stills. Left vague, the employee will try to hand an mp4 to a model that
   * only reads images and the shot dies with a useless error.
   */
  const footageNote = useMemo(() => {
    if (videoRefs.length === 0) return ""
    return `\n\n[THE USER ATTACHED ${videoRefs.length} OF THEIR OWN CLIP(S)]\n`
      + videoRefs.map((r, i) => `  ${i + 1}. ${r.url}`).join("\n")
      + `\nThese are REAL FOOTAGE the user already has, not model references. Two things you may do with them:\n`
      + `  \u2022 CUT THEM INTO THE FILM \u2014 pass a clip's url straight to assemble_film in "clips", in story order, `
      + `alongside the shots you render. Trim with trimStart/trimEnd. This costs nothing and is usually why they attached it.\n`
      + `  \u2022 PULL STILLS FROM THEM \u2014 extract_frames gives you images from a clip, and those images ARE usable as `
      + `reference_image_urls or as a start frame, subject to the usual resolution bar.\n`
      + `Do NOT put a clip url in reference_image_urls and do NOT send one to a video model: nothing in this `
      + `catalog accepts a video input, and the shot will fail. If you are not going to use a clip, say so and why.`
  }, [videoRefs])

  /** How long the cut runs, once the footage has reported its real lengths. */
  const filmSeconds = useMemo(
    () => shots.reduce((n, sh) => n + (measured[sh.queueId] ?? sh.seconds), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shots, measured],
  )

  /** The cut on its real clock: measured lengths, re-stacked from zero. */
  const timedShots = useMemo(() => {
    let t = 0
    return shots.map(sh => {
      const secs = measured[sh.queueId] ?? sh.seconds
      const out = { ...sh, seconds: secs, startSec: t }
      t += secs
      return out
    })
  }, [shots, measured])

  // Within ~5s of the ceiling there is no useful extension left to offer, so
  // edit mode says so rather than listing options that would be refused.
  const atCeiling = filmSeconds > 0 && filmSeconds >= MAX_FILM_SECONDS - 5

  /** References grouped by who they are. Unnamed ones come last. */
  const castGroups = useMemo(() => {
    const byName = new Map<string, { id: string; url: string }[]>()
    const loose: { id: string; url: string }[] = []
    for (const r of imageRefs) {
      const name = cast[r.url]
      if (name) {
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name)!.push(r)
      } else loose.push(r)
    }
    return { named: [...byName.entries()], loose }
  }, [imageRefs, cast])

  /**
   * The cast list, written out for the employee.
   *
   * This is the difference between "here are sixteen pictures" and "these
   * four are Lori" \u2014 the second is castable, the first has to be guessed at.
   */
  const castNote = useMemo(() => {
    if (castGroups.named.length === 0) return ""
    return `\n\n[THE CAST \u2014 the user has told you who is who]\n`
      + castGroups.named.map(([name, rs]) =>
          `  ${name}: ${rs.length} reference(s)\n${rs.map(r => `    ${r.url}`).join("\n")}`
          // A descriptor from a Character Design board is canon text written
          // to be repeated verbatim \u2014 far better than anything derived by
          // looking at the thumbnails.
          + (castDescriptors[name] ? `\n    CANON DESCRIPTOR (use these words verbatim in every prompt they are in): ${castDescriptors[name]}` : "")
        ).join("\n")
      + (castGroups.loose.length
        ? `\n  Unassigned: ${castGroups.loose.length} reference(s) \u2014 locations, props or characters they have not named.`
        : "")
      + `\nUse these groupings: every reference under a name is the SAME PERSON, so pass them together when you `
      + `render that character and write ONE canon descriptor per name. Do not mix references across names in a `
      + `single character's prompt.`
  }, [castGroups, castDescriptors])

  const staleCut = rail.cutShots !== null && shots.length > rail.cutShots

  /**
   * Each marked span, tidied and matched to the footage underneath it.
   *
   * Overlapping marks are merged, because two overlapping requests for the
   * same seconds are one request. Every span also carries the shots it
   * touches and HOW MUCH of each — a span that starts halfway through shot 3
   * is a trim of shot 3, not a reshoot of it, and only the offsets say which.
   */
  const sections = useMemo(() => {
    const sorted = [...marks]
      .map(m => ({ start: Math.max(0, Math.min(m.start, m.end)), end: Math.max(m.start, m.end) }))
      .filter(m => m.end - m.start > 0.05)
      .sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const m of sorted) {
      const last = merged[merged.length - 1]
      if (last && m.start <= last.end + 0.05) last.end = Math.max(last.end, m.end)
      else merged.push({ ...m })
    }
    return merged.map(m => {
      const touched = timedShots
        .filter(sh => sh.startSec < m.end && sh.startSec + sh.seconds > m.start)
        .map(sh => {
          const overlapFrom = Math.max(m.start, sh.startSec)
          const overlapTo = Math.min(m.end, sh.startSec + sh.seconds)
          return {
            shot: sh,
            // Whole means the mark swallows the clip; partial means it has to
            // be trimmed rather than replaced.
            whole: overlapFrom <= sh.startSec + 0.05 && overlapTo >= sh.startSec + sh.seconds - 0.05,
            fromInShot: overlapFrom - sh.startSec,
            toInShot: overlapTo - sh.startSec,
          }
        })
      return { startSec: m.start, endSec: m.end, touched }
    })
  }, [marks, timedShots])

  /**
   * A film with all its footage and no run in flight has to be picked back up.
   *
   * The chat hub has this check; this workspace did not, so a run that ended
   * after settling its shots just stopped — eleven finished takes and no
   * cut, sitting there indefinitely. Keyed on STATE, not on catching the moment
   * the last shot lands, so it recovers whatever the reason.
   */
  useEffect(() => {
    const chatId = rail.chatId
    if (!chatId || rail.busy || rail.questions || rail.plan || rail.storyboard) return
    if (rail.approvals.length > 0) return
    if (!rail.hasRun) return
    // A cut that already covers every landed shot is finished; a cut made
    // BEFORE some of the footage landed is not, and bailing on "a film url
    // exists" is what left those shots stranded.
    if (rail.filmUrl && !staleCut) return
    if (shots.length === 0 || pendingShots.length > 0) return

    // Bounded: at most 3 nudges per film, and never more than one every 3
    // minutes. One push is usually enough; a single push that fails used to
    // leave the film stuck for good, and an unbounded one would spam the run.
    const tries = resumeTriesRef.current.get(chatId) ?? { n: 0, at: 0 }
    if (tries.n >= 3 || Date.now() - tries.at < 3 * 60 * 1000) return
    resumeTriesRef.current.set(chatId, { n: tries.n + 1, at: Date.now() })
    staleCutRef.current = staleCut
    setRail(r => ({ ...r, busy: true, status: staleCut ? "Re-cutting with the rest of the footage…" : "Picking the film back up…" }))
    void (async () => {
      const err = await runStream(`/api/chat-hub/chats/${chatId}/send`, {
        content: staleCutRef.current
          ? `[FOOTAGE LANDED AFTER THE CUT WAS MADE]
`
            + `${shots.length} shots have now landed, but the current cut was assembled from only `
            + `${rail.cutShots}. The rest are finished, paid for, and not in the film. `
            + `Re-assemble the complete cut with every shot that belongs in it. If a shot genuinely should stay out, `
            + `pass it in assemble_film's "omitted" list with the reason. Do NOT re-render anything.`
          : `[ALL ${shots.length} SHOTS HAVE LANDED]
`
            + `Every shot you submitted has finished and the footage is in this conversation. `
            + `Continue: judge the takes from their frames, then ASSEMBLE the film with assemble_film and score it. `
            + `Do NOT re-submit shots that already rendered — the remaining work is the cut itself.`,
      })
      if (err) setRail(r => ({ ...r, busy: false, error: err }))
      void readChat(chatId)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail.chatId, rail.busy, rail.hasRun, rail.filmUrl, rail.questions, rail.plan,
      rail.approvals.length, staleCut, shots.length, pendingShots.length])

  // ── start the production ─────────────────────────────────────────────────
  const start = async () => {
    if (!prompt.trim() || rail.busy) return
    // Synchronous, before the fetch: the click has to change the screen in the
    // same frame or it reads as "nothing happened".
    setRail(r => ({ ...r, busy: true, hasRun: true, status: "Creating a plan…", error: null }))
    try {
      // Every film is a tab, so the tab is created first and the brief is
      // sent into it. A film with no tab could never be found again.
      let chatId = rail.chatId
      if (!chatId) {
        const mk = await fetch("/api/employees/films", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: prompt.trim().slice(0, 60) }),
        })
        if (!mk.ok) throw new Error("Could not start the production")
        const { film } = await mk.json()
        chatId = film.id as number
        setFilms(prev => [film, ...prev])
      }

      setRail(r => ({ ...r, chatId, hasRun: true, status: "Creating a plan…" }))
      clearDraft(chatId)
      clearDraft(null) // the "new film" draft became this film's brief
      const err = await runStream(`/api/chat-hub/chats/${chatId}/send`, {
        content:
          prompt.trim()
          + `\n\n[OUTPUT SETTINGS — the user set these, treat them as fixed]\n`
          + `Every IMAGE you generate: ${imgQuality.toUpperCase()}, ${imgAspect} aspect.\n`
          + `Every VIDEO shot: ${vidRes}, ${vidAspect} aspect.\n`
          + `FINISHED RUNTIME: ${movieFormatById(runtime).label} \u2014 about ${movieFormatById(runtime).seconds}, `
          + `${movieFormatById(runtime).shots}. The assembled cut must actually run near that length: `
          + `count the shots the runtime needs and shoot them ALL before assembling. A one-shot cut is not a film.\n`
          + `Price the plan at these settings and pass them in each generation's settings. `
          + `If a model cannot do one of them, say which shot and why in one line rather than silently using something else.`
          + (Number(capTickets) > 0
            ? `\n\n[BUDGET CEILING \u2014 ${capTickets} TICKETS, SET BY THE USER]\n`
              + `This is a HARD LIMIT on the whole film, not a target. Price the plan against it and propose a shot `
              + `list that FITS: if the runtime cannot be delivered inside it, say so in one line and propose the `
              + `best film that can be, rather than planning something you cannot afford. Do not exceed it \u2014 if you `
              + `are heading over mid-production, stop and ask instead of spending.`
            : "")
          + footageNote + castNote,
        // Only the STILLS go in imageUrls — that field is what the model is
        // shown, and a clip there is a broken image.
        imageUrls: imageRefs.map(r => r.url),
      })
      if (err) setRail(r => ({ ...r, busy: false, error: err }))
      void readChat(chatId)
    } catch (e: any) {
      setRail(r => ({ ...r, busy: false, error: String(e?.message || e) }))
    }
  }

  /**
   * What the user actually said to a question: their own words if they wrote
   * any, otherwise the option they picked.
   */
  const answerFor = useCallback((q: Question, i: number) => {
    const typed = (custom[i] ?? "").trim()
    if (typed) return typed
    return (q.options ?? [])[answers[i] ?? -1] ?? ""
  }, [custom, answers])

  /** Say something to the film once it is underway. */
  /**
   * A change to a film that already exists.
   *
   * Sent bare, this reads as a fresh instruction and the employee re-plans from
   * nothing — re-shooting footage that was already paid for. Films here are
   * meant to be edited over and over, so the message says plainly that a cut
   * exists, how much footage is behind it, and that the job is to CHANGE it.
   */
  const followUp = async () => {
    const text = prompt.trim()
    const chatId = rail.chatId
    if (!chatId || !text || rail.busy) return
    setPrompt("")
    clearDraft(chatId)
    setMarks([])
    // One-shot instructions, not standing preferences: leaving these set
    // would quietly extend and re-score every later edit too.
    setExtendBy("0")
    setEditSound("keep")
    setRail(r => ({ ...r, busy: true, error: null }))
    const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}`
    const marked = sections.length > 0
      ? `THE USER MARKED ${sections.length} SECTION(S) OF THE FILM FOR THIS CHANGE:\n`
        + sections.map(sec => {
            const parts = sec.touched.map(t => t.whole
              ? `shot ${t.shot.index} (queue ${t.shot.queueId}) ENTIRELY`
              : `shot ${t.shot.index} (queue ${t.shot.queueId}) from ${t.fromInShot.toFixed(1)}s to ${t.toInShot.toFixed(1)}s into that clip`)
            return `  \u2022 ${clock(sec.startSec)}-${clock(sec.endSec)} of the cut \u2014 covers ${parts.join("; ") || "no footage"}`
          }).join("\n")
        + `\nThose spans are what the change applies to, and the timecodes are the user's actual intent \u2014 `
        + `they are NOT rounded to whole shots. Where a span covers a shot ENTIRELY, render a replacement for it. `
        + `Where it covers only PART of a shot, trim that shot with trimStart/trimEnd in assemble_film so the marked `
        + `piece is removed, and cover the gap with new footage. Keep the same characters, wardrobe, location, light `
        + `and grade unless the change says otherwise. Everything outside those spans stays exactly as it is \u2014 do `
        + `not re-render it. When the new footage lands, re-assemble the FULL film in order, and pass any shot you `
        + `replaced outright to assemble_film in "omitted" with the reason "replaced by reshoot". `
        + `The finished cut must still run its target length.\n\n`
      : ""
    const content = rail.filmUrl
      ? `[EDIT THE EXISTING FILM]\n`
        + `The user wants this change: "${text}"\n\n`
        + marked
        + `There is already a finished cut, built from ${shots.length} shot(s) that are still available in this `
        + `conversation. This is an EDIT, not a new film. Work out the SMALLEST set of changes that delivers it: `
        + `re-render only the shots the change actually touches, reuse every shot it does not, and then re-assemble `
        + `the complete cut. Do not re-plan the film from scratch, do not re-shoot footage that still works, and do `
        + `not start a new story. Say in one line what you are changing and what you are keeping before you spend `
        + `anything.`
        + (refs.length ? `\nThe user's references are attached again — if they added new ones, they are for this change.` : "")
        + (extendBy !== "0"
          ? `\n\nMAKE THE FILM LONGER: the user asked for roughly ${extendBy}s MORE than it runs now. `
            + `Shoot the extra beats the story needs to fill it — do not stretch or loop existing footage — and `
            + `re-assemble so the finished cut is about ${extendBy}s longer than the current one.`
          : "")
        + (editSound === "keep"
          ? `\n\nSOUND: leave it exactly as it is. Do not generate audio and do not re-score.`
          : editSound === "rescore"
            ? `\n\nSOUND: replace the music with a new bed under the whole cut, mixed under the shot audio.`
          : editSound === "narration"
            ? `\n\nSOUND: add narration over the cut. Write it, show the user the words BEFORE spending anything on `
              + `the voice, and duck the music under it.`
            : `\n\nSOUND: strip it. The re-cut is silent — no music, no voice.`)
        + footageNote + castNote
      : text + footageNote + castNote
    const err = await runStream(`/api/chat-hub/chats/${chatId}/send`, {
      content,
      imageUrls: imageRefs.map(r => r.url),
    })
    if (err) setRail(r => ({ ...r, busy: false, error: err }))
    void readChat(chatId)
  }

  const respond = async (approval: Record<string, unknown>) => {
    if (!rail.chatId || rail.pausedMessageId === null || answering) return
    const chatId = rail.chatId
    setAnswering(true)
    // Clear the card in the SAME frame as the press. The pending state comes
    // back from the poll anyway if the send fails, so an optimistic clear
    // cannot strand the run.
    setRail(r => ({ ...r, busy: true, questions: null, plan: null, storyboard: null, error: null }))
    setAnswers({})
    const err = await runStream(`/api/chat-hub/chats/${chatId}/approve`, {
      messageId: rail.pausedMessageId,
      approvals: [approval],
    })
    setAnswering(false)
    if (err) setRail(r => ({ ...r, busy: false, error: err }))
    void readChat(chatId)
  }

  /**
   * Write the brief from what is already on screen.
   *
   * A blank box in front of a production tool is a hard start, so this hands
   * the references, the output settings, the current draft and — once a film
   * exists — what was actually shot to a small Gemini call and lets it write
   * the brief. With text already in the box it EXPANDS that rather than
   * replacing it, which is the difference between a shortcut and a hijack.
   */
  const autofillBrief = async () => {
    if (autofilling) return
    setAutofilling(true)
    setRail(r => ({ ...r, error: null }))
    try {
      const res = await fetch("/api/employees/brief-autofill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: rail.chatId ?? undefined,
          draft: prompt,
          refs: refs.map(r => r.url),
          settings: { imgQuality, imgAspect, vidRes, vidAspect, runtime, audio },
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d?.prompt) {
        setRail(r => ({ ...r, error: String(d?.error || "Autofill failed") }))
        return
      }
      setPrompt(d.prompt)
      noteDraft(rail.chatId, d.prompt)
    } catch {
      setRail(r => ({ ...r, error: "Autofill could not reach the server" }))
    } finally {
      setAutofilling(false)
    }
  }

  /**
   * Pull a finished character out of Character Design and into this film.
   *
   * The board already holds the two things a film needs \u2014 a canon descriptor
   * written to be pasted verbatim, and images that prove the likeness \u2014 and
   * until now both died inside their own chat. Importing adds the master and
   * a few sheets as references, tags them all with the character's name so
   * they arrive as ONE person, and carries the descriptor through so the
   * employee does not have to re-derive it by looking.
   */
  const importCharacter = useCallback(async (m: {
    name: string; descriptor: string; master: string | null; images: string[]
  }) => {
    const urls = [m.master, ...m.images].filter((u): u is string => !!u)
    if (urls.length === 0) return
    const room = MAX_REFS - imageRefs.length
    const take = urls.slice(0, Math.max(0, Math.min(room, 4)))
    if (take.length === 0) return

    onUploadRefs(take.map(u => ({ id: u, url: u })))
    const next = { ...castRef.current }
    for (const u of take) next[u] = m.name
    castRef.current = next
    setCast(next)
    if (m.descriptor) setCastDescriptors(d => ({ ...d, [m.name]: m.descriptor }))
    setCastPicker(false)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieStudioCast: next }),
    }).catch(() => {})
  }, [imageRefs.length, onUploadRefs])

  /** Name (or rename) the character a reference belongs to. */
  const assignCast = useCallback((url: string, name: string) => {
    const clean = name.trim().slice(0, 40)
    const next = { ...castRef.current }
    if (clean) next[url] = clean
    else delete next[url]
    // Only keep entries for references that still exist, or the map grows
    // forever as the library churns.
    castRef.current = next
    setCast(next)
    setCastingRef(null)
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieStudioCast: next }),
    }).catch(() => {})
  }, [])

  /**
   * Reshoot ONE shot, by name, without disturbing the rest of the film.
   *
   * The film strip lets a user point at a stretch of time; this points at a
   * single take. It is the difference between "the middle is wrong" and "shot
   * 7 is wrong" \u2014 the second is what an editor actually says, and it is far
   * cheaper to act on.
   */
  const reshootShot = async (sh: Shot, note: string) => {
    const chatId = rail.chatId
    if (!chatId || !note.trim()) return
    setInspect(null)
    setInspectNote("")
    setRail(r => ({ ...r, busy: true, error: null, status: "Reshooting\u2026" }))
    const err = await runStream(`/api/chat-hub/chats/${chatId}/send`, {
      content:
        `[RESHOOT SHOT ${sh.index}]\n`
        + `Queue id ${sh.queueId}${sh.model ? `, shot on ${sh.model}` : ""}, ${sh.seconds}s.\n`
        + (sh.prompt ? `Its prompt was: "${sh.prompt.slice(0, 600)}"\n` : "")
        + `The user wants this changed: "${note.trim()}"\n\n`
        + `Render a REPLACEMENT for this one shot only. Keep the same characters, wardrobe, location, light, grade `
        + `and length so it still cuts against its neighbours \u2014 change only what was asked. Every other shot stays `
        + `exactly as it is; do not re-render any of them. When the new take lands, re-assemble the FULL film in `
        + `order with it in place of the original, and pass the original to assemble_film in "omitted" with the `
        + `reason "replaced by reshoot".`,
    })
    if (err) setRail(r => ({ ...r, busy: false, error: err }))
    void readChat(chatId)
  }

  /** Answer every outstanding permission request in one go. */
  /**
   * Hold the CURRENT stage in view.
   *
   * The rail lists five stages in a panel sized to a third of a portrait
   * column, so the list scrolls — and the one stage that must never be the
   * hidden one is the live one. React re-attaches this ref as `now` moves from
   * row to row, so each new stage pulls itself into view as it becomes current.
   */
  const activeStageRef = useCallback((el: HTMLDivElement | null) => {
    el?.scrollIntoView({ block: "nearest" })
  }, [])

  const respondAll = async (approved: boolean) => {
    if (!rail.chatId || rail.pausedMessageId === null || rail.approvals.length === 0 || answering) return
    const chatId = rail.chatId
    const calls = rail.approvals
    setAnswering(true)
    setRail(r => ({ ...r, busy: true, approvals: [], error: null }))
    const err = await runStream(`/api/chat-hub/chats/${chatId}/approve`, {
      messageId: rail.pausedMessageId,
      approvals: calls.map(c => ({ toolCallId: c.toolCallId, approved })),
    })
    setAnswering(false)
    if (err) setRail(r => ({ ...r, busy: false, error: err }))
    void readChat(chatId)
  }

  useEffect(() => { promptRef.current = prompt }, [prompt])
  useEffect(() => {
    if (!draftsLoadedRef.current) return
    const t = setTimeout(() => {
      fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // chatHubMovieFormat is the key the SERVER reads for the runtime
        // target, so writing it here is what makes assemble_film object to a
        // cut that comes in far short.
        body: JSON.stringify({
          movieStudioOutput: { imgQuality, imgAspect, vidRes, vidAspect },
          chatHubMovieFormat: runtime,
          chatHubAudioPlan: audio,
          movieStudioBudgetCap: Number(capTickets) || 0,
        }),
      }).catch(() => {})
    }, 700)
    return () => clearTimeout(t)
  }, [imgQuality, imgAspect, vidRes, vidAspect, runtime, audio, capTickets])
  // Selections are saved per film, debounced through the same writer.
  useEffect(() => {
    if (!draftsLoadedRef.current || !chatIdRef.current) return
    answersRef.current[String(chatIdRef.current)] = answers
    const t = setTimeout(() => {
      fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieStudioAnswers: answersRef.current }),
      }).catch(() => {})
    }, 700)
    return () => clearTimeout(t)
  }, [answers])
  useEffect(() => { chatIdRef.current = rail.chatId }, [rail.chatId])

  // Plan against reality. Recomputed only when one of them changes — the poll
  // ticks every six seconds and this walks every step of the run.
  const planRows = useMemo(() => matchPlan(planSteps, genPools), [planSteps, genPools])

  /**
   * What the run is waiting on, if anything.
   *
   * These used to seize the whole panel by priority, which meant Plan and
   * Activity both rendered the board while it was open \u2014 two tabs showing the
   * same thing. A blocking state is now its OWN tab: it takes focus when it
   * appears, and the other tabs keep showing what they are for.
   */
  const blocking: null | "questions" | "board" | "plan" | "approvals" =
    rail.questions ? "questions"
    : rail.storyboard ? "board"
    : rail.plan ? "plan"
    : rail.approvals.length > 0 ? "approvals"
    : null

  // Follow the production. Something needing an answer always wins; otherwise
  // activity while it works and the film when there is one. Skipped once the
  // user has chosen a tab for themselves \u2014 except for a new blocking state,
  // which is never something to leave off screen.
  const blockingRef = useRef<string | null>(null)
  useEffect(() => {
    if (blocking && blocking !== blockingRef.current) {
      blockingRef.current = blocking
      tabPinnedRef.current = false
      setPanelTab("now")
      return
    }
    if (!blocking) {
      blockingRef.current = null
      if (panelTab === "now") { tabPinnedRef.current = false; setPanelTab(rail.filmUrl ? "film" : "activity") }
    }
    if (tabPinnedRef.current || blocking) return
    if (rail.filmUrl && !rail.busy) setPanelTab("film")
    else if (rail.busy || pendingShots.length > 0) setPanelTab("activity")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocking, rail.filmUrl, rail.busy, pendingShots.length])

  const pickTab = useCallback((t: "now" | "film" | "plan" | "activity") => {
    tabPinnedRef.current = true
    setPanelTab(t)
  }, [])

  /**
   * The cut is only THE FILM when nothing is still moving.
   *
   * assemble_film can run while shots are still in the queue, and the result
   * is a real, playable file — just an incomplete one. Showing it the moment
   * it lands told the user the film was done while a third of it was still
   * rendering, and hid the questions the run was blocked on. So the video is
   * the last thing shown, never the first.
   */
  const filmReady =
    !!rail.filmUrl &&
    !rail.busy &&
    !staleCut &&
    pendingShots.length === 0 &&
    rail.approvals.length === 0 &&
    !rail.questions &&
    !rail.plan &&
    !rail.storyboard

  const started = rail.chatId !== null

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── films as tabs: each one is a row in the database, so a film is an
             ongoing project rather than whatever this browser tab remembers ── */}
      <div className="shrink-0 flex items-end gap-1 px-3 sm:px-4 pb-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {films.map(f => (
          <div
            key={f.id}
            className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-t-lg border-t border-x text-[11px] shrink-0 max-w-[190px] transition-colors ${
              rail.chatId === f.id
                ? "border-white/15 bg-white/[0.06] text-slate-100"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-slate-200"
            }`}
          >
            {renaming?.id === f.id ? (
              // Tap the title of the OPEN film to rename it in place — no
              // separate button, and Escape leaves the name untouched.
              <input
                autoFocus
                value={renaming.text}
                onChange={e => setRenaming({ id: f.id, text: e.target.value })}
                onBlur={() => void renameFilm(f.id, renaming.text)}
                onKeyDown={e => {
                  if (e.key === "Enter") void renameFilm(f.id, renaming.text)
                  if (e.key === "Escape") setRenaming(null)
                }}
                className="w-[150px] bg-black/50 border border-fuchsia-500/40 rounded px-1.5 py-0.5 text-[11px] text-slate-100 focus:outline-none"
              />
            ) : (
              <button
                onClick={() => {
                  if (rail.chatId !== f.id) openFilm(f.id)
                  else setRenaming({ id: f.id, text: f.title })
                }}
                title={rail.chatId === f.id ? "Tap to rename" : f.title}
                className="flex items-center gap-1.5 min-w-0"
              >
                {f.awaitingUser
                  ? <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" title="Waiting for you" />
                  : f.shotsSubmitted > f.shotsLanded
                    ? <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse shrink-0" title="Rendering" />
                    : f.filmUrl
                      ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Cut ready" />
                      : <span className="w-1.5 h-1.5 rounded-full bg-slate-600 shrink-0" />}
                <span className="truncate">{f.title}</span>
              </button>
            )}
            <button
              onClick={() => setConfirmClose(f.id)}
              title="Close this film"
              className="opacity-60 sm:opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded text-slate-500 hover:text-white transition-opacity"
            >
              <X size={10} />
            </button>
          </div>
        ))}
        {confirmClose !== null && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onClick={() => setConfirmClose(null)}>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <div
              className="relative w-full max-w-[340px] rounded-2xl border border-white/10 bg-[#0e0e18] p-4 overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <SilverRimOverlay />
              <div className="relative">
                <div className="text-sm font-bold text-slate-100 mb-1">
                  Close “{films.find(f => f.id === confirmClose)?.title ?? "this film"}”?
                </div>
                <p className="text-[11px] leading-relaxed text-slate-400 mb-3">
                  The production, its plan and its shot history are deleted. Every image and
                  video it made stays in your feed — only the film itself goes.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => void closeFilm(confirmClose)}
                    className="flex-1 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-red-200 text-[12px] font-semibold hover:bg-red-500/25 transition-colors"
                  >
                    Close film
                  </button>
                  <button
                    onClick={() => setConfirmClose(null)}
                    className="px-3 py-2 rounded-lg border border-white/10 text-slate-300 text-[12px] hover:bg-white/5 transition-colors"
                  >
                    Keep
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        <button
          onClick={() => void newFilm()}
          title="Start a new film"
          className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-t-lg border-t border-x border-white/[0.06] text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.04] transition-colors"
        >
          <Plus size={11} /> New
        </button>
      </div>

      {/* Who is this? \u2014 naming a reference is what turns a pile of thumbnails
          into a cast the employee can be told about. Existing names are
          offered first, because the value is in reusing them: two references
          under one name are the same person. */}
      {/* DAILIES. One take, on its own, with what was asked for and what it
          cost \u2014 and the one thing an editor actually wants to say about it,
          which is "do that again but different". Reshooting from here touches
          ONE shot; the film strip above is for marking stretches of time. */}
      {inspect !== null && (() => {
        const sh = timedShots.find(x => x.index === inspect)
        if (!sh) return null
        const t = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`
        return (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
            onClick={() => setInspect(null)}
          >
            <div
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0e0e18] p-4 shadow-2xl"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12px] font-bold text-slate-100">Shot {sh.index}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {t(sh.startSec)}–{t(sh.startSec + sh.seconds)} · {sh.seconds.toFixed(1)}s
                </span>
                <button
                  onClick={() => setInspect(null)}
                  className="ml-auto rounded p-1 text-slate-500 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>

              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                src={sh.url}
                controls
                playsInline
                preload="metadata"
                className="mb-3 w-full rounded-lg border border-white/10 bg-black"
              />

              <div className="mb-3 space-y-1 text-[10px]">
                <div className="flex gap-2">
                  <span className="w-16 shrink-0 uppercase tracking-wider text-slate-600">Model</span>
                  <span className="font-mono text-slate-300">{sh.model || "unknown"}</span>
                </div>
                <div className="flex gap-2">
                  <span className="w-16 shrink-0 uppercase tracking-wider text-slate-600">Queue</span>
                  <span className="font-mono text-slate-500">{sh.queueId}</span>
                </div>
                {sh.prompt && (
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 uppercase tracking-wider text-slate-600">Prompt</span>
                    <span className="leading-snug text-slate-400">{sh.prompt.slice(0, 400)}</span>
                  </div>
                )}
              </div>

              <input
                value={inspectNote}
                onChange={e => setInspectNote(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && inspectNote.trim()) void reshootShot(sh, inspectNote) }}
                placeholder="What should change in this take?"
                className="mb-2 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500/40 focus:outline-none"
              />

              <div className="flex gap-2">
                <button
                  onClick={() => void reshootShot(sh, inspectNote)}
                  disabled={!inspectNote.trim() || rail.busy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/25 bg-white/10 py-2 text-[12px] font-bold text-white transition-all hover:bg-white/15 disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-600"
                >
                  <RefreshCw size={12} /> Reshoot this shot
                </button>
                <a
                  href={sh.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/10 px-3 py-2 text-[12px] text-slate-400 transition-colors hover:bg-white/5"
                >
                  Open
                </a>
              </div>
              <p className="mt-2 text-[9px] leading-snug text-slate-600">
                Only this take is re-rendered. Everything else in the cut stays as it is.
              </p>
            </div>
          </div>
        )
      })()}

      {/* CASTING FROM THE OTHER EMPLOYEE. A Character Design board holds a
          locked design and a canon descriptor; without this they only ever
          existed inside that chat, and every film started by re-deriving the
          same character from a pile of thumbnails. */}
      {castPicker && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4"
          onClick={() => setCastPicker(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0e0e18] p-4 shadow-2xl"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[12px] font-bold text-slate-100">Cast a character</span>
              <button
                onClick={() => setCastPicker(false)}
                className="ml-auto rounded p-1 text-slate-500 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
            <p className="mb-3 text-[10px] leading-snug text-slate-500">
              From Character Design. Brings in the master plus a few sheets, already tagged as one person,
              with the canon descriptor attached.
            </p>

            {castPool.length === 0 ? (
              <div className="py-6 text-center text-[11px] leading-snug text-slate-600">
                No finished characters yet.<br />
                Build one in Character Design and it appears here.
              </div>
            ) : (
              <div className="space-y-2">
                {castPool.map(m => (
                  <button
                    key={m.chatId}
                    onClick={() => void importCharacter(m)}
                    disabled={imageRefs.length >= MAX_REFS}
                    className="flex w-full items-start gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-2 text-left transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/[0.06] disabled:opacity-40"
                  >
                    {m.master ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.master} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-white/10 object-cover" />
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/10 text-[9px] text-slate-600">
                        no art
                      </div>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-semibold text-slate-100">{m.name}</span>
                      {m.descriptor ? (
                        <span className="mt-0.5 block text-[10px] leading-snug text-slate-500 line-clamp-3">
                          {m.descriptor}
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-[10px] text-amber-400/70">
                          No descriptor saved — the film will have to work from the pictures alone.
                        </span>
                      )}
                      <span className="mt-0.5 block font-mono text-[9px] text-slate-600">
                        {1 + m.images.length} image{m.images.length === 0 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {imageRefs.length >= MAX_REFS && (
              <p className="mt-2 text-[10px] text-amber-300/80">
                Reference slots are full — remove some before casting anyone else.
              </p>
            )}
          </div>
        </div>
      )}

      {castingRef && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setCastingRef(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-xs rounded-2xl border border-white/15 bg-[#0e0e18] p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={castingRef} alt="" className="h-12 w-12 rounded-lg border border-white/10 object-cover" />
              <div className="min-w-0">
                <div className="text-[12px] font-bold text-slate-100">Who is this?</div>
                <div className="text-[10px] leading-snug text-slate-500">
                  Group references by character so they are cast together.
                </div>
              </div>
            </div>

            {castGroups.named.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {castGroups.named.map(([n]) => (
                  <button
                    key={n}
                    onClick={() => { setCastDraft(n); assignCast(castingRef, n) }}
                    className="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-500/20"
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}

            <input
              autoFocus
              value={castDraft}
              onChange={e => setCastDraft(e.target.value)}
              placeholder="A name, or a role like 'the barn'"
              onKeyDown={e => {
                if (e.key === "Enter") assignCast(castingRef, castDraft)
                if (e.key === "Escape") setCastingRef(null)
              }}
              className="mb-3 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-cyan-500/40 focus:outline-none"
            />

            <div className="flex gap-2">
              <button
                onClick={() => assignCast(castingRef, castDraft)}
                className="flex-1 rounded-lg border border-white/25 bg-white/10 py-2 text-[12px] font-bold text-white transition-all hover:bg-white/15"
              >
                Save
              </button>
              {cast[castingRef] && (
                <button
                  onClick={() => assignCast(castingRef, "")}
                  className="rounded-lg border border-white/10 px-3 py-2 text-[12px] text-slate-400 transition-colors hover:bg-white/5"
                >
                  Unassign
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    <div className="flex-1 flex flex-col gap-3 min-h-0 px-3 sm:px-4 pb-4">
      {/* Top band: the controls and the cut.
          LANDSCAPE  \u2014 controls on the left, the cut filling the rest.
          PORTRAIT   \u2014 the cut on top at full width, controls in a wide band
                       under it, because a tall narrow screen has no room for a
                       side rail and the film is what the user is looking at. */}
      <div className="flex flex-col landscape:flex-row gap-3 min-h-0 flex-1 overflow-hidden">
      {/* ── left rail ─────────────────────────────────────────────────────── */}
      <div className="w-full landscape:w-[320px] shrink-0 flex flex-col portrait:flex-row gap-3 min-h-0 order-2 landscape:order-1 portrait:h-[200px]">
        <div className="relative flex flex-col min-h-0 flex-1 portrait:basis-1/2 rounded-2xl silver-edge p-3 portrait:p-2 overflow-hidden">
          <div className="relative flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              References
            </span>
            <button
              onClick={() => {
                setCastPicker(true)
                fetch("/api/employees/cast")
                  .then(r => (r.ok ? r.json() : null))
                  .then(d => setCastPool(Array.isArray(d?.cast) ? d.cast : []))
                  .catch(() => setCastPool([]))
              }}
              title="Cast a character built in Character Design"
              className="rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
            >
              Cast
            </button>
            <span className="text-[10px] text-slate-500">
              {imageRefs.length}/{MAX_REFS} img
              {videoRefs.length > 0 && (
                <span className="text-fuchsia-300/80"> · {videoRefs.length}/{MAX_VIDEO_REFS} vid</span>
              )}
            </span>
          </div>
          {/* Grouped by WHO, not by upload order. A named group is a cast
              member the employee can be told about; everything else is
              locations, props and people the user has not identified yet. */}
          <div className="relative flex-1 min-h-0 overflow-y-auto content-start">
            {castGroups.named.map(([name, items]) => (
              <div key={name} className="mb-2">
                <button
                  onClick={() => { setCastDraft(name); setCastingRef(items[0].url) }}
                  className="flex items-center gap-1 mb-1 text-[9px] font-semibold uppercase tracking-wider text-cyan-300/80 hover:text-cyan-200"
                  title="Rename this character"
                >
                  {name}
                  <span className="font-mono normal-case tracking-normal text-slate-600">{items.length}</span>
                </button>
                <div className="flex flex-wrap gap-1.5">
                  {items.map(r => (
                    <RefTile
                      key={r.id}
                      item={r}
                      name={cast[r.url]}
                      onEdit={() => onEditRef(r.id, r.url)}
                      onRemove={() => onRemoveRef(r.id)}
                      onCast={() => { setCastDraft(cast[r.url] ?? ""); setCastingRef(r.url) }}
              />
                  ))}
                </div>
              </div>
            ))}

            {castGroups.loose.length > 0 && castGroups.named.length > 0 && (
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-600">
                Unassigned
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {castGroups.loose.map(r => (
              <RefTile
                key={r.id}
                item={r}
                name={cast[r.url]}
                onEdit={() => onEditRef(r.id, r.url)}
                onRemove={() => onRemoveRef(r.id)}
                onCast={() => { setCastDraft(cast[r.url] ?? ""); setCastingRef(r.url) }}
              />
              ))}
              {videoRefs.map(r => (
              <RefTile
                key={r.id}
                item={r}
                name={cast[r.url]}
                onEdit={() => onEditRef(r.id, r.url)}
                onRemove={() => onRemoveRef(r.id)}
                onCast={() => { setCastDraft(cast[r.url] ?? ""); setCastingRef(r.url) }}
              />
              ))}
            {(imageRefs.length < MAX_REFS || videoRefs.length < MAX_VIDEO_REFS) && (
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="w-[62px] h-[62px] portrait:w-[52px] portrait:h-[52px] shrink-0 rounded-lg border border-dashed border-white/15 text-slate-500 hover:text-white hover:border-white/30 flex items-center justify-center transition-colors"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              </button>
            )}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={e => { void addFiles([...(e.target.files ?? [])]); e.currentTarget.value = "" }}
          />
        </div>

        {/* In landscape this panel sizes to its CONTENT (flex-none) instead
            of splitting the column three ways with the references and the
            status — competing for a third of the height is what pushed
            the button past the panel edge. Portrait keeps its half-row. */}
        <div className="relative flex flex-col min-h-0 landscape:flex-none flex-1 portrait:basis-1/2 rounded-2xl silver-edge p-3 portrait:p-2 overflow-hidden">
          <div className="relative shrink-0 flex items-center gap-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {rail.filmUrl ? "The edit" : "The brief"}
            </span>
            {sections.length > 0 && (
              <span className="rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-mono text-fuchsia-200">
                {sections.length} section{sections.length === 1 ? "" : "s"}
              </span>
            )}
            {/* Writes the brief from the references, the settings and whatever
                is already typed. Disabled while a run owns the box, for the
                same reason the box itself is. */}
            <button
              onClick={() => void autofillBrief()}
              disabled={autofilling || (rail.hasRun && !filmReady) || !signedIn}
              title={
                (rail.hasRun && !filmReady) ? "Wait for the cut before writing a change"
                : prompt.trim() ? "Expand what you have written into a full brief"
                : "Write a brief from your references and settings"
              }
              className={`ml-auto flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                autofilling || (rail.hasRun && !filmReady) || !signedIn
                  ? "border-white/10 text-slate-600 cursor-not-allowed"
                  : "border-white/15 text-slate-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200"
              }`}
            >
              {autofilling
                ? <Loader2 size={9} className="animate-spin" />
                : <Wand2 size={9} />}
              {autofilling ? "Writing" : prompt.trim() ? "Expand" : "Auto"}
            </button>
          </div>
          {/* Scrollable middle: whatever the panel height, the button below
              stays reachable instead of being pushed out of the card. */}
          <div className="relative flex-1 min-h-0 flex flex-col overflow-y-auto">
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); noteDraft(rail.chatId, e.target.value) }}
            disabled={rail.hasRun && !filmReady}
            placeholder={
              !rail.hasRun ? "A short film starring the characters in my references…"
              : filmReady && sections.length > 0
                ? "What should change in the marked sections?"
              : filmReady ? "Ask for a change — or mark sections on the strip and say what to do with them…"
              : "Your film is being made — you can ask for changes once it is cut."
            }
            className="relative w-full shrink-0 h-[52px] landscape:h-[72px] rounded-lg bg-black/40 border border-white/10 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 resize-none focus:outline-none focus:border-fuchsia-500/40 disabled:opacity-60"
          />
          {/* Once a film exists these are the WRONG controls: quality and
              aspect are settled by the footage already shot, and changing the
              runtime mid-edit would invalidate the cut. So edit mode gets its
              own controls, and the fixed specs are shown rather than offered. */}
          {rail.filmUrl ? (
            <div className="relative shrink-0 mt-2 space-y-1.5">
              <div className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/20 px-2 py-1">
                <span className="text-[9px] uppercase tracking-wider text-slate-600">Locked</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {vidRes} · {vidAspect} · {imgQuality.toUpperCase()} stills
                </span>
                <span className="ml-auto text-[9px] text-slate-600">
                  {atCeiling ? `${Math.round(filmSeconds)}s · at the limit` : "matches the cut"}
                </span>
              </div>

              <div className="grid grid-cols-[auto_1fr] gap-x-1.5 gap-y-1.5 items-center">
                <span className="text-[9px] uppercase tracking-wider text-slate-500">Longer</span>
                <Dropdown
                  className="w-full"
                  value={extendBy}
                  onChange={setExtendBy}
                  // Only lengths the pipeline can actually deliver: one
                  // assemble tops out around two minutes, so offering "+30s"
                  // on a 110-second film would promise a cut that cannot be
                  // built.
                  options={[
                    { value: "0", label: atCeiling ? "At the length limit" : "Keep the length" },
                    ...[5, 10, 20, 30]
                      .filter(n => filmSeconds + n <= MAX_FILM_SECONDS)
                      .map(n => ({ value: String(n), label: `Extend by ~${n}s` })),
                  ]}
                />

                <span className="text-[9px] uppercase tracking-wider text-slate-500">Sound</span>
                <Dropdown
                  className="w-full"
                  value={editSound}
                  onChange={setEditSound}
                  options={[
                    { value: "keep", label: "Keep the current sound" },
                    { value: "rescore", label: "New music bed" },
                    { value: "narration", label: "Add narration" },
                    { value: "silent", label: "Strip the sound" },
                  ]}
                />
              </div>
            </div>
          ) : (
          /* Output settings, on the site's own dropdown rather than a native
             <select> \u2014 iOS answers those with a full-screen system picker
             that covers the panel and matches nothing around it. */
          <div className="relative shrink-0 grid grid-cols-[auto_1fr_1fr] gap-x-1.5 gap-y-1.5 mt-2 items-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">Img</span>
            <Dropdown
              className="w-full"
              value={imgQuality}
              disabled={rail.hasRun}
              onChange={setImgQuality}
              options={[{ value: "2k", label: "2K" }, { value: "4k", label: "4K" }]}
            />
            <Dropdown
              className="w-full"
              value={imgAspect}
              disabled={rail.hasRun}
              onChange={setImgAspect}
              options={["16:9", "9:16", "21:9", "4:3", "1:1", "4:5"].map(a => ({ value: a, label: a }))}
            />

            <span className="text-[9px] uppercase tracking-wider text-slate-500">Vid</span>
            <Dropdown
              className="w-full"
              value={vidRes}
              disabled={rail.hasRun}
              onChange={setVidRes}
              options={["480p", "720p", "1080p"].map(r => ({ value: r, label: r }))}
            />
            <Dropdown
              className="w-full"
              value={vidAspect}
              disabled={rail.hasRun}
              onChange={setVidAspect}
              options={["16:9", "9:16", "21:9", "4:3", "1:1", "9:21"].map(a => ({ value: a, label: a }))}
            />

            <span className="text-[9px] uppercase tracking-wider text-slate-500">Max</span>
            <div className="col-span-2 flex items-center gap-1.5">
              <input
                value={capTickets}
                disabled={rail.hasRun}
                onChange={e => setCapTickets(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                placeholder="no limit"
                inputMode="numeric"
                className="w-[74px] rounded-md border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-[10px] text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500/40 focus:outline-none disabled:text-slate-600"
              />
              <span className="text-[9px] text-slate-600">tickets max</span>
            </div>

            <span className="text-[9px] uppercase tracking-wider text-slate-500">Snd</span>
            <div className="col-span-2 flex">
              <Dropdown
                className="flex-1 min-w-0"
                value={audio}
                disabled={rail.hasRun}
                onChange={setAudio}
                options={AUDIO_PLANS.map(a => ({ value: a.id, label: `${a.label} · ${a.note}` }))}
              />
            </div>

            <span className="text-[9px] uppercase tracking-wider text-slate-500">Cut</span>
            <div className="col-span-2 flex">
              <Dropdown
                className="flex-1 min-w-0"
                value={runtime}
                disabled={rail.hasRun}
                onChange={setRuntime}
                options={MOVIE_FORMATS.filter(f => f.id !== "ask").map(f => ({
                  value: f.id,
                  // A real interpunct, not an escape sequence: the old text
                  // rendered the characters "\u00b7" literally in the menu.
                  label: `${f.label} · ${f.seconds}`,
                }))}
              />
            </div>
          </div>
          )}

          </div>

          {(() => {
            // The button reflects the PRODUCTION, not just the text box.
            // It used to flip to "Send" the instant a run began and stay
            // clickable, so the film could be told to do something else while
            // it was still shooting. Now: one job at a time.
            const filmDone = filmReady
            const awaitingUser = !!rail.questions || !!rail.plan || !!rail.storyboard || rail.approvals.length > 0
            const working = rail.busy || pendingShots.length > 0 || awaitingUser
            // Editing is only offered once there is a cut to edit.
            const canSubmit = !!prompt.trim() && signedIn && !working && (!rail.hasRun || filmDone)
            const label =
              !rail.hasRun ? "Create the film"
              : awaitingUser
                ? rail.questions ? "Answer above to continue"
                  : rail.plan ? "Approve the plan above"
                  : "Answer the request above"
              : working ? "Making your film…"
              : filmDone
                ? sections.length > 0
                  ? `Reshoot ${sections.length} section${sections.length === 1 ? "" : "s"}`
                  : "Send a change"
              : "Picking up where it left off…"
            return (
              <button
                onClick={() => void (rail.hasRun ? followUp() : start())}
                disabled={!canSubmit}
                title={working ? "The film is still being made" : undefined}
                className={`relative shrink-0 overflow-hidden mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-bold transition-all ${
                  canSubmit
                    ? "bg-white/10 border border-white/25 text-white hover:bg-white/15 hover:border-white/40"
                    : "bg-white/5 text-slate-600 cursor-not-allowed border border-white/10"
                }`}
              >
                {canSubmit && (
                  <span
                    className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent pointer-events-none"
                    style={{ animation: "sheen-sweep 2.6s infinite" }}
                  />
                )}
                {working
                  ? <span className="w-3 h-3 rounded-full border-2 border-white/25 border-t-slate-400 animate-spin" />
                  : <SiteLogoBox size={14} rounded={4} />}
                {label}
              </button>
            )
          })()}
        </div>

        {/* status rail — the whole conversation, compressed */}
        {started && (() => {
          // The panel is a tall box, so it shows the PRODUCTION, not one line of
          // text floating at the top. Five stages, where we are in them, and
          // what is expected of the user right now.
          const waiting = !!(rail.questions || rail.plan || rail.storyboard) || rail.approvals.length > 0
          const landed = shots.length
          const submitted = shots.length // settled shots are all we can count here

          // Which stage the film is in. Deliberately derived from real state
          // rather than a status string, so it cannot disagree with the screen.
          // Four stages, each defined by something that EXISTS rather than by
          // what the run happens to be doing. The old version put "busy with no
          // question pending" at Shoot, so pressing Create jumped straight past
          // Brief and Plan, then walked BACKWARDS when the questions arrived.
          // Planning is one phase from the user's side: questions, budget and
          // the plates all happen before a single shot exists.
          // Shooting begins when the shots are SUBMITTED. Waiting for one to
          // come back left the panel on "Plan" while eleven shots rendered.
          // A finished film moves PAST the cut, it does not sit on it. Leaving
          // the pointer on Cut drew that stage as still-in-progress under a
          // headline that said the film was ready — so the last production
          // stage ticks green and the ball is handed back to the user.
          // Six phases now. The board sits between planning and shooting
          // because that is literally where the money gate is, and leaving it
          // off the rail was why the run felt out of order: plates rendered
          // under a "Plan" heading, then a board appeared from nowhere.
          const stage =
            filmReady ? 5
            : (landed > 0 && pendingShots.length === 0) || rail.filmUrl ? 4
            : landed > 0 || pendingShots.length > 0 ? 3
            // Plates rendering, or a board waiting: the film exists as stills.
            : rail.storyboard || pendingPlates.length > 0 || Object.keys(plateUrls).length > 0 ? 2
            : rail.hasRun ? 1
            : 0
          // Production never regresses: a stage that has been reached stays
          // reached, so a later question cannot un-tick earlier work. "Your
          // turn" is NOT production though — it is the film sitting finished —
          // so it is excluded from the high-water mark. Without that, asking
          // for a change left the rail claiming it was the user's turn while
          // the studio was busy re-shooting.
          const prod = Math.min(stage, 4)
          if (prod > stageHighRef.current) stageHighRef.current = prod
          const shown = stage === 5 ? 5 : Math.max(prod, stageHighRef.current)
          const STAGES = [
            { key: "brief", label: "Brief", hint: "references and the idea" },
            { key: "plan", label: "Plan", hint: "story, questions and the budget" },
            { key: "board", label: "Board", hint: "the film as stills, before it costs video" },
            { key: "shoot", label: "Shoot", hint: "shots render on the server" },
            { key: "cut", label: "Cut", hint: "assembled and scored" },
            // Not a production stage — the film is done and it is the user's
            // move. Films here are meant to be edited over and over, so the
            // rail ends on their turn rather than on a finished ticklist.
            { key: "edit", label: "Your turn", hint: "ask for a change and it re-cuts" },
          ]

          // A finished film outranks every other reading here. The rail used to
          // fall through to the last step's label and announce "Shooting the
          // film" over a cut that was playing directly beneath it.
          const head = filmReady ? "Your film is ready"
            : rail.questions ? "Your turn"
            : rail.storyboard ? "The board is ready"
            : rail.plan ? "Plan ready"
            : rail.approvals.length > 0 ? "Needs your go-ahead"
            : rail.busy ? (rail.status || "Working")
            : rail.hasRun ? (rail.status || "Standing by")
            : "Ready when you are"
          const sub = filmReady ? "watch it, then ask for a change"
            : rail.questions ? "answer above"
            : rail.storyboard ? "check the shots before they are shot"
            : rail.plan ? "approve above to start shooting"
            : rail.approvals.length > 0 ? "answer above to continue"
            : rail.busy ? "keeps running if you leave"
            : rail.hasRun ? "nothing running"
            : "add refs, describe it, press Create"

          return (
            <div className="relative flex-1 portrait:basis-1/3 min-h-0 rounded-2xl silver-edge overflow-hidden">
              <div className="relative h-full flex flex-col p-3">
                {/* headline */}
                <div className="flex items-start gap-2 shrink-0">
                  <span className="relative mt-0.5 flex items-center justify-center w-4 h-4 shrink-0">
                    {rail.busy ? (
                      <>
                        <span className="absolute inset-0 rounded-full bg-fuchsia-500/25 animate-ping" />
                        <Loader2 size={13} className="relative text-fuchsia-300 animate-spin" />
                      </>
                    ) : waiting ? (
                      <>
                        <span className="absolute inset-0 rounded-full bg-cyan-500/25 animate-pulse" />
                        <span className="relative w-1.5 h-1.5 rounded-full bg-cyan-300" />
                      </>
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className={`text-[12px] font-bold leading-tight ${
                      rail.busy ? "text-fuchsia-100" : waiting ? "text-cyan-100" : "text-slate-300"
                    }`}>{head}</div>
                    <div className="text-[10px] leading-snug text-slate-500">{sub}</div>
                  </div>
                  {/* THE METER. The plan states a budget and nothing used to
                      report against it, so the first sight of the real number
                      was the ticket balance. Over budget goes amber rather
                      than red: overspending is information, not an error. */}
                  {spent.tickets > 0 && (
                    <div className="ml-auto shrink-0 text-right">
                      <div className={`font-mono text-[11px] leading-none ${
                        budget > 0 && spent.tickets > budget ? "text-amber-300" : "text-slate-300"
                      }`}>
                        {spent.tickets}{budget > 0 ? `/${budget}` : ""}
                      </div>
                      <div className="text-[9px] leading-snug text-slate-600">
                        tickets{spent.jobs ? ` \u00b7 ${spent.jobs}` : ""}
                      </div>
                    </div>
                  )}
                </div>

                {/* the pipeline — fills the box and says where the film is */}
                <div className="flex-1 min-h-0 overflow-y-auto mt-3">
                  {STAGES.map((st, i) => {
                    const done = i < shown
                    const now = i === shown
                    return (
                      <div
                        key={st.key}
                        // Portrait lists every stage; landscape has no vertical
                        // room for it, so only the CURRENT stage is shown and it
                        // advances as the film does.
                        ref={now ? activeStageRef : undefined}
                        className={`relative flex gap-2.5 pb-1.5 last:pb-0 landscape:justify-center landscape:pb-0 ${now ? "" : "landscape:hidden"}`}
                      >
                        {/* rail + node */}
                        <div className="relative flex flex-col items-center shrink-0 w-3">
                          <span className={`w-3 h-3 landscape:w-4 landscape:h-4 rounded-full border flex items-center justify-center shrink-0 ${
                            done ? "border-emerald-400/50 bg-emerald-400/20"
                            : now ? "border-cyan-300/70 bg-cyan-400/20"
                            : "border-white/15"
                          }`}>
                            {done
                              ? <Check size={7} className="text-emerald-300" />
                              : now && <span className="w-1 h-1 rounded-full bg-cyan-300 animate-pulse" />}
                          </span>
                          {i < STAGES.length - 1 && (
                            <span className={`w-px flex-1 min-h-[6px] mt-0.5 landscape:hidden ${done ? "bg-emerald-400/25" : "bg-white/10"}`} />
                          )}
                        </div>
                        <div className="min-w-0 -mt-0.5">
                          <div className={`text-[11px] landscape:text-[14px] font-semibold leading-tight ${
                            now ? "text-slate-100" : done ? "text-slate-400" : "text-slate-600"
                          }`}>
                            {st.label}
                            <span className="hidden landscape:inline ml-1.5 font-normal text-[10px] text-slate-600">
                              step {i + 1} of {STAGES.length}
                            </span>
                            {st.key === "board" && pendingPlates.length > 0 && (
                              <span className="ml-1.5 font-normal text-[10px] text-slate-500">
                                {pendingPlates.length} plate{pendingPlates.length === 1 ? "" : "s"} rendering
                              </span>
                            )}
                            {st.key === "shoot" && (landed > 0 || pendingShots.length > 0) && (
                              <span className="ml-1.5 font-normal text-[10px] text-slate-500">
                                {landed}/{landed + pendingShots.length} in
                              </span>
                            )}
                          </div>
                          {now && <div className="text-[9.5px] landscape:text-[11px] leading-snug text-slate-500 landscape:mt-0.5">{st.hint}</div>}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {rail.error && (
                  <div className="shrink-0 mt-2 rounded-lg border border-red-500/25 bg-red-500/[0.08] px-2 py-1.5 text-[10px] leading-snug text-red-200">
                    {rail.error}
                  </div>
                )}
              </div>
            </div>
          )
        })()}
      </div>

      {/* ── the finished cut ─────────────────────────────────────────────── */}
      {/* The card SIZES ITSELF to the column instead of asking for a fixed
          40vh stage. The fixed height made it taller than its slot, which
          first clipped the bottom edge and then — once the column scrolled —
          meant the film could not be seen all at once. Header and strip take
          what they need, the stage takes the rest, and it always fits. */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0 overflow-hidden order-1 landscape:order-2">
        <div className="relative flex-1 min-h-0 flex flex-col rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
          <SilverRimOverlay />
          <div className="shrink-0 px-2 py-1.5 border-b border-white/5 flex items-center gap-1">
            <Clapperboard size={12} className="text-fuchsia-400 shrink-0 ml-1 mr-1" />
            {([
              ...(blocking ? [{
                id: "now" as const,
                label: blocking === "questions" ? "Questions"
                  : blocking === "board" ? "Board"
                  : blocking === "plan" ? "Plan?"
                  : "Approve",
                icon: HelpCircle,
                badge: "you",
              }] : []),
              { id: "film" as const, label: "Film", icon: Clapperboard, badge: filmReady ? "ready" : "" },
              { id: "plan" as const, label: "Plan", icon: ListChecks,
                badge: planRows.length ? `${planRows.filter(r => r.state === "done").length}/${planRows.length}` : "" },
              { id: "activity" as const, label: "Activity", icon: Loader2,
                badge: rail.busy ? "live" : "" },
            ]).map(t => {
              const on = panelTab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => pickTab(t.id)}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                    on ? "bg-white/10 text-slate-100" : "text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]"
                  }`}
                >
                  {t.label}
                  {t.badge && (
                    <span className={`rounded px-1 text-[8px] font-mono normal-case tracking-normal ${
                      t.badge === "you" ? "bg-cyan-500/25 text-cyan-100"
                      : t.badge === "live" ? "bg-fuchsia-500/20 text-fuchsia-200"
                      : t.badge === "ready" ? "bg-emerald-500/20 text-emerald-200"
                      : "bg-white/10 text-slate-400"
                    }`}>{t.badge}</span>
                  )}
                </button>
              )
            })}
          </div>
          {/* THE STAGE. One place to look: the employee asks here, the plan is
              approved here, progress reports here, and the finished cut plays
              here. A question that appears anywhere else gets missed. */}
          <div className="relative flex-1 min-h-0 flex items-center justify-center bg-black overflow-y-auto">
            {panelTab === "now" && rail.questions ? (() => {
              const qs = rail.questions.questions
              const i = Math.min(qIndex, qs.length - 1)
              const q = qs[i]
              const last = i === qs.length - 1
              const answeredAll = qs.every((qq, n) => answers[n] !== undefined || (custom[n] ?? '').trim().length > 0)
              return (
                <div className="w-full max-w-xl px-5 py-5">
                  <div className="flex items-center gap-2 mb-4">
                    <HelpCircle size={14} className="text-cyan-400 shrink-0" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300/90">
                      Before we shoot
                    </span>
                    {/* Dots, so the length of the interview is never a surprise */}
                    <span className="ml-auto flex items-center gap-1">
                      {qs.map((_, n) => (
                        <button
                          key={n}
                          onClick={() => setQIndex(n)}
                          title={`Question ${n + 1}`}
                          className={`h-1.5 rounded-full transition-all ${
                            n === i ? "w-4 bg-cyan-400"
                            : answers[n] !== undefined || (custom[n] ?? "").trim() ? "w-1.5 bg-cyan-500/50"
                            : "w-1.5 bg-white/15"
                          }`}
                        />
                      ))}
                    </span>
                  </div>

                  <div className="text-[15px] leading-snug text-slate-100 font-semibold mb-3">{q.question}</div>

                  <div className="flex flex-col gap-1.5 mb-4">
                    {(q.options ?? []).map((opt, oi) => (
                      <button
                        key={oi}
                        onClick={() => {
                          setAnswers(a => ({ ...a, [i]: oi }))
                          // Move on by itself — the tap already said "this one"
                          if (!last) setTimeout(() => setQIndex(n => n + 1), 160)
                        }}
                        className={`group text-left px-3 py-2.5 rounded-xl border text-[12px] leading-snug transition-all ${
                          answers[i] === oi
                            ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-50"
                            : "border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/25 hover:bg-white/[0.05]"
                        }`}
                      >
                        <span className="flex items-start gap-2.5">
                          <span className={`mt-[3px] w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center ${
                            answers[i] === oi ? "border-cyan-400 bg-cyan-400/20" : "border-white/20"
                          }`}>
                            {answers[i] === oi && <span className="w-1.5 h-1.5 rounded-full bg-cyan-300" />}
                          </span>
                          <span>{opt}</span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Their own words. Anything typed here wins over the
                      options, so a suggestion the employee did not offer is
                      still a valid answer. */}
                  <input
                    value={custom[i] ?? ""}
                    onChange={e => setCustom(c => ({ ...c, [i]: e.target.value }))}
                    placeholder="Or write your own…"
                    className={`w-full mb-4 rounded-xl bg-black/40 border px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none transition-colors ${
                      (custom[i] ?? "").trim()
                        ? "border-cyan-400/50"
                        : "border-white/10 focus:border-white/25"
                    }`}
                  />

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQIndex(n => Math.max(0, n - 1))}
                      disabled={i === 0}
                      className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      title="Previous question"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] text-slate-500">{i + 1} of {qs.length}</span>
                    {last ? (
                      <button
                        onClick={() => {
                          const replies = qs.map((qq, qi) => ({
                            question: qq.question,
                            answer: answerFor(qq, qi),
                          }))
                          // If one of the questions was the film's NAME, that
                          // answer is the film's name — the tab should not keep
                          // an auto-generated title the user just overruled.
                          const titled = replies.find(r => /\b(title|name)\b/i.test(r.question))
                          // "Name it after I have seen it" is a DEFERRAL, not
                          // a title — renaming the film to that sentence would
                          // be the exact opposite of what was asked for.
                          const deferred = /(later|after|not yet|once |decide)/i.test(titled?.answer ?? "")
                          const clean = (titled?.answer ?? "").replace(/^["'“‘]|["'”’]$/g, "").trim()
                          if (clean && !deferred && clean.length <= 80 && rail.chatId) {
                            void renameFilm(rail.chatId, clean)
                          }
                          setCustom({})
                          void respond({
                            toolCallId: rail.questions!.toolCallId,
                            approved: true,
                            answers: replies,
                          })
                        }}
                        disabled={!answeredAll || answering}
                        className="ml-auto px-4 py-2 rounded-lg bg-white/10 border border-white/25 text-white text-[12px] font-bold hover:bg-white/15 hover:border-white/40 disabled:bg-white/5 disabled:text-slate-600 disabled:border-white/10 transition-all"
                        title={answeredAll ? undefined : "Answer every question first"}
                      >
                        Start the film
                      </button>
                    ) : (
                      <button
                        onClick={() => setQIndex(n => Math.min(qs.length - 1, n + 1))}
                        className="ml-auto p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
                        title="Next question"
                      >
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })() : panelTab === "now" && rail.plan ? (() => {
              const steps = rail.plan.steps
              // Steps that spend a model are the ones worth counting; the rest
              // are checks and assembly.
              const gens = steps.filter(t => /\b(shot|render|generat|plate|image|video|frame)\b/i.test(t)).length
              return (
                <div className="w-full h-full overflow-y-auto px-5 py-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Clapperboard size={14} className="text-amber-300 shrink-0" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/90">
                      The plan
                    </span>
                    <span className="ml-auto text-[11px] font-mono text-amber-200/90">
                      {rail.plan.tickets} tickets
                    </span>
                  </div>

                  {rail.plan.summary && (
                    <p className="text-[12px] leading-snug text-slate-200 mb-3">{rail.plan.summary}</p>
                  )}

                  {/* what it is actually going to do */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 text-[10px] text-slate-500">
                    <span>{steps.length} step{steps.length === 1 ? "" : "s"}</span>
                    {gens > 0 && <span>{gens} generation{gens === 1 ? "" : "s"}</span>}
                    <span>{planRes.toUpperCase()} · {planAspect}</span>
                  </div>

                  {steps.length > 0 && (() => {
                    // Edited copy if the user has touched it, the studio's own
                    // list otherwise.
                    const live = planEdits ?? steps
                    const setLine = (n: number, v: string) =>
                      setPlanEdits(live.map((x, i) => (i === n ? v : x)))
                    const drop = (n: number) => setPlanEdits(live.filter((_, i) => i !== n))
                    const move = (n: number, d: -1 | 1) => {
                      const to = n + d
                      if (to < 0 || to >= live.length) return
                      const next = [...live]
                      ;[next[n], next[to]] = [next[to], next[n]]
                      setPlanEdits(next)
                    }
                    return (
                      <div className="mb-3">
                        {live.map((t, n) => (
                          <div key={n} className="group flex items-start gap-1 mb-1">
                            <span className="shrink-0 w-4 pt-1 text-right font-mono text-[11px] text-slate-600">{n + 1}</span>
                            <textarea
                              value={t}
                              rows={1}
                              onChange={e => setLine(n, e.target.value)}
                              onInput={e => {
                                const el = e.currentTarget
                                el.style.height = "auto"
                                el.style.height = el.scrollHeight + "px"
                              }}
                              className="flex-1 resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] leading-snug text-slate-300 hover:border-white/10 focus:border-amber-500/40 focus:bg-black/30 focus:text-slate-100 focus:outline-none"
                            />
                            <span className="flex shrink-0 gap-0.5 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <button onClick={() => move(n, -1)} disabled={n === 0}
                                className="rounded p-0.5 text-slate-600 hover:text-white disabled:opacity-25" title="Move up">
                                <ChevronLeft size={10} className="rotate-90" />
                              </button>
                              <button onClick={() => move(n, 1)} disabled={n === live.length - 1}
                                className="rounded p-0.5 text-slate-600 hover:text-white disabled:opacity-25" title="Move down">
                                <ChevronRight size={10} className="rotate-90" />
                              </button>
                              <button onClick={() => drop(n)}
                                className="rounded p-0.5 text-slate-600 hover:text-red-300" title="Remove this step">
                                <X size={10} />
                              </button>
                            </span>
                          </div>
                        ))}
                        <div className="flex items-center gap-2 pl-5">
                          <button
                            onClick={() => setPlanEdits([...live, ""])}
                            className="flex items-center gap-1 text-[10px] text-slate-500 transition-colors hover:text-slate-200"
                          >
                            <Plus size={9} /> add a step
                          </button>
                          {planEdits && (
                            <button
                              onClick={() => setPlanEdits(null)}
                              className="text-[10px] text-slate-600 transition-colors hover:text-slate-300"
                            >
                              reset
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })()}

                  {/* the two settings worth changing before spending anything */}
                  <div className="flex flex-wrap items-center gap-3 mb-3">
                    <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                      Resolution
                      <Dropdown
                        value={planRes}
                        onChange={setPlanRes}
                        className="w-[72px]"
                        options={[{ value: "2k", label: "2K" }, { value: "4k", label: "4K" }]}
                      />
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                      Aspect
                      <Dropdown
                        value={planAspect}
                        onChange={setPlanAspect}
                        className="w-[84px]"
                        options={["16:9", "9:16", "21:9", "4:3", "1:1", "4:5"].map(a => ({ value: a, label: a }))}
                      />
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => void respond({
                        toolCallId: rail.plan!.toolCallId,
                        approved: true,
                        // The approve route forwards a note to the employee, so
                        // a changed setting reaches the shots it will render.
                        note:
                          `Render every image at ${planRes.toUpperCase()} and every shot at a ${planAspect} aspect ratio unless a shot genuinely cannot use it.`
                          // An amended plan is the plan. Sending the edited
                          // list is the difference between correcting a
                          // proposal and rejecting one.
                          + (planEdits
                            ? `\n\nTHE USER EDITED THE PLAN. Follow THIS list exactly, not the one you proposed:\n`
                              + planEdits.map((t, i) => `${i + 1}. ${t}`).filter(Boolean).join("\n")
                              + `\nSteps they removed are cancelled; steps they added are required; the order here is the order.`
                            : ""),
                      })}
                      disabled={answering}
                      className="flex-1 py-2 rounded-lg bg-white/10 border border-white/25 text-white text-[12px] font-bold hover:bg-white/15 hover:border-white/40 disabled:bg-white/5 disabled:text-slate-600 disabled:border-white/10 transition-all flex items-center justify-center gap-1.5"
                    >
                      {answering ? <><Loader2 size={12} className="animate-spin" /> Sending…</> : <><Check size={12} /> Approve and shoot</>}
                    </button>
                    <button
                      onClick={() => void respond({ toolCallId: rail.plan!.toolCallId, approved: false })}
                      className="px-3 py-2 rounded-lg border border-white/10 text-slate-400 text-[12px] hover:bg-white/5 transition-colors"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )
            })() : panelTab === "now" && rail.storyboard ? (
              // THE BOARD. The last cheap moment in the production: everything
              // after this costs video money, so it sits above every other
              // view and the only ways out are "shoot it" or "change this".
              <div className="w-full h-full overflow-y-auto px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <ListChecks size={14} className="text-amber-300 shrink-0" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/90">
                    The board — {rail.storyboard.frames.length} shot{rail.storyboard.frames.length === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-slate-400 mb-3">
                  This is the film as stills. Nothing has been shot yet — approving it starts the video spend.
                </p>
                {rail.storyboard.frames.some(f => f.plateQueueId && deadPlates.has(f.plateQueueId)) && (
                  <p className="mb-3 rounded-lg border border-red-500/25 bg-red-500/[0.08] px-2.5 py-1.5 text-[11px] leading-snug text-red-200">
                    Some plates failed to render. You can still shoot the board — those shots go ahead
                    without a start frame — or type below to have them re-plated first.
                  </p>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                  {rail.storyboard.frames.map(f => {
                    // The url if the studio had one, otherwise the picture its
                    // queue id resolves to once that plate lands.
                    const url = f.plateUrl ?? (f.plateQueueId ? plateUrls[f.plateQueueId] : undefined)
                    const dead = !url && !!f.plateQueueId && deadPlates.has(f.plateQueueId)
                    const stillComing = !url && !dead && !!f.plateQueueId
                    return (
                    <div key={f.n} className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                      <div className="relative aspect-video bg-black">
                        {url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[9px] text-slate-600">
                            {stillComing
                              ? <><Loader2 size={12} className="animate-spin text-slate-500" />rendering</>
                              : dead
                                ? <><X size={12} className="text-red-400/70" /><span className="text-red-300/70">plate failed</span></>
                                : "no plate"}
                          </div>
                        )}
                        <span className="absolute top-0.5 left-0.5 rounded bg-black/75 px-1 text-[9px] font-mono text-slate-200">
                          {f.n}
                        </span>
                        {f.seconds ? (
                          <span className="absolute top-0.5 right-0.5 rounded bg-black/75 px-1 text-[9px] font-mono text-slate-400">
                            {f.seconds}s
                          </span>
                        ) : null}
                      </div>
                      <div className="px-1.5 py-1">
                        <div className="text-[10px] leading-snug text-slate-300 line-clamp-3">{f.description}</div>
                        {f.feeling && (
                          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-cyan-300/70">{f.feeling}</div>
                        )}
                        {f.model && (
                          <div className="text-[9px] font-mono text-slate-600 truncate">{f.model}</div>
                        )}
                      </div>
                    </div>
                    )
                  })}
                </div>

                {rail.storyboard.note && (
                  <p className="text-[11px] leading-snug text-amber-200/80 mb-3">{rail.storyboard.note}</p>
                )}

                <input
                  value={boardNote}
                  onChange={e => setBoardNote(e.target.value)}
                  placeholder="Change something first? e.g. 'reshoot 3 and 7, wider'"
                  className="w-full mb-2 rounded-lg bg-black/40 border border-white/10 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500/40"
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const note = boardNote.trim()
                      setBoardNote("")
                      void respond({
                        toolCallId: rail.storyboard!.toolCallId,
                        approved: !note,
                        ...(note
                          ? { note: `Do NOT shoot yet. Change the board first: ${note}. Re-plate only the frames named, then present the board again.` }
                          : {}),
                      })
                    }}
                    disabled={answering}
                    className="flex-1 py-2 rounded-lg bg-white/10 border border-white/25 text-white text-[12px] font-bold hover:bg-white/15 hover:border-white/40 disabled:bg-white/5 disabled:text-slate-600 disabled:border-white/10 transition-all flex items-center justify-center gap-1.5"
                  >
                    {answering
                      ? <><Loader2 size={12} className="animate-spin" /> Sending…</>
                      : boardNote.trim() ? <><RefreshCw size={12} /> Change it first</> : <><Check size={12} /> Shoot it</>}
                  </button>
                  <button
                    onClick={() => void respond({ toolCallId: rail.storyboard!.toolCallId, approved: false })}
                    className="px-3 py-2 rounded-lg border border-white/10 text-slate-400 text-[12px] hover:bg-white/5 transition-colors"
                  >
                    Stop
                  </button>
                </div>
              </div>
            ) : panelTab === "now" && rail.approvals.length > 0 ? (
              // Permission to spend. This sits ABOVE the film deliberately:
              // a run that is asking for something has stopped, and showing it
              // a finished-looking cut instead is what made it look "stuck".
              <div className="w-full h-full overflow-y-auto px-5 py-4">
                <div className="flex items-center gap-2 mb-2">
                  <HelpCircle size={14} className="text-cyan-300 shrink-0" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300/90">
                    Needs your go-ahead
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-slate-400 mb-3">
                  The film is paused until you answer. This is what it wants to do next:
                </p>
                <div className="space-y-2.5 mb-4">
                  {rail.approvals.map(a => (
                    <div key={a.toolCallId} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                      <div className="text-[12px] font-semibold text-slate-100 leading-snug">{a.headline}</div>
                      {a.items.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {a.items.map((it, n) => (
                            <li key={n} className="flex items-start gap-1.5">
                              <span className="mt-[6px] w-1 h-1 rounded-full bg-slate-600 shrink-0" />
                              <span className="text-[11px] leading-snug text-slate-400">{it}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {a.effect && (
                        <div className="mt-1.5 text-[10px] leading-snug text-slate-500">{a.effect}</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void respondAll(true)}
                    disabled={answering}
                    className="flex-1 py-2 rounded-lg bg-white/10 border border-white/25 text-white text-[12px] font-bold hover:bg-white/15 hover:border-white/40 disabled:bg-white/5 disabled:text-slate-600 disabled:border-white/10 transition-all flex items-center justify-center gap-1.5"
                  >
                    {answering ? <><Loader2 size={12} className="animate-spin" /> Sending…</> : <><Check size={12} /> Go ahead</>}
                  </button>
                  <button
                    onClick={() => void respondAll(false)}
                    className="px-3 py-2 rounded-lg border border-white/10 text-slate-400 text-[12px] hover:bg-white/5 transition-colors"
                    title="The film carries on without this step"
                  >
                    Skip it
                  </button>
                </div>
              </div>
            ) : panelTab === "plan" ? (
              // The plan is now a place you can go, not a thing that appears.
              <div className="w-full h-full overflow-y-auto px-4 py-3">
                {planRows.length > 0
                  ? <PlanChecklist rows={planRows} />
                  : <div className="flex h-full items-center justify-center text-[11px] text-slate-600">
                      No plan yet — it appears here once the studio proposes one.
                    </div>}
              </div>
            ) : panelTab === "film" && filmReady ? (
              <FilmPlayer src={rail.filmUrl!} videoRef={filmVideoRef} />
            ) : panelTab === "film" && rail.filmUrl ? (
              // A cut EXISTS but is not current \u2014 footage landed after it, or a
              // run is in flight. Showing it silently would repeat the bug where
              // a stale film read as finished.
              <div className="flex flex-col items-center gap-2 px-6 text-center">
                <Clapperboard size={20} className="text-slate-600" />
                <span className="text-[11px] text-slate-400">
                  {staleCut ? "This cut is out of date — footage landed after it was made."
                            : "The film is being worked on."}
                </span>
                <span className="text-[10px] text-slate-600">the new cut appears here when it lands</span>
              </div>
            ) : (
              started && rail.hasRun && (activity.length > 0 || planRows.length > 0) ? (
                // Working, with something to show: the employee's own account of
                // what it is doing, oldest first so the newest line is nearest
                // the eye. The chat transcript is noise here.
                <div className="w-full h-full overflow-y-auto px-4 py-3">
                  <div className="sticky top-0 z-10 -mx-1 mb-2 flex items-center gap-2 bg-black/85 backdrop-blur-sm px-1 py-1">
                    <Loader2 size={12} className="text-fuchsia-300 animate-spin shrink-0" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-200/90">
                      {rail.status || "Working"}
                    </span>
                  </div>
                  {planRows.length > 0 && (
                    <div className="mb-3">
                      <PlanChecklist rows={planRows} />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {activity.map((a, i) => {
                      const latest = i === activity.length - 1
                      return (
                        <div key={a.id} className="flex items-start gap-2">
                          <span className={`mt-[5px] w-1 h-1 rounded-full shrink-0 ${
                            latest ? "bg-fuchsia-300" : "bg-slate-700"
                          }`} />
                          <span className={`text-[11px] leading-snug ${latest ? "text-slate-200" : "text-slate-500"}`}>
                            {a.text}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
              <div className="flex flex-col items-center gap-2 text-slate-600 px-4 text-center">
                {started && rail.hasRun
                  ? <><Loader2 size={18} className="animate-spin text-fuchsia-400/70" />
                      <span className="text-[11px] text-slate-300">{rail.status || "Working…"}</span>
                      <span className="text-[10px] text-slate-600">the finished cut appears here</span></>
                  : <><Clapperboard size={20} />
                      <span className="text-[11px]">The finished cut appears here</span></>}
              </div>
              )
            )}
            {rail.error && (
              <div className="absolute bottom-2 left-2 right-2 rounded-lg border border-red-500/30 bg-red-500/[0.12] px-2.5 py-1.5 text-[11px] text-red-200">
                {rail.error}
              </div>
            )}
          </div>

          {/* ── the film strip ─────────────────────────────── */}
          {shots.length > 0 && filmReady && (
            <FilmStrip
              shots={timedShots}
              onInspect={n => { setInspectNote(""); setInspect(n) }}
              onMeasure={noteDuration}
              videoRef={filmVideoRef}
              marks={marks}
              onMarks={setMarks}
              sections={sections}
            />
          )}
        </div>

      </div>
      </div>

      {/* Bottom band: both feeds across the ENTIRE page width, split down the
          middle. Each column owns its own scroll, so one can be run to the
          bottom without moving the other. */}
      <div className="shrink-0 grid grid-cols-2 gap-3 portrait:h-[30vh] landscape:h-[min(38vh,400px)]">
        <FeedColumn title="Images">{renderFeed("image", feedKey, pendingPlates)}</FeedColumn>
        <FeedColumn title="Videos">{renderFeed("video", feedKey, pendingShots)}</FeedColumn>
      </div>
    </div>
    </div>
  )
}

const STEP_LABEL: Record<string, string> = {
  propose_plan: "Waiting on the plan",
  ask_user: "Waiting for you",
  create_media: "Generating a plate…",
  render_shots: "Shooting the film…",
  check_shots: "Reviewing the takes…",
  extract_frames: "Pulling frames…",
  create_audio: "Scoring…",
  assemble_film: "Cutting the film…",
  edit_image: "Editing…",
  write_summary: "Wrapping up",
  load_skill: "Reading the playbooks…",
  reasoning: "Thinking it through…",
}

function FeedColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="relative flex flex-col min-h-0 rounded-2xl silver-edge overflow-hidden">
      <div className="shrink-0 px-3 py-1.5 border-b border-white/5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{title}</span>
      </div>
      {/* Each column scrolls on its own so the two stay independent */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">{children}</div>
    </div>
  )
}


/**
 * The plan, ticked off by what the run actually made.
 *
 * Every generative line of the approved plan gets a box: an empty circle until
 * something starts, a spinner while it renders, a tick when it lands, a cross
 * when it dies. The count beside it ("4/6") is the point of the whole panel —
 * a plan that promised six plates and delivered four is a discrepancy the
 * activity feed will never show you, because nothing failed loudly.
 */
function PlanChecklist({ rows }: { rows: PlanRow[] }) {
  const extra = extraOf(rows)
  const gens = rows.filter(r => r.planned > 0)
  const plannedTotal = gens.reduce((n, r) => n + r.planned, 0)
  const doneTotal = gens.reduce((n, r) => n + r.done, 0)
  const failedTotal = rows.reduce((n, r) => n + r.failed, 0)
  const over = Object.entries(extra).filter(([, n]) => (n ?? 0) > 0)

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-2 flex items-center gap-2 bg-black/85 backdrop-blur-sm px-1 py-1">
        <ListChecks size={12} className="text-cyan-300 shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-200/90">
          The plan
        </span>
        {plannedTotal > 0 && (
          <span className="ml-auto font-mono text-[10px] text-slate-400">
            {doneTotal}/{plannedTotal}
          </span>
        )}
        {failedTotal > 0 && (
          <span className="font-mono text-[10px] text-red-300">{failedTotal} failed</span>
        )}
      </div>

      <ol className="space-y-1">
        {rows.map((r, i) => {
          const box =
            r.state === "done" ? "border-emerald-400/50 bg-emerald-400/15"
            : r.state === "partial" ? "border-amber-400/50 bg-amber-400/15"
            : r.state === "failed" ? "border-red-400/50 bg-red-400/15"
            : r.state === "running" ? "border-cyan-300/60 bg-cyan-400/10"
            : "border-white/15"
          const text =
            r.state === "done" ? "text-slate-300"
            : r.state === "running" ? "text-slate-100"
            : r.state === "partial" || r.state === "failed" ? "text-slate-200"
            : "text-slate-500"
          return (
            <li key={i} className="flex items-start gap-2">
              <span className={`mt-[2px] w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${box}`}>
                {r.state === "done" && <Check size={8} className="text-emerald-300" />}
                {r.state === "partial" && <AlertTriangle size={8} className="text-amber-300" />}
                {r.state === "failed" && <X size={8} className="text-red-300" />}
                {r.state === "running" && <Loader2 size={8} className="text-cyan-300 animate-spin" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[11px] leading-snug ${text}`}>{r.text}</span>
                {r.planned > 0 && (r.actual.length > 0 || r.state !== "pending") && (
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="h-[3px] flex-1 max-w-[120px] rounded-full bg-white/10 overflow-hidden">
                      <span
                        className={`block h-full rounded-full transition-all ${
                          r.failed > 0 ? "bg-amber-400/70" : "bg-emerald-400/70"
                        }`}
                        style={{ width: `${Math.min(100, (r.done / Math.max(1, r.planned)) * 100)}%` }}
                      />
                    </span>
                    <span className="font-mono text-[9px] text-slate-500">
                      {r.done}/{r.planned}
                      {r.failed > 0 && <span className="text-red-300"> · {r.failed} failed</span>}
                    </span>
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      {over.length > 0 && (
        <div className="mt-2 text-[9px] text-slate-500">
          beyond the plan: {over.map(([k, n]) => `${n} ${k}`).join(", ")}
        </div>
      )}
    </div>
  )
}


/**
 * The finished cut, with the patience the network needs.
 *
 * The film is written to R2 and the panel shows it the moment the assemble step
 * reports done — which can be a second or two before that object is actually
 * servable from the edge. A <video> that loses that race fails ONCE and stays
 * failed: the browser draws the crossed-out play button and never retries,
 * which is why reloading the page "fixed" it.
 *
 * So a load error here is treated as "not yet" rather than "broken": remount
 * with a backoff, then hand the user a button rather than a dead frame.
 */
function FilmPlayer({ src, videoRef }: { src: string; videoRef?: React.RefObject<HTMLVideoElement | null> }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The count lives in a ref as well as state: onError has to read it without
  // going through a state updater, which React is free to run twice.
  const attemptRef = useRef(0)

  // A new cut is a fresh start, however badly the previous one went.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    attemptRef.current = 0
    setAttempt(0)
    setFailed(false)
  }, [src])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const bump = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      attemptRef.current += 1
      setAttempt(attemptRef.current)
    }, delay)
  }, [])

  const retry = useCallback(() => {
    setFailed(false)
    bump(0)
  }, [bump])

  const onError = useCallback(() => {
    const a = attemptRef.current
    if (a >= 4) { setFailed(true); return }
    // Backs off: 1s, 2s, 3s, 4s. Long enough for a write to land, short
    // enough that the user does not go looking for the refresh button.
    bump(1000 * (a + 1))
  }, [bump])

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        <Clapperboard size={20} className="text-slate-600" />
        <span className="text-[11px] text-slate-400">The cut is made but would not load.</span>
        <button
          onClick={retry}
          className="flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-[11px] text-slate-200 hover:border-white/35 hover:bg-white/5 transition-colors"
        >
          <RotateCw size={11} /> Try again
        </button>
      </div>
    )
  }

  // The cache buster only goes on RETRIES, so the first load stays cacheable
  // — and only when the url has no query of its own to disturb.
  const url = attempt === 0 || src.includes("?") ? src : `${src}?r=${attempt}`
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      key={`${src}#${attempt}`}
      ref={videoRef}
      src={url}
      controls
      playsInline
      preload="metadata"
      onError={onError}
      className="max-w-full max-h-full"
    />
  )
}


/**
 * The film as a strip you can scrub, and mark.
 *
 * Each shot is a tile as wide as it runs, the playhead tracks the video above
 * it, dragging across it marks a stretch, and tapping seeks.
 *
 * Marks are CONTINUOUS TIME, not whole shots. They used to snap to clip
 * boundaries because a clip is the smallest thing a model can re-render \u2014 but
 * that is a fact about the machinery, not about the film, and it meant the bit
 * from 0:12 to 0:19 could not be asked for. Assembly can trim a clip at either
 * end, so an arbitrary span is deliverable: the shots it overlaps get trimmed
 * and new footage covers the middle. Timecodes can also just be typed.
 */
function FilmStrip({
  shots,
  videoRef,
  marks,
  onMarks,
  sections,
  onMeasure,
  onInspect,
}: {
  shots: Shot[]
  videoRef: React.RefObject<HTMLVideoElement | null>
  marks: { start: number; end: number }[]
  onMarks: (next: { start: number; end: number }[]) => void
  sections: { startSec: number; endSec: number; touched: { shot: Shot; whole: boolean }[] }[]
  onMeasure: (queueId: number, seconds: number) => void
  /** Double-tap a tile to open that take on its own. */
  onInspect: (shotIndex: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(0)
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null)
  const dragRef = useRef<{ anchor: number; moved: boolean } | null>(null)
  const [typing, setTyping] = useState(false)
  const [fromText, setFromText] = useState("")
  const [toText, setToText] = useState("")
  /**
   * The film's own length, which outranks any sum of its parts.
   *
   * The strip used to add up what each shot was ORDERED at \u2014 eleven at five
   * seconds reads as 55 over a film that runs 29. The file knows the truth,
   * and the playhead has to be plotted against it or it lands in the wrong
   * place at every moment except zero.
   */
  const [filmSecs, setFilmSecs] = useState(0)

  const shotSum = shots.reduce((n, sh) => n + sh.seconds, 0)
  const duration = filmSecs > 0 ? filmSecs : shotSum

  const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`
  /** Timecode with tenths, for spans that do not land on a whole second. */
  const fine = (n: number) => {
    const m = Math.floor(n / 60)
    const sec = n - m * 60
    return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`
  }
  /** Accepts 12, 0:12, 1:04.5 \u2014 whatever someone would actually type. */
  const parseClock = (raw: string): number | null => {
    const t = raw.trim()
    if (!t) return null
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t)
    if (!m) return null
    const mins = m[1] ? Number(m[1]) : 0
    const secs = Number(m[2])
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null
    return mins * 60 + secs
  }

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const sync = () => setAt(el.currentTime || 0)
    const meta = () => {
      sync()
      if (Number.isFinite(el.duration) && el.duration > 0) setFilmSecs(el.duration)
    }
    el.addEventListener("timeupdate", sync)
    el.addEventListener("seeked", sync)
    el.addEventListener("loadedmetadata", meta)
    el.addEventListener("durationchange", meta)
    meta()
    return () => {
      el.removeEventListener("timeupdate", sync)
      el.removeEventListener("seeked", sync)
      el.removeEventListener("loadedmetadata", meta)
      el.removeEventListener("durationchange", meta)
    }
  }, [videoRef, shots.length])

  const timeAtX = useCallback((clientX: number): number => {
    const el = barRef.current
    if (!el || duration <= 0) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((clientX - r.left) / Math.max(1, r.width)) * duration))
  }, [duration])

  const onDown = (e: React.PointerEvent) => {
    const t = timeAtX(e.clientX)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { anchor: t, moved: false }
    setDrag({ start: t, end: t })
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const t = timeAtX(e.clientX)
    // A few pixels of travel is a tap with a shaky finger, not a selection.
    if (Math.abs(t - d.anchor) > duration * 0.01) d.moved = true
    setDrag({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) })
  }

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    const span = drag
    dragRef.current = null
    setDrag(null)
    if (!d) return

    // A press that never moved is a SEEK \u2014 the strip has to work as a
    // scrubber first, or marking a section costs you your place.
    if (!d.moved || !span) {
      const t = timeAtX(e.clientX)
      const el = videoRef.current
      if (el) el.currentTime = t
      setAt(t)
      return
    }
    // Dragging across something already marked clears it, so one gesture both
    // marks and unmarks.
    const covered = marks.some(m => m.start <= span.start + 0.05 && m.end >= span.end - 0.05)
    onMarks(covered
      ? marks.filter(m => !(m.start <= span.start + 0.05 && m.end >= span.end - 0.05))
      : [...marks, span])
  }

  const addTyped = () => {
    const a = parseClock(fromText)
    const b = parseClock(toText)
    if (a === null || b === null || b <= a) return
    onMarks([...marks, { start: Math.max(0, a), end: Math.min(duration || b, b) }])
    setFromText("")
    setToText("")
    setTyping(false)
  }

  const pct = (t: number) => `${(t / Math.max(1e-6, duration)) * 100}%`
  const live = drag ?? null

  return (
    <div className="relative shrink-0 border-t border-white/5 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <Scissors size={11} className="text-slate-500" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {sections.length > 0
            ? `${sections.length} section${sections.length === 1 ? "" : "s"} marked`
            : "Drag to mark \u00b7 tap to scrub"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          {clock(at)} / {clock(duration)}
        </span>
        <button
          onClick={() => setTyping(v => !v)}
          title="Type exact timecodes instead of dragging"
          className={`rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
            typing ? "border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200"
                   : "border-white/10 text-slate-500 hover:border-white/25 hover:text-slate-300"
          }`}
        >
          type
        </button>
        {sections.length > 0 && (
          <button
            onClick={() => onMarks([])}
            className="text-[10px] text-slate-500 hover:text-white transition-colors"
          >
            clear
          </button>
        )}
      </div>

      {typing && (
        <div className="mb-1.5 flex items-center gap-1.5">
          <input
            value={fromText}
            onChange={e => setFromText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addTyped() }}
            placeholder="0:12"
            className="w-[64px] rounded-md border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500/40 focus:outline-none"
          />
          <span className="text-[10px] text-slate-600">to</span>
          <input
            value={toText}
            onChange={e => setToText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addTyped() }}
            placeholder="0:19"
            className="w-[64px] rounded-md border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500/40 focus:outline-none"
          />
          <button
            onClick={addTyped}
            disabled={parseClock(fromText) === null || parseClock(toText) === null
              || (parseClock(toText) ?? 0) <= (parseClock(fromText) ?? 0)}
            className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-white/15 disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-600"
          >
            Mark
          </button>
          <span className="text-[9px] text-slate-600">m:ss, or just seconds</span>
        </div>
      )}

      <div
        ref={barRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { dragRef.current = null; setDrag(null) }}
        // touch-none: on iPad the drag must select, not scroll the panel.
        className="relative flex h-12 w-full touch-none select-none overflow-hidden rounded-lg border border-white/10 bg-black/40 cursor-pointer"
      >
        {shots.map(sh => (
          <div
            key={sh.queueId}
            style={{ flexGrow: sh.seconds, flexBasis: 0 }}
            // Double-tap opens the take. A single tap has to stay a seek \u2014
            // scrubbing is what this bar is for most of the time.
            onDoubleClick={e => { e.stopPropagation(); onInspect(sh.index) }}
            className="relative min-w-0 border-r border-black/60 last:border-r-0"
          >
            {/* The shot's own opening frame is the thumbnail. No server
                round-trip, and it is literally the footage it stands for. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={sh.url}
              muted
              playsInline
              preload="metadata"
              // The tiles already load metadata to show a frame, so the true
              // length comes free \u2014 no extra request, and the strip stops
              // guessing the moment each clip reports in.
              onLoadedMetadata={e => onMeasure(sh.queueId, e.currentTarget.duration)}
              className="absolute inset-0 h-full w-full object-cover opacity-70"
            />
            <span className="absolute inset-0 bg-black/25" />
            <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[8px] font-mono text-slate-300">
              {sh.index}
            </span>
          </div>
        ))}

        {/* Marked spans float OVER the tiles, because a span no longer has to
            line up with one \u2014 it can start and end anywhere. */}
        {sections.map(sec => (
          <span
            key={`${sec.startSec}-${sec.endSec}`}
            className="pointer-events-none absolute inset-y-0 border-x border-fuchsia-300/70 bg-fuchsia-500/30 ring-1 ring-inset ring-fuchsia-400/50"
            style={{ left: pct(sec.startSec), width: pct(sec.endSec - sec.startSec) }}
          />
        ))}
        {live && live.end - live.start > 0 && (
          <span
            className="pointer-events-none absolute inset-y-0 bg-fuchsia-500/40 border-x border-fuchsia-200/80"
            style={{ left: pct(live.start), width: pct(live.end - live.start) }}
          />
        )}

        {/* the playhead */}
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
          style={{ left: pct(at) }}
        >
          <span className="absolute -top-px -left-[3px] h-1.5 w-1.5 rounded-full bg-white" />
        </span>
      </div>

      {sections.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {sections.map(sec => {
            const whole = sec.touched.filter(t => t.whole).length
            const part = sec.touched.length - whole
            return (
              <span
                key={`${sec.startSec}-${sec.endSec}`}
                className="flex items-center gap-1 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-mono text-fuchsia-200"
                title={`${whole} shot(s) replaced outright, ${part} trimmed`}
              >
                {fine(sec.startSec)}–{fine(sec.endSec)}
                <button
                  onClick={() => onMarks(marks.filter(m =>
                    m.end <= sec.startSec + 0.05 || m.start >= sec.endSec - 0.05))}
                  className="text-fuchsia-300/60 transition-colors hover:text-white"
                  title="Unmark this section"
                >
                  <X size={8} />
                </button>
              </span>
            )
          })}
          <span className="ml-1 self-center text-[9px] text-slate-500">
            describe the change in the edit, then send
          </span>
        </div>
      )}
    </div>
  )
}


/**
 * One reference thumbnail.
 *
 * Fixed square rather than a grid cell: a reference can be any shape, and a
 * wide one used to stretch its row and overlap its neighbours. Three targets
 * live on it \u2014 the tile opens the editor, the X removes it from the film, and
 * the badge says (or asks) which character it is.
 */
function RefTile({
  item,
  name,
  onEdit,
  onRemove,
  onCast,
}: {
  item: { id: string; url: string }
  name?: string
  onEdit: () => void
  onRemove: () => void
  onCast: () => void
}) {
  const isVid = isVideoRef(item.url)
  return (
    <div className="group relative w-[62px] h-[62px] portrait:w-[52px] portrait:h-[52px] shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black/40">
      <button onClick={onEdit} title="Edit this reference" className="absolute inset-0">
        {isVid ? (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={item.url}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[8px] font-semibold uppercase tracking-wider text-fuchsia-300">
              clip
            </span>
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/25" />
      </button>

      <button
        onClick={onRemove}
        title="Remove from this film"
        // z-10: it sits ON TOP of the full-tile edit button, so the X removes
        // rather than opening the editor underneath it
        className="absolute z-10 top-0.5 right-0.5 rounded bg-black/70 p-0.5 text-white/80 hover:text-white"
      >
        <X size={10} />
      </button>

      {!isVid && (
        <button
          onClick={onCast}
          title={name ? `${name} \u2014 tap to rename` : "Say who this is"}
          className={`absolute z-10 bottom-0 left-0 right-0 truncate px-1 py-[1px] text-[8px] font-semibold transition-colors ${
            name
              ? "bg-cyan-500/30 text-cyan-50"
              : "bg-black/60 text-slate-500 opacity-0 group-hover:opacity-100"
          }`}
        >
          {name ?? "who?"}
        </button>
      )}
    </div>
  )
}
