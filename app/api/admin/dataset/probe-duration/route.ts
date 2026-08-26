import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { prisma } from '@/lib/prisma'
import { probeDuration } from '@/lib/video-clip'

// POST /api/admin/dataset/probe-duration  { ids: number[] }  — ADMIN ONLY
// Records videoMetadata.durationSec for motion rows that lack it, so the
// Slicing Studio can filter and sort by length. Skips rows already recorded,
// so it is safe to re-run over the whole library.

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: Request) {
  let authed = checkAuth(req as unknown as import('next/server').NextRequest)
  if (!authed) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    authed = !!user && (await checkIsAdmin(user.email))
  }
  if (!authed) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { ids } = await req.json().catch(() => ({ ids: [] }))
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }
  const rows = await prisma.generatedImage.findMany({
    where: { id: { in: ids.slice(0, 100).filter((n: unknown) => typeof n === 'number') }, isDeleted: false },
    select: { id: true, imageUrl: true, videoMetadata: true },
  })

  let updated = 0, skipped = 0, failed = 0
  // Modest parallelism: each probe is a short ranged read of a remote file
  const queue = [...rows]
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift()!
      const meta = (row.videoMetadata as Record<string, unknown> | null) ?? {}
      if (typeof meta.durationSec === 'number') { skipped++; continue }
      try {
        const dur = await probeDuration(row.imageUrl)
        if (!dur || dur <= 0) { failed++; continue }
        await prisma.generatedImage.update({
          where: { id: row.id },
          data: { videoMetadata: { ...meta, durationSec: Math.round(dur * 10) / 10 } },
        })
        updated++
      } catch { failed++ }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return NextResponse.json({ updated, skipped, failed })
}
