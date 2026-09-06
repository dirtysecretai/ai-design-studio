// app/api/prompting-studio/generate/route.ts
// IMAGE generation endpoint with database saving

import { NextRequest, NextResponse } from 'next/server';
import { fal } from "@/lib/fal-client";
import prisma from '@/lib/prisma';
import { uploadToR2 } from '@/lib/r2';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getUserFromSession } from '@/lib/auth';
import { cookies } from 'next/headers';
import { isGenerationBlocked } from '@/lib/generation-guard';
import { enforceContentFilter } from '@/lib/content-filter'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Configure Fal.ai
fal.config({
  credentials: process.env.FAL_KEY
});

export async function POST(req: NextRequest) {
  // Declare outside try so they're accessible in the catch block for cleanup
  let userId = 0
  let ticketCost = 0
  let jobId: number | null = null

  try {
    // Auth via session cookie — never trust userId from the request body
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const sessionUser = await getUserFromSession(token)
    if (!sessionUser) {
      return NextResponse.json({ success: false, error: 'Invalid session' }, { status: 401 });
    }
    userId = sessionUser.id

    if (await isGenerationBlocked(sessionUser.email)) {
      return NextResponse.json({ success: false, error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const body = await req.json();
    const {
      celebrityName,
      enhancement,
      prompt,
      model,
      quality,
      aspectRatio,
      referenceImages,
      position,  // Canvas position — stored so the client can restore the placeholder on refresh
      slotId,    // Which scanner slot submitted this generation
    } = body;

    console.log('=== PROMPTING STUDIO GENERATION STARTED ===');
    console.log('User ID:', userId);
    console.log('Model:', model);
    console.log('Quality:', quality);
    console.log('Aspect Ratio:', aspectRatio);
    console.log('Prompt:', prompt);
    console.log('Reference Images:', referenceImages?.length || 0);

    // Upload reference images to permanent storage if provided
    const permanentReferenceUrls: string[] = [];
    if (referenceImages && referenceImages.length > 0) {
      console.log(`📸 Uploading ${referenceImages.length} reference image(s) to permanent storage...`);
      for (let i = 0; i < referenceImages.length; i++) {
        try {
          // Handle both base64 strings and URLs
          const refImage = referenceImages[i];
          if (refImage.startsWith('data:') || !refImage.startsWith('http')) {
            // It's base64 - upload to Blob
            const base64Data = refImage.split(',')[1] || refImage;
            const refBuffer = Buffer.from(base64Data, 'base64');
            const refFilename = `prompting-studio/${userId}/reference-${Date.now()}-${i}.jpg`;

            const refUrl = await uploadToR2(refFilename, refBuffer, 'image/jpeg');

            permanentReferenceUrls.push(refUrl);
            console.log(`✅ Reference image ${i + 1} uploaded: ${refUrl}`);
          } else {
            // It's already a URL - keep it
            permanentReferenceUrls.push(refImage);
            console.log(`✅ Reference image ${i + 1} already a URL: ${refImage}`);
          }
        } catch (refErr) {
          console.error(`❌ Failed to upload reference image ${i + 1}:`, refErr);
        }
      }
    }

    // Calculate ticket cost based on model and quality
    ticketCost = 1; // Default
    if (model === 'nano-banana-pro') {
      ticketCost = quality === '4k' ? 14 : 7;
    } else if (model === 'pro-scanner-v3') {
      ticketCost = quality === '4k' ? 15 : 7;
    } else if (model === 'seedream-4.5') {
      ticketCost = quality === '4k' ? 4 : 2;
    } else if (model === 'nano-banana-cluster' || model === 'nano-banana') {
      ticketCost = 2;
    } else if (model === 'flash-scanner-v2.5') {
      ticketCost = 1;
    }

    console.log('💰 Ticket cost:', ticketCost);

    // Per-account concurrency cap — the DB row below was meant to enforce this
    // ("concurrency is enforced per-account") but nothing ever checked it, so a
    // user could fire unlimited concurrent FAL jobs. checkUserConcurrency counts
    // the user's in-flight image jobs; owners get 999 (admins effectively unlimited).
    {
      const { checkUserConcurrency } = await import('@/lib/user-concurrency')
      const { allowed, activeCount, limit } = await checkUserConcurrency(userId)
      if (!allowed) {
        return NextResponse.json(
          { success: false, error: `Too many generations in progress (${activeCount}/${limit}). Wait for one to finish.` },
          { status: 429 }
        )
      }
    }

    // jobId is declared above the try block so it's accessible in the catch handler

    // Atomically reserve tickets — checks (balance - max(0, reserved)) >= cost in one SQL
    // statement so concurrent requests cannot both pass with 0 effective balance.
    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, sessionUser.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    console.log('🔒 Attempting to reserve tickets...');
    {
      const { reserveGenerationTickets } = await import('@/lib/ticket-gate')
      const reserveResult = await reserveGenerationTickets(userId, sessionUser.email!, ticketCost)
      if (!reserveResult.ok) {
        console.log(`❌ Insufficient tickets. Need ${reserveResult.need}, have ${reserveResult.have}`);
        return NextResponse.json(
          { success: false, error: `Insufficient tickets. Need ${reserveResult.need}, you have ${reserveResult.have}.` },
          { status: 400 }
        )
      }
      console.log(`✅ Reserved ${ticketCost} tickets`);
    }

    // Track this generation in the DB so loading placeholders survive page refreshes
    // and concurrency is enforced per-account rather than per-tab.
    try {
      const job = await prisma.generationQueue.create({
        data: {
          userId,
          modelId: model,
          modelType: 'image',
          prompt: prompt,
          parameters: {
            source: 'canvas',
            slotId: slotId || 'studio-scanner',
            position: position || { x: 0, y: 0 },
            celebrityName: celebrityName || null,
            enhancement: enhancement || null,
            model,
            quality: quality || '2k',
            aspectRatio: aspectRatio || '1:1',
            referenceImageUrls: permanentReferenceUrls,
          },
          // FAL async models (NanoBanana Pro, SeeDream, FLUX-2) are submitted to
          // FAL's queue and stay "queued" until the webhook fires.
          // Sync models (Gemini, NanoBanana Cluster) update status themselves.
          // Using "queued" prevents a Vercel timeout from leaving a phantom "processing" row.
          status: 'queued',
          ticketCost,
          startedAt: new Date(),
        },
      });
      jobId = job.id;
      console.log(`📋 Created generation job #${jobId}`);
    } catch (jobErr) {
      // Non-fatal: job tracking failure must not block the actual generation
      console.error('⚠️ Failed to create job record (non-fatal):', jobErr);
    }

    // Map UI model IDs to actual API model IDs
    let actualModel = model;
    // Gemini scanner models are ADMIN ONLY (retired from public 2026-07-29)
    {
      const geminiScanners = new Set(['pro-scanner-v3', 'flash-scanner-v2.5', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image'])
      if (geminiScanners.has(model)) {
        const { checkIsAdmin } = await import('@/lib/admin-check')
        if (!(await checkIsAdmin(sessionUser.email))) {
          return NextResponse.json({ success: false, error: 'This model is not available' }, { status: 403 })
        }
      }
    }
    if (model === 'pro-scanner-v3') {
      actualModel = 'gemini-3-pro-image-preview';
      console.log('🔄 Mapped pro-scanner-v3 → gemini-3-pro-image-preview');
    } else if (actualModel === 'flash-scanner-v2.5') {
      actualModel = 'gemini-2.5-flash-image';
      console.log('🔄 Mapped flash-scanner-v2.5 → gemini-2.5-flash-image');
    } else if (actualModel === 'nano-banana-cluster') {
      actualModel = 'nano-banana';
      console.log('🔄 Mapped nano-banana-cluster → nano-banana');
    }

    // Only require prompt
    if (!prompt || !prompt.trim()) {
      return NextResponse.json(
        { success: false, error: 'Prompt is required' },
        { status: 400 }
      );
    }

    let imageUrl = '';
    let images: any[] = [];

    // Map quality to resolution
    const resolution = quality === '4k' ? '4K' : '2K';

    // FAL.AI MODELS
    if (actualModel === 'nano-banana-pro') {
      console.log('🍌 Calling NanoBanana Pro...');

      // Determine endpoint and handle reference images
      let modelEndpoint = 'fal-ai/nano-banana-pro';
      const inputParams: any = {
        prompt,
        num_images: 1,
        aspect_ratio: aspectRatio || '1:1',
        resolution: resolution,
        output_format: 'png',
        safety_tolerance: 6,
        enable_safety_checker: false,
      };

      // If reference images provided, switch to edit endpoint
      if (permanentReferenceUrls.length > 0) {
        console.log(`📸 Using NanoBanana Pro edit mode with ${permanentReferenceUrls.length} reference image(s)`);
        modelEndpoint = 'fal-ai/nano-banana-pro/edit';

        // Upload reference images to FAL storage
        const falImageUrls: string[] = [];
        for (const refUrl of permanentReferenceUrls) {
          try {
            // Download the image from our storage
            const imgResponse = await fetch(refUrl);
            const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());

            // Create a Blob and upload to FAL storage
            const blob = new Blob([imgBuffer], { type: 'image/jpeg' });
            const uploadedUrl = await fal.storage.upload(blob);
            falImageUrls.push(uploadedUrl);
            console.log(`✅ Uploaded reference to FAL: ${uploadedUrl}`);
          } catch (uploadErr) {
            console.error('❌ Failed to upload reference to FAL:', uploadErr);
          }
        }

        if (falImageUrls.length > 0) {
          inputParams.image_urls = falImageUrls;
        }
      }

      console.log(`🎯 Calling endpoint: ${modelEndpoint}`);

      // Submit to FAL.ai async queue — webhook handles completion
      const appUrl = (process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).replace(/\/$/, '');
      const { request_id } = await fal.queue.submit(modelEndpoint, {
        input: inputParams,
        webhookUrl: `${appUrl}/api/webhooks/fal`,
      });
      console.log(`✅ NanoBanana Pro submitted to FAL queue: ${request_id}`);
      const savePrompt = `${celebrityName ? celebrityName + ' - ' : ''}${enhancement ? enhancement + ' - ' : ''}${prompt}`;
      if (jobId) {
        try {
          await prisma.generationQueue.update({
            where: { id: jobId },
            data: {
              falRequestId: request_id,
              parameters: { source: 'canvas', slotId: slotId || 'studio-scanner', position: position || { x: 0, y: 0 }, celebrityName: celebrityName || null, enhancement: enhancement || null, model, quality: quality || '2k', aspectRatio: aspectRatio || '1:1', referenceImageUrls: permanentReferenceUrls, savePrompt },
            },
          });
        } catch (e) { console.error('⚠️ Failed to update job with falRequestId (non-fatal):', e); }
      }
      return NextResponse.json({ success: true, jobId, queued: true });

    } else if (actualModel === 'nano-banana') {
      console.log('🍌🍌 Calling NanoBanana Cluster...');
      
      const result = await fal.subscribe("fal-ai/nano-banana", {
        input: {
          prompt,
          num_images: 2,
          aspect_ratio: aspectRatio || '1:1',
        },
        logs: false,
      });

      console.log('✅ NanoBanana Cluster generation complete (2 images)');
      images = result.data.images || [];
      imageUrl = images[0]?.url;

    } else if (actualModel === 'seedream-4.5') {
      console.log('🌱 Calling SeeDream 4.5...');

      // Calculate image dimensions based on quality and aspect ratio
      const qualityMultiplier = quality === '4k' ? 2 : 1;
      const baseSizes: Record<string, { width: number, height: number }> = {
        '1:1': { width: 1024, height: 1024 },
        '4:5': { width: 896, height: 1152 },
        '3:4': { width: 896, height: 1152 },
        '2:3': { width: 896, height: 1344 },
        '9:16': { width: 768, height: 1344 },
        '16:9': { width: 1344, height: 768 },
        '3:2': { width: 1344, height: 896 },
        '4:3': { width: 1152, height: 896 },
      };

      const dimensions = baseSizes[aspectRatio] || baseSizes['1:1'];
      const image_size = {
        width: dimensions.width * qualityMultiplier,
        height: dimensions.height * qualityMultiplier
      };

      // Determine endpoint and handle reference images
      let modelEndpoint = 'fal-ai/bytedance/seedream/v4.5/text-to-image';
      const inputParams: any = {
        prompt,
        image_size,
        num_images: 1,
        max_images: 1,
        enable_safety_checker: false,
      };

      // If reference images provided, switch to edit endpoint
      if (permanentReferenceUrls.length > 0) {
        console.log(`📸 Using SeeDream edit mode with ${permanentReferenceUrls.length} reference image(s)`);
        modelEndpoint = 'fal-ai/bytedance/seedream/v4.5/edit';

        // Upload reference images to FAL storage
        const falImageUrls: string[] = [];
        for (const refUrl of permanentReferenceUrls) {
          try {
            // Download the image from our storage
            const imgResponse = await fetch(refUrl);
            const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());

            // Create a Blob and upload to FAL storage
            const blob = new Blob([imgBuffer], { type: 'image/jpeg' });
            const uploadedUrl = await fal.storage.upload(blob);
            falImageUrls.push(uploadedUrl);
            console.log(`✅ Uploaded reference to FAL: ${uploadedUrl}`);
          } catch (uploadErr) {
            console.error('❌ Failed to upload reference to FAL:', uploadErr);
          }
        }

        if (falImageUrls.length > 0) {
          inputParams.image_urls = falImageUrls;
        }
      }

      console.log(`🎯 Calling endpoint: ${modelEndpoint}`);
      console.log(`📐 Image size: ${image_size.width}x${image_size.height}`);

      // Submit to FAL.ai async queue — webhook handles completion
      const appUrl = (process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).replace(/\/$/, '');
      const { request_id } = await fal.queue.submit(modelEndpoint, {
        input: inputParams,
        webhookUrl: `${appUrl}/api/webhooks/fal`,
      });
      console.log(`✅ SeeDream 4.5 submitted to FAL queue: ${request_id}`);
      const savePrompt = `${celebrityName ? celebrityName + ' - ' : ''}${enhancement ? enhancement + ' - ' : ''}${prompt}`;
      if (jobId) {
        try {
          await prisma.generationQueue.update({
            where: { id: jobId },
            data: {
              falRequestId: request_id,
              parameters: { source: 'canvas', slotId: slotId || 'studio-scanner', position: position || { x: 0, y: 0 }, celebrityName: celebrityName || null, enhancement: enhancement || null, model, quality: quality || '2k', aspectRatio: aspectRatio || '1:1', referenceImageUrls: permanentReferenceUrls, savePrompt },
            },
          });
        } catch (e) { console.error('⚠️ Failed to update job with falRequestId (non-fatal):', e); }
      }
      return NextResponse.json({ success: true, jobId, queued: true });

    } else if (actualModel === 'flux-2') {
      console.log('🌊 Calling FLUX 2...');

      // Map aspect ratio to FLUX 2 image_size enum or custom dimensions
      const fluxSizeMap: Record<string, string> = {
        '1:1': 'square_hd',
        '4:3': 'landscape_4_3',
        '3:4': 'portrait_4_3',
        '16:9': 'landscape_16_9',
        '9:16': 'portrait_16_9',
      };

      let image_size: any;
      if (quality === '4k') {
        // Use custom dimensions for 4K quality
        const baseSizes: Record<string, { width: number, height: number }> = {
          '1:1': { width: 1536, height: 1536 },
          '4:5': { width: 1344, height: 1680 },
          '3:4': { width: 1344, height: 1792 },
          '9:16': { width: 1080, height: 1920 },
          '16:9': { width: 1920, height: 1080 },
          '4:3': { width: 1792, height: 1344 },
          '3:2': { width: 1920, height: 1280 },
        };
        const dimensions = baseSizes[aspectRatio] || baseSizes['1:1'];
        image_size = { width: dimensions.width, height: dimensions.height };
      } else {
        // Use enum for 2K quality
        image_size = fluxSizeMap[aspectRatio] || 'square_hd';
      }

      const inputParams: any = {
        prompt,
        image_size,
        num_images: 1,
        output_format: 'png',
        enable_safety_checker: false,
        guidance_scale: 2.5,
        num_inference_steps: 28,
      };

      // FLUX 2 supports reference images via /edit endpoint (max 4 images)
      let modelEndpoint = 'fal-ai/flux-2';

      if (permanentReferenceUrls.length > 0) {
        console.log(`📸 Using FLUX 2 edit mode with ${permanentReferenceUrls.length} reference image(s)`);
        modelEndpoint = 'fal-ai/flux-2/edit';

        // FLUX 2 only supports max 4 reference images
        const maxImages = 4;
        const urlsToUse = permanentReferenceUrls.slice(0, maxImages);

        if (permanentReferenceUrls.length > 4) {
          console.log(`⚠️ FLUX 2 only supports 4 reference images, using first 4 of ${permanentReferenceUrls.length}`);
        }

        // Upload reference images to FAL storage
        const falImageUrls: string[] = [];
        for (const refUrl of urlsToUse) {
          try {
            const imgResponse = await fetch(refUrl);
            const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
            const blob = new Blob([imgBuffer], { type: 'image/jpeg' });
            const uploadedUrl = await fal.storage.upload(blob);
            falImageUrls.push(uploadedUrl);
            console.log(`✅ Uploaded reference to FAL: ${uploadedUrl}`);
          } catch (uploadErr) {
            console.error('❌ Failed to upload reference to FAL:', uploadErr);
          }
        }

        if (falImageUrls.length > 0) {
          inputParams.image_urls = falImageUrls;
        }
      }

      console.log(`🎯 Calling endpoint: ${modelEndpoint}`);
      console.log(`📐 Image size: ${JSON.stringify(image_size)}`);

      // Submit to FAL.ai async queue — webhook handles completion
      const appUrl = (process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).replace(/\/$/, '');
      const { request_id } = await fal.queue.submit(modelEndpoint, {
        input: inputParams,
        webhookUrl: `${appUrl}/api/webhooks/fal`,
      });
      console.log(`✅ FLUX 2 submitted to FAL queue: ${request_id}`);
      const savePrompt = `${celebrityName ? celebrityName + ' - ' : ''}${enhancement ? enhancement + ' - ' : ''}${prompt}`;
      if (jobId) {
        try {
          await prisma.generationQueue.update({
            where: { id: jobId },
            data: {
              falRequestId: request_id,
              parameters: { source: 'canvas', slotId: slotId || 'studio-scanner', position: position || { x: 0, y: 0 }, celebrityName: celebrityName || null, enhancement: enhancement || null, model, quality: quality || '2k', aspectRatio: aspectRatio || '1:1', referenceImageUrls: permanentReferenceUrls, savePrompt },
            },
          });
        } catch (e) { console.error('⚠️ Failed to update job with falRequestId (non-fatal):', e); }
      }
      return NextResponse.json({ success: true, jobId, queued: true });

    } else if (actualModel === 'gemini-3-pro-image-preview') {
      console.log('💎 Calling Gemini 3 Pro Image...');
      console.log('📐 Aspect Ratio:', aspectRatio);
      console.log('🎨 Quality:', quality);
      console.log('📸 Reference Images:', permanentReferenceUrls.length);

      const aiModel = genAI.getGenerativeModel({
        model: 'gemini-3-pro-image-preview',
        generationConfig: {
          responseModalities: ['Text', 'Image'],
        } as any
      });

      // Build enhanced prompt with aspect ratio instruction
      const aspectInstructions: Record<string, string> = {
        '1:1': 'square format (1:1 aspect ratio)',
        '2:3': 'portrait format (2:3 aspect ratio)',
        '3:2': 'landscape format (3:2 aspect ratio)',
        '4:5': 'portrait format (4:5 aspect ratio)',
        '3:4': 'portrait format (3:4 aspect ratio)',
        '4:3': 'landscape format (4:3 aspect ratio)',
        '9:16': 'tall portrait format (9:16 aspect ratio)',
        '16:9': 'wide landscape format (16:9 aspect ratio)'
      };

      const aspectInstruction = aspectInstructions[aspectRatio] || 'square format';
      const qualityInstruction = quality === '4k' ? 'ultra high resolution, 4K quality, extremely detailed' : 'high resolution, detailed';

      const enhancedPrompt = `Generate an image in ${aspectInstruction}, ${qualityInstruction}. ${prompt}`;
      console.log('📝 Enhanced Prompt:', enhancedPrompt);

      // Build content array with reference images if provided
      const contentParts: any[] = [];

      // Add reference images first (if any)
      if (permanentReferenceUrls.length > 0) {
        console.log(`📸 Adding ${permanentReferenceUrls.length} reference image(s) to Gemini request...`);
        for (const refUrl of permanentReferenceUrls) {
          try {
            const imgResponse = await fetch(refUrl);
            const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
            const base64Data = imgBuffer.toString('base64');

            contentParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            });
            console.log(`✅ Added reference image to request`);
          } catch (err) {
            console.error('❌ Failed to fetch reference image:', err);
          }
        }
      }

      // Add text prompt last
      contentParts.push({ text: enhancedPrompt });

      const result = await aiModel.generateContent(contentParts);
      const response = await result.response;

      // DEBUG: Log full response structure
      console.log('📋 Gemini Response Object Keys:', Object.keys(response));
      console.log('📋 Candidates:', response.candidates?.length);

      // Check for content blocking FIRST
      if (response.promptFeedback?.blockReason) {
        console.log('🚫 Content blocked by Gemini:', response.promptFeedback.blockReason);
        console.log('🚫 Block reason details:', JSON.stringify(response.promptFeedback, null, 2));
        throw new Error(`Content blocked by Gemini AI: ${response.promptFeedback.blockReason}. Please modify your prompt and try again.`);
      }

      // Check if candidates exist
      if (!response.candidates || response.candidates.length === 0) {
        console.log('❌ No candidates in response');
        console.log('📋 Full response:', JSON.stringify(response, null, 2));
        throw new Error('Gemini did not generate any content. This may be due to safety filters. Please try a different prompt.');
      }

      if (response.candidates?.[0]) {
        const candidate = response.candidates[0];
        console.log('📋 Candidate keys:', Object.keys(candidate));
        console.log('📋 Content:', JSON.stringify(candidate.content, null, 2));
      }

      // Try to extract image - Gemini likely returns base64 in inlineData
      const parts = response.candidates?.[0]?.content?.parts;
      console.log('📋 Parts:', parts);

      if (!parts || !Array.isArray(parts) || parts.length === 0) {
        throw new Error('No image parts in Gemini response - the model may not support image generation');
      }
      
      // Look for inline image data
      for (const part of parts) {
        if (part.inlineData?.data) {
          // Found base64 image!
          const mimeType = part.inlineData.mimeType || 'image/png';
          const base64Data = part.inlineData.data;
          
          console.log(`📦 Found base64 image data, MIME: ${mimeType}`);
          
          // Convert to buffer
          const imageBuffer = Buffer.from(base64Data, 'base64');
          console.log(`✅ Decoded base64, size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);
          
          // Upload to R2
          const filename = `prompting-studio/${userId}/${Date.now()}-gemini.png`;
          imageUrl = await uploadToR2(filename, imageBuffer, mimeType);
          console.log('✅ Uploaded Gemini image to R2:', imageUrl);
          break;
        }
      }

      if (!imageUrl) {
        throw new Error('No image data found in Gemini response - check console logs for structure');
      }

      console.log('✅ Gemini 3 Pro Image generation complete');

    } else if (actualModel === 'gemini-2.5-flash-image') {
      console.log('⚡ Calling Gemini Flash 2.5 Image...');
      console.log('📐 Aspect Ratio:', aspectRatio);
      console.log('🎨 Quality:', quality);
      console.log('📸 Reference Images:', permanentReferenceUrls.length);

      const aiModel = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-image',
        generationConfig: {
          responseModalities: ['Text', 'Image'],
        } as any
      });

      // Build enhanced prompt with aspect ratio instruction
      const aspectInstructions: Record<string, string> = {
        '1:1': 'square format (1:1 aspect ratio)',
        '2:3': 'portrait format (2:3 aspect ratio)',
        '3:2': 'landscape format (3:2 aspect ratio)',
        '4:5': 'portrait format (4:5 aspect ratio)',
        '3:4': 'portrait format (3:4 aspect ratio)',
        '4:3': 'landscape format (4:3 aspect ratio)',
        '9:16': 'tall portrait format (9:16 aspect ratio)',
        '16:9': 'wide landscape format (16:9 aspect ratio)'
      };

      const aspectInstruction = aspectInstructions[aspectRatio] || 'square format';
      const qualityInstruction = quality === '4k' ? 'ultra high resolution, 4K quality, extremely detailed' : 'high resolution, detailed';

      const enhancedPrompt = `Generate an image in ${aspectInstruction}, ${qualityInstruction}. ${prompt}`;
      console.log('📝 Enhanced Prompt:', enhancedPrompt);

      // Build content array with reference images if provided
      const contentParts: any[] = [];

      // Add reference images first (if any)
      if (permanentReferenceUrls.length > 0) {
        console.log(`📸 Adding ${permanentReferenceUrls.length} reference image(s) to Gemini request...`);
        for (const refUrl of permanentReferenceUrls) {
          try {
            const imgResponse = await fetch(refUrl);
            const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
            const base64Data = imgBuffer.toString('base64');

            contentParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            });
            console.log(`✅ Added reference image to request`);
          } catch (err) {
            console.error('❌ Failed to fetch reference image:', err);
          }
        }
      }

      // Add text prompt last
      contentParts.push({ text: enhancedPrompt });

      const result = await aiModel.generateContent(contentParts);
      const response = await result.response;

      // DEBUG: Log full response structure
      console.log('📋 Gemini Flash Response Object Keys:', Object.keys(response));
      console.log('📋 Candidates:', response.candidates?.length);

      // Check for content blocking FIRST
      if (response.promptFeedback?.blockReason) {
        console.log('🚫 Content blocked by Gemini Flash:', response.promptFeedback.blockReason);
        console.log('🚫 Block reason details:', JSON.stringify(response.promptFeedback, null, 2));
        throw new Error(`Content blocked by Gemini AI: ${response.promptFeedback.blockReason}. Please modify your prompt and try again.`);
      }

      // Check if candidates exist
      if (!response.candidates || response.candidates.length === 0) {
        console.log('❌ No candidates in response');
        console.log('📋 Full response:', JSON.stringify(response, null, 2));
        throw new Error('Gemini did not generate any content. This may be due to safety filters. Please try a different prompt.');
      }

      if (response.candidates?.[0]) {
        const candidate = response.candidates[0];
        console.log('📋 Candidate keys:', Object.keys(candidate));
      }

      // Try to extract image - Gemini returns base64 in inlineData
      const parts = response.candidates?.[0]?.content?.parts;

      if (!parts || !Array.isArray(parts) || parts.length === 0) {
        throw new Error('No image parts in Gemini Flash response - the model may not support image generation');
      }

      // Look for inline image data
      for (const part of parts) {
        if (part.inlineData?.data) {
          // Found base64 image!
          const mimeType = part.inlineData.mimeType || 'image/png';
          const base64Data = part.inlineData.data;

          console.log(`📦 Found base64 image data, MIME: ${mimeType}`);

          // Convert to buffer
          const imageBuffer = Buffer.from(base64Data, 'base64');
          console.log(`✅ Decoded base64, size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);

          // Upload to R2
          const filename = `prompting-studio/${userId}/${Date.now()}-gemini-flash.png`;
          imageUrl = await uploadToR2(filename, imageBuffer, mimeType);
          console.log('✅ Uploaded Gemini Flash image to R2:', imageUrl);
          break;
        }
      }

      if (!imageUrl) {
        throw new Error('No image data found in Gemini Flash response');
      }

      console.log('✅ Gemini Flash 2.5 generation complete');

    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid model' },
        { status: 400 }
      );
    }

    if (!imageUrl) {
      return NextResponse.json(
        { success: false, error: 'No image generated' },
        { status: 500 }
      );
    }

    // Download and upload all generated image(s) to permanent Vercel Blob storage
    console.log('💾 Downloading image(s) from Fal.ai...');

    const allBlobUrls: string[] = [];

    if (images.length > 1) {
      // Multi-image (NanoBanana Cluster): upload all images to Blob
      for (let i = 0; i < images.length; i++) {
        const imgRes = await fetch(images[i].url);
        if (!imgRes.ok) throw new Error(`Failed to download image ${i + 1}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        console.log(`Downloaded image ${i + 1}, size: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
        const fname = `prompting-studio/${userId}/${Date.now() + i}-${model}.png`;
        const uploadedUrl = await uploadToR2(fname, buf, 'image/png');
        allBlobUrls.push(uploadedUrl);
        console.log(`✅ Uploaded image ${i + 1} to R2: ${uploadedUrl}`);
      }
    } else {
      // Single image
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error('Failed to download image');
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      console.log(`Downloaded image, size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      const filename = `prompting-studio/${userId}/${Date.now()}-${model}.png`;
      const uploadedUrl = await uploadToR2(filename, imageBuffer, 'image/png');
      allBlobUrls.push(uploadedUrl);
      console.log('✅ Uploaded to R2:', uploadedUrl);
    }

    const primaryBlobUrl = allBlobUrls[0];

    // Deduct tickets from user balance AND release reservation (once, regardless of image count).
    // Use GREATEST(0, ...) on reserved so it can never go negative, which would inflate
    // the effective balance check and allow subsequent free generations.
    console.log(`💸 Deducting ${ticketCost} tickets and releasing reservation...`);
    await prisma.$executeRaw`
      UPDATE "Ticket"
      SET
        balance    = balance - ${ticketCost},
        reserved   = GREATEST(0, reserved - ${ticketCost}),
        "totalUsed" = "totalUsed" + ${ticketCost}
      WHERE "userId" = ${userId}
    `;
    console.log('✅ Tickets deducted and reservation released');

    // Save all images to GeneratedImage table
    console.log('💾 Saving to GeneratedImage table...');
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 100);
    const savePrompt = `${celebrityName ? celebrityName + ' - ' : ''}${enhancement ? enhancement + ' - ' : ''}${prompt}`;

    for (let i = 0; i < allBlobUrls.length; i++) {
      const saved = await prisma.generatedImage.create({
        data: {
          userId: userId,
          prompt: savePrompt,
          imageUrl: allBlobUrls[i],
          model: model,
          ticketCost: i === 0 ? ticketCost : 0, // Only charge for the first image
          referenceImageUrls: permanentReferenceUrls,
          createdAt: new Date(),
          expiresAt: expiresAt,
        },
      });
      console.log(`✅ Saved to GeneratedImage, ID: ${saved.id}`);
    }

    // Save to GenerationTrainingData for gem/diluted marking (primary image only)
    console.log('💾 Saving to GenerationTrainingData table...');
    const trainingData = await prisma.generationTrainingData.create({
      data: {
        userId: userId,
        celebrityName: celebrityName || null,
        enhancement: enhancement || null,
        prompt: prompt,
        model: model,
        quality: quality,
        aspectRatio: aspectRatio,
        imageUrl: primaryBlobUrl,
        success: true,
        errorMessage: null,
        promptTokens: prompt.split(' ').length,
        isDiluted: false,
        isGem: false,
        isDeleted: false,
      },
    });

    console.log('✅ Saved to GenerationTrainingData, ID:', trainingData.id);
    console.log('=== PROMPTING STUDIO GENERATION COMPLETE ===');

    // Mark generation job as completed so the polling client can resolve the placeholder
    if (jobId) {
      try {
        await prisma.generationQueue.update({
          where: { id: jobId },
          data: {
            status: 'completed',
            resultUrl: primaryBlobUrl,
            completedAt: new Date(),
          },
        });
        console.log(`📋 Job #${jobId} marked as completed`);
      } catch (jobErr) {
        console.error('⚠️ Failed to mark job as completed (non-fatal):', jobErr);
      }
    }

    // Return format based on single or multi-image
    if (allBlobUrls.length > 1) {
      return NextResponse.json({
        success: true,
        imageUrl: primaryBlobUrl,
        images: allBlobUrls.map(url => ({ url })),
        referenceImageUrls: permanentReferenceUrls,
        jobId,
      });
    }

    return NextResponse.json({
      success: true,
      imageUrl: primaryBlobUrl,
      referenceImageUrls: permanentReferenceUrls,
      jobId,
    });

  } catch (error: any) {
    console.error('❌ Generation error:', error);
    console.error('❌ Error body:', JSON.stringify(error.body, null, 2));
    console.error('❌ Error status:', error.status);
    console.error('❌ Error message:', error.message);

    // Check if it's a sensitive content error
    const isSensitiveContent = error.message?.toLowerCase().includes('sensitive') ||
                               error.message?.toLowerCase().includes('safety') ||
                               error.message?.toLowerCase().includes('blocked') ||
                               error.message?.toLowerCase().includes('policy');

    // ALWAYS release the ticket reservation on error (tickets weren't actually used).
    // Use releaseReservedTickets (GREATEST floor) so reserved never goes negative.
    if (userId && ticketCost) {
      try {
        console.log(`🔓 Releasing ${ticketCost} reserved tickets due to generation failure...`);
        const { releaseReservedTickets } = await import('@/lib/ticket-gate')
        await releaseReservedTickets(userId, ticketCost)
        console.log('✅ Reserved tickets released - balance unchanged');
      } catch (releaseError) {
        console.error('❌ Failed to release reserved tickets:', releaseError);
      }
    }

    // Mark the generation job as failed so the client can turn the placeholder red
    if (jobId) {
      try {
        await prisma.generationQueue.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            errorMessage: (error.message || 'Generation failed').substring(0, 500),
            completedAt: new Date(),
          },
        });
        console.log(`📋 Job #${jobId} marked as failed`);
      } catch (jobErr) {
        console.error('⚠️ Failed to mark job as failed (non-fatal):', jobErr);
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: isSensitiveContent ? 'Sensitive content detected - request blocked' : (error.message || 'Generation failed'),
        isSensitiveContent: isSensitiveContent
      },
      { status: isSensitiveContent ? 400 : 500 }
    );
  }
}
