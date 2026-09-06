import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fal } from '@/lib/fal-client'
import { getTrainerFamily } from '@/lib/trainer-families'

function authOk(req: NextRequest) {
  const pass = process.env.ADMIN_PASSWORD
  // Fail closed: a missing ADMIN_PASSWORD must deny, not allow
  if (!pass) return false
  return req.headers.get('x-admin-password') === pass
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const jobId = parseInt(req.nextUrl.searchParams.get('jobId') ?? '')
  if (!jobId) return NextResponse.json({ error: 'Missing jobId' }, { status: 400 })

  const job = await prisma.loraTrainingJob.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!job.requestId) return NextResponse.json({ job, falStatus: null })

  fal.config({ credentials: process.env.FAL_KEY! })

  try {
    let falStatus
    try {
      falStatus = await fal.queue.status(job.modelId, {
        requestId: job.requestId,
        logs: true,
      })
    } catch {
      // Some trainer endpoints (wan-22-image-trainer) 422 on logs=1 — the
      // status itself is fine without logs, so retry bare instead of erroring
      falStatus = await fal.queue.status(job.modelId, {
        requestId: job.requestId,
        logs: false,
      })
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() }

    const status = falStatus.status as string

    if (status === 'IN_QUEUE')    updateData.status = 'queued'
    if (status === 'IN_PROGRESS') updateData.status = 'in_progress'

    if (status === 'COMPLETED') {
      const result = await fal.queue.result(job.modelId, { requestId: job.requestId })
      updateData.status    = 'completed'
      const rd = result.data as Record<string, { url?: string } | null> | null
      updateData.loraUrl = rd?.diffusers_lora_file?.url
        ?? rd?.lora_file?.url
        ?? rd?.safetensors_lora_file?.url
        ?? rd?.output_lora_file?.url
        ?? null
      updateData.configUrl = (result.data as Record<string, unknown> | null)
        ? ((result.data as Record<string, { url?: string } | null>)?.config_file?.url ?? null)
        : null

      // Trainer families: capture every output url + kick R2 re-hosting if the
      // webhook hasn't already (webhook-miss recovery; finalize is idempotent)
      const family = getTrainerFamily(job.modelId)
      const jobConfig = (job.config ?? {}) as Record<string, unknown>
      if (family && rd) {
        const resultUrls: Record<string, string> = {}
        for (const f of family.outputFiles) {
          const u = rd[f.key]?.url
          if (u) resultUrls[f.key] = u
        }
        updateData.config = { ...jobConfig, _result: { ...(jobConfig._result as object ?? {}), ...resultUrls } }
        if (!jobConfig._r2Prefix) {
          const reqOrigin = req.nextUrl.origin
          after(async () => {
            const base = reqOrigin || process.env.NEXT_PUBLIC_SITE_URL || 'https://prompt-protocol.vercel.app'
            await fetch(`${base}/api/admin/lora-training/finalize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD ?? '' },
              body: JSON.stringify({ jobId }),
              signal: AbortSignal.timeout(10_000),
            }).catch(() => {})
          })
        }
      }
    }

    if (status === 'FAILED') {
      updateData.status   = 'failed'
      updateData.errorMsg = 'Training failed on FAL'
    }

    const updated = await prisma.loraTrainingJob.update({
      where: { id: jobId },
      data: updateData,
    })

    return NextResponse.json({
      job: updated,
      falStatus,
      logs: (falStatus as unknown as { logs?: unknown[] }).logs ?? [],
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ job, falStatus: null, error: msg })
  }
}
