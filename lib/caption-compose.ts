// Composable training captions.
//
// A training .txt is built from up to four pieces, toggled PER IMAGE via
// GeneratedImage.captionSections:
//   1. the AutoFill/admin caption (always the base — falls back to a caller-
//      supplied default when empty)
//   2. the original user prompt        (sections.prompt)
//   3. a hand-written curator note     (sections.noteOn + sections.note)
//   4. the admin tags                  (sections.tags)
//
// Style (user-decided): CLEAN sections joined by blank lines — no labels, no
// meta-commentary. Identical boilerplate in every file would train noise;
// the pieces themselves are the signal.
//
// captionSections absent/null → base caption only (the long-standing default).

export interface CaptionSections {
  prompt?: boolean
  tags?: boolean
  noteOn?: boolean
  note?: string
}

export function normalizeCaptionSections(raw: unknown): CaptionSections | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const out: CaptionSections = {}
  if (o.prompt === true) out.prompt = true
  if (o.tags === true) out.tags = true
  if (o.noteOn === true) out.noteOn = true
  if (typeof o.note === 'string') out.note = o.note.slice(0, 4000)
  return Object.keys(out).length > 0 ? out : null
}

export function composeTrainingCaption(args: {
  adminCaption?: string | null
  prompt?: string | null
  adminTags?: string[] | null
  sections?: CaptionSections | null
  /** used when adminCaption is empty (e.g. lora prepare's default_caption) */
  fallbackCaption?: string | null
}): string {
  const { sections } = args
  const parts: string[] = []

  const base = (args.adminCaption ?? '').trim() || (args.fallbackCaption ?? '').trim()
  if (base) parts.push(base)

  if (sections?.prompt) {
    const p = (args.prompt ?? '').trim()
    if (p) parts.push(p)
  }
  if (sections?.noteOn) {
    const n = (sections.note ?? '').trim()
    if (n) parts.push(n)
  }
  if (sections?.tags) {
    const t = (args.adminTags ?? []).map(s => s.trim()).filter(Boolean)
    if (t.length > 0) parts.push(t.join(', '))
  }

  return parts.join('\n\n')
}
