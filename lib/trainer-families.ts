// Registry of fal-hosted LoRA trainer FAMILIES beyond the original flux/z-image
// set. Everything family-specific that the training pipeline needs — endpoint
// resolution, dataset media kind, zip field name, input params, output file
// shape, R2 destination — lives here so a new trainer (e.g. LTX-2) is a new
// record plus a UI entry, not another fork in prepare/webhook/finalize.

export type TrainerFamily = {
  familyId: string
  label: string
  media: 'image' | 'video'
  // Resolve the concrete fal endpoint (variants are URL sub-paths, e.g.
  // fal-ai/wan-22-trainer/t2v-a14b — verified via fal OpenAPI)
  falEndpoint: (config: Record<string, unknown>) => string
  // Input field that carries the dataset zip URL
  zipField: string
  buildInput: (config: Record<string, unknown>) => Record<string, unknown>
  // Output payload keys → canonical artifact names for finalize
  outputFiles: { key: string; saveAs: string }[]
  datasetRules: { min: number; max: number }
  r2Namespace: string
}

const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v))
const str = (v: unknown) => (v === undefined || v === '' ? undefined : String(v))

export const TRAINER_FAMILIES: Record<string, TrainerFamily> = {
  'fal-ai/wan-22-trainer': {
    familyId: 'wan22-video',
    label: 'Wan 2.2 Video LoRA',
    media: 'video',
    falEndpoint: (config) => {
      const variant = config.variant === 'i2v-a14b' ? 'i2v-a14b' : 't2v-a14b'
      return `fal-ai/wan-22-trainer/${variant}`
    },
    zipField: 'training_data_url',
    buildInput: (config) => {
      const input: Record<string, unknown> = {}
      const steps = num(config.steps); if (steps !== undefined) input.number_of_steps = steps
      const lr = num(config.learning_rate); if (lr !== undefined) input.learning_rate = lr
      const trigger = str(config.trigger_phrase); if (trigger) input.trigger_phrase = trigger
      // Default ON: normalizes arbitrary clips to the 81-frame/16fps window the
      // trainer expects — without it, odd-length clips fail validation
      input.auto_scale_input = config.auto_scale_input !== false
      return input
    },
    outputFiles: [
      { key: 'lora_file', saveAs: 'final.safetensors' },
      { key: 'config_file', saveAs: 'config.json' },
    ],
    datasetRules: { min: 5, max: 50 },
    r2Namespace: 'training/video-loras',
  },
  'fal-ai/wan-22-image-trainer': {
    familyId: 'wan22-image',
    label: 'Wan 2.2 Image LoRA',
    media: 'image',
    falEndpoint: () => 'fal-ai/wan-22-image-trainer',
    zipField: 'training_data_url',
    buildInput: (config) => {
      const input: Record<string, unknown> = {}
      const steps = num(config.steps); if (steps !== undefined) input.steps = steps
      const lr = num(config.learning_rate); if (lr !== undefined) input.learning_rate = lr
      const trigger = str(config.trigger_phrase); if (trigger) input.trigger_phrase = trigger
      if (config.is_style === true) input.is_style = true
      if (config.use_face_detection === false) input.use_face_detection = false
      if (config.use_face_cropping === true) input.use_face_cropping = true
      if (config.include_synthetic_captions === true) input.include_synthetic_captions = true
      return input
    },
    outputFiles: [
      { key: 'diffusers_lora_file', saveAs: 'final.safetensors' },
      { key: 'high_noise_lora', saveAs: 'high_noise.safetensors' },
      { key: 'config_file', saveAs: 'config.json' },
    ],
    datasetRules: { min: 5, max: 200 },
    r2Namespace: 'training/video-loras',
  },
  'fal-ai/ltx2-video-trainer': {
    familyId: 'ltx2-video',
    label: 'LTX-2 Video LoRA',
    media: 'video',
    falEndpoint: () => 'fal-ai/ltx2-video-trainer',
    zipField: 'training_data_url',
    buildInput: (config) => {
      const input: Record<string, unknown> = {}
      const steps = num(config.steps); if (steps !== undefined) input.number_of_steps = steps
      const lr = num(config.learning_rate); if (lr !== undefined) input.learning_rate = lr
      const trigger = str(config.trigger_phrase); if (trigger) input.trigger_phrase = trigger
      const rank = num(config.rank)
      if (rank !== undefined && [8, 16, 32, 64, 128].includes(rank)) input.rank = rank
      const res = str(config.resolution)
      if (res && ['low', 'medium', 'high'].includes(res)) input.resolution = res
      const ar = str(config.aspect_ratio)
      if (ar && ['16:9', '1:1', '9:16'].includes(ar)) input.aspect_ratio = ar
      if (config.with_audio === true) input.with_audio = true
      return input
    },
    outputFiles: [
      { key: 'lora_file', saveAs: 'final.safetensors' },
      { key: 'config_file', saveAs: 'config.json' },
    ],
    datasetRules: { min: 5, max: 50 },
    r2Namespace: 'training/video-loras',
  },
}

export function getTrainerFamily(modelId: string): TrainerFamily | null {
  return TRAINER_FAMILIES[modelId] ?? null
}
