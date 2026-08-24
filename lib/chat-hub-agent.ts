import { generateText, jsonSchema, tool, createGateway, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createXai } from '@ai-sdk/xai'
import { fal } from '@fal-ai/client'
import prisma from '@/lib/prisma'
import { decryptKey } from '@/lib/chat-key-crypto'
import { parseRunpodConfig } from '@/lib/runpod-config'
import { deductGenerationTickets, refundGenerationTickets, isAdminEmail } from '@/lib/ticket-gate'
import {
  CHAT_HUB_MODELS, DIRECT_KEY_ENV, CHAT_TOOL_IMAGE_COST, usableCreateModels,
  getChatModel, getChatModelForUser, sanitizeCustomModels, getCreateModel,
  resolveCreateSettings, computeCreateCost,
  type ChatHubModel, type ChatHubProvider, type ChatHubRoute, type CustomChatModel,
} from '@/lib/chat-hub-models'
import { buildFalCall, generateWithGeminiApi, persistChatGeneration } from '@/lib/chat-hub-create'
import { AGENT_SKILLS, skillOn, type SkillSet } from '@/lib/chat-hub-skills'
import { getPlaybook } from '@/lib/chat-hub-playbooks'

fal.config({ credentials: process.env.FAL_KEY })

// ── Shared agent types (client + server) ────────────────────────────────────

export type AgentMode = 'plan' | 'accept' | 'approved'

export type AgentStep = {
  id: string                 // toolCallId — upsert key
  tool: 'delegate_task' | 'generate_image' | 'create_media' | 'edit_image' | 'search_refs' | 'dataset' | 'dataset_edit' | 'web_search' | 'save_memory' | 'edit_instructions' | 'ask_user' | 'propose_plan' | 'reasoning' | 'record_evaluation' | 'write_summary' | 'load_skill' | 'remember' | 'publish_instagram'
  status: 'running' | 'done' | 'error' | 'pending' | 'denied' | 'superseded'
  model?: string             // delegate target / create model id
  task?: string
  prompt?: string            // media generation prompt
  settings?: Record<string, string> // create_media settings (aspect/quality/…)
  cost?: number              // create_media ticket cost at those settings
  kind?: 'image' | 'video'   // create_media output kind
  refs?: string[]            // create_media reference images (actual ones used once the result lands)
  // edit_image "layer recipe" — the source + full op list, kept so the media
  // viewer can re-edit layers (tweak text/shapes/overlays) and re-render
  editRecipe?: { image_url?: string; canvas?: { width: number; height: number; color?: string }; operations: unknown[] }
  resultPreview?: string
  imageUrl?: string          // generated media URL (image or video)
  error?: string
  ms?: number
  seg?: number               // text-segment round the call was made in — the UI
                             // renders each step right after that segment
  preText?: boolean          // step ran BEFORE any reply text in its stream —
                             // the UI renders it ABOVE the round's text
  textAt?: number            // chars of reply text that existed when this step
                             // started — lets the UI slice text into true
                             // chronological sections around tool runs
}

export type PendingCall = { toolCallId: string; toolName: string; input: unknown }

export type StreamEvent =
  | { t: 'text'; d: string }
  | { t: 'step'; s: AgentStep }
  | { t: 'approval'; messageId: number; calls: PendingCall[] }
  | { t: 'done'; messageId: number | null }
  | { t: 'error'; message: string }
  | { t: 'ping' } // heartbeat — lets the client detect dead connections

export function sanitizeAgentMode(v: unknown): AgentMode {
  return v === 'plan' || v === 'approved' ? v : 'accept'
}

// Plan budget approved by the user via propose_plan — while active (and not
// exhausted), in-plan work runs without per-call approvals.
export type PlanBudget = { total: number; spent: number }

// Approval policy per tool:
//  - publish_instagram: ALWAYS pauses — external, irreversible, never budget-exempt
//  - propose_plan/ask_user/edit_instructions: ALWAYS pause (they ARE user interactions)
//  - create_media/generate_image: pause UNLESS an approved plan budget is active
//    (the user approved the whole plan's cost in one step)
//  - delegate_task/edit_image: pause in Ask mode unless a plan budget is active
//  - search_refs/web_search/save_memory/remember/load_skill: benign — never pause
export function toolPausesForApproval(toolName: string, mode: AgentMode, planBudgetActive = false): boolean {
  if (toolName === 'publish_instagram') return true
  // Dataset MUTATIONS (buckets/folders/training marks) always need explicit
  // approval — never budget-exempt. Reads (the `dataset` tool) stay auto.
  if (toolName === 'dataset_edit') return true
  if (toolName === 'propose_plan' || toolName === 'ask_user' || toolName === 'edit_instructions') return true
  // AUTO mode ('approved') = full autonomy: media calls run inline, no plan
  // budget required. Ask/plan modes keep the plan-approval economy.
  if (toolName === 'create_media' || toolName === 'generate_image') return mode === 'approved' ? false : !planBudgetActive
  if (mode === 'accept' && (toolName === 'delegate_task' || toolName === 'edit_image')) return !planBudgetActive
  return false
}

// ── Key + routing resolution ────────────────────────────────────────────────

export type RoutingMap = Partial<Record<ChatHubProvider, ChatHubRoute>>

export async function loadUserKeys(userId: number): Promise<Record<string, string>> {
  const rows = await prisma.chatProviderKey.findMany({
    where: { userId },
    select: { provider: true, encrypted: true },
  })
  const keys: Record<string, string> = {}
  for (const row of rows) {
    const plain = decryptKey(row.encrypted)
    if (plain) keys[row.provider] = plain
  }
  return keys
}

export type ModelPrefs = { video?: string; image?: string; notes?: string }

export async function loadChatPrefs(userId: number): Promise<{
  customModels: CustomChatModel[]
  agentRoster: string[] | null
  modelPrefs: ModelPrefs
}> {
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { portalPreferences: true },
    })
    const prefs = (row?.portalPreferences as Record<string, unknown>) ?? {}
    const roster = Array.isArray(prefs.chatHubAgentRoster)
      ? (prefs.chatHubAgentRoster as unknown[]).filter((x): x is string => typeof x === 'string')
      : null
    const mp = (prefs.chatHubModelPrefs ?? {}) as Record<string, unknown>
    return {
      customModels: sanitizeCustomModels(prefs.chatHubCustomModels),
      agentRoster: roster && roster.length > 0 ? roster : null,
      modelPrefs: {
        video: typeof mp.video === 'string' && getCreateModel(mp.video) ? mp.video : undefined,
        image: typeof mp.image === 'string' && getCreateModel(mp.image) ? mp.image : undefined,
        notes: typeof mp.notes === 'string' ? mp.notes.slice(0, 600) : undefined,
      },
    }
  } catch {
    return { customModels: [], agentRoster: null, modelPrefs: {} }
  }
}

// Available ticket balance for instructions (null = admin/unlimited)
export async function loadTicketBalance(userId: number, email: string): Promise<number | null> {
  if (isAdminEmail(email)) return null
  try {
    const t = await prisma.ticket.findUnique({ where: { userId }, select: { balance: true, reserved: true } })
    return Math.max(0, (t?.balance ?? 0) - Math.max(0, t?.reserved ?? 0))
  } catch { return null }
}

function gatewayUsable(userKeys: Record<string, string>): boolean {
  return !!(userKeys['gateway'] || process.env.AI_GATEWAY_API_KEY)
}
function directUsable(provider: ChatHubProvider, userKeys: Record<string, string>): boolean {
  return !!(userKeys[provider] || process.env[DIRECT_KEY_ENV[provider]])
}

// Resolve any chat model (builtin or custom) to a LanguageModel, honoring the
// user's per-provider routing map with fallback to whichever route has a key.
// Customs are gateway-only.
export function resolveChatModel(
  spec: ChatHubModel,
  routes: RoutingMap,
  userKeys: Record<string, string>,
): LanguageModel | { error: string } {
  // Local Ollama models: OpenAI-compatible endpoint on the dev machine —
  // no key, no gateway. .chat() forces /v1/chat/completions (Ollama has no
  // /v1/responses endpoint).
  if (spec.ollama) {
    const base = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    return createOpenAI({ baseURL: `${base}/v1`, apiKey: 'ollama' }).chat(spec.directId)
  }
  // RunPod models: the user's own rented-GPU endpoint (vLLM, OpenAI-compatible).
  // Config is stored encrypted as JSON {baseUrl, apiKey} under provider 'runpod'.
  if (spec.runpod) {
    const cfg = parseRunpodConfig(userKeys['runpod'])
    if (!cfg) {
      return { error: 'No RunPod endpoint linked — connect one in Profile → Chat Settings → Providers' }
    }
    return createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey || 'runpod' }).chat(spec.directId)
  }
  // OpenRouter models: the user's OpenRouter key against their OpenAI-compatible
  // aggregator endpoint. The optional attribution headers are OpenRouter's
  // recommended convention (rankings + dashboard labeling).
  if (spec.openrouter) {
    const key = userKeys['openrouter']
    if (!key) {
      return { error: 'No OpenRouter API key — add one in Profile → Chat Settings → Providers' }
    }
    return createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: key,
      headers: { 'HTTP-Referer': 'https://prompt-protocol.vercel.app', 'X-Title': 'AI Design Studio' },
    }).chat(spec.directId)
  }
  const gatewayModel = (): LanguageModel | { error: string } => {
    const userKey = userKeys['gateway']
    if (userKey) return createGateway({ apiKey: userKey })(spec.id)
    if (process.env.AI_GATEWAY_API_KEY) return spec.id
    return { error: 'No Vercel AI Hub key — add one in Profile → Chat Settings (or set AI_GATEWAY_API_KEY)' }
  }
  const directModel = (): LanguageModel | { error: string } => {
    const apiKey = userKeys[spec.provider] ?? process.env[DIRECT_KEY_ENV[spec.provider]]
    if (!apiKey) return { error: `No ${spec.provider} API key — add one in Profile → Chat Settings (or set ${DIRECT_KEY_ENV[spec.provider]})` }
    switch (spec.provider) {
      case 'Anthropic': return createAnthropic({ apiKey })(spec.directId)
      case 'OpenAI':    return createOpenAI({ apiKey })(spec.directId)
      case 'Google':    return createGoogleGenerativeAI({ apiKey })(spec.directId)
      case 'xAI':       return createXai({ apiKey })(spec.directId)
    }
  }

  if (spec.custom) return gatewayModel()
  const route = routes[spec.provider] ?? 'gateway'
  if (route === 'direct') {
    if (directUsable(spec.provider, userKeys)) return directModel()
    if (gatewayUsable(userKeys)) return gatewayModel() // fallback
    return directModel() // produce the direct error message
  }
  if (gatewayUsable(userKeys)) return gatewayModel()
  if (directUsable(spec.provider, userKeys)) return directModel() // fallback
  return gatewayModel() // produce the gateway error message
}

// ── Roster ──────────────────────────────────────────────────────────────────

export type RosterEntry = ChatHubModel

export function buildRoster(opts: {
  userKeys: Record<string, string>
  routes: RoutingMap
  customModels: CustomChatModel[]
  agentRoster: string[] | null   // manual allowlist (null = auto)
  excludeId: string              // the orchestrating model itself
}): RosterEntry[] {
  const candidates: ChatHubModel[] = [
    ...CHAT_HUB_MODELS,
    ...opts.customModels
      .filter(c => !CHAT_HUB_MODELS.some(m => m.id === c.id))
      .map(c => getChatModelForUser(c.id, [c])!),
  ]
  return candidates.filter(m => {
    if (m.id === opts.excludeId) return false
    if (opts.agentRoster && !opts.agentRoster.includes(m.id)) return false
    if (m.custom) return gatewayUsable(opts.userKeys)
    const route = opts.routes[m.provider] ?? 'gateway'
    return route === 'direct'
      ? directUsable(m.provider, opts.userKeys) || gatewayUsable(opts.userKeys)
      : gatewayUsable(opts.userKeys) || directUsable(m.provider, opts.userKeys)
  })
}

export function rosterInstructions(roster: RosterEntry[]): string {
  if (roster.length === 0) return ''
  const lines = roster.map(m => `- ${m.id} (${m.label})${m.strengths ? `: ${m.strengths}` : ''}`)
  return [
    'You can delegate subtasks to other AI models with the delegate_task tool. Available models:',
    ...lines,
    'Delegate when another model is better suited for a subtask, for second opinions, or to parallelize research/drafting.',
    'JUDGMENT DELEGATION — standing policy: you are the cost-efficient conductor; route HIGH-STAKES JUDGMENT to a top-tier model when one is in your roster (best judges: anthropic/claude-fable-5, anthropic/claude-opus-4.8, openai/gpt-5.5-pro). Use them for: critiquing generated frames/images before committing more tickets (attach via image_urls), reviewing a plan before a big spend, and polishing final copy. Use cheap fast models (claude-haiku-4.5, gemini-3.5-flash, gpt-5.4-mini) for parallel research and rough drafts. A few cents of judgment is cheaper than a failed 75-ticket generation.',
    'ALWAYS announce in your reply text which model(s) you are delegating to and why, BEFORE calling the tool.',
    'Delegated models see ONLY what you pass in task/context — include everything they need. You can also attach conversation images via image_urls (e.g. have a vision model critique a generated frame before you animate it).',
  ].join('\n')
}

// ── Skills (Employees system) ───────────────────────────────────────────────
// A chat's enabled skill ids decide which instruction modules + tools load.
// null = all skills (legacy chats / Full Studio). SkillSet/skillOn live in the
// client-safe registry now (chat-hub-skills) — re-exported here for compat.
export { skillOn, type SkillSet } from '@/lib/chat-hub-skills'

// Run discipline that applies to EVERY agent run regardless of skills:
// progress narration + the summary contract (write_summary is a core tool).
export function coreDisciplineInstructions(): string {
  return [
    'CLARIFY BEFORE CRAFT: when a creative brief leaves real choices open (style/mood, palette, layout direction, exact text copy, which subject variant to feature), ask 1-4 focused multiple-choice questions with the ask_user TOOL (renders as a tappable quiz) BEFORE planning or building. One good quiz beats three revision cycles. Questions written as plain reply text do NOT pause anything — if you must ask in prose (open-ended), END the reply with the question and WAIT for the user\'s next message; never ask and then keep working as if answered, and never call write_summary on a reply that ends in a question.',
    'INTERMEDIATE UPDATES: between plan steps, write exactly ONE short sentence as normal text — what just happened and what you are doing next (e.g. "Start frame approved — sharp focus, good colors. Generating the end frame now."), then CALL the next tool. These progress notes guide the user through the run — keep writing them.',
    'THE SUMMARY IS A TOOL CALL — HARD RULE: when (and ONLY when) every step is fully complete, finish the run by calling write_summary — it renders as the dedicated Summary card at the bottom of the reply. Never write the wrap-up as normal text, and never call write_summary while any step remains (generations unfinished, evaluations pending). If steps remain, your text MUST end with the next tool call — the system detects premature endings and pushes you to continue.',
    'write_summary is the LAST call of a reply — NEVER call propose_plan after it (the system rejects it). If the budget runs out mid-plan, propose the update BEFORE summarizing; summarize only once everything is settled.',
  ].join('\n')
}

// The studio's image/video models the orchestrator can use via create_media.
// Always requires user approval (costs tickets), so tell the model to present
// a recommendation and cost first. `balance` = the user's available tickets
// (null = unlimited/admin). `skills` gates which knowledge modules render.
export function mediaInstructions(balance?: number | null, modelPrefs?: ModelPrefs, skills: SkillSet = null): string {
  const imageOn = skillOn(skills, 'image-generation')
  const videoOn = skillOn(skills, 'video-production')
  if (!imageOn && !videoOn) return ''
  // Hub is admin-only today — the true flag is explicit so the gate is
  // findable when the hub ever opens to non-admins
  const usable = usableCreateModels(true).filter(m => !m.disabled
    && ((m.kind === 'image' && imageOn) || (m.kind === 'video' && videoOn)))
  const lines = usable.map(m => {
    // Annotate options whose choice CHANGES the ticket cost — plans must be
    // budgeted at the intended settings, not the default price (a 4k
    // nano-banana-2 step is 12 tickets, not the 7-ticket default)
    const defaults = resolveCreateSettings(m, {})
    const baseCost = computeCreateCost(m, defaults)
    const opts = (m.fields ?? [])
      .map(f => {
        const parts = f.options.map(o => {
          const c = computeCreateCost(m, { ...defaults, [f.key]: o })
          return c !== baseCost ? `${o} (${c}t)` : o
        })
        return `${f.key}: ${parts.join('|')}`
      })
      .join('; ')
    return `- ${m.id} (${m.label}, ${m.kind}${m.needsRef ? ', needs a reference image' : ''}, ~${baseCost} tickets at defaults${opts ? ` | options → ${opts}` : ''})${m.strengths ? ` — ${m.strengths}` : ''}`
  })
  const prefLines: string[] = []
  if (modelPrefs?.video && videoOn) prefLines.push(`preferred VIDEO model: ${modelPrefs.video}`)
  if (modelPrefs?.image && imageOn) prefLines.push(`preferred IMAGE model: ${modelPrefs.image}`)
  if (modelPrefs?.notes?.trim()) prefLines.push(`additional preferences: ${modelPrefs.notes.trim()}`)
  const out: string[] = [
    'You can also generate images and videos with the studio\'s media models using the create_media tool. Available:',
    ...lines,
    'OPTION PRICING: "(Nt)" after an option = TOTAL tickets when that option is selected (other settings at defaults). BUDGET EVERY PLAN AT THE SETTINGS YOU INTEND TO USE — a step planned at 4k must be budgeted at the 4k price, a 10s video at the 10s price. Never budget the default cost and upgrade later; that forces a mid-run plan update.',
    prefLines.length
      ? `USER MODEL PREFERENCES — default to these choices in your plans unless the task clearly demands otherwise (say why when you deviate): ${prefLines.join('; ')}. The user can still override models when approving the plan.`
      : '',
    typeof balance === 'number'
      ? `USER TICKET BALANCE: ${balance} tickets available right now. NEVER propose a plan that costs more than this balance — scale models/settings down to fit, and tell the user when the balance is the constraint. If they need more, they can top up in the Shop.`
      : 'USER TICKET BALANCE: unlimited (admin account) — still be cost-conscious and say what things would cost.',
    'BUDGET: for multi-asset or project-scale requests, include a budget question in your ask_user quiz (e.g. "How many tickets should this project spend? ~15 / ~40 / ~90 / no limit") and design the plan to fit both their answer and their balance. State a total cost estimate before generating.',
    'Media generation costs the user tickets and ALWAYS requires their approval — your create_media calls pause until they approve.',
    'PLANNING IS MANDATORY — whenever the user wants media created (any phrasing: create, generate, make, render, draw), your FIRST tool action in the reply must be one of:',
    '(A) ask_user — a short quiz when essential info is missing (image vs video, style, subject; include a budget question for multi-asset projects). Never quiz about things already stated or easily inferred.',
    '(B) propose_plan — a 1-2 sentence summary, numbered steps (each naming the model and its estimated tickets), and ticket_budget = the summed TOTAL. This is the user\'s single approval for the whole plan. You may first delegate plan drafting to a stronger model via delegate_task.',
    'Quiz answers flow into the plan: quiz first when needed, then propose_plan. Even a single obvious asset gets a one-step plan. NEVER call create_media before a plan has been approved in this reply — and NEVER describe or announce generations without the matching tool call (the system detects that and forces a redo). Keep reply text brief (~120 words); full generation prompts belong INSIDE tool calls, not in your text.',
    'AFTER PLAN APPROVAL: work inside the approved ticket budget runs AUTOMATICALLY — generations, edits, and delegations no longer pause for approval. Execute the plan step by step, still obeying SEQUENCING and MANDATORY EVALUATION, announcing each step in one short sentence.',
    'PLAN CHANGES: if a generation fails, an evaluation is bad, or anything needs tickets beyond the approved budget, call propose_plan again with is_update=true — a summary of what changed and why, plus ONLY the ADDITIONAL tickets in ticket_budget. The user approves or denies the change; the remaining original budget stays valid either way.',
    'CRITICAL: media exists ONLY when the create_media tool actually runs and returns. NEVER write image or video URLs, <img>/<video> HTML tags, or markdown images in your reply — real results are displayed to the user automatically. NEVER claim a generation is "initiated", "rendering", or "in progress": if you did not call create_media in this turn, nothing was generated. Announcing a generation in text WITHOUT calling the tool is an error.',
    'CHAINING: create_media accepts reference_image_urls — any image URL already in this conversation (user refs, generated media, edit_image outputs, search_refs results). Iterate freely: re-generate with tweaked settings or a different model, animate a generated image, refine with edit_image, use an edited result as the next reference. Each chained generation still pauses for approval.',
    'USER-ATTACHED REFERENCES ARE NOT OPTIONAL: when the user attaches images to a message, they attached them to be USED. Every generation serving that request must pass those exact URLs (listed in the message) in reference_image_urls, on a model that accepts references — and your prompt must say how to use them (subject likeness, style, composition, product). Only skip an attached reference when the user explicitly says it is no longer needed — and say so when you do.',
    'MANDATORY EVALUATION: EVERY generated or edited image comes back attached so you can see it. The moment a result arrives — and BEFORE any step that depends on it — call record_evaluation({image_url, verdict: pass|revise, notes}); it renders as a dedicated evaluation card. Keep surrounding reply text to a one-line transition. verdict=revise → propose the fix (and a plan update if it costs tickets) instead of building on a bad result.',
    'AI-ARTIFACT CHECKLIST — run it in EVERY evaluation of people/creatures before anything else: COUNT the fingers on each visible hand (five!), check eyes (alignment, matching pupils), teeth, ear/jewelry symmetry, limb count and joint direction, warped or melting geometry, gibberish text. ANY artifact = verdict revise, no exceptions — a beautiful image with six fingers is a FAIL.',
    'SEQUENCING: NEVER batch a tool call that depends on another call\'s output into the same round. Dependent steps go one round at a time: generate → result returns → evaluate → THEN the next call. Example of what NOT to do: requesting the end frame in the same round as (or before evaluating) the start frame. Only batch calls that are fully independent of each other.',
  ]

  if (videoOn) out.push(
    'VIDEO QUALITY RANKING: seedance-2.0 is the FLAGSHIP — first choice for hero/final video content. kling-v3 is the premium alternative (best when you need an exact locked start/end frame). seedance-2.0-fast for near-flagship at lower cost; seedance-1.5 / wan-2.5 for cheap drafts.',
    'PREMIUM VIDEO WORKFLOW — for hero-quality video when budget allows (each step follows the sequencing rule): 1) Generate a key frame / style frame with a top image model at an aspect matching the video. 2) When it returns, evaluate it (mandatory); optionally delegate a second-opinion critique via delegate_task with image_urls. Only proceed once it passes. 3) Generate the video: seedance-2.0 with the approved frame(s) in reference_image_urls and prompt instructions for how to use them, or kling-v3 if the shot needs locked start/end frames. For quick or budget videos, skip the frame step and do a single text/image-to-video call.',
  )

  out.push('Craft playbooks (per-model prompt guides, design rules, edit execution, sketch systems, ad/film/style/social craft) live in your SKILL LIBRARY — load the relevant one with load_skill BEFORE that kind of work.')

  return out.filter(Boolean).join('\n')
}

// ── SKILL LIBRARY: always-on summaries + on-demand playbooks ────────────────
// Each enabled skill contributes its 1-2 line summary every step; the full
// craft playbook (lib/chat-hub-playbooks) loads mid-run via load_skill only
// when the agent actually needs it. Rendered in BOTH plan and execute modes —
// summaries are how plan mode knows the agent's craft breadth.
export function skillSummariesInstructions(skills: SkillSet, planMode = false): string {
  const enabled = AGENT_SKILLS.filter(s => skillOn(skills, s.id))
  if (!enabled.length) return ''
  const loadable = enabled.filter(s => s.playbookTokens > 0)
  const alwaysOnly = enabled.filter(s => s.playbookTokens === 0)
  const out: string[] = [
    'SKILL LIBRARY — your enabled skills. Summaries are always in context; full playbooks load via the load_skill tool ONLY when needed.',
  ]
  if (loadable.length) {
    out.push(
      'LOADING DOCTRINE: playbooks are your craft — an under-loaded run produces amateur work. At the START of any creative task, BEFORE proposing the plan, load EVERY playbook the work will touch (batch the load_skill calls), then write the plan FROM them. Minimum sets: character composites & posters → photoshop + character-fusion + figure-anatomy + graphic-design + typography-poster (+ dataset-ops when studio assets are involved); generation-led work → prompting-guides + the relevant craft/style playbooks; layout/text edits → photoshop + typography-poster + graphic-design. The re-send cost of loaded playbooks is ACCEPTED for creative work — but never re-load one already returned this reply, and skip loading entirely for trivial one-op edits.',
      ...loadable.map(s => `- ${s.id}: ${s.summary} (playbook ~${(s.playbookTokens / 1000).toFixed(1)}k tok)`),
    )
  }
  if (alwaysOnly.length) {
    out.push(`Always-on skills (no playbook to load): ${alwaysOnly.map(s => `${s.id} — ${s.summary}`).join(' | ')}`)
  }
  if (planMode && loadable.length) {
    out.push('load_skill is unavailable in Plan mode — plan from the summaries.')
  }
  return out.join('\n')
}

// Capability rundown for the non-media tools — gated by the chat's skills
export function toolsInstructions(hasProject: boolean, skills: SkillSet = null): string {
  const editOn = skillOn(skills, 'photoshop') || skillOn(skills, 'sketching')
  const out = ['Other tools available to you:']
  if (editOn) out.push(
    '- edit_image: Photoshop-style edits on images from this conversation, OR on a blank canvas via canvas:{width,height,color} (free): crop, resize, rotate, flip, grayscale, blur, region_blur (blur one rectangle — soften backgrounds, censor details), sharpen, adjust (brightness/saturation/hue), tint, rounded (corner radius), vignette, pad (extend canvas — e.g. turn 1:1 into 16:9 with borders), text (overlay EXACT text — 6 font families, any hex color, center alignment, stroke outlines), shape (vector rect/circle/ellipse/line/polygon with fill/stroke/gradient/opacity — scrims behind text, badges, dividers, color blocks, blocking sketches; chain up to 20 ops to compose layouts), overlay (paste another image with opacity + blend modes), remove_background / silhouette (AI subject auto-masking — pixel-perfect person/product cutouts and solid-color silhouettes), segment (SAM2 point/box masking — cut out exactly ONE region such as a face+hair), erase_shape (stencil eraser — knock any rect/ellipse/polygon region transparent with feathered edges, or keep:true to cookie-cut it), choke (matte defringe — kill the halo edge on any cutout before pasting), face_swap (dedicated AI face transplant onto the working image — first choice for identity swaps). Use your vision to pick pixel coordinates. For freehand/painterly changes use a generative edit (create_media with the image as reference) instead. Max 2 edit_image attempts per goal — load the photoshop playbook (load_skill) for the full execution system before precise layout work.',
  )
  if (skillOn(skills, 'reference-library')) out.push(
    '- search_refs: browse the user\'s reference library (filter by folder name); returned URLs become usable in create_media and edit_image.',
  )
  if (skillOn(skills, 'dataset-ops')) out.push(
    '- dataset (ADMIN, read-only): browse the studio dataset/buckets system — list_buckets/list_folders, bucket_images & search_images pull curated images into the conversation for edits/generations. Buckets are curated packs NAMED after people/characters/styles ("Carrie Fisher", "Natalie Portman") — when the user names a person or recurring asset, bucket_images with that name (fuzzy match) is your FIRST move. NEVER ask the user to provide reference images before list_buckets + search_refs have both come up empty — asking while a matching bucket exists is a failure.',
    '- dataset_edit (ADMIN): change the dataset — create_bucket/create_folder/move_bucket, add_to_bucket/remove_from_bucket, mark_training. EVERY call pauses for explicit user approval; describe the exact change in your reply first. Training export runs from the dataset page; prepare buckets, then direct the user there.',
  )
  if (skillOn(skills, 'web-research')) out.push(
    '- web_search: live web answers with sources — use for anything current or factual you are unsure about.',
  )
  if (skillOn(skills, 'project-memory')) out.push(
    hasProject
      ? '- save_memory: replace this project\'s persistent memory (shown in your context). Update it when you learn durable facts, preferences, or decisions.'
      : '- save_memory: unavailable here (this chat is not inside a project — the user can move it into one).',
    '- remember: append ONE short durable fact to the user\'s ACCOUNT-WIDE memory (visible in every chat, user-editable in the Memory panel). Use for cross-project knowledge: brand colors, voice, recurring preferences. One fact per call, ≤500 chars — never run narration.',
  )
  out.push(
    '- edit_instructions: rewrite this chat\'s standing instructions (persona / system prompt) or save a reusable instructions preset for the user. ALWAYS pauses for the user\'s approval — show them the proposed text in your reply before calling it. Chat instruction changes take effect from the next message.',
    '- ask_user: present the user a short multiple-choice quiz (1-4 questions, 2-6 short options each) when the request is ambiguous and the answers materially change what you produce — e.g. before spending tickets on media or committing to a big deliverable. The UI renders clickable options and pauses until they answer. Use sparingly; never ask what you can infer.',
  )
  return out.join('\n')
}

// Who the agent IS — the stable mission statement. Feature-specific blocks
// (media, tools, roster) plug in around this; when the site gains features,
// they arrive as new tools + instruction blocks, not identity rewrites.
export function identityInstructions(): string {
  return [
    'You are the AI Design Studio assistant — the built-in creative agent of this website, an AI image & video generation studio.',
    'PRIMARY MISSION: help the user produce great images and videos with the studio\'s media models — clarify what they want, plan the work, write expert prompts using each model\'s prompting guide, generate, evaluate results honestly, and iterate until it\'s right.',
    'Everything else you can do (delegating to other AI models, the reference library, project memory, web search, image editing, instructions/presets) exists to support that creative work and the user\'s broader use of this site.',
    'The site is actively growing: new features arrive as new tools and capability notes in your context. Rely on your current tool list — never assume a capability exists or is missing based on past conversations.',
    'Be a proactive creative partner: opinionated model choices, concrete visual suggestions, concise progress updates.',
  ].join('\n')
}

export function modeInstructions(mode: AgentMode): string {
  if (mode === 'plan') {
    return [
      'You are in PLAN mode — the deliverable IS a thorough written plan; no tools are available and nothing executes. This is the extra thinking pass: invest it.',
      'PLAN MODE OVERRIDES: every earlier rule about tool calls (quizzes, propose_plan, create_media, evaluations) describes the OTHER modes — here you write the whole plan as text.',
      'Produce: (1) a one-paragraph read of the brief and the creative direction you recommend; (2) numbered steps, each naming the exact model, settings, and estimated tickets, with a one-line WHY; (3) the full draft prompt for every generation step, written to that model\'s prompting style; (4) risks and checkpoints — what you will evaluate after each step and what would trigger a revision; (5) the total ticket estimate.',
      'End by asking the user to switch to Ask or Auto mode to execute it.',
    ].join('\n')
  }
  if (mode === 'accept') {
    return 'Tool calls you make will be shown to the user for approval before they run. Group related tool calls together where sensible.'
  }
  // Auto ('approved')
  return [
    'AUTO MODE — full autonomy. This OVERRIDES the planning rules above: do NOT call propose_plan (no plan cards, no budgets) and do NOT quiz the user with ask_user for preferences, style, budget, or clarification. Make the best professional choice yourself, briefly say what you chose, and execute IMMEDIATELY — your first tool action is the work itself.',
    'The ONLY reasons to pause in Auto mode: a step that is destructive or hard to reverse (mutating dataset buckets — dataset_edit always requires approval; publishing anywhere external), or one you genuinely believe could HARM the user\'s work or waste a large amount of tickets (an unusually expensive single step, or repeating a generation that has already failed twice). Then ask_user ONCE, concisely, and continue on their answer.',
    'Everything else still applies: SEQUENCING (dependent calls one round at a time), MANDATORY EVALUATION of every media result, the AI-artifact checklist, and one-line step announcements.',
  ].join('\n')
}

// ── History builder (shared by send + approve) ─────────────────────────────
// Rows come newest-first from the DB; caller reverses before passing here.

export type HistoryRow = {
  role: string
  content: string
  imageUrls: string[]
  metadata?: unknown
}

const IMAGE_HISTORY_WINDOW = 8

// weakModel: small local/pod models (Ollama, RunPod) FEW-SHOT-IMITATE the
// bracketed history serialization — they see prior turns' `[Agent step: …]` and
// `[Generated media: <url>]` markers and copy that surface format as literal
// text, fabricating plausible URLs instead of emitting real tool calls. For
// those models, past tool activity is narrated as plain prose with no bracket
// syntax and no raw media URL to mimic (recent images still arrive as real
// attachments below, which is where reuse URLs live).
export function buildHistoryMessages(rows: HistoryRow[], opts?: { weakModel?: boolean }): ModelMessage[] {
  const weak = opts?.weakModel ?? false
  return rows.flatMap((m, i): ModelMessage | ModelMessage[] => {
    const recent = i >= rows.length - IMAGE_HISTORY_WINDOW
    if (m.role === 'assistant') {
      const meta = (m.metadata ?? {}) as { agentSteps?: AgentStep[]; pendingApproval?: unknown }
      // A weak model may have HALLUCINATED bracket markers into its own prior
      // reply text — replaying those verbatim re-primes the imitation. Scrub
      // any line that is just a fabricated [Agent step …] / [Generated media …]
      // marker (only these exact shapes, so real prose is untouched).
      const baseContent = weak
        ? m.content.split('\n').filter(l => !/^\s*\[(agent step|generated media)\b.*\]\s*$/i.test(l)).join('\n').trim()
        : m.content
      const realSteps = (meta.agentSteps ?? []).filter(s => s.tool !== 'reasoning') // thinking isn't replayed
      let stepMarkers = ''
      if (weak) {
        const acted = realSteps.filter(s => s.status !== 'superseded' && s.status !== 'denied')
        if (acted.length) {
          const names = [...new Set(acted.map(s => s.tool === 'delegate_task' ? `delegate_task→${s.model}` : s.tool))]
          stepMarkers = `(Earlier this conversation you already ran these tools: ${names.join(', ')}. Those runs are finished. Do NOT write tool names, "[Agent step …]", or media URLs as text — when you need to act, emit a real tool call and the system runs it for you.)`
        }
      } else {
        stepMarkers = realSteps
          .map(s => {
            if (s.status === 'superseded') return `[Agent step set aside — the user replied with new context instead of approving: ${s.tool}${s.model ? ` → ${s.model}` : ''}]`
            if (s.status === 'denied') return `[Agent step DENIED by user: ${s.tool}${s.model ? ` → ${s.model}` : ''}]`
            if (s.tool === 'delegate_task') {
              return `[Agent step: delegate_task → ${s.model} | task: ${(s.task ?? '').slice(0, 150)} | result: ${(s.resultPreview ?? s.error ?? '').slice(0, 300)}]`
            }
            return `[Agent step: ${s.tool}${s.model ? ` → ${s.model}` : ''} | ${(s.task ?? s.prompt ?? '').slice(0, 150)} | ${s.status}${s.error ? `: ${s.error.slice(0, 120)}` : ''}]`
          })
          .join('\n')
      }
      // Weak models copy `[Generated media: <url>]` as literal output — the recent
      // images arrive as real attachments (below) with their reuse URLs, so drop
      // the imitable marker line entirely for them.
      const imageMarker = (weak || !m.imageUrls.length)
        ? ''
        : '\n' + m.imageUrls.map(u => `[Generated media: ${u}]`).join('\n')
      const content = [baseContent, stepMarkers].filter(Boolean).join('\n') + imageMarker
      const out: ModelMessage[] = [{ role: 'assistant' as const, content: content || '(no reply)' }]
      // Recent generated IMAGES are replayed as viewable attachments so the
      // orchestrator can evaluate its own output and chain (regen / edit /
      // image-to-video). Videos can't be viewed — the marker above covers them.
      // COST: each replayed image ≈ 1-1.5k input tokens on EVERY model step —
      // keep the window tight (last 2 assistant rows, 2 images each).
      const recentGen = i >= rows.length - 2
      const genImages = recentGen ? m.imageUrls.filter(u => !/\.(mp4|webm|mov)(\?|$)/i.test(u)).slice(0, 2) : []
      if (recent && genImages.length) {
        out.push({
          role: 'user' as const,
          content: [
            ...genImages.map(u => ({
              type: 'file' as const,
              mediaType: /\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : 'image/jpeg',
              data: u,
            })),
            { type: 'text' as const, text: `[Automatic attachment — the ${genImages.length > 1 ? 'images' : 'image'} above ${genImages.length > 1 ? 'are' : 'is'} the media your tools generated in that reply (in order: ${genImages.join(' , ')}). Evaluate and reuse via reference_image_urls or edit_image if useful.]` },
          ],
        })
      }
      return out
    }
    if (m.imageUrls.length && recent) {
      return {
        role: 'user' as const,
        content: [
          ...m.imageUrls.map(u => ({
            type: 'file' as const,
            mediaType: /\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : 'image/jpeg',
            data: u,
          })),
          // The URLs must be spelled out as text — file parts alone don't
          // tell the model the strings it needs for reference_image_urls
          { type: 'text' as const, text: `${m.content}\n[USER-ATTACHED REFERENCE IMAGES — to use them in a generation, pass these exact URLs in reference_image_urls: ${m.imageUrls.join(' , ')}]` },
        ],
      }
    }
    const note = m.imageUrls.length
      ? `\n[${m.imageUrls.length} reference image(s) were attached — usable in reference_image_urls: ${m.imageUrls.join(' , ')}]`
      : ''
    return { role: 'user' as const, content: m.content + note }
  })
}

// vLLM/Qwen3-VL (RunPod) and some local runtimes CRASH (HTTP 500) on RGBA
// images — anything with an alpha channel, which is exactly what our cutouts
// and transparent composites are. Fetch the image, flatten any transparency
// onto white → 3-channel RGB, cap the resolution (fewer vision tokens), and
// return inline bytes. Weak/self-hosted models can't fetch remote URLs
// reliably anyway, so inlining doubles as the fetch fix. Returns null on any
// failure so the caller can leave the original part untouched.
export async function flattenImageForModel(
  url: string,
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    const input = Buffer.from(await r.arrayBuffer())
    const { default: sharp } = await import('sharp')
    const out = await sharp(input, { failOn: 'none' })
      .flatten({ background: '#ffffff' })                       // RGBA → RGB (composite alpha onto white)
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })                                    // JPEG can't carry alpha → guaranteed RGB
      .toBuffer()
    return { bytes: new Uint8Array(out), mediaType: 'image/jpeg' }
  } catch { return null }
}

// Walk a model-messages array and replace every image FILE part (URL-backed)
// with flattened RGB inline bytes — for self-hosted models (Ollama/RunPod)
// that can't fetch URLs and crash on alpha. Handles both plain content-array
// file parts and file parts nested inside tool-result output values.
export async function inlineWeakModelImages(messages: unknown[], cap = 24): Promise<void> {
  let inlined = 0
  const prepCache = new Map<string, { bytes: Uint8Array; mediaType: string } | null>()
  const urlOf = (data: unknown): string | null => {
    if (data instanceof URL) return data.href
    if (typeof data === 'string' && /^https?:/.test(data)) return data
    if (data && typeof data === 'object') {
      const u = (data as any).url
      if (u instanceof URL) return u.href
      if (typeof u === 'string' && /^https?:/.test(u)) return u
    }
    return null
  }
  const visit = async (node: any): Promise<void> => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) await visit(x); return }
    if (node.type === 'file') {
      const u = urlOf(node.data)
      if (u) {
        let prepared = prepCache.get(u)
        if (prepared === undefined) {
          prepared = inlined < cap ? await flattenImageForModel(u) : null
          prepCache.set(u, prepared)
          if (prepared) inlined++
        }
        if (prepared) {
          node.data = prepared.bytes
          node.mediaType = prepared.mediaType
        } else {
          // NEVER leave a URL-backed image part: Google rejects arbitrary
          // fileData URIs with a phantom "Resource exhausted" 429, and
          // self-hosted models can't fetch. Downgrade to a text note.
          node.type = 'text'
          node.text = `[image omitted: ${u.slice(0, 160)}]`
          delete node.data
          delete node.mediaType
        }
      }
      return
    }
    for (const k of Object.keys(node)) await visit(node[k])
  }
  await visit(messages)
}

// ── Tool executors (shared by approved-mode streaming and the approve route) ─

export async function executeDelegateTask(
  input: { model: string; task: string; context?: string; image_urls?: string[] },
  ctx: { roster: RosterEntry[]; routes: RoutingMap; userKeys: Record<string, string>; allowedImages?: Set<string> },
): Promise<{ model: string; answer: string } | { error: string }> {
  const entry = ctx.roster.find(r => r.id === input.model)
  if (!entry) return { error: `Model ${input.model} is not in the available roster` }
  const sub = resolveChatModel(entry, ctx.routes, ctx.userKeys)
  if (typeof sub === 'object' && sub !== null && 'error' in sub) return { error: sub.error }
  // Vision delegation: pass conversation images (generated frames, refs) so
  // the delegate can critique/analyze them — restricted to known URLs.
  const imgs = Array.isArray(input.image_urls)
    ? input.image_urls
        .filter(u => typeof u === 'string' && u.startsWith('https://')
          && (!ctx.allowedImages || ctx.allowedImages.has(u)))
        .slice(0, 4)
    : []
  const promptText = input.context ? `${input.task}\n\nContext:\n${input.context}` : input.task
  try {
    const { text } = await generateText({
      model: sub as LanguageModel,
      instructions: `You are ${entry.label}, completing a delegated subtask for an orchestrating assistant. Be direct and complete — your answer is consumed by another model, not shown verbatim to the user.`,
      ...(imgs.length
        ? {
            messages: [{
              role: 'user' as const,
              content: [
                ...imgs.map(u => ({
                  type: 'file' as const,
                  mediaType: /\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : 'image/jpeg',
                  data: u,
                })),
                { type: 'text' as const, text: promptText },
              ],
            }],
          }
        : { prompt: promptText }),
      abortSignal: AbortSignal.timeout(120_000),
    })
    return { model: input.model, answer: text.slice(0, 12_000) }
  } catch (err: any) {
    return { error: `Delegation to ${entry.label} failed: ${String(err?.message || err).slice(0, 200)}` }
  }
}

// Orchestrator-driven media generation — same pipeline as the "+" Create menu
// (tickets charged, refs from the current message, settings validated per model)
export async function executeCreateMedia(
  input: { model: string; prompt: string; settings?: Record<string, string>; reference_image_urls?: string[] },
  ctx: { user: { id: number; email: string }; attachedImageUrls: string[]; allowedImages?: Set<string> },
): Promise<{ model: string; mediaUrl: string; kind: string; ticketCost: number; settings: Record<string, string>; referenceImageUrls: string[]; note: string } | { error: string }> {
  const spec = getCreateModel(input.model)
  if (!spec || spec.disabled) return { error: `Media model ${input.model} is not available` }
  if (!spec.geminiApi && !process.env.FAL_KEY) return { error: 'FAL_KEY is not configured' }

  const settings = resolveCreateSettings(spec, input.settings)
  const ticketCost = computeCreateCost(spec, settings)
  // Chaining: the orchestrator may name references itself (generated media,
  // edit_image outputs, search_refs results) — restricted to URLs already in
  // this conversation. Falls back to the user's attached refs.
  const requested = Array.isArray(input.reference_image_urls)
    ? input.reference_image_urls.filter(u =>
        typeof u === 'string' && u.startsWith('https://')
        && (!ctx.allowedImages || ctx.allowedImages.has(u)))
    : []
  const baseRefs = requested.length ? requested : ctx.attachedImageUrls
  const refs = spec.maxRefs > 0 ? baseRefs.slice(0, spec.maxRefs) : []
  if (spec.needsRef && refs.length === 0) {
    return { error: `${spec.label} needs a reference image (image-to-${spec.kind} model) — attach one or pass reference_image_urls with an image from this conversation` }
  }

  const ticketResult = await deductGenerationTickets(ctx.user.id, ctx.user.email, ticketCost)
  if (!ticketResult.ok) {
    return { error: `Insufficient tickets — ${spec.label} costs ${ticketCost}, the user has ${ticketResult.have}. Tell the user to top up tickets.` }
  }
  try {
    let mediaUrl: string | undefined
    if (spec.geminiApi) {
      const r = await generateWithGeminiApi(spec.geminiApi, input.prompt, refs, settings)
      if ('error' in r) {
        await refundGenerationTickets(ctx.user.id, ctx.user.email, ticketCost)
        return { error: r.error }
      }
      mediaUrl = r.url
    } else {
      const call = buildFalCall(spec.id, input.prompt, refs, settings)
      if ('error' in call) {
        await refundGenerationTickets(ctx.user.id, ctx.user.email, ticketCost)
        return { error: call.error }
      }
      // 15 min ceiling: video generations legitimately run long, but a
      // stalled connection must throw (the catch refunds) — not hang the run
      const result = await falWithTimeout(spec.label + ' generation', 900_000, () => fal.subscribe(call.endpoint, { input: call.input as any, logs: false }))
      const data = result.data as any
      mediaUrl = data?.images?.[0]?.url ?? data?.video?.url
    }
    if (!mediaUrl) {
      await refundGenerationTickets(ctx.user.id, ctx.user.email, ticketCost)
      return { error: 'The media model returned nothing' }
    }
    // Sync to the user's main session feed (re-hosts images on R2)
    mediaUrl = await persistChatGeneration({
      userId: ctx.user.id, prompt: input.prompt, mediaUrl,
      modelId: spec.id, kind: spec.kind, settings, ticketCost,
      referenceImageUrls: refs,
    })
    return {
      model: spec.id, mediaUrl, kind: spec.kind, ticketCost, settings,
      referenceImageUrls: refs,
      note: `${spec.kind === 'video' ? 'Video' : 'Image'} generated with ${spec.label} (${ticketCost} tickets). It is shown to the user automatically — do not print the raw URL; describe what was created.${spec.kind === 'image' ? ' MANDATORY: evaluate the attached image in your reply (subject, composition, artifacts, prompt adherence) BEFORE any dependent next step.' : ''}`,
    }
  } catch (err: any) {
    console.error('chat-hub create_media error:', err)
    await refundGenerationTickets(ctx.user.id, ctx.user.email, ticketCost)
    // Surface FAL's real validation details — the orchestrator reads this and
    // re-plans (different settings/refs/model) instead of guessing blind
    const detail = err?.body?.detail
    const detailMsg = Array.isArray(detail)
      ? detail.map((d: any) => (d?.msg ? `${Array.isArray(d?.loc) ? d.loc.join('.') + ': ' : ''}${d.msg}` : JSON.stringify(d))).join('; ')
      : typeof detail === 'string' ? detail : ''
    const msg = detailMsg || String(err?.message || err)
    return { error: `${spec.label} generation FAILED: ${msg.slice(0, 400)}. The user was refunded. Read this error, explain it briefly to the user, and propose an adjusted approach (different settings, references, or model).` }
  }
}

// ── edit_image: programmatic twin of the portal's reference editor ─────────
// Sharp-based ops pipeline; source/overlay must come from images already in
// the conversation (attached refs, generated media, library results).
export type EditImageOp =
  | { op: 'crop'; x: number; y: number; width: number; height: number }
  | { op: 'resize'; width?: number; height?: number }
  | { op: 'rotate'; degrees: number }
  | { op: 'flip'; direction: 'horizontal' | 'vertical' }
  | { op: 'grayscale' }
  | { op: 'blur'; sigma?: number }
  | { op: 'sharpen'; sigma?: number }
  | { op: 'adjust'; brightness?: number; saturation?: number; hue?: number }
  | { op: 'tint'; color: string }
  | { op: 'pad'; top?: number; bottom?: number; left?: number; right?: number; color?: string }
  | { op: 'text'; text: string; x: number; y: number; size?: number; color?: string; font?: 'sans' | 'serif' | 'mono' | 'impact' | 'script' | 'condensed'; weight?: 'normal' | 'bold'; align?: 'left' | 'center'; stroke?: string; stroke_width?: number; opacity?: number; rotate?: number; erase?: EraseStroke[]; draw?: DrawStroke[] }
  | { op: 'shape'; shape: 'rect' | 'circle' | 'ellipse' | 'line' | 'polygon'; x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; r?: number; x2?: number; y2?: number; points?: string; fill?: string; stroke?: string; stroke_width?: number; opacity?: number; corner_radius?: number; rotate?: number; gradient?: { from: string; to: string; direction?: 'down' | 'up' | 'left' | 'right'; from_opacity?: number; to_opacity?: number }; erase?: EraseStroke[]; draw?: DrawStroke[] }
  | { op: 'region_blur'; x: number; y: number; width: number; height: number; sigma?: number }
  | { op: 'patch'; from: { x: number; y: number; width: number; height: number }; to: { x: number; y: number; width: number; height: number } }
  | { op: 'rounded'; radius?: number }
  | { op: 'vignette'; strength?: number }
  | { op: 'starfield'; density?: number; seed?: number; color?: string; region?: { x: number; y: number; width: number; height: number } }
  | { op: 'filter'; name: 'noir' | 'bw' | 'vivid' | 'matte' | 'warm' | 'cool' | 'vintage' | 'golden' | 'dreamy' | 'cinematic'; strength?: number }
  | { op: 'overlay'; image_url: string; x: number; y: number; width?: number; height?: number; rotate?: number; opacity?: number; blend?: 'over' | 'multiply' | 'screen' | 'overlay' | 'soft-light'; crop?: { x: number; y: number; width: number; height: number }; flip?: 'horizontal' | 'vertical'; bleed?: boolean; stretch?: boolean; erase?: EraseStroke[]; draw?: DrawStroke[] }
  | { op: 'remove_background'; trim_regions?: { x: number; y: number; width: number; height: number }[] }
  | { op: 'silhouette'; color?: string; on_original?: boolean; trim_regions?: { x: number; y: number; width: number; height: number }[] }
  | { op: 'erase_shape'; shape: 'rect' | 'ellipse' | 'polygon'; x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; rx?: number; ry?: number; points?: string; feather?: number; keep?: boolean }
  | { op: 'choke'; amount?: number; feather?: number }
  | { op: 'face_swap'; face_image_url: string }
  | { op: 'segment'; points?: SegPoint[]; box?: SegBox; parts?: { name?: string; points?: SegPoint[]; box?: SegBox }[]; invert?: boolean }

// User-drawn eraser strokes (media-viewer layer editor). Coordinates and
// brush size are NORMALIZED (0..1) to the layer's own box — the fitted
// overlay rect, or the full canvas for text/shape — so strokes stay glued
// to the layer through later moves/resizes.
export type EraseStroke = { size: number; opacity?: number; points: string }
// User-drawn BRUSH strokes (media-viewer layer editor) — colored paint added
// ON TOP of the layer. Same normalized 0..1 box coords as EraseStroke, plus a
// hex color.
export type DrawStroke = { size: number; opacity?: number; color?: string; points: string }

const parseHexColor = (c?: string): { r: number; g: number; b: number } | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c ?? '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// Hex color as an SVG-safe string ("#rrggbb"), or null if invalid
const hexStr = (c?: string): string | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c ?? '')
  return m ? `#${m[1]}` : null
}

// Subject cutout via fal BiRefNet v2 (background removal). Takes the CURRENT
// working buffer (mid-chain safe) as a PNG data URI — the same base64-data-URI
// pattern the seedream submit routes use — and returns the dominant subject as
// RGBA on transparency at the SAME dimensions as the input.
// NOTE: if very large (4K) buffers ever 413, downscale the segmentation input
// to ≤2048px and scale the mask back up.
async function birefnetCutout(buf: Buffer): Promise<Buffer> {
  const dataUri = `data:image/png;base64,${buf.toString('base64')}`
  const result: any = await falWithTimeout('Subject masking', 120_000, () => fal.subscribe('fal-ai/birefnet/v2', {
    input: { image_url: dataUri, output_format: 'png' },
  }))
  const url = result?.data?.image?.url ?? result?.image?.url
  if (!url) throw new Error('BiRefNet returned no image')
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Could not fetch the cutout (${res.status})`)
  return despeckleAlpha(Buffer.from(await res.arrayBuffer()))
}

// Mask hygiene: BiRefNet sometimes leaves floating chunks of background
// (a piece of wall, furniture) disconnected from the subject. Label the
// alpha's connected components at reduced scale and keep only the dominant
// blob (+ anything ≥8% of its area, so a second person/held object survives).
async function despeckleAlpha(cutBuf: Buffer): Promise<Buffer> {
  try {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(cutBuf, { failOn: 'none' }).metadata()
    const W = meta.width ?? 0, H = meta.height ?? 0
    if (!W || !H) return cutBuf
    const k = Math.min(1, 600 / Math.max(W, H))
    const sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k))
    const alpha = await sharp(cutBuf, { failOn: 'none' })
      .resize(sw, sh, { fit: 'fill' })
      .ensureAlpha()
      .extractChannel(3)
      .raw()
      .toBuffer()
    // BFS connected-components over alpha > 40
    const labels = new Int32Array(sw * sh).fill(-1)
    const areas: number[] = []
    const qx = new Int32Array(sw * sh), qy = new Int32Array(sw * sh)
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x
      if (labels[i] !== -1 || alpha[i] <= 40) continue
      const label = areas.length
      let head = 0, tail = 0, area = 0
      qx[tail] = x; qy[tail] = y; tail++
      labels[i] = label
      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++
        area++
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue
          const ni = ny * sw + nx
          if (labels[ni] === -1 && alpha[ni] > 40) { labels[ni] = label; qx[tail] = nx; qy[tail] = ny; tail++ }
        }
      }
      areas.push(area)
    }
    if (areas.length <= 1) return cutBuf
    const largest = Math.max(...areas)
    const keep = areas.map(a => a >= largest * 0.08)
    if (keep.every(Boolean)) return cutBuf
    // RGBA keep-mask (white, alpha 255 where kept) → upscale → dest-in
    const maskRaw = Buffer.alloc(sw * sh * 4)
    for (let i = 0; i < sw * sh; i++) {
      const on = labels[i] >= 0 ? (keep[labels[i]] ? 255 : 0) : (alpha[i] > 0 ? 255 : 0)
      maskRaw[i * 4] = 255; maskRaw[i * 4 + 1] = 255; maskRaw[i * 4 + 2] = 255; maskRaw[i * 4 + 3] = on
    }
    const maskPng = await sharp(maskRaw, { raw: { width: sw, height: sh, channels: 4 } })
      .resize(W, H, { fit: 'fill' })
      .blur(0.6)
      .png()
      .toBuffer()
    return await sharp(cutBuf, { failOn: 'none' })
      .composite([{ input: maskPng, blend: 'dest-in' }])
      .png()
      .toBuffer()
  } catch {
    return cutBuf // hygiene is best-effort — never fail the cutout over it
  }
}

// Model-driven mask cleanup: zero the cutout's alpha inside the given rects
// (source-image pixels) — for background patches BiRefNet left ATTACHED to
// the subject, which the connected-component despeckle cannot remove.
async function trimCutRegions(buf: Buffer, regions?: { x: number; y: number; width: number; height: number }[]): Promise<Buffer> {
  if (!Array.isArray(regions) || !regions.length) return buf
  const { default: sharp } = await import('sharp')
  const meta = await sharp(buf, { failOn: 'none' }).metadata()
  const w = meta.width ?? 1024, h = meta.height ?? 1024
  // Guardrail: trim_regions ERASES alpha inside each rect — it exists to remove
  // SMALL background patches BiRefNet left attached. Weaker models misread it as
  // "the region to keep/crop to" and pass a full-image rect, which erases the
  // whole subject (blank transparent result). Any rect covering ≳90% of the
  // canvas can only be that mistake — drop it rather than destroy the cutout.
  const kept = regions.filter(r => {
    const rw = Math.max(1, Number(r?.width) || 0), rh = Math.max(1, Number(r?.height) || 0)
    return (rw * rh) < (w * h) * 0.9
  })
  if (!kept.length) return buf // every region was a full-canvas erase — ignore them all
  const rects = kept.slice(0, 12).map(r => {
    const x = Math.max(0, Math.round(Number(r?.x) || 0)), y = Math.max(0, Math.round(Number(r?.y) || 0))
    const rw = Math.max(1, Math.round(Number(r?.width) || 1)), rh = Math.max(1, Math.round(Number(r?.height) || 1))
    return `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="#000"/>`
  }).join('')
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`)
  return sharp(buf, { failOn: 'none' }).composite([{ input: svg, blend: 'dest-out' }]).png().toBuffer()
}

// Stencil mask for erase_shape: the shape rendered solid white on a
// transparent canvas, optionally feathered (gaussian blur) for soft edges.
async function stencilMask(
  w: number, h: number,
  op: { shape: 'rect' | 'ellipse' | 'polygon'; x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; rx?: number; ry?: number; points?: string; feather?: number },
): Promise<Buffer | null> {
  const { default: sharp } = await import('sharp')
  let el: string | null = null
  if (op.shape === 'rect' && op.width && op.height) {
    el = `<rect x="${Math.round(op.x ?? 0)}" y="${Math.round(op.y ?? 0)}" width="${Math.round(op.width)}" height="${Math.round(op.height)}" fill="#fff"/>`
  } else if (op.shape === 'ellipse' && op.rx && op.ry) {
    el = `<ellipse cx="${Math.round(op.cx ?? w / 2)}" cy="${Math.round(op.cy ?? h / 2)}" rx="${Math.round(op.rx)}" ry="${Math.round(op.ry)}" fill="#fff"/>`
  } else if (op.shape === 'polygon' && typeof op.points === 'string' && op.points.trim()) {
    const pts = op.points.trim().split(/\s+/).filter(pair => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(pair))
    if (pts.length >= 3) el = `<polygon points="${pts.slice(0, 64).join(' ')}" fill="#fff"/>`
  }
  if (!el) return null
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${el}</svg>`)
  let mask = await sharp(svg).png().toBuffer()
  const feather = Math.min(100, Math.max(0, Number(op.feather) || 0))
  if (feather > 0.3) mask = await sharp(mask).blur(feather).png().toBuffer()
  return mask
}

// Time-box a fal call: a stalled connection must fail the edit cleanly in
// seconds, not hang it for minutes (fal.subscribe has no client timeout)
async function falWithTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let th: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, rej) => { th = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — network or provider stall; retry the operation`)), ms) }),
    ])
  } finally {
    clearTimeout(th)
  }
}

// Promptable segmentation via fal SAM2: point/box prompts select EXACTLY one
// region (a face+hair, one arm, a single object) — unlike BiRefNet's whole-
// subject cut. Returns the selected region as RGBA on transparency at the
// input's dimensions.
type SegPoint = { x: number; y: number; label?: 0 | 1 }
type SegBox = { x_min: number; y_min: number; x_max: number; y_max: number }

async function sam2Cutout(
  buf: Buffer,
  points?: SegPoint[],
  box?: SegBox,
  parts?: { name?: string; points?: SegPoint[]; box?: SegBox }[],
  invert?: boolean,
): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const meta = await sharp(buf, { failOn: 'none' }).metadata()
  const w = meta.width ?? 1024, h = meta.height ?? 1024
  // SAM2 only needs the image to DECIDE the mask — send a ≤1280px JPEG
  // (a 3300×4100 PNG data URI was ~20MB per call and dominated run time)
  // and scale the prompts to match; the returned mask is upscaled back to
  // the full-res base below, so cutout quality is unchanged.
  const sc = Math.min(1, 1280 / Math.max(w, h))
  const sw = Math.max(1, Math.round(w * sc)), sh = Math.max(1, Math.round(h * sc))
  const small = await sharp(buf, { failOn: 'none' }).resize(sw, sh, { fit: 'fill' }).flatten({ background: '#000' }).jpeg({ quality: 90 }).toBuffer()
  const dataUri = `data:image/jpeg;base64,${small.toString('base64')}`

  // One SAM2 call = ONE object. A face+hair (or hat+hair, sleeve+arm) cutout
  // therefore runs as several PARTS, each its own call, unioned below —
  // mixing both point families in one call makes SAM pick just one of them.
  const maskFor = async (pts?: SegPoint[], bx?: SegBox): Promise<Buffer | null> => {
    // 14: a full-head part legitimately needs ~4 positives + 3 collar
    // negatives — the old cap of 8 silently dropped the negatives
    const prompts = (Array.isArray(pts) ? pts : []).slice(0, 14)
      .filter(pt => Number.isFinite(Number(pt?.x)) && Number.isFinite(Number(pt?.y)))
      // fal's TS types claim label is a '0'|'1' STRING but the server 422s
      // anything except INTEGER 0/1 (verified live) — cast around the bad type
      .map(pt => ({ x: Math.round(Number(pt.x) * sc), y: Math.round(Number(pt.y) * sc), label: (pt.label === 0 ? 0 : 1) as unknown as '0' | '1', frame_index: 0 }))
    const boxPrompts = bx && Number.isFinite(Number(bx.x_min))
      ? [{ x_min: Math.round(Number(bx.x_min) * sc), y_min: Math.round(Number(bx.y_min) * sc), x_max: Math.round(Number(bx.x_max) * sc), y_max: Math.round(Number(bx.y_max) * sc), frame_index: 0 }]
      : []
    if (!prompts.length && !boxPrompts.length) return null
    const result: any = await falWithTimeout('SAM2 segmentation', 120_000, () => fal.subscribe('fal-ai/sam2/image', {
      input: { image_url: dataUri, prompts, box_prompts: boxPrompts, output_format: 'png' },
    }))
    const url = result?.data?.image?.url ?? result?.image?.url
    if (!url) throw new Error('SAM2 returned no mask')
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`Could not fetch the mask (${res.status})`)
    const maskBuf = Buffer.from(await res.arrayBuffer())
    // The endpoint returns the MASK (white = selected). Normalize to the
    // base's size as single-channel luminance (stride-compacted — sharp may
    // hand back 3 channels for a grey image).
    const r = await sharp(maskBuf, { failOn: 'none' }).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true })
    if (r.info.channels === 1) return r.data
    const out = Buffer.alloc(w * h)
    for (let i = 0; i < out.length; i++) out[i] = r.data[i * r.info.channels]
    return out
  }

  const jobs: { name: string; pts?: SegPoint[]; bx?: SegBox }[] = []
  for (const part of (Array.isArray(parts) ? parts : []).slice(0, 6)) {
    jobs.push({ name: String(part?.name ?? `part ${jobs.length + 1}`), pts: part?.points, bx: part?.box })
  }
  if ((Array.isArray(points) && points.length) || box) jobs.push({ name: 'main', pts: points, bx: box })
  if (!jobs.length) throw new Error('segment needs points, a box, or parts[]')
  const results = await Promise.all(jobs.map(async j => ({ name: j.name, mask: await maskFor(j.pts, j.bx) })))
  const emptyNames = results.filter(r => !r.mask).map(r => r.name)
  const masks = results.filter((r): r is { name: string; mask: Buffer } => !!r.mask).map(r => r.mask)
  if (!masks.length) {
    throw new Error(`segment: no part had usable coordinates (${emptyNames.join(', ')}). A part's NAME is only a label — SAM cannot find "face" or "hair" by name. EVERY part needs its own points array with REAL pixel coordinates read from the image (e.g. {name:"face",points:[{x:512,y:300,label:1},{x:470,y:360,label:1},{x:512,y:520,label:0}]}) or a box`)
  }
  // Union: a pixel belongs to the cutout if ANY part selected it
  let lum = Buffer.alloc(w * h)
  for (const m of masks) for (let i = 0; i < lum.length; i++) if (m[i] > lum[i]) lum[i] = m[i]
  if (masks.length >= 2) {
    // Morphological CLOSE (dilate → erode): adjacent part masks meet with a
    // hairline gap neither covers — without this the union renders a thin
    // erased seam line between face and hair. Gaps up to ~8px fuse; the
    // outer boundary comes back to within a pixel of where it was.
    const compact = (r: { data: Buffer; info: { channels: number } }) => {
      if (r.info.channels === 1) return r.data
      const o = Buffer.alloc(w * h)
      for (let i = 0; i < o.length; i++) o[i] = r.data[i * r.info.channels]
      return o
    }
    const d1 = compact(await sharp(lum, { raw: { width: w, height: h, channels: 1 } }).blur(3).raw().toBuffer({ resolveWithObject: true }))
    const dil = Buffer.alloc(w * h)
    for (let i = 0; i < dil.length; i++) { const v = (d1[i] - 40) * 8; dil[i] = v < 0 ? 0 : v > 255 ? 255 : v }
    const d2 = compact(await sharp(dil, { raw: { width: w, height: h, channels: 1 } }).blur(3).raw().toBuffer({ resolveWithObject: true }))
    const ero = Buffer.alloc(w * h)
    for (let i = 0; i < ero.length; i++) { const v = (d2[i] - 200) * 8; ero[i] = v < 0 ? 0 : v > 255 ? 255 : v }
    lum = ero
  }
  if (invert) {
    // HOLE mode (backward swap): ERASE the selected region instead of keeping
    // it. The hole is grown ~6px and feathered so no ring of head pixels
    // survives at the boundary — hand-drawn contours kept missing at scale,
    // SAM + dilation is machine-precise.
    const compactI = (r: { data: Buffer; info: { channels: number } }) => {
      if (r.info.channels === 1) return r.data
      const o = Buffer.alloc(w * h)
      for (let i = 0; i < o.length; i++) o[i] = r.data[i * r.info.channels]
      return o
    }
    const g1 = compactI(await sharp(lum, { raw: { width: w, height: h, channels: 1 } }).blur(4).raw().toBuffer({ resolveWithObject: true }))
    let grown: Buffer = Buffer.alloc(w * h)
    for (let i = 0; i < grown.length; i++) { const v = (g1[i] - 30) * 8; grown[i] = v < 0 ? 0 : v > 255 ? 255 : v }
    grown = compactI(await sharp(grown, { raw: { width: w, height: h, channels: 1 } }).blur(3).raw().toBuffer({ resolveWithObject: true }))
    const rgbaH = Buffer.alloc(w * h * 4, 255)
    for (let i = 0; i < w * h; i++) rgbaH[i * 4 + 3] = grown[i]
    const holeMask = await sharp(rgbaH, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
    return sharp(buf, { failOn: 'none' }).ensureAlpha().composite([{ input: holeMask, blend: 'dest-out' }]).png().toBuffer()
  }
  const rgba = Buffer.alloc(w * h * 4, 255)
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = lum[i]
  const alphaMask = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  return sharp(buf, { failOn: 'none' }).ensureAlpha().composite([{ input: alphaMask, blend: 'dest-in' }]).png().toBuffer()
}

// Knock user-drawn eraser strokes out of a PNG via dest-out compositing.
// Strokes use normalized 0..1 coords/size relative to (w, h) — the same
// convention the client-side live preview draws with, so Save matches it.
async function applyEraseStrokes(buf: Buffer, w: number, h: number, strokes: EraseStroke[]): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const lines = strokes.slice(0, 60).map(s => {
    const pts = String(s.points ?? '').slice(0, 8000).trim().split(/\s+/)
      .map(p => p.split(',').map(Number))
      .filter(a => a.length === 2 && a.every(Number.isFinite))
      .map(([u, v]) => `${(u * w).toFixed(1)},${(v * h).toFixed(1)}`)
    if (!pts.length) return ''
    if (pts.length === 1) pts.push(pts[0])
    const sw = Math.max(1, Math.round((Number(s.size) || 0.05) * w))
    const so = Math.min(1, Math.max(0.05, typeof s.opacity === 'number' ? s.opacity : 1))
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="#000" stroke-opacity="${so}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
  }).filter(Boolean).join('')
  if (!lines) return buf
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`)
  return sharp(buf, { failOn: 'none' }).composite([{ input: svg, blend: 'dest-out' }]).png().toBuffer()
}

// Brush strokes: colored paint composited OVER the layer (source-over). Same
// normalized-coords convention as applyEraseStrokes so the client live preview
// matches the bake exactly.
async function applyDrawStrokes(buf: Buffer, w: number, h: number, strokes: DrawStroke[]): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const lines = strokes.slice(0, 120).map(s => {
    const pts = String(s.points ?? '').slice(0, 8000).trim().split(/\s+/)
      .map(p => p.split(',').map(Number))
      .filter(a => a.length === 2 && a.every(Number.isFinite))
      .map(([u, v]) => `${(u * w).toFixed(1)},${(v * h).toFixed(1)}`)
    if (!pts.length) return ''
    if (pts.length === 1) pts.push(pts[0])
    const sw = Math.max(1, Math.round((Number(s.size) || 0.05) * w))
    const so = Math.min(1, Math.max(0.05, typeof s.opacity === 'number' ? s.opacity : 1))
    const col = hexStr(s.color) ?? '#ffffff'
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-opacity="${so}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
  }).filter(Boolean).join('')
  if (!lines) return buf
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`)
  return sharp(buf, { failOn: 'none' }).composite([{ input: svg, blend: 'over' }]).png().toBuffer()
}

// Deterministic procedural starfield (mulberry32 PRNG). The client live
// preview runs the IDENTICAL algorithm (chat-hub.tsx computeStarfieldClient)
// — keep the two byte-for-byte in sync or previews drift from bakes.
type StarPrim =
  | { t: 'c'; x: number; y: number; r: number; o: number }
  | { t: 'l'; x1: number; y1: number; x2: number; y2: number; w: number; o: number }
function computeStarfield(
  op: { density?: number; seed?: number; region?: { x: number; y: number; width: number; height: number } },
  w: number, h: number,
): StarPrim[] {
  const nn = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const rx = Math.max(0, Math.round(nn(op.region?.x, 0)))
  const ry = Math.max(0, Math.round(nn(op.region?.y, 0)))
  const rw = Math.max(1, Math.min(w - rx, Math.round(nn(op.region?.width, w))))
  const rh = Math.max(1, Math.min(h - ry, Math.round(nn(op.region?.height, h))))
  const density = Math.min(3, Math.max(0.2, nn(op.density, 1)))
  let a = (Math.round(nn(op.seed, 42)) >>> 0) || 42
  const rand = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const sc = Math.max(1, Math.min(w, h) / 1200)
  const count = Math.min(600, Math.round((rw * rh) / 6000 * density))
  const R = (v: number) => Math.round(v * 10) / 10
  const R2 = (v: number) => Math.round(v * 100) / 100
  const out: StarPrim[] = []
  for (let i = 0; i < count; i++) {
    const x = R(rx + rand() * rw), y = R(ry + rand() * rh)
    const k = rand()
    const r = R((k < 0.9 ? 0.5 + rand() * 1.1 : k < 0.98 ? 1.7 + rand() * 1.3 : 2.8 + rand() * 1.7) * sc)
    const o = R2(0.25 + rand() * 0.75)
    out.push({ t: 'c', x, y, r, o })
    if (k >= 0.98) {
      // Hero stars get a soft halo + 4-point flare
      out.push({ t: 'c', x, y, r: R(r * 3), o: 0.1 })
      const f = R(r * 5)
      const fw = R(Math.max(0.8, r * 0.25))
      out.push({ t: 'l', x1: R(x - f), y1: y, x2: R(x + f), y2: y, w: fw, o: R2(o * 0.5) })
      out.push({ t: 'l', x1: x, y1: R(y - f), x2: x, y2: R(y + f), w: fw, o: R2(o * 0.5) })
    }
  }
  return out
}

const FONT_FAMILIES: Record<string, string> = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", monospace',
  impact: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
  script: '"Segoe Script", "Brush Script MT", cursive',
  condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
}

export async function executeEditImage(
  input: {
    image_url?: string
    canvas?: { width: number; height: number; color?: string }
    operations: EditImageOp[]
  },
  ctx: { user: { id: number; email: string }; allowedImages: Set<string> },
): Promise<{ imageUrl: string; width: number | null; height: number | null; note: string } | { error: string }> {
  // URL slip recovery: small/local models mangle long R2 URLs when copying
  // them into tool calls. Exact match first; else a UNIQUE filename match
  // against the allow-list rescues the call instead of failing it.
  const resolveAllowedUrl = (u: unknown): string | null => {
    if (typeof u !== 'string' || !u) return null
    if (ctx.allowedImages.has(u)) return u
    const tail = u.split('?')[0].split('/').pop()?.toLowerCase()
    if (!tail || tail.length < 8) return null
    const hits = [...ctx.allowedImages].filter(a => a.split('?')[0].split('/').pop()?.toLowerCase() === tail)
    return hits.length === 1 ? hits[0] : null
  }
  {
    const fixedSrc = resolveAllowedUrl(input.image_url)
    if (fixedSrc) input.image_url = fixedSrc
  }
  const hasCanvas = !!input.canvas && !input.image_url
  if (!hasCanvas && (!input.image_url || !ctx.allowedImages.has(input.image_url))) {
    if (ctx.allowedImages.size === 0) {
      return { error: 'There are NO images in this conversation yet — nothing to edit. Get a source first: pull one from the dataset buckets or search_refs, ask the user to attach an image, or pass canvas:{width,height,color} to draw on a blank canvas. NEVER invent an image URL.' }
    }
    return { error: 'image_url must be one of the images already in this conversation (attached, generated, or from search_refs) — copy the URL EXACTLY from the tool result, never type one from memory. Or pass canvas:{width,height,color} instead to draw on a blank canvas' }
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 20) {
    return { error: 'Provide 1-20 operations' }
  }
  // Tracked so the catch below can tell the model WHICH op broke — without
  // this it retries the same bad chain in a loop.
  let opNo = 0
  let opName = ''
  try {
    const { default: sharp } = await import('sharp')
    let img: import('sharp').Sharp
    let srcMeta: { width?: number; height?: number }
    let srcBuf: Buffer | null = null
    if (hasCanvas) {
      // Blank canvas: composition sketches, pose blocking, layout studies
      const cw = Math.min(4096, Math.max(64, Math.round(input.canvas!.width || 1024)))
      const ch = Math.min(4096, Math.max(64, Math.round(input.canvas!.height || 1024)))
      // 'transparent' canvas = rasterize-layers mode (the viewer's Merge bakes
      // drawing ops onto transparency to collapse them into one overlay)
      const transparentBg = input.canvas!.color === 'transparent'
      const bg = transparentBg ? { r: 0, g: 0, b: 0 } : (parseHexColor(input.canvas!.color) ?? { r: 255, g: 255, b: 255 })
      img = sharp({ create: { width: cw, height: ch, channels: 4, background: { ...bg, alpha: transparentBg ? 0 : 1 } } })
      srcMeta = { width: cw, height: ch }
    } else {
      const srcRes = await fetch(input.image_url!)
      if (!srcRes.ok) return { error: 'Could not download the source image' }
      srcBuf = Buffer.from(await srcRes.arrayBuffer())
      srcMeta = await sharp(srcBuf, { failOn: 'none' }).metadata()
      img = sharp(srcBuf, { failOn: 'none' })
    }

    for (const raw of input.operations) {
      const op = raw as EditImageOp
      // Gemini habitually DROPS the op field on stencil erases. When the
      // shape is unambiguous (shape + feather/keep, no fill/stroke = cannot
      // be the vector-drawing op), repair it instead of burning a retry
      // round; everything else still hits the loud catch-all below.
      const o0 = op as unknown as Record<string, unknown>
      if (o0.op === undefined && typeof o0.shape === 'string'
          && (o0.feather !== undefined || o0.keep !== undefined)
          && o0.fill === undefined && o0.stroke === undefined) {
        o0.op = 'erase_shape'
      }
      opNo++
      opName = op.op
      if (op.op === 'crop') {
        // Materialize to get the CURRENT size (prior ops may have changed it),
        // then coerce + clamp the rect: the model sometimes omits x/y, sends
        // 0-1 fractions, or overshoots the edge — each used to NaN/throw and
        // kill the whole chain.
        const cb = await img.png().toBuffer()
        const cbm = await sharp(cb, { failOn: 'none' }).metadata()
        const iw = cbm.width ?? 1024, ih = cbm.height ?? 1024
        let rx = Number(op.x), ry = Number(op.y), rw = Number(op.width), rh = Number(op.height)
        if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) {
          return { error: `crop needs numeric width+height in pixels (got width=${JSON.stringify(op.width)}, height=${JSON.stringify(op.height)}). The image is ${iw}x${ih}px; x/y default to 0.` }
        }
        if (rw <= 1 && rh <= 1) {
          // all-fractional rect → scale to pixels
          rx = (Number.isFinite(rx) ? rx : 0) * iw
          ry = (Number.isFinite(ry) ? ry : 0) * ih
          rw *= iw
          rh *= ih
        }
        const left = Math.min(iw - 1, Math.max(0, Math.round(Number.isFinite(rx) ? rx : 0)))
        const top = Math.min(ih - 1, Math.max(0, Math.round(Number.isFinite(ry) ? ry : 0)))
        img = sharp(cb, { failOn: 'none' }).extract({
          left, top,
          width: Math.max(1, Math.min(iw - left, Math.round(rw))),
          height: Math.max(1, Math.min(ih - top, Math.round(rh))),
        })
      } else if (op.op === 'resize') {
        img = img.resize(op.width ? Math.round(op.width) : undefined, op.height ? Math.round(op.height) : undefined, { fit: 'inside', withoutEnlargement: false })
      } else if (op.op === 'rotate') {
        img = img.rotate(Math.round(op.degrees))
      } else if (op.op === 'flip') {
        img = op.direction === 'vertical' ? img.flip() : img.flop()
      } else if (op.op === 'grayscale') {
        img = img.grayscale()
      } else if (op.op === 'blur') {
        img = img.blur(Math.min(50, Math.max(0.3, op.sigma ?? 5)))
      } else if (op.op === 'sharpen') {
        img = img.sharpen({ sigma: Math.min(10, Math.max(0.3, op.sigma ?? 1)) })
      } else if (op.op === 'adjust') {
        img = img.modulate({
          ...(typeof op.brightness === 'number' ? { brightness: Math.min(3, Math.max(0.1, op.brightness)) } : {}),
          ...(typeof op.saturation === 'number' ? { saturation: Math.min(3, Math.max(0, op.saturation)) } : {}),
          ...(typeof op.hue === 'number' ? { hue: Math.round(op.hue) } : {}),
        })
      } else if (op.op === 'tint') {
        const c = parseHexColor(op.color)
        if (!c) return { error: 'tint color must be a 6-digit hex like #cc8844' }
        img = img.tint(c)
      } else if (op.op === 'remove_background') {
        // AI subject segmentation: working image becomes the dominant subject
        // cut out on transparency (chain pad/overlay after it to recompose)
        const base = await img.png().toBuffer()
        try {
          const cut = await trimCutRegions(await birefnetCutout(base), op.trim_regions)
          img = sharp(cut, { failOn: 'none' })
        } catch (err: any) {
          return { error: `Subject masking failed: ${String(err?.message || err).slice(0, 150)}` }
        }
      } else if (op.op === 'segment') {
        // Promptable segmentation (SAM2): points/box select EXACTLY one region
        // — the precision tool for face+hair cutouts and partial-subject work
        const base = await img.png().toBuffer()
        try {
          const cut = await sam2Cutout(base, op.points, op.box, op.parts, op.invert === true)
          img = sharp(cut, { failOn: 'none' })
        } catch (err: any) {
          return { error: `Segment masking failed: ${String(err?.message || err).slice(0, 150)}` }
        }
      } else if (op.op === 'erase_shape') {
        // Stencil eraser: knock out (or keep only) an arbitrary shape, with
        // feathered edges — trims outfit scraps and bad overlaps off cutouts
        const base = await img.ensureAlpha().png().toBuffer()
        const bm = await sharp(base, { failOn: 'none' }).metadata()
        const bw = bm.width ?? 1024, bh = bm.height ?? 1024
        const mask = await stencilMask(bw, bh, op)
        if (!mask) return { error: 'erase_shape needs rect{x,y,width,height}, ellipse{cx,cy,rx,ry}, or polygon{points:"x1,y1 x2,y2 ..."} (3+ points)' }
        const out = await sharp(base, { failOn: 'none' })
          .composite([{ input: mask, blend: op.keep ? 'dest-in' : 'dest-out' }])
          .png().toBuffer()
        img = sharp(out, { failOn: 'none' })
      } else if (op.op === 'choke') {
        // Matte choke / defringe: pull the cutout's alpha edge INWARD a few px
        // and re-feather — kills the halo band of background color that every
        // AI cutout carries on its boundary. Run after segment/remove_background,
        // before overlaying. No-op on fully opaque images.
        const base = await img.ensureAlpha().png().toBuffer()
        const cm = await sharp(base, { failOn: 'none' }).metadata()
        const cw = cm.width ?? 1024, ch = cm.height ?? 1024
        const amount = Math.min(30, Math.max(0.5, Number(op.amount) || 3))
        const feather = Math.min(20, Math.max(0, Number(op.feather ?? 1.5)))
        // blur alpha then hard-threshold high: only pixels well inside the
        // matte survive (≈ erosion by ~amount px), then soften the new edge.
        // Applied via dest-in (same proven pattern as segment) — the mask
        // multiplies the existing alpha, so it can only ever SHRINK the matte.
        // Soft-ramp erosion: blur the alpha, then remap numerically so only
        // pixels well inside the matte survive (the halo fringe sits below the
        // pivot and fades out). sharp promotes 1-channel raw to 3 channels on
        // some ops (blur included), so every raw read is stride-compacted back
        // to a single channel via resolveWithObject.
        const gray = (r: { data: Buffer; info: { channels: number } }) => {
          if (r.info.channels === 1) return r.data
          const out = Buffer.alloc(cw * ch)
          for (let i = 0; i < out.length; i++) out[i] = r.data[i * r.info.channels]
          return out
        }
        const a0 = gray(await sharp(base, { failOn: 'none' }).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true }))
        const blurred = gray(await sharp(a0, { raw: { width: cw, height: ch, channels: 1 } }).blur(amount).raw().toBuffer({ resolveWithObject: true }))
        let lum: Buffer = Buffer.alloc(cw * ch)
        for (let i = 0; i < lum.length; i++) {
          // Ramp 200→243 maps to 0→255 so the matte INTERIOR saturates to
          // fully opaque (a ×4 gain topped out at 220 = every cutout pasted
          // at 86% opacity — the "layers look transparent" bug)
          const v = (blurred[i] - 200) * 6
          lum[i] = v < 0 ? 0 : v > 255 ? 255 : v
        }
        if (feather > 0.3) {
          lum = gray(await sharp(lum, { raw: { width: cw, height: ch, channels: 1 } }).blur(feather).raw().toBuffer({ resolveWithObject: true }))
        }
        const rgbaMask = Buffer.alloc(cw * ch * 4, 255)
        for (let i = 0; i < cw * ch; i++) rgbaMask[i * 4 + 3] = lum[i]
        const maskPng = await sharp(rgbaMask, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer()
        const choked = await sharp(base, { failOn: 'none' })
          .composite([{ input: maskPng, blend: 'dest-in' }])
          .png().toBuffer()
        img = sharp(choked, { failOn: 'none' })
      } else if (op.op === 'face_swap') {
        // Dedicated face-swap model (fal-ai/face-swap): transplants the FACE
        // from face_image_url onto the person in the working image with proper
        // blending — identity swaps without hand-compositing seams. Keeps the
        // working image's hair/body/lighting.
        const src = resolveAllowedUrl(op.face_image_url)
        if (!src) return { error: 'face_swap face_image_url must be an image from this conversation — copy the URL EXACTLY from the tool result' }
        // The base is normally the opaque target photo — a q95 JPEG uploads
        // ~5× faster than PNG with no visible loss; keep PNG only when the
        // working image actually carries transparency
        const baseMeta = await img.clone().metadata()
        const baseIsOpaque = !baseMeta.hasAlpha
        const base = baseIsOpaque ? await img.clone().jpeg({ quality: 95 }).toBuffer() : await img.png().toBuffer()
        try {
          const result: any = await falWithTimeout('Face swap', 240_000, () => fal.subscribe('fal-ai/face-swap', {
            input: {
              base_image_url: `data:image/${baseIsOpaque ? 'jpeg' : 'png'};base64,${base.toString('base64')}`,
              swap_image_url: src,
            },
          }))
          const outUrl = result?.data?.image?.url ?? result?.image?.url
          if (!outUrl) throw new Error('face-swap returned no image')
          const res2 = await fetch(outUrl, { signal: AbortSignal.timeout(60_000) })
          if (!res2.ok) throw new Error(`could not fetch result (${res2.status})`)
          img = sharp(Buffer.from(await res2.arrayBuffer()), { failOn: 'none' })
        } catch (err: any) {
          return { error: `Face swap failed: ${String(err?.message || err).slice(0, 150)}` }
        }
      } else if (op.op === 'silhouette') {
        // Pixel-perfect solid-color silhouette of the auto-detected subject —
        // stamped over the original (default) or alone on transparency
        const base = await img.png().toBuffer()
        let cut: Buffer
        try {
          cut = await trimCutRegions(await birefnetCutout(base), op.trim_regions)
        } catch (err: any) {
          return { error: `Subject masking failed: ${String(err?.message || err).slice(0, 150)}` }
        }
        // Force the cutout to the base's exact dimensions — BiRefNet usually
        // preserves them, but any drift would fail the composite over the base
        const baseMeta2 = await sharp(base, { failOn: 'none' }).metadata()
        let cutMeta = await sharp(cut, { failOn: 'none' }).metadata()
        if (baseMeta2.width && baseMeta2.height
            && (cutMeta.width !== baseMeta2.width || cutMeta.height !== baseMeta2.height)) {
          cut = await sharp(cut, { failOn: 'none' }).resize(baseMeta2.width, baseMeta2.height, { fit: 'fill' }).png().toBuffer()
          cutMeta = await sharp(cut, { failOn: 'none' }).metadata()
        }
        const c = parseHexColor(op.color) ?? { r: 255, g: 255, b: 255 }
        // blend 'in' keeps the solid color only where the cutout has alpha
        const solid = await sharp({
          create: { width: cutMeta.width ?? 1024, height: cutMeta.height ?? 1024, channels: 4, background: { ...c, alpha: 1 } },
        }).png().toBuffer()
        const sil = await sharp(cut, { failOn: 'none' })
          .composite([{ input: solid, blend: 'in' }])
          .png().toBuffer()
        img = op.on_original === false
          ? sharp(sil, { failOn: 'none' })
          : sharp(base, { failOn: 'none' }).composite([{ input: sil, blend: 'over' }])
      } else if (op.op === 'pad') {
        const c = parseHexColor(op.color) ?? { r: 0, g: 0, b: 0 }
        const px = (v: unknown) => Math.min(2000, Math.max(0, Math.round(Number(v) || 0)))
        img = img.extend({
          top: px(op.top), bottom: px(op.bottom), left: px(op.left), right: px(op.right),
          background: { ...c, alpha: 1 },
        })
      } else if (op.op === 'text') {
        // Exact-text overlay via SVG composite (materialize pipeline for dims)
        const base = await img.png().toBuffer()
        const dims = await sharp(base).metadata()
        const w = dims.width ?? 1024, h = dims.height ?? 1024
        const size = Math.min(h, Math.max(8, Math.round(op.size ?? h / 12)))
        const family = FONT_FAMILIES[op.font ?? 'sans'] ?? FONT_FAMILIES.sans
        const fill = hexStr(op.color) ?? '#ffffff'
        const strokeColor = hexStr(op.stroke)
        const strokeAttrs = strokeColor
          ? ` stroke="${strokeColor}" stroke-width="${Math.max(1, Math.round(op.stroke_width ?? Math.max(2, size / 16)))}" paint-order="stroke"`
          : ''
        const opac = typeof op.opacity === 'number' ? Math.min(1, Math.max(0.05, op.opacity)) : 1
        const esc = String(op.text).slice(0, 200)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // Rotation pivots on the ESTIMATED box center — the same arithmetic
        // the client preview uses (character count, not font metrics), so
        // both sides rotate around the identical point
        const rotT = typeof op.rotate === 'number' && Math.round(op.rotate) ? Math.round(op.rotate) : 0
        // Off-canvas guard (estimate; unrotated text only — rotated strips
        // legitimately hug edges). y is the BASELINE: a small y clips the
        // text above the canvas, the classic coordinate mistake.
        if (!rotT) {
          const gLen = String(op.text).slice(0, 200).length || 1
          const gW = Math.max(size * 0.6, gLen * size * 0.56)
          const gH = size * 1.15
          const gx = op.align === 'center' ? Math.round(op.x) - gW / 2 : Math.round(op.x)
          const gy = Math.round(op.y) - size * 0.85
          const gvw = Math.min(gx + gW, w) - Math.max(gx, 0)
          const gvh = Math.min(gy + gH, h) - Math.max(gy, 0)
          const gFrac = gvw > 0 && gvh > 0 ? (gvw * gvh) / (gW * gH) : 0
          if (gFrac < 0.6) {
            return {
              error: `text "${String(op.text).slice(0, 40)}" lands ~${Math.round((1 - gFrac) * 100)}% OFF-canvas (estimated box ${Math.round(gW)}x${Math.round(gH)} at x=${Math.round(op.x)}, baseline y=${Math.round(op.y)} on ${w}x${h}). Remember: y is the BASELINE (the bottom of the letters) — fix x/y/size so the text sits on the canvas.`,
            }
          }
        }
        let textTransform = ''
        if (rotT) {
          const rawLen = String(op.text).slice(0, 200).length || 1
          const estW = Math.max(size * 0.6, rawLen * size * 0.56)
          const pcx = op.align === 'center' ? Math.round(op.x) : Math.round(op.x) + estW / 2
          const pcy = Math.round(op.y) - size * 0.275
          textTransform = ` transform="rotate(${rotT} ${pcx.toFixed(1)} ${pcy.toFixed(1)})"`
        }
        const svg = Buffer.from(
          `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`
          + `<text x="${Math.round(op.x)}" y="${Math.round(op.y)}" font-family='${family}' font-size="${size}" `
          + `font-weight="${op.weight === 'bold' ? 'bold' : 'normal'}" fill="${fill}"${strokeAttrs} opacity="${opac}" `
          + `text-anchor="${op.align === 'center' ? 'middle' : 'start'}"${textTransform}>${esc}</text></svg>`)
        // Rasterize the text layer alone, knock out eraser strokes, paint brush
        // strokes on top, then composite onto the base
        let txt = await sharp(svg).png().toBuffer()
        if (Array.isArray(op.erase) && op.erase.length) txt = await applyEraseStrokes(txt, w, h, op.erase)
        if (Array.isArray(op.draw) && op.draw.length) txt = await applyDrawStrokes(txt, w, h, op.draw)
        img = sharp(base).composite([{ input: txt, left: 0, top: 0 }])
      } else if (op.op === 'shape') {
        // Vector primitives — scrims behind text, badges, dividers, color
        // blocks; chain many ops to "paint" a layout
        const base = await img.png().toBuffer()
        const dims = await sharp(base).metadata()
        const w = dims.width ?? 1024, h = dims.height ?? 1024
        // Stroke-only shapes (frames, panel borders) must NOT default to a
        // solid black fill — an unfilled full-canvas "border" rect painted
        // entire posters black. No fill + a stroke ⇒ outline only.
        const fill = op.fill === 'none' || (!op.fill && op.stroke)
          ? 'none'
          : (hexStr(op.fill) ?? '#000000')
        const strokeColor = hexStr(op.stroke)
        const sw = Math.max(1, Math.round(op.stroke_width ?? 2))
        const opac = typeof op.opacity === 'number' ? Math.min(1, Math.max(0.05, op.opacity)) : 1
        const n = (v: unknown) => Math.round(Number(v) || 0)
        // Gradient fill (rects): the pro scrim — e.g. transparent→dark fade
        // over the lower third before placing text
        let defs = ''
        let fillPaint = fill
        const g = op.gradient
        if (op.shape === 'rect' && g && hexStr(g.from) && hexStr(g.to)) {
          const [x1, y1, x2, y2] =
            g.direction === 'up' ? [0, 1, 0, 0]
            : g.direction === 'left' ? [1, 0, 0, 0]
            : g.direction === 'right' ? [0, 0, 1, 0]
            : [0, 0, 0, 1] // down
          const so = (v: unknown, d: number) => Math.min(1, Math.max(0, typeof v === 'number' ? v : d))
          defs = `<defs><linearGradient id="lg" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
            + `<stop offset="0%" stop-color="${hexStr(g.from)}" stop-opacity="${so(g.from_opacity, 1)}"/>`
            + `<stop offset="100%" stop-color="${hexStr(g.to)}" stop-opacity="${so(g.to_opacity, 1)}"/>`
            + `</linearGradient></defs>`
          fillPaint = 'url(#lg)'
        }
        const common = `fill="${fillPaint}"${strokeColor ? ` stroke="${strokeColor}" stroke-width="${sw}"` : ''} opacity="${opac}"`
        let el = ''
        if (op.shape === 'rect') {
          el = `<rect x="${n(op.x)}" y="${n(op.y)}" width="${Math.max(1, n(op.width))}" height="${Math.max(1, n(op.height))}"`
            + (op.corner_radius ? ` rx="${Math.max(0, n(op.corner_radius))}"` : '') + ` ${common}/>`
        } else if (op.shape === 'circle') {
          el = `<circle cx="${n(op.cx ?? op.x)}" cy="${n(op.cy ?? op.y)}" r="${Math.max(1, n(op.r ?? 50))}" ${common}/>`
        } else if (op.shape === 'ellipse') {
          el = `<ellipse cx="${n(op.cx ?? op.x)}" cy="${n(op.cy ?? op.y)}" rx="${Math.max(1, n(op.width) / 2 || 60)}" ry="${Math.max(1, n(op.height) / 2 || 40)}" ${common}/>`
        } else if (op.shape === 'line') {
          el = `<line x1="${n(op.x)}" y1="${n(op.y)}" x2="${n(op.x2)}" y2="${n(op.y2)}" stroke="${strokeColor ?? (fill === 'none' ? '#ffffff' : fill)}" stroke-width="${sw}" opacity="${opac}"/>`
        } else if (op.shape === 'polygon') {
          const pts = String(op.points ?? '').replace(/[^0-9.,\s-]/g, '').slice(0, 400)
          if (!pts.trim()) return { error: 'polygon needs points like "100,50 200,150 50,150"' }
          el = `<polygon points="${pts}" ${common}/>`
        } else {
          return { error: `Unknown shape ${String((op as any).shape)}` }
        }
        // Shape rotation: wrap in an SVG group rotated around the shape center
        const rotS = typeof op.rotate === 'number' && Math.round(op.rotate) ? Math.round(op.rotate) : 0
        if (rotS) {
          let pcx = 0, pcy = 0
          if (op.shape === 'rect') { pcx = n(op.x) + Math.max(1, n(op.width)) / 2; pcy = n(op.y) + Math.max(1, n(op.height)) / 2 }
          else if (op.shape === 'circle' || op.shape === 'ellipse') { pcx = n(op.cx ?? op.x); pcy = n(op.cy ?? op.y) }
          else if (op.shape === 'line') { pcx = (n(op.x) + n(op.x2)) / 2; pcy = (n(op.y) + n(op.y2)) / 2 }
          else {
            const ptsArr = String(op.points ?? '').trim().split(/\s+/)
              .map(p => p.split(',').map(Number)).filter(a => a.length === 2 && a.every(Number.isFinite))
            if (ptsArr.length) {
              const xs = ptsArr.map(p => p[0]), ys = ptsArr.map(p => p[1])
              pcx = (Math.min(...xs) + Math.max(...xs)) / 2
              pcy = (Math.min(...ys) + Math.max(...ys)) / 2
            }
          }
          el = `<g transform="rotate(${rotS} ${pcx.toFixed(1)} ${pcy.toFixed(1)})">${el}</g>`
        }
        const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${defs}${el}</svg>`)
        let shp = await sharp(svg).png().toBuffer()
        if (Array.isArray(op.erase) && op.erase.length) shp = await applyEraseStrokes(shp, w, h, op.erase)
        if (Array.isArray(op.draw) && op.draw.length) shp = await applyDrawStrokes(shp, w, h, op.draw)
        img = sharp(base).composite([{ input: shp, left: 0, top: 0 }])
      } else if (op.op === 'patch') {
        // Copy a clean region and stretch it over another area of the SAME
        // image — the one-op way to cover unwanted text/objects with
        // background (no multi-call crop→stretch→overlay chains)
        const base = await img.png().toBuffer()
        const f = op.from ?? ({} as any), t = op.to ?? ({} as any)
        const px = (v: unknown) => Math.max(0, Math.round(Number(v) || 0))
        const dm = (v: unknown) => Math.max(1, Math.round(Number(v) || 1))
        const region = await sharp(base)
          .extract({ left: px(f.x), top: px(f.y), width: dm(f.width), height: dm(f.height) })
          .resize(dm(t.width), dm(t.height), { fit: 'fill' })
          .png().toBuffer()
        img = sharp(base).composite([{ input: region, left: px(t.x), top: px(t.y) }])
      } else if (op.op === 'region_blur') {
        // Blur only a rectangle (soften a background area, censor a detail)
        const base = await img.png().toBuffer()
        const left = Math.max(0, Math.round(op.x)), top = Math.max(0, Math.round(op.y))
        const region = await sharp(base)
          .extract({ left, top, width: Math.max(1, Math.round(op.width)), height: Math.max(1, Math.round(op.height)) })
          .blur(Math.min(50, Math.max(0.3, op.sigma ?? 12)))
          .png().toBuffer()
        img = sharp(base).composite([{ input: region, left, top }])
      } else if (op.op === 'rounded') {
        const base = await img.png().toBuffer()
        const dims = await sharp(base).metadata()
        const w = dims.width ?? 1024, h = dims.height ?? 1024
        const r = Math.min(Math.min(w, h) / 2, Math.max(1, Math.round(op.radius ?? Math.min(w, h) * 0.06)))
        const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`)
        img = sharp(base).composite([{ input: mask, blend: 'dest-in' }])
      } else if (op.op === 'vignette') {
        const base = await img.png().toBuffer()
        const dims = await sharp(base).metadata()
        const w = dims.width ?? 1024, h = dims.height ?? 1024
        const s = Math.min(1, Math.max(0.05, op.strength ?? 0.45))
        const grad = Buffer.from(
          `<svg width="${w}" height="${h}"><defs><radialGradient id="g" cx="50%" cy="50%" r="72%">`
          + `<stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="${s}"/>`
          + `</radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`)
        img = sharp(base).composite([{ input: grad, blend: 'over' }])
      } else if (op.op === 'starfield') {
        // Procedural night sky — deterministic per seed, so the layer editor
        // can re-render it identically and tweak density/color afterwards
        const base = await img.png().toBuffer()
        const dims = await sharp(base).metadata()
        const w = dims.width ?? 1024, h = dims.height ?? 1024
        const col = hexStr(op.color) ?? '#ffffff'
        const parts = computeStarfield(op, w, h).map(p => p.t === 'c'
          ? `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${col}" opacity="${p.o}"/>`
          : `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${col}" stroke-width="${p.w}" opacity="${p.o}" stroke-linecap="round"/>`
        ).join('')
        const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts}</svg>`)
        img = sharp(base).composite([{ input: svg, left: 0, top: 0 }])
      } else if (op.op === 'filter') {
        // One-op looks (Instagram/Snapchat-style grades) — deterministic
        // recipes over the accumulated canvas; strength blends with original
        const base = await img.png().toBuffer()
        const fmeta = await sharp(base, { failOn: 'none' }).metadata()
        const w = fmeta.width ?? 1024, h = fmeta.height ?? 1024
        const alphaScale = async (buf: Buffer, a: number) => {
          const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * a)
          return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
        }
        const tintLayer = async (hex: string, alpha: number, blend: 'overlay' | 'soft-light' | 'screen') => {
          const c = parseHexColor(hex) ?? { r: 255, g: 255, b: 255 }
          return {
            input: await sharp({ create: { width: w, height: h, channels: 4 as const, background: { ...c, alpha } } }).png().toBuffer(),
            blend,
          }
        }
        const vignetteLayer = (strength: number) => ({
          input: Buffer.from(
            `<svg width="${w}" height="${h}"><defs><radialGradient id="v" cx="50%" cy="50%" r="72%">`
            + `<stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="${strength}"/>`
            + `</radialGradient></defs><rect width="${w}" height="${h}" fill="url(#v)"/></svg>`),
          blend: 'over' as const,
        })
        const fname = String(op.name ?? '')
        let f = sharp(base, { failOn: 'none' })
        const comps: { input: Buffer; blend: 'overlay' | 'soft-light' | 'screen' | 'over' }[] = []
        if (fname === 'noir') { f = f.grayscale().gamma(1.2); comps.push(vignetteLayer(0.35)) }
        else if (fname === 'bw') { f = f.grayscale().gamma(1.3) }
        else if (fname === 'vivid') { f = f.modulate({ saturation: 1.42, brightness: 1.02 }) }
        else if (fname === 'matte') { f = f.modulate({ saturation: 0.9, brightness: 1.04 }); comps.push(await tintLayer('#cfcfcf', 0.12, 'screen')) }
        else if (fname === 'warm') { f = f.modulate({ saturation: 1.08, hue: -8, brightness: 1.03 }); comps.push(await tintLayer('#ff9a3c', 0.1, 'overlay')) }
        else if (fname === 'cool') { f = f.modulate({ saturation: 1.05, hue: 10 }); comps.push(await tintLayer('#3c78ff', 0.1, 'overlay')) }
        else if (fname === 'vintage') { f = f.modulate({ saturation: 0.72, brightness: 1.02 }); comps.push(await tintLayer('#d2a05a', 0.18, 'soft-light'), await tintLayer('#bdbdbd', 0.08, 'screen')) }
        else if (fname === 'golden') { f = f.modulate({ saturation: 1.15, brightness: 1.04, hue: -10 }); comps.push(await tintLayer('#ffb84d', 0.16, 'soft-light')) }
        else if (fname === 'dreamy') {
          f = f.modulate({ brightness: 1.04, saturation: 1.05 })
          comps.push({ input: await alphaScale(await sharp(base, { failOn: 'none' }).blur(12).png().toBuffer(), 0.35), blend: 'screen' })
        }
        else if (fname === 'cinematic') { f = f.modulate({ saturation: 1.12, hue: -6 }).gamma(1.12); comps.push(await tintLayer('#0a2a33', 0.12, 'overlay'), vignetteLayer(0.25)) }
        else return { error: `Unknown filter "${fname}" — use noir, bw, vivid, matte, warm, cool, vintage, golden, dreamy, cinematic` }
        let outBuf = comps.length ? await f.composite(comps).png().toBuffer() : await f.png().toBuffer()
        const fstr = typeof op.strength === 'number' ? Math.min(1, Math.max(0, op.strength)) : 1
        if (fstr < 1) {
          img = sharp(base, { failOn: 'none' }).composite([{ input: await alphaScale(outBuf, fstr), left: 0, top: 0 }])
        } else {
          img = sharp(outBuf, { failOn: 'none' })
        }
      } else if (op.op === 'overlay') {
        const fixedOv = resolveAllowedUrl(op.image_url)
        if (!fixedOv) return { error: 'overlay image_url must be an image from this conversation — copy the URL EXACTLY from the tool result' }
        ;(op as { image_url: string }).image_url = fixedOv
        const ovRes = await fetch(op.image_url)
        if (!ovRes.ok) return { error: 'Could not download the overlay image' }
        const ovBuf0 = Buffer.from(await ovRes.arrayBuffer())
        let ov = sharp(ovBuf0, { failOn: 'none' })
        const om = await sharp(ovBuf0, { failOn: 'none' }).metadata()
        const mw = om.width ?? 1, mh = om.height ?? 1
        let srcW = mw, srcH = mh
        // Pre-crop the overlay source (source-image pixels) — the clean way
        // to trim flat cut edges off a BiRefNet cutout before placing it
        if (op.crop) {
          const cl = Math.min(mw - 1, Math.max(0, Math.round(op.crop.x)))
          const ct = Math.min(mh - 1, Math.max(0, Math.round(op.crop.y)))
          const cw2 = Math.max(1, Math.min(mw - cl, Math.round(op.crop.width)))
          const ch2 = Math.max(1, Math.min(mh - ct, Math.round(op.crop.height)))
          ov = ov.extract({ left: cl, top: ct, width: cw2, height: ch2 })
          srcW = cw2; srcH = ch2
        }
        // GUARDRAIL — the bare-paste blunder: overlaying a fully OPAQUE image
        // across the whole canvas buries everything built so far (the classic
        // failed face swap: the second photo pasted over the first). Reject it
        // with the correction. Legit full-bleed cases stay allowed: a base
        // photo onto a BLANK canvas, reduced opacity, blend modes, erase
        // strokes, or a pre-crop.
        {
          const plainPaste = (op.opacity === undefined || op.opacity >= 0.95)
            && (!op.blend || op.blend === 'over')
            && !(Array.isArray(op.erase) && op.erase.length)
            && !op.crop
          if (plainPaste) {
            const baseProbe = await img.clone().png().toBuffer()
            const bpm = await sharp(baseProbe, { failOn: 'none' }).metadata()
            const bw2 = bpm.width ?? 1, bh2 = bpm.height ?? 1
            const destW2 = op.width ? Math.round(op.width) : mw
            const destH2 = op.height ? Math.round(op.height) : Math.round(destW2 * (mh / mw))
            const coversAll = destW2 >= bw2 * 0.92 && destH2 >= bh2 * 0.92
              && Math.abs(Number(op.x) || 0) <= bw2 * 0.05 && Math.abs(Number(op.y) || 0) <= bh2 * 0.05
            if (coversAll) {
              const ovAlpha = om.hasAlpha ? (await sharp(ovBuf0, { failOn: 'none' }).stats()).channels[3] : null
              const ovOpaque = !om.hasAlpha || (ovAlpha ? ovAlpha.min >= 250 : true)
              if (ovOpaque) {
                const baseAlpha = (await sharp(baseProbe, { failOn: 'none' }).stats()).channels[3]
                const baseBlank = !baseAlpha || baseAlpha.max <= 10
                if (!baseBlank) {
                  return {
                    error: 'REJECTED: this overlay is a fully OPAQUE image covering the ENTIRE canvas — it would bury everything beneath it (the classic failed face swap: one photo pasted over the other). Overlay CUTOUTS or edited results only: for the backward swap, first erase_shape the head region out of this image (its RESULT url gets transparency) and overlay THAT result; for the forward swap, overlay the segment cutout RESULT urls. Never overlay an original photo full-frame.',
                  }
                }
              }
            }
          }
        }
        // Mirror the overlay so subjects can face INTO the composition
        if (op.flip) ov = op.flip === 'vertical' ? ov.flip() : ov.flop()
        // GUARDRAIL: width+height stretches (fit:fill). Warping people is the
        // #1 grid-layout crime — reject aspect distortion beyond ~7% unless
        // stretch:true declares it (abstract textures only). The right way to
        // fill a mismatched cell is crop-to-cell-aspect + uniform size.
        if (op.width && op.height && op.stretch !== true) {
          const target = Math.round(op.width) / Math.round(op.height)
          const src = srcW / srcH
          const dev = Math.abs(target - src) / src
          if (dev > 0.07) {
            return {
              error: `width+height would STRETCH this overlay ${Math.round(dev * 100)}% off its natural aspect (source is ${srcW}x${srcH}${op.crop ? ' after crop' : ''}, requested ${Math.round(op.width)}x${Math.round(op.height)}). People must NEVER be warped — crop the source to the cell's aspect first (crop:{x,y,width,height} centered on the subject) and then size uniformly. stretch:true is allowed ONLY for abstract textures, never faces or bodies.`,
            }
          }
        }
        // width alone keeps aspect; width+height stretches (side squeezes)
        if (op.width && op.height) ov = ov.resize(Math.round(op.width), Math.round(op.height), { fit: 'fill' })
        else if (op.width) ov = ov.resize(Math.round(op.width))
        // Uniform opacity — SCALE the alpha channel instead of stripping it,
        // so transparent cutouts (remove_background results) keep their mask
        const opacity = typeof op.opacity === 'number' ? Math.min(1, Math.max(0.05, op.opacity)) : 1
        if (opacity < 1) {
          const { data, info } = await ov.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * opacity)
          ov = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        }
        let ovBuf = await ov.png().toBuffer()
        const blend = (['over', 'multiply', 'screen', 'overlay', 'soft-light'] as const).includes(op.blend as any)
          ? op.blend! : 'over'
        // materialize current pipeline before compositing
        const base = await img.png().toBuffer()
        const baseMeta = await sharp(base, { failOn: 'none' }).metadata()
        const bw = baseMeta.width ?? 1024, bh = baseMeta.height ?? 1024
        // AUTO-FIT: sharp hard-fails when a composite is larger than the base
        // at its position ("must have same dimensions or smaller") — scale
        // oversized overlays down and clamp the position instead of failing
        let ovMeta = await sharp(ovBuf, { failOn: 'none' }).metadata()
        let ow = ovMeta.width ?? 1, oh = ovMeta.height ?? 1
        // Auto-shrink oversized overlays ONLY when no explicit width was given
        // — an explicit size is deliberate (and may overflow for bleeds)
        if (!op.width && (ow > bw || oh > bh)) {
          ovBuf = await sharp(ovBuf, { failOn: 'none' }).resize(bw, bh, { fit: 'inside' }).png().toBuffer()
          ovMeta = await sharp(ovBuf, { failOn: 'none' }).metadata()
          ow = ovMeta.width ?? ow
          oh = ovMeta.height ?? oh
        }
        // Eraser + brush strokes are normalized to the FITTED overlay box
        if (Array.isArray(op.erase) && op.erase.length) {
          ovBuf = await applyEraseStrokes(ovBuf, ow, oh, op.erase)
        }
        if (Array.isArray(op.draw) && op.draw.length) {
          ovBuf = await applyDrawStrokes(ovBuf, ow, oh, op.draw)
        }
        let px = Math.round(op.x), py = Math.round(op.y)
        // 360° spin around the overlay's center — the buffer expands to the
        // rotated bounding box, so the position compensates to keep the center
        const rot = typeof op.rotate === 'number' ? ((Math.round(op.rotate) % 360) + 360) % 360 : 0
        if (rot) {
          ovBuf = await sharp(ovBuf, { failOn: 'none' })
            .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png().toBuffer()
          const rm = await sharp(ovBuf, { failOn: 'none' }).metadata()
          const rw = rm.width ?? ow, rh = rm.height ?? oh
          px = Math.round(px + ow / 2 - rw / 2)
          py = Math.round(py + oh / 2 - rh / 2)
          ow = rw; oh = rh
        }
        // OFF-CANVAS placement: instead of clamping the position, CROP the
        // overlay to its visible intersection with the canvas — bleeding a
        // cutout off the edge is the pro move the flat-side doctrine demands
        const vx = Math.max(0, px), vy = Math.max(0, py)
        const vr = Math.min(px + ow, bw), vb = Math.min(py + oh, bh)
        // GUARDRAIL: a mostly-invisible overlay is almost always a coordinate
        // mistake, not a bleed. Big bleeds must be declared with bleed:true —
        // otherwise reject with the arithmetic so the model can fix x/y.
        const visFrac = vr > vx && vb > vy ? ((vr - vx) * (vb - vy)) / (ow * oh) : 0
        if (visFrac < 0.6 && op.bleed !== true) {
          return {
            error: `overlay lands ${Math.round((1 - visFrac) * 100)}% OFF-canvas — only ${Math.max(0, vr - vx)}x${Math.max(0, vb - vy)} of its ${ow}x${oh} is visible at x=${px}, y=${py} on the ${bw}x${bh} canvas. If this large bleed is DELIBERATE, set bleed:true on the op; otherwise fix x/y/width so the subject is actually on the canvas.`,
          }
        }
        if (vr > vx && vb > vy) {
          if (vx !== px || vy !== py || vr - vx !== ow || vb - vy !== oh) {
            ovBuf = await sharp(ovBuf, { failOn: 'none' })
              .extract({ left: vx - px, top: vy - py, width: vr - vx, height: vb - vy })
              .png().toBuffer()
          }
          img = sharp(base).composite([{ input: ovBuf, left: vx, top: vy, blend }])
        } else {
          img = sharp(base) // fully off-canvas — nothing visible to composite
        }
      } else {
        // Unknown / op-less operation: FAIL LOUDLY. Silently skipping these
        // produced "successful" edits that changed NOTHING — the model then
        // composited untouched images believing its erases had happened (the
        // classic result: two photos pasted on top of each other).
        const keys = Object.keys(raw ?? {}).filter(k => k !== 'op').slice(0, 8).join(', ')
        const got = (op as { op?: unknown }).op
        return {
          error: `operation ${opNo} ${got === undefined ? 'has NO "op" field' : `has unknown op "${String(got)}"`} (received keys: ${keys || 'none'}). Every operation MUST name its op — ${keys.includes('shape') || keys.includes('points') ? 'this one looks like {op:"erase_shape",...} (stencil eraser) or {op:"shape",...} (vector drawing) — pick one and resend. ' : ''}Nothing was applied; fix the operation and resend the FULL chain.`,
        }
      }
    }

    const out = await img.png().toBuffer()
    const outMeta = await sharp(out).metadata()
    // Numeric cutout audit: when the result has real transparency, report the
    // alpha coverage + bounding box. Vision models are poor at judging cutout
    // extents from a transparent PNG — the numbers let the model CHECK that a
    // "face+hair" cutout doesn't secretly reach the collar/outfit.
    let alphaNote = ''
    try {
      if ((outMeta.channels ?? 3) === 4 && outMeta.width && outMeta.height) {
        const ow = outMeta.width, oh = outMeta.height
        const aRaw = await sharp(out, { failOn: 'none' }).extractChannel(3).raw().toBuffer({ resolveWithObject: true })
        const stride = aRaw.info.channels
        let on = 0, minX = ow, minY = oh, maxX = -1, maxY = -1
        for (let y = 0; y < oh; y++) {
          for (let x = 0; x < ow; x++) {
            if (aRaw.data[(y * ow + x) * stride] > 40) {
              on++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        const pct = (100 * on) / (ow * oh)
        if (maxY >= 0 && pct < 99.5) {
          alphaNote = ` TRANSPARENCY AUDIT: visible pixels cover ${pct.toFixed(1)}% of the canvas, bounding box x ${minX}-${maxX}, y ${minY}-${maxY}. Compare this box against what you MEANT to keep — a face+hair cutout whose box bottom reaches the shoulders/neckline still carries outfit fabric: shave it (erase_shape polygon, feather 8-12) or re-segment the ORIGINAL with label:0 points on the clothing.`
        }
      }
    } catch { /* audit is best-effort */ }
    // CHANGE MAP for composites: WHERE did this edit actually change pixels?
    // A face/head paste that changed the torso means donor outfit rode along
    // (or an erase hole ate the outfit) — the model cannot reliably see that
    // in a thumbnail, but it can read a diff bounding box.
    let changeNote = ''
    try {
      const opsUsed = new Set((input.operations as { op?: string }[]).map(o => o?.op))
      const compositing = opsUsed.has('overlay') || opsUsed.has('face_swap') || opsUsed.has('patch')
      if (compositing && srcBuf && outMeta.width && outMeta.height
          && srcMeta.width === outMeta.width && srcMeta.height === outMeta.height) {
        const dw = Math.max(1, Math.min(384, outMeta.width))
        const dh = Math.max(1, Math.round(dw * (outMeta.height / outMeta.width)))
        const flat = (buf: Buffer) => sharp(buf, { failOn: 'none' })
          .flatten({ background: '#808080' })
          .resize(dw, dh, { fit: 'fill' })
          .raw().toBuffer({ resolveWithObject: true })
        const [ra, rb] = await Promise.all([flat(srcBuf), flat(out)])
        const ca = ra.info.channels, cb = rb.info.channels
        let changed = 0, minX = dw, minY = dh, maxX = -1, maxY = -1
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const ia = (y * dw + x) * ca, ib = (y * dw + x) * cb
            const d = Math.abs(ra.data[ia] - rb.data[ib])
              + Math.abs(ra.data[ia + 1] - rb.data[ib + 1])
              + Math.abs(ra.data[ia + 2] - rb.data[ib + 2])
            if (d > 60) {
              changed++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxY >= 0) {
          const sx = outMeta.width / dw, sy = outMeta.height / dh
          const pct = (100 * changed) / (dw * dh)
          changeNote = ` CHANGE MAP: vs the source, this edit changed ${pct.toFixed(1)}% of the canvas, inside box x ${Math.round(minX * sx)}-${Math.round(maxX * sx)}, y ${Math.round(minY * sy)}-${Math.round(maxY * sy)} (full-res px). Check this against your INTENT: a face/head paste should change ONLY the head region — a change box that reaches below the collarbone means donor outfit fabric rode along on the cutout or your erase hole ate the target outfit. If so: verdict revise, restart from the ORIGINALS with a tighter cutout/hole.`
        }
      }
    } catch { /* change map is best-effort */ }
    const { uploadToR2 } = await import('@/lib/r2')
    const url = await uploadToR2(`chat-edit-${ctx.user.id}-${Date.now()}.png`, out, 'image/png')
    // NOTE: no GeneratedImage row here — drafts/sketches would pollute the
    // portal feeds. The route persists only the run's FINAL edit on finalize.
    return {
      imageUrl: url,
      width: outMeta.width ?? null,
      height: outMeta.height ?? null,
      note: hasCanvas
        ? `Sketch created at ${outMeta.width}x${outMeta.height}px. Use it in reference_image_urls as a composition/pose blocking reference — tell the generation model it is a rough sketch to follow, not final art.`
        : `Edit applied — source was ${srcMeta.width}x${srcMeta.height}px, result is ${outMeta.width}x${outMeta.height}px. Use these EXACT dimensions for any follow-up coordinates.${alphaNote}${changeNote} The result is shown to the user automatically — describe what changed, do not print the URL.`,
    }
  } catch (err: any) {
    console.error('chat-hub edit_image error:', err)
    const at = opName ? ` at operation ${opNo} (${opName})` : ''
    return { error: `Edit failed${at}: ${String(err?.message || err).slice(0, 200)}. Nothing was saved — fix that operation and resend the FULL operations chain.` }
  }
}

// ── search_refs: browse the user's reference library ───────────────────────
export async function executeSearchRefs(
  input: { folder?: string; limit?: number },
  ctx: { user: { id: number }; allowedImages: Set<string> },
): Promise<{ refs: { url: string; folder: string | null }[]; note: string } | { error: string }> {
  try {
    const limit = Math.min(24, Math.max(1, input.limit ?? 12))
    const rows = await prisma.userReference.findMany({
      where: {
        userId: ctx.user.id,
        isCleared: false,
        ...(input.folder?.trim()
          ? { folder: { name: { contains: input.folder.trim(), mode: 'insensitive' } } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { url: true, folder: { select: { name: true } } },
    })
    const refs = rows.map(r => ({ url: r.url, folder: r.folder?.name ?? null }))
    for (const r of refs) ctx.allowedImages.add(r.url) // usable by edit_image/create_media
    return {
      refs,
      note: refs.length
        ? 'These reference URLs can now be passed to create_media (as generation references) or edit_image. References have no captions — folder names are the only text metadata.'
        : 'No references found' + (input.folder ? ` in folders matching "${input.folder}"` : ' in the library'),
    }
  } catch (err: any) {
    return { error: `Reference search failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// ── dataset: the admin dataset/buckets system (ADMIN ACCOUNTS ONLY) ────────
// Browse folders/buckets, pull bucket images into the conversation (URLs join
// allowedImages → usable by edit_image/create_media), curate: create buckets/
// folders, move generations in/out, toggle the training mark.
export async function executeDataset(
  input: {
    action: string; bucket?: string; folder?: string; parent?: string
    name?: string; description?: string; color?: string
    query?: string; model?: string; marked?: boolean
    image_ids?: number[]; limit?: number
  },
  ctx: { allowedImages: Set<string>; isAdmin?: boolean },
): Promise<Record<string, unknown> | { error: string }> {
  // FAIL-CLOSED: the dataset system is strictly admin-only. Even if tool
  // registration ever changes, non-admin executions die here.
  if (ctx.isAdmin !== true) return { error: 'Admin only — the dataset system is not available on this account.' }
  const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv)$/i
  const limit = Math.min(40, Math.max(1, input.limit ?? 20))
  const findBucket = async (ref?: string) => {
    if (!ref?.trim()) return null
    const idNum = Number(ref)
    return prisma.datasetBucket.findFirst({
      where: Number.isInteger(idNum) && idNum > 0
        ? { id: idNum }
        : { name: { contains: ref.trim(), mode: 'insensitive' } },
    })
  }
  const findFolder = async (ref?: string) => {
    if (!ref?.trim()) return null
    const idNum = Number(ref)
    return prisma.datasetBucketFolder.findFirst({
      where: Number.isInteger(idNum) && idNum > 0
        ? { id: idNum }
        : { name: { contains: ref.trim(), mode: 'insensitive' } },
    })
  }
  const mapImages = (rows: { id: number; imageUrl: string; thumbnailUrl?: string | null; prompt: string; model: string; markedForTraining: boolean; adminTags?: string[]; adminCaption?: string | null }[]) =>
    rows.map(r => {
      ctx.allowedImages.add(r.imageUrl)
      return {
        id: r.id, url: r.imageUrl,
        ...(r.thumbnailUrl ? { thumb: r.thumbnailUrl } : {}),
        prompt: r.prompt.slice(0, 140), model: r.model,
        marked_for_training: r.markedForTraining,
        is_video: VIDEO_RE.test(r.imageUrl),
        ...(r.adminTags?.length ? { tags: r.adminTags.slice(0, 6) } : {}),
        ...(r.adminCaption ? { caption: r.adminCaption.slice(0, 120) } : {}),
      }
    })
  const imgNote = 'These URLs are now usable in edit_image (source/overlay) and create_media (references) — copy them EXACTLY. The FIRST 8 results are attached as image previews — LOOK at them and pick BY EYE: solo, sharp, well-lit shots of the subject with no other people. If nothing fits, search again with a refined query or a higher limit instead of settling. Training export itself runs from the admin dataset page (bucket → Export).'
  const bucketNameList = async () => {
    const rows2 = await prisma.datasetBucket.findMany({ select: { name: true }, orderBy: { createdAt: 'asc' }, take: 40 })
    return rows2.map(b => b.name).join(', ') || '(no buckets exist yet)'
  }
  const ids = Array.isArray(input.image_ids) ? input.image_ids.filter(n => Number.isInteger(n)).slice(0, 200) : []
  try {
    switch (input.action) {
      case 'list_buckets': {
        const buckets = await prisma.datasetBucket.findMany({
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { images: true } }, folder: { select: { name: true } } },
        })
        return {
          buckets: buckets.map(b => ({
            id: b.id, name: b.name, description: b.description ?? undefined,
            folder: b.folder?.name ?? null, images: b._count.images,
          })),
        }
      }
      case 'list_folders': {
        const folders = await prisma.datasetBucketFolder.findMany({
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, parentId: true, _count: { select: { buckets: true } } },
        })
        return { folders: folders.map(f => ({ id: f.id, name: f.name, parentId: f.parentId, buckets: f._count.buckets })) }
      }
      case 'bucket_images': {
        const bucket = await findBucket(input.bucket)
        if (!bucket) {
          return { error: `No bucket matching "${input.bucket ?? ''}". Existing buckets RIGHT NOW: ${await bucketNameList()}. Bucket names are their SUBJECT (a person, character, or style) — pick the matching name from this list, don't guess. This list is LIVE and changes as the user curates — never rely on an earlier snapshot.` }
        }
        const rows = await prisma.datasetBucketImage.findMany({
          where: { bucketId: bucket.id, image: { isDeleted: false } },
          orderBy: { addedAt: 'desc' },
          take: limit,
          select: { image: { select: { id: true, imageUrl: true, thumbnailUrl: true, prompt: true, model: true, markedForTraining: true, adminTags: true, adminCaption: true } } },
        })
        return { bucket: bucket.name, images: mapImages(rows.map(r => r.image)), note: imgNote }
      }
      case 'search_images': {
        const bucket = input.bucket ? await findBucket(input.bucket) : null
        if (input.bucket && !bucket) return { error: `No bucket matching "${input.bucket}". Existing buckets: ${await bucketNameList()}` }
        const q = input.query?.trim()
        const rows = await prisma.generatedImage.findMany({
          where: {
            isDeleted: false,
            // Query matches the prompt OR the name of a bucket the image is
            // filed in — "Carrie Fisher" finds the whole Carrie Fisher pack
            // even when individual prompts never mention her
            ...(q ? {
              OR: [
                { prompt: { contains: q, mode: 'insensitive' } },
                { adminCaption: { contains: q, mode: 'insensitive' } },
                { bucketImages: { some: { bucket: { name: { contains: q, mode: 'insensitive' } } } } },
              ],
            } : {}),
            ...(input.model?.trim() ? { model: { contains: input.model.trim(), mode: 'insensitive' } } : {}),
            ...(typeof input.marked === 'boolean' ? { markedForTraining: input.marked } : {}),
            ...(bucket ? { bucketImages: { some: { bucketId: bucket.id } } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, imageUrl: true, thumbnailUrl: true, prompt: true, model: true, markedForTraining: true, adminTags: true, adminCaption: true },
        })
        return {
          images: mapImages(rows),
          note: rows.length
            ? imgNote
            : `No matches for that query. SEARCH BY SUBJECT, not deliverable: buckets are named after the person/character/style they contain ("Carrie Fisher"), never the thing you are making ("website advertisement"). Existing buckets: ${await bucketNameList()}. Pick the relevant name and call bucket_images with it. Only ask the user for references after the buckets and search_refs both come up empty.`,
        }
      }
      case 'create_bucket': {
        if (!input.name?.trim()) return { error: 'create_bucket needs a name' }
        const folder = input.folder ? await findFolder(input.folder) : null
        if (input.folder && !folder) return { error: `No folder matching "${input.folder}" — use list_folders or create_folder first` }
        const b = await prisma.datasetBucket.create({
          data: {
            name: input.name.trim(),
            description: input.description?.slice(0, 500),
            color: input.color,
            folderId: folder?.id ?? null,
          },
        })
        return { created: { id: b.id, name: b.name, folder: folder?.name ?? null } }
      }
      case 'create_folder': {
        if (!input.name?.trim()) return { error: 'create_folder needs a name' }
        const parent = input.parent ? await findFolder(input.parent) : null
        if (input.parent && !parent) return { error: `No folder matching "${input.parent}"` }
        const f = await prisma.datasetBucketFolder.create({
          data: { name: input.name.trim(), parentId: parent?.id ?? null },
        })
        return { created: { id: f.id, name: f.name, parent: parent?.name ?? null } }
      }
      case 'add_to_bucket':
      case 'remove_from_bucket': {
        const bucket = await findBucket(input.bucket)
        if (!bucket) return { error: `No bucket matching "${input.bucket ?? ''}"` }
        if (!ids.length) return { error: 'image_ids required (numeric ids from bucket_images/search_images)' }
        if (input.action === 'add_to_bucket') {
          await prisma.datasetBucketImage.createMany({
            data: ids.map(imageId => ({ bucketId: bucket.id, imageId })),
            skipDuplicates: true,
          })
        } else {
          await prisma.datasetBucketImage.deleteMany({ where: { bucketId: bucket.id, imageId: { in: ids } } })
        }
        const total = await prisma.datasetBucketImage.count({ where: { bucketId: bucket.id } })
        return { bucket: bucket.name, affected: ids.length, bucket_total: total }
      }
      case 'mark_training': {
        if (!ids.length) return { error: 'image_ids required' }
        const marked = input.marked !== false
        const r = await prisma.generatedImage.updateMany({
          where: { id: { in: ids } },
          data: { markedForTraining: marked },
        })
        return { updated: r.count, marked_for_training: marked }
      }
      case 'move_bucket': {
        const bucket = await findBucket(input.bucket)
        if (!bucket) return { error: `No bucket matching "${input.bucket ?? ''}"` }
        const folder = input.folder && input.folder !== 'root' ? await findFolder(input.folder) : null
        if (input.folder && input.folder !== 'root' && !folder) return { error: `No folder matching "${input.folder}"` }
        await prisma.datasetBucket.update({ where: { id: bucket.id }, data: { folderId: folder?.id ?? null } })
        return { bucket: bucket.name, moved_to: folder?.name ?? 'root' }
      }
      default:
        return { error: 'Unknown action. Use: list_buckets, list_folders, bucket_images, search_images, create_bucket, create_folder, add_to_bucket, remove_from_bucket, mark_training, move_bucket' }
    }
  } catch (err: any) {
    return { error: `Dataset action failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// ── web_search: Gemini with Google Search grounding (raw REST) ─────────────
export async function executeWebSearch(
  input: { query: string },
  ctx: { userKeys: Record<string, string> },
): Promise<{ answer: string; sources?: string[] } | { error: string }> {
  const key = ctx.userKeys['Google'] ?? process.env.GEMINI_API_KEY
  if (!key) return { error: 'Web search needs a Google API key (Profile → Chat Settings)' }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Search the web and answer factually and concisely with key details: ${input.query}` }] }],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(45_000),
      },
    )
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { error: `Search failed (${res.status}): ${t.slice(0, 120)}` }
    }
    const data = await res.json()
    const parts = data?.candidates?.[0]?.content?.parts ?? []
    const answer = parts.map((p: any) => p.text ?? '').join('').trim()
    const sources: string[] = (data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
      .map((c: any) => c?.web?.uri)
      .filter((u: any) => typeof u === 'string')
      .slice(0, 5)
    if (!answer) return { error: 'Search returned no answer' }
    return { answer: answer.slice(0, 8000), ...(sources.length ? { sources } : {}) }
  } catch (err: any) {
    return { error: `Search failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// ── save_memory: project-scoped notes persisted across chats ────────────────
export async function executeSaveMemory(
  input: { content: string },
  ctx: { user: { id: number }; projectId: number | null },
): Promise<{ saved: true; note: string } | { error: string }> {
  if (!ctx.projectId) return { error: 'This chat is not in a project — project memory needs the chat to be moved into a project first' }
  const content = String(input.content ?? '').trim().slice(0, 8000)
  if (!content) return { error: 'Memory content is empty' }
  try {
    const updated = await prisma.chatProject.updateMany({
      where: { id: ctx.projectId, userId: ctx.user.id },
      data: { memory: content },
    })
    if (updated.count === 0) return { error: 'Project not found' }
    return { saved: true, note: 'Project memory updated (full replacement). It is injected into your context in every chat of this project.' }
  } catch (err: any) {
    return { error: `Saving memory failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// ── remember: account-global memory entries (Higgsfield-style) ──────────────
export async function executeRemember(
  input: { content: string; category?: string },
  ctx: { user: { id: number } },
): Promise<{ saved: true; note: string } | { error: string }> {
  const content = String(input.content ?? '').trim().slice(0, 500)
  const category = typeof input.category === 'string' ? input.category.trim().slice(0, 30) || null : null
  if (!content) return { error: 'Memory content is empty' }
  try {
    const existing = await prisma.chatMemory.findFirst({
      where: { userId: ctx.user.id, content },
      select: { id: true },
    })
    if (existing) return { saved: true, note: 'Already in memory — no duplicate created.' }
    const count = await prisma.chatMemory.count({ where: { userId: ctx.user.id } })
    if (count >= 60) {
      return { error: 'Global memory is full (60 entries). Ask the user to prune or consolidate entries in the Memory panel before adding more.' }
    }
    await prisma.chatMemory.create({
      data: { userId: ctx.user.id, content, category, source: 'agent' },
    })
    return { saved: true, note: 'Saved to account-wide memory — every chat sees it from the next step onward.' }
  } catch (err: any) {
    return { error: `Saving memory failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// Compact GLOBAL MEMORY block for instruction assembly — newest-first entries
// capped at ~4800 chars (~1.2k tokens). Empty string when no entries.
export async function loadGlobalMemory(userId: number): Promise<string> {
  try {
    const rows = await prisma.chatMemory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { content: true, category: true },
    })
    if (!rows.length) return ''
    const out: string[] = []
    let chars = 0
    for (const r of rows) {
      const line = `- ${r.category ? `[${r.category}] ` : ''}${r.content}`
      if (chars + line.length > 4800) break
      out.push(line)
      chars += line.length
    }
    return `GLOBAL MEMORY (account-wide notes, newest first — add with the remember tool; the user manages them in the Memory panel):\n${out.join('\n')}`
  } catch {
    return ''
  }
}

// ── edit_instructions: chat system prompt + saved presets (always approved) ─
export async function executeEditInstructions(
  input: { action: 'set_chat_instructions' | 'save_preset'; text: string; preset_name?: string },
  ctx: { user: { id: number }; chatId: number },
): Promise<{ saved: true; note: string } | { error: string }> {
  const text = String(input.text ?? '').trim()
  if (!text) return { error: 'Instructions text is empty' }
  if (text.length > 4000) return { error: 'Instructions must be under 4000 characters' }
  try {
    if (input.action === 'set_chat_instructions') {
      const updated = await prisma.chat.updateMany({
        where: { id: ctx.chatId, userId: ctx.user.id },
        data: { systemPrompt: text },
      })
      if (updated.count === 0) return { error: 'Chat not found' }
      return { saved: true, note: 'Chat instructions replaced — they apply from the NEXT message onward (this turn still runs on the old ones). The user can view/edit them in the Instructions panel.' }
    }
    if (input.action === 'save_preset') {
      const name = String(input.preset_name ?? '').trim().slice(0, 40)
      if (!name) return { error: 'preset_name is required for save_preset' }
      const row = await prisma.user.findUnique({
        where: { id: ctx.user.id },
        select: { portalPreferences: true },
      })
      const prefs = (row?.portalPreferences as Record<string, unknown>) ?? {}
      const personas = Array.isArray(prefs.chatHubPersonas) ? [...(prefs.chatHubPersonas as any[])] : []
      const existing = personas.findIndex(p => p && typeof p === 'object' && p.name === name)
      if (existing >= 0) {
        personas[existing] = { ...personas[existing], text }
      } else {
        if (personas.length >= 20) return { error: 'Preset limit (20) reached — ask the user to delete one first' }
        personas.unshift({
          id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name, text, modelId: null,
        })
      }
      await prisma.user.update({
        where: { id: ctx.user.id },
        data: { portalPreferences: JSON.parse(JSON.stringify({ ...prefs, chatHubPersonas: personas })) },
      })
      return {
        saved: true,
        note: existing >= 0
          ? `Preset "${name}" updated (it already existed — its text was replaced).`
          : `Preset "${name}" saved — the user can apply it from the Instructions panel in any chat.`,
      }
    }
    return { error: 'Unknown action — use set_chat_instructions or save_preset' }
  } catch (err: any) {
    return { error: `Saving instructions failed: ${String(err?.message || err).slice(0, 150)}` }
  }
}

// Persist ONLY the run's final edit to the portal feed (drafts/sketches stay
// chat-only). Called from finalize once the reply settles (nothing pending).
export async function persistFinalEdit(userId: number, steps: AgentStep[], pendingCount: number): Promise<void> {
  if (pendingCount > 0) return
  const edits = steps.filter(s => s.tool === 'edit_image' && s.imageUrl)
  const final = edits[edits.length - 1]
  if (!final?.imageUrl) return
  // Blocking sketches are working material, not deliverables — keep them out
  // of the portal feed (they stay visible in the chat). BUT canvas-built
  // POSTERS are deliverables: a canvas edit whose ops include overlays, text,
  // or a starfield is finished work, not a sketch.
  if (final.resultPreview?.startsWith('Sketch created')) {
    const ops = Array.isArray(final.editRecipe?.operations) ? final.editRecipe.operations as any[] : []
    const deliverable = ops.some(o => o?.op === 'overlay' || o?.op === 'text' || o?.op === 'starfield')
    if (!deliverable) return
  }
  try {
    await prisma.generatedImage.create({
      data: {
        userId,
        prompt: `Edited (final): ${(final.task ?? '').slice(0, 200) || 'chat edit'}`,
        imageUrl: final.imageUrl,
        model: 'chat-image-edit',
        ticketCost: 0,
        referenceImageUrls: [],
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    })
  } catch (err) {
    console.error('persistFinalEdit error:', err)
  }
}

const IMAGE_TOOL_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'] as const

export async function executeGenerateImage(
  input: { prompt: string; aspect_ratio?: string },
  ctx: { user: { id: number; email: string }; attachedImageUrls: string[] },
): Promise<{ imageUrl: string; note: string } | { error: string }> {
  if (!process.env.FAL_KEY) return { error: 'FAL_KEY is not configured' }
  const ticketResult = await deductGenerationTickets(ctx.user.id, ctx.user.email, CHAT_TOOL_IMAGE_COST)
  if (!ticketResult.ok) {
    return { error: `Insufficient tickets — image generation costs ${CHAT_TOOL_IMAGE_COST}, the user has ${ticketResult.have}. Tell the user to top up tickets.` }
  }
  try {
    const useRefs = ctx.attachedImageUrls.length > 0
    const endpoint = useRefs ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro'
    const falInput: Record<string, unknown> = {
      prompt: input.prompt,
      resolution: '2K',
      aspect_ratio: IMAGE_TOOL_ASPECTS.includes(input.aspect_ratio as any) ? input.aspect_ratio : '1:1',
      output_format: 'png',
      num_images: 1,
      safety_tolerance: 6,
      enable_safety_checker: false,
    }
    if (useRefs) falInput.image_urls = ctx.attachedImageUrls
    const result = await falWithTimeout('Image generation', 300_000, () => fal.subscribe(endpoint, { input: falInput as any, logs: false }))
    const url = (result.data as any)?.images?.[0]?.url
    if (!url) {
      await refundGenerationTickets(ctx.user.id, ctx.user.email, CHAT_TOOL_IMAGE_COST)
      return { error: 'The image model returned no image' }
    }
    return { imageUrl: url, note: 'Image generated successfully. It is shown to the user automatically — do not print the raw URL; just describe what was created.' }
  } catch (err: any) {
    console.error('chat-hub generate_image error:', err)
    await refundGenerationTickets(ctx.user.id, ctx.user.email, CHAT_TOOL_IMAGE_COST)
    return { error: `Image generation failed: ${String(err?.message || err).slice(0, 200)}` }
  }
}

// ── Tool registration ────────────────────────────────────────────────────────
// accept mode: tools WITHOUT execute — the SDK stops after emitting the calls,
// which is the approval pause. approved mode: tools execute inline; generated
// image URLs are pushed into ctx.generatedUrls for message persistence.

export function makeAgentTools(ctx: {
  mode: AgentMode
  roster: RosterEntry[]
  routes: RoutingMap
  userKeys: Record<string, string>
  user: { id: number; email: string }
  attachedImageUrls: string[]
  generatedUrls: string[]
  allowedImages: Set<string>
  projectId: number | null
  // Approved plan budget (propose_plan): while set, in-plan work executes
  // inline without pausing; the object is shared with the route for persistence
  planBudget?: PlanBudget | null
  // "Approve + don't ask again for edits this run": free edit_image calls
  // execute inline for the rest of the reply
  autoApproveEdits?: boolean
  // Chat's enabled skills — gates which tools register (null = all)
  skills?: SkillSet
  // ADMIN ONLY: unlocks the dataset/buckets tool. Callers must pass true only
  // for accounts that pass checkIsAdmin (requireChatHubAdmin guarantees it
  // today — revisit if the chat hub ever opens to non-admin users).
  isAdmin?: boolean
}): ToolSet | undefined {
  if (ctx.mode === 'plan') return undefined
  const budgetActive = !!ctx.planBudget
  const skills = ctx.skills ?? null
  const imageOn = skillOn(skills, 'image-generation')
  const videoOn = skillOn(skills, 'video-production')
  const mediaOn = imageOn || videoOn
  const editToolOn = skillOn(skills, 'photoshop') || skillOn(skills, 'sketching')

  // Image results become visible attachments in the model's next step, so it
  // can evaluate its own output mid-plan without an approval round-trip
  const mediaToModelOutput = ({ output }: { output: any }) => {
    const url = output?.mediaUrl ?? output?.imageUrl
    if (typeof url === 'string' && /^https:\/\//.test(url) && !/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      return {
        type: 'content' as const,
        value: [
          { type: 'text' as const, text: JSON.stringify(output) },
          {
            type: 'file' as const,
            data: { type: 'url' as const, url: new URL(url) },
            mediaType: /\.png(\?|$)/i.test(url) ? 'image/png' : /\.webp(\?|$)/i.test(url) ? 'image/webp' : 'image/jpeg',
          },
        ],
      }
    }
    return { type: 'json' as const, value: output }
  }

  const delegateSchema = jsonSchema<{ model: string; task: string; context?: string; image_urls?: string[] }>({
    type: 'object',
    properties: {
      model: ctx.roster.length > 0
        ? { type: 'string', enum: ctx.roster.map(r => r.id), description: 'Which model to delegate to' }
        : { type: 'string', description: 'Which model to delegate to' },
      task: { type: 'string', description: 'The complete, self-contained subtask' },
      context: { type: 'string', description: 'Any extra context the model needs' },
      image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional images from this conversation for the delegate to look at (e.g. critique a generated frame before animating it). Max 4.',
      },
    },
    required: ['model', 'task'],
    additionalProperties: false,
  })
  // Media catalog filtered to the enabled kinds — shrinks the tool schema too
  const usableCreate = usableCreateModels(true).filter(m => !m.disabled
    && ((m.kind === 'image' && imageOn) || (m.kind === 'video' && videoOn)))
  const createMediaSchema = jsonSchema<{ model: string; prompt: string; settings?: Record<string, string>; reference_image_urls?: string[] }>({
    type: 'object',
    properties: {
      model: { type: 'string', enum: usableCreate.map(m => m.id), description: 'Which studio media model to use' },
      prompt: { type: 'string', description: 'Detailed generation prompt' },
      settings: {
        type: 'object',
        description: 'Optional per-model settings (aspect, quality, resolution, duration, audio) — invalid values fall back to defaults',
        additionalProperties: { type: 'string' },
      },
      reference_image_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional reference images for the generation — must be URLs already in this conversation (user refs, previously generated media, edit_image outputs, search_refs results). Omit to use the user\'s attached refs. Use this to chain: generated image → video, edited image → new generation, etc.',
      },
    },
    required: ['model', 'prompt'],
    additionalProperties: false,
  })

  const delegateDescription =
    'Delegate a subtask to another AI model from your roster and get its answer back. ' +
    'Announce the delegation to the user in your reply text before calling this.'
  const createMediaDescription =
    'Generate an image or video with one of the studio\'s media models. Costs the user tickets. ' +
    (budgetActive
      ? 'An approved plan budget is ACTIVE: calls within the remaining budget run immediately without approval; calls that exceed it fail with an error telling you to propose a plan update.'
      : ctx.mode === 'approved'
        ? 'AUTO mode: calls run IMMEDIATELY without approval — you are accountable for cost-sensible model and setting choices.'
        : 'Pauses for the user\'s approval — a plan approved via propose_plan replaces per-call approvals.') +
    ' ' +
    (ctx.attachedImageUrls.length
      ? 'The user\'s attached reference images are automatically passed to models that accept them.'
      : '')

  // Without an approved plan budget, create_media only gets execute in AUTO
  // mode (full autonomy) — in Ask/Plan the pause IS the approval. With a
  // budget it executes inline against the ledger in any mode.
  const createMediaTool = (budgetActive || ctx.mode === 'approved')
    ? tool({
        description: createMediaDescription,
        inputSchema: createMediaSchema,
        toModelOutput: mediaToModelOutput,
        execute: async (input) => {
          const b = ctx.planBudget
          if (b) {
            const spec = getCreateModel(input.model)
            const cost = spec && !spec.disabled
              ? computeCreateCost(spec, resolveCreateSettings(spec, input.settings))
              : 0
            const remaining = b.total - b.spent
            if (cost > remaining) {
              return {
                error: `This generation costs ${cost} tickets but only ${remaining} remain in the approved plan budget `
                  + `(${b.total} approved, ${b.spent} spent). `
                  + `Call propose_plan with is_update=true and the ADDITIONAL tickets needed, explaining why.`,
              }
            }
          }
          const out = await executeCreateMedia(input as any, ctx)
          if ('mediaUrl' in out) {
            ctx.generatedUrls.push(out.mediaUrl)
            ctx.allowedImages.add(out.mediaUrl)
            if (!b) return out
            b.spent += out.ticketCost
            return {
              ...out,
              budget: { total: b.total, spent: b.spent, remaining: b.total - b.spent },
              note: `${(out as any).note ?? ''} Plan budget after this generation: ${b.spent}/${b.total} tickets spent, ${b.total - b.spent} remaining.`.trim(),
            }
          }
          if ('error' in out) {
            if (!b) return out
            // Failed generations REFUND automatically (ticket-gate) and are
            // never charged to the plan ledger — tell the model explicitly,
            // or it treats the budget as burned and re-asks for tickets
            return {
              ...out,
              budget: { total: b.total, spent: b.spent, remaining: b.total - b.spent },
              note: `This FAILED generation consumed NO plan budget — its tickets were refunded to the user automatically. `
                + `Ledger unchanged: ${b.spent}/${b.total} spent, ${b.total - b.spent} remaining. `
                + `Retry within the approved budget (adjust settings/prompt/model if the failure repeats) — do NOT propose a budget update for a failure.`,
            }
          }
          return out
        },
      })
    : tool({ description: createMediaDescription, inputSchema: createMediaSchema })

  const editImageSchema = jsonSchema<{ image_url?: string; canvas?: { width: number; height: number; color?: string }; operations: EditImageOp[] }>({
    type: 'object',
    properties: {
      image_url: { type: 'string', description: 'An image URL already in this conversation (attached, generated, or returned by search_refs). Omit and pass canvas instead to draw from scratch.' },
      canvas: {
        type: 'object',
        description: 'Start from a BLANK canvas instead of an existing image — for composition sketches, pose blocking, layout studies used as generation references. {width, height (px, max 4096), color?: "#rrggbb" background}',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
          color: { type: 'string' },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      operations: {
        type: 'array',
        description: 'Up to 20 ops applied in order. Ops: {op:"crop",x,y,width,height} {op:"resize",width?,height?} {op:"rotate",degrees} {op:"flip",direction:"horizontal"|"vertical"} {op:"grayscale"} {op:"blur",sigma?} {op:"region_blur",x,y,width,height,sigma?} (blur only that rectangle) {op:"patch",from:{x,y,width,height},to:{x,y,width,height}} (copy a clean region of the SAME image and stretch it over another area — THE way to cover unwanted text/objects with background, in one op; optionally region_blur the seam after) {op:"sharpen",sigma?} {op:"adjust",brightness?,saturation?,hue?} (1.0 = unchanged, hue in degrees) {op:"tint",color:"#rrggbb"} {op:"filter",name:"noir"|"bw"|"vivid"|"matte"|"warm"|"cool"|"vintage"|"golden"|"dreamy"|"cinematic",strength?:0-1} (one-op Instagram-style grade over everything painted so far — the FINISHING move; apply BEFORE text ops to keep type pure, or after for a unified cast) {op:"rounded",radius?} (rounded corners, transparent outside) {op:"vignette",strength?} (0-1 darkened edges) {op:"starfield",density?,seed?,color?,region?:{x,y,width,height}} (procedural realistic night-sky stars with halos and flares — THE way to fill empty dark space in space/night designs; density 0.5 sparse - 2 dense, same seed = same sky; add BEFORE text/subjects so stars sit behind them) {op:"pad",top?,bottom?,left?,right?,color?} (extend canvas / borders) {op:"text",text,x,y,size?,color?,font?:"sans"|"serif"|"mono"|"impact"|"script"|"condensed",weight?,align?:"left"|"center" (center = x is the midpoint),stroke?,stroke_width?,opacity?,rotate? (degrees around the text center)} (overlay EXACT text — ONE line per op; for multi-line chain one op per line, stepping y by ~1.25×size) {op:"shape",shape:"rect"|"circle"|"ellipse"|"line"|"polygon",x,y,width,height,cx,cy,r,x2,y2,points?,fill?,stroke?,stroke_width?,opacity?,corner_radius?,rotate? (degrees around the shape center),gradient?:{from,to,direction?:"down"|"up"|"left"|"right",from_opacity?,to_opacity?}} (vector primitives — gradient rect = pro fade scrim; chain shapes to build badges, dividers, color blocks. FRAMES/BORDERS: stroke + NO fill = outline only; a fill value paints the whole shape SOLID — a filled full-canvas rect covers everything beneath it) {op:"overlay",image_url,x,y,width?,height?,rotate?,opacity?,blend?:"over"|"multiply"|"screen"|"overlay"|"soft-light",crop?:{x,y,width,height},flip?:"horizontal"|"vertical"} (width alone keeps aspect; width+height stretches and is REJECTED beyond 7% aspect distortion unless stretch:true — textures only, NEVER people: fill mismatched cells by crop-to-cell-aspect + uniform width; rotate spins degrees around the overlay center; x/y may be NEGATIVE or overflow — the overlay crops at the canvas edge, which is exactly HOW you bleed a cutout\'s flat side off-canvas. Overlays landing >40% off-canvas are REJECTED unless you set bleed:true (declare big bleeds deliberately; verify x+width vs canvas arithmetic for every subject). crop trims the overlay SOURCE before placing — in source-image pixels — THE tool for cutting flat truncated edges off a cutout. flip mirrors the overlay: subjects must look/lean INTO the canvas) {op:"remove_background",trim_regions?:[{x,y,width,height}]} (AI subject segmentation — the working image becomes the dominant subject cut out on transparency; floating junk blobs are auto-removed. USUALLY OMIT trim_regions — the cutout is already clean. trim_regions ERASES pixels inside each rect (it does NOT crop-to-keep); use it ONLY for a small stray background patch still stuck to the subject, sized to that patch in source pixels. A rect near the full image size erases the WHOLE subject → blank result, so never pass one; if unsure, omit it) {op:"silhouette",color?:"#hex" (default white),on_original?:boolean,trim_regions?} (pixel-perfect solid-color silhouette of the auto-detected subject — on_original true (default) stamps it over the image, false returns the silhouette alone on transparency) {op:"segment",parts?:[{name,points?:[{x,y,label?:1 keep|0 exclude}],box?:{x_min,y_min,x_max,y_max}}],points?,box?} (SAM2 promptable masking — cuts out EXACTLY what you point at, on transparency. ONE SAM CALL = ONE OBJECT, so anything made of several things is a list of PARTS, each segmented separately and unioned: a full head is parts:[{name:"face",points:[forehead,cheek,cheek,chin + 2 label:0 on the collar]},{name:"hair",points:[top of hair mass,left hair,right hair,any long lengths + 1-2 label:0 on the collar/shoulders]}]; a hat, a sleeve, an arm, a hand, a necklace are each their own part. The part name is ONLY a label — SAM cannot locate "face" by name: EVERY part must carry its own points (or box) with real pixel coordinates you read off the image. Mixing face and hair points in ONE part makes SAM keep only one of them. Up to 6 parts, 14 points each; label:0 negatives on the outfit are MANDATORY for any head part — without them SAM bleeds into fabric. Plain points/box (no parts) = one object. invert:true ERASES the selected region instead of keeping it (auto-grown ~6px + feathered) — THE way to cut a head-shaped hole for the backward swap; NEVER hand-draw an erase_shape polygon around a head, your contours miss at full resolution. Read the TRANSPARENCY AUDIT in the result: box below the chin = outfit survived; box hugging the face tighter than the visible hair = the hair part failed. Far more surgical than remove_background whole-subject cut) {op:"face_swap",face_image_url} (dedicated AI face swap — transplants the FACE from face_image_url onto the person in the working image with professional blending: correct scale, angle, skin tone. Keeps the working image hair/body/outfit/lighting. THE FIRST CHOICE for identity swaps — use the manual segment+overlay pipeline ONLY when the HAIR must move too) {op:"choke",amount?:px (default 3),feather?:px (default 1.5)} (matte defringe — pulls the cutout alpha edge INWARD and re-feathers, killing the halo band of leftover background color every AI cutout carries. Run on every segment/remove_background cutout BEFORE overlaying it — halo bands read as a sticker outline in the composite) {op:"erase_shape",shape:"rect"|"ellipse"|"polygon",x,y,width,height (rect) | cx,cy,rx,ry (ellipse) | points:"x1,y1 x2,y2 x3,y3 ..." (polygon, 3-64 vertices),feather?:px,keep?:boolean} (stencil eraser — makes the pixels INSIDE the shape transparent; keep:true inverts it to a cookie-cutter that keeps ONLY the inside. feather (try 4-15) softens the edge so trims blend invisibly. THE tool for shaving outfit scraps, overlapping arms, or any awkward region off a cutout before overlaying — polygon hugs any contour)',
        items: {
          type: 'object',
          properties: { op: { type: 'string', description: 'REQUIRED on every operation — the operation name (e.g. "erase_shape", "overlay", "segment")' } },
          required: ['op'],
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  })
  const editImageDescription =
    'Edit an image programmatically (crop, resize, rotate, flip, grayscale, blur, overlay/paste another image, ' +
    'AI subject masking: silhouettes and background removal). ' +
    'Free — no tickets. Use your vision to determine pixel coordinates. Announce edits in your reply text first.'

  const searchRefsTool = tool({
    description: 'Browse the user\'s reference library. References have no captions — filter by folder name or list recent. Returned URLs become usable in create_media and edit_image.',
    inputSchema: jsonSchema<{ folder?: string; limit?: number }>({
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name filter (optional)' },
        limit: { type: 'number', description: 'Max results (default 12, max 24)' },
      },
      additionalProperties: false,
    }),
    execute: (input) => executeSearchRefs(input, ctx),
  })
  // Dataset results attach the first 8 images as visual previews — picking
  // by eye is the whole point (prompt snippets can't reveal a second person
  // in frame, bad lighting, or a wrong angle)
  const datasetToModelOutput = ({ output }: { output: any }) => {
    const imgs = Array.isArray(output?.images) ? output.images : []
    const previews = imgs
      .filter((r: any) => !r?.is_video && typeof (r?.thumb ?? r?.url) === 'string')
      .slice(0, 8)
    if (!previews.length) return { type: 'json' as const, value: output }
    try {
      return {
        type: 'content' as const,
        value: [
          { type: 'text' as const, text: JSON.stringify(output) },
          ...previews.map((r: any) => {
            const u = String(r.thumb ?? r.url)
            return {
              type: 'file' as const,
              data: { type: 'url' as const, url: new URL(u) },
              mediaType: /\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : 'image/jpeg',
            }
          }),
        ],
      }
    } catch {
      return { type: 'json' as const, value: output }
    }
  }
  const datasetTool = tool({
    toModelOutput: datasetToModelOutput,
    description:
      'ADMIN, READ-ONLY: browse the studio\'s dataset/buckets system (the admin dataset page). List folders and buckets, pull bucket images into this conversation (their URLs become usable in edit_image and create_media), and search generations — the first 8 image results attach as previews so you pick BY EYE. All CHANGES (creating buckets/folders, filing images, training marks) go through dataset_edit, which always pauses for approval.',
    inputSchema: jsonSchema<{ action: string; bucket?: string; folder?: string; query?: string; model?: string; marked?: boolean; limit?: number }>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_buckets', 'list_folders', 'bucket_images', 'search_images'],
          description: 'list_buckets/list_folders = browse the tree; bucket_images = pull a bucket\'s images into the conversation; search_images = find generations by prompt text/model/marked/bucket',
        },
        bucket: { type: 'string', description: 'Bucket name (fuzzy) or numeric id' },
        folder: { type: 'string', description: 'Folder name (fuzzy) or id' },
        query: { type: 'string', description: 'search_images: prompt text filter' },
        model: { type: 'string', description: 'search_images: model id filter' },
        marked: { type: 'boolean', description: 'search_images: filter by training mark' },
        limit: { type: 'number', description: 'Max images returned (default 20, max 40)' },
      },
      required: ['action'],
      additionalProperties: false,
    }),
    execute: (input) => executeDataset(input, ctx),
  })

  // dataset_edit NEVER gets execute — every dataset mutation pauses for
  // explicit approval (never budget-exempt). Executed in the approve route.
  const datasetEditTool = tool({
    description:
      'ADMIN: CHANGE the dataset/buckets system — create buckets/folders, add/remove generations, toggle training marks, move buckets. ALWAYS pauses for explicit user approval; state exactly what will change in your reply BEFORE calling. Use numeric image ids from dataset bucket_images/search_images results. Training EXPORT runs from the dataset page itself — prepare the bucket, then point the user at Export.',
    inputSchema: jsonSchema<{ action: string; bucket?: string; folder?: string; parent?: string; name?: string; description?: string; color?: string; marked?: boolean; image_ids?: number[] }>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_bucket', 'create_folder', 'add_to_bucket', 'remove_from_bucket', 'mark_training', 'move_bucket'],
          description: 'create_bucket/create_folder/move_bucket = organize the tree; add_to_bucket/remove_from_bucket = file generations; mark_training = toggle the training flag',
        },
        bucket: { type: 'string', description: 'Bucket name (fuzzy) or numeric id' },
        folder: { type: 'string', description: 'Folder name (fuzzy) or id; "root" for no folder in move_bucket' },
        parent: { type: 'string', description: 'create_folder: parent folder name/id' },
        name: { type: 'string', description: 'create_bucket / create_folder: the new name' },
        description: { type: 'string', description: 'create_bucket: optional description' },
        color: { type: 'string', description: 'create_bucket: optional hex color' },
        marked: { type: 'boolean', description: 'mark_training: the value to set (default true)' },
        image_ids: { type: 'array', items: { type: 'number' }, description: 'add/remove/mark: numeric image ids' },
      },
      required: ['action'],
      additionalProperties: false,
    }),
  })
  const webSearchTool = tool({
    description: 'Search the live web for current information. Returns a grounded answer with source URLs.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: (input) => executeWebSearch(input, ctx),
  })
  const saveMemoryTool = tool({
    description: 'Persist PROJECT memory: durable notes shared by every chat in this project (full replacement, max 8000 chars). For account-wide facts that every chat should know (brand, voice, preferences), use remember instead. Current project memory is already in your context.',
    inputSchema: jsonSchema<{ content: string }>({
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    }),
    execute: (input) => executeSaveMemory(input, ctx),
  })
  const rememberTool = tool({
    description:
      'Append ONE short durable fact/preference to the user\'s ACCOUNT-WIDE memory (visible in every chat, editable by the user in the Memory panel). ≤500 chars, one fact per call. Use for durable cross-project knowledge (brand colors, voice, recurring preferences) — NOT run narration. Project-specific notes belong in save_memory.',
    inputSchema: jsonSchema<{ content: string; category?: string }>({
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember (≤500 chars)' },
        category: { type: 'string', description: 'Optional short label: brand, preference, character, fact, workflow…' },
      },
      required: ['content'],
      additionalProperties: false,
    }),
    execute: (input) => executeRemember(input, ctx),
  })

  // load_skill: pull a skill's full playbook into context mid-run. Free,
  // auto-executes everywhere — the summaries block teaches when to call it.
  const loadableSkills = AGENT_SKILLS.filter(s => skillOn(skills, s.id) && s.playbookTokens > 0).map(s => s.id)
  const loadSkillTool = tool({
    description:
      'Load the full playbook for an enabled skill into this conversation. Instant, free, no approval. ' +
      `Loadable skills: ${loadableSkills.join(', ')}. Load just before the work that needs it — ` +
      'the returned text stays in context for the rest of this reply. Never re-load one already returned.',
    inputSchema: jsonSchema<{ skill_id: string }>({
      type: 'object',
      properties: {
        skill_id: { type: 'string', enum: loadableSkills.length ? loadableSkills : ['none'], description: 'Skill whose playbook to load' },
      },
      required: ['skill_id'],
      additionalProperties: false,
    }),
    execute: async ({ skill_id }) => {
      if (!loadableSkills.includes(skill_id)) {
        return { error: `No playbook for '${skill_id}' — loadable skills: ${loadableSkills.join(', ') || '(none)'}` }
      }
      const pb = getPlaybook(skill_id, { skills })
      return pb ? { skill: skill_id, playbook: pb } : { error: `Playbook for '${skill_id}' is missing` }
    },
  })

  // publish_instagram NEVER gets execute — external + irreversible, the pause
  // IS the approval (never budget-exempt). Executed in the approve route.
  const publishInstagramTool = tool({
    description:
      'Publish an image or reel to the owner\'s connected Instagram professional account. ALWAYS pauses for explicit approval — never bypassed by plan budgets. Only call when the user asked to publish. Write the complete caption in your reply BEFORE calling so the approval card shows exactly what ships.',
    inputSchema: jsonSchema<{ media_type: 'image' | 'reel'; media_url: string; caption: string }>({
      type: 'object',
      properties: {
        media_type: { type: 'string', enum: ['image', 'reel'], description: 'image = feed post; reel = video' },
        media_url: { type: 'string', description: 'A media URL already in this conversation (generated or edited this chat). Images are auto-converted to JPEG and must end up between 4:5 and 1.91:1 aspect; reels are MP4, 9:16 recommended.' },
        caption: { type: 'string', description: 'The complete final caption incl. hashtags (≤2200 chars)' },
      },
      required: ['media_type', 'media_url', 'caption'],
      additionalProperties: false,
    }),
  })

  // edit_instructions NEVER gets execute — changing standing instructions or
  // saving presets always pauses for user approval regardless of mode
  const editInstructionsTool = tool({
    description:
      'Rewrite this chat\'s standing instructions (persona / system prompt), or save a reusable named ' +
      'instructions preset for the user. Always pauses for the user\'s approval. Show the proposed text ' +
      'in your reply before calling. Chat instruction changes apply from the next message onward.',
    inputSchema: jsonSchema<{ action: 'set_chat_instructions' | 'save_preset'; text: string; preset_name?: string }>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set_chat_instructions', 'save_preset'],
          description: 'set_chat_instructions replaces this chat\'s instructions; save_preset stores a named preset usable in any chat',
        },
        text: { type: 'string', description: 'The complete instructions text (max 4000 chars — full replacement, not a diff)' },
        preset_name: { type: 'string', description: 'Preset name (required for save_preset; reusing an existing name updates that preset)' },
      },
      required: ['action', 'text'],
      additionalProperties: false,
    }),
  })

  // ask_user NEVER gets execute — it renders a quiz in the approval bar and
  // resumes with the user's answers via the approve route
  const askUserTool = tool({
    description:
      'Ask the user a short multiple-choice quiz (1-4 questions, 2-6 short options each) to pin down ' +
      'requirements when the request is ambiguous and the answers materially change the output. ' +
      'Execution pauses until they answer. Use sparingly — never ask what you can infer.',
    inputSchema: jsonSchema<{ questions: { question: string; options: string[]; allow_multiple?: boolean }[] }>({
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1-4 questions, each with 2-6 short answer options',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, description: '2-6 short options' },
              allow_multiple: { type: 'boolean', description: 'Let the user pick more than one option' },
            },
            required: ['question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    }),
  })

  // propose_plan NEVER gets execute — the pause renders the plan card with the
  // summed ticket cost for one-tap approval (approve route applies the budget)
  const proposePlanTool = tool({
    description:
      'Propose a plan for one-tap user approval: summary, numbered steps, and ticket_budget. ' +
      'ticket_budget = the summed cost of the plan\'s create_media GENERATIONS ONLY, at their listed per-option prices. ' +
      'edit_image, AI masking, dataset, refs and text/shape work are FREE — a plan with no generations MUST set ticket_budget 0 ' +
      '(a 0-ticket approved plan still auto-runs every step; NEVER pad the budget to unlock auto-run). ' +
      'An update (is_update=true) requests only the ADDITIONAL tickets. ' +
      'Once approved, work within the plan runs automatically without per-call approvals. ' +
      'FAILED generations refund automatically and consume NONE of the budget — the create tool reports the live ledger (spent/remaining) after every result; trust it and retry failures within the approved amount instead of proposing an update. ' +
      'Call it again with is_update=true only when the plan genuinely changes or needs more tickets.',
    inputSchema: jsonSchema<{ summary: string; steps: string[]; ticket_budget: number; is_update?: boolean }>({
      type: 'object',
      properties: {
        summary: { type: 'string', description: '1-2 sentence summary of the plan (or of the change, for updates)' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Numbered steps — each: what happens, which model, estimated tickets (e.g. "Start frame — nano-banana-pro, ~7 tickets")',
        },
        ticket_budget: { type: 'number', description: 'Summed total tickets (new plan) or ADDITIONAL tickets requested (update)' },
        is_update: { type: 'boolean', description: 'true when modifying or extending an already-approved plan' },
      },
      required: ['summary', 'steps', 'ticket_budget'],
      additionalProperties: false,
    }),
  })

  const executingDelegate = tool({
    description: delegateDescription,
    inputSchema: delegateSchema,
    execute: (input) => executeDelegateTask(input, ctx),
  })
  const executingEditImage = tool({
    description: editImageDescription,
    inputSchema: editImageSchema,
    toModelOutput: mediaToModelOutput,
    execute: async (input) => {
      const out = await executeEditImage(input, ctx)
      if ('imageUrl' in out) {
        ctx.generatedUrls.push(out.imageUrl)
        ctx.allowedImages.add(out.imageUrl)
      }
      return out
    },
  })

  // record_evaluation: structured image verdicts — renders as a dedicated
  // evaluation card in the UI instead of burying critiques in reply text
  // ONE rubric, two enforcers: the orchestrator's provisional sweep AND the
  // independent fresh-eyes judge inspect against this exact list
  const EVAL_SWEEP_RUBRIC = 'HARD AUTO-FAILS — the verdict MUST be revise if ANY of these appear, no matter how good everything else is: (a) any text overlapping or touching other text, or text clipped by an element/edge; (b) a visible straight cutout edge or rectangular paste border around a subject (raw photo box instead of a clean cutout); (c) LEFTOVER SPACE — audit all four quadrants: a quadrant of bare background that no subject mass, type block, or eye-path element touches or frames is leftover, not negative space (deliberate minimal layouts pass ONLY when the space is shaped by a strong anchor and the eye path crosses it); (d) any text too small or low-contrast to read; (e) subjects crammed into one corner of an otherwise bare canvas; (f) a cutout\'s flat side floating SHORT of the canvas edge instead of pressed onto it; (g) a subject\'s face/gaze aimed out of the frame while the composition\'s open space sits on the opposite side (mirror the overlay with flip instead); (h) one subject colliding with or covering another subject\'s face/head — overlap is only acceptable as deliberate depth staging with both faces fully visible; (i) a TRUNCATED edge of one subject lying ON TOP of another subject (a cut-off shoulder/arm covering an intact body reads as a sticker slapped over a person — the COMPLETE subject belongs in front, the truncated edge tucks BEHIND it or off-canvas); (j) UNMOTIVATED head-scale mismatch — heads are the unit of scale; same-depth subjects must match within ~10%, while perspective scenes SHOULD scale heads by distance — fail only when the sizes disagree with the composition\'s depth story (smaller head but same plane, no overlap/placement cues selling distance); (k) a graphic occluding a subject\'s HIGH-VALUE zones — face, eyes, expression, or the identity-defining hair silhouette — or careless amputation of them; strategic peripheral interleaving (a divider behind the subject, a bar clipping an outer shoulder edge to integrate the layout) is GOOD design and passes; (l) an UNMOTIVATED effect — decoration that does not belong to the concept\'s world (a starfield on a non-space brief, random particles, an off-theme texture): every effect must be justified by the brief; (m) a subject substantially OFF-CANVAS — more than ~40% of a subject cropped away by the canvas edge without deliberate bleed intent, or the subject\'s face/torso pushed off-frame (declaring bleed:true does NOT exempt a subject from this check); (n) BRIEF INFIDELITY — the composition ignores the brief\'s stated hierarchy: the requested main subjects are not the dominant elements (wrong star of the show), or a required element is missing/marginal; (o) WARPED SUBJECT — a person visibly stretched or squashed off natural proportions (non-uniform scaling to fill a cell/space): compare face/body proportions against the source — fill mismatched cells by CROPPING to the cell\'s aspect, never by squashing the person. FOR COMPOSITES pass reference_urls (the source images used) — the result and sources come back attached for verification; evaluating a composite without its sources in view is not an evaluation. SWEEP FORMAT — your notes MUST OPEN with the full sweep, every letter a-o: "Sweep: a-clear b-clear c-FAIL(bottom third empty) …". MEASURED EVIDENCE, NOT ADJECTIVES: cite numbers — each head\'s pixel height, margin sizes, the exact coordinates where any graphic crosses a body, which cut edge sits where and what covers it (trace every subject outline end to end). For (i) specifically, the sweep line must LIST each subject\'s missing parts and the actual stack order — e.g. "i: A missing R shoulder, ON TOP of B (intact) = FAIL, restack B in front" — checking (i) without the inventory is not checking it. When BOTH subjects are cut, rank by severity: the bigger cut may not sit in front of the smaller one (a missing shoulder never fronts a clipped bicep). Matching outfits camouflage cuts — trace each outline separately; camouflage is not integration. "Looks balanced" is not an evaluation; "left head 340px vs right head 280px = 21% mismatch, j-FAIL" is. DEFAULT TO REVISE: a pass requires positive measured evidence in every category — when uncertain, revise. An elite retoucher rejects most first drafts; a first-attempt pass should be the exception. Any FAIL ⇒ verdict revise with the exact fix (restack order, new x/y/width, flip, trim, reroute the graphic) — NEVER by covering the problem with a new graphic: concealment is itself a fail.'
  // NOTE: the FULL rubric (EVAL_SWEEP_RUBRIC) is enforced by the independent
  // judge — the tool description stays COMPACT (Gemini rejects requests when
  // function declarations grow too large; the inlined rubric broke sends).
  // Independent judge is OPT-IN via CHAT_EVAL_JUDGE=on (.env.local) — the
  // user parked it for now; self-evaluation is the gate while it's off
  const judgeOn = process.env.CHAT_EVAL_JUDGE === 'on'
  const recordEvaluationTool = tool({
    description:
      'Record your evaluation of a generated/edited image as a structured verdict. MANDATORY after every image result, BEFORE any dependent step. '
      + (judgeOn
        ? 'YOUR VERDICT IS PROVISIONAL: an independent fresh-eyes judge re-inspects the image (and sources) against the full studio rubric and ITS verdict is what gets recorded — submit your honest sweep anyway. '
        : 'YOUR SWEEP IS THE GATE — nothing else re-checks the image, so run it with full rigor against the attached pixels. ')
      + 'Open your notes with the auto-fail sweep, every letter a-o with MEASURED evidence (numbers, not adjectives): '
      + '(a) text on text/clipped; (b) raw box-paste edge; (c) leftover space (quadrant audit); (d) illegible text; (e) corner cramming; '
      + '(f) flat side floating short of the edge; (g) gaze aimed out of frame; (h) a subject covering another\'s face; '
      + '(i) truncated edge on top of a subject — list each subject\'s missing parts + the stack order; (j) unmotivated head-scale mismatch; '
      + '(k) graphic over face/eyes/hair-silhouette; (l) unmotivated effect (off-theme starfield etc.); (m) subject >40% off-canvas; '
      + '(n) brief infidelity (wrong star of the show); (o) warped/stretched person. '
      + 'DEFAULT TO REVISE — a pass needs positive evidence; re-evaluations after fix passes keep FULL strictness. '
      + 'For composites, reference_urls (the sources used) is REQUIRED — result + sources re-attach for verification. '
      + 'Fixes correct geometry (restack/reposition/flip/trim) — NEVER conceal a flaw with a new graphic.',
    inputSchema: jsonSchema<{ image_url: string; verdict: 'pass' | 'revise'; notes: string; reference_urls?: string[] }>({
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'The image being evaluated (URL from this conversation)' },
        verdict: { type: 'string', enum: ['pass', 'revise'], description: 'pass = good enough to build on; revise = regenerate/fix first' },
        notes: { type: 'string', description: 'The sweep + measured evidence, then what to change if revising' },
        reference_urls: { type: 'array', items: { type: 'string' }, description: 'REQUIRED for composites: the SOURCE images the piece was built from (bucket originals, cutouts) — the tool re-attaches them beside the result so you can verify identity and completeness against what the sources actually contain' },
      },
      required: ['image_url', 'verdict', 'notes'],
      additionalProperties: false,
    }),
    // Attach the evaluated image + sources to the tool result — the verdict
    // gets checked against ACTUAL pixels, not memory of them
    toModelOutput: ({ output }: { output: any }) => {
      const urls: string[] = Array.isArray(output?.attach) ? output.attach : []
      const files = urls
        .filter(u => typeof u === 'string' && /^https:\/\//.test(u) && !/\.(mp4|webm|mov)(\?|$)/i.test(u))
        .slice(0, 4)
        .map(u => ({
          type: 'file' as const,
          data: { type: 'url' as const, url: new URL(u) },
          mediaType: /\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : 'image/jpeg',
        }))
      if (!files.length) return { type: 'json' as const, value: { noted: output?.noted, note: output?.note } }
      return {
        type: 'content' as const,
        value: [{ type: 'text' as const, text: JSON.stringify({ noted: output?.noted, note: output?.note }) }, ...files],
      }
    },
    execute: async (input) => {
      const refs = Array.isArray(input.reference_urls)
        ? input.reference_urls.filter(u => typeof u === 'string' && ctx.allowedImages.has(u)).slice(0, 3)
        : []
      const attach = [
        ...(ctx.allowedImages.has(input.image_url) ? [input.image_url] : []),
        ...refs,
      ]
      const selfVerdict = input.verdict === 'pass' ? 'PASS' : 'REVISE'
      // INDEPENDENT JUDGE: a fresh-context vision model re-runs the sweep on
      // the actual pixels — no context fatigue, no sunk-cost bias, zero
      // investment in the piece passing. Its verdict is final; the
      // orchestrator's self-verdict is the fallback if the judge is
      // unavailable (no key, delegate error).
      let judge: { verdict: 'pass' | 'revise'; report: string; model: string } | null = null
      if (attach.length && judgeOn) {
        try {
          const prefs = ['gemini-3.1-pro', 'gemini-3-pro', 'fable', 'opus', 'sonnet', 'gpt-5']
          const judgeModel =
            prefs.map(p => ctx.roster.find(r => r.id.toLowerCase().includes(p))).find(Boolean)?.id
            ?? ctx.roster[0]?.id
          if (judgeModel) {
            const out = await executeDelegateTask(
              {
                model: judgeModel,
                task:
                  'You are the studio\'s INDEPENDENT image judge — fresh eyes, zero investment in this piece passing, maximally strict. '
                  + 'Image 1 is the piece under evaluation; any further images are the SOURCES it was built from (verify identity and completeness against them — what does each source contain vs what survived into the composite?). Inspection rubric:\n'
                  + EVAL_SWEEP_RUBRIC
                  + `\n\nThe creator claims verdict "${selfVerdict}" with notes: "${String(input.notes ?? '').slice(0, 500)}". Do NOT defer to the claim — verify with your own eyes.`
                  + '\nREPLY FORMAT: first line EXACTLY "VERDICT: PASS" or "VERDICT: REVISE", then the full sweep with measured evidence, then the exact fixes if revising.',
                image_urls: attach,
              },
              { roster: ctx.roster, routes: ctx.routes, userKeys: ctx.userKeys, allowedImages: ctx.allowedImages },
            )
            if (out && 'answer' in out && typeof (out as any).answer === 'string') {
              const ans = String((out as any).answer)
              const v = /VERDICT:\s*REVISE/i.test(ans) ? ('revise' as const)
                : /VERDICT:\s*PASS/i.test(ans) ? ('pass' as const) : null
              if (v) judge = { verdict: v, report: ans.replace(/^\s*VERDICT:[^\n]*\n?/i, '').trim().slice(0, 1600), model: judgeModel }
            }
          }
        } catch {}
      }
      const finalVerdict = judge?.verdict ?? input.verdict
      const overrode = judge !== null && judge.verdict !== input.verdict
      return {
        noted: true,
        note: `${finalVerdict === 'pass' ? 'PASS' : 'REVISE'} — `
          + (judge
            ? `INDEPENDENT JUDGE (${judge.model})${overrode ? ` OVERRODE your ${selfVerdict}` : ' concurs'}: ${judge.report}`
            : String(input.notes ?? '').slice(0, 1500))
          + (attach.length > 1 ? ' The evaluated image and its SOURCES are attached below in that order.' : '')
          + (finalVerdict === 'revise' ? ' Apply the exact fixes in a fix pass, then evaluate again.' : ''),
        attach,
      }
    },
  })

  // write_summary: the run's closing summary as a structured unit — the UI
  // renders it as a dedicated Summary card at the BOTTOM of the reply
  const writeSummaryTool = tool({
    description:
      'Deliver the final run summary. Call this LAST, after every step is complete — it renders as the dedicated Summary card at the bottom of the reply. 3-6 plain sentences: what you did, what was produced, models used, total tickets spent, and 1-2 next options. Do NOT also write the summary as normal reply text.',
    inputSchema: jsonSchema<{ summary: string }>({
      type: 'object',
      properties: { summary: { type: 'string', description: 'The complete summary text (markdown ok, no headers)' } },
      required: ['summary'],
      additionalProperties: false,
    }),
    execute: async () => ({ noted: true, note: 'Summary recorded — it is displayed to the user as the closing card.' }),
  })

  // Core tools always register; skill-gated tools only when their skill is on
  const alwaysOn: ToolSet = {
    edit_instructions: editInstructionsTool, ask_user: askUserTool, propose_plan: proposePlanTool,
    record_evaluation: recordEvaluationTool, write_summary: writeSummaryTool,
    ...(loadableSkills.length ? { load_skill: loadSkillTool } : {}),
    ...(skillOn(skills, 'reference-library') ? { search_refs: searchRefsTool } : {}),
    ...(ctx.isAdmin && skillOn(skills, 'dataset-ops') ? { dataset: datasetTool, dataset_edit: datasetEditTool } : {}),
    ...(skillOn(skills, 'web-research') ? { web_search: webSearchTool } : {}),
    ...(skillOn(skills, 'project-memory') ? { save_memory: saveMemoryTool, remember: rememberTool } : {}),
    ...(skillOn(skills, 'instagram-publishing') ? { publish_instagram: publishInstagramTool } : {}),
  }
  const delegationOn = skillOn(skills, 'delegation')

  if (ctx.mode === 'accept') {
    return {
      // An approved plan budget lifts the Ask-mode pauses — the user already
      // approved this work as part of the plan
      ...(delegationOn ? {
        delegate_task: budgetActive
          ? executingDelegate
          : tool({ description: delegateDescription, inputSchema: delegateSchema }),
      } : {}),
      ...(mediaOn ? { create_media: createMediaTool } : {}),
      ...(editToolOn ? {
        edit_image: (budgetActive || ctx.autoApproveEdits)
          ? executingEditImage
          : tool({ description: editImageDescription, inputSchema: editImageSchema }),
      } : {}),
      ...alwaysOn,
    }
  }

  return {
    ...(delegationOn ? { delegate_task: executingDelegate } : {}),
    ...(mediaOn ? { create_media: createMediaTool } : {}),
    ...(editToolOn ? { edit_image: executingEditImage } : {}),
    ...alwaysOn,
  }
}

// Weak models sometimes narrate work ("sending to the render engines now!",
// "I will build the full layout now", fake media URLs) without ever calling a
// tool — the reply then just STOPS. Detect announced-but-unexecuted work so
// the driver can force a corrective pass that actually executes.
export function looksLikePhantomMediaClaim(text: string): boolean {
  if (!text.trim()) return false
  if (/fal\.media|\.r2\.dev|https?:\/\/\S+\.(png|jpe?g|webp|mp4|webm)/i.test(text)) return true
  return /(sending|submitt\w*|initiat\w*|queu\w*|dispatch\w*|kick\w* off)[^.\n]{0,60}(render|engine|generat|model)|render engines? now|(generat|render|creat|build|edit|composit|isolat|appl)\w*[^.\n]{0,40}\b(now|right away|as we speak)\b|(images?|videos?|assets?|layouts?|edits?)[^.\n]{0,30}(are|is) being (generated|rendered|created|built|composited)|\b(i(?:'ll| will| am going to|'m about to)|let me|proceeding to)\b[^.\n]{0,80}\b(build|creat|generat|render|edit|composit|isolat|overlay|appl|execut)\w*[^.\n]{0,60}(!|\.|$)/i.test(text)
}

// ── NDJSON event stream driver (shared by send + approve) ──────────────────
// The Response is returned IMMEDIATELY; `begin` runs inside the stream so any
// pre-work (approve route: executing approved tool calls) emits live events
// instead of blocking the response. Draining continues in a detached task so
// persistence happens even if the client aborts (enqueue throws swallowed).
// The caller's `finalize` does the DB write and returns the messageId.

export function agentStreamResponse(opts: {
  agentMode: AgentMode
  seedSteps?: AgentStep[]
  // Live check for an approved plan budget — tools inside the budget execute
  // inline, so they must NOT be marked pending (the budget can appear mid-run
  // when a propose_plan approval executes in `begin`)
  isBudgetActive?: () => boolean
  // "Don't ask again for edits this run" — edit_image calls execute inline
  editsAutoApproved?: () => boolean
  // Which text-segment round this stream writes (0 = initial send; approval
  // continuations pass the prior segment count) — stamped on new steps
  segIndex?: number
  // Do pre-work (emitting events / mutating the shared steps map), then return
  // the streamText fullStream to drain — or null to finish without one.
  begin: (send: (e: StreamEvent) => void, steps: Map<string, AgentStep>) => Promise<AsyncIterable<any> | null>
  // Phantom-media guard: called once when the reply claimed media work but
  // made zero tool calls — returns a corrective fullStream to drain (or null).
  retryIfPhantom?: (textSoFar: string) => Promise<AsyncIterable<any> | null>
  // Empty-reply guard: called once when the stream produced NO visible output
  // (no text, no non-reasoning steps, nothing pending) — some models think for
  // a while and then just stop. Returns a corrective fullStream (or null).
  retryIfEmpty?: () => Promise<AsyncIterable<any> | null>
  // Plan-completion guard: called once when the stream ended with nothing
  // pending — the route decides (e.g. unspent plan budget ⇒ model stopped
  // mid-plan or wrote its summary early) and returns a continuation stream.
  retryIfIncomplete?: (textSoFar: string) => Promise<AsyncIterable<any> | null>
  // `errored` = the stream emitted an error part or threw — callers persist a
  // visible failure stub instead of leaving a dangling user message (which the
  // reload-reconnect logic would read as "still generating").
  // `elapsedMs` = wall-clock runtime of THIS stream — callers accumulate it
  // into metadata.runMs for the reply's total-run stopwatch.
  finalize: (o: { text: string; steps: AgentStep[]; pending: PendingCall[]; errored: boolean; canceled: boolean; elapsedMs: number }) => Promise<number | null>
  // User-initiated cancel: checked between stream parts. When it flips true,
  // any tool already executing FINISHES, then consumption stops — no further
  // model rounds, and finalize receives canceled: true.
  isCanceled?: () => boolean
  // Idle-watchdog override (ms) — local Ollama models need a longer leash
  idleMs?: number
  // Live-progress hook (throttled ~2s): routes persist this state so a page
  // that reloads mid-run can keep rendering the reply as it happens instead
  // of waiting for the final row. Fire-and-forget — must never throw.
  onProgress?: (o: { text: string; steps: AgentStep[] }) => void
}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let onEvent: (() => void) | null = null
      const send = (e: StreamEvent) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')) } catch {}
        // Pings schedule progress too — liveRun.updatedAt must stay fresh
        // during long silent tool calls or reconnected clients give up
        try { onEvent?.() } catch {}
      }
      ;(async () => {
        const runStartedAt = Date.now()
        const steps = new Map<string, AgentStep>((opts.seedSteps ?? []).map(s => [s.id, s]))
        const startedAt = new Map<string, number>()
        const pending: PendingCall[] = []
        let text = ''
        let hadError = false
        let wasCanceled = false
        // First moment a cancel request was OBSERVED — after a 12s grace the
        // run ends even if a tool is still executing (the old behavior waited
        // for the tool, so a minutes-long edit chain ignored Stop entirely)
        let cancelSeenAt: number | null = null
        // Throttled live-progress mirror (survives client disconnects)
        let progAt = 0
        let progTimer: ReturnType<typeof setTimeout> | null = null
        const fireProgress = () => {
          progAt = Date.now()
          try { opts.onProgress?.({ text, steps: [...steps.values()] }) } catch {}
        }
        if (opts.onProgress) {
          onEvent = () => {
            const since = Date.now() - progAt
            if (since >= 2000) { fireProgress(); return }
            if (!progTimer) progTimer = setTimeout(() => { progTimer = null; fireProgress() }, 2000 - since)
          }
        }
        // Heartbeat: NDJSON pings every 20s so the client can tell a slow
        // tool call (silent but alive) from a dead connection (Safari over
        // LAN IPs drops streams without surfacing an error — the composer
        // then waits forever until a manual refresh)
        const heartbeat = setInterval(() => send({ t: 'ping' }), 20_000)
        try {
          // Reasoning ("thinking") streams render as collapsible cards — ONE
          // CARD PER BLOCK (unique counter id: providers reuse part.id across
          // blocks, which collapsed every thought into the first card and made
          // it "move around"), updated in chunks to avoid event spam
          let reasonBuf = ''
          let reasonId: string | null = null
          let reasonSent = 0
          let reasonCount = 0
          const flushReasoning = (final: boolean) => {
            if (!reasonId) return
            const s = steps.get(reasonId)
            if (!s) return
            s.resultPreview = reasonBuf.slice(0, 4000) || undefined
            if (final) {
              s.status = 'done'
              const t0 = startedAt.get(reasonId)
              if (t0) s.ms = Date.now() - t0
            }
            send({ t: 'step', s: { ...s } })
            reasonSent = reasonBuf.length
          }

          // Watchdog: abort a stream that goes silent — a hung upstream request
          // otherwise leaves the user staring at "Thinking…" forever. Long
          // silences are legitimate while a slow tool (video gen, delegation)
          // is executing, so the idle limit stretches when one is running.
          // Local models (Ollama) get a longer leash — cold loads + prompt
          // evaluation of a 16k context on local hardware can be silent for
          // minutes before the first token
          const IDLE_MS = opts.idleMs ?? 180_000        // 3 min of true silence = dead
          const IDLE_TOOL_MS = Math.max(480_000, IDLE_MS)   // while a tool call is in flight
          const drain = async (stream: AsyncIterable<any>) => {
          const it = stream[Symbol.asyncIterator]()
          // The pending it.next() survives race ticks — re-calling next()
          // after an abandoned race would pull and silently DROP a part
          let pendingNext: Promise<IteratorResult<any>> | null = null
          let lastPartAt = Date.now()
          while (true) {
            const toolRunning = [...steps.values()].some(s =>
              s.status === 'running' && s.tool !== 'reasoning')
            if (!pendingNext) pendingNext = it.next()
            let th: ReturnType<typeof setTimeout> | undefined
            const winner = await Promise.race([
              pendingNext,
              new Promise<'tick'>(res => { th = setTimeout(() => res('tick'), 1500) }),
            ])
            clearTimeout(th)
            if (winner === 'tick') {
              // No part this tick (usually a slow tool executing). Cancel is
              // enforced HERE too: 12s after the request the in-flight step
              // is abandoned and the run winds down as canceled.
              if (opts.isCanceled?.() && !wasCanceled) {
                if (cancelSeenAt === null) cancelSeenAt = Date.now()
                else if (Date.now() - cancelSeenAt > 12_000) {
                  wasCanceled = true
                  try { await it.return?.(undefined) } catch {}
                  break
                }
              }
              const idleLimit = toolRunning ? IDLE_TOOL_MS : IDLE_MS
              if (Date.now() - lastPartAt > idleLimit) {
                hadError = true
                console.error('chat-hub stream watchdog: no output for', idleLimit, 'ms — aborting')
                send({ t: 'error', message: 'The model stopped responding — run aborted. Send again or retry with another model (↺).' })
                try { await it.return?.(undefined) } catch {}
                break
              }
              continue
            }
            pendingNext = null
            if (winner.done) break
            lastPartAt = Date.now()
            const part = winner.value
            switch (part.type) {
              case 'text-delta':
                text += part.text
                send({ t: 'text', d: part.text })
                break
              case 'reasoning-start': {
                if (reasonId) flushReasoning(true) // close a dangling block
                reasonId = `reason-${opts.segIndex ?? 0}-${reasonCount++}`
                reasonBuf = ''
                reasonSent = 0
                const s: AgentStep = {
                  id: reasonId, tool: 'reasoning', status: 'running',
                  seg: opts.segIndex ?? 0,
                  textAt: text.length,
                  ...(text.trim() ? {} : { preText: true }),
                }
                steps.set(s.id, s)
                startedAt.set(s.id, Date.now())
                send({ t: 'step', s: { ...s } })
                break
              }
              case 'reasoning-delta':
                if (reasonId) {
                  reasonBuf += String(part.text ?? '')
                  if (reasonBuf.length - reasonSent > 600) flushReasoning(false)
                }
                break
              case 'reasoning-end':
                flushReasoning(true)
                reasonId = null
                break
              case 'tool-call': {
                const input = (part.input ?? {}) as Record<string, unknown>
                // Once write_summary has been called, the run is OVER — a
                // late propose_plan must not open a new approval card on a
                // summarized reply (it resurrects "approve?" after "done")
                if (part.toolName === 'propose_plan'
                    && [...steps.values()].some(x => x.tool === 'write_summary')) {
                  const s: AgentStep = {
                    id: part.toolCallId,
                    tool: 'propose_plan',
                    status: 'error',
                    seg: opts.segIndex ?? 0,
                    task: typeof input.summary === 'string' ? String(input.summary).slice(0, 300) : undefined,
                    error: 'Rejected: this reply is already summarized — no new plans after write_summary. If more work is needed, the user can send a new message.',
                  }
                  steps.set(s.id, s)
                  send({ t: 'step', s: { ...s } })
                  break
                }
                const pauses = toolPausesForApproval(part.toolName, opts.agentMode, opts.isBudgetActive?.() ?? false)
                  && !(part.toolName === 'edit_image' && (opts.editsAutoApproved?.() ?? false))
                const s: AgentStep = {
                  id: part.toolCallId,
                  tool: part.toolName as AgentStep['tool'],
                  status: pauses ? 'pending' : 'running',
                  seg: opts.segIndex ?? 0,
                  textAt: text.length,
                  // Chronology marker: tools called before any text render
                  // ABOVE the round's text in the UI
                  ...(text.trim() ? {} : { preText: true }),
                  model: typeof input.model === 'string' ? input.model : undefined,
                  task: typeof input.task === 'string' ? input.task
                    : typeof input.skill_id === 'string' ? input.skill_id
                    : typeof input.summary === 'string' ? String(input.summary).slice(0, 300)
                    : typeof input.query === 'string' ? input.query
                    : typeof input.folder === 'string' ? `folder: ${input.folder}`
                    : typeof input.text === 'string' ? String(input.text).slice(0, 300)
                    : typeof input.notes === 'string' ? String(input.notes).slice(0, 300)
                    : typeof input.content === 'string' ? String(input.content).slice(0, 300)
                    : Array.isArray(input.operations) ? (input.operations as any[]).map(o => o?.op).join(' → ')
                    : Array.isArray(input.questions) ? (input.questions as any[]).map(q => q?.question).filter(Boolean).join(' | ').slice(0, 300)
                    : undefined,
                  prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
                }
                if (part.toolName === 'create_media' && typeof input.model === 'string') {
                  const spec = getCreateModel(input.model)
                  if (spec) {
                    s.kind = spec.kind
                    s.settings = resolveCreateSettings(spec, input.settings)
                    s.cost = computeCreateCost(spec, s.settings)
                  }
                  // References the model NAMED in the call — replaced by the
                  // actually-used set (incl. attached-refs fallback) on result
                  if (Array.isArray(input.reference_image_urls)) {
                    s.refs = (input.reference_image_urls as unknown[])
                      .filter((u): u is string => typeof u === 'string')
                      .slice(0, 12)
                  }
                }
                if (part.toolName === 'propose_plan' && typeof input.ticket_budget === 'number') {
                  s.cost = Math.max(0, Math.round(input.ticket_budget))
                }
                if ((part.toolName === 'dataset' || part.toolName === 'dataset_edit') && typeof input.action === 'string') {
                  // Human-readable target so the step card says WHAT it browsed
                  // ("bucket images · Carrie Fisher"), not just "the dataset"
                  const target = [input.bucket, input.folder, input.name, input.query]
                    .find(v => typeof v === 'string' && (v as string).trim())
                  s.task = String(input.action).replace(/_/g, ' ')
                    + (target ? ` · ${String(target).slice(0, 60)}` : '')
                }
                if (part.toolName === 'record_evaluation' && typeof input.image_url === 'string') {
                  // Stamp the judged URL so the UI can tie verdicts to edits
                  // (supersede logic hides only REVISE-judged attempts)
                  s.imageUrl = String(input.image_url)
                }
                if (part.toolName === 'edit_image' && Array.isArray(input.operations)) {
                  // Keep the full layer recipe so the viewer can re-edit it
                  s.editRecipe = {
                    ...(typeof input.image_url === 'string' ? { image_url: input.image_url } : {}),
                    ...(input.canvas && typeof input.canvas === 'object' ? { canvas: input.canvas as any } : {}),
                    operations: input.operations as unknown[],
                  }
                }
                steps.set(s.id, s)
                startedAt.set(s.id, Date.now())
                send({ t: 'step', s })
                if (pauses) {
                  pending.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
                }
                break
              }
              case 'tool-result': {
                const s = steps.get(part.toolCallId)
                if (!s) break
                const out = (part.output ?? {}) as Record<string, unknown>
                if (out.error) {
                  s.status = 'error'
                  s.error = String(out.error).slice(0, 500)
                } else {
                  s.status = 'done'
                  s.resultPreview = String(out.answer ?? out.note ?? '').slice(0, 4000) || undefined
                  if (typeof out.imageUrl === 'string') s.imageUrl = out.imageUrl
                  if (typeof out.mediaUrl === 'string') s.imageUrl = out.mediaUrl
                  // create_media reports which references it ACTUALLY used
                  if (Array.isArray(out.referenceImageUrls)) {
                    s.refs = (out.referenceImageUrls as unknown[])
                      .filter((u): u is string => typeof u === 'string')
                      .slice(0, 12)
                  }
                }
                const t0 = startedAt.get(part.toolCallId)
                if (t0) s.ms = Date.now() - t0
                send({ t: 'step', s })
                break
              }
              case 'error': {
                console.error('chat-hub agent stream part error:', part.error)
                hadError = true
                // Surface the REAL provider error (truncated) — "check the
                // model/key" hid actionable details like schema rejections
                const detail = (() => {
                  const e = part.error as { message?: string; responseBody?: string } | string | undefined
                  const raw = typeof e === 'string' ? e : (e?.responseBody || e?.message || '')
                  return String(raw).replace(/\s+/g, ' ').slice(0, 280)
                })()
                send({ t: 'error', message: detail ? `Generation error: ${detail}` : 'Generation error — check the model/key and try again' })
                break
              }
            }
            // Graceful user cancel: any tool already in flight finishes (its
            // result arrives on later parts, which we keep consuming while
            // busy) — once nothing is running, stop: no further model rounds
            if (opts.isCanceled?.() && !wasCanceled) {
              const busy = [...steps.values()].some(s => s.status === 'running' && s.tool !== 'reasoning')
              if (!busy) {
                wasCanceled = true
                try { await it.return?.(undefined) } catch {}
                break
              } else if (cancelSeenAt === null) {
                cancelSeenAt = Date.now()
              }
            }
          }
          }

          const fullStream = await opts.begin(send, steps)
          if (fullStream) await drain(fullStream)

          // The model announced media work but called no tools: one forced
          // corrective pass that must actually execute (weak models narrate
          // "sending to the render engines now!" instead of calling tools).
          // Reasoning cards aren't actions — guards compare real tool activity
          const actionSteps = () => [...steps.values()].filter(s => s.tool !== 'reasoning').length
          const seedActions = (opts.seedSteps ?? []).filter(s => s.tool !== 'reasoning').length
          // Fires on (a) announced-but-unexecuted media claims, and (b) the
          // small-model flail: load playbooks / browse around, then simply
          // stop — no actual work, no closing question. One corrective push.
          const GATHER_TOOLS = new Set(['load_skill', 'search_refs', 'dataset', 'reasoning'])
          const seedIds = new Set((opts.seedSteps ?? []).map(x => x.id))
          const newSteps = [...steps.values()].filter(s => !seedIds.has(s.id))
          const gatherFlail = newSteps.some(s => s.tool === 'load_skill')
            && newSteps.every(s => GATHER_TOOLS.has(s.tool))
            && !!text.trim()
            && !/[?？][\s*_)"']*$/.test(text.trim().slice(-40))
          if (
            opts.retryIfPhantom && fullStream && !wasCanceled
            && pending.length === 0
            && ((actionSteps() === seedActions && looksLikePhantomMediaClaim(text)) || gatherFlail)
          ) {
            const second = await opts.retryIfPhantom(text)
            if (second) {
              send({ t: 'text', d: '\n\n' })
              text += '\n\n'
              await drain(second)
            }
          }

          // Empty-reply guard: reasoning-only turns render as a lone
          // "Thought it through" card with nothing else — push the model to
          // actually answer (once).
          if (opts.retryIfEmpty && fullStream && pending.length === 0 && !hadError && !wasCanceled
              && !text.trim()
              && ![...steps.values()].some(s => s.tool !== 'reasoning')) {
            const answer = await opts.retryIfEmpty()
            if (answer) await drain(answer)
          }

          // Turn ended with nothing pending — if the route judges the plan
          // unfinished (unspent budget), push one continuation to keep going
          // or explicitly confirm completion. NEVER after write_summary: a
          // summarized run is DONE — pushing it again made models invent
          // bonus generations to "use up" leftover budget.
          if (opts.retryIfIncomplete && fullStream && pending.length === 0 && !wasCanceled
              && ![...steps.values()].some(s => s.tool === 'write_summary' && s.status === 'done')) {
            const more = await opts.retryIfIncomplete(text)
            if (more) {
              send({ t: 'text', d: '\n\n' })
              text += '\n\n'
              await drain(more)
            }
          }

          // Stop live-progress writes BEFORE finalize — a late throttled
          // write racing the final row update could resurrect stale state
          onEvent = null
          if (progTimer) { clearTimeout(progTimer); progTimer = null }
          const messageId = await opts.finalize({
            text, steps: [...steps.values()], pending, errored: hadError, canceled: wasCanceled,
            elapsedMs: Date.now() - runStartedAt,
          })
          if (pending.length > 0 && messageId) {
            send({ t: 'approval', messageId, calls: pending })
          }
          send({ t: 'done', messageId })
        } catch (err) {
          console.error('chat-hub agent stream error:', err)
          send({ t: 'error', message: 'Generation failed' })
          onEvent = null
          if (progTimer) { clearTimeout(progTimer); progTimer = null }
          try {
            await opts.finalize({
              text, steps: [...steps.values()], pending, errored: true, canceled: wasCanceled,
              elapsedMs: Date.now() - runStartedAt,
            })
          } catch {}
        } finally {
          if (progTimer) clearTimeout(progTimer)
          clearInterval(heartbeat)
          try { controller.close() } catch {}
        }
      })()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

// ── Auto-compaction ─────────────────────────────────────────────────────────
// When a chat outgrows the history window, summarize the messages that fell
// out of it into Chat.memorySummary (merged with the previous summary). Runs
// fire-and-forget after a send; the summary is injected into instructions on
// subsequent turns, so the model keeps long-term context without re-sending
// the whole transcript.
const COMPACT_WINDOW = 40   // matches HISTORY_WINDOW in the send route
const COMPACT_KEEP = 30     // newest messages never summarized (still in window)

export async function maybeCompactChat(opts: {
  chatId: number
  memorySummary: string | null
  summaryUpToId: number | null
  userKeys: Record<string, string>
  routes: RoutingMap
  fallbackModelId: string
}): Promise<void> {
  try {
    const total = await prisma.chatMessage.count({ where: { chatId: opts.chatId } })
    if (total <= COMPACT_WINDOW) return

    const recent = await prisma.chatMessage.findMany({
      where: { chatId: opts.chatId },
      orderBy: { id: 'desc' },
      take: COMPACT_KEEP,
      select: { id: true },
    })
    const cutoff = recent[recent.length - 1]?.id ?? 0
    const olds = await prisma.chatMessage.findMany({
      where: { chatId: opts.chatId, id: { lt: cutoff, gt: opts.summaryUpToId ?? 0 } },
      orderBy: { id: 'asc' },
      take: 60,
      select: { id: true, role: true, content: true },
    })
    if (olds.length < 8) return // compact in worthwhile chunks

    // Cheap summarizer: Gemini Flash if usable, else the chat's own model
    const flash = getChatModel('google/gemini-3.5-flash')
    let model = flash ? resolveChatModel(flash, opts.routes, opts.userKeys) : { error: 'no flash' }
    if (typeof model === 'object' && model !== null && 'error' in model) {
      const own = getChatModel(opts.fallbackModelId)
      if (!own) return
      model = resolveChatModel(own, opts.routes, opts.userKeys)
      if (typeof model === 'object' && model !== null && 'error' in model) return
    }

    const { text } = await generateText({
      model: model as LanguageModel,
      instructions: 'You maintain a running summary of a conversation. Merge the previous summary with the new messages into ONE compact summary (max ~500 words). Preserve concrete facts, names, decisions, requirements, preferences, and unresolved threads. Plain text.',
      prompt: `Previous summary:\n${opts.memorySummary ?? '(none)'}\n\nNew messages to fold in:\n${olds.map(m => `${m.role}: ${m.content.slice(0, 600)}`).join('\n')}`,
      abortSignal: AbortSignal.timeout(90_000),
    })
    if (!text.trim()) return
    await prisma.chat.update({
      where: { id: opts.chatId },
      data: { memorySummary: text.trim().slice(0, 6000), summaryUpToId: olds[olds.length - 1].id },
    })
  } catch (err) {
    console.error('chat-hub compaction error:', err)
  }
}
