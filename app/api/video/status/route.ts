import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { fal } from "@fal-ai/client";
import { uploadToR2 } from '@/lib/r2';
import { resolveRequestUser, requireScopes } from '@/lib/api-key-auth';


fal.config({
  credentials: process.env.FAL_KEY!
});

// POST /api/video/status
// Polls a FAL queue job and saves to DB on completion.
// Body: { requestId, falEndpoint, prompt, model, duration, resolution, ticketCost, thumbnailUrl }
export async function POST(request: NextRequest) {
  try {
    // Authenticate — bearer API key (desktop app) or session cookie
    const resolved = await resolveRequestUser(request);
    if ('error' in resolved) return resolved.error;
    const { user, apiAuth } = resolved;
    if (apiAuth) {
      const denied = requireScopes(apiAuth, 'jobs:read');
      if (denied) return denied;
    }

    const {
      requestId,
      falEndpoint,
      prompt,
      model,
      duration,
      resolution,
      ticketCost,
      thumbnailUrl,
      queuedAt,
    } = await request.json();

    if (!requestId || !falEndpoint) {
      return NextResponse.json({ error: 'Missing requestId or falEndpoint' }, { status: 400 });
    }

    // Check FAL queue status
    const status = await fal.queue.status(falEndpoint, { requestId, logs: false });

    if (status.status === 'COMPLETED') {
      // Fetch the result
      const result = await fal.queue.result<any>(falEndpoint, { requestId });

      const falVideoUrl = result.data?.video?.url;
      if (!falVideoUrl) {
        return NextResponse.json({ status: 'failed', error: 'No video URL in result' });
      }

      const actualPrompt = result.data?.actual_prompt || prompt;

      // Idempotency: if this requestId was already saved, return the existing record
      const existingVideo = await prisma.generatedImage.findFirst({
        where: { falRequestId: requestId },
        select: { id: true, imageUrl: true },
      })
      if (existingVideo) {
        console.log(`↩ Video already saved [${requestId}] returning existing record ${existingVideo.id}`)
        return NextResponse.json({
          status: 'completed',
          videoUrl: existingVideo.imageUrl,
          thumbnailUrl: existingVideo.imageUrl,
          videoId: existingVideo.id,
          actualPrompt,
        })
      }

      // Upload video to Vercel Blob for permanent storage (FAL URLs expire after ~24–48h)
      let permanentVideoUrl = falVideoUrl
      try {
        const videoRes = await fetch(falVideoUrl)
        if (videoRes.ok) {
          const contentType = videoRes.headers.get('content-type') || 'video/mp4'
          const ext = contentType.includes('webm') ? 'webm' : 'mp4'
          const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
          const filename = `video-${user.id}-${Date.now()}.${ext}`
          permanentVideoUrl = await uploadToR2(filename, videoBuffer, contentType)
          console.log(`[video/status] Uploaded video to blob: ${permanentVideoUrl}`)
        }
      } catch (uploadErr) {
        console.error('[video/status] Failed to upload video to blob (using FAL URL as fallback):', uploadErr)
      }

      // Real dimensions when fal reports them — feeds display tiles at the true
      // aspect instead of assuming 16:9 (i2v output follows the start image)
      const vw = result.data?.video?.width
      const vh = result.data?.video?.height
      const realAspect = vw > 0 && vh > 0 ? `${vw}:${vh}` : null

      // Save completed video to DB
      const savedVideo = await prisma.generatedImage.create({
        data: {
          // Queue order, not completion order — the feed sorts on createdAt and
          // videos finish wildly out of order. Sanity-capped to the last 24h.
          ...(typeof queuedAt === 'number' && queuedAt > Date.now() - 24 * 3600 * 1000 && queuedAt <= Date.now() + 60_000
            ? { createdAt: new Date(queuedAt) } : {}),
          userId: user.id,
          prompt: actualPrompt,
          imageUrl: permanentVideoUrl,
          model: model || 'wan-2.5',
          quality: resolution || '1080p',
          aspectRatio: realAspect || '16:9',
          ticketCost: ticketCost || 0,
          expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          falRequestId: requestId,
          videoMetadata: {
            duration: duration || '5',
            resolution: resolution || '1080p',
            isVideo: true,
            thumbnailUrl: thumbnailUrl || permanentVideoUrl,
            ...(realAspect ? { aspectRatio: realAspect } : {}),
          } as any,
        },
      });

      // Settle the GenerationQueue row (admin/video-status already does this; without
      // it the row lingers 'processing' until the 10-min auto-failer marks a SUCCESSFUL
      // video as failed — which would show a phantom error tile in the feed)
      const { releaseQueueSlot } = await import('@/lib/admin-queue-helpers')
      await releaseQueueSlot(requestId, false).catch(() => {})

      return NextResponse.json({
        status: 'completed',
        videoUrl: permanentVideoUrl,
        thumbnailUrl: thumbnailUrl || permanentVideoUrl,
        videoId: savedVideo.id,
        actualPrompt,
      });

    } else if ((status as any).status === 'ERROR' || (status as any).status === 'FAILED') {
      const { releaseQueueSlot } = await import('@/lib/admin-queue-helpers')
      await releaseQueueSlot(requestId, true, 'Video generation failed on FAL processing servers').catch(() => {})
      return NextResponse.json({ status: 'failed', error: 'Video generation failed on FAL processing servers' });
    } else {
      // IN_QUEUE or IN_PROGRESS
      return NextResponse.json({ status: 'in_progress', falStatus: status.status });
    }

  } catch (error: any) {
    console.error('Video status check error:', error);
    // Return in_progress on transient errors so the client keeps polling
    return NextResponse.json({ status: 'in_progress', error: error.message });
  }
}
