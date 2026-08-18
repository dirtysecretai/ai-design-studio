import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { PassThrough, Readable } from 'node:stream'
import archiver from 'archiver'

// STREAMED zip of the user's selected files.
//
// v1 buffered the whole zip in function memory before sending a byte — a
// selection of 4K originals is hundreds of MB per part, which (a) blew the
// serverless limits on big selections and (b) forced the client to fetch the
// zip into JS memory, which crashed iPad Safari at ~275MB/part.
//
// Now the archive streams: images are fetched one at a time and zip bytes flow
// out as they're produced (STORE — no compression, images are already
// compressed). Constant memory on the server, and the client just points the
// BROWSER at this URL (native download, no JS heap at all).
//
// GET /api/images/zip?ids=1,2,3,...
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return new NextResponse('Unauthorized', { status: 401 })

  const user = await getUserFromSession(token)
  if (!user) return new NextResponse('Unauthorized', { status: 401 })

  const { searchParams } = new URL(req.url)
  const idsParam = searchParams.get('ids') ?? ''
  const ids = idsParam
    .split(',')
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0)
  const partLabel = searchParams.get('part') ?? ''

  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }
  if (ids.length > 30) {
    return NextResponse.json({ error: 'Too many ids per zip part (max 30) — request in chunks' }, { status: 400 })
  }

  // Only return files that belong to this user
  const images = await prisma.generatedImage.findMany({
    where: { id: { in: ids }, userId: user.id },
    select: { id: true, imageUrl: true },
  })
  if (images.length === 0) {
    return NextResponse.json({ error: 'No matching files' }, { status: 404 })
  }

  const archive = archiver('zip', { store: true })
  const out = new PassThrough()
  archive.pipe(out)

  // Feed the archive in the background while the response streams. One file
  // at a time, and each append WAITS for its entry to flush into the (client-
  // paced) output before the next fetch — so server memory stays at roughly
  // one image regardless of selection size, and a slow client naturally
  // slows the R2 fetching instead of piling buffers up.
  const appendAndWait = (buf: Buffer, name: string) => new Promise<void>((resolve, reject) => {
    const onEntry = () => { cleanup(); resolve() }
    const onError = (e: Error) => { cleanup(); reject(e) }
    const cleanup = () => { archive.off('entry', onEntry); archive.off('error', onError) }
    archive.once('entry', onEntry)
    archive.once('error', onError)
    archive.append(buf, { name })
  })
  ;(async () => {
    for (const img of images) {
      try {
        const res = await fetch(img.imageUrl, { signal: AbortSignal.timeout(30000) })
        if (!res.ok) continue
        const buf = Buffer.from(await res.arrayBuffer())
        const ct = res.headers.get('content-type') ?? ''
        const url = img.imageUrl
        const ext =
          /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url) ? 'mp4'
          : ct.includes('mp4') || ct.includes('video/mp4') ? 'mp4'
          : ct.includes('webm') ? 'webm'
          : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg'
          : ct.includes('webp') ? 'webp'
          : 'png'
        await appendAndWait(buf, `file-${img.id}.${ext}`)
      } catch {
        // Skip files that fail — don't abort the whole zip
      }
    }
    void archive.finalize()
  })().catch(() => { try { archive.abort() } catch {} })

  const filename = partLabel
    ? `selections-${partLabel}.zip`
    : `selections-${Date.now()}.zip`

  return new NextResponse(Readable.toWeb(out) as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
