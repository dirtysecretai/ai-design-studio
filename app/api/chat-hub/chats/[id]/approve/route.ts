import { NextResponse } from 'next/server'
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolContent } from 'ai'
import prisma from '@/lib/prisma'
import { requireChatHubAdmin } from '@/lib/chat-hub-auth'
import { getChatModelForUser, DEFAULT_CHAT_MODEL } from '@/lib/chat-hub-models'
import {
  loadUserKeys, loadChatPrefs, resolveChatModel, buildRoster,
  rosterInstructions, mediaInstructions, toolsInstructions, modeInstructions, movieFormatInstructions, audioPlanInstructions,
  identityInstructions, coreDisciplineInstructions, skillOn,
  skillSummariesInstructions, loadGlobalMemory,
  sanitizeAgentMode, buildHistoryMessages, makeAgentTools, agentStreamResponse,
  executeDelegateTask, executeGenerateImage, executeCreateMedia, executeEditImage,
  executeEditInstructions, executeDataset, loadTicketBalance, persistFinalEdit,
  inlineWeakModelImages,
  type RoutingMap, type AgentStep, type PendingCall, type PlanBudget, type SkillSet,
} from '@/lib/chat-hub-agent'
import { executeRenderShots, executeRenderPlates, executeCheckShots, executeAssembleFilm, executeCreateAudio, executeExtractFrames } from '@/lib/chat-film-tools'
import { movieFormatSeconds } from '@/lib/chat-hub-skills'
import { sanitizeSkillIds } from '@/lib/chat-hub-skills'
import { isChatCancelRequested, clearChatCancel } from '@/lib/chat-hub-cancel'
import { getPlaybook } from '@/lib/chat-hub-playbooks'
import { loadInstagramCreds, publishImage, publishReel } from '@/lib/chat-hub-instagram'

export const maxDuration = 300

const HISTORY_WINDOW = 40
// Multi-step media pipelines legitimately need many rounds (start frame →
// evaluate → end frame → evaluate → video → …) — the cap is only a runaway guard
const MAX_APPROVAL_ROUNDS = 12

function sanitizeRoutes(raw: unknown): RoutingMap {
  const routes: RoutingMap = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if ((v === 'gateway' || v === 'direct') && ['Anthropic', 'OpenAI', 'Google', 'xAI'].includes(k)) {
        routes[k as keyof RoutingMap] = v
      }
    }
  }
  return routes
}

// POST /api/chat-hub/chats/[id]/approve — { messageId, approvals:[{toolCallId, approved}], routes? }
// Executes the approved pending tool calls from an Ask-mode pause, then
// continues the orchestrator with the real tool results. Streams the same
// NDJSON events; the client appends them to the SAME assistant bubble.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireChatHubAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const chatId = parseInt((await params).id)
  if (isNaN(chatId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const messageId = typeof body.messageId === 'number' ? body.messageId : NaN
  if (isNaN(messageId)) return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 })
  const approvals = new Map<string, boolean>(
    Array.isArray(body.approvals)
      ? body.approvals
          .filter((a: any) => a && typeof a.toolCallId === 'string' && typeof a.approved === 'boolean')
          .map((a: any) => [a.toolCallId, a.approved])
      : []
  )
  // Optional per-call settings overrides (user tweaked the media configuration
  // in the approval bar — aspect ratio, resolution, duration, …)
  const settingsOverrides = new Map<string, Record<string, string>>(
    Array.isArray(body.approvals)
      ? body.approvals
          .filter((a: any) => a && typeof a.toolCallId === 'string' && a.settings && typeof a.settings === 'object')
          .map((a: any) => [a.toolCallId, a.settings])
      : []
  )
  // Plan adjustments: the user can raise/lower the ticket budget and attach
  // free-text tweaks ("use 4k", "swap to SeeDream") when approving a plan
  const planAdjustments = new Map<string, { budget?: number; note?: string }>(
    Array.isArray(body.approvals)
      ? body.approvals
          .filter((a: any) => a && typeof a.toolCallId === 'string'
            && (typeof a.budget_override === 'number' || typeof a.note === 'string'))
          .map((a: any) => [a.toolCallId, {
            ...(typeof a.budget_override === 'number' ? { budget: Math.max(0, Math.round(a.budget_override)) } : {}),
            ...(typeof a.note === 'string' && a.note.trim() ? { note: a.note.trim().slice(0, 300) } : {}),
          }])
      : []
  )

  // ask_user quiz answers: [{question, answer}] per call
  const answersByCall = new Map<string, { question: string; answer: string }[]>(
    Array.isArray(body.approvals)
      ? body.approvals
          .filter((a: any) => a && typeof a.toolCallId === 'string' && Array.isArray(a.answers))
          .map((a: any) => [
            a.toolCallId,
            a.answers
              .filter((x: any) => x && typeof x.question === 'string' && typeof x.answer === 'string')
              .slice(0, 4)
              .map((x: any) => ({ question: x.question.slice(0, 300), answer: x.answer.slice(0, 300) })),
          ])
      : []
  )

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId: user.id },
    select: {
      id: true, model: true, systemPrompt: true, agentMode: true, skills: true,
      projectId: true, memorySummary: true,
      project: { select: { memory: true } },
    },
  })
  if (!chat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const agentMode = sanitizeAgentMode(chat.agentMode)
  const skillIds = sanitizeSkillIds(chat.skills)
  const skillSet: SkillSet = skillIds === null ? null : new Set(skillIds)
  // A film needs far more steps than a chat reply: intake alone spends
  // reasoning, ask_user, four or five playbook loads and propose_plan, and the
  // production has not started. At 16 the run ran out mid-shoot and simply
  // stopped, which reads to the user as "it broke".
  const STEP_CAP = skillOn(skillSet, 'movie-production') || skillOn(skillSet, 'character-design') ? 30 : 16


  const row = await prisma.chatMessage.findFirst({
    where: { id: messageId, chatId, role: 'assistant' },
  })
  if (!row) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  const meta = (row.metadata ?? {}) as Record<string, any>
  const pendingApproval = meta.pendingApproval as { calls: PendingCall[]; round: number } | undefined
  if (!pendingApproval?.calls?.length) {
    return NextResponse.json({ error: 'Nothing awaiting approval on this message' }, { status: 400 })
  }
  if ((pendingApproval.round ?? 1) > MAX_APPROVAL_ROUNDS) {
    // Don't leave the user stuck with an un-runnable, un-deniable bar: cancel
    // the pending calls on the row so the UI clears, and say what to do next.
    const steps = ((meta.agentSteps ?? []) as AgentStep[]).map(s =>
      s.status === 'pending' ? { ...s, status: 'denied' as const } : s)
    await prisma.chatMessage.update({
      where: { id: row.id },
      data: { metadata: JSON.parse(JSON.stringify({ ...meta, agentSteps: steps, pendingApproval: null })) },
    }).catch(() => {})
    return NextResponse.json({
      error: `This reply hit the ${MAX_APPROVAL_ROUNDS}-round safety limit — its pending requests were cancelled. Send a new message to continue the work in a fresh reply.`,
    }, { status: 400 })
  }

  const prefs = await loadChatPrefs(user.id)
  // A chat whose model is missing or retired should not become unusable: fall
  // back to the default rather than stranding the user's work behind an error
  // they cannot act on.
  const modelSpec = getChatModelForUser(chat.model, prefs.customModels)
    ?? getChatModelForUser(DEFAULT_CHAT_MODEL, prefs.customModels)
  if (!modelSpec) return NextResponse.json({ error: 'Chat model no longer available' }, { status: 400 })
  const userKeys = await loadUserKeys(user.id)
  const bodyRoutes = sanitizeRoutes(body.routes)
  // Same fallback as the send route: a caller without a routing UI still gets
  // the account's saved provider routing instead of defaulting to the gateway.
  const routes = Object.keys(bodyRoutes).length > 0 ? bodyRoutes : prefs.routing
  const resolved = resolveChatModel(modelSpec, routes, userKeys)
  if (typeof resolved === 'object' && resolved !== null && 'error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 500 })
  }

  const roster = buildRoster({
    userKeys, routes,
    customModels: prefs.customModels,
    agentRoster: prefs.agentRoster,
    excludeId: chat.model,
  })

  const priorSteps: AgentStep[] = Array.isArray(meta.agentSteps) ? meta.agentSteps : []
  const generatedUrls: string[] = []

  // Plan budget approved in an earlier round of this reply (propose_plan) —
  // in-plan work executes without further pauses until it's exhausted
  let planBudget: PlanBudget | null =
    meta.planBudget && typeof meta.planBudget.total === 'number'
      ? { total: meta.planBudget.total, spent: typeof meta.planBudget.spent === 'number' ? meta.planBudget.spent : 0 }
      : null

  // "Approve + don't ask again for edits this run" — sticky for the reply
  const autoApproveEdits = meta.autoApproveEdits === true || body.autoApproveEdits === true

  const ticketBalance = await loadTicketBalance(user.id, user.email)
  const globalMemory = skillOn(skillSet, 'project-memory') ? await loadGlobalMemory(user.id) : ''

  // Denial wind-down: when the user approved NOTHING this round (or declined
  // a plan/plan-update), the continuation must wrap up — not keep executing
  const anyApproved = pendingApproval.calls.some(c => approvals.get(c.toolCallId) ?? false)
  const planDenied = pendingApproval.calls.some(
    c => c.toolName === 'propose_plan' && !(approvals.get(c.toolCallId) ?? false))
  const windDown = !anyApproved || planDenied

  // Playbooks loaded via load_skill earlier this reply: buildHistoryMessages
  // compresses steps to short markers, so the playbook text would vanish
  // exactly when plan-budget execution starts — re-inject it here.
  const loadedPlaybookIds = [...new Set(
    priorSteps
      .filter(s => s.tool === 'load_skill' && s.status === 'done' && typeof s.task === 'string')
      .map(s => s.task as string)
  )]
  const loadedPlaybooks = loadedPlaybookIds
    .map(id => getPlaybook(id, { skills: skillSet }))
    .filter((t): t is string => !!t)

  const instructions = [
    identityInstructions(),
    coreDisciplineInstructions(),
    chat.systemPrompt?.trim() || '',
    skillSummariesInstructions(skillSet, agentMode === 'plan'),
    skillOn(skillSet, 'delegation') ? rosterInstructions(roster) : '',
    mediaInstructions(ticketBalance, prefs.modelPrefs, skillSet, true),
    movieFormatInstructions(skillSet, prefs.movieFormat),
    audioPlanInstructions(skillSet, prefs.audioPlan),
    toolsInstructions(chat.projectId !== null, skillSet),
    globalMemory,
    chat.project?.memory?.trim()
      ? `PROJECT MEMORY (persistent notes for this project — update via save_memory):\n${chat.project.memory.trim()}`
      : '',
    loadedPlaybooks.length
      ? `LOADED PLAYBOOKS (loaded earlier this reply via load_skill — still in force):\n\n${loadedPlaybooks.join('\n\n')}`
      : '',
    chat.memorySummary?.trim()
      ? `EARLIER CONVERSATION (auto-compacted summary of messages before the recent window):\n${chat.memorySummary.trim()}`
      : '',
    windDown
      ? 'PLAN DENIED — the user declined the pending request(s). Do NOT re-propose the same plan and do NOT start any new work that costs tickets. Acknowledge the denial in at most 2 sentences, call write_summary if this reply does not have one yet, and STOP.'
      : '',
    modeInstructions(agentMode),
  ].filter(Boolean).join('\n\n') || undefined

  // Shared with the plan-completion guard (set inside `begin`)
  let continuationMessages: ModelMessage[] | null = null
  let continuationTools: ReturnType<typeof makeAgentTools> = undefined
  // Shared with finalize: mid-run authorized URLs (dataset/search_refs)
  let runAllowedImages: Set<string> | null = null
  // Live-progress writes run serialized on this chain (see onProgress)
  let progressChain: Promise<unknown> = Promise.resolve()

  try {
    return agentStreamResponse({
      agentMode,
      isCanceled: () => isChatCancelRequested(chatId),
      idleMs: modelSpec.ollama || modelSpec.runpod ? 600_000 : undefined,
      seedSteps: priorSteps,
      // A 0-ticket approved plan is a FREE plan (edit-only work) — it stays
      // active for the whole reply so free steps auto-run without re-asking.
      // Paid budgets deactivate once spent.
      isBudgetActive: () => !!planBudget && (planBudget.total === 0 || planBudget.total > planBudget.spent),
      editsAutoApproved: () => autoApproveEdits,
      // New tool calls made in this continuation belong to the segment this
      // round is writing — the UI interleaves them at that point
      segIndex: Array.isArray(meta.textSegments) ? meta.textSegments.length : (row.content ? 1 : 0),
      // Live progress: keep the row itself current (content/steps/segments)
      // so a page reloaded mid-continuation renders the run as it happens.
      // The liveRun marker tells the client the run is still in flight.
      // Serialized like the send route — finalize awaits the chain so a
      // straggler write can never overwrite the FINAL row state
      onProgress: ({ text, steps }) => {
        const newText = text.trim()
        const priorSegs: string[] = Array.isArray(meta.textSegments)
          ? meta.textSegments
          : (row.content ? [row.content] : [])
        progressChain = progressChain.then(() =>
          prisma.chatMessage.update({
            where: { id: row.id },
            data: {
              content: newText ? (row.content ? `${row.content}\n\n${newText}` : newText) : row.content,
              metadata: JSON.parse(JSON.stringify({
                ...meta,
                pendingApproval: null,
                agentSteps: steps,
                textSegments: newText ? [...priorSegs, newText] : priorSegs,
                liveRun: { updatedAt: Date.now() },
              })),
            },
          }).catch(() => {})
        )
      },
      // Everything (tool execution INCLUDED) runs inside the stream so the
      // client sees live running/done step events instead of a silent wait.
      begin: async (sendEvent, stepById) => {
        const results = new Map<string, unknown>()

        // Attached refs for the create_media fallback: the most recent user
        // message that actually HAS attachments (not just the latest message —
        // "looks good, go ahead" replies would otherwise drop the refs)
        const triggerMsg = await prisma.chatMessage.findFirst({
          where: { chatId, id: { lt: row.id }, role: 'user', NOT: { imageUrls: { isEmpty: true } } },
          orderBy: { id: 'desc' },
          select: { imageUrls: true },
        })
        const attachedImageUrls = triggerMsg?.imageUrls ?? []

        // Images the agent may operate on (edit_image / create_media refs)
        const imageRows = await prisma.chatMessage.findMany({
          where: { chatId },
          orderBy: { id: 'desc' },
          take: 60,
          select: { imageUrls: true },
        })
        const allowedImages = new Set<string>(attachedImageUrls)
        for (const r of imageRows) for (const u of r.imageUrls) allowedImages.add(u)
        // URLs authorized in EARLIER phases of this reply (dataset buckets,
        // search_refs) — persisted at each finalize, restored across pauses.
        // Without this, an approved remove_background on a bucket image dies
        // with "image_url must be one of the images already in this conversation".
        if (Array.isArray(meta.allowedExtra)) {
          for (const u of meta.allowedExtra) if (typeof u === 'string') allowedImages.add(u)
        }
        runAllowedImages = allowedImages

        // Mark denials immediately; run all APPROVED calls IN PARALLEL —
        // each emits running/done events as it progresses
        const approvedCalls: PendingCall[] = []
        for (const call of pendingApproval.calls) {
          const step = stepById.get(call.toolCallId) ?? {
            id: call.toolCallId,
            tool: call.toolName as AgentStep['tool'],
            status: 'pending' as const,
          }
          stepById.set(step.id, step)
          if (approvals.get(call.toolCallId) ?? false) {
            step.status = 'running'
            approvedCalls.push(call)
          } else {
            step.status = 'denied'
          }
          sendEvent({ t: 'step', s: { ...step } })
        }

        // Persist the decision IMMEDIATELY — pendingApproval stripped, step
        // statuses recorded. Without this, the card only clears when the
        // (potentially long) continuation finalizes, so a refresh mid-run or
        // after a crash resurrects an already-answered approval from the DB.
        {
          const roundIds = new Set(pendingApproval.calls.map(c => c.toolCallId))
          const decidedSteps = ((meta.agentSteps ?? []) as AgentStep[]).map(s =>
            roundIds.has(s.id)
              ? { ...s, status: ((approvals.get(s.id) ?? false) ? 'running' : 'denied') as AgentStep['status'] }
              : s)
          await prisma.chatMessage.update({
            where: { id: row.id },
            data: { metadata: JSON.parse(JSON.stringify({ ...meta, agentSteps: decidedSteps, pendingApproval: null })) },
          }).catch(() => {})
        }

        await Promise.all(approvedCalls.map(async (call) => {
          const step = stepById.get(call.toolCallId)!
          const t0 = Date.now()
          let out: any
          try {
            if (call.toolName === 'delegate_task') {
              out = await executeDelegateTask(call.input as any, { roster, routes, userKeys, allowedImages })
            } else if (call.toolName === 'create_media') {
              const rawInput = (call.input ?? {}) as Record<string, unknown>
              const override = settingsOverrides.get(call.toolCallId)
              out = await executeCreateMedia(
                { ...(rawInput as any), settings: override ?? (rawInput.settings as any) },
                { user: { id: user.id, email: user.email }, attachedImageUrls, allowedImages },
              )
              if (out && 'mediaUrl' in out) {
                // A submitted-but-unrendered video has no URL yet — an empty
                // string here becomes <img src=""> in the saved reply, which
                // the browser resolves as the page and re-downloads.
                if (out.mediaUrl) {
                  generatedUrls.push(out.mediaUrl)
                  allowedImages.add(out.mediaUrl) // usable by chained calls this turn
                }
                // Reflect what actually ran (user may have changed the config)
                step.settings = out.settings
                step.cost = out.ticketCost
                step.refs = Array.isArray(out.referenceImageUrls) ? out.referenceImageUrls.slice(0, 12) : []
              }
            } else if (call.toolName === 'edit_image') {
              out = await executeEditImage(call.input as any, {
                user: { id: user.id, email: user.email },
                allowedImages,
              })
              if (out && 'imageUrl' in out) {
                generatedUrls.push(out.imageUrl)
                allowedImages.add(out.imageUrl)
              }
            } else if (call.toolName === 'propose_plan') {
              const inp = (call.input ?? {}) as Record<string, unknown>
              const requested = Math.max(0, Math.round(Number(inp.ticket_budget) || 0))
              const adj = planAdjustments.get(call.toolCallId)
              const add = adj?.budget ?? requested
              if (planBudget) planBudget.total += add
              else planBudget = { total: add, spent: 0 }
              out = {
                approved: true,
                budget: { total: planBudget.total, spent: planBudget.spent, remaining: planBudget.total - planBudget.spent },
                note: `Plan approved — budget now ${planBudget.total} tickets (${planBudget.spent} already spent). `
                  + (adj?.budget !== undefined && adj.budget !== requested
                    ? `NOTE: the user ADJUSTED the budget to ${add} tickets (you requested ${requested}) — rescale the plan to fit (more budget = higher quality/resolution, less = cheaper models/settings). `
                    : '')
                  + (adj?.note
                    ? `USER ADJUSTMENTS to apply to the plan: "${adj.note}". Honor these exactly. `
                    : '')
                  + `Execute step by step (sequencing + mandatory evaluation still apply); work within the remaining budget runs automatically. `
                  + `If you must exceed it, call propose_plan with is_update=true and the additional tickets.`,
              }
            } else if (call.toolName === 'edit_instructions') {
              out = await executeEditInstructions(call.input as any, { user: { id: user.id }, chatId })
            } else if (call.toolName === 'publish_instagram') {
              const inp = (call.input ?? {}) as { media_type?: string; media_url?: string; caption?: string }
              const mediaUrl = String(inp.media_url ?? '')
              const caption = String(inp.caption ?? '').slice(0, 2200)
              if (!allowedImages.has(mediaUrl)) {
                out = { error: 'media_url must be a URL already in this conversation (generated or attached here)' }
              } else {
                const creds = await loadInstagramCreds(user.id)
                if (!creds) {
                  out = { error: 'Instagram is not connected — the user can connect it in Profile → Chat Settings → Providers → Instagram.' }
                } else if (inp.media_type === 'reel') {
                  out = await publishReel(creds, { videoUrl: mediaUrl, caption })
                } else {
                  out = await publishImage(creds, { imageUrl: mediaUrl, caption })
                }
                if (out && 'permalink' in out) {
                  out = {
                    published: true,
                    permalink: out.permalink,
                    note: `Published to Instagram${out.permalink ? ` — ${out.permalink}` : ''}. The permalink is shown to the user.`,
                  }
                }
              }
            } else if (call.toolName === 'dataset_edit') {
              // requireChatHubAdmin gated this request; executeDataset also
              // fail-closes on non-admin ctx as defense in depth
              out = await executeDataset(call.input as any, { allowedImages, isAdmin: true })
            } else if (call.toolName === 'ask_user') {
              const ans = answersByCall.get(call.toolCallId)
              out = ans && ans.length
                ? {
                    answers: ans,
                    note: 'User answers:\n' + ans.map(a => `${a.question} → ${a.answer}`).join('\n'),
                  }
                : { error: 'The user submitted no answers — proceed with your best judgment' }
            } else if (call.toolName === 'generate_image') {
              out = await executeGenerateImage(call.input as any, {
                user: { id: user.id, email: user.email },
                attachedImageUrls,
              })
              if (out && 'imageUrl' in out) generatedUrls.push(out.imageUrl)
            } else if (
              call.toolName === 'render_shots' || call.toolName === 'render_plates' || call.toolName === 'check_shots'
              || call.toolName === 'assemble_film' || call.toolName === 'create_audio'
              || call.toolName === 'extract_frames'
            ) {
              // The film tools pause for approval too (render_shots and
              // create_audio spend tickets), so approving one used to answer
              // "Unknown tool" and end the movie right there.
              const filmCtx = {
                user: { id: user.id, email: user.email },
                chatId,
                attachedImageUrls,
                allowedImages,
                generatedUrls,
                targetSeconds: movieFormatSeconds(prefs.movieFormat),
                budgetCap: prefs.budgetCap,
              }
              out =
                call.toolName === 'render_shots' ? await executeRenderShots(call.input as any, filmCtx as any)
                : call.toolName === 'render_plates' ? await executeRenderPlates(call.input as any, filmCtx as any)
                : call.toolName === 'check_shots' ? await executeCheckShots(call.input as any, filmCtx as any)
                : call.toolName === 'assemble_film' ? await executeAssembleFilm(call.input as any, filmCtx as any)
                : call.toolName === 'create_audio' ? await executeCreateAudio(call.input as any, filmCtx as any)
                : await executeExtractFrames(call.input as any, filmCtx as any)
              if (out && typeof out.mediaUrl === 'string' && out.mediaUrl) {
                generatedUrls.push(out.mediaUrl)
                allowedImages.add(out.mediaUrl)
              }
            } else if (call.toolName === 'present_storyboard') {
              // APPROVING THE BOARD IS THE GO-AHEAD, NOTHING MORE.
              //
              // This route dispatches each paused tool by name, and anything it
              // does not recognise comes back as "Unknown tool" \u2014 so pressing
              // "Shoot it" handed the studio an error, which it read as the board
              // having failed. It replanned, re-rendered the plates, and asked for
              // the plan again. The tool itself does no work; the approval IS the
              // result, and the gate in render_shots reads this step being done.
              const n = Array.isArray((call.input as any)?.frames) ? (call.input as any).frames.length : 0
              out = {
                approved: true,
                frames: n,
                note:
                  `The user approved the board (${n} shot(s)). Shoot it now: submit the WHOLE shot list in one `
                  + `render_shots call, exactly as boarded. Do not re-render the plates, do not re-plan, and do not `
                  + `ask for the plan again \u2014 this approval is the go-ahead.`,
              }
            } else {
              out = { error: `Unknown tool ${call.toolName}` }
            }
          } catch (err: any) {
            out = { error: String(err?.message || err).slice(0, 200) }
          }
          results.set(call.toolCallId, out)
          if (out?.error) {
            step.status = 'error'
            step.error = String(out.error).slice(0, 500)
          } else if (Array.isArray(out?.queueIds) && out.queueIds.length > 0) {
            // Shots submitted, not rendered: the step stays running and carries
            // the ids so film-status can settle them after this turn ends.
            step.status = 'running'
            ;(step as any).queueIds = (out.queueIds as unknown[]).filter((n): n is number => typeof n === 'number')
            step.resultPreview = String(out?.note ?? '').slice(0, 4000) || undefined
          } else if (out?.pending === true && typeof out?.queueId === 'number') {
            step.status = 'running'
            ;(step as any).queueId = out.queueId
            step.resultPreview = String(out?.note ?? '').slice(0, 4000) || undefined
          } else {
            step.status = 'done'
            step.resultPreview = String(out?.answer ?? out?.note ?? '').slice(0, 4000) || undefined
            if (typeof out?.imageUrl === 'string') step.imageUrl = out.imageUrl
            // An empty mediaUrl is a video with no picture yet, not a result
            if (typeof out?.mediaUrl === 'string' && out.mediaUrl) step.imageUrl = out.mediaUrl
          }
          step.ms = Date.now() - t0
          sendEvent({ t: 'step', s: { ...step } })
        }))

        // ── Continuation history: all rows except the paused one, then the
        //    real tool-call/tool-result exchange ────────────────────────────
        const historyRows = await prisma.chatMessage.findMany({
          where: { chatId, id: { not: row.id } },
          orderBy: { id: 'desc' },
          take: HISTORY_WINDOW,
          select: { role: true, content: true, imageUrls: true, metadata: true },
        })
        historyRows.reverse()
        const messages: ModelMessage[] = buildHistoryMessages(historyRows, { weakModel: !!(modelSpec.ollama || modelSpec.runpod) })

        messages.push({
          role: 'assistant',
          content: [
            ...(row.content ? [{ type: 'text' as const, text: row.content }] : []),
            ...pendingApproval.calls.map(c => ({
              type: 'tool-call' as const,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.input,
            })),
          ],
        })
        // Generated/edited IMAGES go back as multimodal tool results so the
        // orchestrator can SEE and evaluate them in the continuation (then
        // regen with new settings, edit, or chain into image-to-video).
        const toolContent: ToolContent = pendingApproval.calls.map(c => {
          const out: any = results.get(c.toolCallId)
          const url: string | undefined = out?.mediaUrl ?? out?.imageUrl
          const isImage = typeof url === 'string' && !/\.(mp4|webm|mov)(\?|$)/i.test(url)
          return {
            type: 'tool-result' as const,
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            output: results.has(c.toolCallId)
              ? isImage
                ? {
                    type: 'content' as const,
                    value: [
                      { type: 'text' as const, text: JSON.stringify(out) },
                      {
                        type: 'file' as const,
                        data: { type: 'url' as const, url: new URL(url!) },
                        mediaType: /\.png(\?|$)/i.test(url!) ? 'image/png' : /\.webp(\?|$)/i.test(url!) ? 'image/webp' : 'image/jpeg',
                      },
                    ],
                  }
                : { type: 'json' as const, value: out }
              : { type: 'error-text' as const, value: 'The user denied this tool call. Do not retry it; continue without it.' },
          }
        })
        messages.push({ role: 'tool', content: toolContent })

        // Anthropic prompt caching (probe-verified on ai@7): a cache_control
        // marker on the final message caches the whole prefix — instructions +
        // history + tool exchange — so every subsequent step of this
        // continuation reads it at ~10% of input price (5-min TTL).
        if (modelSpec.provider === 'Anthropic' && messages.length) {
          const last = messages[messages.length - 1] as ModelMessage & { providerOptions?: Record<string, any> }
          last.providerOptions = {
            ...(last.providerOptions ?? {}),
            anthropic: { ...(last.providerOptions?.anthropic ?? {}), cacheControl: { type: 'ephemeral' } },
          }
        }

        // Self-hosted models (Ollama/RunPod): flatten RGBA → RGB and inline the
        // continuation's images (history + tool-result cutouts) as bytes, so
        // vLLM doesn't 500 on transparent composites.
        if (modelSpec.ollama || modelSpec.runpod || modelSpec.provider === 'Google') {
          await inlineWeakModelImages(messages)
        }

        const tools = makeAgentTools({
          mode: agentMode, roster, routes, userKeys,
          // requireChatHubAdmin gated this request — the hub is admin-only today
          isAdmin: true,
          user: { id: user.id, email: user.email },
          attachedImageUrls: [],
          generatedUrls,
          allowedImages,
          projectId: chat.projectId,
          chatId,
          planBudget,
          autoApproveEdits,
          skills: skillSet,
        })
        continuationMessages = messages
        continuationTools = tools
        const result = streamText({
          model: resolved as LanguageModel,
          instructions,
          messages,
          tools,
          stopWhen: stepCountIs(STEP_CAP),
          providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
          onError: ({ error }) => { console.error('chat-hub approve stream error:', error) },
        })
        return result.fullStream
      },
      // Model ended its turn while the approved plan still has meaningful
      // unspent budget — it either stopped mid-plan or wrote its summary too
      // early. Push one continuation: do the next step, or confirm completion.
      retryIfIncomplete: async (assistantText) => {
        // After a denial the run is winding down — never push it to keep
        // executing the old plan's remaining budget
        if (windDown) return null
        if (!planBudget || !continuationMessages) return null
        const remaining = planBudget.total - planBudget.spent
        if (remaining < 5 || !assistantText.trim()) return null
        try {
          const cont = streamText({
            model: resolved as LanguageModel,
            instructions,
            messages: [
              ...continuationMessages,
              { role: 'assistant', content: assistantText },
              {
                role: 'user',
                content: (() => {
                  const planStep = [...priorSteps].reverse().find(s => s.tool === 'propose_plan' && s.task)
                  return `SYSTEM CHECK: the approved plan still has ${remaining} of ${planBudget.total} tickets unspent and you ended your turn with nothing pending. `
                    + (planStep?.task ? `THE APPROVED PLAN WAS: "${planStep.task}". Compare it against the steps already completed above. ` : '')
                    + `If a PLANNED step genuinely remains undone, CONTINUE NOW — one short progress sentence, then call the next tool. `
                    + `UNSPENT BUDGET IS SAVINGS, NOT A TO-DO: never create assets beyond the plan's step list. `
                    + `If every planned step is complete, state in one sentence that the remaining budget was not needed, then call write_summary. Do not repeat earlier text.`
                })(),
              },
            ],
            tools: continuationTools,
            stopWhen: stepCountIs(STEP_CAP),
            providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
            onError: ({ error }) => { console.error('chat-hub plan-completion stream error:', error) },
          })
          return cont.fullStream
        } catch (err) {
          console.error('chat-hub plan-completion retry error:', err)
          return null
        }
      },
      finalize: async ({ text, steps, pending, errored, canceled, elapsedMs }) => {
        clearChatCancel(chatId)
        // In-flight progress writes must settle BEFORE the final row update —
        // a straggler landing after it would resurrect stale live state
        try { await progressChain } catch {}
        // (errored is unused here: the row already exists, so a reload shows
        // its current state rather than a dangling user message)
        // `steps` includes seeds (executed/denied) + any new calls from the continuation
        const newText = text.trim()
        const priorSegments: string[] = Array.isArray(meta.textSegments)
          ? meta.textSegments
          : (row.content ? [row.content] : [])
        await prisma.chatMessage.update({
          where: { id: row.id },
          data: {
            content: newText ? (row.content ? `${row.content}\n\n${newText}` : newText) : row.content,
            // Same reason: a shot may have settled into this row between the
            // read above and this write, and an empty url is a pending video
            // that has no picture yet.
            imageUrls: { set: [...new Set([...row.imageUrls, ...generatedUrls])].filter(Boolean) },
            metadata: JSON.parse(JSON.stringify({
              ...meta,
              // Total-run stopwatch: accumulate this continuation's runtime
              runMs: (typeof meta.runMs === 'number' ? meta.runMs : 0) + elapsedMs,
              ...(canceled ? { canceled: true } : {}),
              ...(errored ? { streamErrored: true } : { streamErrored: undefined }),
              // Keep mid-run authorized URLs alive across further pauses
              ...(runAllowedImages ? { allowedExtra: [...runAllowedImages].slice(-300) } : {}),
              ...(autoApproveEdits ? { autoApproveEdits: true } : {}),
              textSegments: newText ? [...priorSegments, newText] : priorSegments,
              agentSteps: steps,
              ...(planBudget ? { planBudget } : {}),
              pendingApproval: pending.length
                ? { calls: pending, round: (pendingApproval.round ?? 1) + 1 }
                : null,
            })),
          },
        })
        await prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } })
        // Run settled → sync the FINAL edit (only) to the portal feed
        void persistFinalEdit(user.id, steps, pending.length)
        return row.id
      },
    })
  } catch (error) {
    console.error('chat-hub approve error:', error)
    return NextResponse.json({ error: 'Continuation failed' }, { status: 500 })
  }
}
