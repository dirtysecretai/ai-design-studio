/**
 * Pull the panorama out of a Hunyuan World archive and make it the preview.
 *
 * Hunyuan World returns a ZIP: several `mesh_layerN.ply` at 86MB to 561MB
 * each, plus the panorama images it built the world from. The layers are far
 * too large for a browser, so the viewer had nothing to show and the whole
 * render looked like a dead end — when the most useful part of it, the
 * panorama, is a 12MB PNG sitting inside the same file.
 *
 * The archive is never downloaded. ZIP keeps its index at the END of the file,
 * so the central directory is read with one ranged request, the single wanted
 * entry is located, and only that entry's bytes are fetched and inflated. On a
 * 563MB archive that is ~13MB of transfer instead of 563MB.
 *
 *   node scripts/extract-world-panoramas.mjs --dry-run
 *   node scripts/extract-world-panoramas.mjs
 */
import fs from 'fs'
import zlib from 'zlib'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')

const PUBLIC_PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const range = async (url, start, end) => {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120000) })
  if (res.status !== 206) throw new Error(`range not supported (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** Read the central directory without fetching the archive. */
async function listEntries(url) {
  const head = await fetch(url, { method: 'HEAD' })
  const size = Number(head.headers.get('content-length'))
  const tailLen = Math.min(size, 65536)
  const tail = await range(url, size - tailLen, size - 1)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('no end-of-central-directory (zip64 or truncated)')

  const count = tail.readUInt16LE(eocd + 10)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cdStart = cdOffset - (size - tailLen)
  const cd = cdStart >= 0 ? tail.subarray(cdStart) : await range(url, cdOffset, size - 1)

  const entries = []
  let o = 0
  for (let k = 0; k < count && o + 46 <= cd.length; k++) {
    if (cd.readUInt32LE(o) !== 0x02014b50) break
    const method = cd.readUInt16LE(o + 10)
    const compSize = cd.readUInt32LE(o + 20)
    const uncSize = cd.readUInt32LE(o + 24)
    const nameLen = cd.readUInt16LE(o + 28)
    const extraLen = cd.readUInt16LE(o + 30)
    const cmtLen = cd.readUInt16LE(o + 32)
    const localOffset = cd.readUInt32LE(o + 42)
    entries.push({
      name: cd.subarray(o + 46, o + 46 + nameLen).toString('utf8'),
      method, compSize, uncSize, localOffset,
    })
    o += 46 + nameLen + extraLen + cmtLen
  }
  return { size, entries }
}

/** Fetch and inflate exactly one entry. */
async function readEntry(url, entry) {
  // The local header repeats the name and extra field, and its extra field
  // length can differ from the central directory's — so it must be read
  // rather than assumed.
  const lh = await range(url, entry.localOffset, entry.localOffset + 29)
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header')
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  const raw = await range(url, dataStart, dataStart + entry.compSize - 1)
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`unsupported compression method ${entry.method}`)
}

// Best panorama first: the super-resolution one if present, else the plain.
const WANT = ['full_image_sr.png', 'full_image.png', 'image.png', 'sky_image_sr.png']

const rows = await prisma.generatedImage.findMany({
  where: { model: '3d:hunyuan-world', isDeleted: false },
  select: { id: true, imageUrl: true, videoMetadata: true },
  orderBy: { id: 'desc' },
})
console.log(`${rows.length} Hunyuan World asset(s)\n`)

let done = 0, skipped = 0, failed = 0
for (const row of rows) {
  const meta = row.videoMetadata ?? {}
  const t = meta.threed ?? {}
  if (t.preview) { skipped++; console.log(`  ${row.id} — already has a preview`); continue }
  const zip = (t.files ?? []).find(f => /\.zip(\?|$)/i.test(f.url))
  if (!zip) { skipped++; console.log(`  ${row.id} — no archive`); continue }

  try {
    const { size, entries } = await listEntries(zip.url)
    const pick = WANT.map(w => entries.find(e => e.name.endsWith(w))).find(Boolean)
    if (!pick) {
      failed++
      console.log(`  ${row.id} — no panorama among: ${entries.map(e => e.name).join(', ')}`)
      continue
    }
    console.log(`  ${row.id} — ${(size / 1e6).toFixed(0)}MB archive → ${pick.name} (${(pick.uncSize / 1e6).toFixed(1)}MB, fetching ${(pick.compSize / 1e6).toFixed(1)}MB)`)
    if (DRY) { done++; continue }

    const png = await readEntry(zip.url, pick)
    const key = `world-preview/${row.id}.png`
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: png, ContentType: 'image/png',
    }))
    const url = `${PUBLIC_PREFIX}/${key}`

    await prisma.generatedImage.update({
      where: { id: row.id },
      data: {
        imageUrl: url,
        videoMetadata: {
          ...meta,
          threed: {
            ...t,
            preview: url,
            files: [...(t.files ?? []), { url, kind: 'preview' }],
            // What is in the archive, so the UI can say so without re-reading it.
            archive: entries.map(e => ({ name: e.name, bytes: e.uncSize })),
          },
        },
      },
    })
    done++
  } catch (e) {
    failed++
    console.log(`  ${row.id} — ${String(e.message).slice(0, 100)}`)
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written. ' : ''}extracted ${done}, skipped ${skipped}, failed ${failed}`)
await prisma.$disconnect()
