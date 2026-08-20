import { NextRequest, NextResponse } from 'next/server'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getUserFromSession } from '@/lib/auth'
import { cookies } from 'next/headers'
import { checkIsAdmin } from '@/lib/admin-check'
import { checkAuth } from '@/lib/admin-auth'

// GET /api/admin/video-loras — list trained Wan/LTX LoRA runs from R2
// (training/video-loras/<run>/run.json + final.safetensors). Admin only.
// Auth: admin session cookie OR x-admin-password header (trainer page uses
// the header, portal uses the session).

export const dynamic = 'force-dynamic'

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

let cache: { at: number; data: unknown } | null = null

export async function GET(req: NextRequest) {
  let authed = checkAuth(req)
  if (!authed) {
    const token = (await cookies()).get('session')?.value
    const user = token ? await getUserFromSession(token) : null
    authed = !!user && await checkIsAdmin(user.email)
  }
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (cache && Date.now() - cache.at < 60_000 && !req.nextUrl.searchParams.has('fresh')) {
    return NextResponse.json(cache.data)
  }

  const bucket = process.env.R2_BUCKET_NAME!
  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
  const prefix = 'training/video-loras/'

  const keys: string[] = []
  let token2: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token2, MaxKeys: 1000,
    }))
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key)
    token2 = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token2)

  const runFolders = [...new Set(
    keys
      .filter(k => k.endsWith('/run.json'))
      .map(k => k.slice(prefix.length).split('/')[0])
  )]

  const runs: unknown[] = []
  for (const folder of runFolders) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${folder}/run.json` }))
      const meta = JSON.parse(await obj.Body!.transformToString()) as Record<string, unknown>
      const files = (meta.files ?? {}) as Record<string, string>
      runs.push({
        run: folder,
        name: meta.run_name ?? folder,
        family: meta.family ?? null,
        variant: meta.variant ?? null,
        trigger_phrase: meta.trigger_phrase ?? null,
        imageCount: meta.imageCount ?? null,
        createdAt: meta.createdAt ?? null,
        loraUrl: files['final.safetensors'] ?? `${publicBase}/${prefix}${folder}/final.safetensors`,
        highNoiseUrl: files['high_noise.safetensors'] ?? null,
      })
    } catch (e) {
      console.error(`[video-loras] bad run.json in ${folder}:`, e)
    }
  }

  runs.sort((a, b) => String((b as { createdAt?: string }).createdAt ?? '').localeCompare(String((a as { createdAt?: string }).createdAt ?? '')))
  const data = { runs }
  cache = { at: Date.now(), data }
  return NextResponse.json(data)
}
