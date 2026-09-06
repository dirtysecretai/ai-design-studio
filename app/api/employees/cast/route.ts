import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import { splitBible } from '@/lib/film-notes'
import { jsonPrivate } from '@/lib/api-json'

/**
 * The casting list: every character the Character Design employee has built.
 *
 * A board that only exists inside its own chat is a dead end — the Movie
 * Studio has been handed flat piles of thumbnails and left to infer who is
 * who, which is exactly where likeness errors begin. A finished character has
 * three things worth carrying into a film: a NAME, a CANON DESCRIPTOR written
 * to be repeated verbatim in prompts, and the IMAGES that prove what they look
 * like. This returns those.
 *
 * Derived, not stored twice: the descriptor is read from the character chat's
 * own notes and the images from what that chat actually generated, so a board
 * that gets refined stays correct here without anything being kept in sync.
 * ADMIN ONLY.
 */

export const runtime = 'nodejs'

const SOURCE = 'character-design'

export type CastMember = {
  chatId: number
  name: string
  descriptor: string
  /** The master image, when one can be identified. */
  master: string | null
  /** Everything this board produced, newest first, master excluded. */
  images: string[]
}

/**
 * The canon descriptor, from the character's own notes.
 *
 * The Character Design employee writes its notes with the same mechanism the
 * Movie Studio uses, so the descriptor sits after the bible marker. Falls back
 * to nothing rather than guessing: a wrong descriptor is worse than none,
 * because it would be repeated verbatim into every prompt.
 */
function readDescriptor(systemPrompt: string | null): string {
  const notes = splitBible(systemPrompt).notes
  if (!notes) return ''
  // Prefer an explicit DESCRIPTOR heading; otherwise the first real paragraph.
  const tagged = /(?:^|\n)#{0,3}\s*(?:CANON\s+)?DESCRIPTOR\s*:?\s*\n?([\s\S]*?)(?=\n#{1,3}\s|\n\s*\n|$)/i.exec(notes)
  const text = (tagged?.[1] ?? notes.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 1200)
}

export async function GET(): Promise<Response> {
  const user = await requireChatHubAdmin()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const chats = await prisma.chat.findMany({
    where: { userId: user.id, source: SOURCE },
    orderBy: { updatedAt: 'desc' },
    take: 40,
    select: { id: true, title: true, systemPrompt: true },
  })
  if (chats.length === 0) return jsonPrivate({ cast: [] })

  const rows = await prisma.chatMessage.findMany({
    where: { chatId: { in: chats.map(c => c.id) } },
    orderBy: { id: 'asc' },
    select: { chatId: true, imageUrls: true, metadata: true },
  })

  const byChat = new Map<number, string[]>()
  for (const r of rows) {
    const list = byChat.get(r.chatId) ?? []
    for (const u of r.imageUrls ?? []) {
      // Clips are not casting material; a character is cast from stills.
      if (typeof u === 'string' && u && !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) list.push(u)
    }
    for (const st of (((r.metadata ?? {}) as Record<string, any>).agentSteps ?? []) as any[]) {
      if (typeof st?.imageUrl === 'string' && st.status === 'done') list.push(st.imageUrl)
    }
    byChat.set(r.chatId, list)
  }

  const cast: CastMember[] = chats.map(c => {
    const all = [...new Set(byChat.get(c.id) ?? [])]
    // The FIRST image a board produces is its master — every sheet after it is
    // anchored on that one, which is what makes it the right anchor to carry
    // into a film.
    const master = all[0] ?? null
    return {
      chatId: c.id,
      name: (c.title || 'Untitled character').trim(),
      descriptor: readDescriptor(c.systemPrompt),
      master,
      images: all.slice(1, 12).reverse(),
    }
  }).filter(m => m.master || m.descriptor)

  return jsonPrivate({ cast })
}
