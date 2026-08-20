import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'

// GET /api/cron/ccbill-export — monthly CCBill compliance export generator.
//
// Vercel Cron fires this on the 1st of each month (see vercel.json): it builds
// the previous month's complaints report (the same four CCBill bullets the
// content-reports console renders) plus a CSV of every complaint received, and
// saves BOTH into the ComplianceExport table (DDL out-of-band, raw SQL) —
// ready to review and send before the 2nd-Monday deadline. Idempotent: an
// existing month is only regenerated when ?force=1.
//
// Exports contain reporter PII, so they live in the DATABASE behind admin
// auth — never on public R2.
//
// Manual runs (admin password): ?month=YYYY-MM to (re)generate any month.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TYPE_LABELS: Record<string, string> = {
  'illegal-content': 'Illegal content',
  'non-consensual': 'Non-consensual imagery',
  'underage-concern': 'Underage concern',
  'copyright': 'Copyright',
  'depicted-person-appeal': 'Depicted-person appeal',
  'other': 'Other',
}

function prevMonthKey(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`
  const isAdmin = checkAuth(req)
  if (!isCron && !isAdmin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const monthParam = req.nextUrl.searchParams.get('month')
    const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : prevMonthKey()
    const force = req.nextUrl.searchParams.get('force') === '1'

    const existing = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM "ComplianceExport" WHERE month = ${month}`
    if (existing.length > 0 && !force) {
      return NextResponse.json({ ok: true, month, alreadyExists: true })
    }

    // Month window [start, end)
    const start = new Date(`${month}-01T00:00:00.000Z`)
    const end = new Date(start)
    end.setUTCMonth(end.getUTCMonth() + 1)

    const received = await prisma.contentReport.findMany({
      where: { createdAt: { gte: start, lt: end } },
      orderBy: { id: 'asc' },
    })
    const resolvedInMonth = await prisma.contentReport.findMany({
      where: { resolvedAt: { gte: start, lt: end } },
      orderBy: { id: 'asc' },
    })
    const violations = resolvedInMonth.filter(r => r.status === 'resolved-removed')
    const settled = resolvedInMonth.filter(r => r.status.startsWith('resolved-') || r.status === 'escalated')

    const byType: Record<string, number> = {}
    for (const v of violations) byType[v.type] = (byType[v.type] ?? 0) + 1

    const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-')
    const lines: string[] = []
    lines.push(`Content Violations Report — ${month}`)
    lines.push('Prompt & Protocol LLC — prompt-protocol.vercel.app')
    lines.push(`Generated ${new Date().toISOString().slice(0, 10)} (automated monthly export)`)
    lines.push('')
    lines.push(`Complaints received this month: ${received.length}`)
    lines.push(`Violations found this month: ${violations.length}`)
    lines.push('')
    lines.push('Violation types:')
    if (Object.keys(byType).length === 0) lines.push('  (none)')
    else for (const [t, n] of Object.entries(byType)) lines.push(`  ${TYPE_LABELS[t] ?? t}: ${n}`)
    lines.push('')
    lines.push('URLs with content violations:')
    if (violations.length === 0) lines.push('  (none)')
    else for (const v of violations) {
      lines.push(`  ${v.contentUrl}`)
      lines.push(`    type: ${TYPE_LABELS[v.type] ?? v.type} · action: ${v.actionTaken || 'content removed'} · resolved: ${fmt(v.resolvedAt)}`)
    }
    lines.push('')
    lines.push('Actions taken on complaints resolved this month:')
    if (settled.length === 0) lines.push('  (none)')
    else for (const r of settled) {
      lines.push(`  #${r.id} [${TYPE_LABELS[r.type] ?? r.type}] ${r.status} — ${r.actionTaken || '-'}`)
    }
    const summary = lines.join('\n')

    const esc = (s: string | null) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const csv = [
      ['id', 'createdAt', 'type', 'status', 'contentUrl', 'actionTaken', 'resolvedAt', 'reviewedBy', 'resolutionNote'].join(','),
      ...received.map(r =>
        [r.id, r.createdAt.toISOString(), r.type, r.status, esc(r.contentUrl), esc(r.actionTaken), r.resolvedAt?.toISOString() ?? '', esc(r.reviewedBy), esc(r.resolutionNote)].join(',')
      ),
    ].join('\n')

    await prisma.$executeRaw`
      INSERT INTO "ComplianceExport" (month, summary, csv)
      VALUES (${month}, ${summary}, ${csv})
      ON CONFLICT (month) DO UPDATE SET summary = ${summary}, csv = ${csv}, "createdAt" = CURRENT_TIMESTAMP`

    console.log(`[ccbill-export] saved ${month}: ${received.length} received, ${violations.length} violations`)
    return NextResponse.json({ ok: true, month, received: received.length, violations: violations.length })
  } catch (e) {
    console.error('[ccbill-export] error:', e)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
