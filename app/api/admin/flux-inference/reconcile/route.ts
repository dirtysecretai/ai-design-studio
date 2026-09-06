import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import prisma from '@/lib/prisma'
import { jsonPrivate } from '@/lib/api-json'

const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// POST /api/admin/flux-inference/reconcile
//
// Rebuilds GeneratedImage rows for flux outputs that exist in R2 but never got
// saved. The old flow only wrote the DB row when a BROWSER's poller happened to
// witness "completed" — closing the tab, sleeping a phone, or switching devices
// mid-run orphaned the finished image permanently. The worker writes to a
// deterministic key (inference/outputs/<jobId>.png) and the generate route
// writes a metadata sidecar (inference/meta/<jobId>.json), so the server can
// reconstruct everything on its own.
//
// Idempotent: rows are matched by imageUrl, so repeated calls are harmless.
export async function POST(req: Request) {
  const token = (await cookies()).get('session')?.value
  const sessionUser = token ? await getUserFromSession(token) : null
  if (!sessionUser) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })
  if (!await checkIsAdmin(sessionUser.email ?? '')) {
    return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME) {
    return jsonPrivate({ error: 'R2 not configured' }, { status: 500 })
  }

  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get('hours')) || 48))
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
    const outputs: { key: string; at: Date }[] = []
    let token2: string | undefined
    do {
      const res = await r2.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: 'inference/outputs/', ContinuationToken: token2,
      }))
      for (const o of res.Contents ?? []) {
        if (!o.Key || !o.LastModified) continue
        if (o.LastModified.getTime() > cutoff) outputs.push({ key: o.Key, at: o.LastModified })
      }
      token2 = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token2)

    let recovered = 0
    for (const out of outputs) {
      const imageUrl = `${PUBLIC_URL}/${out.key}`
      const existing = await prisma.generatedImage.findFirst({
        where: { imageUrl }, select: { id: true },
      })
      if (existing) continue

      // Sidecar written at submit time carries prompt + full settings
      const jobId = out.key.split('/').pop()!.replace(/\.png$/i, '')
      let meta: Record<string, unknown> | null = null
      try {
        const m = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: `inference/meta/${jobId}.json` }))
        const text = await m.Body?.transformToString('utf-8')
        if (text) meta = JSON.parse(text)
      } catch { /* pre-sidecar run — fall back to a placeholder */ }

      const w = Number(meta?.width) || 0
      const h = Number(meta?.height) || 0
      await prisma.generatedImage.create({
        data: {
          userId:             sessionUser.id,
          prompt:             String(meta?.prompt || '(recovered generation)').slice(0, 5000),
          imageUrl,
          model:              'custom-flux-lora',
          ticketCost:         0,
          referenceImageUrls: [],
          createdAt:          out.at,
          expiresAt:          new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
          ...(w > 0 && h > 0 ? { aspectRatio: `${w}x${h}` } : {}),
          videoMetadata: {
            recovered: true,
            fluxWidth: w || 1024,
            fluxHeight: h || 1024,
            ...(meta?.seed !== undefined ? { fluxSeed: meta.seed } : {}),
            ...(meta?.steps !== undefined ? { fluxSteps: meta.steps } : {}),
            ...(meta?.guidance !== undefined ? { fluxGuidance: meta.guidance } : {}),
            ...(meta?.sampler ? { fluxSampler: meta.sampler } : {}),
            ...(meta?.checkpoint ? { fluxCheckpointKey: meta.checkpoint } : {}),
            ...(meta?.upscale ? { fluxUpscale: meta.upscale } : {}),
            ...(Array.isArray(meta?.pipeline_steps) ? { fluxPipelineSteps: meta.pipeline_steps } : {}),
          } as object,
        },
      })
      recovered++
    }

    return jsonPrivate({ ok: true, scanned: outputs.length, recovered })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return jsonPrivate({ error: msg }, { status: 500 })
  }
}
