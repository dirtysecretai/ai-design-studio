import { NextResponse, after } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { promoteNextQueuedJob } from '@/lib/fal-queue'
import { resolveFalImageModelSpec, buildFalImageInput } from '@/lib/fal-image-models'
import { getModelById } from '@/config/ai-models.config'
import { jsonPrivate } from '@/lib/api-json'

// POST /api/admin/batch-generate
//
// Batch mode used to be a loop inside the browser: one POST per batch, four in
// flight. Refreshing the page killed the loop, so a run of 100 stopped at
// whatever had already been submitted and the rest existed nowhere. A batch is
// an account-level intention, not a tab-level one.
//
// This enqueues every batch in ONE request as `queued` GenerationQueue rows
// carrying their prepared fal endpoint and input. From there the existing
// promoter (promoteNextQueuedJob, run after every webhook and by the
// drain-queue cron) submits them at global concurrency. Closing the tab, losing
// the laptop, or reloading mid-run changes nothing.
//
// Reference images are passed to fal as their permanent R2 URLs rather than
// being re-uploaded to fal storage: uploading 100 batches inside one request
// would blow the function's time limit, and fal fetches public URLs. ADMIN ONLY.

export const runtime = 'nodejs'
export const maxDuration = 60

/** Hard ceiling — a runaway client should not be able to enqueue unbounded work. */
const MAX_BATCHES = 500

export async function POST(req: Request) {
  // Session-only on purpose: every queued row is owned by a user, so the
  // admin-password header (which identifies no one) cannot stand in here.
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  if (!user || !(await checkIsAdmin(user.email))) {
    return jsonPrivate({ error: 'Admin only' }, { status: 403 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return jsonPrivate({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const model = typeof body.model === 'string' ? body.model : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '1:1'
  const quality = typeof body.quality === 'string' ? body.quality : '1k'

  // Each entry is one batch: the reference images that batch runs with.
  const rawBatches: unknown = body.batches
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    return jsonPrivate({ error: 'batches must be a non-empty array' }, { status: 400 })
  }
  const batches: string[][] = rawBatches
    .slice(0, MAX_BATCHES)
    .map((b: unknown) =>
      Array.isArray(b) ? b.filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u)) : []
    )
    .filter(b => b.length > 0)

  if (batches.length === 0) {
    return jsonPrivate(
      { error: 'Every batch needs at least one reference image with a permanent https URL.' },
      { status: 400 },
    )
  }

  const selectedModel = getModelById(model)
  if (!selectedModel) {
    return jsonPrivate({ error: `Unknown model: ${model}` }, { status: 400 })
  }

  // Only the fal-spec image suite can be prepared ahead of time — the older
  // models build their input inside /api/generate's own per-model branches.
  const probeSpec = resolveFalImageModelSpec(model, true)
  if (!probeSpec) {
    return jsonPrivate(
      {
        error:
          `${selectedModel.displayName} can't run server-side batches yet — that only covers the fal image models. ` +
          `Pick one of those, or run this model's batches with the tab open.`,
      },
      { status: 400 },
    )
  }

  const rows: { falEndpoint: string; falInput: Record<string, any>; refs: string[] }[] = []
  for (const refs of batches) {
    const spec = resolveFalImageModelSpec(model, refs.length > 0)
    if (!spec) continue
    try {
      const built = buildFalImageInput(spec, {
        prompt,
        aspectRatio,
        quality,
        imageUrls: refs.slice(0, spec.maxInputImages),
        options: body,
      })
      rows.push({ falEndpoint: built.endpoint, falInput: built.input, refs })
    } catch (err: any) {
      // One malformed batch should not silently drop the other 99
      return jsonPrivate(
        { error: err?.message || `Could not build input for ${model}` },
        { status: 400 },
      )
    }
  }

  if (rows.length === 0) {
    return jsonPrivate({ error: 'Nothing could be queued from those batches.' }, { status: 400 })
  }

  const jobPrompt = prompt || selectedModel.displayName

  // Admin batches are not billed, matching the client path this replaces
  // (it posted adminMode: true, which skips ticket deduction).
  // createManyAndReturn, not createMany: the client needs the row ids to show
  // a card per queued batch IMMEDIATELY. Without them the tab had nothing to
  // draw and the only thing that produced tiles was the 10s recovery poll \u2014
  // which is why a run of 69 looked empty until it was reloaded.
  const created = await prisma.generationQueue.createManyAndReturn({
    select: { id: true },
    data: rows.map(r => ({
      userId: user.id,
      modelId: model,
      modelType: 'image',
      prompt: jobPrompt,
      status: 'queued',
      ticketCost: 0,
      parameters: {
        source: 'main-scanner',
        model,
        quality,
        aspectRatio,
        adminMode: true,
        batch: true,
        referenceImageUrls: r.refs,
        loraUrl: typeof body.loraUrl === 'string' ? body.loraUrl : null,
        loraName: typeof body.loraName === 'string' ? body.loraName : null,
        falEndpoint: r.falEndpoint,
        falInput: r.falInput,
      },
    })),
  })

  // Don't wait for the cron's next minute — fill whatever capacity is free now.
  // Each call claims at most one global slot, so this promotes up to the limit
  // and the rest drain as running jobs finish.
  after(async () => {
    for (let i = 0; i < 12; i++) {
      try {
        await promoteNextQueuedJob()
      } catch (e) {
        console.error('[batch-generate] promote failed:', e)
        break
      }
    }
  })

  console.log(`[batch-generate] user ${user.id} queued ${rows.length} × ${model}`)
  return jsonPrivate({
    success: true,
    queued: rows.length,
    model,
    // Paired with the refs each row was built from, so every card can show the
    // reference it is generating against while it waits.
    jobs: created.map((row, i) => ({ id: row.id, refs: rows[i]?.refs ?? [] })),
  })
}
