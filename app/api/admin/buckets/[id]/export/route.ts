import { NextResponse } from 'next/server'
import JSZip from 'jszip'
import { prisma } from '@/lib/prisma'
import { checkAuth } from '@/lib/admin-auth'
import { composeTrainingCaption, normalizeCaptionSections } from '@/lib/caption-compose'


// GET /api/admin/buckets/[id]/export
// Streams a zip of all images in the bucket plus a .txt caption file for each.
// Caption file contains the adminCaption if set, otherwise falls back to the prompt.
// Skips videos. Named sequentially: 0001.jpg + 0001.txt, 0002.jpg + 0002.txt, ...
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return new NextResponse('Unauthorized', { status: 401 })

  const { id } = await params
  const bucketId = parseInt(id)
  if (isNaN(bucketId)) return new NextResponse('Invalid id', { status: 400 })

  const bucket = await prisma.datasetBucket.findUnique({
    where: { id: bucketId },
    include: {
      images: {
        include: {
          image: {
            select: { id: true, imageUrl: true, adminCaption: true, prompt: true, adminTags: true, model: true, captionSections: true },
          },
        },
        orderBy: { addedAt: 'asc' },
      },
    },
  })

  if (!bucket) return new NextResponse('Bucket not found', { status: 404 })

  // Filter out videos and images with no URL
  const imageEntries = bucket.images
    .map(bi => bi.image)
    .filter(img => img.imageUrl && !/\.(mp4|webm|mov|avi|mkv)$/i.test(img.imageUrl))

  if (imageEntries.length === 0) {
    return new NextResponse('No images in bucket', { status: 404 })
  }

  const zip = new JSZip()
  const folder = zip.folder(bucket.name.replace(/[^a-z0-9-_]/gi, '_')) ?? zip

  let downloaded = 0
  await Promise.all(
    imageEntries.map(async (img, i) => {
      const idx = String(i + 1).padStart(4, '0')
      try {
        const res = await fetch(img.imageUrl, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) return
        const buffer = Buffer.from(await res.arrayBuffer())
        const contentType = res.headers.get('content-type') || 'image/jpeg'
        const ext = contentType.includes('webp') ? 'webp'
                  : contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
                  : contentType.includes('png') ? 'png'
                  : 'jpg'

        folder.file(`${idx}.${ext}`, buffer)

        // Caption: composable sections when configured; otherwise adminCaption
        // with a prompt fallback for AI-generated images only (uploads have
        // prompt = filename, useless as a training caption)
        const isUpload = img.model === '__upload__'
        const caption = composeTrainingCaption({
          adminCaption: img.adminCaption,
          prompt: isUpload ? '' : img.prompt,
          adminTags: img.adminTags,
          sections: normalizeCaptionSections(img.captionSections),
          fallbackCaption: !isUpload ? img.prompt : '',
        })
        folder.file(`${idx}.txt`, caption)

        downloaded++
      } catch {
        // Skip unreachable images silently
      }
    })
  )

  if (downloaded === 0) {
    return new NextResponse('Could not download any images', { status: 500 })
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  const safeName = bucket.name.replace(/[^a-z0-9-_]/gi, '_')
  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}-dataset.zip"`,
      'Content-Length': String(zipBuffer.length),
    },
  })
}
