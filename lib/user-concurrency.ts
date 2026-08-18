import prisma from '@/lib/prisma'

const OWNER_EMAILS = ['dirtysecretai@gmail.com', 'promptandprotocol@gmail.com']

// Limits per tier: owner=unlimited, dev=6, free=2
export async function getUserConcurrencyLimit(userId: number): Promise<number> {
  const [user, sub] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.subscription.findFirst({
      where: {
        userId,
        tier: 'prompt-studio-dev',
        status: 'active',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      },
      select: { id: true },
    }),
  ])
  if (!user) return 2
  if (OWNER_EMAILS.includes(user.email)) return 999
  // Audit/reviewer accounts (@audit.pp, e.g. CCBill compliance) test as Dev Tier
  if (user.email.endsWith('@audit.pp')) return 6
  return sub ? 6 : 2
}

// Count active (processing, queued, or freshly-claimed pending) image
// generations for this user. 'pending' rows are atomic claims made by
// claimUserGenerationRow below — they hold the user's slot for the second or
// two between claim and submit, so a burst of spam can't slip past the limit.
export async function getUserActiveGenerations(userId: number): Promise<number> {
  return prisma.generationQueue.count({
    where: {
      userId,
      modelType: 'image',
      status: { in: ['processing', 'queued', 'pending'] },
    },
  })
}

// ── ATOMIC user-slot claim ──
// The old checkUserConcurrency was read-then-act: N simultaneous submissions
// all read the same active count, all passed, and the user blew straight
// through their limit. This claims the slot atomically by creating the
// GenerationQueue row INSIDE a per-user advisory-locked transaction — the
// lock serializes concurrent submissions for one user, and the created
// 'pending' row is counted by the next request's check, so at most `limit`
// rows can ever exist. The caller then charges tickets and flips the row to
// 'queued'/'processing' (or deletes it on failure). Rows stuck in 'pending'
// (crashed function) are swept by the drain-queue cron.
export async function claimUserGenerationRow(args: {
  userId: number
  modelId: string
  modelType: 'image' | 'video'
  prompt: string
  parameters: object
  ticketCost: number
}): Promise<{ ok: true; rowId: number } | { ok: false; activeCount: number; limit: number }> {
  const limit = await getUserConcurrencyLimit(args.userId)
  return prisma.$transaction(async (tx) => {
    // Transaction-scoped advisory lock — safe under connection pooling
    // (released automatically at commit/rollback)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gen-claim-' + args.userId}))`
    const activeCount = await tx.generationQueue.count({
      where: {
        userId: args.userId,
        modelType: args.modelType,
        status: { in: ['processing', 'queued', 'pending'] },
      },
    })
    if (activeCount + 1 > limit) {
      return { ok: false as const, activeCount, limit }
    }
    const row = await tx.generationQueue.create({
      data: {
        userId: args.userId,
        modelId: args.modelId,
        modelType: args.modelType,
        prompt: args.prompt.slice(0, 5000),
        parameters: args.parameters as never,
        status: 'pending',
        ticketCost: args.ticketCost,
      },
      select: { id: true },
    })
    return { ok: true as const, rowId: row.id }
  }, { timeout: 15000 })
}

export async function checkUserConcurrency(
  userId: number,
  slotsNeeded = 1
): Promise<{ allowed: boolean; activeCount: number; limit: number }> {
  const [activeCount, limit] = await Promise.all([
    getUserActiveGenerations(userId),
    getUserConcurrencyLimit(userId),
  ])
  return { allowed: activeCount + slotsNeeded <= limit, activeCount, limit }
}
