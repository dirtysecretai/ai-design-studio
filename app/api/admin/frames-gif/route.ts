import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { gifToMp4 } from '@/lib/video-clip'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// POST /api/admin/frames-gif — ADMIN ONLY
// Frame Extractor GIF support: browsers cannot seek GIFs in a <video>
// element (and iPad Safari has no ImageDecoder), so the popup posts the raw
// GIF bytes here, ffmpeg converts to a transient MP4, and the client runs
// its normal on-device extraction on the returned clip. Nothing is stored —
// the temp dir is deleted before the response leaves.

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_GIF_BYTES = 80 * 1024 * 1024

export async function POST(req: Request) {
  // Dual auth (same pattern as /api/admin/transcribe): admin session cookie
  // (the portal) OR the x-admin-password header (admin tooling/scripts)
  let authed = checkAuth(req as unknown as import('next/server').NextRequest)
  if (!authed) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    authed = !!user && (await checkIsAdmin(user.email))
  }
  if (!authed) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  let dir: string | null = null
  try {
    const buf = Buffer.from(await req.arrayBuffer())
    if (buf.length < 100) return NextResponse.json({ error: 'Empty upload' }, { status: 400 })
    if (buf.length > MAX_GIF_BYTES) return NextResponse.json({ error: 'GIF too large (max 80MB)' }, { status: 413 })
    // GIF magic: GIF87a / GIF89a
    if (!(buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) {
      return NextResponse.json({ error: 'Not a GIF file' }, { status: 400 })
    }

    dir = await mkdtemp(path.join(tmpdir(), 'frames-gif-'))
    const inFile = path.join(dir, 'in.gif')
    const outFile = path.join(dir, 'out.mp4')
    await writeFile(inFile, buf)
    await gifToMp4(inFile, outFile)
    const mp4 = await readFile(outFile)

    return new NextResponse(new Uint8Array(mp4), {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Content-Length': String(mp4.length),
      },
    })
  } catch (err: unknown) {
    console.error('frames-gif conversion error:', err)
    return NextResponse.json({ error: 'GIF conversion failed — try re-exporting the GIF' }, { status: 500 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
