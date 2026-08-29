// One-off: the Virtual Try-On runs made before the aspect fix stored the
// route's default '16:9', so the feed cropped them into a landscape sliver.
// Their real shape follows the person photo, which 'auto' tells the feed to
// measure. Run with --apply to write; without it, this only reports.
//
//   node scripts/fix-tryon-aspect.mjs            (dry run)
//   node scripts/fix-tryon-aspect.mjs --apply
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'

// .env.local is not loaded outside Next
// .env.local OVERRIDES: @prisma/client auto-loads .env, which holds an older
// PRISMA_DATABASE_URL here — Next gives .env.local precedence and so must this.
// Split on /\r?\n/ and trim, or a trailing \r from CRLF lands inside the value
// and silently invalidates the key.
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const apply = process.argv.includes('--apply')
const prisma = new PrismaClient()

const rows = await prisma.generatedImage.findMany({
  where: { model: 'google-virtual-try-on', isDeleted: false },
  select: { id: true, userId: true, aspectRatio: true, quality: true, createdAt: true, imageUrl: true },
  orderBy: { createdAt: 'desc' },
})

console.log(`found ${rows.length} virtual try-on generations`)
for (const r of rows) {
  console.log(
    `  #${r.id}  user=${r.userId}  aspect=${r.aspectRatio ?? 'null'}  ${r.createdAt.toISOString()}  ${r.imageUrl.slice(-40)}`
  )
}

const stale = rows.filter(r => r.aspectRatio !== 'auto')
console.log(`\n${stale.length} would change to 'auto'`)

if (!apply) {
  console.log("dry run — re-run with --apply to write")
} else if (stale.length > 0) {
  const res = await prisma.generatedImage.updateMany({
    where: { id: { in: stale.map(r => r.id) } },
    data: { aspectRatio: 'auto' },
  })
  console.log(`updated ${res.count} rows`)
}

await prisma.$disconnect()
