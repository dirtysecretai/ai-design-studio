// Every fal video endpoint this app can submit to, keyed by the model id the
// UI uses. Lives here rather than inside the route so other code (the Model
// Watch page) can answer "do we already use this model?" from data instead of
// grepping source files at runtime.
export const FAL_ENDPOINTS: Record<string, string> = {
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
  // MiniMax H3 Max (ADMIN ONLY while testing) — `minimax/` owner, no fal-ai/
  // prefix. 480P/768P, duration 5-15s, optional end frame.
  'minimax-h3-max':             'minimax/h3-max/image-to-video',
  'minimax-h3-max-text':        'minimax/h3-max/text-to-video',
  // Flux 3 video (ADMIN ONLY while testing) — five sibling endpoints under the
  // `blackforestlabs/` owner. Which one runs is decided by the inputs given:
  //   prompt only .................. text-to-video
  //   + start image ................ image-to-video
  //   + start AND end image ........ first-last-frame-to-video
  //   several reference images ..... keyframes-to-video (frame-pinned)
  //   a source video ............... extend-video
  'flux-3-t2v':                 'blackforestlabs/flux-3/text-to-video',
  'flux-3-i2v':                 'blackforestlabs/flux-3/image-to-video',
  'flux-3-flf':                 'blackforestlabs/flux-3/first-last-frame-to-video',
  'flux-3-keyframes':           'blackforestlabs/flux-3/keyframes-to-video',
  'flux-3-extend':              'blackforestlabs/flux-3/extend-video',
  // Wan 3.0 / 3.0 Prime (ADMIN ONLY) — `alibaba/` owner. Native audio, 480p to
  // 1080p, adaptive aspect, optional end frame. Prime is the higher tier and
  // has no reference-to-video sibling.
  'wan-3.0-t2v':                'alibaba/wan-3.0/text-to-video',
  'wan-3.0-i2v':                'alibaba/wan-3.0/image-to-video',
  'wan-3.0-r2v':                'alibaba/wan-3.0/reference-to-video',
  'wan-3.0-prime-t2v':          'alibaba/wan-3.0-prime/text-to-video',
  'wan-3.0-prime-i2v':          'alibaba/wan-3.0-prime/image-to-video',
  // SeeDance 2.5 (ADMIN ONLY) — i2v + r2v only, no text-only endpoint
  'seedance-2.5-i2v':           'bytedance/seedance-2.5/image-to-video',
  'seedance-2.5-r2v':           'bytedance/seedance-2.5/reference-to-video',
  // Gemini Omni Flash 1.1 (ADMIN ONLY) — adds 4K, drops the edit endpoint
  'gemini-omni-1.1-t2v':        'google/gemini-omni-flash/v1.1/text-to-video',
  'gemini-omni-1.1-i2v':        'google/gemini-omni-flash/v1.1/image-to-video',
  'gemini-omni-1.1-r2v':        'google/gemini-omni-flash/v1.1/reference-to-video',
  'gemini-omni-1.1-edit':       'google/gemini-omni-flash/v1.1/edit',
  // LTX 2.5 (ADMIN ONLY) — Pro tops out at 1080p, Fast reaches 2160p and
  // longer durations. Both take an fps choice and a camera_motion hint.
  'ltx-2.5-pro-t2v':            'lightricks/ltx-2.5/text-to-video/pro',
  'ltx-2.5-pro-i2v':            'lightricks/ltx-2.5/image-to-video/pro',
  'ltx-2.5-fast-t2v':           'lightricks/ltx-2.5/text-to-video/fast',
  'ltx-2.5-fast-i2v':           'lightricks/ltx-2.5/image-to-video/fast',
  // Gemini Omni Flash lives under the `google` owner — NO `fal-ai/` prefix
  // (same pattern as bytedance/seedance-2.0 above). ADMIN-ONLY model.
  'gemini-omni-flash-t2v':      'google/gemini-omni-flash',
  'gemini-omni-flash-i2v':      'google/gemini-omni-flash/image-to-video',
  'gemini-omni-flash-r2v':      'google/gemini-omni-flash/reference-to-video',
  'gemini-omni-flash-edit':     'google/gemini-omni-flash/edit',
  // ── Video tools: transform an existing clip ──
  'flux-video-upscale':         'blackforestlabs/flux-video-upscale',
  'topaz-upscale-precision':    'topaz/upscale/video/precision',
  'topaz-upscale-creative':     'topaz/upscale/video/creative',
  'topaz-upscale-generative':   'topaz/upscale/video/generative',
  'seedvr2-video':              'fal-ai/seedvr/upscale/video',
  'flashvsr-video':             'fal-ai/flashvsr/upscale/video',
  'bytedance-video-upscale':    'fal-ai/bytedance-upscaler/upscale/video',
  'topaz-colorize':             'topaz/colorize/video',
  'topaz-deblur':               'topaz/deblur/video',
  'topaz-interpolate':          'topaz/interpolate/video',
  'topaz-sdr-to-hdr':           'topaz/sdr-to-hdr/video',
};

/** Owner/app prefixes of the fal models this app already uses. */
export const FAL_APPS_IN_USE: string[] = [
  ...new Set(Object.values(FAL_ENDPOINTS).map(e => e.split('/').slice(0, 2).join('/'))),
]

/** Image-side fal apps, kept alongside so coverage reads as one list. */
export const FAL_IMAGE_APPS_IN_USE: string[] = [
  'fal-ai/flux', 'fal-ai/flux-pro', 'fal-ai/nano-banana', 'fal-ai/recraft',
  'bytedance/seedream', 'fal-ai/clarity-upscaler', 'fal-ai/aura-sr',
  'fal-ai/esrgan', 'fal-ai/drct', 'fal-ai/z-image', 'fal-ai/ideogram',
  'fal-ai/kling-image', 'fal-ai/gpt-image', 'fal-ai/supir',
]

/**
 * Every model id that produces VIDEO, as stored in GeneratedImage.model.
 * The image feed excludes these and the video feed selects them, so a model
 * missing here shows up in the wrong feed. Add new video models here.
 */
export const VIDEO_MODEL_IDS: string[] = [
  // generators
  'wan-2.5', 'wan-2.7', 'wan-2.2-lora', 'wan-3.0', 'wan-3.0-prime',
  'kling-v3', 'kling-o3', 'kling-v3-motion',
  'seedance-1.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.5',
  'gemini-omni-flash', 'gemini-omni-1.1',
  'minimax-h3-max', 'flux-3',
  'ltx-2.5-pro', 'ltx-2.5-fast',
  'lipsync-v3', 'happy-horse',
  // tools that output video
  'flux-video-upscale', 'topaz-upscale-precision', 'topaz-upscale-creative',
  'topaz-upscale-generative', 'seedvr2-video', 'flashvsr-video',
  'bytedance-video-upscale', 'topaz-interpolate', 'topaz-colorize',
  'topaz-deblur', 'topaz-sdr-to-hdr',
]

/** File extensions that mean "this row is a video" regardless of its model. */
export const VIDEO_FILE_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv']

/**
 * Models only admin accounts may use. Lives here rather than in the route so
 * client-safe code (the chat catalog, the model pickers) can gate on the SAME
 * list the server enforces — two copies of this drift, and a drift here means
 * a user is offered a model the server will refuse.
 */
export const ADMIN_ONLY_VIDEO_MODELS = new Set<string>([
  'gemini-omni-flash', 'wan-2.7', 'wan-2.2-lora', 'minimax-h3-max', 'flux-3',
  'wan-3.0', 'wan-3.0-prime', 'seedance-2.5', 'gemini-omni-1.1', 'ltx-2.5-pro', 'ltx-2.5-fast',
  'flux-video-upscale', 'topaz-upscale-precision', 'topaz-upscale-creative',
  'topaz-upscale-generative', 'seedvr2-video', 'flashvsr-video',
  'bytedance-video-upscale', 'topaz-colorize', 'topaz-deblur',
  'topaz-interpolate', 'topaz-sdr-to-hdr',
])
