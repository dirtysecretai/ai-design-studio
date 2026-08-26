import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { checkAuth } from '@/lib/admin-auth'
import { normalizeCaptionSections } from '@/lib/caption-compose'


// GET — paginated dataset browser + optional ?export=true for full JSON download
export async function GET(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)

  // ?ids=1,2,3 → per-image lookup for specific images (dataset composer:
  // caption refresh after AutoFill, and url/thumb re-hydration after a
  // preset/run-reload restore — those save slim items without URLs)
  const idsParam = searchParams.get('ids')
  if (idsParam) {
    const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0).slice(0, 500)
    if (ids.length === 0) return NextResponse.json({ images: [] })
    const rows = await prisma.generatedImage.findMany({
      where: { id: { in: ids }, isDeleted: false },
      // prompt + captionSections ride along for the composable-caption system
      select: { id: true, adminCaption: true, adminTags: true, imageUrl: true, thumbnailUrl: true, aspectRatio: true, prompt: true, captionSections: true },
    })
    return NextResponse.json({ images: rows })
  }

  // ?slim=1&bucketId=&mediaType=motion → the whole bucket, minimal fields.
  // Powers the Slicing Studio library: client-side filter/sort/paginate with
  // no per-page round trip.
  if (searchParams.get('slim') === '1') {
    const bid = parseInt(searchParams.get('bucketId') || '')
    const EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.gif']
    const w: Prisma.GeneratedImageWhereInput = { isDeleted: false }
    if (!isNaN(bid)) w.bucketImages = { some: { bucketId: bid } }
    if (searchParams.get('mediaType') === 'motion') {
      w.OR = EXTS.map(e => ({ imageUrl: { endsWith: e } }))
    }
    const rows = await prisma.generatedImage.findMany({
      where: w,
      select: { id: true, imageUrl: true, aspectRatio: true, createdAt: true, videoMetadata: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    return NextResponse.json({
      items: rows.map(r => {
        const m = (r.videoMetadata as Record<string, unknown> | null) ?? {}
        const segs = [1, 2].filter(n => typeof m[`previewAnimUrl${n}`] === 'string').length + 1
        return {
          id: r.id,
          url: r.imageUrl,
          aspectRatio: r.aspectRatio,
          createdAt: r.createdAt,
          name: typeof m.originalFilename === 'string' ? m.originalFilename : null,
          mime: typeof m.mimeType === 'string' ? m.mimeType : null,
          dur: typeof m.durationSec === 'number' ? m.durationSec : null,
          segs,
        }
      }),
    })
  }

  const isExport    = searchParams.get('export') === 'true'
  const page        = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const isAll       = searchParams.get('all') === 'true'
  const limit       = isAll ? 10000 : Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '30')))
  const skip        = (page - 1) * limit

  // Filters — model, aspectRatio, userId support multi-value (repeated params)
  const modelList       = searchParams.getAll('model').filter(Boolean)
  const aspectRatioList = searchParams.getAll('aspectRatio').filter(Boolean)
  const userIdList      = searchParams.getAll('userId').filter(Boolean).map(Number).filter(n => !isNaN(n))
  const qualityList     = searchParams.getAll('quality').filter(Boolean)
  const hasRefs     = searchParams.get('hasRefs')     || ''   // 'true' | 'false' | '1' | '2' | '3' | '4+'
  const hasRating   = searchParams.get('hasRating')   || ''   // 'true' | 'false'
  const hasCaption  = searchParams.get('hasCaption')  || ''   // 'true' | 'false'
  const hasTag      = searchParams.get('hasTag')      || ''   // 'true' | 'false'
  const tagFilter   = searchParams.get('tagFilter')   || ''   // specific tag value
  const mediaType   = searchParams.get('mediaType')   || ''   // 'image' | 'video' | ''
  const markedOnly  = searchParams.get('markedOnly') === 'true'
  const bucketId    = searchParams.get('bucketId')    || ''
  // Exclusion: hide generations already sorted into any of these buckets
  // (client expands excluded folders into their full bucket subtree)
  const excludeBuckets = searchParams.getAll('excludeBucket').map(Number).filter(n => !isNaN(n) && n > 0)
  const search      = searchParams.get('search')      || ''
  const sort        = searchParams.get('sort')        || 'newest'

  const where: Prisma.GeneratedImageWhereInput = { isDeleted: false }

  if (modelList.length === 1)       where.model       = modelList[0]
  else if (modelList.length > 1)    where.model       = { in: modelList }
  if (aspectRatioList.length === 1) where.aspectRatio = aspectRatioList[0]
  else if (aspectRatioList.length > 1) where.aspectRatio = { in: aspectRatioList }
  if (userIdList.length === 1)      where.userId      = userIdList[0]
  else if (userIdList.length > 1)   where.userId      = { in: userIdList }
  if (qualityList.length === 1)    where.quality = qualityList[0]
  else if (qualityList.length > 1) where.quality = { in: qualityList }
  if (markedOnly)  where.markedForTraining = true
  if (bucketId || excludeBuckets.length > 0) {
    where.bucketImages = {
      ...(bucketId ? { some: { bucketId: parseInt(bucketId) } } : {}),
      ...(excludeBuckets.length > 0 ? { none: { bucketId: { in: excludeBuckets } } } : {}),
    }
  }
  // Media type by FILE EXTENSION — the old "has videoMetadata = video" check
  // broke once image models started storing generation settings in
  // videoMetadata (custom flux records its config there): every recent flux
  // image was misclassified as a video and vanished from "Images only".
  const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv']
  if (mediaType === 'video') where.OR  = VIDEO_EXTS.map(e => ({ imageUrl: { endsWith: e } }))
  if (mediaType === 'image') where.AND = VIDEO_EXTS.map(e => ({ NOT: { imageUrl: { endsWith: e } } }))
  // 'motion' = videos AND gifs — the Slicing Studio's sliceable set
  if (mediaType === 'motion') where.OR = [...VIDEO_EXTS, '.gif'].map(e => ({ imageUrl: { endsWith: e } }))

  if (hasRefs === 'true')        where.referenceImageUrls = { isEmpty: false }
  else if (hasRefs === 'false') where.referenceImageUrls = { isEmpty: true }
  else if (['1', '2', '3', '4+'].includes(hasRefs)) {
    const rows = await prisma.$queryRaw<{ id: number }[]>(
      hasRefs === '4+'
        ? Prisma.sql`SELECT id FROM "GeneratedImage" WHERE cardinality("referenceImageUrls") >= 4 AND "isDeleted" = false`
        : Prisma.sql`SELECT id FROM "GeneratedImage" WHERE cardinality("referenceImageUrls") = ${parseInt(hasRefs)} AND "isDeleted" = false`
    )
    where.id = { in: rows.map(r => r.id) }
  }

  if (hasRating === 'true')  where.imageRating = { isNot: null }
  if (hasRating === 'false') where.imageRating = { is: null }

  if (hasCaption === 'true')  where.adminCaption = { not: null }
  if (hasCaption === 'false') where.adminCaption = null

  if (hasTag === 'true')  where.adminTags = { isEmpty: false }
  if (hasTag === 'false') where.adminTags = { isEmpty: true }

  if (tagFilter) where.adminTags = { has: tagFilter }

  if (search) where.prompt = { contains: search, mode: 'insensitive' }

  const orderBy: Prisma.GeneratedImageOrderByWithRelationInput =
    sort === 'oldest' ? { createdAt: 'asc'  }
    : sort === 'rating' ? { imageRating: { score: 'desc' } }
    : sort === 'cost'   ? { ticketCost: 'desc' }
    : { createdAt: 'desc' }

  // ── Export ──────────────────────────────────────────────────────────────────
  if (isExport) {
    const records = await prisma.generatedImage.findMany({
      where,
      include: {
        imageRating: { select: { score: true, wasAccurate: true, feedbackText: true, tags: true } },
        user:        { select: { id: true, email: true } },
      },
      orderBy,
    })

    const payload = records.map(r => ({
      id:                 r.id,
      prompt:             r.prompt,
      imageUrl:           r.imageUrl,
      referenceImageUrls: r.referenceImageUrls,
      model:              r.model,
      quality:            r.quality,
      aspectRatio:        r.aspectRatio,
      ticketCost:         r.ticketCost,
      markedForTraining:  r.markedForTraining,
      adminTags:          r.adminTags,
      adminCaption:       r.adminCaption,
      rating:             r.imageRating?.score         ?? null,
      ratingAccurate:     r.imageRating?.wasAccurate   ?? null,
      ratingTags:         r.imageRating?.tags          ?? [],
      userId:             r.userId,
      createdAt:          r.createdAt,
    }))

    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="dataset-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // ── Bucket stats-only (separate non-blocking request from client) ──────────
  if (searchParams.get('statsOnly') === 'true' && bucketId) {
    const bid = parseInt(bucketId)
    const bw = { isDeleted: false, bucketImages: { some: { bucketId: bid } } }
    const [marked, tagged, captioned, total] = await Promise.all([
      prisma.generatedImage.count({ where: { ...bw, markedForTraining: true } }),
      prisma.generatedImage.count({ where: { ...bw, adminTags: { isEmpty: false } } }),
      prisma.generatedImage.count({ where: { ...bw, adminCaption: { not: null } } }),
      prisma.generatedImage.count({ where: bw }),
    ])
    return NextResponse.json({ bucketStats: { marked, tagged, captioned, total } }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // ── IDs-only (for select-all across all pages) ─────────────────────────────
  if (searchParams.get('idsOnly') === 'true') {
    const rows = await prisma.generatedImage.findMany({
      where,
      select: { id: true },
      orderBy,
    })
    return NextResponse.json({ ids: rows.map(r => r.id) }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // ── Paginated list ──────────────────────────────────────────────────────────
  const [total, images] = await prisma.$transaction([
    prisma.generatedImage.count({ where }),
    prisma.generatedImage.findMany({
      where,
      select: {
        id: true, prompt: true, imageUrl: true, referenceImageUrls: true,
        model: true, quality: true, aspectRatio: true, ticketCost: true,
        markedForTraining: true, adminTags: true, adminCaption: true,
        captionSections: true,
        createdAt: true, expiresAt: true, falRequestId: true, videoMetadata: true,
        isDeleted: true, thumbnailUrl: true,
        user:        { select: { id: true, email: true, name: true } },
        imageRating: { select: { score: true, wasAccurate: true, tags: true, feedbackText: true, createdAt: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
  ])

  // Facets + overall stats are GLOBAL (they ignore the active filters), yet
  // they were recomputed on EVERY page/bucket/filter change — ~8 full-table
  // queries per click that made bucket switches crawl or hang. Now they only
  // compute when the client asks (?facets=1 — first load / manual refresh).
  let facetsPayload: Record<string, unknown> | undefined
  let overallStatsPayload: Record<string, number> | undefined
  if (searchParams.get('facets') === '1') {
    const [models, aspects, qualities, overallMarked, overallTagged, overallCaptioned] = await Promise.all([
      prisma.generatedImage.groupBy({ by: ['model'],       where: { isDeleted: false }, _count: true }),
      prisma.generatedImage.groupBy({ by: ['aspectRatio'], where: { isDeleted: false }, _count: true }),
      prisma.generatedImage.groupBy({ by: ['quality'],     where: { isDeleted: false }, _count: true }),
      prisma.generatedImage.count({ where: { isDeleted: false, markedForTraining: true } }),
      prisma.generatedImage.count({ where: { isDeleted: false, adminTags: { isEmpty: false } } }),
      prisma.generatedImage.count({ where: { isDeleted: false, adminCaption: { not: null } } }),
    ])

    // Top tags via raw SQL (unnest the array)
    const topTags = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
      SELECT unnest("adminTags") AS tag, COUNT(*) AS count
      FROM "GeneratedImage"
      WHERE "isDeleted" = false
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 30
    `

    // Users who have generations, ordered by count desc
    const userFacets = await prisma.generatedImage.groupBy({
      by: ['userId'],
      where: { isDeleted: false },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 100,
    })
    const userIds = userFacets.map(u => u.userId)
    const userDetails = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    })
    const userMap = Object.fromEntries(userDetails.map(u => [u.id, u]))
    const users = userFacets
      .map(u => ({ id: u.userId, email: userMap[u.userId]?.email ?? `#${u.userId}`, name: userMap[u.userId]?.name ?? null, count: u._count.id }))
      .filter(u => u.email)

    facetsPayload = {
      models:    models.map(m => ({ value: m.model,       count: m._count })),
      aspects:   aspects.map(a => ({ value: a.aspectRatio, count: a._count })).filter(a => a.value),
      qualities: qualities.map(q => ({ value: q.quality, count: q._count })).filter(q => q.value),
      tags:      topTags.map(t => ({ value: t.tag, count: Number(t.count) })),
      users,
    }
    overallStatsPayload = { marked: overallMarked, tagged: overallTagged, captioned: overallCaptioned }
  }

  return NextResponse.json({
    images,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    ...(facetsPayload ? { facets: facetsPayload } : {}),
    ...(overallStatsPayload ? { overallStats: overallStatsPayload } : {}),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// PATCH — update one or many images
// Body options (all fields optional except ids):
//   { ids, marked }              → set markedForTraining
//   { ids, tags }                → REPLACE adminTags (single-item edit)
//   { ids, addTags }             → MERGE into existing adminTags (batch)
//   { ids, removeTags }          → remove specific tags from existing adminTags (batch)
//   { ids, caption }             → set/clear adminCaption (null to clear)
//   Any combination of the above is applied together.
export async function PATCH(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json() as {
      ids?:       number[]
      marked?:    boolean
      tags?:      string[]
      addTags?:   string[]
      removeTags?: string[]
      caption?:   string | null
      // Per-image caption updates in one request (composer find & replace)
      captions?:  { id: number; caption: string | null }[]
      // Composable training-caption sections ({prompt?,tags?,noteOn?,note?} or null to clear)
      captionSections?: unknown
    }

    // Bulk per-image captions — independent of the ids-based paths below
    if (Array.isArray(body.captions) && body.captions.length > 0) {
      const rows = body.captions
        .filter(c => typeof c?.id === 'number' && c.id > 0)
        .slice(0, 1000)
      // updateMany per row: a missing/deleted id is a no-op instead of failing
      // the whole transaction
      await prisma.$transaction(rows.map(c =>
        prisma.generatedImage.updateMany({
          where: { id: c.id, isDeleted: false },
          data: { adminCaption: typeof c.caption === 'string' && c.caption.length > 0 ? c.caption : null },
        })
      ))
      return NextResponse.json({ updated: rows.length })
    }

    const { ids, marked, tags, addTags, removeTags, caption } = body
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 })
    }

    // Fields that can be applied via updateMany (no per-row read needed)
    const simpleData: Prisma.GeneratedImageUpdateInput = {}
    if (marked    !== undefined) simpleData.markedForTraining = marked
    if (caption   !== undefined) simpleData.adminCaption      = caption
    if (tags      !== undefined) simpleData.adminTags         = tags
    if ('captionSections' in body) {
      // Normalized to the known shape; null/empty clears back to autofill-only
      const norm = normalizeCaptionSections(body.captionSections)
      simpleData.captionSections = norm === null ? Prisma.DbNull : (norm as Prisma.InputJsonValue)
    }

    let updated = 0

    if (addTags?.length || removeTags?.length) {
      // Need per-row tag merge — fetch existing tags first
      const rows = await prisma.generatedImage.findMany({
        where:  { id: { in: ids } },
        select: { id: true, adminTags: true },
      })

      await prisma.$transaction(
        rows.map(row => {
          let merged = [...row.adminTags]
          if (addTags?.length)    merged = [...new Set([...merged, ...addTags])]
          if (removeTags?.length) merged = merged.filter(t => !removeTags.includes(t))

          return prisma.generatedImage.update({
            where: { id: row.id },
            data:  { ...simpleData, adminTags: merged },
          })
        })
      )
      updated = rows.length
    } else if (Object.keys(simpleData).length > 0) {
      const result = await prisma.generatedImage.updateMany({
        where: { id: { in: ids } },
        data:  simpleData as Prisma.GeneratedImageUncheckedUpdateManyInput,
      })
      updated = result.count
    }

    return NextResponse.json({ updated })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
