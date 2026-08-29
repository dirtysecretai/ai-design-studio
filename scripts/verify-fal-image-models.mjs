/**
 * Verifies every model in lib/fal-image-models.ts against its LIVE fal.ai
 * OpenAPI Input schema.
 *
 *   node --experimental-strip-types scripts/verify-fal-image-models.mjs
 *
 * For each model it builds the exact payload app/api/generate/route.ts would
 * submit (several aspect ratios / quality tiers / option combinations) and
 * checks: required fields present, no unknown keys, enum/const values valid,
 * numeric bounds, and basic types. A wrong key here is a paid 422 in prod.
 */
import { FAL_IMAGE_MODELS, buildFalImageInput } from '../lib/fal-image-models.ts'

const SCHEMA_URL = (id) =>
  `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(id)}`

const IMG = 'https://storage.googleapis.com/falserverless/model_tests/upscale/owl.png'

// ── tiny JSON-Schema validator covering the subset fal emits ─────────────────
function deref(doc, node) {
  let n = node
  let guard = 0
  while (n && n.$ref && guard++ < 10) {
    n = n.$ref.replace(/^#\//, '').split('/').reduce((acc, k) => acc[k], doc)
  }
  return n
}

function validate(doc, schema, value, path, errors) {
  const s = deref(doc, schema)
  if (!s) return

  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branches = s.anyOf || s.oneOf
    const ok = branches.some((b) => {
      const sub = []
      validate(doc, b, value, path, sub)
      return sub.length === 0
    })
    if (!ok) errors.push(`${path}: ${JSON.stringify(value)} matches none of the allowed variants`)
    return
  }

  if (s.const !== undefined && value !== s.const) {
    errors.push(`${path}: must be const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`)
    return
  }
  if (Array.isArray(s.enum)) {
    if (!s.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in enum [${s.enum.join('|')}]`)
    }
    return
  }

  switch (s.type) {
    case 'null':
      if (value !== null) errors.push(`${path}: expected null`)
      return
    case 'string':
      if (typeof value !== 'string') { errors.push(`${path}: expected string, got ${typeof value}`); return }
      if (s.minLength != null && value.length < s.minLength) errors.push(`${path}: shorter than minLength ${s.minLength}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`)
      return
    case 'integer':
      if (!Number.isInteger(value)) { errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`); return }
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path}: expected number`); return }
      break
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return }
      if (s.minItems != null && value.length < s.minItems) errors.push(`${path}: fewer than minItems ${s.minItems}`)
      if (s.maxItems != null && value.length > s.maxItems) errors.push(`${path}: more than maxItems ${s.maxItems}`)
      if (s.items) value.forEach((v, i) => validate(doc, s.items, v, `${path}[${i}]`, errors))
      return
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path}: expected object`); return }
      checkObject(doc, s, value, path, errors)
      return
    }
    default:
      // untyped node (e.g. bare $ref target already deref'd, or `any`)
      if (s.properties) { checkObject(doc, s, value, path, errors); return }
      return
  }

  if (s.minimum != null && value < s.minimum) errors.push(`${path}: ${value} < minimum ${s.minimum}`)
  if (s.maximum != null && value > s.maximum) errors.push(`${path}: ${value} > maximum ${s.maximum}`)
}

function checkObject(doc, s, value, path, errors) {
  const props = s.properties || {}
  for (const r of s.required || []) {
    if (value[r] === undefined) errors.push(`${path}${path ? '.' : ''}${r}: REQUIRED field missing`)
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) { errors.push(`${path}${path ? '.' : ''}${k}: value is undefined`); continue }
    if (!props[k]) { errors.push(`${path}${path ? '.' : ''}${k}: UNKNOWN key (not in schema)`); continue }
    validate(doc, props[k], v, `${path}${path ? '.' : ''}${k}`, errors)
  }
}

// ── payload permutations per model ──────────────────────────────────────────
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '21:9', '2:1', '1:2', '9:21', 'auto', 'bogus-ratio']
const QUALITIES = ['1k', '2k', '4k', 'weird']

const OPTION_SETS = [
  {},
  // everything a client could plausibly send, including junk that must be
  // sanitised away rather than forwarded to fal
  {
    grokQuality: 'low',
    qwenNegativePrompt: 'blurry',
    qwenPromptExpansion: false,
    briaStylePreset: 'Photoreal',
    briaSeed: 1234,
    briaMaskUrl: IMG,
    ideogramRenderingSpeed: 'QUALITY',
    ideogramExpansionModel: 'None',
    nb2LiteSafetyTolerance: 6,
    nb2LiteThinking: 'high',
    nb2LiteLimitGenerations: false,
    recraftStyleId: '00000000-0000-0000-0000-000000000000',
    recraftStyleMatch: 'precise',
    recraftColors: [{ r: 12, g: 200, b: 255 }, { r: 999, g: -5, b: 3 }],
    recraftBackgroundColor: { r: 255, g: 255, b: 255 },
    pixelcutBackgroundMode: 'Color',
    pixelcutBackgroundColor: { r: 240, g: 240, b: 240 },
    pixelcutMargin: '15%',
    pixelcutOutputFormat: 'jpeg',
    topazUpscaleFactor: 4,
    topazCreativity: 3,
    topazDetail: 0.5,
    topazTexture: 3,
    topazDenoise: 0.3,
    topazSharpen: 0.4,
    topazFixCompression: 0.2,
    topazStrength: 0.8,
    topazFaceEnhancement: false,
    topazFaceEnhancementStrength: 0.5,
    topazFaceEnhancementCreativity: 0.2,
    topazCropToFill: true,
    topazColorPreservation: true,
    topazAutoprompt: true,
    topazEnhancementStrength: 'high',
    topazSubjectDetection: 'Foreground',
    topazOutputFormat: 'jpeg',
  },
  // hostile / malformed client input — must never reach fal as-is
  {
    grokQuality: 'ultra',
    briaStylePreset: 'Nope',
    ideogramRenderingSpeed: 'FASTEST',
    nb2LiteSafetyTolerance: '99',
    nb2LiteThinking: 'medium',
    recraftStyleMatch: 'loose',
    recraftColors: 'not-an-array',
    pixelcutBackgroundMode: 'Rainbow',
    pixelcutOutputFormat: 'gif',
    topazModel: 'Definitely Not A Model',
    topazUpscaleFactor: 99,
    topazCreativity: -4,
    topazSubjectDetection: 'Sideways',
    topazOutputFormat: 'tiff',
    topazEnhancementStrength: 'extreme',
  },
]

function modelSpecificOptions(id) {
  // exercise every per-model enum member at least once
  const map = {
    'topaz-img-upscale-precision': ['Standard V2', 'High Fidelity V3', 'High Fidelity V2', 'Low Resolution V2', 'CGI', 'Text Refine'],
    'topaz-img-upscale-creative': ['Bloom 2', 'Bloom', 'Bloom Realism'],
    'topaz-img-upscale-generative': ['Wonder 3.5', 'Wonder 3', 'Wonder 2', 'Wonder', 'Recover 3', 'Standard MAX', 'Redefine', 'Recovery V2', 'Recovery'],
    'topaz-adjust': ['Adjust V2', 'White Balance', 'Colorize'],
    'topaz-sharpen': ['Standard', 'Strong', 'Lens Blur V2', 'Motion Blur', 'Natural', 'Refocus', 'Wildlife', 'Portrait', 'Auto Sharpen', 'Super Focus V3', 'Super Focus V2'],
    'topaz-denoise': ['Normal', 'Strong', 'Extreme', 'Denoise Max'],
    'topaz-restore': ['Recover 3', 'Dust-Scratch V2'],
  }
  return (map[id] || []).map((m) => ({ topazModel: m }))
}

/** Proves the validator actually rejects bad payloads (guards against a
 *  silently no-op checker making every model look green). */
async function selfTest() {
  const doc = await (await fetch(SCHEMA_URL('google/nano-banana-2-lite'))).json()
  const schema = doc.components.schemas.NanoBanana2LiteInput
  const P = 'a perfectly ordinary valid prompt'
  const cases = [
    [{ aspect_ratio: '1:1' }, 'missing required prompt'],
    [{ prompt: 'ab' }, 'prompt below minLength'],
    [{ prompt: P, bogus_key: 1 }, 'unknown key'],
    [{ prompt: P, aspect_ratio: '7:3' }, 'invalid enum'],
    [{ prompt: P, safety_tolerance: 6 }, 'number where string enum expected'],
    [{ prompt: P, num_images: 99 }, 'above maximum'],
    [{ prompt: P, output_format: 'tiff' }, 'invalid output_format'],
  ]
  let bad = 0
  for (const [payload, label] of cases) {
    const errs = []
    checkObject(doc, schema, payload, '', errs)
    if (errs.length === 0) { console.log(`SELFTEST FAIL: validator accepted ${label}`); bad++ }
    else console.log(`selftest ok: rejected ${label} -> ${errs[0]}`)
  }
  return bad
}

async function main() {
  const only = process.argv.slice(2).filter((a) => a !== '--selftest')
  if (process.argv.includes('--selftest')) {
    const bad = await selfTest()
    if (bad) process.exit(1)
    console.log('')
  }
  let failed = 0
  let checked = 0

  for (const [id, spec] of Object.entries(FAL_IMAGE_MODELS)) {
    if (only.length && !only.includes(id)) continue

    const res = await fetch(SCHEMA_URL(spec.endpoint), { headers: { accept: 'application/json' } })
    if (!res.ok) {
      console.log(`FAIL ${id.padEnd(30)} schema fetch HTTP ${res.status} for ${spec.endpoint}`)
      failed++
      continue
    }
    const doc = await res.json()
    const inputName = Object.keys(doc.components?.schemas || {}).find((k) => /Input$/.test(k))
    if (!inputName) {
      console.log(`FAIL ${id.padEnd(30)} no *Input schema at ${spec.endpoint}`)
      failed++
      continue
    }
    const inputSchema = doc.components.schemas[inputName]

    const errors = []
    let payloads = 0
    const optionSets = [...OPTION_SETS, ...modelSpecificOptions(id)]

    for (const aspectRatio of ASPECTS) {
      for (const quality of QUALITIES) {
        for (const options of optionSets) {
          const imageUrls = spec.maxInputImages > 0 || spec.needsImage
            ? Array.from({ length: Math.max(2, spec.maxInputImages) }, () => IMG)
            : []
          let built
          try {
            built = buildFalImageInput(spec, {
              prompt: 'a neon lighthouse on a cliff, cinematic',
              aspectRatio,
              quality,
              imageUrls,
              options,
            })
          } catch (e) {
            errors.push(`builder threw for ar=${aspectRatio} q=${quality}: ${e.message}`)
            continue
          }
          payloads++
          const sub = []
          checkObject(doc, inputSchema, built.input, '', sub)
          for (const e of sub) errors.push(`[ar=${aspectRatio} q=${quality}] ${e}`)
        }
      }
    }

    // The builder must reject a too-short prompt rather than forward it (fal
    // 422s on minLength), and must reject a missing required input image.
    const guardImgs = Array.from({ length: Math.max(2, spec.maxInputImages) }, () => IMG)
    if (spec.promptMin && spec.promptMin > 1) {
      let threw = false
      try { buildFalImageInput(spec, { prompt: 'a', aspectRatio: '1:1', quality: '1k', imageUrls: guardImgs, options: {} }) }
      catch { threw = true }
      if (!threw) errors.push(`builder accepted a 1-char prompt despite minLength ${spec.promptMin}`)
    }
    if (spec.needsImage) {
      let threw = false
      try { buildFalImageInput(spec, { prompt: 'a valid prompt here', aspectRatio: '1:1', quality: '1k', imageUrls: [], options: {} }) }
      catch { threw = true }
      if (!threw) errors.push('builder accepted an empty image list despite needsImage')
    }

    checked++
    if (errors.length) {
      failed++
      const uniq = [...new Set(errors)]
      console.log(`FAIL ${id.padEnd(30)} ${spec.endpoint}`)
      for (const e of uniq.slice(0, 12)) console.log(`       ${e}`)
      if (uniq.length > 12) console.log(`       ... +${uniq.length - 12} more`)
    } else {
      console.log(`OK   ${id.padEnd(30)} ${spec.endpoint}  (${payloads} payloads, schema ${inputName})`)
    }
  }

  console.log(`\n${checked - failed}/${checked} models valid`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
