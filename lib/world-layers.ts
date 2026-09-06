import sharp from 'sharp'
import { listZipEntries, readZipEntry, type ZipEntry } from './zip-peek'

/**
 * Turn a Hunyuan World archive into layers a browser can actually move.
 *
 * Hunyuan World does not return a model — it returns a layered 2.5D scene:
 * four `mesh_layerN.ply` totalling ~23 million triangles and 850MB, which no
 * browser will open, plus the plates those layers were built from. The
 * geometry is out of reach; the plates are not, and they are the same
 * decomposition: an inpainted sky, the scene with the foreground removed, and
 * a mask per foreground subject.
 *
 * Stacked and shifted against each other under the pointer, those plates give
 * back the depth the meshes encode, for a few hundred kilobytes instead of
 * 850MB. It is a truer representation than orbiting the geometry would be
 * anyway — the layers are depth shells meant to be seen from near the original
 * camera, and orbiting one looks like cardboard.
 *
 * The archive is never downloaded whole; each plate is pulled out of it
 * individually over ranged requests.
 */

export type WorldLayerRole = 'sky' | 'scene' | 'background' | 'subject'

export type BuiltLayer = {
  role: WorldLayerRole
  /** How far this plate travels, 0 = pinned, 1 = full throw. */
  depth: number
  label?: string
  webp: Buffer
}

/** Wide enough to look sharp, small enough to animate. The plates are 4K. */
const LAYER_WIDTH = 1600

const firstOf = (entries: ZipEntry[], names: string[]) =>
  names.map(n => entries.find(e => e.name.endsWith(n))).find(Boolean)

/**
 * Foreground masks are stored as 0/1, not 0/255 — a straight read looks like
 * an empty image (mean 0.2) and silently produces a fully transparent cutout.
 * Scaling is what makes them usable as an alpha channel.
 */
async function maskToAlpha(mask: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(mask)
    .greyscale()
    .linear(255, 0)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer()
}

/** An RGB plate cut to a mask, as a transparent WebP. */
async function cutout(plate: Buffer, mask: Buffer, width: number, height: number): Promise<Buffer> {
  const rgb = await sharp(plate).resize(width, height, { fit: 'fill' }).removeAlpha().toBuffer()
  const alpha = await maskToAlpha(mask, width, height)
  return sharp(rgb)
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .webp({ quality: 82 })
    .toBuffer()
}

/**
 * Is this worth showing as parallax?
 *
 * Depth is only visible when something is CUT OUT and standing in front of
 * something else. Two opaque full-frame plates just wobble. A cut layer is
 * either a segmented subject, or the ground plane lifted off the sky — either
 * one is enough.
 */
export function worthParallax(layers: { role: string }[]): boolean {
  return layers.some(l => l.role === 'subject' || l.role === 'scene')
}

export async function buildWorldLayers(zipUrl: string): Promise<{
  layers: BuiltLayer[]
  entries: { name: string; bytes: number }[]
  full: Buffer | null
}> {
  const { entries } = await listZipEntries(zipUrl)
  const listing = entries.map(e => ({ name: e.name, bytes: e.bytes }))

  const fullEntry = firstOf(entries, ['full_image_sr.png', 'full_image.png', 'image.png'])
  if (!fullEntry) return { layers: [], entries: listing, full: null }
  const fullPng = await readZipEntry(zipUrl, fullEntry)

  const meta = await sharp(fullPng).metadata()
  const width = LAYER_WIDTH
  const height = Math.round((meta.height ?? 1) * (LAYER_WIDTH / (meta.width ?? 1)))

  const layers: BuiltLayer[] = []
  const resizeWebp = (buf: Buffer) =>
    sharp(buf).resize(width, height, { fit: 'fill' }).webp({ quality: 82 }).toBuffer()

  // ── deepest: the inpainted sky plate, already complete ───────────────────
  const sky = firstOf(entries, ['sky_image_sr.png', 'sky_image.png'])
  if (sky) {
    layers.push({ role: 'sky', depth: 0, webp: await resizeWebp(await readZipEntry(zipUrl, sky)) })
  }

  /*
   * ── the scene, lifted off the sky ────────────────────────────────────────
   *
   * Preferably the plate with every subject removed and the hole painted in
   * (progressive removal: remove_fg2 has had more taken out than remove_fg1),
   * otherwise the full frame.
   *
   * Cut against sky_mask where one exists, which is the difference between a
   * scene with depth and two opaque plates sliding past each other. Some
   * worlds segment no subject at all — a landscape has nobody standing in it —
   * and for those this horizon cut is the ONLY depth on offer.
   *
   * The mask marks the ground white and the sky black, and unlike the subject
   * masks it is already full-range 0/255.
   */
  const bgEntry = firstOf(entries, ['remove_fg2_image_sr.png', 'remove_fg1_image_sr.png', 'remove_fg2_image.png', 'remove_fg1_image.png'])
  const bgPng = bgEntry ? await readZipEntry(zipUrl, bgEntry) : fullPng
  const skyMask = firstOf(entries, ['sky_mask.png'])
  if (sky && skyMask) {
    layers.push({
      role: 'scene',
      depth: 0.35,
      webp: await cutout(bgPng, await readZipEntry(zipUrl, skyMask), width, height),
    })
  } else {
    layers.push({ role: 'background', depth: sky ? 0.25 : 0, webp: await resizeWebp(bgPng) })
  }

  // ── the subjects, cut from the full plate ────────────────────────────────
  type Subject = { mask: ZipEntry; label?: string; bottom: number }
  const subjects: Subject[] = []
  for (const n of ['fg1', 'fg2']) {
    const mask = entries.find(e => e.name.endsWith(`${n}_mask.png`))
    if (!mask) continue
    let label: string | undefined
    let bottom = 0
    const meta_ = entries.find(e => e.name.endsWith(`${n}.json`))
    if (meta_) {
      try {
        const j = JSON.parse((await readZipEntry(zipUrl, meta_)).toString('utf8')) as {
          bboxes?: { label?: string; bbox?: number[] }[]
        }
        const first = j.bboxes?.[0]
        label = first?.label
        bottom = first?.bbox?.[3] ?? 0
      } catch { /* the cutout works without a label */ }
    }
    subjects.push({ mask, label, bottom })
  }

  // Nearest last. An object whose box reaches further down the frame is
  // standing closer to the camera — the only depth cue the archive gives,
  // and a reliable one for a photographed scene.
  subjects.sort((a, b) => a.bottom - b.bottom)
  for (let i = 0; i < subjects.length; i++) {
    const s = subjects[i]
    layers.push({
      role: 'subject',
      depth: subjects.length === 1 ? 1 : 0.6 + (0.4 * i) / (subjects.length - 1),
      label: s.label,
      webp: await cutout(fullPng, await readZipEntry(zipUrl, s.mask), width, height),
    })
  }

  return { layers, entries: listing, full: fullPng }
}
