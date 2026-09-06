/**
 * Move the genuinely-public assets off the private bucket.
 *
 * The site logo, home cards and profile carousel are shown to anonymous
 * visitors, so they cannot live behind a signature. R2's public access is a
 * per-bucket switch — there is no such thing as a public prefix — so they move
 * to a second, small, public bucket. Everything a user generated stays where
 * it is and goes private.
 *
 * Copies first, updates the row, and never deletes: if anything goes wrong the
 * original object is still there and the old URL still resolves.
 *
 *   node scripts/migrate-public-assets.mjs --dry-run
 *   node scripts/migrate-public-assets.mjs
 */
import fs from 'fs'
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

const DRY = process.argv.includes('--dry-run')
const PRIVATE_PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const PRIVATE_BUCKET = process.env.R2_BUCKET_NAME
const PUBLIC_BUCKET = process.env.R2_PUBLIC_BUCKET_NAME
const PUBLIC_URL = (process.env.R2_PUBLIC_ASSET_URL || '').replace(/\/$/, '')

if (!PUBLIC_BUCKET || !PUBLIC_URL) {
  console.error('Set R2_PUBLIC_BUCKET_NAME and R2_PUBLIC_ASSET_URL first (step 1 of the runbook).')
  process.exit(1)
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const isPrivate = u => typeof u === 'string' && PRIVATE_PREFIX && u.startsWith(`${PRIVATE_PREFIX}/`)
const keyOf = u => u.slice(PRIVATE_PREFIX.length + 1).split('?')[0]

async function copy(key) {
  if (DRY) return true
  // Stream through rather than CopyObject: the buckets are separate and a
  // cross-bucket copy needs the source readable by the destination's creds.
  const src = await r2.send(new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }))
  const body = Buffer.from(await src.Body.transformToByteArray())
  await r2.send(new PutObjectCommand({
    Bucket: PUBLIC_BUCKET, Key: key, Body: body,
    ContentType: src.ContentType || 'application/octet-stream',
  }))
  return true
}

async function alreadyThere(key) {
  try { await r2.send(new HeadObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key })); return true }
  catch { return false }
}

const sets = [
  { name: 'SystemState.logoUrl', field: 'logoUrl',
    load: () => prisma.systemState.findMany({ select: { id: true, logoUrl: true } }),
    save: (id, url) => prisma.systemState.update({ where: { id }, data: { logoUrl: url } }) },
  { name: 'HomeCard.mediaUrl', field: 'mediaUrl',
    load: () => prisma.homeCard.findMany({ select: { id: true, mediaUrl: true } }),
    save: (id, url) => prisma.homeCard.update({ where: { id }, data: { mediaUrl: url } }) },
  { name: 'CarouselImage.imageUrl', field: 'imageUrl',
    load: () => prisma.carouselImage.findMany({ select: { id: true, imageUrl: true } }),
    save: (id, url) => prisma.carouselImage.update({ where: { id }, data: { imageUrl: url } }) },
]

let moved = 0, skipped = 0, failed = 0
for (const set of sets) {
  const rows = await set.load()
  const todo = rows.filter(r => isPrivate(r[set.field]))
  console.log(`\n${set.name}: ${rows.length} rows, ${todo.length} on the private bucket`)
  for (const row of todo) {
    const key = keyOf(row[set.field])
    try {
      if (!DRY && await alreadyThere(key)) {
        console.log(`  = ${key} (already on the public bucket)`)
      } else {
        await copy(key)
      }
      if (!DRY) await set.save(row.id, `${PUBLIC_URL}/${key}`)
      moved++
      console.log(`  ${DRY ? '~' : '+'} ${key}`)
    } catch (e) {
      failed++
      console.log(`  ! ${key} — ${String(e.message).slice(0, 80)}`)
    }
  }
  skipped += rows.length - todo.length
}

console.log(`\n${DRY ? 'DRY RUN — nothing written. ' : ''}moved ${moved}, already public ${skipped}, failed ${failed}`)
if (failed) console.log('Fix the failures before switching public access off — those assets would go dark.')
await prisma.$disconnect()
