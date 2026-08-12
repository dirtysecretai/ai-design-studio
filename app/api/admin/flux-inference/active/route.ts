import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'

// GET /api/admin/flux-inference/active
//
// In-flight flux jobs, discovered SERVER-SIDE so the loading tiles show up on
// every device instead of only the browser that pressed Generate. A job is
// "active" when its submit-time metadata sidecar exists but the worker hasn't
// written the output PNG yet (deterministic key), within the poll window.
export async function GET(req: Request) {
  const token = (await cookies()).get('session')?.value
  const sessionUser = token ? await getUserFromSession(token) : null
  if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await checkIsAdmin(sessionUser.email ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME) {
    return NextResponse.json({ jobs: [] })
  }

  // Flux pipeline chains can run a long time; match the client's 3h poll cap
  const hours = Math.min(6, Math.max(1, Number(new URL(req.url).searchParams.get('hours')) || 3))
  const bucket = process.env.R2_BUCKET_NAME
  const r2 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    maxAttempts: 2,
  })

  try {
    const cutoff = Date.now() - hours * 3600 * 1000

    // One listing each — cheaper than a HeadObject per candidate job
    const listAll = async (prefix: string) => {
      const keys: { key: string; at: number }[] = []
      let t: string | undefined
      do {
        const res = await r2.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: t }))
        for (const o of res.Contents ?? []) {
          if (o.Key && o.LastModified) keys.push({ key: o.Key, at: o.LastModified.getTime() })
        }
        t = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (t)
      return keys
    }

    const [metas, outputs] = await Promise.all([
      listAll('inference/meta/'),
      listAll('inference/outputs/'),
    ])
    const done = new Set(outputs.map(o => o.key.split('/').pop()!.replace(/\.png$/i, '')))

    const candidates = metas
      .filter(m => m.at > cutoff)
      .map(m => ({ jobId: m.key.split('/').pop()!.replace(/\.json$/i, ''), at: m.at }))
      .filter(c => !done.has(c.jobId))
      .sort((a, b) => b.at - a.at)
      .slice(0, 12)

    // "Sidecar exists, output doesn't" is PERMANENTLY true for a job that
    // failed — which made this endpoint re-serve dead jobs forever, so the
    // client kept re-adopting them and dismissing did nothing. Ask RunPod:
    // only genuinely queued/running jobs count as active.
    const endpointId = process.env.RUNPOD_ENDPOINT_ID
    const apiKey = process.env.RUNPOD_API_KEY
    const stillRunning = async (jobId: string): Promise<boolean> => {
      if (!endpointId || !apiKey) return false
      try {
        const r = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) return false // 404 = purged/unknown → not active
        const s = await r.json() as { status?: string }
        return s.status === 'IN_QUEUE' || s.status === 'IN_PROGRESS'
      } catch { return false } // unreachable → don't resurrect a tile
    }

    const jobs = (await Promise.all(candidates.map(async c => {
      try {
        if (!await stillRunning(c.jobId)) return null
        const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: `inference/meta/${c.jobId}.json` }))
        const text = await obj.Body?.transformToString('utf-8')
        const meta = text ? JSON.parse(text) : {}
        return {
          jobId:     c.jobId,
          prompt:    String(meta.prompt ?? ''),
          startedAt: c.at,
          width:     Number(meta.width) || 1024,
          height:    Number(meta.height) || 1024,
        }
      } catch { return null }
    }))).filter(Boolean)

    return NextResponse.json({ jobs })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg, jobs: [] }, { status: 500 })
  }
}
