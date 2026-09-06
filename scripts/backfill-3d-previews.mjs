/**
 * Re-harvest finished 3D jobs with the widened output map.
 *
 * The original harvest only knew a handful of output field names, so several
 * models' preview renders were dropped on the floor — TripoSplat's
 * `preprocessed_image`, SAM3's `visualization`, VGGT's GLB point cloud. The
 * effect was a finished asset with nothing to show, which the viewer then
 * reported as an empty bench.
 *
 * fal still serves the results, so the previews can be recovered rather than
 * regenerated. Additive only: existing files are kept, new ones are merged in
 * by URL, and nothing is removed.
 *
 *   node scripts/backfill-3d-previews.mjs --dry-run
 *   node scripts/backfill-3d-previews.mjs
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

// Kept in step with harvest() in app/api/admin/threed/route.ts.
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

const rows = await prisma.generatedImage.findMany({
  where: { model: { startsWith: '3d:' }, isDeleted: false },
  select: { id: true, model: true, imageUrl: true, falRequestId: true, videoMetadata: true },
  orderBy: { id: 'desc' },
})
console.log(`${rows.length} 3D assets\n`)

let gained = 0, unchanged = 0, gone = 0
for (const r of rows) {
  const meta = r.videoMetadata ?? {}
  const t = meta.threed
  if (!t?.endpoint || !r.falRequestId) { gone++; continue }

  const res = await fetch(`https://queue.fal.run/${base(t.endpoint)}/requests/${r.falRequestId}`, {
    headers: { Authorization: `Key ${process.env.FAL_KEY}` }, signal: AbortSignal.timeout(20000),
  }).catch(() => null)
  if (!res?.ok) { gone++; continue }

  const fresh = harvest(await res.json())
  const have = new Set((t.files ?? []).map(f => f.url))
  const added = fresh.filter(f => !have.has(f.url))
  if (added.length === 0) { unchanged++; continue }

  const files = [...(t.files ?? []), ...added]
  const preview = files.find(f => f.kind === 'preview')?.url ?? t.preview ?? null
  gained++
  console.log(`  ${r.id} ${r.model.padEnd(26)} +${added.length}: ${added.map(a => a.kind).join(', ')}${preview && !t.preview ? '  (now has a preview)' : ''}`)

  if (!DRY) {
    await prisma.generatedImage.update({
      where: { id: r.id },
      data: {
        // The tile shows imageUrl; point it at the preview only if it was
        // previously falling back to the mesh file itself.
        imageUrl: preview ?? r.imageUrl,
        videoMetadata: { ...meta, threed: { ...t, files, preview } },
      },
    })
  }
}
console.log(`\n${DRY ? 'DRY RUN — nothing written. ' : ''}gained ${gained}, already complete ${unchanged}, unreadable at fal ${gone}`)
await prisma.$disconnect()
