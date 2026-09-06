import prisma from '@/lib/prisma'

/**
 * The production bible: what this film knows about itself, forever.
 *
 * A film is not a conversation. It runs for days across many chats' worth of
 * steps, and the thing that has to survive is not the transcript — it is the
 * CAST, the world, and the decisions the user has already made. Replaying the
 * transcript to preserve that is both lossy and expensive: every step of an
 * agent run re-sends the whole context, so a long history is paid for again on
 * each of thirty steps. A compact, rewritten set of notes is paid for the same
 * thirty times, but it is a fifth of the size and none of it is filler.
 *
 * WHERE IT LIVES. Chat.systemPrompt already holds the employee's own text and
 * is already injected into every send and approve. The bible is appended after
 * a sentinel, so it needs no migration and is in context automatically. The
 * employee text above the sentinel is never touched.
 */

export const BIBLE_MARKER = '=== PRODUCTION BIBLE — this film, remembered ==='

/** Hard ceiling. Notes that grow without bound become the cost they replaced. */
export const BIBLE_MAX = 6000

export const BIBLE_TEMPLATE = `## STORY
LOGLINE: one sentence, characters by role and never by name.
THEME: what the film is about underneath the events.
SETTING: where and when.
TREATMENT: three to six sentences. Every shot should trace back to a line here.

## CAST
One block per character who appears more than once. Name, then a single canon
description line that gets repeated VERBATIM in every prompt they are in, then
GOAL / MOTIVATION / STAKES in one line, then their reference urls, then
anything a provider refuses about them.

## WORLD
Location, era, season, weather, palette. Only what a shot prompt needs.

## LOOK
Grade, lens feel, aspect, the one or two rules that keep shots consistent.

## DECISIONS
Calls the user has already made, in their words, so they are never re-asked.

## CONTINUITY
What the current cut establishes, shot by shot, in one line each.`

/** Split a film's stored prompt into the employee text and its notes. */
export function splitBible(systemPrompt: string | null | undefined): {
  base: string
  notes: string
} {
  const raw = String(systemPrompt ?? '')
  const at = raw.indexOf(BIBLE_MARKER)
  if (at < 0) return { base: raw, notes: '' }
  return {
    base: raw.slice(0, at).trimEnd(),
    notes: raw.slice(at + BIBLE_MARKER.length).trim(),
  }
}

/**
 * The character equivalent, and the reason its shape is fixed.
 *
 * /api/employees/cast parses DESCRIPTOR out of these notes to hand to the
 * Movie Studio, so a board written in free prose is a board no film can cast
 * from. The heading is the contract.
 */
export const CHARACTER_TEMPLATE = `## DESCRIPTOR
One paragraph, written to be pasted VERBATIM into a prompt: face shape, eyes,
hair (colour, length, texture, how it sits), skin, build, height read, age
read, every distinguishing mark. No story, no opinions \u2014 only what a model
needs to draw this person.

## PROFILE
Age range and gender presentation, two or three traits, their situation, and
what they are struggling with.

## WANT
GOAL / MOTIVATION / STAKES in one line.

## WARDROBE
Their default outfit, and the alternates that exist.

## RESTRICTIONS
Anything a provider refuses about them, and what to do instead.`

export async function readFilmNotes(chatId: number, userId: number): Promise<string> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    select: { systemPrompt: true },
  })
  return splitBible(chat?.systemPrompt).notes
}

/**
 * Replace the notes wholesale.
 *
 * Full replacement rather than append, deliberately: notes that can only grow
 * are the problem this exists to solve. Rewriting forces the employee to
 * decide each time what still matters, which is what keeps a feature-length
 * production inside a fixed budget.
 */
export async function writeFilmNotes(
  chatId: number,
  userId: number,
  notes: string,
): Promise<{ ok: true; chars: number } | { error: string }> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    select: { id: true, systemPrompt: true },
  })
  if (!chat) return { error: 'This film could not be found' }

  const trimmed = String(notes ?? '').trim()
  if (!trimmed) return { error: 'notes cannot be empty — pass the full replacement text' }
  if (trimmed.length > BIBLE_MAX) {
    return {
      error:
        `Notes are ${trimmed.length} characters, over the ${BIBLE_MAX} limit. This is a signal, not an `
        + `obstacle: cut the CONTINUITY lines for shots that are settled, collapse anything said twice, and drop `
        + `every line that would not change a future shot. Keep the cast and the user's decisions.`,
    }
  }

  const { base } = splitBible(chat.systemPrompt)
  await prisma.chat.update({
    where: { id: chat.id },
    data: { systemPrompt: `${base}\n\n${BIBLE_MARKER}\n${trimmed}` },
  })
  return { ok: true, chars: trimmed.length }
}
