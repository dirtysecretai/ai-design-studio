/**
 * Build parallax layers for Hunyuan World assets that predate the feature.
 *
 * New worlds get these at settle time. This is for the ones already in the
 * library, whose archives are still readable at fal / on R2.
 *
 *   node scripts/backfill-world-layers.mjs --dry-run
 *   node scripts/backfill-world-layers.mjs
 */
import fs from 'fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { PrismaClient } = await import('@prisma/client')

/*
 * Node's type stripping does not resolve extensionless TypeScript imports the
 * way the bundler does, so lib/world-layers.ts cannot simply be imported here.
 * Patched copies are written beside it rather than changing the library to
 * suit a script — the app is the thing that has to stay correct.
 */
const shimDir = '.tmp-world-layers'
fs.mkdirSync(shimDir, { recursive: true })
fs.copyFileSync('lib/zip-peek.ts', `${shimDir}/zip-peek.ts`)
fs.writeFileSync(
  `${shimDir}/world-layers.ts`,
  fs.readFileSync('lib/world-layers.ts', 'utf8').replace("from './zip-peek'", "from './zip-peek.ts'"),
)
const { buildWorldLayers } = await import(`../${shimDir}/world-layers.ts`)
process.on('exit', () => { try { fs.rmSync(shimDir, { recursive: true, force: true }) } catch {} })

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')
// Rebuild layers that already exist — used when the layering itself improves.
const FORCE = process.argv.includes('--force')

const PUBLIC_PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const r2 = new S3Client({
  region: 'auto', endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
const put = async (key, body, type) => {
  await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: body, ContentType: type }))
  return `${PUBLIC_PREFIX}/${key}`
}

const rows = await prisma.generatedImage.findMany({
  where: { model: '3d:hunyuan-world', isDeleted: false },
  select: { id: true, videoMetadata: true }, orderBy: { id: 'desc' },
})
console.log(`${rows.length} world(s)\n`)

let built = 0, skipped = 0, failed = 0
for (const row of rows) {
  const meta = row.videoMetadata ?? {}
  const t = meta.threed ?? {}
  if (t.layers?.length > 1 && !FORCE) { skipped++; console.log(`  ${row.id} — already has layers (--force to rebuild)`); continue }
  const zip = (t.files ?? []).find(f => /\.zip(\?|$)/i.test(f.url))
  if (!zip) { skipped++; console.log(`  ${row.id} — no archive`); continue }

  try {
    const t0 = Date.now()
    const { layers, entries } = await buildWorldLayers(zip.url)
    if (!layers.some(l => l.role === 'subject' || l.role === 'scene')) {
      skipped++
      console.log(`  ${row.id} — nothing cut out to move; leaving the flat preview`)
      continue
    }
    const bytes = layers.reduce((n, l) => n + l.webp.length, 0)
    console.log(`  ${row.id} — ${layers.length} layers, ${(bytes / 1024).toFixed(0)}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s: ${layers.map(l => l.label ?? l.role).join(' → ')}`)
    if (DRY) { built++; continue }

    const stored = []
    for (const [i, l] of layers.entries()) {
      stored.push({
        url: await put(`world-layers/${row.id}-${i}-${l.role}.webp`, l.webp, 'image/webp'),
        role: l.role, depth: l.depth, label: l.label,
      })
    }
    await prisma.generatedImage.update({
      where: { id: row.id },
      data: { videoMetadata: { ...meta, threed: { ...t, layers: stored, archive: t.archive ?? entries } } },
    })
    built++
  } catch (e) {
    failed++
    console.log(`  ${row.id} — ${String(e.message).slice(0, 100)}`)
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written. ' : ''}built ${built}, skipped ${skipped}, failed ${failed}`)
await prisma.$disconnect()
