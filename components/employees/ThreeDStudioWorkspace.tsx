"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Loader2, Plus, X, Download, Sparkles, AlertTriangle, Upload, ChevronDown, Check, Maximize2, Minimize2, RotateCw, Layers, Search } from "lucide-react"
import { SilverRimOverlay } from "@/components/home/SilverRimOverlay"
import { createPortal } from "react-dom"
import { THREED_MODELS, THREED_STAGE_LABEL, type ThreeDStage, type ThreeDModel, type ThreeDControl } from "@/lib/fal-3d-models"

/**
 * 3D Studio.
 *
 * The other studios make pictures; this one makes FILES — meshes, rigs and
 * worlds — and that changes the whole surface. A thumbnail tells you almost
 * nothing about a mesh, so the centre of the page is a real viewer you can
 * orbit. And the models chain rather than compete: generate a shape, remesh it
 * into clean topology, retexture it, rig it. The library on the right is
 * therefore not an archive, it is the INPUT to the next step, which is why any
 * asset can be sent straight back in as the source.
 */

type Job = { id: number; prompt: string; modelId: string; startedAt: string; queuedAt: string }
type Failure = {
  id: number
  prompt: string
  modelId: string
  error: string
  queuedAt: string
  failedAt: string | null
  falRequestId: string | null
  endpoint: string | null
  inputs: string[]
}

type Asset = {
  id: number
  prompt: string
  modelId: string
  preview: string | null
  files: { url: string; kind: string }[]
  archive: { name: string; bytes: number }[] | null
  layers: { url: string; role: string; depth: number; label?: string }[] | null
  createdAt: string
  queuedAt: string
}

/**
 * One tile in the library strip, whatever state it is in.
 *
 * Running, failed and finished used to render as three groups one after the
 * other, so a tile jumped across the strip the moment it changed state and the
 * failures piled up in the middle regardless of when they happened. They are
 * one list ordered by when the work was submitted, so a tile stays put.
 */
type StripItem =
  | { kind: "job"; at: number; job: Job }
  | { kind: "fail"; at: number; fail: Failure }
  | { kind: "asset"; at: number; asset: Asset }

/**
 * Anything that can be fed in as a source mesh.
 *
 * Refine, rig, retexture and segment all consume a mesh, and until now the
 * bench picked one for you: whatever was active in the Refs dropdown, else
 * whatever tile happened to be selected in the library strip. That is fine
 * right up until you own more than one mesh, at which point the only way to
 * use the other one was to go and change what was active elsewhere. Uploads
 * and previous generations are the same kind of thing here, so they are
 * offered as one list.
 */
type MeshOption = {
  url: string
  label: string
  detail?: string
  preview?: string | null
  origin: "upload" | "generated"
}

const MESH_EXT = /\.(glb|gltf|obj|stl|fbx|ply|usdz|3mf)(\?|$)/i

/** The file extension, for a tile that has no picture to show. */
function meshExt(url: string): string {
  return (url.split("?")[0].split(".").pop() ?? "3d").toUpperCase()
}

/** The last path segment, minus the cache-busting noise. */
function meshName(url: string): string {
  return decodeURIComponent(url.split("?")[0].split("/").pop() ?? "mesh")
}

const STAGES: ThreeDStage[] = ["generate", "refine", "rig", "scene", "analyse"]

/**
 * What a failure means, and what to do about it.
 *
 * The raw message is always shown underneath — this is the part that saves a
 * search. Most failures here are one of a few recurring shapes, and every one
 * of them has a concrete fix.
 */
function readFailure(error: string): { headline: string; fix: string } | null {
  const e = error.toLowerCase()
  if (e.includes("auto-reset by cron")) {
    return {
      headline: "Killed by the queue watchdog, not by fal",
      fix: "A bookkeeping bug let the watchdog fail long 3D jobs at twelve minutes without ever checking whether they were still running. It is fixed, and 3D now gets an hour. Jobs lost this way had usually finished at fal and can be recovered.",
    }
  }
  if (e.includes("file size exceeds") || e.includes("exceeds the maximum size")) {
    return {
      headline: "The source image is too big for this model",
      fix: "Most of these cap the input at 20MB. References here are full-resolution originals and are often larger than that — shrink the image first, or pick a model with a higher limit.",
    }
  }
  if (e.includes("dimensions are too large") || e.includes("maximum area")) {
    return {
      headline: "The source image has too many pixels",
      fix: "This limit is on total area, not file size, so a long thin image can fail even when it is small on disk. Scale it down and try again.",
    }
  }
  if (e.includes("too large for rapid")) {
    return {
      headline: "Rapid takes smaller inputs than Pro",
      fix: "Use the Pro variant for this image, or downscale it first.",
    }
  }
  if (e.includes("field required") || e.includes("rejected the input")) {
    return {
      headline: "fal refused the input",
      fix: "The field it names was missing or the wrong shape. If a required option on the bench is blank, fill it in; otherwise this is a bug in the model catalog worth reporting.",
    }
  }
  if (e.includes("timed out")) {
    return {
      headline: "Never finished at fal",
      fix: "The job sat past the hour cutoff without completing. Re-running usually works; if it keeps happening the model is likely overloaded.",
    }
  }
  return null
}

/**
 * Why an output cannot be orbited, in the user's terms.
 *
 * <model-viewer> reads glTF and nothing else. Several models here do not
 * produce glTF at all — TripoSplat's whole point is a Gaussian splat, Hunyuan
 * Motion returns an FBX animation — and showing those the same empty "generated
 * models appear here" panel as an empty bench reads as "your render vanished".
 * It did not; it is just not a format a browser can turn.
 */
function whyNotViewable(a: Asset, splatBytes?: number): { headline: string; detail: string } {
  const exts = a.files
    .filter(f => f.kind !== "preview")
    .map(f => (f.url.split("?")[0].split(".").pop() ?? "").toLowerCase())
  if (exts.some(e => e === "ply" || e === "splat")) {
    // Splats DO render here now; the only ones that do not are the ones too
    // large to survive it, so say which problem this actually is.
    return splatBytes && splatBytes > SPLAT_MAX_BYTES
      ? {
          headline: `This splat is too big to open in a browser (${(splatBytes / 1048576).toFixed(0)}MB)`,
          detail: `Anything over ${SPLAT_MAX_BYTES / 1048576}MB will lock the tab up rather than render. Download it and open it in SuperSplat, Postshot or Blender.`,
        }
      : {
          headline: "The splat renderer could not load",
          detail: "The viewer is fetched from a CDN on demand; if that request was blocked it falls back to here. Reload the page to try again, or download the file and open it in SuperSplat.",
        }
  }
  if (exts.includes("zip")) {
    return {
      headline: "This is a world archive, not a single model",
      detail: "Hunyuan World returns layered geometry plus its panorama images, bundled together. The layers run to hundreds of megabytes each, so the archive is a download — the panorama below is what it built.",
    }
  }
  if (exts.some(e => e === "fbx")) {
    return {
      headline: "FBX has no browser viewer",
      detail: "Download it and open it in Blender, Maya or Unreal — it is the right format for a rig or an animation, just not for a web preview.",
    }
  }
  if (exts.length > 0) {
    return {
      headline: `${exts[0].toUpperCase()} cannot be shown here`,
      detail: "The viewer reads glTF and GLB only. The file is finished and downloadable below.",
    }
  }
  return { headline: "Nothing to display", detail: "This job produced data rather than a model — the files are below." }
}

/** A file model-viewer can show: glTF and nothing else. */
function viewableUrl(a: Asset | null): string | null {
  if (!a) return null
  const glb = a.files.find(f => /\.(glb|gltf)(\?|$)/i.test(f.url))
  return glb?.url ?? null
}

/**
 * A Gaussian splat this browser can render.
 *
 * TripoSplat's output is a 3DGS .ply — 262,144 Gaussians, about 18MB — which
 * is well within what a WebGL splat renderer handles. It was being written off
 * as undisplayable only because model-viewer reads glTF.
 *
 * Hunyuan World's layers are also .ply, but they run 86MB to 561MB each and
 * would take the tab down, so anything past the cap stays a download. The
 * limit is on the file, not the format.
 */
const SPLAT_MAX_BYTES = 80 * 1024 * 1024

function splatUrl(a: Asset | null): string | null {
  if (!a) return null
  const f = a.files.find(x => /\.(ply|splat|ksplat|spz)(\?|$)/i.test(x.url) && x.kind !== "preview")
  return f?.url ?? null
}

/**
 * What to write under a tile.
 *
 * An image-to-3D job has no prompt, so the stored title falls back to the
 * source URL — and a tile captioned "https://pub-de315f…" tells you nothing
 * about what is in it. The model name is the useful label there.
 */
function tileCaption(prompt: string, modelId: string): string {
  if (!prompt || /^https?:\/\//i.test(prompt)) {
    return THREED_MODELS.find(m => m.id === modelId)?.label ?? modelId
  }
  return prompt
}

/**
 * One knob from the model's own schema.
 *
 * Left alone, a control sends nothing at all and fal applies its own default.
 * That matters: writing our idea of the default into every submit would mean
 * quietly overriding whatever fal changes later, and it is the difference
 * between "standard texture" and "we insisted on standard texture".
 */
function ControlField({
  control,
  value,
  onChange,
}: {
  control: ThreeDControl
  value: string | number | boolean | undefined
  onChange: (v: string | number | boolean) => void
}) {
  const label = (
    <span className="block text-[10px] font-medium text-slate-400 mb-0.5">
      {control.label}
      {control.required && <span className="text-red-400/70"> *</span>}
    </span>
  )
  const help = control.help ? (
    <span className="block mt-0.5 text-[9px] leading-snug text-slate-600">{control.help}</span>
  ) : null

  if (control.kind === "toggle") {
    const on = value === undefined ? control.preset === true : value === true
    return (
      <div className="py-1">
        <button
          onClick={() => onChange(!on)}
          className="w-full flex items-center gap-2 text-left"
        >
          <span
            className={`h-3.5 w-3.5 shrink-0 rounded flex items-center justify-center border transition-colors ${
              on ? "bg-white/25 border-white/40" : "border-white/20"
            }`}
          >
            {on && <Check size={9} className="text-white" />}
          </span>
          <span className="text-[11px] text-slate-300">{control.label}</span>
        </button>
        {help}
      </div>
    )
  }

  if (control.kind === "select") {
    return (
      <label className="block py-1">
        {label}
        <select
          value={String(value ?? control.preset ?? "")}
          onChange={e => {
            const raw = e.target.value
            const match = control.options?.find(o => String(o.value) === raw)
            onChange(match ? match.value : raw)
          }}
          className="w-full rounded-lg bg-black/40 border border-white/10 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-white/30"
        >
          {control.options?.map(o => (
            <option key={String(o.value)} value={String(o.value)} className="bg-slate-900">
              {o.label}
            </option>
          ))}
        </select>
        {help}
      </label>
    )
  }

  return (
    <label className="block py-1">
      {label}
      <input
        type={control.kind === "number" ? "number" : "text"}
        value={String(value ?? "")}
        placeholder={control.placeholder}
        onChange={e => {
          const raw = e.target.value
          if (control.kind === "number") {
            // An empty box means "don't send it", not zero.
            onChange(raw === "" ? "" : Number(raw))
          } else {
            onChange(raw)
          }
        }}
        className="w-full rounded-lg bg-black/40 border border-white/10 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-white/30"
      />
      {help}
    </label>
  )
}

export function ThreeDStudioWorkspace({
  signedIn,
  activeRefs = [],
  onRemoveRef,
}: {
  signedIn: boolean
  /**
   * Whatever is switched on in the taskbar's Refs dropdown.
   *
   * The bench had its own one-off uploader and knew nothing about the library,
   * so activating a reference did nothing here and the same picture had to be
   * uploaded twice. These are the same references every other studio uses.
   */
  activeRefs?: { id: string; url: string }[]
  onRemoveRef?: (id: string) => void
}) {
  const [stage, setStage] = useState<ThreeDStage>("generate")
  const [modelId, setModelId] = useState("tripo-2.5-image")
  const [prompt, setPrompt] = useState("")
  const [imageUrl, setImageUrl] = useState("")
  /** True once the user uploads their own, so the library stops overriding it. */
  const [imageOwn, setImageOwn] = useState(false)
  /**
   * The extra views for the multi-view models.
   *
   * Meshy's multi-image, Rodin and VGGT all reconstruct from SEVERAL angles of
   * the same subject and were being handed exactly one, which throws away the
   * only thing that makes them better than the single-image models. `imageUrl`
   * stays the primary view so every other model keeps working unchanged; these
   * are appended to it.
   */
  const [extraUrls, setExtraUrls] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The selected model's own knobs.
   *
   * Cleared whenever the model changes: a face count meant for Tripo is
   * meaningless to Hunyuan, and carrying it over would send a field the next
   * model has never heard of.
   */
  const [opts, setOpts] = useState<Record<string, string | number | boolean>>({})
  const [showOpts, setShowOpts] = useState(false)
  const [assets, setAssets] = useState<Asset[]>([])
  /** Submitted and still at fal. Survives a refresh, because the DB holds it. */
  const [jobs, setJobs] = useState<Job[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  /**
   * Auto-spin is right for a first look and wrong for study: it drags the
   * model out from under you the moment you try to inspect one angle.
   */
  const [spin, setSpin] = useState(true)
  const [full, setFull] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Asset | null>(null)
  const [uploading, setUploading] = useState(false)
  /**
   * A mesh the user brought themselves.
   *
   * Refine and Rig used to demand a library selection, which meant you could
   * not touch either until you had generated something here first — and an
   * artist arriving with a finished model had nowhere to put it. An uploaded
   * mesh takes precedence over the library pick when both exist.
   */
  const [meshUpload, setMeshUpload] = useState<{ url: string; name: string; bytes: number } | null>(null)
  const [meshBusy, setMeshBusy] = useState(false)
  /** An explicit choice from the picker. Beats every implicit fallback. */
  const [pickedMesh, setPickedMesh] = useState<MeshOption | null>(null)
  const [meshPickerOpen, setMeshPickerOpen] = useState(false)
  /** Every 3D file in the account library, not only the activated ones. */
  const [libraryMeshes, setLibraryMeshes] = useState<MeshOption[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [meshQuery, setMeshQuery] = useState("")
  /** The failure whose details are open, if any. */
  const [errorDetail, setErrorDetail] = useState<Failure | null>(null)
  /**
   * Splat URLs the renderer could not handle — too big, or the CDN module
   * failed. Remembered so the viewer falls back to the download panel once
   * rather than retrying on every re-render.
   */
  const [splatRefused, setSplatRefused] = useState<Record<string, true>>({})
  /** Byte size per splat URL, measured before deciding to render it. */
  const [splatBytes, setSplatBytes] = useState<Record<string, number>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const meshRef = useRef<HTMLInputElement>(null)

  // Meshes activated in the library are not reference IMAGES \u2014 they are
  // candidate source meshes, and they belong to the mesh slot instead.
  const isMeshUrl = (u: string) => /\.(glb|gltf|obj|stl|fbx|ply|usdz|3mf)(\?|$)/i.test(u)
  const refImages = useMemo(() => activeRefs.filter(r => !isMeshUrl(r.url)), [activeRefs])
  const refMeshes = useMemo(() => activeRefs.filter(r => isMeshUrl(r.url)), [activeRefs])

  const spec = useMemo(() => THREED_MODELS.find(m => m.id === modelId), [modelId])
  const inStage = useMemo(() => THREED_MODELS.filter(m => m.stage === stage), [stage])

  // Keep the model valid for the stage. Switching to Rig with an image model
  // selected would otherwise submit a call the endpoint cannot accept.
  useEffect(() => {
    if (!inStage.some(m => m.id === modelId)) setModelId(inStage[0]?.id ?? "")
  }, [inStage, modelId])

  // An activated reference becomes the source image unless the user has
  // deliberately uploaded or chosen something else.
  useEffect(() => {
    if (!imageUrl && refImages.length > 0) setImageUrl(refImages[0].url)
    if (imageUrl && refImages.length > 0 && !refImages.some(r => r.url === imageUrl) && !imageOwn) {
      setImageUrl(refImages[0].url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refImages])

  // The browser owns fullscreen state \u2014 Escape and the system chrome can both
  // leave it without telling us \u2014 so the flag follows the event rather than
  // the click.
  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  const toggleFull = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void el.requestFullscreen?.().catch(() => {})
  }, [])

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/threed", { cache: "no-store" })
      if (!r.ok) return
      const d = await r.json()
      if (Array.isArray(d.assets)) {
        setAssets(d.assets)
        setSelected(cur => cur ?? d.assets[0] ?? null)
      }
      if (Array.isArray(d.jobs)) setJobs(d.jobs)
      if (Array.isArray(d.failed)) setFailures(d.failed)
    } catch { /* the library is not worth an error banner */ }
  }, [])
  useEffect(() => { void load() }, [load])

  // The GET settles finished jobs as a side effect, so polling is both how the
  // queue stays current and how a result ever lands. 6s while something is
  // running, nothing at all when the bench is idle.
  useEffect(() => {
    if (jobs.length === 0) return
    const t = setInterval(() => { void load() }, 6000)
    return () => clearInterval(t)
  }, [jobs.length, load])

  /**
   * Every mesh in the account reference library.
   *
   * Fetched when the picker first opens rather than on mount: most sessions
   * never touch a mesh model, and this is a whole-library read.
   */
  const loadLibraryMeshes = useCallback(async () => {
    setLibraryLoading(true)
    try {
      const r = await fetch("/api/user/references", { cache: "no-store" })
      if (!r.ok) return
      const d = await r.json()
      const rows: { id: number; url: string }[] = Array.isArray(d.references) ? d.references : []
      setLibraryMeshes(
        rows
          .filter(x => MESH_EXT.test(x.url))
          .reverse()
          .map(x => ({
            url: x.url,
            label: meshName(x.url),
            detail: meshExt(x.url),
            origin: "upload" as const,
          })),
      )
    } catch {
      /* the picker still shows generated meshes and the upload button */
    } finally {
      setLibraryLoading(false)
    }
  }, [])

  const openMeshPicker = useCallback(() => {
    setMeshPickerOpen(true)
    if (libraryMeshes.length === 0) void loadLibraryMeshes()
  }, [libraryMeshes.length, loadLibraryMeshes])

  /** Meshes made on this bench, newest first. */
  const generatedMeshes = useMemo<MeshOption[]>(
    () =>
      assets
        .map((a): MeshOption | null => {
          const file = a.files.find(f => f.kind !== "preview" && MESH_EXT.test(f.url))
            ?? a.files.find(f => f.kind !== "preview")
          if (!file) return null
          return {
            url: file.url,
            label: tileCaption(a.prompt, a.modelId),
            detail: meshExt(file.url),
            preview: a.preview,
            origin: "generated" as const,
          }
        })
        .filter((m): m is MeshOption => m !== null),
    [assets],
  )

  /**
   * What the picker shows: everything the user could legitimately feed in,
   * in two groups, filtered by the search box.
   *
   * Meshes activated in the Refs dropdown are folded into the uploads group
   * rather than given a third heading — from the user's side they are the same
   * thing, a file they put in the library, and the only difference is a toggle
   * they set somewhere else.
   */
  const meshGroups = useMemo(() => {
    const q = meshQuery.trim().toLowerCase()
    const match = (m: MeshOption) => !q || m.label.toLowerCase().includes(q)
    const seen = new Set<string>()
    const dedupe = (list: MeshOption[]) =>
      list.filter(m => !seen.has(m.url) && (seen.add(m.url), true)).filter(match)
    return [
      { title: "Made on this bench", items: dedupe(generatedMeshes) },
      {
        title: "Your uploads",
        items: dedupe([
          ...(meshUpload
            ? [{ url: meshUpload.url, label: meshUpload.name, detail: `${(meshUpload.bytes / 1048576).toFixed(1)}MB`, origin: "upload" as const }]
            : []),
          ...refMeshes.map(r => ({ url: r.url, label: meshName(r.url), detail: meshExt(r.url), origin: "upload" as const })),
          ...libraryMeshes,
        ]),
      },
    ]
  }, [generatedMeshes, libraryMeshes, refMeshes, meshUpload, meshQuery])

  /**
   * The library strip, in submission order rather than grouped by state.
   *
   * Newest first, which is where a fresh job appears; because the key is when
   * the work was QUEUED, a tile keeps its place as it moves from running to
   * finished or failed. Ties fall back to the row id so the order is total —
   * two jobs submitted in the same second must not swap on every poll.
   */
  const strip = useMemo<StripItem[]>(() => {
    const at = (v: string | null | undefined, fallback: number) => {
      const t = v ? Date.parse(v) : NaN
      return Number.isFinite(t) ? t : fallback
    }
    const items: StripItem[] = [
      ...jobs.map(j => ({ kind: "job" as const, at: at(j.queuedAt ?? j.startedAt, j.id), job: j })),
      ...failures.map(f => ({ kind: "fail" as const, at: at(f.queuedAt, f.id), fail: f })),
      ...assets.map(a => ({ kind: "asset" as const, at: at(a.queuedAt ?? a.createdAt, a.id), asset: a })),
    ]
    const idOf = (i: StripItem) => (i.kind === "job" ? i.job.id : i.kind === "fail" ? i.fail.id : i.asset.id)
    return items.sort((x, y) => y.at - x.at || idOf(y) - idOf(x))
  }, [jobs, failures, assets])

  const uploadMesh = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    setMeshBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append("file", f)
      const r = await fetch("/api/upload-mesh", { method: "POST", body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d?.url) { setError(String(d?.error || "That file could not be uploaded")); return }
      setMeshUpload({ url: d.url, name: d.name ?? f.name, bytes: d.bytes ?? f.size })
      // Uploading is a choice, so it selects — otherwise the picker would sit
      // there still showing whatever was chosen before.
      setPickedMesh({
        url: d.url,
        label: d.name ?? f.name,
        detail: `${((d.bytes ?? f.size) / 1048576).toFixed(1)}MB`,
        origin: "upload",
      })
      setMeshPickerOpen(false)
    } finally {
      setMeshBusy(false)
    }
  }

  /**
   * A reference image, shrunk before it is sent.
   *
   * /api/upload-reference refuses anything over 15MB because it expects the
   * client to have compressed already \u2014 and a photo straight off a phone is
   * routinely bigger than that. This used to fetch, ignore a failed response
   * entirely, and leave the spinner to stop with nothing on screen: the
   * silent failure. Now it downsizes first and says so when it still fails.
   */
  const upload = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    setUploading(true)
    setError(null)
    try {
      const body = new FormData()
      body.append("file", await shrinkForUpload(f))
      const r = await fetch("/api/upload-reference", { method: "POST", body })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || typeof d?.url !== "string") {
        setError(String(d?.error || `Upload failed (${r.status})`))
        return
      }
      setImageUrl(d.url)
      setImageOwn(true)
    } catch (e: any) {
      setError(String(e?.message || "Upload failed"))
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    setOpts({})
    setShowOpts(false)
    setExtraUrls([])
  }, [modelId])

  const run = async () => {
    if (!spec || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch("/api/admin/threed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId,
          prompt,
          imageUrl,
          // Primary view first — multi-view models treat position as meaning.
          imageUrls: imageUrl ? [imageUrl, ...extraUrls] : extraUrls,
          // A refine/rig step runs on whatever is selected in the library,
          // which is what makes the chain work without a file picker.
          meshUrl: sourceMesh,
          options: opts,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d?.job) {
        setError(String(d?.error || "That did not work"))
        return
      }
      // Optimistic, so the queue tile appears in the same frame as the press;
      // the next poll replaces it with the server's copy.
      setJobs(j => [d.job, ...j])
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Which mesh is going in.
   *
   * An explicit pick wins over everything, then an upload, then whatever the
   * user activated in Refs, and only then the tile that happens to be selected
   * in the library strip. The fallbacks are kept so the common case — one mesh,
   * just made it, want to rig it — still needs no clicks at all.
   */
  const meshSource: MeshOption | null = pickedMesh
    ?? (meshUpload
      ? { url: meshUpload.url, label: meshUpload.name, detail: `${(meshUpload.bytes / 1048576).toFixed(1)}MB`, origin: "upload" }
      : null)
    ?? (refMeshes[0]
      ? { url: refMeshes[0].url, label: meshName(refMeshes[0].url), detail: "active in Refs", origin: "upload" }
      : null)
    ?? (() => {
      const f = selected?.files.find(x => x.kind !== "preview")
      return f && selected
        ? { url: f.url, label: tileCaption(selected.prompt, selected.modelId), detail: meshExt(f.url), preview: selected.preview, origin: "generated" as const }
        : null
    })()
  const sourceMesh = meshSource?.url ?? ""
  const multiView = spec?.input === "images"
  const controls = spec?.controls ?? []
  // Named rather than counted, so the button can say what it is waiting for.
  const missingRequired = controls
    .filter(c => c.required && !String(opts[c.key] ?? "").trim())
    .map(c => c.label)
  const needsMesh = spec?.input === "mesh" || spec?.input === "image+mesh"
  const needsImage = spec?.input === "image" || spec?.input === "images" || spec?.input === "image+mesh"
  const needsText = spec?.input === "text"
  const meshReady = !needsMesh || !!sourceMesh
  const canRun = signedIn && !busy && !!spec
    && (!needsText || !!prompt.trim())
    && (!needsImage || !!imageUrl)
    && meshReady
    && missingRequired.length === 0

  const view = viewableUrl(selected)
  const splat = view ? null : splatUrl(selected)

  /*
   * Measure before rendering.
   *
   * Hunyuan World writes .ply layers up to 561MB; handing one of those to the
   * splat renderer takes the tab down. A HEAD is cheap and turns "the browser
   * froze" into an honest "too big to display".
   */
  useEffect(() => {
    if (!splat || splat in splatBytes || splat in splatRefused) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(splat, { method: "HEAD" })
        const n = Number(r.headers.get("content-length"))
        if (!cancelled) setSplatBytes(b => ({ ...b, [splat]: Number.isFinite(n) && n > 0 ? n : 0 }))
      } catch {
        if (!cancelled) setSplatBytes(b => ({ ...b, [splat]: 0 }))
      }
    })()
    return () => { cancelled = true }
  }, [splat, splatBytes, splatRefused])

  const splatSize = splat ? splatBytes[splat] : undefined
  // 0 means "the server did not say", which is not a reason to refuse.
  const splatShowable = !!splat
    && !splatRefused[splat]
    && splatSize !== undefined
    && (splatSize === 0 || splatSize <= SPLAT_MAX_BYTES)
  const markSplatFailed = useCallback(() => {
    if (splat) setSplatRefused(r => ({ ...r, [splat]: true }))
  }, [splat])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 flex flex-col landscape:flex-row gap-3 min-h-0 px-3 sm:px-4 pb-4 overflow-hidden">

        {/* ── the bench ──────────────────────────────────────────────────── */}
        <div className="w-full landscape:w-[320px] shrink-0 flex flex-col gap-3 min-h-0 order-2 landscape:order-1">
          <div className="relative flex flex-col min-h-0 rounded-2xl silver-edge p-3 overflow-y-auto">
            <span className="relative text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
              The bench
            </span>

            <div className="relative flex flex-wrap gap-1 mb-2">
              {STAGES.map(s => (
                <button
                  key={s}
                  onClick={() => setStage(s)}
                  className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                    stage === s ? "bg-red-500/20 text-red-200" : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                  }`}
                >
                  {THREED_STAGE_LABEL[s]}
                </button>
              ))}
            </div>

            <div className="relative mb-2">
              <ModelPicker models={inStage} value={modelId} onChange={setModelId} />
            </div>

            {spec && (
              <div className="relative mb-2 rounded-lg border border-white/[0.06] bg-black/20 px-2 py-1.5">
                <p className="text-[10px] leading-snug text-slate-400">{spec.bestFor}</p>
                <p className="mt-1 text-[9px] font-mono text-slate-600">→ {spec.output}</p>
                {spec.caveat && (
                  <p className="mt-1 flex gap-1 text-[9px] leading-snug text-amber-300/70">
                    <AlertTriangle size={9} className="mt-[2px] shrink-0" />{spec.caveat}
                  </p>
                )}
              </div>
            )}

            {needsText && (
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="A weathered brass diving helmet, riveted seams…"
                className="relative w-full h-[68px] mb-2 rounded-lg bg-black/40 border border-white/10 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 resize-none focus:outline-none focus:border-red-500/40"
              />
            )}

            {needsImage && refImages.length > 0 && (
              <div className="relative mb-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500">
                    {multiView ? "Views of the subject" : "From your refs"}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-slate-600">
                    {multiView && extraUrls.length > 0
                      ? `${extraUrls.length + (imageUrl ? 1 : 0)}/${refImages.length}`
                      : refImages.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {refImages.map(r => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setImageOwn(false)
                        if (!multiView) { setImageUrl(r.url); return }
                        // First press picks the primary view, the rest toggle
                        // as extra angles; pressing the primary again clears
                        // it and promotes the next one so there is never a
                        // gap where extras exist with nothing leading them.
                        if (imageUrl === r.url) {
                          setImageUrl(extraUrls[0] ?? "")
                          setExtraUrls(u => u.slice(1))
                        } else if (!imageUrl) {
                          setImageUrl(r.url)
                        } else {
                          setExtraUrls(u => u.includes(r.url) ? u.filter(x => x !== r.url) : [...u, r.url])
                        }
                      }}
                      title={multiView ? "Add as a view of the same subject" : "Use this reference"}
                      className={`relative h-[46px] w-[46px] shrink-0 overflow-hidden rounded-md border transition-colors ${
                        imageUrl === r.url || extraUrls.includes(r.url)
                          ? "border-red-400/70"
                          : "border-white/10 hover:border-white/30"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.url} alt="" className="h-full w-full object-cover" />
                      {(imageUrl === r.url || extraUrls.includes(r.url)) && (
                        <span className="absolute inset-0 ring-2 ring-inset ring-red-400/60" />
                      )}
                      {multiView && (imageUrl === r.url || extraUrls.includes(r.url)) && (
                        <span className="absolute bottom-0 right-0 rounded-tl bg-red-500/90 px-1 font-mono text-[8px] leading-[13px] text-white">
                          {imageUrl === r.url ? 1 : extraUrls.indexOf(r.url) + 2}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[9px] leading-snug text-slate-600">
                  {multiView
                    ? "Tap several angles of the SAME subject — this model reconstructs from all of them. Different subjects will produce a mess."
                    : "Activated in the Refs dropdown. Turn one on there and it appears here."}
                </p>
              </div>
            )}

            {needsImage && (
              <div className="relative mb-2 flex items-center gap-2">
                {imageUrl ? (
                  <div className="relative h-[62px] w-[62px] shrink-0 overflow-hidden rounded-lg border border-white/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => { setImageUrl(""); setImageOwn(false) }}
                      className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 text-white/80 hover:text-white"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-lg border border-dashed border-white/15 text-slate-500 transition-colors hover:border-white/30 hover:text-white"
                  >
                    {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  </button>
                )}
                <span className="text-[10px] leading-snug text-slate-500">
                  {imageUrl
                    ? (imageOwn ? "Uploaded here" : "From your references")
                    : "Upload one, or activate a reference in the Refs dropdown"}
                </span>
              </div>
            )}

            {needsMesh && (
              <div className="relative mb-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500">Source mesh</span>
                  <button
                    onClick={openMeshPicker}
                    className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400 transition-colors hover:border-red-400/40 hover:text-red-200"
                  >
                    <Layers size={9} /> {meshSource ? "Change" : "Choose"}
                  </button>
                </div>

                <button
                  onClick={openMeshPicker}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                    meshReady
                      ? "border-white/[0.06] bg-black/20 hover:border-white/20"
                      : "border-amber-500/25 bg-amber-500/[0.07] hover:border-amber-400/50"
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/50">
                    {meshSource?.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={meshSource.preview} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Box size={13} className={meshReady ? "text-red-400/70" : "text-amber-400/70"} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    {meshSource ? (
                      <>
                        <span className="block truncate text-[11px] text-slate-100">{meshSource.label}</span>
                        <span className="block truncate font-mono text-[9px] text-slate-500">
                          {meshSource.origin === "generated" ? "made here" : "your upload"}
                          {meshSource.detail ? ` · ${meshSource.detail}` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="block text-[10px] leading-snug text-amber-200">
                        Pick a mesh — one you uploaded, or one you made here.
                      </span>
                    )}
                  </span>
                  <ChevronDown size={11} className="shrink-0 -rotate-90 text-slate-500" />
                </button>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={e => { void upload([...(e.target.files ?? [])]); e.currentTarget.value = "" }}
            />
            <input
              ref={meshRef}
              type="file"
              accept=".glb,.gltf,.obj,.stl,.fbx,.ply,.usdz,.3mf"
              hidden
              onChange={e => { void uploadMesh([...(e.target.files ?? [])]); e.currentTarget.value = "" }}
            />

            {controls.length > 0 && (
              <div className="relative mb-2">
                {/* Required fields are never hidden behind a disclosure — a
                    model that cannot run without them would look broken. */}
                {controls.filter(c => c.required).map(c => (
                  <ControlField
                    key={c.key}
                    control={c}
                    value={opts[c.key]}
                    onChange={v => setOpts(o => ({ ...o, [c.key]: v }))}
                  />
                ))}

                {controls.some(c => !c.required) && (
                  <button
                    onClick={() => setShowOpts(v => !v)}
                    className="w-full flex items-center gap-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    <ChevronDown size={11} className={`transition-transform ${showOpts ? "" : "-rotate-90"}`} />
                    {spec?.family} options
                    {Object.keys(opts).some(k => controls.some(c => c.key === k && !c.required)) && (
                      <span className="ml-auto rounded-full bg-white/10 px-1.5 text-[9px] text-slate-300">changed</span>
                    )}
                  </button>
                )}

                {showOpts && controls.filter(c => !c.required).map(c => (
                  <ControlField
                    key={c.key}
                    control={c}
                    value={opts[c.key]}
                    onChange={v => setOpts(o => ({ ...o, [c.key]: v }))}
                  />
                ))}
              </div>
            )}

            <button
              onClick={() => void run()}
              disabled={!canRun}
              className={`relative w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-bold transition-all ${
                canRun
                  ? "bg-white/10 border border-white/25 text-white hover:bg-white/15 hover:border-white/40"
                  : "bg-white/5 text-slate-600 cursor-not-allowed border border-white/10"
              }`}
            >
              {busy
                ? <><Loader2 size={13} className="animate-spin" /> Sending…</>
                : missingRequired.length > 0
                  ? <>Needs {missingRequired.join(" and ").toLowerCase()}</>
                  : <><Sparkles size={13} /> {THREED_STAGE_LABEL[stage]}</>}
            </button>
            {jobs.length > 0 && (
              <p className="relative mt-1 text-[9px] leading-snug text-slate-600">
                {jobs.length} running. 3D takes minutes — this keeps going if you close the tab.
              </p>
            )}
            {error && (
              <div className="relative mt-2 rounded-lg border border-red-500/30 bg-red-500/[0.12] px-2.5 py-1.5 text-[11px] text-red-200">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* ── the viewer ─────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0 overflow-hidden order-1 landscape:order-2">
          <div className="relative flex-1 min-h-0 flex flex-col rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
            <SilverRimOverlay />
            <div className="shrink-0 px-3 py-1.5 border-b border-white/5 flex items-center gap-2">
              <Box size={12} className="text-red-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {selected ? selected.prompt.slice(0, 46) : "The model"}
              </span>
              {selected && (
                <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                  {selected.modelId}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setSpin(v => !v)}
                  title={spin ? "Stop the turntable" : "Spin it"}
                  className={`rounded-md border p-1 transition-colors ${
                    spin
                      ? "border-red-400/40 bg-red-500/10 text-red-200"
                      : "border-white/10 text-slate-500 hover:border-white/25 hover:text-slate-200"
                  }`}
                >
                  <RotateCw size={11} className={spin ? "animate-spin [animation-duration:3s]" : ""} />
                </button>
                <button
                  onClick={toggleFull}
                  title={full ? "Leave fullscreen (Esc)" : "Fullscreen"}
                  className="rounded-md border border-white/10 p-1 text-slate-500 transition-colors hover:border-white/25 hover:text-slate-200"
                >
                  {full ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
                </button>
              </span>
            </div>

            <div ref={stageRef} className="relative flex-1 min-h-0 flex items-center justify-center bg-black">
              {/* Fullscreen shows only the stage, so the model loses its
                  header \u2014 the label comes with it rather than disappearing. */}
              {full && selected && (
                <span className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-black/70 px-2 py-1">
                  <span className="block text-[11px] text-slate-100">{selected.prompt.slice(0, 60)}</span>
                  <span className="block font-mono text-[9px] text-slate-400">{selected.modelId}</span>
                </span>
              )}
              {full && (
                <span className="absolute right-3 top-3 z-10 flex gap-1">
                  <button
                    onClick={() => setSpin(v => !v)}
                    className={`rounded-md border px-2 py-1 text-[10px] ${
                      spin ? "border-red-400/40 bg-red-500/15 text-red-200" : "border-white/15 bg-black/60 text-slate-300"
                    }`}
                  >
                    {spin ? "Spinning" : "Static"}
                  </button>
                  <button
                    onClick={toggleFull}
                    className="rounded-md border border-white/15 bg-black/60 px-2 py-1 text-[10px] text-slate-300"
                  >
                    Exit
                  </button>
                </span>
              )}
              {selected?.layers && selected.layers.some(l => l.role === "subject" || l.role === "scene") ? (
                // A layered world. Preferred over the flat preview: it is the
                // same pixels, but it moves the way the scene was built.
                <ParallaxViewer key={selected.id} layers={selected.layers} />
              ) : view ? (
                <ModelViewer key={view} src={view} poster={selected?.preview ?? undefined} spin={spin} />
              ) : splatShowable && splat ? (
                <SplatViewer key={splat} src={splat} onFail={markSplatFailed} />
              ) : splat && splatSize === undefined ? (
                <div className="flex flex-col items-center gap-2 text-slate-600">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[10px]">checking the splat…</span>
                </div>
              ) : selected?.preview ? (
                // There is a picture but nothing to orbit. Show the picture,
                // and name the actual reason rather than "no GLB" — a splat is
                // not a failed mesh, it is a different kind of thing.
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={selected.preview} alt="" className="max-h-full max-w-full object-contain" />
                  <div className="absolute inset-x-2 bottom-2 flex items-end gap-2">
                    <span className="min-w-0 flex-1 rounded bg-black/80 px-2 py-1.5">
                      <span className="block text-[10px] font-semibold text-slate-200">
                        {whyNotViewable(selected, splatSize).headline}
                      </span>
                      <span className="block text-[9px] leading-snug text-slate-500">
                        {whyNotViewable(selected, splatSize).detail}
                      </span>
                    </span>
                    {(() => {
                      const main = selected.files.find(f => f.kind !== "preview")
                      return main ? (
                        <a
                          href={main.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 flex items-center gap-1 rounded-lg border border-white/15 bg-black/80 px-2 py-1.5 text-[10px] text-slate-200 transition-colors hover:border-red-400/40 hover:text-white"
                        >
                          <Download size={10} /> {(main.url.split("?")[0].split(".").pop() ?? "file").toUpperCase()}
                        </a>
                      ) : null
                    })()}
                  </div>
                </>
              ) : selected ? (
                // A finished asset that simply is not glTF. Saying which format
                // it is and what opens it beats an empty-bench message that
                // makes a successful render look like a lost one.
                (() => {
                  const why = whyNotViewable(selected, splatSize)
                  const main = selected.files.find(f => f.kind !== "preview") ?? selected.files[0]
                  return (
                    <div className="flex max-w-[320px] flex-col items-center gap-2 px-6 text-center">
                      <Box size={22} className="text-red-400/60" />
                      <span className="text-[12px] font-semibold text-slate-200">{why.headline}</span>
                      <span className="text-[10px] leading-snug text-slate-500">{why.detail}</span>
                      {main && (
                        <a
                          href={main.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[10px] text-slate-200 transition-colors hover:border-red-400/40 hover:text-white"
                        >
                          <Download size={10} /> Download the {(main.url.split("?")[0].split(".").pop() ?? "file").toUpperCase()}
                        </a>
                      )}
                    </div>
                  )
                })()
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 text-center text-slate-600">
                  <Box size={22} />
                  <span className="text-[11px]">Generated models appear here, orbitable.</span>
                </div>
              )}
            </div>

            {selected?.archive && selected.archive.length > 0 && (
              <div className="relative shrink-0 border-t border-white/5 px-3 pt-2">
                <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                  Inside the archive
                </span>
                <div className="flex flex-wrap gap-1">
                  {[...selected.archive]
                    .sort((a, b) => b.bytes - a.bytes)
                    .map(e => (
                      <span
                        key={e.name}
                        className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 text-[9px] text-slate-400"
                      >
                        <span className="truncate max-w-[150px]">{e.name}</span>
                        <span className="font-mono text-slate-600">
                          {e.bytes >= 1048576 ? `${(e.bytes / 1048576).toFixed(0)}MB` : `${Math.max(1, Math.round(e.bytes / 1024))}KB`}
                        </span>
                      </span>
                    ))}
                </div>
              </div>
            )}

            {selected && selected.files.length > 0 && (
              <div className="relative shrink-0 border-t border-white/5 px-3 py-2 flex flex-wrap gap-1">
                {/* Deduped here too: rows written before harvest() started
                    doing it still hold the same url under two kinds. */}
                {selected.files.filter((f, i, all) => all.findIndex(x => x.url === f.url) === i).map(f => (
                  <a
                    key={f.url}
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400 transition-colors hover:border-white/30 hover:text-slate-100"
                  >
                    <Download size={9} /> {f.kind}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* ── the library, which is also the input to the next step ─────── */}
          <div className="relative shrink-0 h-[122px] rounded-2xl silver-edge p-2 overflow-hidden">
            <div className="relative flex h-full gap-1.5 overflow-x-auto">
              {assets.length === 0 && jobs.length === 0 && failures.length === 0 && (
                <div className="flex w-full items-center justify-center text-[10px] text-slate-600">
                  Nothing built yet.
                </div>
              )}

              {/* One list, in submission order. These come from the database,
                  not from this tab, so they are still here after a refresh —
                  which is what the copy on the button promises. */}
              {strip.map(item => {
                if (item.kind === "job") {
                  const j = item.job
                  return (
                    <div
                      key={`job-${j.id}`}
                      title={`${tileCaption(j.prompt, j.modelId)} — ${j.modelId}`}
                      className="relative h-full w-[92px] shrink-0 overflow-hidden rounded-lg border border-red-400/30 bg-red-500/[0.06]"
                    >
                      <span className="absolute inset-x-0 top-0 z-10 truncate bg-black/75 px-1 py-0.5 text-left font-mono text-[8px] text-red-200/80">
                        {j.modelId}
                      </span>
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <Loader2 size={14} className="animate-spin text-red-300/80" />
                        <Elapsed since={j.startedAt} />
                      </span>
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/75 px-1 py-0.5 text-left text-[8px] text-slate-300">
                        {tileCaption(j.prompt, j.modelId)}
                      </span>
                    </div>
                  )
                }

                if (item.kind === "fail") {
                  const f = item.fail
                  return (
                    <button
                      key={`fail-${f.id}`}
                      onClick={() => setErrorDetail(f)}
                      title="What went wrong?"
                      className="group relative h-full w-[92px] shrink-0 overflow-hidden rounded-lg border border-red-500/40 bg-red-500/[0.1] text-left transition-colors hover:border-red-400/70"
                    >
                      <span className="absolute inset-x-0 top-0 z-10 truncate bg-black/75 px-1 py-0.5 text-left font-mono text-[8px] text-red-300/70">
                        {f.modelId}
                      </span>
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center">
                        <X size={14} className="text-red-400" />
                        <span className="text-[8px] leading-tight text-red-200/80">failed</span>
                        <span className="text-[7px] uppercase tracking-wide text-red-300/50 opacity-0 transition-opacity group-hover:opacity-100">
                          tap for why
                        </span>
                      </span>
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/75 px-1 py-0.5 text-left text-[8px] text-slate-300">
                        {tileCaption(f.prompt, f.modelId)}
                      </span>
                    </button>
                  )
                }

                const a = item.asset
                return (
                  <button
                    key={`asset-${a.id}`}
                    onClick={() => setSelected(a)}
                    title={`${tileCaption(a.prompt, a.modelId)} — ${a.modelId}`}
                    className={`relative h-full w-[92px] shrink-0 overflow-hidden rounded-lg border bg-black/40 transition-colors ${
                      selected?.id === a.id ? "border-red-400/60" : "border-white/10 hover:border-white/30"
                    }`}
                  >
                    {a.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.preview} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <Box size={16} className="absolute inset-0 m-auto text-slate-700" />
                    )}
                    {/* The model id on every tile, not just the selected one:
                        comparing two generations is the whole reason to keep
                        both, and you cannot compare what you cannot identify. */}
                    <span className="absolute inset-x-0 top-0 truncate bg-black/75 px-1 py-0.5 text-left font-mono text-[8px] text-red-200/80">
                      {a.modelId}
                    </span>
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/75 px-1 py-0.5 text-left text-[8px] text-slate-300">
                      {tileCaption(a.prompt, a.modelId)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {errorDetail && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setErrorDetail(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-red-500/30 bg-[#0e0e18] shadow-2xl"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2.5">
              <AlertTriangle size={13} className="text-red-400" />
              <span className="text-[12px] font-semibold text-slate-100">
                {THREED_MODELS.find(m => m.id === errorDetail.modelId)?.label ?? errorDetail.modelId} failed
              </span>
              <button
                onClick={() => setErrorDetail(null)}
                className="ml-auto rounded-md p-1 text-slate-500 transition-colors hover:text-white"
              >
                <X size={13} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {(() => {
                const read = readFailure(errorDetail.error)
                return read ? (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-2">
                    <p className="text-[11px] font-semibold text-amber-100">{read.headline}</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-amber-200/70">{read.fix}</p>
                  </div>
                ) : null
              })()}

              <div>
                <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                  What fal said
                </span>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-red-200/90">
                  {errorDetail.error}
                </pre>
              </div>

              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
                <span className="text-slate-600">Model</span>
                <span className="font-mono text-slate-300">{errorDetail.modelId}</span>
                {errorDetail.endpoint && (
                  <>
                    <span className="text-slate-600">Endpoint</span>
                    <span className="break-all font-mono text-slate-300">{errorDetail.endpoint}</span>
                  </>
                )}
                {errorDetail.falRequestId && (
                  <>
                    <span className="text-slate-600">Request</span>
                    <span className="break-all font-mono text-slate-500">{errorDetail.falRequestId}</span>
                  </>
                )}
                <span className="text-slate-600">Queued</span>
                <span className="text-slate-400">{new Date(errorDetail.queuedAt).toLocaleString()}</span>
                {errorDetail.failedAt && (
                  <>
                    <span className="text-slate-600">Ran for</span>
                    <span className="text-slate-400">
                      {Math.max(0, Math.round((Date.parse(errorDetail.failedAt) - Date.parse(errorDetail.queuedAt)) / 60000))} min
                    </span>
                  </>
                )}
              </div>

              {errorDetail.inputs.length > 0 && (
                <div>
                  <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                    What it was given
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {[...new Set(errorDetail.inputs)].map(u => (
                      <a
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="h-12 w-12 overflow-hidden rounded-md border border-white/10 transition-colors hover:border-white/30"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u} alt="" className="h-full w-full object-cover" />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-white/10 px-3 py-2">
              <button
                onClick={() => {
                  const lines = [
                    "model: " + errorDetail.modelId,
                    errorDetail.endpoint ? "endpoint: " + errorDetail.endpoint : "",
                    errorDetail.falRequestId ? "request: " + errorDetail.falRequestId : "",
                    "error: " + errorDetail.error,
                  ].filter(Boolean)
                  void navigator.clipboard?.writeText(lines.join("\n"))
                }}
                className="w-full rounded-lg border border-white/15 py-1.5 text-[10px] text-slate-300 transition-colors hover:border-white/30 hover:text-white"
              >
                Copy the details
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {meshPickerOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setMeshPickerOpen(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0e0e18] shadow-2xl"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2.5">
              <Box size={13} className="text-red-400/70" />
              <span className="text-[12px] font-semibold text-slate-100">Choose a source mesh</span>
              <button
                onClick={() => meshRef.current?.click()}
                disabled={meshBusy}
                className="ml-auto flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[10px] text-slate-300 transition-colors hover:border-red-400/40 hover:text-white"
              >
                {meshBusy ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />} Upload a file
              </button>
              <button
                onClick={() => setMeshPickerOpen(false)}
                className="rounded-md p-1 text-slate-500 transition-colors hover:text-white"
              >
                <X size={13} />
              </button>
            </div>

            <div className="relative shrink-0 border-b border-white/10 px-3 py-2">
              <Search size={11} className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                value={meshQuery}
                onChange={e => setMeshQuery(e.target.value)}
                placeholder="Filter by name…"
                className="w-full rounded-lg bg-black/40 border border-white/10 py-1 pl-6 pr-2 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-white/30"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {meshGroups.every(g => g.items.length === 0) ? (
                <div className="py-10 text-center text-[11px] leading-relaxed text-slate-500">
                  {libraryLoading
                    ? "Reading your library…"
                    : meshQuery
                      ? "Nothing matches that."
                      : "No meshes yet. Generate one on this bench, or upload a .glb / .obj / .stl / .fbx."}
                </div>
              ) : meshGroups.map(group => group.items.length > 0 && (
                <div key={group.title} className="mb-3 last:mb-0">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                      {group.title}
                    </span>
                    <span className="font-mono text-[9px] text-slate-700">{group.items.length}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    {group.items.map(m => (
                      <button
                        key={m.url}
                        onClick={() => { setPickedMesh(m); setMeshPickerOpen(false) }}
                        title={m.label}
                        className={`group relative overflow-hidden rounded-lg border bg-black/40 text-left transition-colors ${
                          sourceMesh === m.url
                            ? "border-red-400/70 ring-1 ring-red-400/30"
                            : "border-white/10 hover:border-white/30"
                        }`}
                      >
                        <span className="flex aspect-square items-center justify-center">
                          {m.preview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.preview} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex flex-col items-center gap-1">
                              <Box size={16} className="text-slate-600 transition-colors group-hover:text-red-400/70" />
                              <span className="font-mono text-[8px] text-slate-700">{m.detail}</span>
                            </span>
                          )}
                        </span>
                        <span className="block truncate border-t border-white/5 bg-black/60 px-1.5 py-1 text-[9px] text-slate-300">
                          {m.label}
                        </span>
                        {sourceMesh === m.url && (
                          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500">
                            <Check size={9} className="text-white" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * A layered world, moved under the pointer.
 *
 * Hunyuan World's actual geometry is ~23 million triangles across four PLY
 * layers totalling 850MB, which no browser will open. But the archive also
 * carries the plates that geometry was built from — an inpainted sky, the
 * scene with its subjects removed, and a cut-out per subject — and sliding
 * those against each other gives back the depth the meshes encode, for about
 * 370KB.
 *
 * The throw is deliberately small. Each plate is flat, and the backdrop behind
 * a subject is inpainted guesswork; push the parallax far and the guess slides
 * out from behind the subject it was invented to hide. A few percent reads as
 * depth, and never exposes that.
 */
function ParallaxViewer({
  layers,
  className = "",
}: {
  layers: { url: string; role: string; depth: number; label?: string }[]
  className?: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  // -1..1 on each axis, from the centre of the frame.
  const [aim, setAim] = useState({ x: 0, y: 0 })
  const [engaged, setEngaged] = useState(false)

  const track = useCallback((clientX: number, clientY: number) => {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box) return
    setAim({
      x: Math.max(-1, Math.min(1, ((clientX - box.left) / box.width) * 2 - 1)),
      y: Math.max(-1, Math.min(1, ((clientY - box.top) / box.height) * 2 - 1)),
    })
  }, [])

  /*
   * On a tablet there is no pointer to follow, so the device's own tilt drives
   * it instead — which is the more natural gesture for looking into a scene
   * anyway. iOS demands an explicit permission call for motion events, and
   * only from a user gesture; if it is refused the frame simply sits still.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return
    let live = true
    const onTilt = (e: DeviceOrientationEvent) => {
      if (!live || e.gamma == null || e.beta == null) return
      setAim({
        x: Math.max(-1, Math.min(1, e.gamma / 35)),
        y: Math.max(-1, Math.min(1, (e.beta - 45) / 35)),
      })
    }
    window.addEventListener("deviceorientation", onTilt)
    return () => { live = false; window.removeEventListener("deviceorientation", onTilt) }
  }, [])

  // How far the nearest plate travels, as a share of the frame.
  const THROW = 2.4

  return (
    <div
      ref={frameRef}
      onMouseMove={e => { setEngaged(true); track(e.clientX, e.clientY) }}
      onMouseLeave={() => { setEngaged(false); setAim({ x: 0, y: 0 }) }}
      onTouchMove={e => {
        const t = e.touches[0]
        if (t) { setEngaged(true); track(t.clientX, t.clientY) }
      }}
      onTouchEnd={() => setAim({ x: 0, y: 0 })}
      className={`relative h-full w-full overflow-hidden ${className}`}
    >
      {layers.map(layer => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={layer.url}
          src={layer.url}
          alt={layer.label ?? layer.role}
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover will-change-transform"
          style={{
            /* Each plate is blown up slightly so shifting it never drags an
               edge into frame. Deeper plates move less, which is the whole
               illusion. */
            transform: `scale(${1 + THROW / 100 + layer.depth * 0.02}) translate(${
              -aim.x * layer.depth * THROW
            }%, ${-aim.y * layer.depth * THROW * 0.6}%)`,
            transition: engaged ? "transform 120ms ease-out" : "transform 600ms ease-out",
            zIndex: Math.round(layer.depth * 10),
          }}
        />
      ))}

      <span className="pointer-events-none absolute bottom-2 left-2 z-20 rounded bg-black/70 px-2 py-1 text-[9px] text-slate-400">
        {layers.length} layers · move to look around
      </span>
    </div>
  )
}

/**
 * A Gaussian splat, rendered in WebGL.
 *
 * Splats are not geometry — they are millions of oriented, coloured blobs —
 * so no glTF viewer will ever show one. The renderer is pulled from a CDN at
 * mount for the same reason model-viewer is: it is a large dependency that
 * exactly one admin page uses, and bundling it would tax every other page.
 *
 * esm.sh is asked to bundle three.js in (`?bundle`) rather than declaring it
 * as a bare import. A bare `three` specifier would need an import map, and an
 * import map injected after the page's own modules have loaded is not reliable
 * across browsers — Safari in particular.
 *
 * `sharedMemoryForWorkers: false` is required: the shared-memory path needs
 * COOP/COEP headers this app does not send, and without the flag the viewer
 * throws on construction.
 */
function SplatViewer({ src, onFail }: { src: string; onFail: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [pct, setPct] = useState(0)

  useEffect(() => {
    let cancelled = false
    let viewer: { dispose?: () => void; start?: () => void; addSplatScene?: (u: string, o: unknown) => Promise<void> } | null = null
    /*
     * The renderer gets its OWN node, created outside React.
     *
     * It builds a canvas and its own controls inside whatever root it is
     * given, and tears them down on dispose. Pointed at a React-rendered
     * element, the two fight over the same children: switching away from a
     * splat threw "removeChild: the node to be removed is not a child of this
     * node", because React went to remove a child the renderer had already
     * taken. Giving it a node React has never heard of removes the conflict
     * entirely rather than trying to sequence the two teardowns.
     */
    const host = hostRef.current
    const mount = document.createElement("div")
    mount.style.width = "100%"
    mount.style.height = "100%"
    host?.appendChild(mount)

    void (async () => {
      try {
        // Held in a variable so TypeScript does not try to resolve a URL as a
        // module path, and so no bundler attempts to inline a CDN dependency.
        const cdn = "https://esm.sh/@mkkellogg/gaussian-splats-3d@0.4.7?bundle&target=es2022"
        const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ cdn)
        if (cancelled || !hostRef.current) return
        const Viewer = (mod as { Viewer: new (o: unknown) => typeof viewer }).Viewer
        viewer = new Viewer({
          rootElement: mount,
          selfDrivenMode: true,
          useBuiltInControls: true,
          sharedMemoryForWorkers: false,
          dynamicScene: false,
          antialiased: true,

        })
        await viewer!.addSplatScene!(src, {
          progressiveLoad: true,
          onProgress: (p: number) => { if (!cancelled) setPct(Math.round(p)) },
        })
        if (cancelled) return
        viewer!.start!()
        setReady(true)
      } catch (err) {
        console.error("[splat viewer]", err)
        if (!cancelled) onFail()
      }
    })()

    return () => {
      cancelled = true
      try { viewer?.dispose?.() } catch { /* already torn down */ }
      // Ours to remove, and only if the renderer has not already done it.
      try {
        if (mount.parentNode === host) host?.removeChild(mount)
      } catch { /* nothing left to detach */ }
    }
  }, [src, onFail])

  return (
    <div className="absolute inset-0">
      {/* Empty by design: everything inside is created and destroyed by the
          renderer, so React must never think it owns a child here. */}
      <div ref={hostRef} className="h-full w-full" />
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-slate-400">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-[10px]">
            {pct > 0 ? `loading the splat — ${pct}%` : "starting the splat renderer…"}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * An orbitable GLB, on Google's model-viewer element.
 *
 * Loaded from a CDN at mount rather than bundled: it is a ~300KB web component
 * that only this one admin page uses, and adding three.js to the app bundle to
 * spin a mesh would cost every other page for nothing. The custom element
 * upgrades itself once the script lands, so the tag can be rendered before it
 * is defined.
 */
function ModelViewer({ src, poster, spin = true }: { src: string; poster?: string; spin?: boolean }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (customElements.get("model-viewer")) { setReady(true); return }
    const existing = document.querySelector<HTMLScriptElement>("script[data-model-viewer]")
    if (existing) {
      existing.addEventListener("load", () => setReady(true))
      return
    }
    const s = document.createElement("script")
    s.type = "module"
    s.dataset.modelViewer = "1"
    s.src = "https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"
    s.onload = () => setReady(true)
    document.head.appendChild(s)
  }, [])

  if (!ready) {
    return (
      <div className="flex flex-col items-center gap-2 text-slate-600">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-[10px]">loading the viewer…</span>
      </div>
    )
  }

  // auto-rotate is presence-based, so it has to be ABSENT rather than false
  // when the turntable is off — hence the spread instead of an attribute.
  return (
    // @ts-expect-error — a custom element, not a React intrinsic
    <model-viewer
      src={src}
      poster={poster}
      camera-controls
      {...(spin ? { "auto-rotate": true } : {})}
      touch-action="pan-y"
      shadow-intensity="1"
      exposure="1"
      style={{ width: "100%", height: "100%", backgroundColor: "#000" }}
    />
  )
}


/**
 * The model picker, grouped by who makes it.
 *
 * A flat list of twenty-five names in a select is unusable when the names are
 * things like "Hunyuan 3D 3.1 Rapid" and "Tripo H3.1" \u2014 you cannot tell what
 * is a family, what is a tier, or what any of it costs. Grouping by vendor the
 * way the image taskbar does turns it into a decision: pick a family you trust,
 * then a tier within it, with the price on the row.
 *
 * Rendered in a portal at fixed coordinates for the same reason the site's
 * other dropdown is: every panel here has overflow-hidden and would clip it.
 */
function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ThreeDModel[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = models.find(m => m.id === value)

  const families = useMemo(() => {
    const by = new Map<string, ThreeDModel[]>()
    for (const m of models) {
      if (!by.has(m.family)) by.set(m.family, [])
      by.get(m.family)!.push(m)
    }
    return [...by.entries()]
  }, [models])

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const wanted = Math.min(families.length * 96 + models.length * 34, 420)
    const below = window.innerHeight - r.bottom - 8
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 280) - 8)),
      top: below < wanted && r.top > below ? Math.max(8, r.top - wanted - 4) : r.bottom + 4,
      width: Math.max(r.width, 280),
    })
  }, [families.length, models.length])

  useEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("pointerdown", down)
    document.addEventListener("keydown", key)
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      document.removeEventListener("pointerdown", down)
      document.removeEventListener("keydown", key)
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
          open ? "border-red-400/50 bg-black/60" : "border-white/10 bg-black/40 hover:border-white/25"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-slate-100">{active?.label ?? "Pick a model"}</span>
          <span className="block text-[9px] uppercase tracking-wider text-slate-600">
            {active?.family ?? ""}{active?.usd != null ? ` · $${active.usd}` : ""}
          </span>
        </span>
        <ChevronDown size={11} className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, zIndex: 10000 }}
          className="max-h-[420px] overflow-y-auto rounded-xl border border-white/15 bg-[#0e0e18] py-1 shadow-2xl"
        >
          {families.map(([family, list]) => (
            <div key={family} className="px-1 py-0.5">
              <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-red-300/70">
                {family}
              </div>
              {list.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setOpen(false) }}
                  className={`flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    m.id === value ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  <span className="mt-[3px] w-3 shrink-0">
                    {m.id === value && <Check size={10} className="text-red-300" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[11px] text-slate-100">{m.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-500">
                        {m.usd != null ? `$${m.usd}` : "—"}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[9px] leading-snug text-slate-600 line-clamp-2">
                      {m.bestFor}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}


/**
 * Downscale an image so the reference endpoint will take it.
 *
 * 2048px on the long edge at q0.86 lands a phone photo comfortably under the
 * 15MB ceiling while keeping far more detail than the 3D models can use.
 * Anything already small enough is passed through untouched, and if the canvas
 * work fails for any reason the original is sent rather than nothing \u2014 a
 * server-side rejection is a better outcome than a silent drop.
 */
async function shrinkForUpload(file: File, maxEdge = 2048, quality = 0.86): Promise<File | Blob> {
  if (!file.type.startsWith("image/") || file.size < 4 * 1024 * 1024) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 14 * 1024 * 1024) { bmp.close(); return file }
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) { bmp.close(); return file }
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/jpeg", quality))
    return blob ?? file
  } catch {
    return file
  }
}


/** How long a running job has been going, ticking. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const started = Date.parse(since)
  const secs = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0
  return (
    <span className="font-mono text-[9px] text-red-200/70">
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
    </span>
  )
}
