import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { gifToMp4 } from '@/lib/video-clip'
import { uploadToR2 } from '@/lib/r2'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'
import { jsonPrivate } from '@/lib/api-json'

// POST /api/admin/gif-to-video — ADMIN ONLY
// Turns a GIF into an H.264 MP4 stored in R2, so GIFs can be used wherever a
// video reference is accepted (Kling motion control, Flux 3, Gemini Omni Flash,
// SeeDance 2.0). Providers only take real video URLs, and a GIF will not even
// load in a <video> element for the client-side duration checks.
//
// Two input modes, matching frames-gif:
//   application/json { url }  → server pulls the GIF from our own storage
//   raw body                  → bytes straight from a file picker

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_GIF_BYTES = 80 * 1024 * 1024

export async function POST(req: Request) {
  let authed = checkAuth(req as unknown as import('next/server').NextRequest)
  if (!authed) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    authed = !!user && (await checkIsAdmin(user.email))
  }
  if (!authed) return jsonPrivate({ error: 'Admin only' }, { status: 403 })

  let dir: string | null = null
  try {
    let buf: Buffer
    if ((req.headers.get('content-type') || '').includes('application/json')) {
      const { url } = await req.json().catch(() => ({ url: '' }))
      const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
      if (typeof url !== 'string' || !publicBase || !url.startsWith(`${publicBase}/`)) {
        return jsonPrivate({ error: 'url must point at our own storage' }, { status: 400 })
      }
      const src = await fetch(url)
      if (!src.ok) return jsonPrivate({ error: `Source fetch failed (${src.status})` }, { status: 502 })
      buf = Buffer.from(await src.arrayBuffer())
    } else {
      buf = Buffer.from(await req.arrayBuffer())
    }

    if (buf.length < 100) return jsonPrivate({ error: 'Empty upload' }, { status: 400 })
    if (buf.length > MAX_GIF_BYTES) return jsonPrivate({ error: 'GIF too large (max 80MB)' }, { status: 413 })
    // GIF magic: GIF87a / GIF89a
    if (!(buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) {
      return jsonPrivate({ error: 'Not a GIF file' }, { status: 400 })
    }

    const work = await mkdtemp(path.join(tmpdir(), 'gif-video-'))
    dir = work
    const inFile = path.join(work, 'in.gif')
    const outFile = path.join(work, 'out.mp4')
    await writeFile(inFile, buf)
    // gifToMp4 already pads odd dimensions to even — libx264 rejects odd sizes
    await gifToMp4(inFile, outFile)
    const mp4 = await readFile(outFile)

    const url = await uploadToR2(`uploads/gif-video/${crypto.randomUUID()}.mp4`, mp4, 'video/mp4')
    return jsonPrivate({ url, bytes: mp4.length })
  } catch (err) {
    console.error('gif-to-video error:', err instanceof Error ? err.message : err)
    return jsonPrivate({ error: 'GIF conversion failed — try re-exporting the GIF' }, { status: 500 })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
