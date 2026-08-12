import { NextResponse } from 'next/server'
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { checkAdminRequest } from '@/lib/admin-check'

// Built-in models bundled in the worker image — excluded from the custom list
const BUILT_IN = new Set(['4x-UltraSharp.pth', 'RealESRGAN_x4plus.pth', 'RealESRGAN_x2plus.pth'])

function makeR2() {
  return new S3Client({
    region:   'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
    maxAttempts: 1,
  })
}

// GET /api/admin/flux-inference/esrgan-models
// Returns { models: string[] } — custom .pth filenames in training/models/esrgan/
export async function GET(req: Request) {
  if (!await checkAdminRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_BUCKET_NAME) {
    return NextResponse.json({ models: [] })
  }
  try {
    const r2  = makeR2()
    const res = await Promise.race([
      r2.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: 'training/models/esrgan/',
      })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ])
    const models = (res.Contents ?? [])
      .map(o => o.Key!.split('/').pop()!)
      .filter(name => name.endsWith('.pth') && !BUILT_IN.has(name))
      .sort((a, b) => a.localeCompare(b))
    return NextResponse.json({ models })
  } catch {
    return NextResponse.json({ models: [] })
  }
}
