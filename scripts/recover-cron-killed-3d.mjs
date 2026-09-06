/**
 * Recover 3D jobs the drain-queue cron killed by mistake.
 *
 * The cron read `parameters.falEndpoint`; the 3D route writes
 * `parameters.endpoint`. With no endpoint to check, verifyWithFal took its
 * "never submitted → safe to fail" shortcut and failed the job at twelve
 * minutes WITHOUT ever asking fal. Every one of these had in fact completed —
 * the renders were paid for and then discarded.
 *
 * fal still serves the results, so they can be reclaimed rather than re-run.
 * Idempotent: a job whose asset already exists is skipped.
 *
 *   node scripts/recover-cron-killed-3d.mjs --dry-run
 *   node scripts/recover-cron-killed-3d.mjs
 */
import fs from 'fs'
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')
const base = ep => ep.split('/').slice(0, 2).join('/')

function harvest(data) {
  const out = []
  const push = (v, kind) => {
    const url = typeof v === 'string' ? v : v?.url
    if (typeof url === 'string' && url.startsWith('http')) out.push({ url, kind })
  }
  push(data.model_mesh, 'mesh'); push(data.pbr_model, 'pbr'); push(data.base_model, 'base')
  push(data.model_glb, 'glb'); push(data.model_url, 'mesh'); push(data.mesh, 'mesh')
  push(data.world_file, 'world')
  push(data.rigged_character_glb, 'rigged-glb'); push(data.rigged_character_fbx, 'rigged-fbx')
  push(data.animation_glb, 'anim-glb'); push(data.animation_fbx, 'anim-fbx')
  push(data.fbx_file, 'anim-fbx'); push(data.motion_json, 'motion')
  push(data.point_cloud, 'glb')
  push(data.rendered_image, 'preview'); push(data.preprocessed_image, 'preview')
  push(data.visualization, 'preview'); push(data.image, 'preview')
  if (Array.isArray(data.images)) data.images.forEach(i => push(i, 'preview'))
  if (Array.isArray(data.meshes)) data.meshes.forEach(m => push(m, 'mesh'))
  if (data.model_urls && typeof data.model_urls === 'object') {
    for (const [name, v] of Object.entries(data.model_urls)) push(v, name)
  }
  return out
}

const jobs = await prisma.generationQueue.findMany({
  where: { modelType: 'threed', status: 'failed', errorMessage: { startsWith: 'Auto-reset by cron' } },
  select: { id: true, userId: true, modelId: true, prompt: true, falRequestId: true, parameters: true, createdAt: true },
  orderBy: { id: 'asc' },
})
console.log(`${jobs.length} cron-killed 3D job(s)\n`)

let recovered = 0, already = 0, lost = 0
for (const job of jobs) {
  const params = job.parameters ?? {}
  const ep = params.endpoint
  if (!ep || !job.falRequestId) { lost++; console.log(`  ${job.id} — no endpoint/request id`); continue }

  const existing = await prisma.generatedImage.findFirst({ where: { falRequestId: job.falRequestId }, select: { id: true } })
  if (existing) { already++; console.log(`  ${job.id} ${job.modelId} — already saved as ${existing.id}`); continue }

  const res = await fetch(`https://queue.fal.run/${base(ep)}/requests/${job.falRequestId}`, {
    headers: { Authorization: `Key ${process.env.FAL_KEY}` }, signal: AbortSignal.timeout(30000),
  }).catch(() => null)
  if (!res?.ok) { lost++; console.log(`  ${job.id} ${job.modelId} — result gone (${res?.status ?? 'ERR'})`); continue }

  const files = harvest(await res.json())
  if (files.length === 0) { lost++; console.log(`  ${job.id} ${job.modelId} — no usable file`); continue }

  const preview = files.find(f => f.kind === 'preview')?.url ?? null
  const primary = files.find(f => f.kind !== 'preview')?.url ?? files[0].url
  recovered++
  console.log(`  ${job.id} ${job.modelId.padEnd(16)} + ${files.length} file(s): ${files.map(f => f.kind).join(', ')}`)

  if (!DRY) {
    await prisma.generatedImage.create({
      data: {
        userId: job.userId,
        prompt: job.prompt,
        imageUrl: preview ?? primary,
        model: `3d:${job.modelId}`,
        ticketCost: 0,
        referenceImageUrls: Array.isArray(params.referenceImageUrls) ? params.referenceImageUrls : [],
        expiresAt: new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
        falRequestId: job.falRequestId,
        createdAt: job.createdAt,
        videoMetadata: { threed: { endpoint: ep, preview, files, usd: params.usd ?? null } },
      },
    })
    await prisma.generationQueue.update({
      where: { id: job.id },
      data: { status: 'completed', errorMessage: null, completedAt: new Date() },
    })
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written. ' : ''}recovered ${recovered}, already saved ${already}, unrecoverable ${lost}`)
await prisma.$disconnect()
