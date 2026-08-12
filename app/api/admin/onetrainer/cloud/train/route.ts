import { NextResponse } from 'next/server'
import { S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { checkAuth } from '@/lib/admin-auth'
import { uploadToR2 } from '@/lib/r2'

const RUNPOD_API = 'https://api.runpod.ai/v2'

function makeR2() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    maxAttempts: 1,
  })
}

async function runFolderExists(folder: string): Promise<boolean> {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_BUCKET_NAME) return false
  try {
    await makeR2().send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: `training/loras/${folder}/run.json`,
    }))
    return true
  } catch { return false }
}

// Existing runs' DISPLAY names (run.json run_name, folder as fallback) — used
// to auto-version a reused name: "Alexandra Thomas v2" launched again becomes
// "Alexandra Thomas v3" (same family logic as the picker/rename feature)
async function existingRunNames(): Promise<string[]> {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME) return []
  try {
    const r2 = makeR2()
    const listed = await r2.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: 'training/loras/' }))
    const metaKeys = (listed.Contents ?? []).map(o => o.Key ?? '').filter(k => k.endsWith('/run.json'))
    const names = await Promise.all(metaKeys.map(async k => {
      try {
        const obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: k }))
        const text = await obj.Body?.transformToString('utf-8')
        const name = text ? JSON.parse(text)?.run_name : null
        return String(name || k.split('/')[2])
      } catch { return k.split('/')[2] }
    }))
    return names
  } catch { return [] }
}

const stripVer = (n: string) => n.replace(/[\s_-]*v\d+$/i, '')
const verOf = (n: string) => { const m = n.match(/[\s_-]*v(\d+)$/i); return m ? parseInt(m[1], 10) : 1 }
const famKey = (n: string) => stripVer(n).toLowerCase().replace(/[\s_]+/g, ' ').trim()

// POST — dispatch a training run to RunPod.
// Each run gets its own R2 folder: training/loras/<folder>/
//   run.json               — full config + dataset composition (written here, before dispatch)
//   final.safetensors      — final LoRA (worker uploads via output_r2_key)
//   epochs/*.safetensors   — per-epoch snapshots (worker uploads via snapshots_r2_prefix,
//                            only when the config enables save_after)
// Body: { run_name, config, concepts, checkpoint_r2_key, run_meta? }
// run_meta (optional, stored in run.json only — never sent to the worker):
//   { dataset?: { name, defaultSource, images: [...] } }
export async function POST(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const endpointId = process.env.RUNPOD_ENDPOINT_ID
  const apiKey = process.env.RUNPOD_API_KEY
  if (!endpointId || !apiKey) {
    return NextResponse.json({ error: 'RunPod not configured — set RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY' }, { status: 500 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const requestedName = typeof body.run_name === 'string' && body.run_name.trim() ? body.run_name.trim() : 'Training Run'

  // Auto-version the DISPLAY name on reuse: exact-name collision bumps to the
  // family's next version ("Alexandra Thomas v2" again → "Alexandra Thomas v3")
  let runName = requestedName
  const taken = await existingRunNames()
  if (taken.some(n => n.toLowerCase() === requestedName.toLowerCase())) {
    const base = stripVer(requestedName).trim() || requestedName
    const maxVer = Math.max(
      verOf(requestedName),
      ...taken.filter(n => famKey(n) === famKey(requestedName)).map(verOf),
    )
    runName = `${base} v${maxVer + 1}`
  }
  const baseFolder = runName.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'run'

  // Never overwrite an existing run's outputs — auto-suffix -v2, -v3, ...
  let folder = baseFolder
  for (let v = 2; v <= 99 && await runFolderExists(folder); v++) folder = `${baseFolder}-v${v}`

  const runMeta = (body.run_meta ?? null) as Record<string, unknown> | null
  delete body.run_meta

  const input = {
    ...body,
    run_name:            runName,
    output_r2_key:       `training/loras/${folder}/final.safetensors`,
    snapshots_r2_prefix: `training/loras/${folder}/epochs/`,
  }

  // Record the run's full recipe alongside its outputs (config viewer + Reload)
  try {
    await uploadToR2(
      `training/loras/${folder}/run.json`,
      Buffer.from(JSON.stringify({
        run_name:          runName,
        folder,
        created_at:        new Date().toISOString(),
        checkpoint_r2_key: body.checkpoint_r2_key ?? null,
        config:            body.config ?? null,
        concepts:          body.concepts ?? null,
        dataset:           runMeta?.dataset ?? null,
      }, null, 2)),
      'application/json',
    )
  } catch (e) {
    console.error('[cloud/train] run.json upload failed:', e)
  }

  const res = await fetch(`${RUNPOD_API}/${endpointId}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // Long training runs must never die to the endpoint's default execution
    // timeout (600s) — override per job: 24h ceiling
    body: JSON.stringify({ input, policy: { executionTimeout: 24 * 60 * 60 * 1000 } }),
  })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: `RunPod error: ${err}` }, { status: res.status })
  }

  const data = await res.json() as { id: string }

  // Record the RunPod job id + launch time in run.json so the Monitor can be
  // SERVER-backed: any admin on any device lists in-flight runs from R2 rather
  // than from the launching browser's localStorage.
  try {
    await uploadToR2(
      `training/loras/${folder}/run.json`,
      Buffer.from(JSON.stringify({
        run_name:          runName,
        folder,
        created_at:        new Date().toISOString(),
        checkpoint_r2_key: body.checkpoint_r2_key ?? null,
        config:            body.config ?? null,
        concepts:          body.concepts ?? null,
        dataset:           runMeta?.dataset ?? null,
        job_id:            data.id,
        started_at:        Date.now(),
      }, null, 2)),
      'application/json',
    )
  } catch (e) {
    console.error('[cloud/train] run.json job_id update failed:', e)
  }

  return NextResponse.json({ job_id: data.id, started: true, run_folder: folder, run_name: runName })
}
