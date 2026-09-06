"use client"

import { useRef, useState } from "react"
import { Loader2, Plus, X, ScanFace, User } from "lucide-react"
import { SilverRimOverlay } from "@/components/home/SilverRimOverlay"
import { SiteLogoBox } from "@/components/SitePageHeader"

/**
 * Face Swap Studio, as two boxes and a button.
 *
 * The chat employee spends its first turn working out which photo is the face
 * donor and which supplies the body. Here that question cannot exist: the box
 * the user drops the image in IS the answer. So there is no prompt, no
 * settings, and one action.
 */

type Slot = { url: string } | null

function UploadSlot({
  label, hint, icon: Icon, value, onChange, disabled,
}: {
  label: string
  hint: string
  icon: typeof User
  value: Slot
  onChange: (v: Slot) => void
  disabled: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/upload-reference", { method: "POST", body: fd })
      if (!res.ok) return
      const { url } = await res.json()
      if (typeof url === "string") onChange({ url })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-slate-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      </div>
      <button
        onClick={() => !disabled && inputRef.current?.click()}
        disabled={disabled || busy}
        className="relative w-full aspect-square rounded-xl border border-dashed border-white/15 bg-white/[0.02] overflow-hidden hover:border-white/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {value ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value.url} alt="" className="w-full h-full object-cover" />
            {!disabled && (
              <span
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); onChange(null) }}
                onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); onChange(null) } }}
                className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/70 text-white/80 hover:text-white cursor-pointer"
              >
                <X size={12} />
              </span>
            )}
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-slate-500">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
            <span className="text-[10px] px-3 text-center leading-snug">{hint}</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={e => { void pick(e.target.files?.[0]); e.currentTarget.value = "" }}
      />
    </div>
  )
}

export function FaceSwapWorkspace({
  signedIn,
  renderFeed,
}: {
  signedIn: boolean
  /** The portal's own session feed, so this matches the rest of the site. */
  renderFeed: (kind: "image" | "video", nonce?: number) => React.ReactNode
}) {
  const [face, setFace] = useState<Slot>(null)
  const [bodyImg, setBodyImg] = useState<Slot>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedKey, setFeedKey] = useState(0)

  const run = async () => {
    if (!face || !bodyImg || running) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch("/api/employees/face-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faceUrl: face.url, bodyUrl: bodyImg.url }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || `Failed (${res.status})`)
      // It lands in the feed like any other generation
      setFeedKey(k => k + 1)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col lg:flex-row gap-3 h-full min-h-0 px-3 sm:px-4 pb-4">
      <div className="w-full lg:w-[320px] shrink-0 flex flex-col gap-3">
        <div className="relative rounded-2xl border border-white/10 bg-white/[0.02] p-3 overflow-hidden">
          <SilverRimOverlay />
          <div className="relative flex gap-3">
            <UploadSlot
              label="Face"
              hint="The face and hair to use"
              icon={ScanFace}
              value={face}
              onChange={setFace}
              disabled={running}
            />
            <UploadSlot
              label="Body"
              hint="The photo that keeps its body and outfit"
              icon={User}
              value={bodyImg}
              onChange={setBodyImg}
              disabled={running}
            />
          </div>
          {(() => {
            const ready = !!face && !!bodyImg && !running && signedIn
            return (
              <button
                onClick={() => void run()}
                disabled={!ready}
                className={`relative overflow-hidden mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-bold transition-all ${
                  ready
                    ? "bg-white/10 border border-white/25 text-white hover:bg-white/15 hover:border-white/40"
                    : "bg-white/5 text-slate-600 cursor-not-allowed border border-white/10"
                }`}
              >
                {ready && (
                  <span
                    className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent pointer-events-none"
                    style={{ animation: "sheen-sweep 2.6s infinite" }}
                  />
                )}
                {running
                  ? <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  : <SiteLogoBox size={14} rounded={4} />}
                {running ? "Swapping…" : "Generate"}
              </button>
            )
          })()}
          {error && (
            <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/[0.08] p-2 text-[11px] text-red-200">
              {error}
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            Works best when both photos share a similar head angle. The result lands in your feed.
          </p>
        </div>
      </div>

      <div className="relative flex-1 min-w-0 flex flex-col min-h-0 rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <SilverRimOverlay />
        <div className="shrink-0 px-3 py-1.5 border-b border-white/5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Results</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">{renderFeed("image", feedKey)}</div>
      </div>
    </div>
  )
}
