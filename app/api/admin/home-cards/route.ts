import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { uploadToR2, uploadPublicAsset, deleteFromR2 } from '@/lib/r2'

const pExecFile = promisify(execFile)

// Home-page section-card media. Each card is keyed by a stable string
// ("image:{name}", "video:{name}", "shop:tickets", "gen:all", "admin:chat", …).
// Admins upload an image OR video that fills the card; it's stored on public R2 and
// served full-quality via the direct URL. GET is public; mutations are ADMIN ONLY.
//
// Uploads go THROUGH THE SERVER (not a browser→R2 presigned PUT) because the R2
// bucket's CORS policy doesn't allow direct browser PUTs from our origins. Framed
// images arrive as a base64 JSON body; videos arrive as multipart/form-data (a raw
// File). Both are streamed to R2 server-side with uploadToR2.

export const runtime = 'nodejs'
// Video uploads may be transcoded (HEVC → H.264), which takes time for large clips.
export const maxDuration = 300

// Apple devices record/export video as HEVC (H.265), which Safari plays but desktop
// Chrome cannot decode — the card would go black on desktop. Detect non-H.264 video
// and transcode it to H.264 so it plays everywhere. Falls back to the original bytes
// if ffmpeg is unavailable or anything fails (never blocks the upload).
async function ensureH264(buffer: Buffer): Promise<Buffer> {
  if (!ffmpegPath) return buffer
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'hc-'))
    const inFile = join(dir, 'in')
    const outFile = join(dir, 'out.mp4')
    writeFileSync(inFile, buffer)

    // Detect the video codec (ffmpeg -i prints stream info to stderr and exits non-zero).
    let codec = ''
    try { await pExecFile(ffmpegPath, ['-i', inFile]) }
    catch (e: any) { codec = (String(e?.stderr || '').match(/Video:\s*(\w+)/) || [])[1] || '' }
    if (codec === 'h264') return buffer // already web-safe

    await pExecFile(ffmpegPath, [
      '-y', '-i', inFile,
      '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-crf', '20', '-preset', 'fast', '-movflags', '+faststart',
      '-an', // cards are muted — drop audio to keep it small
      outFile,
    ], { maxBuffer: 1 << 30 })
    return readFileSync(outFile)
  } catch {
    return buffer
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }
}

async function getAdminUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  const user = await getUserFromSession(token)
  if (!user) return null
  if (!(await checkIsAdmin(user.email))) return null
  return user
}

// MIME → file extension (normalizing the awkward ones).
function extFor(contentType: string): string {
  return (contentType.split('/')[1] || 'bin')
    .replace('jpeg', 'jpg')
    .replace('quicktime', 'mp4')
    .replace('x-m4v', 'mp4')
    .replace('x-matroska', 'webm')
    .replace('svg+xml', 'svg')
}

const safeKeyOf = (k: string) => k.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)

// Upsert the card row + clean up the previous asset (best-effort).
async function saveCard(key: string, mediaUrl: string, mediaType: 'image' | 'video') {
  const existing = await prisma.homeCard.findUnique({ where: { key } })
  const card = await prisma.homeCard.upsert({
    where: { key },
    update: { mediaUrl, mediaType },
    create: { key, mediaUrl, mediaType },
    select: { key: true, mediaUrl: true, mediaType: true },
  })
  if (existing?.mediaUrl && existing.mediaUrl !== mediaUrl) {
    deleteFromR2(existing.mediaUrl).catch(() => {})
  }
  return card
}

// GET — public: the full key → { mediaUrl, mediaType } map for filling cards.
export async function GET() {
  try {
    const rows = await prisma.homeCard.findMany({ select: { key: true, mediaUrl: true, mediaType: true } })
    const cards: Record<string, { mediaUrl: string; mediaType: string }> = {}
    for (const r of rows) cards[r.key] = { mediaUrl: r.mediaUrl, mediaType: r.mediaType }
    return NextResponse.json({ cards }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('home-cards GET error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// POST — admin. Two shapes:
//   multipart/form-data { key, file }  → video (or image) upload, any size
//   application/json    { key, image } → base64 data URL (framed image)
export async function POST(req: Request) {
  try {
    const admin = await getAdminUser()
    if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const ctype = req.headers.get('content-type') || ''

    // --- multipart: raw file (video or image) ---
    if (ctype.includes('multipart/form-data')) {
      const form = await req.formData()
      const key = String(form.get('key') || '').trim()
      const file = form.get('file')
      if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
      if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
      const raw = file.type || ''
      if (!raw.startsWith('image/') && !raw.startsWith('video/')) {
        return NextResponse.json({ error: 'Only image or video uploads are allowed' }, { status: 400 })
      }
      const isVid = raw.startsWith('video')
      const ct = isVid ? 'video/mp4' : raw
      let buffer: Buffer = Buffer.from(await file.arrayBuffer())
      if (buffer.length === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 })
      // Transcode HEVC (and other non-web codecs) → H.264 so it plays in every browser.
      if (isVid) buffer = await ensureH264(buffer)
      const r2Key = `home-cards/${safeKeyOf(key)}-${randomUUID()}.${isVid ? 'mp4' : extFor(ct)}`
      const mediaUrl = await uploadPublicAsset(r2Key, buffer, ct)
      const card = await saveCard(key, mediaUrl, isVid ? 'video' : 'image')
      return NextResponse.json({ card })
    }

    // --- json: base64 framed image ---
    const body = await req.json().catch(() => null)
    const key = typeof body?.key === 'string' ? body.key.trim() : ''
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
    const dataUrl: string = typeof body?.image === 'string' ? body.image : ''
    const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/)
    if (!m) return NextResponse.json({ error: 'Invalid image data' }, { status: 400 })
    const ct = m[1]
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length === 0) return NextResponse.json({ error: 'Empty image' }, { status: 400 })
    if (buffer.length > 12 * 1024 * 1024) return NextResponse.json({ error: 'Image too large' }, { status: 413 })
    const r2Key = `home-cards/${safeKeyOf(key)}-${randomUUID()}.${extFor(ct)}`
    const mediaUrl = await uploadPublicAsset(r2Key, buffer, ct)
    const card = await saveCard(key, mediaUrl, 'image')
    return NextResponse.json({ card })
  } catch (error) {
    console.error('home-cards POST error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE ?key= — admin: remove a card's media (reverts it to the default look).
export async function DELETE(req: Request) {
  try {
    const admin = await getAdminUser()
    if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const { searchParams } = new URL(req.url)
    const key = (searchParams.get('key') || '').trim()
    if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

    const existing = await prisma.homeCard.findUnique({ where: { key } })
    if (existing) {
      deleteFromR2(existing.mediaUrl).catch(() => {})
      await prisma.homeCard.delete({ where: { key } })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('home-cards DELETE error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
