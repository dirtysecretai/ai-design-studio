/**
 * One-off: build the R2 thumbnail for every reference that lacks one.
 *
 * The route makes these on demand, but on-demand means the FIRST person to
 * open the Refs dropdown after this change pays for all 413 of them one tile
 * at a time. Doing it here means the dropdown is fast the first time it opens.
 * Safe to re-run: an existing thumbnail is skipped, never rewritten.
 */
import fs from 'fs'
import sharp from 'sharp'
for (const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'')
}
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

const LIMIT = Number(process.argv[2] || 0) || Infinity
const refs = await prisma.userReference.findMany({
  where: { isCleared: false }, select: { id: true, url: true }, orderBy: { id: 'desc' },
})
const pub = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// R2 client, same shape as lib/r2.ts (this is a plain node script, no TS loader)
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3')
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
const BUCKET = process.env.R2_BUCKET_NAME

let made = 0, had = 0, gone = 0, failed = 0, done = 0
const todo = refs.slice(0, LIMIT === Infinity ? refs.length : LIMIT)

/**
 * Read an object through the S3 API rather than its URL.
 *
 * This script runs outside Next, so it does not get the signing that
 * instrumentation.ts installs on the server's fetch — and the bucket no longer
 * answers unauthenticated GETs. It has the R2 credentials, so it can just ask
 * the bucket directly, which is simpler than signing anyway.
 */
async function getObject(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return Buffer.from(await res.Body.transformToByteArray())
}

async function one(ref) {
  const key = `ref-thumb/${ref.id}.webp`
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    had++; return
  } catch {}
  try {
    const srcKey = ref.url.startsWith(pub + '/') ? ref.url.slice(pub.length + 1) : null
    let buf
    if (srcKey) {
      try { buf = await getObject(srcKey) } catch { gone++; return }
    } else {
      const src = await fetch(ref.url, { signal: AbortSignal.timeout(40000) })
      if (!src.ok) { gone++; return }
      buf = Buffer.from(await src.arrayBuffer())
    }
    const thumb = await sharp(buf).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer()
    await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: thumb, ContentType: 'image/webp' }))
    made++
  } catch (e) {
    failed++
    if (failed <= 5) console.log('  fail', ref.id, String(e.message).slice(0, 70))
  } finally {
    if (++done % 50 === 0) console.log(`  ${done}/${todo.length} — made ${made}, had ${had}, gone ${gone}, failed ${failed}`)
  }
}

const CONC = 6
const queue = [...todo]
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) await one(queue.shift())
}))
console.log(`\nDONE ${done}: made ${made}, already had ${had}, source gone ${gone}, failed ${failed}`)
await prisma.$disconnect()
