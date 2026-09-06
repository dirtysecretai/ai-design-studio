import { NextResponse } from 'next/server'
import { streamText, stepCountIs, type LanguageModel } from 'ai'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import { getChatModelForUser } from '@/lib/chat-hub-models'
import {
  loadUserKeys, loadChatPrefs, resolveChatModel, buildRoster,
  rosterInstructions, mediaInstructions, toolsInstructions, modeInstructions, movieFormatInstructions, audioPlanInstructions, providerFilterWarning,
  identityInstructions, coreDisciplineInstructions, skillOn,
  skillSummariesInstructions, loadGlobalMemory,
  sanitizeAgentMode, buildHistoryMessages, makeAgentTools, agentStreamResponse,
  maybeCompactChat, loadTicketBalance, persistFinalEdit, inlineWeakModelImages,
  type RoutingMap, type AgentStep, type SkillSet, type PlanBudget,
} from '@/lib/chat-hub-agent'
import { sanitizeSkillIds, movieFormatSeconds } from '@/lib/chat-hub-skills'
import { isChatCancelRequested, clearChatCancel } from '@/lib/chat-hub-cancel'
import { generateChatTitle } from '@/lib/chat-hub-title'

export const maxDuration = 300

// How many prior messages are sent to the model as context. History is always
// rebuilt from the DB — the client never supplies it — so future programmatic
// callers get identical semantics for free.
const HISTORY_WINDOW = 40

function sanitizeRoutes(raw: unknown, fallbackRoute: unknown, provider: string): RoutingMap {
  const routes: RoutingMap = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if ((v === 'gateway' || v === 'direct') && ['Anthropic', 'OpenAI', 'Google', 'xAI'].includes(k)) {
        routes[k as keyof RoutingMap] = v
      }
    }
  } else if (fallbackRoute === 'direct' || fallbackRoute === 'gateway') {
    routes[provider as keyof RoutingMap] = fallbackRoute
  }
  return routes
}

// POST /api/chat-hub/chats/[id]/send — { content, model, routes?, route?, imageUrls? }
// Streams NDJSON agent events (text deltas + live tool-step cards). The chat's
// agentMode governs execution: plan (no tools), accept (tool calls pause for
// approval — continued via the /approve route), approved (auto-execute).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireChatHubAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const chatId = parseInt((await params).id)
  if (isNaN(chatId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const model = typeof body.model === 'string' ? body.model : ''
  if (!content) return NextResponse.json({ error: 'Message is empty' }, { status: 400 })

  const prefs = await loadChatPrefs(user.id)
  // A chat already knows which model it runs on, so an omitted `model` is not
  // an error — it means "the one this chat was created with". The hub always
  // sends it; the Employees workspaces have no model picker and should not
  // have to invent one. Without this fallback their sends 400'd before the
  // user's message was ever written.
  const chatRow = await prisma.chat.findFirst({
    where: { id: chatId, userId: user.id },
    select: { model: true },
  })
  if (!chatRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const modelSpec = getChatModelForUser(model || chatRow.model, prefs.customModels)
  if (!modelSpec) return NextResponse.json({ error: 'Unknown model' }, { status: 400 })

  // Attached reference images: https URLs only, clamped to the model's input cap
  const imageUrls: string[] = Array.isArray(body.imageUrls)
    ? body.imageUrls
        .filter((u: unknown): u is string => typeof u === 'string' && /^https:\/\//.test(u))
        .slice(0, modelSpec.maxImages)
    : []

  const userKeys = await loadUserKeys(user.id)
  // The hub sends its routing with every message; the Employees workspaces have
  // no routing UI. Without a fallback they always resolved to the Vercel
  // gateway and failed with "No Vercel AI Hub key" even when the account is set
  // up to call Google directly.
  const bodyRoutes = sanitizeRoutes(body.routes, body.route, modelSpec.provider)
  const routes = Object.keys(bodyRoutes).length > 0 ? bodyRoutes : prefs.routing
  const resolved = resolveChatModel(modelSpec, routes, userKeys)
  if (typeof resolved === 'object' && resolved !== null && 'error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 500 })
  }

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId: user.id },
    select: {
      id: true, title: true, systemPrompt: true, agentMode: true, skills: true, source: true,
      projectId: true, memorySummary: true, summaryUpToId: true,
      project: { select: { memory: true } },
    },
  })
  if (!chat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const agentMode = sanitizeAgentMode(chat.agentMode)
  // Enabled skills (null = all = legacy behavior)
  const skillIds = sanitizeSkillIds(chat.skills)
  const skillSet: SkillSet = skillIds === null ? null : new Set(skillIds)
  // A film needs far more steps than a chat reply: intake alone spends
  // reasoning, ask_user, four or five playbook loads and propose_plan, and the
  // production has not started. At 16 the run ran out mid-shoot and simply
  // stopped, which reads to the user as "it broke".
  const STEP_CAP = skillOn(skillSet, 'movie-production') || skillOn(skillSet, 'character-design') ? 30 : 16

  const mediaEnabled = skillOn(skillSet, 'image-generation') || skillOn(skillSet, 'video-production')
  const editEnabled = skillOn(skillSet, 'photoshop') || skillOn(skillSet, 'sketching')

  // Stale pending approvals: the user replied with new context instead of
  // approving — mark them superseded (not "denied", which reads as a refusal)
  const stale = await prisma.chatMessage.findFirst({
    where: { chatId, role: 'assistant' },
    orderBy: { id: 'desc' },
    select: { id: true, metadata: true },
  })
  const staleMeta = (stale?.metadata ?? {}) as Record<string, unknown>
  if (stale && staleMeta.pendingApproval) {
    const steps = ((staleMeta.agentSteps ?? []) as AgentStep[]).map(s =>
      s.status === 'pending' ? { ...s, status: 'superseded' as const } : s)
    await prisma.chatMessage.update({
      where: { id: stale.id },
      data: { metadata: JSON.parse(JSON.stringify({ ...staleMeta, agentSteps: steps, pendingApproval: null })) },
    })
  }

  const userRow = await prisma.chatMessage.create({ data: { chatId, role: 'user', content, imageUrls } })
  // First exchange: the first message stands in as the title until the run
  // finishes, then a one-shot auto-title replaces it (see onFinish)
  // Films start life as 'Untitled film', chats as 'New chat' — either is the
  // placeholder that says "nobody has named this yet".
  const isFilm = chat.source === 'movie-studio'
  const firstExchange = chat.title === 'New chat' || chat.title === 'Untitled film'
  // A chat borrows its first message as a stand-in title; a film keeps
  // "Untitled film" until the user names it, so the tab never shows a title
  // nobody chose.
  const placeholderTitle = isFilm ? chat.title : content.slice(0, 60)
  await prisma.chat.update({
    where: { id: chatId },
    data: {
      // The RESOLVED model, never the raw body value. A caller with no model
      // picker sends none, and writing that empty string wiped the chat's
      // model — every later request then failed with "Chat model no longer
      // available", which is what happened to the film workspaces.
      model: modelSpec.id,
      ...(firstExchange ? { title: placeholderTitle } : {}),
    },
  })

  const historyRows = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { id: 'desc' },
    take: HISTORY_WINDOW,
    select: { role: true, content: true, imageUrls: true, metadata: true },
  })
  historyRows.reverse()
  const messages = buildHistoryMessages(historyRows, { weakModel: !!(modelSpec.ollama || modelSpec.runpod) })

  // Self-hosted models (Ollama, RunPod) can't reliably fetch remote image URLs,
  // and vLLM/Qwen3-VL 500s on RGBA (transparent) images. Flatten alpha → RGB,
  // downscale, and inline every attachment as bytes.
  // GOOGLE models need the same treatment for a different reason: the AI SDK
  // passes URL-backed file parts to Gemini as fileData.fileUri, and the Gemini
  // API only accepts Google-hosted URIs — arbitrary R2/blob URLs come back as
  // a bogus "Resource has been exhausted" 429. This silently broke EVERY
  // image-attached Google chat (the "Art Director can't do it" mystery).
  if (modelSpec.ollama || modelSpec.runpod || modelSpec.provider === 'Google') {
    await inlineWeakModelImages(messages)
  }

  const roster = buildRoster({
    userKeys, routes,
    customModels: prefs.customModels,
    agentRoster: prefs.agentRoster,
    excludeId: model,
  })
  const ticketBalance = await loadTicketBalance(user.id, user.email)
  const globalMemory = skillOn(skillSet, 'project-memory') ? await loadGlobalMemory(user.id) : ''
  const instructions = [
    identityInstructions(),
    coreDisciplineInstructions(),
    (modelSpec.ollama || modelSpec.runpod)
      ? 'SELF-HOSTED MODEL — HARD RULE ON TOOLS: To do ANYTHING real (edit, mask, remove background, generate, overlay), you MUST emit an actual structured tool call. The system runs it and returns the real result — including the real image URL. NEVER type tool names, step markers like "[Agent step: …]", "[Generated media: …]", or any image URL as prose: a URL you write yourself is fabricated and will 404. If you find yourself DESCRIBING an edit or apologizing for a bad result, do not narrate a fix — emit the corrected tool call instead. One real tool call beats any amount of text.'
      : '',
    chat.systemPrompt?.trim() || '',
    skillSummariesInstructions(skillSet, agentMode === 'plan'),
    skillOn(skillSet, 'delegation') ? rosterInstructions(roster) : '',
    // Plan mode gets the catalog too — a thorough plan names real models,
    // settings and ticket costs (modeInstructions overrides the tool rules)
    mediaInstructions(ticketBalance, prefs.modelPrefs, skillSet, true),
    providerFilterWarning(content, skillSet),
    movieFormatInstructions(skillSet, prefs.movieFormat),
    audioPlanInstructions(skillSet, prefs.audioPlan),
    agentMode === 'plan' ? '' : toolsInstructions(chat.projectId !== null, skillSet),
    globalMemory,
    chat.project?.memory?.trim()
      ? `PROJECT MEMORY (persistent notes for this project — update via save_memory):\n${chat.project.memory.trim()}`
      : '',
    chat.memorySummary?.trim()
      ? `EARLIER CONVERSATION (auto-compacted summary of messages before the recent window):\n${chat.memorySummary.trim()}`
      : '',
    modeInstructions(agentMode),
  ].filter(Boolean).join('\n\n') || undefined

  // Images the agent may operate on: this message's refs + everything already
  // in the conversation (generated media, earlier attachments)
  const allowedImages = new Set<string>(imageUrls)
  for (const row of historyRows) for (const u of row.imageUrls) allowedImages.add(u)

  // Refs for the create_media fallback (used when the model passes none):
  // this message's attachments, else the most recent user attachments in the
  // window — "now generate it" turns keep the refs from the message before
  const lastAttachedRow = [...historyRows].reverse().find(r => r.role === 'user' && r.imageUrls.length > 0)
  const effectiveAttachedRefs = imageUrls.length ? imageUrls : (lastAttachedRow?.imageUrls ?? [])

  // An approved plan budget belongs to the CHAT, not to the single reply that
  // happened to collect the approval. A film runs across several replies — the
  // render queue hands shots back and the run continues in a fresh send — and
  // this route never looked the budget up, so pass 2 asked the user to approve
  // a plan they had already approved and paid for.
  //
  // Take the most recent budget in the window that still has money in it. A
  // 0-total plan is a FREE plan and stays active; a spent one does not.
  let planBudget: PlanBudget | null = null
  for (let i = historyRows.length - 1; i >= 0; i--) {
    const pb = (historyRows[i].metadata as { planBudget?: { total?: unknown; spent?: unknown } } | null)?.planBudget
    if (!pb || typeof pb.total !== 'number') continue
    const total = pb.total
    const spent = typeof pb.spent === 'number' ? pb.spent : 0
    if (total === 0 || total > spent) planBudget = { total, spent }
    break // only the newest one counts — an older, exhausted plan is finished
  }

  const generatedUrls: string[] = []
  // Live-progress writes run serialized on this chain (see onProgress)
  let progressChain: Promise<unknown> = Promise.resolve()
  const tools = makeAgentTools({
    mode: agentMode, roster, routes, userKeys,
    // requireChatHubAdmin gated this request — the hub is admin-only today
    isAdmin: true,
    user: { id: user.id, email: user.email },
    attachedImageUrls: effectiveAttachedRefs,
    generatedUrls,
    allowedImages,
    projectId: chat.projectId,
    skills: skillSet,
    // Carried from the approved plan so a continuation does not re-ask
    planBudget,
    // Scopes the shot-list duplicate guard to this film
    chatId,
    // So assemble_film can object when the cut lands far under the runtime
    // the user picked, rather than trusting the model to notice.
    targetSeconds: movieFormatSeconds(prefs.movieFormat),
    budgetCap: prefs.budgetCap,
  })

  // Anthropic prompt caching (probe-verified on ai@7): a cache_control marker
  // on the final message caches the whole prefix — instructions + history —
  // so every subsequent step of this run reads it at ~10% of input price
  // (5-min TTL). Anthropic-provider models only; ignored elsewhere.
  if (modelSpec.provider === 'Anthropic' && messages.length) {
    const last = messages[messages.length - 1] as (typeof messages)[number] & { providerOptions?: Record<string, any> }
    last.providerOptions = {
      ...(last.providerOptions ?? {}),
      anthropic: { ...(last.providerOptions?.anthropic ?? {}), cacheControl: { type: 'ephemeral' } },
    }
  }

  // Fire-and-forget: fold overflowed history into the running summary for
  // the NEXT turn (no latency added to this one)
  void maybeCompactChat({
    chatId,
    memorySummary: chat.memorySummary,
    summaryUpToId: chat.summaryUpToId,
    userKeys, routes,
    fallbackModelId: model,
  })

  try {
    const result = streamText({
      model: resolved as LanguageModel,
      instructions,
      messages,
      tools,
      stopWhen: stepCountIs(STEP_CAP),
      // Anthropic hard-requires max_tokens > thinking budget — the provider's
      // default output cap is 4096, equal to the budget, which 400s instantly
      maxOutputTokens: 16384,
      // Thinking → "Thinking it through" cards in the UI. Anthropic thinking is
      // enabled here (fresh turn) but NOT on the approve continuation: Anthropic
      // requires the paused assistant turn's signed thinking blocks to be
      // replayed with tool results, and we don't persist those.
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: true } },
        // Claude 5-era API: 'adaptive' (verified live); 'enabled'+budget is
        // rejected by every current Anthropic model on this account
        anthropic: { thinking: { type: 'adaptive' } },
      },
      onError: ({ error }) => { console.error('chat-hub send stream error:', error) },
    })

    return agentStreamResponse({
      agentMode,
      isCanceled: () => isChatCancelRequested(chatId),
      // A film continues across replies, so this route now runs mid-plan work
      // that only the approve route used to. Same safety net: if the model
      // stops while the approved plan still has real money and nothing is
      // pending, push it once to do the next step or say it is finished.
      // Without this, a turn that got refused or lost its footing ended with
      // the user's approved budget silently unspent.
      retryIfIncomplete: async (assistantText) => {
        if (!planBudget) return null
        const remaining = planBudget.total - planBudget.spent
        if (remaining < 5 || !assistantText.trim()) return null
        try {
          const cont = streamText({
            model: resolved as LanguageModel,
            instructions,
            messages: [
              ...messages,
              { role: 'assistant', content: assistantText },
              {
                role: 'user',
                content:
                  `SYSTEM CHECK: the approved plan still has ${remaining} of ${planBudget.total} tickets unspent and you ended your turn with nothing pending. `
                  + `If a PLANNED step genuinely remains undone, CONTINUE NOW — one short progress sentence, then call the next tool. `
                  + `If a tool refused your call, read WHY and act on it rather than stopping: a guard that reports work already in flight means WAIT for it, not finish. `
                  + `UNSPENT BUDGET IS SAVINGS, NOT A TO-DO: never create assets beyond the plan's step list. `
                  + `If every planned step is complete or genuinely blocked, say so in one sentence and call write_summary. Do not repeat earlier text.`,
              },
            ],
            tools,
            stopWhen: stepCountIs(STEP_CAP),
            maxOutputTokens: 16384,
            onError: ({ error }) => { console.error('chat-hub send continuation error:', error) },
          })
          return cont.fullStream
        } catch { return null }
      },
      // 24B-class local models can sit silent for minutes on cold load /
      // long prompt eval — don't watchdog them at cloud pace
      idleMs: modelSpec.ollama || modelSpec.runpod ? 600_000 : undefined,
      // Live progress rides on the triggering user row's metadata — a page
      // that reloads mid-run polls it and keeps rendering the reply live.
      // Writes are SERIALIZED so finalize can await the chain — a straggler
      // landing after the clear resurrected stale "editing…" states.
      onProgress: ({ text, steps }) => {
        progressChain = progressChain.then(() =>
          prisma.chatMessage.update({
            where: { id: userRow.id },
            data: {
              metadata: JSON.parse(JSON.stringify({
                liveRun: { text, steps, model, updatedAt: Date.now() },
              })),
            },
          }).catch(() => {})
        )
      },
      begin: async () => result.fullStream,
      // The model wrote "generating now…" prose without calling create_media —
      // send it straight back with orders to execute (or quiz), not re-plan.
      // Only meaningful when a media skill is enabled.
      // Some models (Gemini especially) occasionally think for a long time and
      // then end the turn with NO visible output — the user sees a lone
      // "Thought it through" card and silence. Push once for a real answer.
      retryIfEmpty: async () => {
        try {
          const answer = streamText({
            model: resolved as LanguageModel,
            instructions,
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  'SYSTEM CHECK: your previous turn produced NO visible reply — only internal reasoning, which the user cannot read. Answer the user NOW: write your actual response text and make any tool calls the request needs (quiz/plan/generation). Do not end this turn empty again.',
              },
            ],
            tools,
            stopWhen: stepCountIs(STEP_CAP),
            maxOutputTokens: 16384,
            providerOptions: {
              google: { thinkingConfig: { includeThoughts: true } },
              anthropic: { thinking: { type: 'adaptive' } },
            },
            onError: ({ error }) => { console.error('chat-hub empty-retry stream error:', error) },
          })
          return answer.fullStream
        } catch (err) {
          console.error('chat-hub empty-retry error:', err)
          return null
        }
      },
      retryIfPhantom: (agentMode === 'plan' || (!mediaEnabled && !editEnabled)) ? undefined : async (assistantText) => {
        try {
          const correction = streamText({
            model: resolved as LanguageModel,
            instructions,
            messages: [
              ...messages,
              { role: 'assistant', content: assistantText },
              {
                role: 'user',
                content:
                  'SYSTEM CHECK: your reply announced or described work, but you called NO tools — nothing was executed and any URLs you wrote do not exist. Fix it NOW in this reply: make the tool calls the work needs (edit_image for edits/layouts, create_media for generations — with ask_user or propose_plan first when info or approval is required). If you genuinely cannot proceed, say why plainly instead of announcing work. Keep any text to one short sentence.',
              },
            ],
            tools,
            stopWhen: stepCountIs(STEP_CAP),
            maxOutputTokens: 16384,
            providerOptions: {
              google: { thinkingConfig: { includeThoughts: true } },
              anthropic: { thinking: { type: 'adaptive' } },
            },
            onError: ({ error }) => { console.error('chat-hub phantom-retry stream error:', error) },
          })
          return correction.fullStream
        } catch (err) {
          console.error('chat-hub phantom-retry error:', err)
          return null
        }
      },
      finalize: async ({ text, steps, pending, errored, canceled, elapsedMs }) => {
        clearChatCancel(chatId)
        // Run settled — drop the live-progress mirror (the real row is truth).
        // Await in-flight progress writes FIRST so none lands after the clear.
        try { await progressChain } catch {}
        void prisma.chatMessage.update({
          where: { id: userRow.id }, data: { metadata: {} },
        }).catch(() => {})
        if (!text.trim() && generatedUrls.length === 0 && steps.length === 0) {
          if (canceled) {
            const row = await prisma.chatMessage.create({
              data: {
                chatId, role: 'assistant',
                content: '*(run canceled before any output)*',
                model,
                metadata: { canceled: true, runMs: elapsedMs },
              },
            })
            return row.id
          }
          if (!errored) return null
          // Persist a visible failure stub — a dangling user message makes the
          // reload logic show "still working" and poll a run that's dead
          const row = await prisma.chatMessage.create({
            data: {
              chatId, role: 'assistant', content:
                '*(generation failed — the model returned an error before replying. Send again, or use the ↺ button to retry with another model.)*',
              model,
              metadata: { streamErrored: true, runMs: elapsedMs },
            },
          })
          return row.id
        }
        let usage: unknown, finishReason: unknown
        try { usage = await result.totalUsage } catch {}
        try { finishReason = await result.finishReason } catch {}
        const row = await prisma.chatMessage.create({
          data: {
            chatId,
            role: 'assistant',
            content: text,
            model,
            imageUrls: [...new Set(generatedUrls)].filter(Boolean),
            metadata: JSON.parse(JSON.stringify({
              usage, finishReason, routes,
              runMs: elapsedMs,
              ...(canceled ? { canceled: true } : {}),
              // Partial replies from aborted/errored streams must not render
              // a green "Done" — the client shows a "Stopped" strip instead
              ...(errored ? { streamErrored: true } : {}),
              // URLs authorized mid-run (dataset buckets, search_refs) — the
              // approve route restores these so approved edit/create calls
              // can still use them after the pause
              allowedExtra: [...allowedImages].slice(-300),
              // Text segments: distinct sub-cards in the UI (initial message,
              // post-approval continuations…)
              textSegments: text.trim() ? [text] : [],
              ...(steps.length ? { agentSteps: steps } : {}),
              // Carry the budget forward with what this reply actually spent,
              // so the NEXT continuation reads accurate remaining money instead
              // of re-reading the pre-spend figure from an older reply.
              ...(planBudget ? { planBudget } : {}),
              ...(pending.length ? { pendingApproval: { calls: pending, round: 1 } } : {}),
            })),
          },
        })
        await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
        // One-shot auto-title after the first exchange. Conditional on the
        // placeholder still being in place, so a manual rename mid-run wins.
        // Films are NOT auto-titled: the employee offers titles in its intake
        // questions and the user picks or writes one, which the workspace then
        // applies. Naming it here would decide that before they were asked.
        if (firstExchange && !isFilm) {
          void generateChatTitle(content, text).then(async (title) => {
            if (!title || title === placeholderTitle) return
            await prisma.chat.updateMany({ where: { id: chatId, title: placeholderTitle }, data: { title } })
          }).catch(() => {})
        }
        // Run settled (Auto mode can finish in one stream) → sync final edit
        void persistFinalEdit(user.id, steps, pending.length)
        return row.id
      },
    })
  } catch (error) {
    console.error('chat-hub send error:', error)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
