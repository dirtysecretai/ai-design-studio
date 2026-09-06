// One-shot auto-titling: after the FIRST exchange, a flash-lite call turns
// "the first message, truncated" into a real title. Runs once per chat; manual
// renames are never overwritten (the caller only updates while the title still
// equals the first-message placeholder).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const TITLE_MODEL = 'gemini-3.1-flash-lite-preview'
const TIMEOUT_MS = 8_000

/** Shared plumbing — only the instruction differs between a chat and a film. */
async function titleFromModel(
  instruction: string,
  userText: string,
  assistantText: string,
): Promise<string | null> {
  if (!GEMINI_API_KEY) return null
  const u = userText.replace(/\s+/g, ' ').trim().slice(0, 1500)
  const a = assistantText.replace(/\s+/g, ' ').trim().slice(0, 1500)
  if (!u) return null
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TITLE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{ parts: [{ text:
`${instruction}

USER: ${u}
ASSISTANT: ${a || '(no reply yet)'}

Title:` }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 24 },
        }),
      },
    )
    if (!res.ok) return null
    const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    let title = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').split('\n')[0].trim()
    title = title.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/[.:;!]+$/, '').trim()
    if (!title || title.length < 2) return null
    return title.slice(0, 60)
  } catch {
    return null
  }
}

export async function generateChatTitle(userText: string, assistantText: string): Promise<string | null> {
  return titleFromModel(
    'Write a short title for this chat conversation: 2 to 6 words, Title Case, no quotes, no trailing punctuation, no emoji. '
    + 'Name the actual subject or task (e.g. "Face Swap Cleanup", "Neon Poster Layout"), never generic words like "Chat" or "Conversation". '
    + 'Reply with the title only.',
    userText,
    assistantText,
  )
}

/**
 * Name a film the way a film gets named.
 *
 * NOT used to auto-title a film: a film is named by the USER, from the title
 * question in the employee's intake. This exists for suggesting names.
 *
 *
 * The chat titler describes a task ("Face Swap Cleanup"). A film needs a TITLE
 * — the words that would sit on the poster — so it gets its own instruction
 * rather than a reworded version of the chat one.
 */
export async function generateFilmTitle(userText: string, assistantText: string): Promise<string | null> {
  return titleFromModel(
    'Invent the TITLE of a short film from the brief below — the words that would appear on its poster. '
    + '2 to 5 words, Title Case, no quotes, no punctuation at the end, no emoji, no subtitle. '
    + 'Evocative and specific to THIS story (e.g. "Stand At The Treeline", "Perimeter Breach", "The Long Winter"). '
    + 'Never describe the task, and never use the words Film, Movie, Short or Untitled. Reply with the title only.',
    userText,
    assistantText,
  )
}
