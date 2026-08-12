import { NextResponse } from 'next/server'
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'
import { checkAdminRequest } from '@/lib/admin-check'

const RUNPOD_API = 'https://api.runpod.ai/v2'
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// Ground-truth completion check: the worker writes the output to a
// DETERMINISTIC key (inference/outputs/<jobId>.png). RunPod purges job status
// shortly after workers scale down, so a finished job can 404 before the
// client ever saw "completed" (tab asleep, page closed). The file in R2 is
// the truth — if it exists, the job completed.
async function r2OutputCheck(jobId: string): Promise<string | null> {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_BUCKET_NAME) return null
  try {
    const r2 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      maxAttempts: 1,
    })
    const key = `inference/outputs/${jobId}.png`
    await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }))
    return key
  } catch { return null }
}

// POST — called by startNb2SlotPolling with { requestId, ... }
// Returns { status: 'processing' | 'completed' | 'failed', images?: [{url, dbId}], error? }
export async function POST(req: Request) {
  if (!await checkAdminRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { requestId?: string }
  const jobId = body.requestId
  if (!jobId) return NextResponse.json({ status: 'failed', error: 'Missing requestId' })

  const endpointId = process.env.RUNPOD_ENDPOINT_ID
  const apiKey     = process.env.RUNPOD_API_KEY
  if (!endpointId || !apiKey) return NextResponse.json({ status: 'failed', error: 'RunPod not configured' })

  const res = await fetch(`${RUNPOD_API}/${endpointId}/status/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    // 404: either brief registration delay after /run submit, or job was purged
    // post-completion. Check R2 for the output first — if the file exists the
    // job COMPLETED and this must not be reported as missing.
    if (res.status === 404) {
      const r2Key = await r2OutputCheck(jobId)
      if (r2Key) {
        const imageUrl = PUBLIC_URL
          ? `${PUBLIC_URL}/${r2Key}`
          : `https://${process.env.R2_BUCKET_NAME}.${new URL(process.env.R2_ENDPOINT!).hostname}/${r2Key}`
        return NextResponse.json({ status: 'completed', images: [{ url: imageUrl, dbId: null, r2Key }], workerId: null })
      }
      return NextResponse.json({ status: 'processing', notFound: true })
    }
    return NextResponse.json({ status: 'failed', error: `RunPod HTTP ${res.status}` })
  }

  const data = await res.json() as { status: string; workerId?: string; delayTime?: number; output?: { success?: boolean; output_r2_key?: string; error?: string }; error?: string }
  // Worker identity lets the client detect COLD STARTS (fresh worker = model
  // load ahead = much longer run) and calibrate its ETA accordingly
  const workerId = data.workerId ?? null

  const statusMap: Record<string, string> = {
    IN_QUEUE:    'processing',
    IN_PROGRESS: 'processing',
    COMPLETED:   'completed',
    FAILED:      'failed',
    CANCELLED:   'failed',
    TIMED_OUT:   'failed',
  }
  const status = statusMap[data.status] ?? 'processing'

  if (status === 'failed') {
    return NextResponse.json({ status: 'failed', error: data.output?.error ?? data.error ?? 'RunPod job failed' })
  }

  if (status === 'completed') {
    const r2Key = data.output?.output_r2_key
    if (!r2Key) {
      // Handler returned success=False — surface its error message, not a generic one
      const handlerErr = data.output?.error ?? 'Job completed but produced no output (check worker logs)'
      return NextResponse.json({ status: 'failed', error: handlerErr })
    }

    const imageUrl = PUBLIC_URL
      ? `${PUBLIC_URL}/${r2Key}`
      : `https://${process.env.R2_BUCKET_NAME}.${new URL(process.env.R2_ENDPOINT!).hostname}/${r2Key}`

    return NextResponse.json({ status: 'completed', images: [{ url: imageUrl, dbId: null, r2Key }], workerId })
  }

  // queued: still IN_QUEUE (no worker assigned yet). That alone is NOT a cold
  // start — the queue also backs up when every warm worker is busy. Check the
  // endpoint health: only report coldBooting when a worker is initializing.
  if (data.status === 'IN_QUEUE') {
    let coldBooting = false
    try {
      const h = await fetch(`${RUNPOD_API}/${endpointId}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(4000),
      })
      if (h.ok) {
        const hd = await h.json() as { workers?: { initializing?: number } }
        coldBooting = (hd.workers?.initializing ?? 0) > 0
      }
    } catch { /* health unavailable — don't guess cold */ }
    return NextResponse.json({ status: 'processing', workerId, queued: true, coldBooting })
  }
  return NextResponse.json({ status: 'processing', workerId })
}
