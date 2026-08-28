import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'
import { readdir, stat } from 'fs/promises'
import path from 'path'
import { VIDEO_EXTS, localMediaDisabled, safeResolve, probeMovie } from '@/lib/local-media'

// GET /api/admin/movies?scan=<abs path>         → the movies under a root
// GET /api/admin/movies?dir=<abs path>          → folders + video files in dir
// GET /api/admin/movies?probe=<abs path>        → duration/dims/codec for one file
// GET /api/admin/movies?roots=1                 → drive letters / mount points
// ADMIN ONLY, local server only. Lets the Slicing Studio browse to movies on an
// attached drive and slice them in place — nothing is uploaded.

export const runtime = 'nodejs'
export const maxDuration = 60

async function isAdmin(req: Request): Promise<boolean> {
  if (checkAuth(req as unknown as import('next/server').NextRequest)) return true
  const token = (await cookies()).get('session')?.value
  const user = token ? await getUserFromSession(token) : null
  return !!user && (await checkIsAdmin(user.email))
}

// Release-folder noise: "Star.Wars.1983.1080p.REMUX.DTS-HD...", "x265", etc.
const RELEASE_RE = /(\d{3,4}p|remux|blu-?ray|web-?dl|webrip|x26[45]|hevc|avc|dts|ddp|aac|hdr|proper|repack|\d{4}\.)/i
const looksLikeRelease = (name: string) =>
  RELEASE_RE.test(name) || (name.split('.').length > 3)

// Title for a file: the deepest folder under the root that still reads like a
// name. Falls back to the shallowest folder, then the filename.
function titleFor(root: string, file: string): string {
  const rel = path.relative(root, path.dirname(file))
  const segs = rel.split(path.sep).filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!looksLikeRelease(segs[i])) return segs[i]
  }
  return segs[0] || path.basename(file, path.extname(file))
}

async function walkVideos(dir: string, depth: number, out: string[], budget = { n: 0 }) {
  if (depth < 0 || out.length >= 300 || budget.n > 4000) return
  let entries: import('fs').Dirent[] = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    budget.n++
    if (e.name.startsWith('$') || e.name.startsWith('.') || e.name === 'System Volume Information') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkVideos(full, depth - 1, out, budget)
    else if (VIDEO_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full)
  }
}

export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  const disabled = localMediaDisabled()
  if (disabled) return NextResponse.json({ error: disabled }, { status: 501 })

  const sp = new URL(req.url).searchParams

  // Which drives exist, so the browser can start somewhere sensible
  if (sp.get('roots') === '1') {
    const roots: string[] = []
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${letter}:\\`
        try { if ((await stat(p)).isDirectory()) roots.push(p) } catch { /* no such drive */ }
      }
    } else {
      roots.push('/')
    }
    return NextResponse.json({ roots })
  }

  const probePath = sp.get('probe')
  if (probePath) {
    try {
      const file = safeResolve(probePath, { mustBeVideo: true })
      const st = await stat(file)
      const info = await probeMovie(file)
      return NextResponse.json({ ...info, size: st.size, name: path.basename(file), path: file })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'probe failed' }, { status: 400 })
    }
  }

  // Scan a root and group the files it finds into one entry per movie
  const scanRoot = sp.get('scan')
  if (scanRoot) {
    try {
      const root = safeResolve(scanRoot)
      const files: string[] = []
      await walkVideos(root, 4, files)

      // One movie per title; when a folder holds several files (extras,
      // samples) the biggest one is the feature.
      const byTitle = new Map<string, { path: string; size: number; extras: number }>()
      for (const f of files) {
        const title = titleFor(root, f)
        let size = 0
        try { size = (await stat(f)).size } catch { continue }
        const cur = byTitle.get(title)
        if (!cur) byTitle.set(title, { path: f, size, extras: 0 })
        else if (size > cur.size) byTitle.set(title, { path: f, size, extras: cur.extras + 1 })
        else cur.extras++
      }

      // Probe a few at a time — each is a header read, not a decode
      const list = [...byTitle.entries()].map(([title, v]) => ({ title, ...v }))
      const movies: unknown[] = new Array(list.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < list.length) {
          const i = cursor++
          const m = list[i]
          let info = { duration: 0, width: 0, height: 0, codec: 'unknown', fps: 0, playable: false }
          try { info = await probeMovie(m.path) } catch { /* still list it */ }
          movies[i] = {
            title: m.title,
            path: m.path,
            size: m.size,
            extras: m.extras,
            ext: path.extname(m.path).toLowerCase().slice(1),
            duration: info.duration,
            width: info.width,
            height: info.height,
            fps: info.fps,
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker))
      movies.sort((a, b) => String((a as { title: string }).title).localeCompare(String((b as { title: string }).title)))
      return NextResponse.json({ root, movies })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'scan failed' }, { status: 400 })
    }
  }

  const dirParam = sp.get('dir')
  if (!dirParam) return NextResponse.json({ error: 'dir required' }, { status: 400 })
  try {
    const dir = safeResolve(dirParam)
    const entries = await readdir(dir, { withFileTypes: true })
    const folders: { name: string; path: string }[] = []
    const files: { name: string; path: string; size: number; ext: string }[] = []
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        folders.push({ name: e.name, path: full })
      } else if (VIDEO_EXTS.includes(path.extname(e.name).toLowerCase())) {
        // Duration needs a probe per file, which is too slow for a listing —
        // the client probes lazily, on selection
        let size = 0
        try { size = (await stat(full)).size } catch { /* unreadable — still list it */ }
        files.push({ name: e.name, path: full, size, ext: path.extname(e.name).toLowerCase().slice(1) })
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), folders, files })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'listing failed' }, { status: 400 })
  }
}
