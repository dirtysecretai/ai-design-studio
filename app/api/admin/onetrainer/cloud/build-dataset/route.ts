import { NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import archiver from 'archiver'
import sharp from 'sharp'
import { PassThrough } from 'stream'
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

export const maxDuration = 300

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv)$/i
// Zip streams to R2 (never buffered whole in memory), so the cap is about
// sane dataset sizes rather than server RAM
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

// Server-side BACKGROUND dataset builds (DatasetBuildJob, raw SQL — table was
// added out-of-band). POST starts a job and returns its id immediately; the
// build continues via after() even if the client leaves. Any page/device polls
// GET ?job= / ?active=1 for live progress, and PATCH marks a job consumed once
// its result has been attached (or dismissed).

interface BuildItem { id: number; url: string; caption: string }

async function runBuild(jobId: number) {
  const fail = async (msg: string) => {
    await prisma.$executeRaw`
      UPDATE "DatasetBuildJob" SET "status" = 'failed', "error" = ${msg.slice(0, 2000)}, "updatedAt" = NOW()
      WHERE "id" = ${jobId}`.catch(() => {})
  }
  try {
    const rows = await prisma.$queryRaw<{ itemsJson: string; name: string; maxDim: number }[]>`
      SELECT "itemsJson", "name", "maxDim" FROM "DatasetBuildJob" WHERE "id" = ${jobId} LIMIT 1`
    if (rows.length === 0) return
    const items = JSON.parse(rows[0].itemsJson) as BuildItem[]
    const maxDim = rows[0].maxDim

    // Throttled progress writes (~every 2s) so the DB isn't hammered per image.
    // Each write also reads the job's status — a PATCH {cancel:true} flips it
    // to 'cancelled' and the workers below bail out within a couple seconds.
    let lastWrite = 0
    let cancelled = false
    const report = async (done: number, bytes: number, phase: string, force = false) => {
      const now = Date.now()
      if (!force && now - lastWrite < 2000) return
      lastWrite = now
      try {
        const st = await prisma.$queryRaw<{ status: string }[]>`
          SELECT "status" FROM "DatasetBuildJob" WHERE "id" = ${jobId} LIMIT 1`
        if (st[0]?.status === 'cancelled') { cancelled = true; return }
      } catch {}
      await prisma.$executeRaw`
        UPDATE "DatasetBuildJob"
        SET "progressDone" = ${done}, "progressTotal" = ${items.length}, "progressBytes" = ${Math.round(bytes)},
            "phase" = ${phase}, "updatedAt" = NOW()
        WHERE "id" = ${jobId}`.catch(() => {})
    }

    // Zip stream → R2 multipart upload (50MB parts, bounded memory)
    const safeName = (rows[0].name || 'dataset').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60)
    const key = `training/datasets/${safeName}-${Date.now()}.zip`
    const s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    })
    // Image reads, measured from this network: the public r2.dev URL rides
    // Cloudflare's edge (~35MB/s here) but can throttle sustained bursts by
    // holding connections; the S3 API never throttles but crawls (~1MB/s). So:
    // edge fetch with a hard timeout + backoff retries first, S3 as the
    // reliable last-resort rescue for stragglers. No path can wedge a worker.
    const getImage = async (url: string): Promise<Buffer | null> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
          if (res.ok) return Buffer.from(await res.arrayBuffer())
          if (res.status !== 429 && res.status < 500) break // hard 4xx — no point retrying
        } catch { /* timeout / held connection — retry with backoff */ }
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 1000))
      }
      try {
        const key = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))
        if (key) {
          const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }))
          if (obj.Body) return Buffer.from(await obj.Body.transformToByteArray())
        }
      } catch { /* give up — caller counts it as skipped */ }
      return null
    }

    const pass = new PassThrough()
    const upload = new Upload({
      client: s3,
      params: { Bucket: process.env.R2_BUCKET_NAME!, Key: key, Body: pass, ContentType: 'application/zip' },
      partSize: 50 * 1024 * 1024,
      queueSize: 3,
    })
    const uploadDone = upload.done()

    const archive = archiver('zip', { zlib: { level: 0 } }) // images are already compressed
    let zipBytes = 0
    archive.on('data', (c: Buffer) => { zipBytes += c.length })
    archive.pipe(pass)
    const archiveErr = new Promise<never>((_, reject) => archive.on('error', reject))

    let totalBytes = 0
    let added = 0
    let skipped = 0
    const queue = [...items]
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        if (cancelled) break
        const it = queue.shift()!
        try {
          if (totalBytes > MAX_TOTAL_BYTES) { skipped++; continue }
          const fetched = await getImage(it.url)
          if (!fetched) { skipped++; continue }
          let buf: Buffer = fetched
          let ext: string
          if (maxDim > 0) {
            // Downscale to the training-relevant size; JPEG q90 keeps detail
            // while cutting multi-MB originals to ~100–300KB each
            try {
              buf = await sharp(buf).rotate()
                .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer()
              ext = 'jpg'
            } catch {
              const m = it.url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i)
              ext = m ? m[1].toLowerCase() : 'jpg'
            }
          } else {
            const m = it.url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i)
            ext = m ? m[1].toLowerCase() : 'jpg'
          }
          totalBytes += buf.length
          if (totalBytes > MAX_TOTAL_BYTES) { skipped++; continue }
          archive.append(buf, { name: `${it.id}.${ext}` })
          archive.append(it.caption, { name: `${it.id}.txt` })
          added++
        } catch { skipped++ }
        finally { await report(added + skipped, totalBytes, 'fetching') }
      }
    })
    await Promise.race([Promise.all(workers), archiveErr])
    if (cancelled) {
      // Tear down cleanly: abort the multipart upload (discards uploaded
      // parts server-side) and destroy the zip stream. Status is already
      // 'cancelled' — leave it as the final state.
      try { archive.destroy() } catch {}
      try { await upload.abort() } catch {}
      return
    }
    await report(added + skipped, totalBytes, 'uploading', true)
    await archive.finalize()
    await Promise.race([uploadDone, archiveErr])

    if (added === 0) { await fail('All images failed to download'); return }

    await prisma.$executeRaw`
      UPDATE "DatasetBuildJob"
      SET "status" = 'completed', "resultKey" = ${key}, "resultCount" = ${added}, "resultSkipped" = ${skipped},
          "resultSizeMb" = ${Math.round(zipBytes / 1024 / 1024 * 10) / 10},
          "truncated" = ${totalBytes > MAX_TOTAL_BYTES},
          "progressDone" = ${added + skipped}, "progressTotal" = ${items.length},
          "progressBytes" = ${Math.round(zipBytes)}, "phase" = 'done', "updatedAt" = NOW()
      WHERE "id" = ${jobId}`
  } catch (e) {
    await fail(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  }
}

// POST { items: [{id, caption}], name?, maxDim? } → { jobId } (build runs in background)
export async function POST(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as { items?: { id?: unknown; caption?: unknown }[]; name?: string; maxDim?: number } | null
  const maxDim = [768, 1024, 1536, 2048].includes(Number(body?.maxDim)) ? Number(body?.maxDim) : 0
  const rawItems = Array.isArray(body?.items) ? body!.items : []
  const wanted = new Map<number, string>()
  for (const it of rawItems) {
    const id = Number(it?.id)
    if (!isNaN(id) && id > 0) wanted.set(id, typeof it?.caption === 'string' ? it.caption : '')
  }
  if (wanted.size === 0) return NextResponse.json({ error: 'items required' }, { status: 400 })
  if (wanted.size > 5000) return NextResponse.json({ error: 'Max 5000 images per dataset' }, { status: 400 })

  const records = await prisma.generatedImage.findMany({
    where: { id: { in: [...wanted.keys()] }, isDeleted: false },
    select: { id: true, imageUrl: true },
  })
  const items: BuildItem[] = records
    .filter(r => r.imageUrl && !VIDEO_RE.test(r.imageUrl))
    .map(r => ({ id: r.id, url: r.imageUrl, caption: (wanted.get(r.id) ?? '').trim() }))
  if (items.length === 0) return NextResponse.json({ error: 'No usable images in the selection' }, { status: 400 })

  const name = (body?.name || 'dataset').slice(0, 80)
  const jobRows = await prisma.$queryRaw<{ id: number }[]>`
    INSERT INTO "DatasetBuildJob" ("name", "maxDim", "itemsJson", "progressTotal", "updatedAt")
    VALUES (${name}, ${maxDim}, ${JSON.stringify(items)}, ${items.length}, NOW())
    RETURNING "id"`
  const jobId = jobRows[0].id

  // Continue after the response is sent — the client doesn't have to stay
  after(() => runBuild(jobId))

  return NextResponse.json({ jobId })
}

const JOB_SELECT = `SELECT "id", "status", "name", "maxDim", "progressDone", "progressTotal",
  "progressBytes"::float8 AS "progressBytes", "phase", "resultKey", "resultCount", "resultSkipped",
  "resultSizeMb", "truncated", "error", "createdAt" FROM "DatasetBuildJob"`

// GET ?job=<id> → that job (&items=1 includes itemsJson); GET ?active=1 →
// newest unconsumed job from the last 2h; GET ?list=1 → the "Built" library
// (every completed build, reusable as a concept without rebuilding)
export async function GET(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sp = new URL(req.url).searchParams
  const jobId = parseInt(sp.get('job') ?? '')
  if (!isNaN(jobId)) {
    const select = sp.get('items') === '1' ? JOB_SELECT.replace(' FROM', ', "itemsJson" FROM') : JOB_SELECT
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`${select} WHERE "id" = $1 LIMIT 1`, jobId)
    return NextResponse.json(rows[0] ?? null)
  }
  if (sp.get('list') === '1') {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `${JOB_SELECT} WHERE "status" = 'completed' AND "resultKey" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 30`)
    return NextResponse.json(rows)
  }
  if (sp.get('active') === '1') {
    // Reap zombies first: the build worker writes progress every ~2s, so a
    // 'running' row silent for 10+ minutes died with its server process (dev
    // restart, crash). Without this it haunts every page load as a stuck
    // "Building… 0/N" bar forever.
    try {
      await prisma.$executeRaw`
        UPDATE "DatasetBuildJob" SET "status" = 'failed',
          "error" = 'Stale build — its worker died (server restart). Start a fresh build.',
          "updatedAt" = NOW()
        WHERE "status" = 'running' AND "updatedAt" < NOW() - INTERVAL '10 minutes'`
    } catch { /* reap is best-effort */ }
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `${JOB_SELECT} WHERE "consumedAt" IS NULL AND "status" != 'cancelled'
         AND ("status" = 'running' OR "updatedAt" > NOW() - INTERVAL '2 hours')
       ORDER BY "createdAt" DESC LIMIT 1`)
    return NextResponse.json(rows[0] ?? null)
  }
  return NextResponse.json({ error: 'job or active param required' }, { status: 400 })
}

// DELETE ?job=<id> → remove a built dataset: the zip in R2 (best-effort) and
// the job record. Past training runs that used the zip are unaffected — they
// already trained; only future reuse goes away.
export async function DELETE(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const jobId = parseInt(new URL(req.url).searchParams.get('job') ?? '')
  if (isNaN(jobId)) return NextResponse.json({ error: 'job param required' }, { status: 400 })
  try {
    const rows = await prisma.$queryRaw<{ resultKey: string | null }[]>`
      SELECT "resultKey" FROM "DatasetBuildJob" WHERE "id" = ${jobId} LIMIT 1`
    const key = rows[0]?.resultKey
    if (key && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME) {
      const r2 = new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      })
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })).catch(() => {})
    }
    await prisma.$executeRaw`DELETE FROM "DatasetBuildJob" WHERE "id" = ${jobId}`
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// PATCH ?job=<id> → mark consumed (result attached or dismissed — stops it
// re-surfacing). With a JSON body { name } → rename the build instead (the
// Built library keys reuse on names, and "dataset + dataset" tells you nothing).
export async function PATCH(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const jobId = parseInt(new URL(req.url).searchParams.get('job') ?? '')
  if (isNaN(jobId)) return NextResponse.json({ error: 'job param required' }, { status: 400 })
  const body = await req.json().catch(() => null) as { name?: string; cancel?: boolean } | null
  // { cancel: true } → stop an in-flight build. The background runner checks
  // status on every progress tick and bails within ~2s, aborting its upload.
  if (body?.cancel === true) {
    await prisma.$executeRaw`
      UPDATE "DatasetBuildJob" SET "status" = 'cancelled', "phase" = 'cancelled', "updatedAt" = NOW()
      WHERE "id" = ${jobId} AND "status" NOT IN ('completed', 'failed')`
    return NextResponse.json({ ok: true, cancelled: true })
  }
  if (typeof body?.name === 'string' && body.name.trim()) {
    const name = body.name.trim().slice(0, 80)
    await prisma.$executeRaw`UPDATE "DatasetBuildJob" SET "name" = ${name}, "updatedAt" = NOW() WHERE "id" = ${jobId}`
    return NextResponse.json({ ok: true, name })
  }
  await prisma.$executeRaw`UPDATE "DatasetBuildJob" SET "consumedAt" = NOW() WHERE "id" = ${jobId}`
  return NextResponse.json({ ok: true })
}
