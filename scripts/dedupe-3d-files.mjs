/** Remove duplicate file entries the widened harvest introduced (same url, two kinds). */
import fs from 'fs'
for (const l of fs.readFileSync('.env.local','utf8').split(/\r?\n/)) { const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2].replace(/^["']|["']$/g,'') }
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')
const rows = await prisma.generatedImage.findMany({
  where: { model: { startsWith: '3d:' }, isDeleted: false },
  select: { id: true, model: true, videoMetadata: true }, orderBy: { id: 'desc' },
})
let fixed = 0
for (const r of rows) {
  const meta = r.videoMetadata ?? {}
  const t = meta.threed
  const files = t?.files ?? []
  const seen = new Set()
  const clean = files.filter(f => !seen.has(f.url) && (seen.add(f.url), true))
  if (clean.length === files.length) continue
  fixed++
  console.log(`  ${r.id} ${r.model.padEnd(24)} ${files.length} → ${clean.length}`)
  if (!DRY) {
    await prisma.generatedImage.update({ where: { id: r.id }, data: { videoMetadata: { ...meta, threed: { ...t, files: clean } } } })
  }
}
console.log(`\n${DRY ? 'DRY RUN. ' : ''}${fixed} row(s) with duplicates`)
await prisma.$disconnect()
