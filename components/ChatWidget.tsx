"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { X, Send, ImagePlus, Trash2, Bot, ChevronRight } from "lucide-react"
import { SiteLogoBox } from "@/components/SitePageHeader"

interface Part {
  type: 'text' | 'image'
  text?: string
  mimeType?: string
  data?: string
}

interface Message {
  id: string
  role: 'user' | 'model'
  content: string | Part[]
  displayText?: string
  imageCount?: number
}

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="bg-white/10 px-1 py-0.5 rounded text-slate-200 text-[11px]">$1</code>')
    .replace(/^### (.+)$/gm, '<div class="font-bold text-white text-[11px] mt-2 mb-0.5">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="font-bold text-white text-xs mt-2 mb-1">$1</div>')
    .replace(/^- (.+)$/gm, '<div class="flex gap-1.5 items-start"><span class="text-slate-500 mt-0.5 shrink-0">•</span><span>$1</span></div>')
    .replace(/^\d+\. (.+)$/gm, '<div class="flex gap-1.5 items-start"><span class="text-slate-500 mt-0.5 shrink-0">›</span><span>$1</span></div>')
    .replace(/^---$/gm, '<hr class="border-white/10 my-2" />')
    .replace(/\n/g, '<br/>')
}

const WELCOME: Message = {
  id: 'welcome',
  role: 'model',
  content: "Hi! I'm your AI Design Studio guide. Ask me anything — how to use a model, recommend a workflow, what tickets cost, or how to navigate the site. You can also paste a screenshot and I'll help explain what you're seeing.",
}

// The Guide is a right-edge tab that opens a slide-in drawer — the SAME pattern
// on every screen size (the old desktop bottom-right pill overlapped the prompt
// box's Generate button). `sideTabOnly` is kept for call-site compatibility but
// no longer changes behavior.
export default function ChatWidget({ sideTabOnly = false }: { sideTabOnly?: boolean }) {
  void sideTabOnly
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([WELCOME])
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<{ mimeType: string; data: string; previewUrl: string }[]>([])
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
        inputRef.current?.focus()
      }, 300)
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (pendingImages.length >= 2) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const [meta, data] = dataUrl.split(',')
      const mimeType = meta.split(':')[1]?.split(';')[0] || 'image/jpeg'
      setPendingImages(prev => [...prev, { mimeType, data, previewUrl: dataUrl }])
    }
    reader.readAsDataURL(file)
  }, [pendingImages.length])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) handleImageFile(file)
      }
    }
  }, [handleImageFile])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text && pendingImages.length === 0) return
    if (streaming) return

    const userMsgId = `user-${Date.now()}`
    let userContent: string | Part[]
    const imageCount = pendingImages.length

    if (pendingImages.length > 0) {
      const parts: Part[] = pendingImages.map(img => ({
        type: 'image' as const,
        mimeType: img.mimeType,
        data: img.data,
      }))
      if (text) parts.push({ type: 'text', text })
      userContent = parts
    } else {
      userContent = text
    }

    const userMsg: Message = { id: userMsgId, role: 'user', content: userContent, displayText: text, imageCount }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setPendingImages([])
    setStreaming(true)

    const assistantMsgId = `assistant-${Date.now()}`
    setMessages(prev => [...prev, { id: assistantMsgId, role: 'model', content: '' }])

    try {
      const history = [...messages, userMsg]
        .filter(m => m.id !== 'welcome')
        .map(m => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })

      if (!res.ok) {
        const err = await res.json()
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: `Sorry, something went wrong: ${err.error || 'Unknown error'}` } : m
        ))
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += decoder.decode(value, { stream: true })
        const current = accumulated
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, content: current } : m
        ))
      }
    } catch {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, content: 'Sorry, I ran into an error. Please try again.' } : m
      ))
    } finally {
      setStreaming(false)
    }
  }, [input, pendingImages, streaming, messages])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const clearHistory = () => setMessages([WELCOME])

  // ── Shared panel content ──────────────────────────────────────────────────
  const panelContent = (
    <>
      {/* Header — synced site logo in the silver rim, like the site's menus */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-white/[0.02] shrink-0">
        <div className="flex items-center gap-2.5">
          <SiteLogoBox size={24} rounded={8} />
          <div>
            <p className="text-[12px] font-bold text-white leading-none">Studio Guide</p>
            <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-slate-500 leading-none mt-1">AI Assistant</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={clearHistory} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-slate-300 transition-colors" title="Clear history">
            <Trash2 size={13} />
          </button>
          <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors" aria-label="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'model' && (
              <div className="w-6 h-6 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center shrink-0 mt-0.5">
                <Bot size={12} className="text-slate-200" />
              </div>
            )}
            <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-white/10 border border-white/20 text-slate-100 rounded-tr-sm'
                : 'bg-white/4 border border-white/8 text-slate-300 rounded-tl-sm'
            }`}>
              {msg.role === 'user' && (msg.imageCount ?? 0) > 0 && (
                <div className="mb-1.5 text-[10px] text-slate-400 flex items-center gap-1">
                  <ImagePlus size={10} />
                  {msg.imageCount} image{msg.imageCount! > 1 ? 's' : ''} attached
                </div>
              )}
              {(() => {
                const text = typeof msg.content === 'string'
                  ? msg.content
                  : msg.displayText || (Array.isArray(msg.content)
                      ? (msg.content as Part[]).find(p => p.type === 'text')?.text || ''
                      : '')
                if (!text && msg.role === 'model' && streaming) {
                  return (
                    <span className="inline-flex gap-1 items-center">
                      <span className="w-1 h-1 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1 h-1 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1 h-1 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                  )
                }
                if (msg.role === 'model' && text) {
                  return <div className="prose-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
                }
                return <span>{text}</span>
              })()}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Pending images */}
      {pendingImages.length > 0 && (
        <div className="px-4 pb-1 flex gap-2 shrink-0">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/25">
              <img src={img.previewUrl} alt="attachment" className="w-full h-full object-cover" />
              <button onClick={() => setPendingImages(prev => prev.filter((_, idx) => idx !== i))} className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 flex items-center justify-center">
                <X size={8} className="text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-2 border-t border-white/6 shrink-0">
        <div className="flex items-end gap-2 bg-white/4 border border-white/10 rounded-xl px-3 py-2 focus-within:border-white/25 transition-colors">
          <button onClick={() => fileInputRef.current?.click()} className="text-slate-600 hover:text-slate-400 transition-colors shrink-0 pb-0.5" disabled={pendingImages.length >= 2} title="Attach image">
            <ImagePlus size={15} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask anything… or paste a screenshot"
            rows={1}
            disabled={streaming}
            className="flex-1 bg-transparent text-[12px] text-white placeholder-slate-600 outline-none resize-none max-h-24 leading-relaxed disabled:opacity-50"
            style={{ fieldSizing: 'content' } as any}
          />
          <button onClick={send} disabled={streaming || (!input.trim() && pendingImages.length === 0)} className="shrink-0 pb-0.5 text-slate-200 hover:text-white disabled:text-slate-700 disabled:cursor-not-allowed transition-colors">
            <Send size={15} />
          </button>
        </div>
        <p className="text-[9px] text-slate-700 text-center mt-1.5">Enter to send · Shift+Enter for newline</p>
      </div>
    </>
  )

  return (
    <>
      {/* ══════════════════════════════════════════════════════════
          ALL DEVICES: right-edge tab → slide-in drawer + backdrop.
          (One pattern everywhere — the old desktop bottom-right pill
          sat on top of the prompt box's Generate button.)
      ══════════════════════════════════════════════════════════ */}

      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setOpen(false)}
      />

      {/* Side tab (visible when closed) — synced logo + animated silver rim.
          isolate + -z-10 keeps the spinner under the content (Safari). */}
      <div
        className={`fixed right-0 top-1/2 -translate-y-1/2 z-50 transition-opacity duration-200 ${open ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      >
        <div className="relative isolate rounded-l-2xl overflow-hidden p-[1.5px] pr-0 shadow-lg shadow-black/40">
          <span
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 aspect-square w-[300%] animate-spin pointer-events-none -z-10"
            style={{
              background:
                "conic-gradient(from 0deg, rgba(226,232,240,0.1), #f8fafc, #94a3b8, rgba(226,232,240,0.15), #cbd5e1, #64748b, rgba(226,232,240,0.1))",
              animationDuration: "5s",
            }}
          />
          <button
            onClick={() => setOpen(true)}
            className="relative flex flex-col items-center gap-2 px-1.5 py-3.5 rounded-l-[14px] bg-[#070b14]/95 backdrop-blur-sm text-slate-300 hover:text-white transition-colors"
            aria-label="Open AI Guide"
          >
            <SiteLogoBox size={22} rounded={7} />
            {/* Silver-shimmer title — same treatment as the taskbar Image/Video buttons */}
            <span
              className="text-[10px] font-extrabold tracking-widest uppercase silver-shimmer-text whitespace-nowrap shrink-0 leading-none"
              // The tab reads bottom-to-top; the class composites with
              // translateZ(0), so the rotation has to carry it along or the
              // layer promotion is lost.
              style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg) translateZ(0)' }}
            >
              AI Guide
            </span>
            <ChevronRight size={11} className="text-slate-600" />
          </button>
        </div>
      </div>

      {/* Slide-in drawer */}
      <div
        className={`fixed top-0 bottom-0 right-0 z-50 w-[85vw] max-w-[360px] flex flex-col bg-[#070b14]/95 backdrop-blur-xl border-l border-white/[0.08] shadow-2xl shadow-black/60 transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {panelContent}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0]
          if (file) handleImageFile(file)
          e.target.value = ''
        }}
      />
    </>
  )
}
