import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import { CHAT_HUB_MODELS, DEFAULT_CHAT_MODEL } from '@/lib/chat-hub-models'
import { BUILT_IN_EMPLOYEES } from '@/lib/chat-hub-skills'
import { generateFilmTitle } from '@/lib/chat-hub-title'
import { jsonPrivate } from '@/lib/api-json'

/**
 * Films are ongoing projects, not one-shot prompts.
 *
 * Each film is a Chat row tagged `source: 'movie-studio'` — the marker keeps
 * them out of the hub's own chat list while needing no schema change. The tab
 * strip is that list; a film survives refreshes, devices and weeks because the
 * work lives in the database rather than in a tab's memory.
 *
 * ADMIN ONLY, like the rest of the Employees section.
 */

const SOURCE = 'movie-studio'
const UNTITLED = 'Untitled film'
const MOVIE_STUDIO = BUILT_IN_EMPLOYEES.find(e => e.id === 'emp-movie-studio')!

/**
 * The orchestrator a film runs on.
 *
 * DEFAULT_CHAT_MODEL is simply the first entry in the catalog (Claude Fable 5),
 * which is not a deliberate choice for this employee — a film is a long
 * tool-calling run, and the Flash line is both the strongest at that and far
 * cheaper over a production's many steps. Falls back to the catalog default if
 * the id is ever retired.
 */
const FILM_MODEL =
  CHAT_HUB_MODELS.find(m => m.id === 'google/gemini-3.7-flash')?.id ?? DEFAULT_CHAT_MODEL

/** Everything a tab needs, derived from the film's own messages. */
async function summarise(chatId: number) {
  const rows = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { id: 'asc' },
    select: { role: true, metadata: true },
  })
  let filmUrl: string | null = null
  let shotsSubmitted = 0
  let shotsLanded = 0
  let awaitingUser = false
  for (const m of rows) {
    const meta = (m.metadata ?? {}) as Record<string, any>
    if (Array.isArray(meta.pendingApproval?.calls) && meta.pendingApproval.calls.length > 0) awaitingUser = true
    else if (m.role === 'assistant') awaitingUser = false
    for (const st of (meta.agentSteps ?? []) as any[]) {
      if (st?.tool === 'assemble_film' && st.status === 'done' && typeof st.imageUrl === 'string' && st.imageUrl) {
        filmUrl = st.imageUrl
      }
      if (Array.isArray(st?.queueIds)) {
        const res = st.shotResults ?? {}
        for (const q of st.queueIds) {
          shotsSubmitted++
          if (res[String(q)] !== undefined) shotsLanded++
        }
      }
    }
  }
  return { filmUrl, shotsSubmitted, shotsLanded, awaitingUser }
}

/**
 * Last-resort naming for a film whose cut exists but which nobody named.
 *
 * The user's choice always comes first: the employee asks in its intake, and
 * again after the cut if they said "name it later". This is the backstop for
 * when neither happened, so a finished film is never delivered as "Untitled".
 */
async function autoNameFinishedFilm(userId: number, chatId: number): Promise<void> {
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { id: 'asc' },
      take: 4,
      select: { role: true, content: true },
    })
    const brief = rows.find(r => r.role === 'user')?.content ?? ''
    const reply = rows.find(r => r.role === 'assistant')?.content ?? ''
    if (!brief.trim()) return
    const title = await generateFilmTitle(brief, reply)
    if (!title) return
    // Only if it is STILL unnamed — the user may have named it meanwhile.
    await prisma.chat.updateMany({
      where: { id: chatId, userId, source: SOURCE, title: UNTITLED },
      data: { title },
    })
  } catch {
    // A missing title is cosmetic; never let it break the tab strip.
  }
}

// GET /api/employees/films — the tab strip
export async function GET(): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const chats = await prisma.chat.findMany({
    where: { userId: user.id, source: SOURCE },
    orderBy: { updatedAt: 'desc' },
    take: 24,
    select: { id: true, title: true, updatedAt: true },
  })
  const films = await Promise.all(chats.map(async c => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    ...(await summarise(c.id)),
  })))

  // A finished film is never left as "Untitled film". The employee is told to
  // ask, and the user's answer always wins — this only catches the case where
  // the cut exists and nobody ever named it. Fire-and-forget so the tab strip
  // is not held up; the name appears on the next poll. Self-limiting: once the
  // title changes, the condition stops matching.
  for (const f of films) {
    if (f.filmUrl && f.title === UNTITLED) void autoNameFinishedFilm(user.id, f.id)
  }

  return jsonPrivate({ films })
}

// POST /api/employees/films — start a new film (a new tab)
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 80)
    : UNTITLED

  const chat = await prisma.chat.create({
    data: {
      userId: user.id,
      title,
      model: FILM_MODEL,
      source: SOURCE,
      // Always Ask mode: a film is planned WITH the user
      agentMode: 'accept',
      systemPrompt: MOVIE_STUDIO.text,
      skills: MOVIE_STUDIO.skills,
    },
    select: { id: true, title: true, updatedAt: true },
  })
  return jsonPrivate({
    film: { ...chat, filmUrl: null, shotsSubmitted: 0, shotsLanded: 0, awaitingUser: false },
  })
}

// PATCH /api/employees/films — rename a film { id, title }
export async function PATCH(req: NextRequest): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const id = Number(body.id ?? 0)
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : ''
  if (!id || !title) return jsonPrivate({ error: 'id and title are required' }, { status: 400 })

  // The auto-titler only overwrites a title that still equals its placeholder,
  // so a name the user typed is safe by construction.
  const updated = await prisma.chat.updateMany({
    where: { id, userId: user.id, source: SOURCE },
    data: { title },
  })
  if (updated.count === 0) return jsonPrivate({ error: 'Not found' }, { status: 404 })
  return jsonPrivate({ ok: true, title })
}

// DELETE /api/employees/films?id=123 — close a tab.
// Deletes the film and its messages; the generations themselves stay in the
// user's feed, so nothing they paid for is lost with the tab.
export async function DELETE(req: NextRequest): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const id = Number(new URL(req.url).searchParams.get('id') ?? 0)
  if (!id) return jsonPrivate({ error: 'id is required' }, { status: 400 })

  const owned = await prisma.chat.findFirst({
    where: { id, userId: user.id, source: SOURCE },
    select: { id: true },
  })
  if (!owned) return jsonPrivate({ error: 'Not found' }, { status: 404 })

  await prisma.chat.delete({ where: { id } })
  return jsonPrivate({ ok: true })
}
