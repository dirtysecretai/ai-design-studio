import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

// CCBill compliance: public complaint / takedown / depicted-person-appeal intake.
// POST is intentionally unauthenticated — anyone must be able to report content
// without an account. Complaints are reviewed and resolved within 5 business days;
// confirmed-illegal content is removed immediately (admin console sets isDeleted).

const REPORT_TYPES = [
  'illegal-content',
  'non-consensual',
  'underage-concern',
  'copyright',
  'depicted-person-appeal',
  'other',
] as const

const STATUSES = [
  'open',
  'under-review',
  'resolved-removed',
  'resolved-no-violation',
  'escalated',
] as const

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      type,
      contentUrl,
      description,
      reporterEmail,
      reporterName,
      isDepictedPerson,
      website, // honeypot — real users never see or fill this field
    } = body

    if (typeof website === 'string' && website.trim() !== '') {
      // Bot filled the honeypot: pretend success, write nothing
      return NextResponse.json({ success: true, reportId: 0 })
    }

    if (!REPORT_TYPES.includes(type)) {
      return NextResponse.json({ error: 'Invalid report type' }, { status: 400 })
    }
    if (!contentUrl || typeof contentUrl !== 'string' || contentUrl.trim().length === 0) {
      return NextResponse.json({ error: 'Content URL is required' }, { status: 400 })
    }
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 })
    }
    if (contentUrl.length > 2000) {
      return NextResponse.json({ error: 'Content URL is too long' }, { status: 400 })
    }
    if (description.length > 5000) {
      return NextResponse.json({ error: 'Description is too long (5000 characters max)' }, { status: 400 })
    }
    // Appeals need a way to reach the person for the consent investigation
    if (type === 'depicted-person-appeal' && (!reporterEmail || typeof reporterEmail !== 'string' || !reporterEmail.includes('@'))) {
      return NextResponse.json(
        { error: 'A contact email is required for depicted-person removal appeals' },
        { status: 400 }
      )
    }

    // Best-effort: link the report to the generated image it targets so the
    // admin console can remove it in one click
    const url = contentUrl.trim()
    let relatedImageId: number | null = null
    try {
      const match = await prisma.generatedImage.findFirst({
        where: { OR: [{ imageUrl: url }, { thumbnailUrl: url }] },
        select: { id: true },
      })
      relatedImageId = match?.id ?? null
    } catch {}

    const report = await prisma.contentReport.create({
      data: {
        type,
        contentUrl: url,
        description: description.trim(),
        reporterEmail: typeof reporterEmail === 'string' && reporterEmail.trim() ? reporterEmail.trim() : null,
        reporterName: typeof reporterName === 'string' && reporterName.trim() ? reporterName.trim() : null,
        isDepictedPerson: isDepictedPerson === true || type === 'depicted-person-appeal',
        relatedImageId,
      },
    })

    return NextResponse.json({ success: true, reportId: report.id })
  } catch (error) {
    console.error('Content report POST error:', error)
    return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 })
  }
}

// Admin auth via header — never the query string (query strings leak into
// server/proxy access logs and browser history).
function checkAdmin(request: Request) {
  const pass = process.env.ADMIN_PASSWORD
  // Fail closed: a missing ADMIN_PASSWORD must deny, not allow
  if (!pass) return false
  return request.headers.get('x-admin-password') === pass
}

export async function GET(request: Request) {
  try {
    if (!checkAdmin(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const reports = await prisma.contentReport.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        relatedImage: {
          select: { id: true, userId: true, isDeleted: true, imageUrl: true, thumbnailUrl: true },
        },
      },
    })

    return NextResponse.json(reports)
  } catch (error) {
    console.error('Content report GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    if (!checkAdmin(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await request.json()
    const { id, status, resolutionNote, actionTaken, reviewedBy, removeImage } = body

    if (!id || typeof id !== 'number') {
      return NextResponse.json({ error: 'Missing report ID' }, { status: 400 })
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const existing = await prisma.contentReport.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }

    // Immediate removal: soft-delete hides the image from every feed at once
    if (removeImage === true && existing.relatedImageId) {
      await prisma.generatedImage.update({
        where: { id: existing.relatedImageId },
        data: { isDeleted: true },
      })
    }

    const data: Record<string, unknown> = {}
    if (status !== undefined) {
      data.status = status
      if (status.startsWith('resolved-') || status === 'escalated') {
        data.resolvedAt = existing.resolvedAt ?? new Date()
      }
    }
    if (resolutionNote !== undefined) data.resolutionNote = resolutionNote
    if (actionTaken !== undefined) data.actionTaken = actionTaken
    if (reviewedBy !== undefined) data.reviewedBy = reviewedBy

    const report = await prisma.contentReport.update({ where: { id }, data })

    return NextResponse.json({ success: true, report })
  } catch (error) {
    console.error('Content report PUT error:', error)
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 })
  }
}
