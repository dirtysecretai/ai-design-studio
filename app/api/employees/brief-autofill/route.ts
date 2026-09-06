import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import { movieFormatById, audioPlanById } from '@/lib/chat-hub-skills'

/**
 * Write the brief for the user.
 *
 * The Movie Studio's brief box is the one place a run can be won or lost, and
 * a blank box in front of a production tool is a hard start. This looks at the
 * SAME things the employee will: the reference images, the output settings,
 * whatever the user has already typed, and — once a film exists — what was
 * actually made. Then it writes the brief, or rewrites the draft, at the level
 * of detail the employee works best from.
 *
 * Deliberately a small, cheap, direct Gemini call rather than a chat run: it
 * writes ONE paragraph and spends no tickets.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL = 'gemini-3.7-flash'
const TIMEOUT_MS = 30_000
/**
 * Room for the answer, and for the thinking in front of it.
 *
 * This was 400, which is generous for a 110-word paragraph and nowhere near
 * enough for a REASONING model: Gemini 3.x spends output tokens thinking
 * before it writes, so the budget was consumed before the brief was, and the
 * paragraph came back sliced mid-sentence. It also explains the 30-45s wait —
 * the model was thinking the whole time.
 */
const MAX_OUTPUT = 2048
/** References are context, not the deliverable — small is fine and fast. */
const REF_EDGE = 512
const MAX_REFS = 4

export const runtime = 'nodejs'
export const maxDuration = 60

/** A reference as Gemini wants it: base64 JPEG, downscaled hard. */
async function inlineRef(url: string): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const small = await sharp(buf)
      .resize({ width: REF_EDGE, height: REF_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer()
    return { inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }
  } catch {
    return null
  }
}

/** What this film has actually done so far, if it has done anything. */
async function filmContext(chatId: number, userId: number): Promise<string> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    select: { id: true, title: true },
  })
  if (!chat) return ''

  const rows = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { id: 'asc' },
    select: { role: true, content: true, metadata: true },
  })
  if (rows.length === 0) return ''

  let cut: string | null = null
  let landed = 0
  let outstanding = 0
  let planSteps: string[] = []
  const briefs: string[] = []

  for (const m of rows) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      briefs.push(m.content.replace(/\s+/g, ' ').trim().slice(0, 400))
    }
    const meta = (m.metadata ?? {}) as Record<string, any>
    for (const st of ((meta.agentSteps ?? []) as any[])) {
      if (st?.tool === 'assemble_film' && st.status === 'done' && st.imageUrl) cut = st.imageUrl
      if (st?.tool === 'propose_plan' && Array.isArray(st.input?.steps)) {
        planSteps = (st.input.steps as unknown[]).map(String)
      }
      if (st?.tool === 'render_shots' && Array.isArray(st.queueIds)) {
        const res = st.shotResults ?? {}
        for (const q of st.queueIds) {
          if (res[String(q)] === undefined) outstanding++
          else if (!String(res[String(q)]).startsWith('ERROR:')) landed++
        }
      }
    }
  }

  const parts: string[] = [`FILM SO FAR — "${chat.title}".`]
  if (briefs.length) parts.push(`Earlier brief(s) from the user: ${briefs.slice(-3).join(' // ')}`)
  if (planSteps.length) parts.push(`The approved plan was: ${planSteps.slice(0, 14).join('; ')}`)
  parts.push(
    cut
      ? `A cut EXISTS (${landed} shots landed${outstanding ? `, ${outstanding} still rendering` : ''}). `
        + 'So this brief is an EDIT of an existing film, not a new one.'
      : `No cut yet (${landed} shots landed${outstanding ? `, ${outstanding} rendering` : ''}).`,
  )
  return parts.join('\n')
}

export async function POST(req: NextRequest) {
  const user = await requireChatHubAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!GEMINI_API_KEY) return NextResponse.json({ error: 'No Gemini key configured' }, { status: 500 })

  const body = await req.json().catch(() => ({})) as Record<string, any>
  const draft = String(body.draft ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  const refs = Array.isArray(body.refs)
    ? (body.refs as unknown[]).filter((u): u is string => typeof u === 'string' && u.startsWith('https://')).slice(0, MAX_REFS)
    : []
  const chatId = Number(body.chatId ?? 0)
  const st = (body.settings ?? {}) as Record<string, any>

  const format = movieFormatById(String(st.runtime ?? ''))
  const audio = audioPlanById(String(st.audio ?? ''))
  const settingsLine = [
    `runtime ${format.label} (${format.seconds}, ${format.shots})`,
    `stills at ${String(st.imgQuality ?? '4k').toUpperCase()} ${String(st.imgAspect ?? '16:9')}`,
    `video at ${String(st.vidRes ?? '1080p')} ${String(st.vidAspect ?? '16:9')}`,
    `soundtrack: ${audio.label} (${audio.note})`,
  ].join(', ')

  const context = chatId > 0 ? await filmContext(chatId, user.id).catch(() => '') : ''
  const editing = context.includes('A cut EXISTS')

  const instruction = [
    'You write BRIEFS for a film-production AI. The brief is the single instruction a director-agent will act on:',
    'it plans the story, casts the models, renders stills, shoots video clips and cuts them together.',
    '',
    'Write the brief the user should send. Rules:',
    '- One paragraph, 40-110 words. Plain prose. No headings, no bullet points, no markdown, no preamble, no quotes.',
    '- Second person to the studio ("Make me…", "Open on…"). Never explain what you are doing.',
    '- Say the STORY: who is in it, where, what happens, and how it ends. Concrete beats beat adjectives.',
    '- Name a look: time of day, weather, light, lens feel, grade. One clause is enough.',
    '- Use the attached reference images to describe WHO the characters are and what the world looks like.',
    '  Describe them; do not refer to them as "the references" or by number.',
    '- Do NOT restate the runtime, resolution, aspect ratio or soundtrack — those are already set in the UI',
    '  and repeating them wastes the brief.',
    '- Do NOT invent a title, a ticket budget, shot counts or model names. That is the studio\'s job.',
    editing
      ? '- THIS IS AN EDIT of a film that already exists. Write a change request, not a new film: say exactly what to '
        + 'change, keep, re-shoot or replace, and why. Build on what was already made rather than starting over.'
      : '- This is a NEW film. Give it a beginning, a turn and an ending that fits the runtime.',
    draft
      ? '- The user has already typed something. KEEP their intent, their characters and their ending, and expand it '
        + 'into a full brief. Do not replace their idea with your own.'
      : '- The user has typed nothing, so propose something specific and shootable from the references alone.',
    '',
    `PRODUCTION SETTINGS (context only, do not repeat): ${settingsLine}`,
    context ? '' : 'This film has not been started yet.',
    context,
    draft ? `WHAT THE USER TYPED: ${draft}` : 'The user typed nothing.',
    '',
    'Reply with the brief text only.',
  ].filter(Boolean).join('\n')

  const images = (await Promise.all(refs.map(inlineRef))).filter(Boolean) as {
    inlineData: { mimeType: string; data: string }
  }[]

  // A brief is one paragraph; there is nothing here worth a long deliberation,
  // and the wait is what the user actually feels.
  const payload: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: instruction }, ...images] }],
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: MAX_OUTPUT,
      thinkingConfig: { thinkingLevel: 'low' },
    },
  }

  try {
    let res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify(payload),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // thinkingConfig is a Gemini 3.x field. If this key or model does not
      // know it the request is rejected outright, so the low-latency path is
      // attempted first and the plain one is the fallback — rather than
      // never asking for less thinking and always paying for it.
      if (res.status === 400 && 'thinkingConfig' in (payload.generationConfig as object)) {
        const plain = { ...payload, generationConfig: { temperature: 0.85, maxOutputTokens: MAX_OUTPUT } }
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            body: JSON.stringify(plain),
          },
        )
      }
      if (!res.ok) {
        return NextResponse.json(
          { error: `Autofill failed (${res.status})`, detail: detail.slice(0, 300) },
          { status: 502 },
        )
      }
    }
    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
    }
    const out = (data.candidates?.[0]?.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('')
      .trim()
      // The model occasionally wraps the paragraph in quotes or a "Brief:" label
      .replace(/^(brief|prompt)\s*:\s*/i, '')
      .replace(/^["'“‘]+|["'”’]+$/g, '')
      .trim()
    if (!out) {
      const why = data.candidates?.[0]?.finishReason
      return NextResponse.json(
        {
          error: why === 'MAX_TOKENS'
            ? 'The model ran out of room before it wrote anything — try again'
            : 'The model returned nothing',
        },
        { status: 502 },
      )
    }
    return NextResponse.json({
      prompt: out,
      sawRefs: images.length,
      editing,
      // Surfaced so a clipped paragraph is visible as a clipped paragraph
      // rather than looking like the model simply stopped mid-thought.
      truncated: data.candidates?.[0]?.finishReason === 'MAX_TOKENS',
    })
  } catch (err: any) {
    const msg = String(err?.message || err)
    return NextResponse.json(
      { error: msg.includes('timeout') ? 'Autofill timed out' : `Autofill failed: ${msg.slice(0, 200)}` },
      { status: 502 },
    )
  }
}
