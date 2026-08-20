import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { getFilterState, setAdminFilterOn, setFilterMode, filterStats, testPromptVerdict } from '@/lib/content-filter'
import { CELEBRITY_NAME_COUNT } from '@/lib/celebrity-names'

// GET/POST /api/admin/content-filter — ADMIN ONLY
// Controls whether the CCBill prompt filter ALSO applies to admin accounts.
// Regular users are always filtered regardless of this flag — there is no
// switch anywhere that disables the filter for them.

export const dynamic = 'force-dynamic'

async function isAuthed(req: NextRequest): Promise<boolean> {
  if (checkAuth(req)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const state = await getFilterState()
  return NextResponse.json({ ...state, stats: { ...filterStats(), nameCount: CELEBRITY_NAME_COUNT } })
}

export async function POST(req: NextRequest) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as { on?: unknown; mode?: unknown; testPrompt?: unknown }
  if (typeof body.testPrompt === 'string' && body.testPrompt.trim()) {
    return NextResponse.json({ test: await testPromptVerdict(body.testPrompt.trim().slice(0, 2000)) })
  }
  if (typeof body.on !== 'boolean' && body.mode === undefined) {
    return NextResponse.json({ error: 'Expected { on?: boolean, mode?: "gemini" | "static" }' }, { status: 400 })
  }
  if (typeof body.on === 'boolean') {
    await setAdminFilterOn(body.on)
    console.log(`[content-filter] admin filter toggled ${body.on ? 'ON' : 'OFF'}`)
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'gemini' && body.mode !== 'static') {
      return NextResponse.json({ error: 'mode must be "gemini" or "static"' }, { status: 400 })
    }
    await setFilterMode(body.mode)
    console.log(`[content-filter] mode set to ${body.mode}`)
  }
  return NextResponse.json(await getFilterState())
}
