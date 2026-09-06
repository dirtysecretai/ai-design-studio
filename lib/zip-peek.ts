import zlib from 'zlib'

/**
 * Read inside a remote ZIP without downloading it.
 *
 * Hunyuan World returns its result as an archive: several `mesh_layerN.ply`
 * running 86MB to 561MB each, plus the panorama images it built the world
 * from. The layers cannot be shown in a browser, so the render arrived looking
 * like a dead end — while the genuinely useful part, a 12MB panorama, sat
 * inside the same file.
 *
 * ZIP puts its index at the END of the file, which makes this possible over
 * plain HTTP: one ranged request finds the central directory, a second reads
 * the single wanted entry. Extracting a panorama from a 563MB archive moves
 * about 13MB instead of 563MB — the difference between something that can run
 * inside a request handler and something that cannot.
 *
 * Only the two compression methods ZIP actually uses in practice are
 * supported: stored and deflate.
 */

export type ZipEntry = {
  name: string
  /** Uncompressed size, which is what a person means by "how big is it". */
  bytes: number
  compressedBytes: number
  method: number
  localOffset: number
}

async function rangeBytes(url: string, start: number, end: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(120_000),
  })
  // 200 means the server ignored the range and is sending the whole archive —
  // refuse rather than pull half a gigabyte into a function.
  if (res.status !== 206) throw new Error(`range requests unsupported (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** The archive's table of contents. */
export async function listZipEntries(url: string): Promise<{ size: number; entries: ZipEntry[] }> {
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  const size = Number(head.headers.get('content-length'))
  if (!Number.isFinite(size) || size <= 0) throw new Error('archive size unknown')

  const tailLen = Math.min(size, 65_536)
  const tail = await rangeBytes(url, size - tailLen, size - 1)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  // Zip64 uses a different terminator; these archives do not, and guessing at
  // one would be worse than saying so.
  if (eocd < 0) throw new Error('no end-of-central-directory record (zip64?)')

  const count = tail.readUInt16LE(eocd + 10)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cdStartInTail = cdOffset - (size - tailLen)
  const cd = cdStartInTail >= 0 ? tail.subarray(cdStartInTail) : await rangeBytes(url, cdOffset, size - 1)

  const entries: ZipEntry[] = []
  let o = 0
  for (let k = 0; k < count && o + 46 <= cd.length; k++) {
    if (cd.readUInt32LE(o) !== 0x02014b50) break
    const nameLen = cd.readUInt16LE(o + 28)
    entries.push({
      method: cd.readUInt16LE(o + 10),
      compressedBytes: cd.readUInt32LE(o + 20),
      bytes: cd.readUInt32LE(o + 24),
      localOffset: cd.readUInt32LE(o + 42),
      name: cd.subarray(o + 46, o + 46 + nameLen).toString('utf8'),
    })
    o += 46 + nameLen + cd.readUInt16LE(o + 30) + cd.readUInt16LE(o + 32)
  }
  return { size, entries }
}

/** Fetch and decompress exactly one entry. */
export async function readZipEntry(url: string, entry: ZipEntry): Promise<Buffer> {
  // The local header repeats the name and extra field, and its extra-field
  // length can differ from the central directory's, so where the data starts
  // has to be read rather than assumed.
  const lh = await rangeBytes(url, entry.localOffset, entry.localOffset + 29)
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local file header')
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  const raw = await rangeBytes(url, dataStart, dataStart + entry.compressedBytes - 1)
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`unsupported compression method ${entry.method}`)
}

/** Panorama candidates, best first. */
const PREVIEW_NAMES = ['full_image_sr.png', 'full_image.png', 'image.png', 'sky_image_sr.png']

/**
 * The best displayable still inside an archive, if there is one.
 *
 * Returns the bytes plus the full listing, because the listing is worth
 * keeping either way — it lets the UI say what is in the archive without ever
 * opening it again.
 */
export async function extractArchivePreview(url: string): Promise<{
  png: Buffer | null
  name: string | null
  entries: { name: string; bytes: number }[]
}> {
  const { entries } = await listZipEntries(url)
  const listing = entries.map(e => ({ name: e.name, bytes: e.bytes }))
  const pick = PREVIEW_NAMES.map(w => entries.find(e => e.name.endsWith(w))).find(Boolean)
    // Any reasonably-sized image will do if none of the known names are there.
    ?? entries.find(e => /\.(png|jpg|jpeg|webp)$/i.test(e.name) && e.bytes < 40 * 1024 * 1024)
  if (!pick) return { png: null, name: null, entries: listing }
  return { png: await readZipEntry(url, pick), name: pick.name, entries: listing }
}
