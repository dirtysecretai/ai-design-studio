import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { Readable } from 'node:stream'
import { prisma } from '@/lib/prisma'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { uploadToR2 } from '@/lib/r2'
import { getTrainerFamily } from '@/lib/trainer-families'

// POST /api/admin/lora-training/finalize { jobId }
//
// Re-hosts a completed trainer job's artifacts from fal's CDN (which can
// expire) into R2 under <family.r2Namespace>/<run>/, writes a run.json
// describing the run, and stamps the job's loraUrl with the permanent R2 URL.
// Idempotent via config._r2Prefix — the webhook AND the status poller both
// kick this, whichever fires first wins. Only trainer-family jobs (wan22/ltx2)
// are finalized; flux jobs keep their existing fal-URL behavior.
//
// The transfers are HUNDREDS of MB and must not ride the request lifetime:
// callers time out (undici gives up at ~5min) and a dev-server handler dies
// with its disconnected client, killing the copy mid-stream. So the route
// validates, responds 202 immediately, and runs the copy in after() —
// detached from the connection, bounded by maxDuration on Vercel. Completion
// signal = config._r2Prefix set (re-POST returns alreadyFinalized).

export const maxDuration = 300

function authOk(req: NextRequest) {
  const pass = process.env.ADMIN_PASSWORD
  if (!pass) return false
  return req.headers.get('x-admin-password') === pass
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let jobId: number
  try {
    jobId = (await req.json() as { jobId: number }).jobId
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const job = await prisma.loraTrainingJob.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const family = getTrainerFamily(job.modelId)
  if (!family) return NextResponse.json({ ok: true, skipped: 'not a family job' })
  if (job.status !== 'completed') return NextResponse.json({ error: `Job is ${job.status}` }, { status: 409 })

  const config = (job.config ?? {}) as Record<string, unknown>
  if (config._r2Prefix) {
    return NextResponse.json({ ok: true, alreadyFinalized: true, r2Prefix: config._r2Prefix })
  }

  after(async () => {
    try {
      await runFinalize(jobId, job as { name: string | null; loraUrl: string | null; configUrl: string | null; imageCount: number }, family, config)
    } catch (err) {
      console.error(`[lora/finalize] job ${jobId} failed:`, err instanceof Error ? err.message : err)
    }
  })
  return NextResponse.json({ ok: true, started: true }, { status: 202 })
}

async function runFinalize(
  jobId: number,
  job: { name: string | null; loraUrl: string | null; configUrl: string | null; imageCount: number },
  family: NonNullable<ReturnType<typeof getTrainerFamily>>,
  config: Record<string, unknown>,
) {

  // Source URLs: webhook/status stored them in config._result (all files) and
  // job.loraUrl/configUrl (primary two)
  const result = (config._result ?? {}) as Record<string, string | undefined>
  const sourceFor = (key: string): string | null => {
    if (result[key]) return result[key]!
    if (key === 'lora_file' || key === 'diffusers_lora_file') return job.loraUrl ?? null
    if (key === 'config_file') return job.configUrl ?? null
    return null
  }

  const safeName = (job.name || `run-${jobId}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `run-${jobId}`
  const prefix = `${family.r2Namespace}/${safeName}-${jobId}`
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })

  const saved: Record<string, string> = {}
  try {
    for (const f of family.outputFiles) {
      const src = sourceFor(f.key)
      if (!src) continue // optional artifact (e.g. high_noise on video trainer)
      // LoRA files run to hundreds of MB and a fetch signal governs the WHOLE
      // body stream — no explicit timeout; the route's maxDuration bounds it
      // on Vercel, and local finalize is manually retried if it ever hangs
      const res = await fetch(src)
      if (!res.ok || !res.body) throw new Error(`fetch ${f.key} → HTTP ${res.status}`)
      const key = `${prefix}/${f.saveAs}`
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: key,
          Body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
          ContentType: f.saveAs.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        },
        partSize: 50 * 1024 * 1024,
        queueSize: 3,
      })
      await upload.done()
      saved[f.saveAs] = `${publicBase}/${key}`
    }

    if (!saved['final.safetensors']) throw new Error('No primary LoRA file could be re-hosted')

    const runJson = {
      family: family.familyId,
      variant: config.variant ?? null,
      run_name: job.name,
      jobId,
      trigger_phrase: config.trigger_phrase ?? null,
      params: family.buildInput(config),
      imageCount: job.imageCount,
      sourceImageIds: Array.isArray(config._imageIds) ? config._imageIds : [],
      createdAt: new Date().toISOString(),
      files: saved,
    }
    await uploadToR2(`${prefix}/run.json`, Buffer.from(JSON.stringify(runJson, null, 2)), 'application/json')

    await prisma.loraTrainingJob.update({
      where: { id: jobId },
      data: {
        loraUrl: saved['final.safetensors'],
        configUrl: saved['config.json'] ?? job.configUrl,
        config: { ...config, _r2Prefix: prefix, _r2Files: saved } as object,
      },
    })

    console.log(`[lora/finalize] job ${jobId} → ${prefix} (${Object.keys(saved).length + 1} files)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[lora/finalize] job ${jobId} failed:`, msg)
    // Leave the job completed with fal URLs — finalize can be retried by
    // re-POSTing (the _r2Prefix claim is only written on success)
  }
}
