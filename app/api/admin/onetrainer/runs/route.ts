import { NextResponse } from 'next/server'
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  CreateMultipartUploadCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { checkAuth } from '@/lib/admin-auth'

// Trained-LoRA runs stored under training/loras/ in R2.
// Layout (new runs):  training/loras/<folder>/{run.json, final.safetensors, epochs/*.safetensors}
// Layout (legacy):    training/loras/<name>.safetensors  (flat single file)

interface FileInfo { key: string; name: string; size_gb: number; last_modified: string | null }

function makeR2() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

// Dismissed-run list, stored in R2 so hiding a run on one device hides it on
// all of them (the Monitor is shared across every admin device now).
const DISMISSED_KEY = 'training/monitor-dismissed.json'
async function readDismissed(r2: S3Client, bucket: string): Promise<string[]> {
  try {
    const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: DISMISSED_KEY }))
    const text = await obj.Body?.transformToString('utf-8')
    const parsed = text ? JSON.parse(text) : null
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

// GET               → { runs: [{ folder, final, epochs[], hasMeta, createdAt }], legacy: FileInfo[] }
// GET ?meta=<folder> → parsed run.json for that run
// GET ?tracked=1     → in-flight/recent runs for the Monitor, from run.json —
//                      SERVER-backed so every admin device sees the same list
export async function GET(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(req.url)
  const metaFolder = searchParams.get('meta')
  const r2 = makeR2()
  const bucket = process.env.R2_BUCKET_NAME!

  try {
    if (searchParams.get('tracked') === '1') {
      const listed = await r2.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'training/loras/' }))
      const metaKeys = (listed.Contents ?? []).map(o => o.Key ?? '').filter(k => k.endsWith('/run.json'))
      const dismissed = new Set(await readDismissed(r2, bucket))
      const runs = (await Promise.all(metaKeys.map(async key => {
        try {
          const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
          const text = await obj.Body?.transformToString('utf-8')
          const meta = text ? JSON.parse(text) : null
          const jobId = typeof meta?.job_id === 'string' ? meta.job_id : null
          if (!jobId || dismissed.has(jobId)) return null
          const folder = key.split('/')[2]
          const startedAt = typeof meta?.started_at === 'number'
            ? meta.started_at
            : (meta?.created_at ? new Date(meta.created_at).getTime() : 0)
          return { jobId, runName: String(meta?.run_name || folder), runFolder: folder, startedAt }
        } catch { return null }
      }))).filter((r): r is { jobId: string; runName: string; runFolder: string; startedAt: number } => !!r)
      // Newest first, capped — the Monitor polls one status request per card
      runs.sort((a, b) => b.startedAt - a.startedAt)
      return NextResponse.json({ runs: runs.slice(0, 20) })
    }
    // ?final=<folder> → does the run's final LoRA exist yet? Ground truth for
    // completion when RunPod's job status has expired (it TTLs after a while,
    // which left finished runs spinning forever on the Monitor).
    const finalFolder = searchParams.get('final')
    if (finalFolder) {
      const safe = finalFolder.replace(/[^a-z0-9_-]/gi, '_')
      try {
        const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: `training/loras/${safe}/final.safetensors` }))
        return NextResponse.json({ exists: true, size: head.ContentLength ?? 0, lastModified: head.LastModified?.toISOString() ?? null })
      } catch {
        return NextResponse.json({ exists: false })
      }
    }
    if (metaFolder) {
      const safe = metaFolder.replace(/[^a-z0-9_-]/gi, '_')
      const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: `training/loras/${safe}/run.json` }))
      const text = await obj.Body?.transformToString('utf-8')
      if (!text) return NextResponse.json({ error: 'run.json empty' }, { status: 404 })
      return NextResponse.json(JSON.parse(text))
    }

    const objects: { Key?: string; Size?: number; LastModified?: Date }[] = []
    let token: string | undefined
    do {
      const res = await r2.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: 'training/loras/', ContinuationToken: token,
      }))
      objects.push(...(res.Contents ?? []))
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)

    const toInfo = (o: { Key?: string; Size?: number; LastModified?: Date }): FileInfo => ({
      key:           o.Key!,
      name:          o.Key!.split('/').pop()!,
      size_gb:       Math.round((o.Size ?? 0) / 1e9 * 100) / 100,
      last_modified: o.LastModified?.toISOString() ?? null,
    })

    const runs = new Map<string, { folder: string; final: FileInfo | null; epochs: FileInfo[]; hasMeta: boolean; createdAt: string | null }>()
    const legacy: FileInfo[] = []

    for (const o of objects) {
      if (!o.Key) continue
      const rel = o.Key.slice('training/loras/'.length)
      if (!rel) continue
      const parts = rel.split('/')

      if (parts.length === 1) {
        if (/\.safetensors$/i.test(parts[0])) legacy.push(toInfo(o))
        continue
      }

      const folder = parts[0]
      const run = runs.get(folder) ?? { folder, final: null, epochs: [], hasMeta: false, createdAt: null }
      if (parts.length === 2 && parts[1] === 'run.json') {
        run.hasMeta = true
        run.createdAt = o.LastModified?.toISOString() ?? null
      } else if (parts.length === 2 && /\.safetensors$/i.test(parts[1])) {
        run.final = toInfo(o)
      } else if (parts.length === 3 && parts[1] === 'epochs' && /\.safetensors$/i.test(parts[2])) {
        run.epochs.push(toInfo(o))
      }
      runs.set(folder, run)
    }

    // Sort epochs by epoch number — OneTrainer snapshot names are
    // <timestamp>-save-<step>-<epoch>-<n>.safetensors
    const epochNum = (n: string) => {
      const s = n.match(/-save-\d+-(\d+)-\d+\.safetensors$/i)
      if (s) return parseInt(s[1])
      const m = n.match(/(\d+)(?=\.safetensors$)/i)
      return m ? parseInt(m[1]) : 0
    }
    const list = [...runs.values()]
      .filter(r => r.final || r.epochs.length > 0 || r.hasMeta)
      .map(r => ({ ...r, epochs: r.epochs.sort((a, b) => epochNum(a.name) - epochNum(b.name)) }))
      .sort((a, b) => {
        const ad = a.createdAt ?? a.final?.last_modified ?? ''
        const bd = b.createdAt ?? b.final?.last_modified ?? ''
        return bd.localeCompare(ad)
      })
    legacy.sort((a, b) => (b.last_modified ?? '').localeCompare(a.last_modified ?? ''))

    return NextResponse.json({ runs: list, legacy })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST { action: 'promote', folder, name? } → copy a completed FINE-TUNE run's
// final model into training/checkpoints/ so it becomes a selectable base
// checkpoint. Multipart server-side copy — the file is ~22GB (CopyObject
// alone caps at 5GB).
export async function POST(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null) as { action?: string; folder?: string; name?: string; jobId?: string } | null

  // { action: 'dismiss', jobId } → hide a run from the Monitor on EVERY device
  // (the tracked list is server-backed, so dismissal has to be too)
  if (body?.action === 'dismiss') {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 })
    const r2d = makeR2()
    const bkt = process.env.R2_BUCKET_NAME!
    const current = await readDismissed(r2d, bkt)
    if (!current.includes(jobId)) current.push(jobId)
    await r2d.send(new PutObjectCommand({
      Bucket: bkt, Key: DISMISSED_KEY,
      Body: JSON.stringify(current.slice(-500)), ContentType: 'application/json',
    }))
    return NextResponse.json({ ok: true })
  }

  if (body?.action !== 'promote') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  const folder = (body.folder ?? '').replace(/[^a-z0-9_-]/gi, '_')
  if (!folder) return NextResponse.json({ error: 'folder required' }, { status: 400 })
  const rawName = (body.name ?? folder).replace(/[^a-z0-9 _.-]/gi, '_').trim() || folder
  const destName = rawName.endsWith('.safetensors') ? rawName : `${rawName}.safetensors`

  const r2 = makeR2()
  const bucket = process.env.R2_BUCKET_NAME!
  const srcKey = `training/loras/${folder}/final.safetensors`
  const destKey = `training/checkpoints/${destName}`
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: srcKey }))
    const size = head.ContentLength ?? 0
    if (size === 0) return NextResponse.json({ error: 'final.safetensors not found for this run' }, { status: 404 })

    const PART = 1024 * 1024 * 1024 // 1GB parts
    const mp = await r2.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: destKey }))
    try {
      const parts: { ETag?: string; PartNumber: number }[] = []
      for (let start = 0, num = 1; start < size; start += PART, num++) {
        const end = Math.min(start + PART, size) - 1
        const res = await r2.send(new UploadPartCopyCommand({
          Bucket: bucket, Key: destKey, UploadId: mp.UploadId,
          CopySource: `${bucket}/${srcKey}`,
          CopySourceRange: `bytes=${start}-${end}`,
          PartNumber: num,
        }))
        parts.push({ ETag: res.CopyPartResult?.ETag, PartNumber: num })
      }
      await r2.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: destKey, UploadId: mp.UploadId,
        MultipartUpload: { Parts: parts },
      }))
    } catch (e) {
      await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId: mp.UploadId })).catch(() => {})
      throw e
    }
    return NextResponse.json({ ok: true, checkpointKey: destKey, sizeGb: Math.round(size / 1e9 * 10) / 10 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// PATCH { folder, run_name } → rename a run's display name in its run.json.
// The R2 folder itself keeps its original name — a live worker is still
// uploading into that prefix, so only the metadata changes.
export async function PATCH(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null) as { folder?: string; run_name?: string } | null
  const folder = (body?.folder ?? '').replace(/[^a-z0-9_-]/gi, '_')
  const runName = (body?.run_name ?? '').trim().slice(0, 80)
  if (!folder || !runName) return NextResponse.json({ error: 'folder and run_name required' }, { status: 400 })

  const r2 = makeR2()
  const bucket = process.env.R2_BUCKET_NAME!
  const key = `training/loras/${folder}/run.json`
  try {
    // Collision check: gather every OTHER run's display name (run.json name,
    // falling back to the folder name) and auto-suffix v2/v3/… on a match —
    // same convention the train route uses for folder names.
    const taken = new Set<string>()
    try {
      const listed = await r2.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'training/loras/' }))
      const metaKeys = (listed.Contents ?? [])
        .map(o => o.Key ?? '')
        .filter(k => k.endsWith('/run.json') && k !== key)
      await Promise.all(metaKeys.map(async mk => {
        try {
          const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: mk }))
          const text = await obj.Body?.transformToString('utf-8')
          const name = text ? JSON.parse(text)?.run_name : null
          taken.add(String(name || mk.split('/')[2]).toLowerCase())
        } catch { taken.add(mk.split('/')[2].toLowerCase()) }
      }))
    } catch { /* listing failed — rename proceeds without the check */ }
    let finalName = runName
    for (let n = 2; taken.has(finalName.toLowerCase()) && n < 50; n++) {
      finalName = `${runName} v${n}`
    }

    let meta: Record<string, unknown> = {}
    try {
      const obj = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const text = await obj.Body?.transformToString('utf-8')
      if (text) meta = JSON.parse(text)
    } catch { /* no run.json yet — create a minimal one */ }
    meta.run_name = finalName
    await r2.send(new PutObjectCommand({
      Bucket: bucket, Key: key,
      Body: JSON.stringify(meta, null, 2),
      ContentType: 'application/json',
    }))
    return NextResponse.json({ ok: true, run_name: finalName })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
