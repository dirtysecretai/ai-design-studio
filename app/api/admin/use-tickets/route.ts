import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getUserFromSession } from '@/lib/auth'
import prisma from '@/lib/prisma'

// POST /api/admin/use-tickets
// Deducts tickets from the current session user (admin client-side accounting for
// models that bypass /api/generate). Refunds are NO LONGER handled here — they are
// issued server-side on failure by releaseQueueSlot (lib/admin-queue-helpers.ts),
// tied to a real failed job. The old client-trusted `refund` action let a user
// restore their balance up to totalBought for free; it has been removed.
// body: { action: "deduct", amount: number }
// Returns: { success: true, newBalance: number }
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const user = await getUserFromSession(token)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

    const { action, amount } = await req.json()
    if (!action || typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'Invalid action or amount' }, { status: 400 })
    }

    if (action === 'deduct') {
      // ATOMIC check+deduct. The old read-then-update was a TOCTOU race: two
      // concurrent requests could both pass the balance check and both
      // subtract, driving the balance negative. The conditional UPDATE makes
      // the check and the deduction a single indivisible operation.
      const affected = await prisma.$executeRaw`
        UPDATE "Ticket"
        SET balance = balance - ${amount}, "totalUsed" = "totalUsed" + ${amount}
        WHERE "userId" = ${user.id}
          AND (balance - GREATEST(0, COALESCE(reserved, 0))) >= ${amount}
      `
      if (affected === 0) {
        return NextResponse.json({ error: 'Insufficient tickets' }, { status: 402 })
      }
      const updated = await prisma.ticket.findUnique({
        where: { userId: user.id }, select: { balance: true },
      })
      return NextResponse.json({ success: true, newBalance: updated?.balance ?? 0 })
    }

    if (action === 'refund') {
      // Removed: refunds are issued server-side on job failure (releaseQueueSlot),
      // never on client request. Reject so the old exploit path is dead.
      return NextResponse.json({ error: 'Refunds are handled automatically on failure' }, { status: 400 })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error: any) {
    console.error('use-tickets error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
