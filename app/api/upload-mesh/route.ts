import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { uploadToR2, userKey } from '@/lib/r2'

/**
 * Upload a 3D asset.
 *
 * The existing upload routes gate on MIME type and browsers do not agree on
 * what a .glb or a .stl is — Chrome sends `model/gltf-binary`, Safari often
 * sends nothing at all, and a .fbx is usually `application/octet-stream`. So
 * this gates on the EXTENSION, which is the only thing that reliably survives
 * the trip, and stores the file under a stable extension so the 3D viewer and
 * fal can both tell what it is from the url alone.
 */

export const runtime = 'nodejs'
export const maxDuration = 300

/** Formats worth accepting, and what each is actually for. */
const ALLOWED: Record<string, string> = {
  glb: 'model/gltf-binary',      // the web-viewable one, and what most fal models return
  gltf: 'model/gltf+json',
  obj: 'text/plain',             // universal, no rig, no PBR
  stl: 'model/stl',              // 3D PRINTING. geometry only, no colour
  fbx: 'application/octet-stream', // rigs and animation; what game engines want
  ply: 'application/octet-stream', // point clouds and splats
  usdz: 'model/vnd.usdz+zip',    // Apple AR quick look
  '3mf': 'application/octet-stream', // printing WITH colour and materials
}

/** 200MB: a textured mesh is far bigger than a photograph. */
const MAX_BYTES = 200 * 1024 * 1024

export async function POST(req: Request): Promise<Response> {
  try {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (file.size === 0) return NextResponse.json({ error: 'Empty file' }, { status: 400 })
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: '3D file too large (max 200MB)' }, { status: 413 })
    }

    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    const contentType = ALLOWED[ext]
    if (!contentType) {
      return NextResponse.json(
        { error: `Unsupported 3D format ".${ext}". Accepted: ${Object.keys(ALLOWED).join(', ')}` },
        { status: 400 },
      )
    }

    const buf = Buffer.from(await file.arrayBuffer())
    const key = `meshes/${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const url = await uploadToR2(userKey(user.id, key), buf, contentType)

    return NextResponse.json({ url, ext, bytes: buf.byteLength, name: file.name })
  } catch (err: any) {
    console.error('upload-mesh error:', err)
    return NextResponse.json({ error: String(err?.message || 'Upload failed') }, { status: 500 })
  }
}
