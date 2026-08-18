import { after }  from 'next/server'
import { prisma } from '@/lib/prisma'
import { processChunk, getBaseUrl, AUTOFILL_MODELS } from './_processor'
import { checkAuth } from '@/lib/admin-auth'


export async function GET(req: Request) {
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 })
  const select = {
    id: true, status: true, mode: true, modelKey: true, advanced: true,
    totalCount: true, nextIndex: true, processedCount: true, skippedCount: true, failedCount: true,
    triggerWord: true, curatorContext: true,
    createdAt: true, updatedAt: true,
  } as const

  // ALWAYS return EVERY active job (running/queued/paused) — no take limit and
  // no age filter. The old `take: 20` truncated to the newest 20 jobs, so a big
  // queue (e.g. 20 queued) would push the jobs that are actually PROCESSING out
  // of the response and they'd vanish from the UI after a refresh. Finished
  // jobs get a small recent tail for history.
  const [active, finished] = await Promise.all([
    prisma.autoFillJob.findMany({
      where:   { status: { in: ['running', 'queued', 'paused'] } },
      orderBy: { createdAt: 'desc' },
      take:    500,
      select,
    }),
    prisma.autoFillJob.findMany({
      where:   { status: { in: ['done', 'cancelled'] }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select,
    }),
  ])

  // Order for the queue feed: in-progress first (running, then paused), then the
  // queue in FIFO order (next-to-run first), then finished newest-first.
  const rank = (s: string) => (s === 'running' ? 0 : s === 'paused' ? 1 : s === 'queued' ? 2 : 3)
  const jobs = [...active, ...finished].sort((a, b) => {
    const ra = rank(a.status), rb = rank(b.status)
    if (ra !== rb) return ra - rb
    return ra === 3
      ? b.createdAt.getTime() - a.createdAt.getTime() // finished: newest first
      : a.createdAt.getTime() - b.createdAt.getTime() // active: oldest first (FIFO / processing order)
  })
  return Response.json({ jobs })
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 })

  const {
    ids, mode, model: modelKey, overwrite = false, advanced = false, context, contextTags,
  } = await req.json() as {
    ids:          number[]
    mode:         'caption' | 'tags' | 'flux' | 'append'
    model:        'pro' | 'flash'
    overwrite:    boolean
    advanced:     boolean
    context?:     string
    contextTags?: string[]
  }

  if (!Array.isArray(ids) || ids.length === 0) return new Response('ids required', { status: 400 })
  if (!['caption', 'tags', 'flux', 'append'].includes(mode)) return new Response('invalid mode', { status: 400 })
  // Validate the model key — an unknown key used to be stored verbatim,
  // silently run flash-lite, AND be mislabeled "Pro" in the run list
  if (modelKey !== undefined && !AUTOFILL_MODELS.some(m => m.key === modelKey)) {
    return new Response('invalid model', { status: 400 })
  }
  // Append rewrites existing captions from a natural-language instruction —
  // without one there is nothing to apply
  if (mode === 'append' && !context?.trim()) {
    return new Response('append mode needs an edit instruction', { status: 400 })
  }

  const curatorContext = mode === 'append'
    // Append: curatorContext carries the raw edit instruction verbatim (the
    // processor feeds it to the model as the curator's own words). Names go in
    // as a hint line rather than the "must be included" phrasing used below.
    ? [context!.trim(), ...(contextTags?.length ? [`(Subject name(s): ${contextTags.join(', ')})`] : [])].join('\n')
    : [
        ...(contextTags?.length ? [`Subjects/names: ${contextTags.join(', ')}`] : []),
        ...(context ? [context] : []),
      ].join(' — ') || null

  const triggerWord = (mode === 'flux' || mode === 'append') ? (contextTags?.[0] ?? null) : null

  // For append, `advanced` carries the NAMING flag (curated names/titles vs
  // strict visual-only) — see buildAppendInstruction. Defaults on: naming is
  // the reason to use this mode.
  const advancedFlag = mode === 'append' ? advanced !== false : advanced

  // If a job is actively running (updated recently) or paused, enqueue; otherwise start immediately.
  // Ignore 'running' jobs not updated in 3+ minutes — they are stuck/zombie and the cron watchdog
  // will re-kick them. Don't let them block new work.
  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000)
  const activeJob = await prisma.autoFillJob.findFirst({
    where: {
      OR: [
        { status: 'paused' },
        { status: 'running', updatedAt: { gte: threeMinutesAgo } },
      ],
    },
  })

  const initialStatus = activeJob ? 'queued' : 'running'

  const job = await prisma.autoFillJob.create({
    data: {
      status: initialStatus,
      mode, modelKey: modelKey ?? 'flash', overwrite, advanced: advancedFlag,
      curatorContext, triggerWord, imageIds: ids, totalCount: ids.length,
    },
  })

  if (initialStatus === 'running') {
    const baseUrl = getBaseUrl(req)
    after(async () => {
      await processChunk(job.id, baseUrl)
    })
  }

  return Response.json({ jobId: job.id, status: initialStatus })
}
