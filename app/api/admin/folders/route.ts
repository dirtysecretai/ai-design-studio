import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import { jsonPrivate } from '@/lib/api-json'

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv)$/i


// ?fast=1 skips the per-folder preview queries — instant catalog, previews
// hydrated by a follow-up full GET.
export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })
  const fast = new URL(req.url).searchParams.get('fast') === '1'
  const folders = await prisma.datasetBucketFolder.findMany({ orderBy: { createdAt: 'asc' } })

  // Collect up to 4 direct preview URLs per folder from its direct buckets.
  // BOUNDED per-folder query (take: 40) — a single unbounded findMany across all
  // foldered buckets returned ~57k rows / 7.24MB and blew Prisma Accelerate's 5MB
  // cap (P6009), which 500'd this route and made every folder vanish from the UI.
  // Mirrors the per-bucket pattern in app/api/admin/buckets/route.ts.
  const previewMap = new Map<number, string[]>()
  if (!fast && folders.length > 0) {
    await Promise.all(folders.map(async f => {
      const rows = await prisma.datasetBucketImage.findMany({
        where: { bucket: { folderId: f.id } },
        select: { imageId: true, image: { select: { imageUrl: true } } },
        orderBy: { imageId: 'asc' },
        take: 40,
      })
      // 400px thumb endpoint, not full originals — full-size preview decodes
      // were crashing iPad Safari (see buckets route)
      previewMap.set(f.id, rows
        .filter(r => !VIDEO_RE.test(r.image.imageUrl))
        .slice(0, 4)
        .map(r => `/api/admin/dataset/thumb/${r.imageId}`))
    }))
  }

  return jsonPrivate(
    folders.map(f => ({ ...f, previewUrls: previewMap.get(f.id) ?? [] })),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })
  const { name, parentId } = await req.json() as { name: string; parentId?: number | null }
  if (!name?.trim()) return jsonPrivate({ error: 'name required' }, { status: 400 })
  const folder = await prisma.datasetBucketFolder.create({ data: { name: name.trim(), parentId: parentId ?? null } })
  return jsonPrivate(folder, { status: 201 })
}
