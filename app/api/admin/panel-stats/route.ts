import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import prisma from '@/lib/prisma'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'

// GET /api/admin/panel-stats — ADMIN ONLY
// One aggregate call powering the admin panel's "Needs attention" strip:
// open complaints + how many are past/near their resolution deadline
// (5 business days; NCII 48h), generation queue depth, active/failed training
// jobs, and whether last month's CCBill export is saved.

export const dynamic = 'force-dynamic'

function resolutionDeadline(createdAt: Date, type: string): Date {
  if (type === 'non-consensual') return new Date(createdAt.getTime() + 48 * 3600 * 1000)
  const d = new Date(createdAt)
  let added = 0
  while (added < 5) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  d.setUTCHours(23, 59, 59, 999)
  return d
}

function prevMonthKey(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

export async function GET(req: NextRequest) {
  let authed = checkAuth(req)
  if (!authed) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    authed = !!user && (await checkIsAdmin(user.email))
  }
  if (!authed) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  try {
    const now = Date.now()
    const [openReports, queued, processing, activeTraining, failedTraining24h, exportRows] = await Promise.all([
      prisma.contentReport.findMany({
        where: { status: { in: ['open', 'under-review'] } },
        select: { createdAt: true, type: true },
      }),
      prisma.generationQueue.count({ where: { status: 'queued' } }),
      prisma.generationQueue.count({ where: { status: 'processing' } }),
      prisma.loraTrainingJob.count({ where: { status: { in: ['preparing', 'queued', 'in_progress'] } } }),
      prisma.loraTrainingJob.count({ where: { status: 'failed', updatedAt: { gte: new Date(now - 24 * 3600 * 1000) } } }),
      prisma.$queryRaw<{ month: string }[]>`SELECT month FROM "ComplianceExport" WHERE month = ${prevMonthKey()}`,
    ])

    let overdue = 0
    let nearestDeadline: number | null = null
    for (const r of openReports) {
      const dl = resolutionDeadline(r.createdAt, r.type).getTime()
      if (dl < now) overdue++
      if (nearestDeadline === null || dl < nearestDeadline) nearestDeadline = dl
    }

    return NextResponse.json({
      reports: { open: openReports.length, overdue, nearestDeadline },
      queue: { queued, processing },
      training: { active: activeTraining, failed24h: failedTraining24h },
      ccbillExport: { month: prevMonthKey(), ready: exportRows.length > 0 },
    })
  } catch (e) {
    console.error('[panel-stats] error:', e)
    return NextResponse.json({ error: 'Stats failed' }, { status: 500 })
  }
}
