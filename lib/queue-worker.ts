import prisma from '@/lib/prisma';
import { fal } from '@fal-ai/client';

fal.config({ credentials: process.env.FAL_KEY });

/**
 * Check if a model can accept new generation (under concurrency limit)
 */
export async function canProcessGeneration(modelId: string): Promise<boolean> {
  try {
    const limit = await prisma.modelConcurrencyLimit.findUnique({
      where: { modelId }
    });

    if (!limit) {
      // If no limit exists, allow it (for backward compatibility)
      console.warn(`No concurrency limit found for model: ${modelId}`);
      return true;
    }

    return limit.currentActive < limit.maxConcurrent;
  } catch (error) {
    console.error('Error checking generation capacity:', error);
    return true; // Fail open
  }
}

/**
 * Add a generation to the queue
 */
export async function queueGeneration(params: {
  userId: number;
  modelId: string;
  modelType: 'image' | 'video';
  prompt: string;
  parameters: any;
  ticketCost: number;
  priority?: number;
}): Promise<{ queueId: number; position: number }> {
  try {
    // Reserve tickets — ATOMIC and guarded. This used to be a bare decrement
    // with no balance check, which is how accounts went negative (one user hit
    // -12): concurrent submissions, or a submission with a balance below cost,
    // both just subtracted. The conditional UPDATE only applies when the funds
    // are actually there, and returns 0 rows otherwise.
    if (params.ticketCost > 0) {
      const affected = await prisma.$executeRaw`
        UPDATE "Ticket"
        SET balance = balance - ${params.ticketCost},
            reserved = GREATEST(0, COALESCE(reserved, 0)) + ${params.ticketCost}
        WHERE "userId" = ${params.userId}
          AND (balance - GREATEST(0, COALESCE(reserved, 0))) >= ${params.ticketCost}
      `;
      if (affected === 0) {
        const t = await prisma.ticket.findUnique({ where: { userId: params.userId } });
        const available = Math.max(0, (t?.balance ?? 0) - Math.max(0, t?.reserved ?? 0));
        throw new Error(`Insufficient tickets. Need ${params.ticketCost} ticket(s), but you have ${available}.`);
      }
    }

    // Create queue item
    const queueItem = await prisma.generationQueue.create({
      data: {
        userId: params.userId,
        modelId: params.modelId,
        modelType: params.modelType,
        prompt: params.prompt,
        parameters: params.parameters,
        ticketCost: params.ticketCost,
        priority: params.priority || 0,
        status: 'queued'
      }
    });

    // Calculate position in queue
    const position = await prisma.generationQueue.count({
      where: {
        modelId: params.modelId,
        status: 'queued',
        queuedAt: { lte: queueItem.queuedAt }
      }
    });

    // Update position
    await prisma.generationQueue.update({
      where: { id: queueItem.id },
      data: { queuePosition: position }
    });

    return { queueId: queueItem.id, position };
  } catch (error) {
    console.error('Error queueing generation:', error);
    throw error;
  }
}

/**
 * Get next item from queue for a specific model
 */
export async function getNextQueueItem(modelId: string) {
  try {
    const nextItem = await prisma.generationQueue.findFirst({
      where: {
        modelId,
        status: 'queued'
      },
      orderBy: [
        { priority: 'desc' },
        { queuedAt: 'asc' }
      ]
    });

    return nextItem;
  } catch (error) {
    console.error('Error getting next queue item:', error);
    return null;
  }
}

/**
 * Mark a queue item as processing
 */
export async function startProcessing(queueId: number): Promise<boolean> {
  try {
    const item = await prisma.generationQueue.findUnique({
      where: { id: queueId }
    });

    if (!item || item.status !== 'queued') {
      return false;
    }

    // Increment active count
    await prisma.modelConcurrencyLimit.update({
      where: { modelId: item.modelId },
      data: { currentActive: { increment: 1 } }
    });

    // Update queue item
    await prisma.generationQueue.update({
      where: { id: queueId },
      data: {
        status: 'processing',
        startedAt: new Date()
      }
    });

    return true;
  } catch (error) {
    console.error('Error starting processing:', error);
    return false;
  }
}

/**
 * Mark a queue item as completed
 */
export async function completeGeneration(
  queueId: number,
  resultUrl: string
): Promise<void> {
  try {
    const item = await prisma.generationQueue.findUnique({
      where: { id: queueId }
    });

    if (!item) return;

    // Move reserved tickets to used
    await prisma.ticket.update({
      where: { userId: item.userId },
      data: {
        reserved: { decrement: item.ticketCost },
        totalUsed: { increment: item.ticketCost }
      }
    });

    // Update queue item
    await prisma.generationQueue.update({
      where: { id: queueId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        resultUrl
      }
    });

    // Decrement active count
    await prisma.modelConcurrencyLimit.update({
      where: { modelId: item.modelId },
      data: { currentActive: { decrement: 1 } }
    });

    // Process next item in queue
    await processNextInQueue(item.modelId);
  } catch (error) {
    console.error('Error completing generation:', error);
  }
}

/**
 * Mark a queue item as failed
 */
export async function failGeneration(
  queueId: number,
  errorMessage: string
): Promise<void> {
  try {
    const item = await prisma.generationQueue.findUnique({
      where: { id: queueId }
    });

    if (!item) return;

    // Refund reserved tickets
    await prisma.ticket.update({
      where: { userId: item.userId },
      data: {
        balance: { increment: item.ticketCost },
        reserved: { decrement: item.ticketCost }
      }
    });

    // Update queue item
    await prisma.generationQueue.update({
      where: { id: queueId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage
      }
    });

    // Decrement active count
    await prisma.modelConcurrencyLimit.update({
      where: { modelId: item.modelId },
      data: { currentActive: { decrement: 1 } }
    });

    // Process next item in queue
    await processNextInQueue(item.modelId);
  } catch (error) {
    console.error('Error failing generation:', error);
  }
}

/**
 * Process next item in queue for a model (if capacity available).
 * Called after each job completes or fails to keep the queue moving.
 */
export async function processNextInQueue(modelId: string): Promise<void> {
  try {
    // Check if we can process more
    const canProcess = await canProcessGeneration(modelId);
    if (!canProcess) return;

    // Get next queued item
    const nextItem = await getNextQueueItem(modelId);
    if (!nextItem) return;

    const params = nextItem.parameters as any;
    const appUrl = process.env.APP_URL || `https://${process.env.VERCEL_URL}`;
    const webhookUrl = `${appUrl}/api/webhooks/fal`;

    // Mark as processing first to avoid double-dispatch races
    await startProcessing(nextItem.id);

    // Submit to FAL.ai queue
    const { request_id } = await fal.queue.submit(nextItem.modelId, {
      input: params?.falInput || params,
      webhookUrl,
    });

    // Save the FAL.ai request_id so the webhook can look it up
    await prisma.generationQueue.update({
      where: { id: nextItem.id },
      data: { falRequestId: request_id }
    });

    console.log(`Dispatched queue item #${nextItem.id} for model ${modelId}, request_id: ${request_id}`);
  } catch (error) {
    console.error('Error processing next in queue:', error);
  }
}

/**
 * Get queue status for a user's generation
 */
export async function getQueueStatus(queueId: number) {
  try {
    const item = await prisma.generationQueue.findUnique({
      where: { id: queueId }
    });

    if (!item) return null;

    if (item.status === 'queued') {
      // Calculate current position
      const position = await prisma.generationQueue.count({
        where: {
          modelId: item.modelId,
          status: 'queued',
          queuedAt: { lte: item.queuedAt }
        }
      });

      return {
        status: 'queued',
        position,
        estimatedWait: position * 30 // Rough estimate: 30 seconds per generation
      };
    }

    return {
      status: item.status,
      resultUrl: item.resultUrl,
      errorMessage: item.errorMessage
    };
  } catch (error) {
    console.error('Error getting queue status:', error);
    return null;
  }
}
