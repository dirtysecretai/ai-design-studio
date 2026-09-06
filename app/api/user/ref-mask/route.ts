import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'

fal.config({ credentials: process.env.FAL_KEY })

export const maxDuration = 60

// POST /api/user/ref-mask — auto-mask for the reference image editor.
// Body: { image: <data URL of the current canvas>, prompt?: string }
//  - With a prompt → fal-ai/evf-sam (text-prompted segmentation, mask_only default)
//  - Without      → fal-ai/birefnet/v2 (salient-subject mask via mask_only)
// Both return a black/white mask image; we fetch it server-side and hand back a
// data URL so the client canvas never taints.

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const user = await getUserFromSession(token)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

    const body = await req.json().catch(() => null)
    const image: string = typeof body?.image === 'string' ? body.image : ''
    const prompt: string = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (!image.startsWith('data:image/')) {
      return NextResponse.json({ error: 'image must be a data URL' }, { status: 400 })
    }
    // ~12MB decoded cap — the editor caps canvases at 4096px, JPEG q0.92 stays well under
    if (image.length > 16_000_000) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 })
    }

    let maskUrl: string | undefined
    if (prompt) {
      const result: any = await fal.subscribe('fal-ai/evf-sam', {
        input: {
          image_url: image,
          prompt,
          mask_only: true,
          fill_holes: true,
        },
      })
      maskUrl = result?.data?.image?.url
    } else {
      const result: any = await fal.subscribe('fal-ai/birefnet/v2', {
        // mask_only is in the live API schema but missing from the client's typings
        input: {
          image_url: image,
          mask_only: true,
          operating_resolution: '1024x1024',
          output_format: 'png',
        } as any,
      })
      maskUrl = result?.data?.image?.url
    }

    if (!maskUrl) return NextResponse.json({ error: 'No mask returned' }, { status: 502 })

    // Already a data URI (sync_mode-style responses) — pass straight through
    if (maskUrl.startsWith('data:')) {
      return NextResponse.json({ mask: maskUrl })
    }
    const maskRes = await fetch(maskUrl)
    if (!maskRes.ok) return NextResponse.json({ error: 'Failed to fetch mask' }, { status: 502 })
    const ct = maskRes.headers.get('content-type') || 'image/png'
    const buf = Buffer.from(await maskRes.arrayBuffer())
    return NextResponse.json({ mask: `data:${ct};base64,${buf.toString('base64')}` })
  } catch (error: any) {
    console.error('ref-mask error:', error?.body ?? error)
    const detail = error?.body?.detail
    const msg = Array.isArray(detail)
      ? detail.map((d: any) => d.msg).join('; ')
      : (typeof detail === 'string' ? detail : error?.message) || 'Auto-mask failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
