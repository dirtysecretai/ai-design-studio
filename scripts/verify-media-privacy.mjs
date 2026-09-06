/**
 * Prove the media actually went private.
 *
 * Run it BEFORE switching public access off to see the exposure, and AFTER to
 * confirm it is closed. It re-runs the exact unauthenticated fetches that
 * demonstrated the problem: a generated image, a reference, and the sequential
 * thumbnail key that made the reference library enumerable.
 *
 *   node scripts/verify-media-privacy.mjs
 */
import fs from 'fs'
import { createHmac } from 'crypto'

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

const PREFIX = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
const MEDIA_HOST = (process.env.MEDIA_HOST || '').replace(/\/$/, '')
const SECRET = process.env.MEDIA_SIGNING_SECRET || ''
const PUBLIC_ASSET_URL = (process.env.R2_PUBLIC_ASSET_URL || '').replace(/\/$/, '')

function signed(storedUrl, ttl = 3600) {
  const key = storedUrl.slice(PREFIX.length + 1).split('?')[0]
  const exp = (Math.floor(Date.now() / 1000 / 3600) + Math.ceil(ttl / 3600)) * 3600
  const sig = createHmac('sha256', SECRET).update(`${key}\n${exp}`).digest('base64url')
  return `${MEDIA_HOST}/${key}?exp=${exp}&sig=${sig}`
}

const status = async (url, opts) => {
  try { return (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000), ...opts })).status }
  catch { return 'ERR' }
}

let bad = 0
const shouldFail = async (label, url) => {
  const s = await status(url)
  const ok = s === 401 || s === 403 || s === 404
  if (!ok) bad++
  console.log(`  ${ok ? 'private ' : 'EXPOSED '} ${String(s).padEnd(4)} ${label}`)
}
const shouldWork = async (label, url) => {
  const s = await status(url)
  if (s !== 200) bad++
  console.log(`  ${s === 200 ? 'ok      ' : 'BROKEN  '} ${String(s).padEnd(4)} ${label}`)
}

const [gen] = await prisma.generatedImage.findMany({ where: { isDeleted: false }, select: { imageUrl: true }, orderBy: { id: 'desc' }, take: 1 })
const [ref] = await prisma.userReference.findMany({ where: { isCleared: false }, select: { id: true, url: true }, orderBy: { id: 'desc' }, take: 1 })

console.log('\nUnauthenticated, straight at the bucket — these must all be refused:')
if (gen) await shouldFail('a generated image', gen.imageUrl)
if (ref) await shouldFail('a reference original', ref.url)
if (ref) await shouldFail('the enumerable thumbnail key', `${PREFIX}/ref-thumb/${ref.id}.webp`)

if (MEDIA_HOST && SECRET) {
  console.log('\nThrough the media Worker — a valid signature must work, a bad one must not:')
  if (gen) await shouldWork('correctly signed', signed(gen.imageUrl))
  if (gen) await shouldFail('signature tampered', signed(gen.imageUrl).replace(/sig=.$/, 'sig=x'))
  if (gen) {
    const u = new URL(signed(gen.imageUrl))
    u.searchParams.set('exp', '1000')
    await shouldFail('expired link', u.toString())
  }
  if (gen) await shouldFail('no signature at all', `${MEDIA_HOST}/${gen.imageUrl.slice(PREFIX.length + 1)}`)
} else {
  console.log('\n(MEDIA_HOST / MEDIA_SIGNING_SECRET not set — skipping the Worker checks)')
}

if (PUBLIC_ASSET_URL) {
  const logo = await prisma.systemState.findFirst({ select: { logoUrl: true } })
  if (logo?.logoUrl?.startsWith(PUBLIC_ASSET_URL)) {
    console.log('\nPublic assets — these must STAY reachable:')
    await shouldWork('site logo', logo.logoUrl)
  }
}

console.log(bad === 0 ? '\nAll checks passed.' : `\n${bad} check(s) failed — see above.`)
await prisma.$disconnect()
process.exit(bad === 0 ? 0 : 1)
