import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'

// GET /api/admin/compliance-exports — ADMIN ONLY
// Lists the auto-generated monthly CCBill exports (ComplianceExport table);
// ?month=YYYY-MM returns one month's full summary + CSV. These contain
// reporter PII — admin auth required, never publicly hosted.

export const dynamic = 'force-dynamic'

async function isAuthed(req: NextRequest): Promise<boolean> {
  if (checkAuth(req)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

export async function GET(req: NextRequest) {
  if (!(await isAuthed(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const month = req.nextUrl.searchParams.get('month')
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: 'Bad month' }, { status: 400 })
    const rows = await prisma.$queryRaw<{ month: string; summary: string; csv: string; createdAt: Date }[]>`
      SELECT month, summary, csv, "createdAt" FROM "ComplianceExport" WHERE month = ${month}`
    if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ export: rows[0] })
  }
  const rows = await prisma.$queryRaw<{ month: string; createdAt: Date }[]>`
    SELECT month, "createdAt" FROM "ComplianceExport" ORDER BY month DESC LIMIT 36`
  return NextResponse.json({ exports: rows })
}
