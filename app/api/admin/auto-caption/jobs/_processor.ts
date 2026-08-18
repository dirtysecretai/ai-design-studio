import { after } from 'next/server'
import { prisma } from '@/lib/prisma'

export const CHUNK_SIZE = 5

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!

// Model whitelist lives in lib/autofill-models.ts (client-safe, shared with
// both admin pages' dropdowns)
export { AUTOFILL_MODELS } from '@/lib/autofill-models'
import { AUTOFILL_MODELS as _AM } from '@/lib/autofill-models'
const MODELS: Record<string, string> = Object.fromEntries(_AM.map(m => [m.key, m.apiId]))

type ImagePart  = { inlineData: { data: string; mimeType: string } }
type TextPart   = { text: string }
type GeminiPart = ImagePart | TextPart

async function fetchImageAsBase64(url: string, timeoutMs = 20_000): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const buffer = await res.arrayBuffer()
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
  return { data: Buffer.from(buffer).toString('base64'), mimeType }
}

async function fetchImageAsBase64Safe(url: string): Promise<{ data: string; mimeType: string } | null> {
  try { return await fetchImageAsBase64(url) } catch { return null }
}

async function callGeminiParts(parts: GeminiPart[], modelId: string, maxTokens = 800, timeoutMs = 60_000): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
  })

  const MAX_RETRIES = 4
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 30_000)
      await new Promise(r => setTimeout(r, delayMs))
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 503 || res.status === 429) {
      lastError = new Error(`Gemini ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`)
      continue
    }
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`)
    }
    const json = await res.json()
    if (json.promptFeedback?.blockReason) throw new Error(`Blocked by safety filter: ${json.promptFeedback.blockReason}`)
    const candidate = json.candidates?.[0]
    if (!candidate) throw new Error('No candidates in Gemini response')
    const finishReason = candidate.finishReason
    if (finishReason === 'SAFETY') throw new Error('Blocked by output safety filter')
    const text = candidate.content?.parts?.[0]?.text
    if (!text) throw new Error(`No text returned (finishReason: ${finishReason ?? 'unknown'})`)
    if (finishReason === 'MAX_TOKENS') throw new Error(`Caption truncated — hit token limit`)
    return text.trim()
  }
  throw lastError ?? new Error('Gemini request failed after retries')
}

export function cleanTags(raw: string): string[] {
  return raw
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter(t => t.length > 0 && t.length <= 40)
}

function buildBasicInstruction(mode: 'caption' | 'tags', promptSnippet: string, curatorContext: string | null): string {
  const ctx = curatorContext ? `\nCURATOR CONTEXT (must be included): ${curatorContext}` : ''
  if (mode === 'caption') {
    return `You are an AI training data curator. Analyze this AI-generated image and write a concise training caption (1–3 sentences) that accurately describes the visual content.\n\nFocus on: main subject, style, key visual elements, mood, and composition.\n\nOriginal generation prompt: "${promptSnippet}"${ctx}\n\nRespond with ONLY the caption text. No preamble, no quotes.`
  }
  return `You are an AI training data curator. Analyze this AI-generated image and generate 5–15 descriptive tags for a training dataset.\n\nTags must be lowercase. Use hyphens for multi-word terms. Cover: subject, style, color palette, mood, composition, visual elements.\n\nOriginal generation prompt: "${promptSnippet}"${ctx}\n\nRespond with ONLY a comma-separated list. Example: portrait, dark-lighting, fantasy-style, blue-tones, dramatic-pose`
}

function buildAdvancedInstruction(
  mode: 'caption' | 'tags',
  promptSnippet: string,
  refCount: number,
  rating: { score: number; wasAccurate: boolean | null; tags: string[]; feedbackText: string | null } | null,
  curatorContext: string | null,
): string {
  const ctx = curatorContext ? `\n- CURATOR CONTEXT (must be included): ${curatorContext}` : ''
  const ratingLine = rating
    ? [
        `Rating: ${rating.score}/5 stars`,
        rating.wasAccurate !== null ? `Prompt accuracy: ${rating.wasAccurate ? 'accurate' : 'inaccurate'}` : null,
        rating.tags.length ? `Feedback tags: ${rating.tags.join(', ')}` : null,
        rating.feedbackText ? `User feedback: "${rating.feedbackText}"` : null,
      ].filter(Boolean).join(' · ')
    : 'No user rating'
  const refLine = refCount > 0
    ? `${refCount} reference image(s) provided below — used for face/subject identity consistency`
    : 'No reference images used'
  const qualityHint = !rating ? '' :
    rating.score === 5 ? '\nQUALITY NOTE: 5-star rating — emphasize high quality, correct anatomy, precise details.' :
    rating.score === 4 ? '\nQUALITY NOTE: 4-star rating — highlight its strong aspects.' :
    rating.score <= 2  ? '\nQUALITY NOTE: Low rating — note any visible quality issues or inaccuracies.' : ''
  const refHint = refCount > 0 ? '\nIDENTITY NOTE: If identity appears consistent across images, note this explicitly.' : ''

  if (mode === 'caption') {
    return `You are an expert AI training data curator analyzing an AI-generated image with full context.

IMAGE ORDER: Image 1 = the generated result (caption this one). ${refCount > 0 ? `Images 2–${refCount + 1} = reference images used for subject identity.` : ''}

CONTEXT:
- Original prompt: "${promptSnippet}"
- ${refLine}
- ${ratingLine}${ctx}
${qualityHint}${refHint}

TASK: Write a training caption (2–4 sentences) for the FIRST IMAGE only.${curatorContext ? '\nIMPORTANT: The curator context above MUST be reflected in your caption.' : ''}

Respond with ONLY the caption. No preamble, no quotes.`
  }

  const qualityTags = !rating ? '' :
    rating.score === 5 ? '\nMUST INCLUDE quality tags: high-quality, correct-anatomy' :
    rating.score === 4 ? '\nINCLUDE: good-quality' :
    rating.score <= 2  ? '\nINCLUDE: low-quality' : ''
  const refTags = refCount > 0 ? '\nIf identity is consistent with references, INCLUDE: face-consistent, identity-preserved' : ''
  const ctxTags = curatorContext
    ? `\nCURATOR CONTEXT tags (must include): ${curatorContext.toLowerCase().replace(/[^a-z0-9\s,-]/g, '').split(/[\s,]+/).filter(Boolean).join(', ')}`
    : ''

  return `You are an expert AI training data curator generating tags for an AI-generated image with full context.

IMAGE ORDER: Image 1 = the generated result (tag this one). ${refCount > 0 ? `Images 2–${refCount + 1} = reference images for context.` : ''}

CONTEXT:
- Original prompt: "${promptSnippet}"
- ${refLine}
- ${ratingLine}${ctx}
${qualityHint}${refHint}

TASK: Generate 8–20 descriptive tags for the FIRST IMAGE.
Rules: lowercase, hyphens for multi-word terms.
Cover: subject, style, lighting, colors, composition, mood, quality.
${qualityTags}${refTags}${ctxTags}

Respond with ONLY a comma-separated list.`
}

function buildFluxInstruction(
  promptSnippet: string,
  refCount: number,
  rating: { score: number; wasAccurate: boolean | null; tags: string[]; feedbackText: string | null } | null,
  triggerWord: string | null,
): string {
  const triggerLine = triggerWord
    ? `TRIGGER WORD: "${triggerWord}" — this exact string MUST appear once, early in the caption. It will become the LoRA activation token.`
    : 'No trigger word set — describe the subject naturally without a special token.'
  const ratingHint = rating ? `Quality rating: ${rating.score}/5${rating.feedbackText ? ` — user note: "${rating.feedbackText}"` : ''}` : ''
  const refOrderNote = refCount > 0
    ? `IMAGE ORDER: Image 1 = training image (caption this). Images 2–${refCount + 1} = reference images for subject/identity context only — do NOT caption them.`
    : 'Only one image provided — caption it.'

  return `You are a professional AI model trainer writing FLUX.1-dev LoRA training captions. These captions are the sole signal the model uses to learn, so visual precision is critical.

${triggerLine}

${refOrderNote}

═══ CAPTION STRUCTURE (follow this exact order) ═══

1. SUBJECT LINE — trigger word + subject identity + single most distinctive visual element (1 sentence)
2. COSTUME/OUTFIT — every significant clothing piece, material, color, texture visible in the image (1–2 sentences)
3. POSE & ACTION — exact body position, limb placement, gesture, facial expression if visible (1 sentence)
4. BACKGROUND & SETTING — environment, location, colors, depth, atmosphere (1 sentence)
5. LIGHTING — direction, quality, color temperature, shadow behavior (1 sentence)
6. CAMERA & FRAMING — angle, shot type, depth of field (1 sentence)
7. QUALITY CLOSE — end with comma-separated quality descriptors

═══ WRITING RULES ═══

✓ Natural descriptive sentences — NOT comma-separated tags
✓ Visually specific: "glossy black full-plate armor" not "dark outfit"
✓ Name exact colors and materials
✓ Describe ONLY what is visible in Image 1
✗ No subjective adjectives: menacing, beautiful, powerful
✗ No story or lore beyond what is visually present
✗ No phrases: "the image shows", "we can see", "depicting"

TARGET LENGTH: 120–220 words

═══ CONTEXT ═══
- Original generation prompt: "${promptSnippet}"${ratingHint ? `\n- ${ratingHint}` : ''}

Respond with ONLY the caption text. No preamble, no section headers, no quotes, no markdown.`
}

// APPEND mode — rewrite an EXISTING caption per a natural-language edit.
// The model sees the image + the current caption + the instruction, and
// returns the full revised caption.
//
// CONDITIONAL NAMING (naming=true, the default) is the point of this mode.
// Training correlates TOKENS with PIXELS — it has no notion of "description"
// vs "lore". Any phrase that consistently co-occurs with a visual cluster
// becomes a promptable handle, so curated names ("Tony Bulgoni's red and
// white super suit", "from Hot Dog Man") DO give the user extra ways to
// summon the look, and invented names are ideal because the base model holds
// no competing prior for them.
//
// What actually breaks a handle is NON-DISCRIMINATIVE naming: if the phrase
// lands on images that don't share the visual, it averages into mush. Hence
// the rule below is conditional — a name is attached only where its visual
// referent is actually present, never blanket-applied. naming=false falls
// back to strict visual-only editing.
function buildAppendInstruction(
  existingCaption: string,
  instruction: string,
  triggerWord: string | null,
  refCount: number,
  naming: boolean,
): string {
  // Emphatic and placed LAST (recency) — flash-lite was silently dropping the
  // rename when the rest of the edit turned out to be inapplicable
  const triggerLine = triggerWord
    ? `\n\n═══ MANDATORY ═══\nThe caption MUST contain the exact token "${triggerWord}" once, early, as the subject's identity — replacing any other name currently used for the subject. This is required even if every other part of the edit turns out not to apply to this image.`
    : ''
  const refOrderNote = refCount > 0
    ? `IMAGE ORDER: Image 1 = the training image (the caption describes THIS). Images 2–${refCount + 1} = references for identity context only.`
    : 'One image provided — it is the training image the caption describes.'

  const groundingRule = naming
    ? `3. NAMING RULE — the core of this mode:
   • The curator's names, titles and phrases ARE wanted in the caption. They become prompt handles, so use them VERBATIM and identically every time.
   • CONDITIONAL ATTACHMENT: attach a name only to an image where the thing it names is actually present. If the edit says the red and white super suit is "from Hot Dog Man", include that naming ONLY when the suit is visible in THIS image. If the suit is absent, omit the suit naming entirely — do not mention it.
   • Subject/character names may always be used as the subject's identity, even when only the person is visible.
   • NEVER invent visual details to match a name. Name what is there; do not describe what is not.
   • If the edit contradicts the image, follow the IMAGE and silently omit the contradiction.`
    : `3. GROUNDING RULE (strict visual mode):
   • Describe ONLY what is visibly present. Adopt the curator's vocabulary for visible things.
   • Do NOT state titles, backstory or in-fiction names as visual facts. A proper name may be used as the subject's name only.
   • If the edit contradicts the image, follow the IMAGE and silently omit the contradiction.`

  return `You are a professional AI model trainer REVISING an existing LoRA training caption.

${refOrderNote}

═══ CURRENT CAPTION ═══
${existingCaption}

═══ REQUESTED EDIT (curator's own words) ═══
${instruction}

═══ HOW TO APPLY THE EDIT ═══

1. Start from the CURRENT CAPTION. Preserve everything still accurate — its structure, ordering, level of detail, and its quality descriptors.
2. Apply the curator's edit, ADOPTING THEIR EXACT VOCABULARY. If they call it a "red and white super suit", use that phrase verbatim — identical wording across the dataset is what makes it a reliable prompt handle.
${groundingRule}
4. Do not simply append a sentence to the end — weave the edit into the relevant existing sentences so the caption reads as one coherent description.
5. Keep roughly the original length (±30%).${triggerLine}

═══ WRITING RULES ═══
✓ Natural descriptive sentences, not comma-separated tags
✓ Specific colors, materials, textures
✗ No subjective adjectives (menacing, beautiful, iconic)
✗ No "the image shows", "we can see", "depicting"

Respond with ONLY the revised caption. No preamble, no quotes, no markdown, no commentary about what you changed.`
}

type JobRecord = {
  id:                 number
  prompt:             string
  imageUrl:           string
  videoMetadata:      unknown
  adminTags:          string[]
  adminCaption:       string | null
  referenceImageUrls: string[]
  imageRating:        { score: number; wasAccurate: boolean | null; tags: string[]; feedbackText: string | null } | null
}

export type JobResult = {
  id:       number
  type:     'result' | 'skip' | 'error'
  value?:   string
  tags?:    string[]
  imageUrl: string
  error?:   string
}

export function getBaseUrl(req: Request): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host  = req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

// Find the oldest queued job and start it — uses after() to avoid an HTTP round-trip.
// Next.js supports nested after() calls, so this works whether called from a route handler
// or from within another after() callback (e.g. at the end of processChunk).
export async function autoStartNextQueued(baseUrl: string): Promise<void> {
  const nextJob = await prisma.autoFillJob.findFirst({
    where:   { status: 'queued' },
    orderBy: { createdAt: 'asc' },
  })
  if (!nextJob) return
  await prisma.autoFillJob.update({ where: { id: nextJob.id }, data: { status: 'running' } })
  after(async () => { await processChunk(nextJob.id, baseUrl) })
}

export async function processChunk(jobId: string, baseUrl: string): Promise<void> {
  try {
    await _processChunk(jobId, baseUrl)
  } catch {
    // Unexpected fatal error — park as 'paused' (not 'done') so progress is preserved
    // and the user can resume. Then allow the next queued job to run.
    try { await prisma.autoFillJob.update({ where: { id: jobId }, data: { status: 'paused' } }) } catch {}
    try { await autoStartNextQueued(baseUrl) } catch {}
  }
}

async function _processChunk(jobId: string, baseUrl: string): Promise<void> {
  const job = await prisma.autoFillJob.findUnique({ where: { id: jobId } })
  if (!job || job.status !== 'running') return

  const modelId = MODELS[job.modelKey] ?? MODELS.flash

  const records: JobRecord[] = await prisma.generatedImage.findMany({
    where:   { id: { in: job.imageIds as number[] }, isDeleted: false },
    select:  {
      id: true, prompt: true, imageUrl: true, videoMetadata: true,
      adminTags: true, adminCaption: true, referenceImageUrls: true,
      imageRating: { select: { score: true, wasAccurate: true, tags: true, feedbackText: true } },
    },
    orderBy: { id: 'asc' },
  })

  const recordMap = new Map(records.map(r => [r.id, r]))
  const ordered   = (job.imageIds as number[]).map(id => recordMap.get(id)).filter((r): r is JobRecord => !!r)

  const existingResults: JobResult[] = Array.isArray(job.results) ? (job.results as JobResult[]) : []
  const newResults: JobResult[] = []
  let processedCount = job.processedCount
  let skippedCount   = job.skippedCount
  let failedCount    = job.failedCount
  let firstProcessed = true

  const startIndex = job.nextIndex
  const chunkEnd   = Math.min(startIndex + CHUNK_SIZE, ordered.length)

  for (let i = startIndex; i < chunkEnd; i++) {
    // Check for pause or cancel between every image
    if (i > startIndex) {
      const current = await prisma.autoFillJob.findUnique({ where: { id: jobId }, select: { status: true } })
      if (current?.status !== 'running') return
    }

    const record = ordered[i]

    // APPEND mode needs an existing caption to revise — nothing to edit
    // otherwise. (Its whole purpose is rewriting, so `overwrite` doesn't
    // apply: it always writes back over the caption it just revised.)
    if (job.mode === 'append' && !record.adminCaption?.trim()) {
      skippedCount++
      newResults.push({ id: record.id, type: 'skip', imageUrl: record.imageUrl, error: 'No caption to edit — run a caption pass first' })
      const allResults = [...existingResults, ...newResults].slice(-100)
      await prisma.autoFillJob.update({ where: { id: jobId }, data: { nextIndex: i + 1, skippedCount, results: allResults } })
      continue
    }

    // Skip already-processed
    if (!job.overwrite && job.mode !== 'append') {
      const alreadyCaptioned = (job.mode === 'caption' || job.mode === 'flux') && !!record.adminCaption
      const alreadyTagged    = job.mode === 'tags' && record.adminTags.length > 0
      if (alreadyCaptioned || alreadyTagged) {
        skippedCount++
        const skipReason = alreadyCaptioned ? 'Already captioned' : 'Already tagged'
        newResults.push({ id: record.id, type: 'skip', imageUrl: record.imageUrl, error: skipReason })
        const allResults = [...existingResults, ...newResults].slice(-100)
        await prisma.autoFillJob.update({ where: { id: jobId }, data: { nextIndex: i + 1, skippedCount, results: allResults } })
        continue
      }
    }

    // Skip videos
    if (/\.(mp4|webm|mov)$/i.test(record.imageUrl)) {
      skippedCount++
      newResults.push({ id: record.id, type: 'skip', imageUrl: record.imageUrl, error: 'Video — images only' })
      const allResults = [...existingResults, ...newResults].slice(-100)
      await prisma.autoFillJob.update({ where: { id: jobId }, data: { nextIndex: i + 1, skippedCount, results: allResults } })
      continue
    }

    if (!firstProcessed) await new Promise(r => setTimeout(r, 800))
    firstProcessed = false

    try {
      const promptSnippet = record.prompt.slice(0, 400)
      const rating        = record.imageRating ?? null
      const mainImage     = await fetchImageAsBase64(record.imageUrl)

      let savedValue: string
      let savedTags:  string[] | undefined

      if (job.mode === 'append') {
        const refUrls   = (record.referenceImageUrls ?? []).slice(0, 3)
        const refImages = (await Promise.all(refUrls.map(fetchImageAsBase64Safe))).filter((x): x is { data: string; mimeType: string } => !!x)
        const parts: GeminiPart[] = [
          { inlineData: mainImage },
          ...refImages.map(img => ({ inlineData: img })),
          // `advanced` doubles as the naming flag for append mode (no schema
          // change): true = curated names/titles wanted, false = strict visual
          { text: buildAppendInstruction(record.adminCaption!.trim(), job.curatorContext ?? '', job.triggerWord, refImages.length, job.advanced) },
        ]
        const raw = await callGeminiParts(parts, modelId, 1400, 90_000)
        savedValue = raw.replace(/^["']|["']$/g, '').trim()
        // Guard: a refusal or empty return must never wipe a good caption
        if (savedValue.length < 20) throw new Error('Revision came back empty or too short — caption left unchanged')
        await prisma.generatedImage.update({ where: { id: record.id }, data: { adminCaption: savedValue } })

      } else if (job.mode === 'flux') {
        const refUrls   = (record.referenceImageUrls ?? []).slice(0, 3)
        const refImages = (await Promise.all(refUrls.map(fetchImageAsBase64Safe))).filter((x): x is { data: string; mimeType: string } => !!x)
        const parts: GeminiPart[] = [{ inlineData: mainImage }, ...refImages.map(img => ({ inlineData: img })), { text: buildFluxInstruction(promptSnippet, refImages.length, rating, job.triggerWord) }]
        const raw = await callGeminiParts(parts, modelId, 1200, 90_000)
        savedValue = raw.replace(/^["']|["']$/g, '').trim()
        await prisma.generatedImage.update({ where: { id: record.id }, data: { adminCaption: savedValue } })

      } else if (!job.advanced) {
        const tokenLimit = job.mode === 'caption' ? 800 : 400
        const raw = await callGeminiParts([{ inlineData: mainImage }, { text: buildBasicInstruction(job.mode as 'caption' | 'tags', promptSnippet, job.curatorContext) }], modelId, tokenLimit)
        if (job.mode === 'caption') {
          savedValue = raw.replace(/^["']|["']$/g, '').trim()
          await prisma.generatedImage.update({ where: { id: record.id }, data: { adminCaption: savedValue } })
        } else {
          savedTags  = cleanTags(raw)
          savedValue = savedTags.join(', ')
          await prisma.generatedImage.update({ where: { id: record.id }, data: { adminTags: savedTags } })
        }

      } else {
        const refUrls   = (record.referenceImageUrls ?? []).slice(0, 3)
        const refImages = (await Promise.all(refUrls.map(fetchImageAsBase64Safe))).filter((x): x is { data: string; mimeType: string } => !!x)
        const tokenLimit = job.mode === 'caption' ? 1000 : 500
        const parts: GeminiPart[] = [{ inlineData: mainImage }, ...refImages.map(img => ({ inlineData: img })), { text: buildAdvancedInstruction(job.mode as 'caption' | 'tags', promptSnippet, refImages.length, rating, job.curatorContext) }]
        const raw = await callGeminiParts(parts, modelId, tokenLimit, 90_000)
        if (job.mode === 'caption') {
          savedValue = raw.replace(/^["']|["']$/g, '').trim()
          await prisma.generatedImage.update({ where: { id: record.id }, data: { adminCaption: savedValue } })
        } else {
          savedTags  = cleanTags(raw)
          savedValue = savedTags.join(', ')
          await prisma.generatedImage.update({ where: { id: record.id }, data: { adminTags: savedTags } })
        }
      }

      processedCount++
      newResults.push({ id: record.id, type: 'result', value: savedValue, tags: savedTags, imageUrl: record.imageUrl })

    } catch (err: unknown) {
      failedCount++
      newResults.push({ id: record.id, type: 'error', imageUrl: record.imageUrl, error: (err as Error).message })
    }

    const allResults = [...existingResults, ...newResults].slice(-100)
    await prisma.autoFillJob.update({
      where: { id: jobId },
      data:  { nextIndex: i + 1, processedCount, failedCount, results: allResults },
    })
  }

  // All images in this chunk processed — chain or finish
  if (chunkEnd >= ordered.length) {
    await prisma.autoFillJob.update({ where: { id: jobId }, data: { status: 'done' } })
    await autoStartNextQueued(baseUrl)
  } else {
    // Chain the next chunk via HTTP self-call (gives a fresh function invocation + timeout budget).
    // Retry up to 3 times — if all fail the job stays 'running' and the cron watchdog re-kicks
    // it within 60 seconds.
    let chained = false
    for (let attempt = 0; attempt < 3 && !chained; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt))
      try {
        const res = await fetch(`${baseUrl}/api/admin/auto-caption/jobs/${jobId}/continue`, {
          method:  'POST',
          headers: { 'x-admin-password': process.env.ADMIN_PASSWORD ?? '' },
          signal:  AbortSignal.timeout(10_000),
        })
        if (res.ok) chained = true
      } catch { /* retry */ }
    }
  }
}
