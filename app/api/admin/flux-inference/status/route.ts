import { NextResponse } from 'next/server'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { checkAdminRequest } from '@/lib/admin-check'

const RUNPOD_API = 'https://api.runpod.ai/v2'


const r2 = new S3Client({
  region:   'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

interface RunPodOutput {
  success?: boolean
  error?: string
  output_r2_key?: string
  logs?: string[]
}

interface RunPodStatus {
  id:            string
  status:        string
  output?:       RunPodOutput
  error?:        string
  executionTime?: number
}

export async function GET(req: Request) {
  if (!await checkAdminRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('job_id')
  if (!jobId) return NextResponse.json({ error: 'Missing job_id' }, { status: 400 })

  const endpointId = process.env.RUNPOD_ENDPOINT_ID
  const apiKey     = process.env.RUNPOD_API_KEY
  if (!endpointId || !apiKey)
    return NextResponse.json({ error: 'RunPod not configured' }, { status: 500 })

  const res = await fetch(`${RUNPOD_API}/${endpointId}/status/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) return NextResponse.json({ error: 'Failed to get RunPod status' }, { status: res.status })

  const data = await res.json() as RunPodStatus
  const statusMap: Record<string, string> = {
    IN_QUEUE:    'running',
    IN_PROGRESS: 'running',
    COMPLETED:   'done',
    FAILED:      'error',
    CANCELLED:   'cancelled',
    TIMED_OUT:   'error',
  }

  const output    = data.output ?? {}
  const rpStatus  = statusMap[data.status] ?? 'running'
  const r2Key     = output.output_r2_key ?? null

  // Generate a 1-hour presigned URL for the result image when done
  let imageUrl: string | null = null
  if (rpStatus === 'done' && r2Key) {
    try {
      imageUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
        { expiresIn: 3600 },
      )
    } catch { /* leave null */ }
  }

  return NextResponse.json({
    status:    rpStatus,
    job_id:    jobId,
    success:   output.success ?? null,
    error:     output.error ?? data.error ?? null,
    image_url: imageUrl,
    r2_key:    r2Key,
    logs:      output.logs ?? [],
  })
}
