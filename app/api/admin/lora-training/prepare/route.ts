import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fal } from '@fal-ai/client'
import archiver from 'archiver'
import fs from 'fs'
import path from 'path'
import { finished } from 'stream/promises'
import sharp from 'sharp'
import { composeTrainingCaption, normalizeCaptionSections } from '@/lib/caption-compose'

export const maxDuration = 300

function authOk(req: NextRequest) {
  const pass = process.env.ADMIN_PASSWORD
  // Fail closed: a missing ADMIN_PASSWORD must deny, not allow
  if (!pass) return false
  return req.headers.get('x-admin-password') === pass
}

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = pathname.split('.').pop()?.toLowerCase()
    if (ext && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext
    }
  } catch { /* ignore */ }
  return 'jpg'
}

function buildFalInput(modelId: string, config: Record<string, unknown>): Record<string, unknown> {
  if (modelId === 'fal-ai/flux-2-trainer') {
    const input: Record<string, unknown> = {}
    if (config.steps              !== undefined) input.steps              = Number(config.steps)
    if (config.learning_rate      !== undefined) input.learning_rate      = Number(config.learning_rate)
    if (config.default_caption    !== undefined && config.default_caption !== '') input.default_caption    = String(config.default_caption)
    if (config.output_lora_format !== undefined) input.output_lora_format = String(config.output_lora_format)
    return input
  }
  if (modelId === 'fal-ai/flux-2-trainer/edit') {
    const input: Record<string, unknown> = {}
    if (config.steps              !== undefined) input.steps              = Number(config.steps)
    if (config.learning_rate      !== undefined) input.learning_rate      = Number(config.learning_rate)
    if (config.default_caption    !== undefined && config.default_caption !== '') input.default_caption    = String(config.default_caption)
    if (config.output_lora_format !== undefined) input.output_lora_format = String(config.output_lora_format)
    return input
  }
  if (modelId === 'fal-ai/flux-lora-fast-training') {
    const input: Record<string, unknown> = {}
    if (config.steps         !== undefined) input.steps         = Number(config.steps)
    if (config.learning_rate !== undefined) input.learning_rate = Number(config.learning_rate)
    if (config.trigger_word  !== undefined && config.trigger_word !== '') input.trigger_word = String(config.trigger_word)
    return input
  }
  if (modelId === 'fal-ai/z-image-turbo-trainer-v2' || modelId === 'fal-ai/z-image-base-trainer') {
    const input: Record<string, unknown> = {}
    if (config.steps           !== undefined) input.steps           = Number(config.steps)
    if (config.learning_rate   !== undefined) input.learning_rate   = Number(config.learning_rate)
    if (config.default_caption !== undefined && config.default_caption !== '') input.default_caption = String(config.default_caption)
    return input
  }
  return { ...config }
}

async function setProgress(jobId: number, msg: string) {
  console.log(`[lora/prepare] job ${jobId}: ${msg}`)
  // 3s timeout — a hanging Prisma connection must never block the main flow
  await Promise.race([
    prisma.loraTrainingJob.update({ where: { id: jobId }, data: { errorMsg: msg } }),
    new Promise<void>(resolve => setTimeout(resolve, 1_000)),
  ]).catch(() => {})
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let jobId: number
  try {
    const body = await req.json() as { jobId: number }
    jobId = body.jobId
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const job = await prisma.loraTrainingJob.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (job.status !== 'preparing') return NextResponse.json({ ok: true, skipped: true })

  const zipPath = path.join('/tmp', `lora-${jobId}.zip`)

  try {
    const config = job.config as Record<string, unknown>

    // Edit trainer: user uploads their own paired ZIP — skip download/build step
    if (job.modelId === 'fal-ai/flux-2-trainer/edit') {
      const zipUrl = config._zipUrl ? String(config._zipUrl) : null
      if (!zipUrl) throw new Error('No _zipUrl in config for edit trainer')

      await setProgress(jobId, 'Submitting edit trainer ZIP to FAL...')
      fal.config({ credentials: process.env.FAL_KEY! })

      const falInput = buildFalInput(job.modelId, config)
      const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://prompt-protocol.vercel.app'}/api/webhooks/fal`
      const submission = await fal.queue.submit(job.modelId, {
        input: { image_data_url: zipUrl, ...falInput },
        webhookUrl,
      })

      await prisma.loraTrainingJob.update({
        where: { id: jobId },
        data: { requestId: submission.request_id, status: 'queued', errorMsg: null },
      })

      return NextResponse.json({ ok: true, requestId: submission.request_id })
    }

    const defaultCaption = config.default_caption ? String(config.default_caption) : ''
    const imageIds = Array.isArray(config._imageIds) ? (config._imageIds as number[]) : []

    await setProgress(jobId, 'Fetching image list...')

    // prompt/tags/captionSections ride along so composable caption sections
    // (per-image toggles) are honored in the training txt
    const imgSelect = { id: true, imageUrl: true, adminCaption: true, prompt: true, adminTags: true, captionSections: true } as const
    const images = imageIds.length > 0
      ? await prisma.generatedImage.findMany({
          where: { id: { in: imageIds } },
          select: imgSelect,
        })
      : await prisma.generatedImage.findMany({
          where: { isDeleted: false, markedForTraining: true },
          orderBy: { createdAt: 'desc' },
          select: imgSelect,
        })

    if (images.length === 0) {
      throw new Error('No images found')
    }

    await setProgress(jobId, `Found ${images.length} images — building ZIP...`)

    fal.config({ credentials: process.env.FAL_KEY! })

    // Stream ZIP directly to /tmp — each image buffer is written to disk and freed immediately
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { store: true })
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') console.error('[archiver] warning:', err) })
    archive.on('error', (err) => { console.error('[archiver] error:', err) })
    archive.pipe(output)

    let downloaded = 0
    let skipped = 0
    const BATCH = 20

    for (let i = 0; i < images.length; i += BATCH) {
      const batch = images.slice(i, i + BATCH)

      // Resize to max 1024px, preserve original format (PNG stays PNG to avoid JPEG artifacts)
      const results = await Promise.all(batch.map(async (img) => {
        try {
          const res = await fetch(img.imageUrl, { signal: AbortSignal.timeout(15_000) })
          if (!res.ok) return null
          const rawBuf = Buffer.from(await res.arrayBuffer())
          const meta = await sharp(rawBuf).metadata()
          const isPng = meta.format === 'png'
          const buf = isPng
            ? await sharp(rawBuf)
                .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
                .png({ compressionLevel: 6 })
                .toBuffer()
            : await sharp(rawBuf)
                .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 95 })
                .toBuffer()
          const ext = isPng ? 'png' : 'jpg'
          const caption = composeTrainingCaption({
            adminCaption: img.adminCaption,
            prompt: img.prompt,
            adminTags: img.adminTags,
            sections: normalizeCaptionSections(img.captionSections),
            fallbackCaption: defaultCaption,
          })
          return { name: `${img.id}.${ext}`, buf, caption, id: img.id }
        } catch { return null }
      }))

      // Append each result to archive — archiver writes to disk and frees the buffer
      for (const r of results) {
        if (!r) { skipped++; continue }
        archive.append(r.buf, { name: r.name })
        if (r.caption) archive.append(Buffer.from(r.caption), { name: `${r.id}.txt` })
        downloaded++
      }

      const processed = downloaded + skipped
      await setProgress(jobId, `Downloading: ${downloaded} ok, ${skipped} skipped (${processed}/${images.length})`)
    }

    await setProgress(jobId, `Download complete: ${downloaded} ok, ${skipped} skipped — finalizing ZIP...`)
    await archive.finalize()
    await finished(output)

    // Upload zip from disk — read once into memory for upload
    const zipBuffer = await fs.promises.readFile(zipPath)
    const zipMB = (zipBuffer.length / 1024 / 1024).toFixed(1)
    await setProgress(jobId, `Uploading ${zipMB}MB ZIP to FAL storage...`)

    const zipFile = new File([new Uint8Array(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength)], 'training.zip', { type: 'application/zip' })
    const zipUrl = await fal.storage.upload(zipFile)

    await setProgress(jobId, 'Submitting to FAL training queue...')
    const falInput = buildFalInput(job.modelId, config)
    const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://prompt-protocol.vercel.app'}/api/webhooks/fal`
    // Field name differs per model: flux-lora-fast-training uses images_data_url (plural)
    const zipKey = job.modelId === 'fal-ai/flux-lora-fast-training' ? 'images_data_url' : 'image_data_url'
    const submission = await fal.queue.submit(job.modelId, {
      input: { [zipKey]: zipUrl, ...falInput },
      webhookUrl,
    })

    await prisma.loraTrainingJob.update({
      where: { id: jobId },
      data: { requestId: submission.request_id, status: 'queued', errorMsg: null },
    })

    // Clean up temp file
    fs.promises.unlink(zipPath).catch(() => {})

    return NextResponse.json({ ok: true, requestId: submission.request_id })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[lora/prepare] job ${jobId} failed:`, msg)
    fs.promises.unlink(zipPath).catch(() => {})
    await prisma.loraTrainingJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorMsg: msg },
    }).catch((e: unknown) => console.error('[lora/prepare] failed to mark job failed:', e))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
