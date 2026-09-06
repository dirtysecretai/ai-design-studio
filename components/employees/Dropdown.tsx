"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Check } from "lucide-react"

/**
 * The site's own dropdown.
 *
 * Two problems with the obvious implementations:
 *  - a native <select> hands iPad Safari its full-screen system picker, which
 *    looks nothing like the page and covers the panel you were reading;
 *  - an absolutely-positioned menu is CLIPPED by any ancestor with
 *    overflow-hidden, and every panel here has one — the list was cut off at
 *    the bottom of its card.
 *
 * So the menu renders in a portal at fixed coordinates measured from the
 * button, and flips above it when there is more room up than down.
 */
export function Dropdown({
  value,
  options,
  onChange,
  disabled,
  className = "",
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; drop: "down" | "up" } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find(o => o.value === value)

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Roughly how tall the list wants to be, capped like the menu itself
    const wanted = Math.min(options.length * 28 + 8, 224)
    const below = window.innerHeight - r.bottom - 8
    const drop: "down" | "up" = below < wanted && r.top > below ? "up" : "down"
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 120) - 8)),
      top: drop === "down" ? r.bottom + 4 : Math.max(8, r.top - wanted - 4),
      width: Math.max(r.width, 120),
      drop,
    })
  }, [options.length])

  useLayoutEffect(() => { if (open) place() }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    // Any scroll or resize moves the button, so the menu has to follow or close
    const onMove = () => place()
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", onMove)
    window.addEventListener("scroll", onMove, true)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onMove)
      window.removeEventListener("scroll", onMove, true)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] transition-colors ${className} ${
          disabled
            ? "border-white/10 bg-black/30 text-slate-600 cursor-not-allowed"
            : open
              ? "border-white/30 bg-black/60 text-slate-100"
              : "border-white/10 bg-black/40 text-slate-200 hover:border-white/25"
        }`}
      >
        <span className="flex-1 min-w-0 truncate text-left">{current?.label ?? value}</span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: pos.width, zIndex: 10000 }}
          className="max-w-[240px] max-h-56 overflow-y-auto rounded-lg border border-white/15 bg-[#0e0e18] shadow-2xl py-1"
        >
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false) }}
              className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] transition-colors ${
                o.value === value
                  ? "bg-white/10 text-white"
                  : "text-slate-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="w-3 shrink-0">
                {o.value === value && <Check size={10} className="text-cyan-300" />}
              </span>
              <span className="truncate">{o.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
