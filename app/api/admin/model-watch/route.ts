import { NextResponse } from 'next/server'
import { FAL_APPS_IN_USE, FAL_IMAGE_APPS_IN_USE } from '@/lib/fal-video-endpoints'
import { FAL_TOOL_MODELS } from '@/lib/fal-tool-models'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'

// GET /api/admin/model-watch  → fal.ai's public catalog, cross-referenced
// against the endpoints this app actually wires up.
//
// The point is to find out about a new fal model BEFORE a competitor ships it:
// sweep fal's catalog across the keywords that matter here, then mark each
// entry `have` by scanning our own generation routes for its endpoint id.
// ADMIN ONLY.

export const runtime = 'nodejs'
export const maxDuration = 60

async function isAdmin(req: Request): Promise<boolean> {
  if (checkAuth(req)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

// Keyword sweep — one page each. fal's search is keyword-scoped, so a single
// query misses whole families; these nine cover everything this app generates.
const KEYWORDS = [
  'video',
  'image-to-video',
  'text-to-video',
  'text-to-image',
  'image-to-image',
  'upscale',
  'lora',
  'audio',
  'edit',
  // The generation keywords only ever surfaced things that MAKE a picture, so
  // whole families the site already depends on — speech, sound effects,
  // segmentation, relighting, camera control, training — never appeared here
  // at all. These are also the families most likely to hold a feature worth
  // building a manual tool around.
  'text-to-audio',
  'speech',
  'music',
  'sound-effects',
  'segmentation',
  'relight',
  'camera',
  'training',
  'face-swap',
  'video-to-video',
  'audio-to-video',
  'text-to-speech',
  // 3D is a whole ecosystem on fal — seventy-odd models across text-to-3d,
  // image-to-3d, retexturing, remeshing, rigging and scene reconstruction —
  // and none of the generation keywords above surfaced a single one of them.
  '3d',
  'image-to-3d',
  'text-to-3d',
  '3d-to-3d',
  'mesh',
  'rigging',
  'gaussian-splatting',
  'point-cloud',
  'panorama',
  'depth',
]

// Where our model ids live. Anything referenced in these files counts as
// "have it" — they hold every fal endpoint the app can call.
const SOURCE_FILES = [
  'app/api/video/generate/route.ts',
  'app/api/generate/route.ts',
  'app/admin/portal-v2/page.tsx',
]

export interface WatchItem {
  id: string
  title: string
  category: string
  owner: string
  have: boolean
  date: string | null
  description: string
  thumbnailUrl: string | null
}

interface CatalogPayload {
  items: WatchItem[]
  scannedAt: string
  keywords: string[]
  errors: string[]
}

// fal's catalog is stable minute to minute and this page gets reloaded a lot —
// cache the whole cross-referenced result for ten minutes rather than firing
// nine upstream requests per page load.
const CACHE_MS = 10 * 60 * 1000
let cache: { at: number; payload: CatalogPayload } | null = null

interface FalModel {
  id?: unknown
  title?: unknown
  category?: unknown
  date?: unknown
  shortDescription?: unknown
  thumbnailUrl?: unknown
}

async function fetchKeyword(kw: string): Promise<FalModel[]> {
  const res = await fetch(
    `https://fal.ai/api/models?keywords=${encodeURIComponent(kw)}&page=1`,
    { headers: { accept: 'application/json' }, cache: 'no-store' },
  )
  if (!res.ok) throw new Error(`${kw}: HTTP ${res.status}`)
  const data = (await res.json()) as { items?: unknown }
  return Array.isArray(data?.items) ? (data.items as FalModel[]) : []
}

// "fal-ai/kling-video/v2/master/image-to-video" → "fal-ai/kling-video".
// Matching on the owner/app prefix as well as the full id is what makes the
// check honest: we ship one variant of a family and shouldn't be told the
// other eleven are all missing.
function prefixOf(id: string): string {
  const segs = id.split('/').filter(Boolean)
  return segs.slice(0, 2).join('/')
}

function categoryOf(raw: string): string {
  const c = raw.toLowerCase()
  if (c.includes('upscal') || c.includes('super-resolution')) return 'upscale'
  if (c.includes('video')) return 'video'
  if (c.includes('image')) return 'image'
  return 'other'
}

// Which fal apps we already use, straight from our own endpoint table. Reading
// source files here instead made the bundler trace the whole repo.
function inUseApps(): Set<string> {
  // FAL_TOOL_MODELS is the third catalog: audio, masking, relight, face swap,
  // transcription and training all live outside the two generation lists, so
  // without it every one of them showed up here as a model we do not have.
  return new Set(
    [...FAL_APPS_IN_USE, ...FAL_IMAGE_APPS_IN_USE, ...FAL_TOOL_MODELS.map(t => t.endpoint)]
      .map(a => a.toLowerCase()),
  )
}

async function buildCatalog(): Promise<CatalogPayload> {
  const errors: string[] = []
  const results = await Promise.all(
    KEYWORDS.map(async kw => {
      try {
        return await fetchKeyword(kw)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `${kw}: failed`)
        return [] as FalModel[]
      }
    }),
  )

  const inUse = inUseApps()

  const byId = new Map<string, WatchItem>()
  for (const list of results) {
    for (const m of list) {
      const id = typeof m.id === 'string' ? m.id : ''
      if (!id || byId.has(id)) continue
      const prefix = prefixOf(id)
      byId.set(id, {
        id,
        title: typeof m.title === 'string' && m.title ? m.title : id,
        category: categoryOf(typeof m.category === 'string' ? m.category : ''),
        owner: id.split('/')[0] || 'unknown',
        // Match on the owner/app prefix — one app covers many sub-endpoints
        have: inUse.has(prefix.toLowerCase()) || inUse.has(id.toLowerCase()),
        date: typeof m.date === 'string' ? m.date : null,
        description: typeof m.shortDescription === 'string' ? m.shortDescription : '',
        thumbnailUrl: typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl : null,
      })
    }
  }

  // Missing first, then newest — the two questions this page exists to answer
  const items = [...byId.values()].sort((a, b) => {
    if (a.have !== b.have) return a.have ? 1 : -1
    return (b.date || '').localeCompare(a.date || '')
  })

  return { items, scannedAt: new Date().toISOString(), keywords: KEYWORDS, errors }
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1'
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ ...cache.payload, cached: true })
  }

  try {
    const payload = await buildCatalog()
    // Never cache a total wash-out — a transient upstream failure shouldn't
    // pin an empty catalog in place for ten minutes.
    if (payload.items.length > 0) cache = { at: Date.now(), payload }
    return NextResponse.json({ ...payload, cached: false })
  } catch (e) {
    // A stale catalog beats an error screen
    if (cache) return NextResponse.json({ ...cache.payload, cached: true, stale: true })
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Catalog fetch failed' },
      { status: 502 },
    )
  }
}
