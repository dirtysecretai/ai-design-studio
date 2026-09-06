import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import { jsonPrivate } from '@/lib/api-json'

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv)$/i


// GET — list all buckets with image counts and direct preview URLs (no proxy).
// ?fast=1 skips the per-bucket preview queries (one findMany total) so the
// catalog renders instantly; callers hydrate previews with a follow-up full GET.
export async function GET(req: Request) {
  if (!checkAuth(req)) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })
  const fast = new URL(req.url).searchParams.get('fast') === '1'

  const buckets = await prisma.datasetBucket.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { images: true } } },
  })

  // Fetch up to 4 preview URLs per bucket concurrently (avoids slow N+1 serial queries)
  const previewMap = new Map<number, string[]>()
  if (!fast && buckets.length > 0) {
    await Promise.all(buckets.map(async b => {
      const rows = await prisma.datasetBucketImage.findMany({
        where: { bucketId: b.id },
        select: { imageId: true, image: { select: { imageUrl: true } } },
        orderBy: { imageId: 'asc' },
        take: 8,
      })
      // Serve the 400px thumb endpoint, NOT the full originals — 4 full-size
      // decodes per card across a screen of cards blew iPad Safari's memory
      // and force-restarted the tab
      const urls = rows
        .filter(r => !VIDEO_RE.test(r.image.imageUrl))
        .slice(0, 4)
        .map(r => `/api/admin/dataset/thumb/${r.imageId}`)
      previewMap.set(b.id, urls)
    }))
  }

  return jsonPrivate(
    buckets.map(b => ({
      id: b.id, name: b.name, description: b.description, color: b.color,
      folderId: b.folderId ?? null, count: b._count.images, createdAt: b.createdAt,
      previewUrls: previewMap.get(b.id) ?? [],
    })),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

// POST — create a new bucket
// Body: { name, description?, color?, folderId? }
export async function POST(req: Request) {
  if (!checkAuth(req)) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const { name, description, color, folderId } = await req.json() as { name: string; description?: string; color?: string; folderId?: number }
  if (!name?.trim()) return jsonPrivate({ error: 'name required' }, { status: 400 })

  const bucket = await prisma.datasetBucket.create({ data: { name: name.trim(), description, color, folderId: folderId ?? null } })
  return jsonPrivate(bucket, { status: 201 })
}
