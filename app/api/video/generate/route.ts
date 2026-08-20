import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { fal } from "@fal-ai/client";
import { syncAndClaimFalSlot } from '@/lib/admin-queue-helpers';
import { isGenerationBlocked } from '@/lib/generation-guard';
import { cookies } from 'next/headers';
import { getUserFromSession } from '@/lib/auth';
import { authenticateApiKey, invalidKeyResponse, requireScopes, canUseModel, modelNotPermittedResponse } from '@/lib/api-key-auth';
import { enforceContentFilter } from '@/lib/content-filter'


fal.config({
  credentials: process.env.FAL_KEY!
});

// FAL endpoint IDs by model
const FAL_ENDPOINTS: Record<string, string> = {
  'wan-2.5':               'fal-ai/wan-25-preview/image-to-video',
  // Wan 2.7 (ADMIN ONLY while testing) — endpoint ids verified via fal's model API
  'wan-2.7':               'fal-ai/wan/v2.7/image-to-video',
  'wan-2.7-text':          'fal-ai/wan/v2.7/text-to-video',
  'kling-v3':              'fal-ai/kling-video/v3/pro/image-to-video',
  'kling-o3':              'fal-ai/kling-video/o3/standard/image-to-video',
  'kling-v3-motion':       'fal-ai/kling-video/v3/pro/motion-control',
  'seedance-1.5':          'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
  'seedance-1.5-text':     'fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
  // SD 2.0 lives under the `bytedance` owner — a `fal-ai/` prefix 404s with
  // "Path /seedance-2.0/... not found" (verified against the live queue API)
  'seedance-2.0-t2v':           'bytedance/seedance-2.0/text-to-video',
  'seedance-2.0-i2v':           'bytedance/seedance-2.0/image-to-video',
  'seedance-2.0-r2v':           'bytedance/seedance-2.0/reference-to-video',
  'seedance-2.0-fast-t2v':      'bytedance/seedance-2.0/fast/text-to-video',
  'seedance-2.0-fast-i2v':      'bytedance/seedance-2.0/fast/image-to-video',
  'seedance-2.0-fast-r2v':      'bytedance/seedance-2.0/fast/reference-to-video',
  'lipsync-v3':                 'fal-ai/sync-lipsync/v3',
  // Wan 2.2 A14B with custom LoRAs (ADMIN ONLY) — serves LoRAs trained by the
  // wan-22-trainer pipeline; loras[].path takes our R2 URLs
  'wan-2.2-lora-t2v':           'fal-ai/wan/v2.2-a14b/text-to-video/lora',
  'wan-2.2-lora-i2v':           'fal-ai/wan/v2.2-a14b/image-to-video/lora',
  'happy-horse':                'alibaba/happy-horse/image-to-video',
  // Gemini Omni Flash lives under the `google` owner — NO `fal-ai/` prefix
  // (same pattern as bytedance/seedance-2.0 above). ADMIN-ONLY model.
  'gemini-omni-flash-t2v':      'google/gemini-omni-flash',
  'gemini-omni-flash-i2v':      'google/gemini-omni-flash/image-to-video',
  'gemini-omni-flash-r2v':      'google/gemini-omni-flash/reference-to-video',
  'gemini-omni-flash-edit':     'google/gemini-omni-flash/edit',
};

// Models only admin accounts may use (pricing TBD) — enforced server-side,
// independent of the client-supplied adminMode flag
const ADMIN_ONLY_VIDEO_MODELS = new Set(['gemini-omni-flash', 'wan-2.7', 'wan-2.2-lora']);

export async function POST(request: NextRequest) {
  try {
    // Bearer API key (desktop app) first, session cookie fallback
    const apiAuth0 = await authenticateApiKey(request)
    if (apiAuth0 === 'invalid') return invalidKeyResponse()
    const apiAuth = apiAuth0
    const _ck = await cookies(); const _tok = _ck.get('session')?.value
    const _u = apiAuth ? apiAuth.user : (_tok ? await getUserFromSession(_tok) : null)
    if (await isGenerationBlocked(_u?.email)) {
      return NextResponse.json({ error: 'Generation is temporarily disabled for maintenance. Please check back soon.' }, { status: 503 })
    }

    const {
      userId: userIdRaw,
      prompt,
      imageUrl,
      duration = '5',
      resolution = '1080p',
      audioUrl,
      adminMode: adminModeRaw = false,
      model = 'wan-2.5',
      generateAudio = false,
      klingAspectRatio = '16:9',
      endImageUrl,
      hasDevTier = false,
      // Motion Control
      motionVideoUrl,
      motionVideoDurationSec,
      characterOrientation = 'image',
      keepOriginalSound = true,
      // SeeDance 2.0 reference-to-video (also reused for Gemini Omni Flash modes)
      sd20Mode = 't2v',
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      referenceVideoDurationSec = 0,
      // Gemini Omni Flash edit (video-to-video)
      editVideoUrl,
      editVideoDurationSec = 0,
      // Lipsync v3
      lipsyncVideoUrl,
      lipsyncAudioUrl,
      lipsyncSyncMode = 'cut_off',
      lipsyncVideoDurationSec = 0,
      // WAN 2.5 safety
      wan25SafetyChecker = true,
      // Seedance 1.5 safety
      seedance15SafetyChecker = true,
      // WAN 2.7 safety
      wan27SafetyChecker = true,
      // Wan 2.2 LoRA serving: [{ path, scale, transformer }] — validated below
      loras = [],
    } = await request.json();

    // CCBill compliance: fal content-safety flags from the client are only honored
    // for verified admins — regular users ALWAYS run with the checker ON, no matter
    // what the request body claims.
    const { checkIsAdmin: _checkIsAdmin } = await import('@/lib/admin-check')
    const isAdminUser = _u ? await _checkIsAdmin(_u.email) : false

    // Bearer calls: enforce scopes + per-model permission; the authenticated
    // user's id ALWAYS overrides the legacy body userId (never trust the body
    // for ticket deduction on the key path), and adminMode is a portal concept.
    if (apiAuth) {
      const denied = requireScopes(apiAuth, 'generate:video', 'tickets:spend')
      if (denied) return denied
      if (!canUseModel(apiAuth, 'video', model)) return modelNotPermittedResponse(model)
    }
    const userId = apiAuth ? apiAuth.user.id : userIdRaw
    const adminMode = apiAuth ? false : adminModeRaw

    // Admin-only models: hard server gate, regardless of what the client sent
    if (ADMIN_ONLY_VIDEO_MODELS.has(model) && !isAdminUser) {
      return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 });
    }

    const isSD20Family = model === 'seedance-2.0' || model === 'seedance-2.0-fast'
    const isOmni = model === 'gemini-omni-flash'
    const isLipsync = model === 'lipsync-v3'
    // For SD20 family: auto-detect mode from imageUrl; explicit r2v overrides
    const effectiveSd20Mode = isSD20Family
      ? (sd20Mode === 'r2v' ? 'r2v' : imageUrl ? 'i2v' : 't2v')
      : isOmni
        ? (sd20Mode === 'r2v' || sd20Mode === 'edit' ? sd20Mode : imageUrl ? 'i2v' : 't2v')
        : sd20Mode
    const isWanLora = model === 'wan-2.2-lora'
    const isTextToVideo = model === 'seedance-1.5'
      ? !imageUrl
      : isSD20Family
        ? (effectiveSd20Mode !== 'i2v') // t2v/r2v need no start frame
        : isOmni
          ? (effectiveSd20Mode !== 'i2v') // t2v/r2v/edit need no start frame
          : isWanLora
            ? !imageUrl // t2v when no start frame
            : false

    // Wan 2.2 LoRA: validate the loras array — only OUR trained artifacts may
    // be loaded (R2 video-loras namespace), never arbitrary URLs
    let wanLoras: { path: string; scale: number; transformer: 'high' | 'low' | 'both' }[] = []
    if (isWanLora) {
      const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')
      const raw = Array.isArray(loras) ? loras.slice(0, 2) : []
      for (const l of raw) {
        const p = typeof l?.path === 'string' ? l.path : ''
        if (!publicBase || !p.startsWith(`${publicBase}/training/video-loras/`)) {
          return NextResponse.json({ success: false, error: 'Invalid LoRA path' }, { status: 400 });
        }
        const scale = Math.min(4, Math.max(0, Number(l?.scale) || 1))
        const transformer = l?.transformer === 'low' || l?.transformer === 'both' ? l.transformer : 'high'
        wanLoras.push({ path: p, scale, transformer })
      }
      if (wanLoras.length === 0) {
        return NextResponse.json({ success: false, error: 'Select a trained LoRA first' }, { status: 400 });
      }
    }
    if (!imageUrl && !isTextToVideo && !isLipsync) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (isOmni && effectiveSd20Mode === 'edit' && !editVideoUrl) {
      return NextResponse.json({ success: false, error: 'Edit mode requires a source video' }, { status: 400 });
    }
    if (isOmni && effectiveSd20Mode === 'r2v' && !(Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0)) {
      return NextResponse.json({ success: false, error: 'Reference mode requires at least one reference image' }, { status: 400 });
    }
    // fal SD20 r2v: input videos must total 2-15s (the 15s cap is enforced client-side)
    if (isSD20Family && effectiveSd20Mode === 'r2v' && Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0 && (referenceVideoDurationSec || 0) < 2) {
      return NextResponse.json({ success: false, error: 'Reference videos must total at least 2 seconds' }, { status: 400 });
    }
    // Wan 2.7 i2v: prompt is optional when a start image is provided (fal schema)
    if (model !== 'kling-v3-motion' && !isLipsync && !prompt && !(model === 'wan-2.7' && imageUrl)) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (model === 'kling-v3-motion' && !motionVideoUrl) {
      return NextResponse.json({ success: false, error: 'Missing motion reference video URL' }, { status: 400 });
    }
    if (isLipsync && (!lipsyncVideoUrl || !lipsyncAudioUrl)) {
      return NextResponse.json({ success: false, error: 'Lipsync requires both video and audio URLs' }, { status: 400 });
    }

    if (!adminMode && !userId) {
      return NextResponse.json({ success: false, error: 'Missing userId' }, { status: 400 });
    }

    // Calculate ticket cost based on model
    let ticketCost: number;
    if (isLipsync) {
      ticketCost = Math.max(10, Math.ceil((lipsyncVideoDurationSec || 0) * 6));
    } else if (model === 'kling-v3-motion') {
      // 6 tickets/sec × actual video duration (or max if unknown)
      const fallbackSec = characterOrientation === 'video' ? 30 : 10;
      const sec = motionVideoDurationSec ? Math.ceil(motionVideoDurationSec) : fallbackSec;
      ticketCost = sec * 6;
    } else if (model === 'kling-o3') {
      const pricing: Record<string, number> = {
        '3': 15, '4': 18, '5': 20, '6': 24, '7': 28,
        '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
        '13': 52, '14': 56, '15': 60,
      };
      ticketCost = pricing[duration] || 20;
    } else if (model === 'kling-v3') {
      ticketCost = parseInt(duration) * (generateAudio ? 8 : 6);
    } else if (model === 'seedance-1.5') {
      const resMultiplier = resolution === '1080p' ? 2.25 : resolution === '480p' ? 0.5 : 1.0
      const audioMultiplier = generateAudio ? 1.0 : 0.5
      ticketCost = Math.ceil(parseInt(duration) * 2.0 * resMultiplier * audioMultiplier) + 1
    } else if (model === 'seedance-2.0') {
      // fal's SeeDance 2.0 has no 1080p (480p/720p only) — 720p is the 1.0x base
      const resMultiplier = resolution === '480p' ? 0.5 : 1.0
      const hasVideoRefs = sd20Mode === 'r2v' && Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0
      const videoInputMultiplier = hasVideoRefs ? 0.6 : 1.0
      const outputDurSec = duration === 'auto' ? 5 : parseInt(duration)
      const effectiveDur = outputDurSec + (hasVideoRefs ? (referenceVideoDurationSec || 0) : 0)
      ticketCost = Math.ceil(effectiveDur * 15 * resMultiplier * videoInputMultiplier)
    } else if (model === 'seedance-2.0-fast') {
      // 12 tickets/sec at 720p; 480p = 0.5x
      const resMultiplier = resolution === '480p' ? 0.5 : 1.0
      const hasVideoRefs = sd20Mode === 'r2v' && Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0
      const videoInputMultiplier = hasVideoRefs ? 0.6 : 1.0
      const outputDurSec = duration === 'auto' ? 5 : parseInt(duration)
      const effectiveDur = outputDurSec + (hasVideoRefs ? (referenceVideoDurationSec || 0) : 0)
      ticketCost = Math.ceil(effectiveDur * 12 * resMultiplier * videoInputMultiplier)
    } else if (model === 'gemini-omni-flash') {
      // PLACEHOLDER ≈ SeeDance 2.0 (15 tickets/sec); no resolution knob on this model
      const sec = effectiveSd20Mode === 'edit'
        ? Math.max(3, Math.ceil(editVideoDurationSec || 8))
        : (parseInt(duration) || 8);
      ticketCost = sec * 15;
    } else if (model === 'wan-2.7') {
      // PLACEHOLDER — modeled on Wan 2.5's per-second rates (1080p 20/5s = 4/s,
      // 720p 13/5s = 2.6/s). ADMIN ONLY until priced manually.
      const sec = parseInt(duration) || 5;
      ticketCost = Math.ceil(sec * (resolution === '1080p' ? 4 : 2.6));
    } else if (isWanLora) {
      // PLACEHOLDER — ADMIN ONLY until priced. A14B renders ~81 frames @16fps ≈ 5s
      const sec = Math.ceil((parseInt(duration) || 5));
      ticketCost = Math.ceil(sec * (resolution === '720p' ? 4 : 2.6));
    } else if (model === 'happy-horse') {
      ticketCost = parseInt(duration) * (resolution === '1080p' ? 12 : 7);
    } else {
      const pricing: Record<string, Record<string, number>> = {
        '480p':  { '5': 7,  '10': 14 },
        '720p':  { '5': 13, '10': 26 },
        '1080p': { '5': 20, '10': 40 },
      };
      ticketCost = pricing[resolution]?.[duration] || 20;
    }

    // CCBill content filter — must pass BEFORE any charge or provider submit
    {
      const _cf = await enforceContentFilter(prompt, _u?.email)
      if (!_cf.ok) return NextResponse.json({ error: _cf.reason }, { status: 400 })
    }
    // For non-admin: verify and deduct tickets before queuing
    if (!adminMode) {
      const userTickets = await prisma.ticket.findUnique({
        where: { userId },
        select: { balance: true, reserved: true },
      });

      if (!userTickets) {
        return NextResponse.json({ success: false, error: 'User tickets not found' }, { status: 404 });
      }

      // Use the same effective balance formula as /api/user/tickets and the UI:
      // effectiveBalance = max(0, balance - reserved)
      // This prevents the display and the check from diverging when `reserved` is non-zero.
      const effectiveBalance = Math.max(0, userTickets.balance - (userTickets.reserved || 0));
      if (effectiveBalance < ticketCost) {
        return NextResponse.json(
          { success: false, error: `Insufficient tickets. Need ${ticketCost} tickets.` },
          { status: 400 }
        );
      }

      // Deduct tickets before submitting to FAL queue
      await prisma.ticket.update({
        where: { userId },
        data: {
          balance:   { decrement: ticketCost },
          totalUsed: { increment: ticketCost },
        },
      });
    }

    // Build FAL input based on model
    const falEndpoint = (isSD20Family || isOmni)
      ? FAL_ENDPOINTS[`${model}-${effectiveSd20Mode}`] || FAL_ENDPOINTS[`${model}-t2v`]
      : model === 'seedance-1.5' && !imageUrl
      ? FAL_ENDPOINTS['seedance-1.5-text']
      : model === 'wan-2.7' && !imageUrl
      ? FAL_ENDPOINTS['wan-2.7-text']
      : isWanLora
      ? FAL_ENDPOINTS[imageUrl ? 'wan-2.2-lora-i2v' : 'wan-2.2-lora-t2v']
      : FAL_ENDPOINTS[model] || FAL_ENDPOINTS['wan-2.5'];
    let falInput: Record<string, any>;

    if (isLipsync) {
      falInput = {
        video_url:  lipsyncVideoUrl,
        audio_url:  lipsyncAudioUrl,
        sync_mode:  lipsyncSyncMode || 'cut_off',
      };
    } else if (model === 'kling-v3-motion') {
      falInput = {
        image_url:             imageUrl,
        video_url:             motionVideoUrl,
        character_orientation: characterOrientation,
        keep_original_sound:   keepOriginalSound,
      };
      if (prompt?.trim()) falInput.prompt = prompt.trim();
    } else if (model === 'kling-v3') {
      falInput = {
        prompt,
        start_image_url: imageUrl,
        duration: String(duration),
        aspect_ratio: klingAspectRatio,
        generate_audio: generateAudio,
      };
      if (endImageUrl) falInput.end_image_url = endImageUrl;
    } else if (model === 'kling-o3') {
      falInput = {
        prompt,
        image_url: imageUrl,
        duration: String(duration),
        generate_audio: generateAudio,
      };
    } else if (model === 'seedance-1.5') {
      falInput = {
        prompt,
        aspect_ratio: klingAspectRatio,
        resolution,
        duration: String(duration),
        generate_audio: generateAudio,
        enable_safety_checker: isAdminUser ? seedance15SafetyChecker === true : true,
      };
      if (imageUrl) falInput.image_url = imageUrl;
      if (endImageUrl) falInput.end_image_url = endImageUrl;
    } else if (isSD20Family) {
      // Base params shared across all SD20 modes.
      // fal's SeeDance 2.0 family accepts 480p/720p only — clamp any stale 1080p
      // from an old client to 720p instead of 422ing the whole job.
      const sd20Base: Record<string, any> = {
        prompt,
        resolution: resolution === '1080p' ? '720p' : resolution,
        generate_audio: generateAudio,
        enable_safety_checker: false,
      };
      // Only pass duration when explicitly selected (omit for "auto" — let the model decide)
      if (duration && duration !== 'auto') sd20Base.duration = String(duration);
      if (klingAspectRatio && klingAspectRatio !== 'auto') sd20Base.aspect_ratio = klingAspectRatio;

      if (effectiveSd20Mode === 'i2v') {
        falInput = { ...sd20Base, image_url: imageUrl };
        if (endImageUrl) falInput.end_image_url = endImageUrl;
      } else if (effectiveSd20Mode === 'r2v') {
        falInput = { ...sd20Base };
        if (Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) falInput.image_urls = referenceImageUrls;
        if (Array.isArray(referenceVideoUrls) && referenceVideoUrls.length > 0) falInput.video_urls = referenceVideoUrls;
        if (Array.isArray(referenceAudioUrls) && referenceAudioUrls.length > 0) falInput.audio_urls = referenceAudioUrls;
      } else {
        // t2v
        falInput = { ...sd20Base };
      }
    } else if (isOmni) {
      // Gemini Omni Flash schema: prompt + aspect_ratio (16:9|9:16) + duration
      // (INTEGER 3-10). No resolution/audio/safety params — extraneous keys 422.
      // Edit (video-to-video) takes ONLY prompt + video_url.
      const omniBase: Record<string, any> = { prompt };
      if (effectiveSd20Mode !== 'edit') {
        if (duration && duration !== 'auto') omniBase.duration = parseInt(duration) || 8;
        if (klingAspectRatio === '9:16' || klingAspectRatio === '16:9') omniBase.aspect_ratio = klingAspectRatio;
      }
      if (effectiveSd20Mode === 'i2v') {
        falInput = { ...omniBase, image_url: imageUrl };
      } else if (effectiveSd20Mode === 'r2v') {
        falInput = { ...omniBase, image_urls: (referenceImageUrls as string[]).slice(0, 9) };
      } else if (effectiveSd20Mode === 'edit') {
        falInput = { prompt, video_url: editVideoUrl };
      } else {
        falInput = { ...omniBase };
      }
    } else if (model === 'wan-2.7') {
      // ADMIN ONLY (testing). fal schema: 720p/1080p, duration 2-15 (integer),
      // optional prompt (i2v), first + end frame, driving audio; aspect_ratio is
      // t2v-only (i2v infers it from the start image).
      falInput = {
        resolution,
        duration: parseInt(duration) || 5,
        enable_prompt_expansion: true,
        enable_safety_checker: isAdminUser ? wan27SafetyChecker === true : true,
      };
      if (prompt?.trim()) falInput.prompt = prompt.trim();
      if (imageUrl) falInput.image_url = imageUrl;
      else if (klingAspectRatio && klingAspectRatio !== 'auto') falInput.aspect_ratio = klingAspectRatio;
      if (endImageUrl) falInput.end_image_url = endImageUrl;
      if (audioUrl) falInput.audio_url = audioUrl;
    } else if (isWanLora) {
      // Wan 2.2 A14B */lora schema (verified via fal OpenAPI): resolution
      // 480p/580p/720p, num_frames 17-161 (default 81 ≈ 5s @16fps), loras[]
      // of { path, scale, transformer }. duration (sec) → num_frames @16fps.
      const sec = Math.min(10, Math.max(1, parseInt(duration) || 5));
      falInput = {
        prompt,
        loras: wanLoras,
        resolution: ['480p', '580p', '720p'].includes(resolution) ? resolution : '720p',
        num_frames: Math.min(161, Math.max(17, sec * 16 + 1)),
        enable_safety_checker: isAdminUser ? false : true,
      };
      if (imageUrl) falInput.image_url = imageUrl;
      else if (['16:9', '9:16', '1:1'].includes(klingAspectRatio)) falInput.aspect_ratio = klingAspectRatio;
    } else if (model === 'happy-horse') {
      falInput = {
        image_url: imageUrl,
        resolution,
        duration: parseInt(duration),
        enable_safety_checker: false,
      };
      if (prompt?.trim()) falInput.prompt = prompt.trim();
    } else {
      // WAN 2.5
      falInput = {
        prompt,
        image_url: imageUrl,
        resolution,
        duration,
        enable_prompt_expansion: true,
        enable_safety_checker: isAdminUser ? wan25SafetyChecker === true : true,
      };
      if (audioUrl) falInput.audio_url = audioUrl;
    }

    console.log(`Submitting ${model} job to FAL queue:`, JSON.stringify({ falEndpoint, ...falInput }, null, 2));

    // Admin mode: resolve the target user, sync counter, then claim a slot or queue for later
    let adminSlotClaimed = false
    let adminTargetUserId: number | null = null
    if (adminMode) {
      const { cookies } = await import('next/headers')
      const { getUserFromSession } = await import('@/lib/auth')
      const FALLBACK_ADMIN_EMAILS = ['promptandprotocol@gmail.com', 'dirtysecretai@gmail.com']
      const cookieStore = await cookies()
      const token = cookieStore.get('session')?.value
      const sessionUser = token ? await getUserFromSession(token) : null
      if (!sessionUser) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      // Verify the session user is actually an admin
      let isAdmin = false
      try {
        const count = await prisma.adminAccount.count()
        if (count === 0) {
          isAdmin = FALLBACK_ADMIN_EMAILS.includes(sessionUser.email)
        } else {
          const account = await prisma.adminAccount.findUnique({ where: { email: sessionUser.email } })
          isAdmin = !!(account?.canAccessAdmin)
        }
      } catch {
        isAdmin = FALLBACK_ADMIN_EMAILS.includes(sessionUser.email)
      }
      if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      adminTargetUserId = sessionUser.id
      if (!adminTargetUserId) {
        return NextResponse.json({ success: false, error: 'No user found' }, { status: 500 });
      }

      const { claimed, maxConcurrent } = await syncAndClaimFalSlot()
      if (!claimed) {
        const queueEntry = await prisma.generationQueue.create({
          data: {
            userId:     adminTargetUserId,
            modelId:    model,
            modelType:  'video',
            prompt:     (prompt || '').trim(),
            parameters: { falEndpoint, falInput, usePolling: true },
            status:     'queued',
            ticketCost: ticketCost, // real cost — admin video is debited client-side; refunded server-side on failure
          },
        })
        console.log(`Video queued (at capacity, max=${maxConcurrent}) model=${model} queueId=#${queueEntry.id}`)
        return NextResponse.json({ success: true, queued: true, queueId: queueEntry.id, ticketCost, model, resolution, duration, falEndpoint })
      }
      adminSlotClaimed = true
    }

    // Submit to FAL async queue (returns immediately with a requestId)
    let requestId: string;
    try {
      const submitted = await fal.queue.submit(falEndpoint, { input: falInput });
      requestId = submitted.request_id;
    } catch (falError: any) {
      // Refund tickets if FAL submit fails
      if (!adminMode) {
        await prisma.ticket.update({
          where: { userId },
          data: {
            balance:   { increment: ticketCost },
            totalUsed: { decrement: ticketCost },
          },
        }).catch(() => {}); // best-effort refund
      }

      // Release the admin slot we claimed (if any)
      if (adminMode && adminSlotClaimed) {
        const { FAL_GLOBAL_ID } = await import('@/lib/fal-queue')
        await prisma.modelConcurrencyLimit.updateMany({
          where: { modelId: FAL_GLOBAL_ID },
          data: { currentActive: { decrement: 1 } },
        }).catch(() => {})
      }

      console.error('FAL queue submit error:', falError);
      const isContentViolation = falError.body?.detail?.[0]?.type === 'content_policy_violation';
      const rawDetail = Array.isArray(falError.body?.detail)
        ? falError.body.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
        : falError.body?.message || falError.message || 'Unknown error'
      const { friendlyFalVideoError } = await import('@/lib/fal-friendly-errors')
      return NextResponse.json(
        {
          success: false,
          error: isContentViolation
            ? 'Content policy violation: Your prompt or image was flagged. Please use different content.'
            : `Failed to queue video generation: ${friendlyFalVideoError(rawDetail)}`,
          isContentViolation,
        },
        { status: 400 }
      );
    }

    // Track as processing in GenerationQueue so the polling status route can settle
    // the job and — on failure — refund the debited tickets server-side (works even
    // if the user's tab is closed). ticketCost is the amount actually debited:
    // admin video is debited client-side, non-admin server-side above.
    if (adminMode && adminSlotClaimed && adminTargetUserId) {
      await prisma.generationQueue.create({
        data: {
          userId:      adminTargetUserId,
          modelId:     model,
          modelType:   'video',
          prompt:      (prompt || '').trim(),
          parameters:  { falEndpoint, falInput, usePolling: true },
          status:      'processing',
          ticketCost:  ticketCost,
          falRequestId: requestId,
          startedAt:   new Date(),
        },
      })
    } else if (!adminMode && userId) {
      await prisma.generationQueue.create({
        data: {
          userId:       userId,
          modelId:      model,
          modelType:    'video',
          prompt:       (prompt || '').trim(),
          parameters:   { falEndpoint, falInput, usePolling: true },
          status:       'processing',
          ticketCost:   ticketCost,
          falRequestId: requestId,
          startedAt:    new Date(),
        },
      }).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      requestId,
      falEndpoint,
      ticketCost,
      model,
      resolution,
      duration,
    });

  } catch (error: any) {
    console.error('Video generation error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to submit video generation' }, { status: 500 });
  }
}
