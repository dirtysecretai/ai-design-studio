import { NextResponse } from 'next/server'
import { fal } from '@/lib/fal-client'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'

fal.config({ credentials: process.env.FAL_KEY })

// POST /api/admin/transcribe { audio: <data URI> } — ADMIN ONLY
// Voice dictation for the portal prompt box: the browser records a short clip
// (MediaRecorder: webm/opus on Chrome, mp4/AAC on iOS Safari), sends it here
// as a data URI, and fal's Wizper (Whisper v3) transcribes it. Wizper decodes
// any container via ffmpeg server-side, so no client-side format juggling.
// Cost is fractions of a cent per clip; clips are capped at ~4MB (≈2 min).

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_AUDIO_BYTES = 4 * 1024 * 1024

export async function POST(req: Request) {
  try {
    // Dual auth (same pattern as /api/admin/video-loras): admin session cookie
    // (the portal) OR the x-admin-password header (admin tooling/scripts)
    let authed = checkAuth(req as unknown as import('next/server').NextRequest)
    if (!authed) {
      const token = (await cookies()).get('session')?.value
      const user = token ? await getUserFromSession(token) : null
      authed = !!user && (await checkIsAdmin(user.email))
    }
    if (!authed) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const { audio } = await req.json().catch(() => ({})) as { audio?: string }
    const m = typeof audio === 'string' ? /^data:(audio\/[\w.+-]+)(?:;codecs=[\w.,+-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(audio) : null
    if (!m) return NextResponse.json({ error: 'Expected { audio: <audio data URI> }' }, { status: 400 })
    const mime = m[1]
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length < 500) return NextResponse.json({ error: 'Recording too short' }, { status: 400 })
    if (buf.length > MAX_AUDIO_BYTES) return NextResponse.json({ error: 'Recording too large — keep it under ~2 minutes' }, { status: 413 })

    const audioUrl = await fal.storage.upload(new Blob([new Uint8Array(buf)], { type: mime }))
    const result = await fal.subscribe('fal-ai/wizper', {
      input: { audio_url: audioUrl, task: 'transcribe' },
    })
    const text = String((result.data as { text?: string })?.text ?? '').trim()
    if (!text) return NextResponse.json({ error: 'No speech detected' }, { status: 422 })

    return NextResponse.json({ text })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Transcription failed'
    console.error('transcribe error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
