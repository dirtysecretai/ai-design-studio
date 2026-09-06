import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const MULTIPART_CHUNK_SIZE = 50 * 1024 * 1024  // 50 MB

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

/**
 * The PRIVATE bucket: everything a user makes or uploads.
 *
 * Its r2.dev public access is switched off. The only way to read it is a URL
 * signed by lib/media-url.ts and served by the media Worker.
 */
const BUCKET = process.env.R2_BUCKET_NAME!

/**
 * The prefix private objects are recorded under in the database.
 *
 * This used to be a working public URL and is now just an identifier — the
 * shape that marks a stored value as "private media, sign it before handing it
 * out". Keeping it means none of the 86,000 rows already storing one has to be
 * rewritten. Do not put it in a response; run the value through
 * signMediaUrl/signPayload instead.
 */
export const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

/**
 * The PUBLIC bucket: site logo, home cards, shop products, gallery, carousel.
 *
 * A separate bucket rather than a prefix, because R2's public access is a
 * per-bucket switch — there is no such thing as a public prefix. Making it a
 * storage boundary also means "is this public?" is answered by where the file
 * is, not by remembering to call the right helper.
 */
const PUBLIC_BUCKET = process.env.R2_PUBLIC_BUCKET_NAME || ''
export const PUBLIC_ASSET_URL = (process.env.R2_PUBLIC_ASSET_URL || '').replace(/\/$/, '')

/**
 * Namespace a private upload to its owner.
 *
 * Ownership is enforced in Postgres, so this is not what makes the object
 * safe. It is what makes an object's owner readable from its key — which is
 * what an audit needs, what a per-user purge needs, and what the Worker would
 * need if this ever moves to a first-party signed cookie (that design checks a
 * key prefix against the cookie's user id).
 */
export function userKey(userId: number | string, rest: string): string {
  return `u/${userId}/${rest.replace(/^\/+/, '')}`
}

export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<string> {
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
  return `${PUBLIC_URL}/${key}`
}

/**
 * Write to the PUBLIC bucket. Only for assets that are meant to be visible to
 * anonymous visitors: the site logo, home cards, shop products, the gallery
 * and the carousel. Anything a user made belongs in uploadToR2.
 */
export async function uploadPublicAsset(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<string> {
  // The public bucket is step one of the privacy rollout and does not exist
  // yet in production. Until it does, these fall back to the current bucket —
  // exactly where they already live. Throwing instead would take the logo,
  // home-card and carousel uploaders down the moment this deployed, for a
  // migration that has not happened.
  if (!PUBLIC_BUCKET || !PUBLIC_ASSET_URL) {
    console.warn('[r2] public asset bucket not configured; storing on the main bucket')
    return uploadToR2(key, body, contentType)
  }
  await r2.send(new PutObjectCommand({
    Bucket: PUBLIC_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
  return `${PUBLIC_ASSET_URL}/${key}`
}

/** Does this object exist on the private bucket? */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

export async function presignPutUrl(
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType })
  const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn })
  return { uploadUrl, publicUrl: `${PUBLIC_URL}/${key}` }
}

export async function presignGetUrl(key: string, expiresIn = 3600): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key })
  return getSignedUrl(r2, cmd, { expiresIn })
}

export async function initMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
  const res = await r2.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }))
  if (!res.UploadId) throw new Error('R2 did not return an UploadId')
  return { uploadId: res.UploadId }
}

export async function presignUploadPart(key: string, uploadId: string, partNumber: number, expiresIn = 3600): Promise<string> {
  return getSignedUrl(r2, new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn })
}

export async function completeMultipartUpload(key: string, uploadId: string): Promise<void> {
  const parts: { PartNumber: number; ETag: string }[] = []
  let marker: string | undefined
  do {
    const res = await r2.send(new ListPartsCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
    for (const p of res.Parts ?? []) {
      if (p.PartNumber && p.ETag) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag })
    }
    marker = res.IsTruncated && res.NextPartNumberMarker != null ? String(res.NextPartNumberMarker) : undefined
  } while (marker)
  parts.sort((a, b) => a.PartNumber - b.PartNumber)
  await r2.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }))
}

export async function deleteFromR2(urlOrKey: string | string[]): Promise<void> {
  const keys = Array.isArray(urlOrKey) ? urlOrKey : [urlOrKey]
  for (const item of keys) {
    // A caller may hold the stored form, a signed media URL, or a bare key.
    const key = item.startsWith('http')
      ? item.replace(`${PUBLIC_URL}/`, '').replace(/^https?:\/\/[^/]+\//, '').split('?')[0]
      : item
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  }
}
