/**
 * The 3D suite: fal's mesh, scene and rigging models.
 *
 * A separate catalog from the image and video ones because 3D is a different
 * shape of work — the output is a FILE (a mesh, a rig, a world) rather than a
 * picture, the useful models chain into each other (generate → remesh →
 * retexture → rig), and what makes one right for a job is usually its export
 * format rather than its look.
 *
 * Every entry below was read off fal's live catalog and OpenAPI schemas on
 * 2026-09-05, including the published prices. Prices are fal's own words,
 * converted to USD per generation; they are what the Ticket Economics page
 * prices against, not what the user is charged.
 */

/**
 * One exposed knob on a model.
 *
 * Curated, not generated: Trellis alone publishes thirty inputs and twenty-six
 * of them are denoising internals nobody should touch from a bench. What is
 * listed here is what changes the deliverable — export format, polycount,
 * texture quality — plus the handful of fields a model REFUSES to run without.
 */
export type ThreeDControl = {
  key: string
  label: string
  kind: 'text' | 'number' | 'toggle' | 'select'
  /** Sent when the user leaves it alone. Omit to send nothing. */
  preset?: string | number | boolean
  options?: { value: string | number; label: string }[]
  placeholder?: string
  help?: string
  /** fal 422s without it, so the bench blocks instead of burning a submit. */
  required?: boolean
}

export type ThreeDStage = 'generate' | 'refine' | 'rig' | 'scene' | 'analyse'

export type ThreeDModel = {
  id: string
  label: string
  endpoint: string
  stage: ThreeDStage
  /** Who makes it. The picker groups by this, the way the taskbar groups images. */
  family: string
  /** What it consumes. */
  input: 'text' | 'image' | 'images' | 'mesh' | 'image+mesh'
  /**
   * The EXACT field names fal expects, read off each endpoint's schema.
   *
   * Inferring these from `input` was wrong for nine of twenty-five models and
   * every one of them failed the same way: fal accepted the job, reported it
   * COMPLETED, and returned a 422 when the result was read. Trellis wants
   * image_url not image_urls, Hunyuan wants input_image_url, Tripo's remesh
   * wants mesh_url while Meshy's rigging wants model_url. There is no house
   * style to infer, so the names are written down.
   */
  imageField?: string
  meshField?: string
  /** Set only where a typed prompt steers an image/mesh job rather than being ignored. */
  promptField?: string
  /** What comes back, in the words that matter to a pipeline. */
  output: string
  /** fal's published price per generation, or null when they publish none. */
  usd: number | null
  /** One line on when this is the right choice. */
  bestFor: string
  /** Honest limitations. */
  caveat?: string
  /** Knobs worth exposing on the bench. */
  controls?: ThreeDControl[]
}

export const THREED_MODELS: ThreeDModel[] = [
  // ── generate: something from nothing, or from a picture ──────────────────
  {
    id: 'meshy-7-text',
    label: 'Meshy 7 (text → 3D)',
    family: 'Meshy',
    endpoint: 'meshy/v7/text-to-3d',
    stage: 'generate',
    input: 'text',
    output: 'Textured PBR mesh (GLB), quad-friendly topology',
    usd: 0.8,
    bestFor: 'A described object with no reference at all. The most complete text-to-mesh here: real geometry plus PBR maps rather than a blobby preview.',
    caveat: '$0.80 untextured, more with textures — the priciest generate step, so prove the shape before paying for texture.',
    controls: [
      { key: 'topology', label: 'Topology', kind: 'select', options: [{ value: 'triangle', label: 'Triangles' }, { value: 'quad', label: 'Quads' }], preset: 'triangle', help: 'Quads are what you want if the mesh is going into a modelling package.' },
      { key: 'target_polycount', label: 'Target polycount', kind: 'number', placeholder: '30000' },
      { key: 'model_type', label: 'Detail', kind: 'select', options: [{ value: 'standard', label: 'Standard' }, { value: 'lowpoly', label: 'Low poly' }, { value: 'smart-topology', label: 'Smart topology' }], preset: 'standard' },
      { key: 'symmetry_mode', label: 'Symmetry', kind: 'select', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Force on' }, { value: 'off', label: 'Off' }], preset: 'auto' },
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'enable_rigging', label: 'Auto-rig as humanoid', kind: 'toggle', preset: false, help: 'Only meaningful on a character; skips straight to a rigged GLB.' },
    ],
  },
  {
    id: 'meshy-7-image',
    label: 'Meshy 7 (image → 3D)',
    family: 'Meshy',
    endpoint: 'meshy/v7/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'image_url',
    output: 'Textured PBR mesh (GLB)',
    usd: 0.8,
    bestFor: 'One reference photo into a production-ready mesh. The default when quality matters more than cost.',
    controls: [
      { key: 'topology', label: 'Topology', kind: 'select', options: [{ value: 'triangle', label: 'Triangles' }, { value: 'quad', label: 'Quads' }], preset: 'triangle', help: 'Quads are what you want if the mesh is going into a modelling package.' },
      { key: 'target_polycount', label: 'Target polycount', kind: 'number', placeholder: '30000' },
      { key: 'model_type', label: 'Detail', kind: 'select', options: [{ value: 'standard', label: 'Standard' }, { value: 'lowpoly', label: 'Low poly' }, { value: 'smart-topology', label: 'Smart topology' }], preset: 'standard' },
      { key: 'symmetry_mode', label: 'Symmetry', kind: 'select', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Force on' }, { value: 'off', label: 'Off' }], preset: 'auto' },
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'enable_rigging', label: 'Auto-rig as humanoid', kind: 'toggle', preset: false, help: 'Only meaningful on a character; skips straight to a rigged GLB.' },
    ],
  },
  {
    id: 'meshy-7-multi',
    label: 'Meshy 7 (multi-view → 3D)',
    family: 'Meshy',
    endpoint: 'meshy/v7/multi-image-to-3d',
    stage: 'generate',
    input: 'images',
    imageField: 'image_urls',
    output: 'Textured PBR mesh (GLB)',
    usd: 0.8,
    bestFor: 'Several angles of the same object. Multi-view beats single-image every time for anything with a back you care about.',
    controls: [
      { key: 'topology', label: 'Topology', kind: 'select', options: [{ value: 'triangle', label: 'Triangles' }, { value: 'quad', label: 'Quads' }], preset: 'triangle', help: 'Quads are what you want if the mesh is going into a modelling package.' },
      { key: 'target_polycount', label: 'Target polycount', kind: 'number', placeholder: '30000' },
      { key: 'symmetry_mode', label: 'Symmetry', kind: 'select', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Force on' }, { value: 'off', label: 'Off' }], preset: 'auto' },
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'enable_rigging', label: 'Auto-rig as humanoid', kind: 'toggle', preset: false, help: 'Only meaningful on a character; skips straight to a rigged GLB.' },
    ],
  },
  {
    id: 'tripo-2.5-image',
    label: 'Tripo 2.5 (image → 3D)',
    family: 'Tripo',
    endpoint: 'tripo3d/tripo/v2.5/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'image_url',
    output: 'base_model, pbr_model, model_mesh + a rendered preview',
    usd: 0.2,
    bestFor: 'The value pick, and the most controllable: face_limit, quad topology, PBR on/off, texture off/standard/HD, and an orientation flag.',
    caveat: '$0.20 untextured, $0.30 standard texture, more for HD.',
    controls: [
      { key: 'texture', label: 'Texture', kind: 'select', options: [{ value: 'no', label: 'None' }, { value: 'standard', label: 'Standard' }, { value: 'HD', label: 'HD' }], preset: 'standard' },
      { key: 'quad', label: 'Quad mesh', kind: 'toggle', preset: false, help: 'Adds $0.05 and gives clean topology for editing.' },
      { key: 'pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'face_limit', label: 'Face limit', kind: 'number', placeholder: 'leave blank for auto' },
      { key: 'orientation', label: 'Orientation', kind: 'select', options: [{ value: 'default', label: 'As generated' }, { value: 'align_image', label: 'Align to image' }], preset: 'default' },
    ],
  },
  {
    id: 'tripo-h3.1-image',
    label: 'Tripo H3.1 (image → 3D)',
    family: 'Tripo',
    endpoint: 'tripo3d/h3.1/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'image_url',
    output: 'Textured mesh',
    usd: null,
    bestFor: 'Tripo\'s newer line — worth A/B-ing against 2.5 on the same reference before committing a batch.',
    controls: [
      { key: 'texture', label: 'Texture', kind: 'select', options: [{ value: 'no', label: 'None' }, { value: 'standard', label: 'Standard' }, { value: 'HD', label: 'HD' }], preset: 'standard' },
      { key: 'quad', label: 'Quad mesh', kind: 'toggle', preset: false, help: 'Adds $0.05 and gives clean topology for editing.' },
      { key: 'pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'face_limit', label: 'Face limit', kind: 'number', placeholder: 'leave blank for auto' },
      { key: 'orientation', label: 'Orientation', kind: 'select', options: [{ value: 'default', label: 'As generated' }, { value: 'align_image', label: 'Align to image' }], preset: 'default' },
    ],
  },
  {
    id: 'hunyuan3d-3.1-pro-image',
    label: 'Hunyuan 3D 3.1 Pro (image → 3D)',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'input_image_url',
    output: 'High-resolution textured mesh',
    usd: 0.375,
    bestFor: 'Detail-heavy objects. The Pro tier is noticeably finer than the rapid one on hard surfaces and ornament.',
    controls: [
      { key: 'face_count', label: 'Face count', kind: 'number', placeholder: '500000', help: '40,000 to 1,500,000.' },
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: false },
      { key: 'generate_type', label: 'Output', kind: 'select', options: [{ value: 'Normal', label: 'Geometry + texture' }, { value: 'Geometry', label: 'Geometry only' }], preset: 'Normal' },
    ],
  },
  {
    id: 'hunyuan3d-3.1-rapid-image',
    label: 'Hunyuan 3D 3.1 Rapid (image → 3D)',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'input_image_url',
    output: 'Textured mesh, fast',
    usd: null,
    bestFor: 'Draft passes and shape-finding, before you spend Pro money on the version you keep.',
    controls: [
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: false },
    ],
  },
  {
    id: 'rodin-2.5',
    label: 'Rodin V2.5 (image → 3D)',
    family: 'Rodin',
    endpoint: 'fal-ai/hyper3d/rodin/v2.5',
    stage: 'generate',
    input: 'images',
    promptField: 'prompt',
    imageField: 'image_urls',
    output: 'Production-ready mesh',
    usd: 0.4,
    bestFor: 'Clean, printable-feeling geometry. Rodin tends to give tidier surfaces than the photo-derived models.',
    caveat: 'HighPack costs extra on top of the $0.40 base.',
    controls: [
      { key: 'tier', label: 'Tier', kind: 'select', options: [{ value: 'Gen-2.5-Minimum', label: 'Minimum' }, { value: 'Gen-2.5-Low', label: 'Low' }, { value: 'Gen-2.5-Medium', label: 'Medium' }, { value: 'Gen-2.5-High', label: 'High' }, { value: 'Gen-2.5-Extreme-High', label: 'Extreme high' }], preset: 'Gen-2.5-High' },
      { key: 'quality_mesh_option', label: 'Mesh budget', kind: 'select', options: [{ value: 'Auto', label: 'Auto' }, { value: '4K Quad', label: '4K quad' }, { value: '18K Quad', label: '18K quad' }, { value: '100K Quad', label: '100K quad' }, { value: '50K Triangle', label: '50K tri' }, { value: '500K Triangle', label: '500K tri' }], preset: 'Auto' },
      { key: 'geometry_file_format', label: 'Export', kind: 'select', options: [{ value: 'glb', label: 'GLB' }, { value: 'fbx', label: 'FBX' }, { value: 'obj', label: 'OBJ' }, { value: 'stl', label: 'STL' }, { value: 'usdz', label: 'USDZ' }], preset: 'glb' },
      { key: 'material', label: 'Material', kind: 'select', options: [{ value: 'All', label: 'All' }, { value: 'PBR', label: 'PBR' }, { value: 'Shaded', label: 'Shaded' }, { value: 'None', label: 'None' }], preset: 'All' },
      { key: 'TAPose', label: 'T/A-pose', kind: 'toggle', preset: false, help: 'Generates the character posed for rigging.' },
      { key: 'hd_texture', label: 'HD texture', kind: 'toggle', preset: false },
    ],
  },
  {
    id: 'trellis-2',
    label: 'TRELLIS 2 (image → 3D)',
    family: 'TRELLIS',
    endpoint: 'fal-ai/trellis-2',
    stage: 'generate',
    input: 'image',
    imageField: 'image_url',
    output: 'Native 3D representation → mesh',
    usd: 0.25,
    bestFor: 'A native-3D generator rather than a multi-view reconstructor, and it has a LoRA path (fal-ai/trellis-2-lora) if you ever train a style.',
    caveat: '$0.25 at 512p, $0.30 at 1024p.',
    controls: [
      { key: 'resolution', label: 'Resolution', kind: 'select', options: [{ value: 512, label: '512' }, { value: 1024, label: '1024' }, { value: 1536, label: '1536' }], preset: 1024 },
      { key: 'texture_size', label: 'Texture size', kind: 'select', options: [{ value: 1024, label: '1K' }, { value: 2048, label: '2K' }, { value: 4096, label: '4K' }], preset: 2048 },
      { key: 'decimation_target', label: 'Vertex target', kind: 'number', placeholder: '500000' },
      { key: 'remesh', label: 'Clean topology', kind: 'toggle', preset: true },
    ],
  },
  {
    id: 'hi3d-image',
    label: 'Hi3D V3.0 (image → 3D)',
    family: 'Hi3D',
    endpoint: 'hitem3d/hi3d/v3.0/image-to-3d',
    stage: 'generate',
    input: 'image',
    imageField: 'image_url',
    output: 'Mesh',
    usd: null,
    bestFor: 'The Hi3D family is the one with the most 3D-to-3D follow-ups (texture, split, multicolor), so starting here keeps those open.',
    controls: [
      { key: 'resolution', label: 'Resolution', kind: 'select', options: [{ value: '2048quality', label: '2048 quality' }, { value: '2048master', label: '2048 master' }], preset: '2048quality' },
      { key: 'export_format', label: 'Export', kind: 'select', options: [{ value: 'glb', label: 'GLB' }, { value: 'obj', label: 'OBJ' }, { value: 'fbx', label: 'FBX' }, { value: 'stl', label: 'STL' }, { value: 'usdz', label: 'USDZ' }], preset: 'glb' },
      { key: 'enable_texture', label: 'Texture', kind: 'toggle', preset: true },
      { key: 'enable_pbr', label: 'PBR maps', kind: 'toggle', preset: true },
    ],
  },

  // ── refine: an existing mesh, made usable ────────────────────────────────
  {
    id: 'tripo-remesh',
    label: 'Tripo Remesh',
    family: 'Tripo',
    endpoint: 'tripo3d/tripo/remesh',
    stage: 'refine',
    input: 'mesh',
    meshField: 'mesh_url',
    output: 'Clean quad topology at a target polygon count',
    usd: null,
    bestFor: 'THE step that turns a generated blob into something a game engine or a modeller will accept. Generated meshes are triangle soup; quads are what rigs and subdivision need.',
  },
  {
    id: 'hunyuan-smart-topology',
    label: 'Hunyuan Smart Topology',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/smart-topology',
    stage: 'refine',
    input: 'mesh',
    meshField: 'input_file_url',
    output: 'Optimised topology',
    usd: null,
    bestFor: 'The alternative remesher. Worth trying when Tripo\'s quad pass mangles a shape.',
  },
  {
    id: 'meshy-retexture',
    label: 'Meshy Retexture',
    family: 'Meshy',
    endpoint: 'fal-ai/meshy/v5/retexture',
    stage: 'refine',
    input: 'mesh',
    meshField: 'model_url',
    output: 'New textures on existing geometry',
    usd: null,
    bestFor: 'Keeping a mesh you like and changing what it is made of. Far cheaper than regenerating for a material change.',
  },
  {
    id: 'hi3d-texture',
    label: 'Hi3D Texture',
    family: 'Hi3D',
    endpoint: 'hitem3d/hi3d/texture',
    stage: 'refine',
    input: 'image+mesh',
    imageField: 'image_url',
    meshField: 'mesh_url',
    output: 'Textured mesh',
    usd: 0.02,
    bestFor: 'Texturing bare geometry FROM a reference image — the cheapest useful call in the whole 3D suite.',
    caveat: 'Billed per credit at $0.02, so the real cost depends on how many credits a job consumes.',
  },
  {
    id: 'hunyuan-part',
    label: 'Hunyuan 3D Part Split',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/part',
    stage: 'refine',
    input: 'mesh',
    meshField: 'input_file_url',
    output: 'Model split into parts',
    usd: null,
    bestFor: 'Breaking a single mesh into components you can move, recolour or print separately.',
  },
  {
    id: 'tripo-segment',
    label: 'Tripo Segment',
    family: 'Tripo',
    endpoint: 'tripo3d/tripo/segment',
    stage: 'refine',
    input: 'mesh',
    meshField: 'mesh_url',
    output: 'Semantic parts',
    usd: null,
    bestFor: 'Same idea, semantic rather than geometric — it knows a handle from a lid.',
  },
  {
    id: 'hi3d-multicolor',
    label: 'Hi3D Multicolor',
    family: 'Hi3D',
    endpoint: 'hitem3d/hi3d/multicolor',
    stage: 'refine',
    input: 'mesh',
    meshField: 'mesh_url',
    output: 'Multicolor model',
    usd: null,
    bestFor: 'Prepping for a MULTICOLOUR 3D PRINTER, which needs colour assigned per region rather than a texture map.',
  },

  // ── rig: make it move ────────────────────────────────────────────────────
  {
    id: 'meshy-rigging',
    label: 'Meshy Auto-Rig',
    family: 'Meshy',
    endpoint: 'fal-ai/meshy/rigging',
    stage: 'rig',
    input: 'mesh',
    meshField: 'model_url',
    output: 'rigged_character_glb, rigged_character_fbx, animation_glb/fbx, basic_animations',
    usd: 0.2,
    bestFor: 'A humanoid mesh into a skinned, animation-ready character. Returns FBX as well as GLB, which is what a game engine actually wants.',
    caveat: '+$0.12 with enable_animation, so $0.32 for a rig with motion.',
    controls: [
      { key: 'height_meters', label: 'Character height (m)', kind: 'number', placeholder: '1.7' },
      { key: 'enable_animation', label: 'Apply an animation preset', kind: 'toggle', preset: false },
    ],
  },
  {
    id: 'hunyuan-motion',
    label: 'Hunyuan Motion (text → animation)',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan-motion',
    stage: 'rig',
    input: 'text',
    output: '3D human motion',
    usd: null,
    bestFor: 'Describing a movement and getting motion data, rather than picking from a canned animation list.',
    controls: [
      { key: 'duration', label: 'Duration (s)', kind: 'number', placeholder: '5', help: '0.5 to 12.' },
      { key: 'output_format', label: 'Export', kind: 'select', options: [{ value: 'fbx', label: 'FBX' }, { value: 'dict', label: 'Raw dict' }], preset: 'fbx' },
    ],
  },

  // ── scene: a whole environment ───────────────────────────────────────────
  {
    id: 'hunyuan-world',
    label: 'Hunyuan World 1.0',
    family: 'Hunyuan',
    endpoint: 'fal-ai/hunyuan_world/image-to-world',
    stage: 'scene',
    input: 'image',
    imageField: 'image_url',
    output: 'world_file — a panorama or navigable 3D world',
    usd: null,
    bestFor: 'ONE image into a whole environment. The closest thing here to "generate a game level from a concept painting".',
    caveat: 'Needs labels_fg1, labels_fg2 and classes alongside the image — you must tell it what is foreground and what the objects are, so it is not a one-field call.',
    controls: [
      { key: 'labels_fg1', label: 'Foreground object 1', kind: 'text', placeholder: 'e.g. rusted car', help: 'Hunyuan World separates two foreground objects from the backdrop and refuses to run without both named.', required: true },
      { key: 'labels_fg2', label: 'Foreground object 2', kind: 'text', placeholder: 'e.g. street lamp', required: true },
      { key: 'classes', label: 'Scene class', kind: 'text', placeholder: 'e.g. outdoor', help: "'outdoor' or 'indoor' — how it reads the space.", required: true },
    ],
  },
  {
    id: 'triposplat',
    label: 'TripoSplat',
    family: 'Tripo',
    endpoint: 'tripo3d/triposplat',
    stage: 'scene',
    input: 'image',
    imageField: 'image_url',
    output: 'Gaussian splat',
    usd: null,
    bestFor: 'Photoreal captured-looking scenes. Splats look better than meshes for environments but do not import into a game engine the way a mesh does.',
    caveat: 'A splat is not a mesh. Wrong output if the goal is printing or rigging.',
  },
  {
    id: 'sam3-3d-objects',
    label: 'SAM 3D Objects',
    family: 'SAM 3D',
    endpoint: 'fal-ai/sam-3/3d-objects',
    stage: 'scene',
    input: 'image',
    promptField: 'prompt',
    imageField: 'image_url',
    output: 'Reconstructed objects from a real photo',
    usd: 0.02,
    bestFor: 'Pulling real objects out of a real photograph as separate 3D models. Two cents a unit.',
  },
  {
    id: 'sam3-3d-body',
    label: 'SAM 3D Body',
    family: 'SAM 3D',
    endpoint: 'fal-ai/sam-3/3d-body',
    stage: 'scene',
    input: 'image',
    imageField: 'image_url',
    output: 'Human body shape and pose',
    usd: null,
    bestFor: 'Reconstructing a person\'s body and pose from a photo — a starting point for a character, or a pose reference.',
  },

  // ── analyse: geometry as data ────────────────────────────────────────────
  {
    id: 'vggt-1b',
    label: 'VGGT-1B (scene understanding)',
    family: 'VGGT',
    endpoint: 'fal-ai/vggt-1b',
    stage: 'analyse',
    input: 'images',
    imageField: 'image_urls',
    output: 'JSON: depth, camera poses, point cloud',
    usd: null,
    bestFor: 'Images or video into depth maps, camera tracks and a point cloud. The measurement tool rather than the making tool.',
  },
  {
    id: 'hi3d-relief',
    label: 'Hi3D Image to Relief',
    family: 'Hi3D',
    endpoint: 'hitem3d/hi3d/image-to-relief',
    stage: 'analyse',
    input: 'image',
    imageField: 'image_url',
    output: '3D relief depth map',
    usd: null,
    bestFor: 'A flat image as a raised relief — the right tool for engraved plaques, coins and lithophanes, all of which print well.',
  },
]

export const THREED_STAGE_LABEL: Record<ThreeDStage, string> = {
  generate: 'Generate',
  refine: 'Refine',
  rig: 'Rig & animate',
  scene: 'Scenes & capture',
  analyse: 'Analyse',
}

export function get3DModel(id: string | undefined): ThreeDModel | undefined {
  return THREED_MODELS.find(m => m.id === id)
}
