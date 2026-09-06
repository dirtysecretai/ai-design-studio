import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { uploadToR2 } from '@/lib/r2'
import { spawn } from 'child_process'
import { writeFile, readFile, readdir, rm, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { jsonPrivate } from '@/lib/api-json'

const FALLBACK_ADMIN_EMAILS = ['promptandprotocol@gmail.com', 'dirtysecretai@gmail.com']

async function getAdminUser(): Promise<{ id: number; email: string } | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return null
    const user = await getUserFromSession(token)
    if (!user) return null
    const count = await prisma.adminAccount.count()
    if (count === 0) return FALLBACK_ADMIN_EMAILS.includes(user.email) ? user : null
    const account = await prisma.adminAccount.findUnique({ where: { email: user.email } })
    return account?.canAccessAdmin ? user : null
  } catch { return null }
}

// In-memory job store — survives page refreshes, cleared on server restart
type Job = {
  status: 'pending' | 'done' | 'error'
  imageUrl?: string
  dbId?: number
  error?: string
  createdAt: number
}
const jobs = new Map<string, Job>()

// Prune jobs older than 30 minutes
function pruneJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id)
  }
}

const PYTHON_CANDIDATES = [
  path.join(process.cwd(), 'AI', 'Real-ESRGAN', 'venv', 'Scripts', 'python.exe'),
  path.join(process.cwd(), 'AI', 'upscaler-venv', 'Scripts', 'python.exe'),
  'C:\\Users\\Owner\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
]

function findPython(): string {
  for (const p of PYTHON_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return 'python'
}

async function runInferenceBackground(
  jobId: string,
  userId: number,
  prompt: string,
  imageUrl: string,
  modelPath: string,
  scale: number,
) {
  const tmpDir = path.join(os.tmpdir(), `esrgan-${jobId}`)
  const inPath = path.join(tmpDir, 'input.png')
  const outDir = path.join(tmpDir, 'out')

  try {
    // No hard timeout — large images can take >30s to download
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Failed to fetch source image (${imgRes.status})`)
    const buf = Buffer.from(await imgRes.arrayBuffer())

    await mkdir(tmpDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    await writeFile(inPath, buf)

    const pythonExe = findPython()
    const script    = path.join(process.cwd(), 'AI', 'upscaler-infer.py')

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonExe, [
        script,
        '--model_path', modelPath,
        '-i', inPath,
        '-o', outDir,
        '--outscale', String(scale),
      ], {
        cwd: path.join(process.cwd(), 'AI'),
        // Ignore stdin; drain stdout so the 64 KB pipe buffer never fills and kills the process
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Drain stdout — Real-ESRGAN logs progress there; not reading it causes ECONNABORTED
      proc.stdout.on('data', () => {})

      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr.slice(-800) || `Exit code ${code}`))
      })
      proc.on('error', reject)
    })

    const files = await readdir(outDir)
    if (files.length === 0) throw new Error('No output generated')

    const outBuf = await readFile(path.join(outDir, files[0]))

    // Upload to R2
    const key = `local-esrgan/${userId}/${jobId}.png`
    const r2Url = await uploadToR2(key, outBuf, 'image/png')

    // Save to DB so it appears in the user's feed on page refresh
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
    const saved = await prisma.generatedImage.create({
      data: {
        userId,
        prompt,
        imageUrl: r2Url,
        model: 'local-realesrgan',
        ticketCost: 0,
        referenceImageUrls: [],
        expiresAt,
      },
    })

    jobs.set(jobId, { status: 'done', imageUrl: r2Url, dbId: saved.id, createdAt: jobs.get(jobId)!.createdAt })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    jobs.set(jobId, { status: 'error', error: msg, createdAt: jobs.get(jobId)?.createdAt ?? Date.now() })
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// POST — submit job, return jobId immediately
export async function POST(req: Request) {
  const user = await getAdminUser()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const { imageUrl, modelPath, scale = 4, prompt = 'Local ESRGAN upscale' } = await req.json()
  if (!imageUrl || !modelPath) return jsonPrivate({ error: 'imageUrl and modelPath required' }, { status: 400 })
  if (!existsSync(modelPath)) return jsonPrivate({ error: `Model not found: ${modelPath}` }, { status: 400 })

  pruneJobs()
  const jobId = `esrgan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  jobs.set(jobId, { status: 'pending', createdAt: Date.now() })

  // Fire and forget — job runs in background
  runInferenceBackground(jobId, user.id, prompt, imageUrl, modelPath, scale)

  return jsonPrivate({ jobId })
}

// GET — poll job status
export async function GET(req: Request) {
  const user = await getAdminUser()
  if (!user) return jsonPrivate({ error: 'Unauthorized' }, { status: 401 })

  const jobId = new URL(req.url).searchParams.get('jobId')
  if (!jobId) return jsonPrivate({ error: 'jobId required' }, { status: 400 })

  const job = jobs.get(jobId)
  if (!job) return jsonPrivate({ status: 'not_found' }, { status: 404 })

  return jsonPrivate({ status: job.status, imageUrl: job.imageUrl, dbId: job.dbId, error: job.error })
}
