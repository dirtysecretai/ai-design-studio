// Agent Skills & Employees — modular instruction/tool loading for the chat hub.
// CLIENT-SAFE (no prisma/crypto): imported by both the UI (chips, cost readout)
// and the server (instruction assembly + tool gating in chat-hub-agent).
//
// HYBRID LOADING (v2): a selected skill contributes only its SUMMARY line +
// tool access on every step (summaryTokens). Its full PLAYBOOK (craft text,
// server-only in lib/chat-hub-playbooks.ts) loads mid-run via the load_skill
// tool ONLY when the agent needs it (playbookTokens). Skills with
// playbookTokens = 0 are fully always-on (their text is operational and
// renders in mediaInstructions/toolsInstructions every step).
//
// A SKILL = summary + tools (+ optional playbook). An EMPLOYEE = a named
// preset composing personality text + a skill set. A chat's `skills` column
// (null = all skills = legacy behavior) decides what gets assembled per step.
//
// Token numbers are measured estimates (text chars / 4, including the skill's
// tool schemas) — keep them roughly current when skill texts grow.

// A chat's enabled skill ids (null = all skills = legacy chats / Full Studio).
export type SkillSet = Set<string> | null
export const skillOn = (skills: SkillSet, id: string) => !skills || skills.has(id)

export type SkillCategory = 'media' | 'craft' | 'marketing' | 'film' | 'style' | 'social' | 'utility'

export const SKILL_CATEGORIES: { id: SkillCategory; label: string }[] = [
  { id: 'media', label: 'Media Engines' },
  { id: 'craft', label: 'Design Craft' },
  { id: 'marketing', label: 'Ads & Marketing' },
  { id: 'film', label: 'Film & Story' },
  { id: 'style', label: 'Style & Character' },
  { id: 'social', label: 'Social & Formats' },
  { id: 'utility', label: 'Utilities' },
]

export type AgentSkill = {
  id: string
  name: string
  description: string               // card copy shown in the UI
  category: SkillCategory
  summary: string                   // literal 1-2 line ALWAYS-ON instruction text (SKILL LIBRARY block)
  summaryTokens: number             // always-on tokens per step (summary + tool schema share + operational blocks)
  playbookTokens: number            // on-demand tokens when load_skill fires (0 = fully always-on skill)
  tools: string[]                   // tool names unlocked (beyond core tools)
  kinds?: ('image' | 'video')[]     // media catalog sections enabled
}

// Core is ALWAYS loaded: identity, mode, planning discipline (plan/quiz/
// summary/evaluation contracts) + core tools. ~1.6k tokens incl. schemas.
export const CORE_TOKENS = 1600
export const CORE_TOOLS = ['propose_plan', 'ask_user', 'record_evaluation', 'write_summary', 'edit_instructions']

export const AGENT_SKILLS: AgentSkill[] = [
  // ── Media Engines ──────────────────────────────────────────────────────────
  {
    id: 'image-generation',
    name: 'Image generation',
    description: 'The studio image models (NanoBanana, SeeDream, FLUX, GPT Images…) with the media workflow, chaining, evaluation and budget rules.',
    category: 'media',
    summary: 'Generate images with the studio models via create_media (catalog, costs and workflow rules are in your context).',
    summaryTokens: 1100, playbookTokens: 0,
    tools: ['create_media'], kinds: ['image'],
  },
  {
    id: 'video-production',
    name: 'Video production',
    description: 'The studio video models (SeeDance 2.0, Kling 3.0, Wan…), the video quality ranking and the premium key-frame workflow.',
    category: 'media',
    summary: 'Generate video with the studio models via create_media — quality ranking and the key-frame workflow are in your context.',
    summaryTokens: 700, playbookTokens: 0,
    tools: ['create_media'], kinds: ['video'],
  },
  {
    id: 'prompting-guides',
    name: 'Model prompting guides',
    description: 'The distilled official prompting guide for each media model (NanoBanana natural language, GPT Images sections, Kling cinematography…). Loads on demand.',
    category: 'media',
    summary: 'Distilled official prompting guides per media model — prompt structure differs sharply between models. Load before writing any generation prompt.',
    summaryTokens: 45, playbookTokens: 950,
    tools: [],
  },
  // ── Design Craft ───────────────────────────────────────────────────────────
  {
    id: 'graphic-design',
    name: 'Graphic design',
    description: 'Art-director knowledge: composition rules, eye-path and margins, contrast/scrim discipline, media-craft vocabulary. Loads on demand.',
    category: 'craft',
    summary: 'Art-director craft: composition vocabulary, eye-path, gestalt principles, hierarchy levels, margins-by-numbers, contrast/scrim rules and layout verification. Load before any layout, poster or text-on-image work.',
    summaryTokens: 45, playbookTokens: 1250,
    tools: [],
  },
  {
    id: 'color-theory',
    name: 'Color theory',
    description: 'Master colorist knowledge: harmonies, value structure, saturation discipline, temperature, mood palettes, grading vocabulary, style-specific color systems.',
    category: 'craft',
    summary: 'Color mastery: harmonies, value-first structure, saturation discipline, temperature depth, mood palettes with hexes, grading terms, per-style color systems. Load before any color-critical work — palettes, grading, mood, brand color, style matching.',
    summaryTokens: 50, playbookTokens: 1000,
    tools: [],
  },
  {
    id: 'lighting-design',
    name: 'Lighting mastery',
    description: 'Light quality/direction/ratio systems, named portrait setups, motivated light, chiaroscuro, volumetrics, mood-by-light.',
    category: 'craft',
    summary: 'Master lighting: quality/direction/ratio systems, named portrait setups (Rembrandt, butterfly, split, rim), motivated light, chiaroscuro, volumetrics, mood-by-light. Load before any shot where light carries the mood — portraits, drama, product heroes.',
    summaryTokens: 50, playbookTokens: 1000,
    tools: [],
  },
  {
    id: 'style-lexicon',
    name: 'Style lexicon',
    description: 'Art movements & design eras as deployable prompt language — Bauhaus, Swiss, Deco, Brutalism, Y2K, Baroque, Ukiyo-e and more.',
    category: 'craft',
    summary: 'Art movements & design eras as deployable prompt language — Bauhaus, Swiss, Deco, Nouveau, Brutalism, Memphis, Y2K, vaporwave, Baroque, Impressionism, Ukiyo-e and more, with when-to-use guidance. Load when a brief names an era/movement or needs a distinctive style direction.',
    summaryTokens: 50, playbookTokens: 1100,
    tools: [],
  },
  {
    id: 'photography-craft',
    name: 'Photography craft',
    description: 'Focal-length psychology, aperture/DOF, shutter/motion, film stocks & formats, grain, framing conventions.',
    category: 'craft',
    summary: 'Photographer-grade camera language: focal-length psychology, aperture/DOF, shutter/motion, film stocks & formats, grain, framing conventions. Load before photoreal work that must read like a real photograph.',
    summaryTokens: 45, playbookTokens: 900,
    tools: [],
  },
  {
    id: 'materials-surfaces',
    name: 'Materials & surfaces',
    description: 'Rendering language for metals, glass, fabrics, skin subsurface, liquids, wood/stone, patina & wear.',
    category: 'craft',
    summary: 'Material rendering language: metals, glass, fabrics, skin subsurface, liquids, wood/stone, patina & wear. Load before product/character work where surfaces must feel tactile.',
    summaryTokens: 45, playbookTokens: 850,
    tools: [],
  },
  {
    id: 'figure-anatomy',
    name: 'Anatomy & figure',
    description: 'Classical figure knowledge: proportion canons, gesture & balance, skeletal landmarks, muscle masses, hands, heads, foreshortening, motion — and the evaluation drills to catch anatomy failures.',
    category: 'craft',
    summary: 'Classical anatomy: proportion canons (8-head adult, child scales), gesture/line-of-action, contrapposto & balance, skeletal landmarks, simplified muscle masses, the hand system, head construction, foreshortening, joint limits. Load before ANY work featuring people or creatures — generation, pose sketching, or judging figures.',
    summaryTokens: 55, playbookTokens: 1300,
    tools: [],
  },
  {
    id: 'photoshop',
    name: 'Photoshop editing',
    description: 'The edit_image tool: crop/adjust/text/shapes/gradients/patch + AI subject masking (silhouettes, background removal) + the layered design-execution playbook incl. style-matched editing and compositing recipes (loads on demand).',
    category: 'craft',
    summary: 'Layered edit execution: scrims, lower-thirds, badges, palette discipline, spacing systems, patch removal, AI SUBJECT MASKING (pixel-perfect silhouettes & background removal), FULL COMPOSITING (multi-person collages from cutouts — segmentation + overlay stacking is an EDIT job, never needs generation), CUTOUT FLAT-SIDE DOCTRINE (bleed/tuck/trim every straight cut edge), TEXT OCCUPANCY planning (type never sits on type), procedural STARFIELD skies, ASSET STICKER LIBRARY technique (search_refs folders as texture packs), STYLE-MATCHED editing and compositing recipes (duotones, shadows, blend stacks). Load before executing precise edits or text placement.',
    summaryTokens: 500, playbookTokens: 3500,
    tools: ['edit_image'],
  },
  {
    id: 'sketching',
    name: 'Sketching & perspective',
    description: 'Blank-canvas composition/pose blocking sketches + full perspective systems (1/2/3-point, fisheye, isometric). Includes the edit_image tool.',
    category: 'craft',
    summary: 'Perspective systems (1/2/3-point, fisheye, isometric) and blank-canvas blocking sketches that steer generations. Load before sketching or perspective-critical scenes.',
    summaryTokens: 200, playbookTokens: 750,
    tools: ['edit_image'],
  },
  // ── Ads & Marketing ────────────────────────────────────────────────────────
  {
    id: 'ad-creative-director',
    name: 'Ad Creative Director',
    description: 'Direct-response ad creative: thumb-stopping hooks, ad visual hierarchy, offer framing and multi-variant angle strategy.',
    category: 'marketing',
    summary: 'Direct-response ad creative: thumb-stopping hooks, ad visual hierarchy, offer framing and multi-variant angles. Load before designing any ad.',
    summaryTokens: 45, playbookTokens: 900,
    tools: ['create_media', 'edit_image', 'search_refs', 'web_search'],
  },
  {
    id: 'ugc-content',
    name: 'UGC-Style Content',
    description: 'Authentic creator-style content: phone-camera look, natural light, handheld energy — believable, not studio-polished.',
    category: 'marketing',
    summary: 'Authentic creator-style content: phone-camera look, natural light, handheld energy — believable, not studio-polished. Load before making UGC-style assets.',
    summaryTokens: 45, playbookTokens: 700,
    tools: ['create_media'],
  },
  {
    id: 'product-photography',
    name: 'Product Shots',
    description: 'Studio-grade product photography: lighting recipes, surfaces, standard angle sets, e-commerce vs lifestyle treatments.',
    category: 'marketing',
    summary: 'Studio product photography: lighting recipes, surfaces, the standard e-comm angle set, lifestyle staging. Load before product shots.',
    summaryTokens: 45, playbookTokens: 800,
    tools: ['create_media', 'edit_image', 'search_refs'],
  },
  {
    id: 'brand-kit',
    name: 'Brand Kit & Analyzer',
    description: 'Extract a brand system (palette, type voice, tone) from refs or a site and enforce it on every asset; saves the kit to memory for reuse.',
    category: 'marketing',
    summary: 'Extract a brand system (palette hexes, type voice, tone words) from refs or a site, persist it to memory, and enforce it verbatim on every asset. Load before brand work.',
    summaryTokens: 45, playbookTokens: 700,
    tools: ['search_refs', 'web_search', 'save_memory', 'edit_image'],
  },
  // ── Film & Story ───────────────────────────────────────────────────────────
  {
    id: 'cinematic-direction',
    name: 'Cinematic Director',
    description: 'Film-grade camera language: shot grammar, lensing, movement vocabulary, motivated light and continuity locks.',
    category: 'film',
    summary: 'Film-grade camera language: shot grammar, lensing, movement, motivated light, continuity locks. Load before directing any cinematic shot or clip.',
    summaryTokens: 45, playbookTokens: 900,
    tools: ['create_media'],
  },
  {
    id: 'script-storyboard',
    name: 'Script & Storyboard',
    description: 'Beat sheets, shot lists and storyboard frames BEFORE spending tickets on video — structure first, render second.',
    category: 'film',
    summary: 'Beat sheets, shot lists and cheap storyboard frames BEFORE spending tickets on video. Load before planning any multi-shot piece.',
    summaryTokens: 45, playbookTokens: 800,
    tools: ['create_media', 'edit_image'],
  },
  {
    id: 'montage-sequencing',
    name: 'Montage & Sequencing',
    description: 'Multi-shot sequences that cut together: continuity locks, rhythm, transitions, start/end-frame chaining across clips.',
    category: 'film',
    summary: 'Multi-shot sequences that cut together: continuity locks, rhythm, transitions, start/end-frame chaining. Load before generating any shot sequence.',
    summaryTokens: 45, playbookTokens: 700,
    tools: ['create_media'],
  },
  // ── Style & Character ──────────────────────────────────────────────────────
  {
    id: 'cartoon-anime',
    name: 'Cartoon & Anime',
    description: 'Stylized illustration — anime, western cartoon, chibi, webtoon — with style-locking vocabulary so a look holds across a set.',
    category: 'style',
    summary: 'Stylized illustration (anime, western cartoon, chibi, webtoon) with style-locking descriptors that hold across a set. Load before stylized work.',
    summaryTokens: 45, playbookTokens: 800,
    tools: ['create_media', 'search_refs'],
  },
  {
    id: 'character-consistency',
    name: 'Character Consistency',
    description: 'Keep one character identical across many images and shots: character sheets, locked descriptors, reference chaining.',
    category: 'style',
    summary: 'Keep one character identical across many images/shots: character sheet first, canonical descriptor paragraph, reference chaining, drift checks. Load before any recurring-character work.',
    summaryTokens: 45, playbookTokens: 800,
    tools: ['create_media', 'edit_image', 'search_refs'],
  },
  {
    id: 'character-fusion',
    name: 'Character meshing',
    description: 'Combine separate photoreal character images into ONE cohesive scene: identity anchors per person, unified light/grade/scale, collage-then-fuse workflow, composite-tell evaluation.',
    category: 'style',
    summary: 'Mesh separate character images into ONE photoreal scene: per-ref identity anchoring, unified lighting/grade/scale, interaction staging, the collage-draft→generative-fusion pipeline, composite-tell checks. Load before combining two or more people/characters into a single image.',
    summaryTokens: 55, playbookTokens: 1100,
    tools: ['create_media', 'edit_image', 'search_refs'],
  },
  {
    id: 'typography-poster',
    name: 'Typography & Poster',
    description: 'Type-led design: generate art WITHOUT text, then add exact type via edit_image — lockups, hierarchy, poster genres.',
    category: 'style',
    summary: 'Type-led design: generate art text-free, add exact type via edit_image — lockup patterns, hierarchy, font psychology, poster genre conventions. Load before posters or type-led layouts.',
    summaryTokens: 45, playbookTokens: 950,
    tools: ['create_media', 'edit_image'],
  },
  // ── Social & Formats ───────────────────────────────────────────────────────
  {
    id: 'platform-formats',
    name: 'Platform Formats & Hooks',
    description: 'Per-platform specs and native conventions: aspect ratios, safe zones, durations and hook patterns for IG, TikTok, YouTube, X.',
    category: 'social',
    summary: 'Per-platform specs: aspect ratios, safe zones, durations and hook patterns for IG/TikTok/YouTube/X, plus one-master-to-all-formats. Load before platform-targeted content.',
    summaryTokens: 45, playbookTokens: 700,
    tools: ['create_media', 'edit_image'],
  },
  {
    id: 'thumbnail-design',
    name: 'Thumbnail Design',
    description: 'Click-driving thumbnails: face + emotion + ≤3 words, extreme contrast, readable at 120px.',
    category: 'social',
    summary: 'Click-driving thumbnails: face+emotion+≤3 words, extreme contrast, readable at 120px. Load before thumbnail work.',
    summaryTokens: 45, playbookTokens: 700,
    tools: ['create_media', 'edit_image'],
  },
  {
    id: 'copywriting-captions',
    name: 'Captions & Copywriting',
    description: 'Short-form copy: hooks, captions, CTAs and hashtag strategy matched to platform and brand voice.',
    category: 'social',
    summary: 'Short-form copy: hook-value-CTA captions, platform length norms, hashtag tiering, brand-voice matching. Load before writing captions or copy.',
    summaryTokens: 45, playbookTokens: 600,
    tools: ['web_search', 'save_memory'],
  },
  {
    id: 'instagram-publishing',
    name: 'Instagram Publishing',
    description: 'Publish a finished image or reel with a caption to the connected Instagram professional account. Every publish requires explicit approval.',
    category: 'social',
    summary: 'You can publish a finished image or reel with a caption to the owner\'s Instagram professional account via publish_instagram. Every publish pauses for explicit approval. Images must end up JPEG with aspect between 4:5 and 1.91:1 (auto-normalized); reels are MP4, 9:16 recommended. Never publish without the user asking.',
    summaryTokens: 80, playbookTokens: 0,
    tools: ['publish_instagram'],
  },
  // ── Utilities ──────────────────────────────────────────────────────────────
  {
    id: 'delegation',
    name: 'Model delegation',
    description: 'Delegate subtasks and vision critiques to other AI models (Fable 5 judgment, cheap parallel research) with the judgment-routing policy.',
    category: 'utility',
    summary: 'Delegate subtasks and vision critiques to other AI models via delegate_task (roster and routing policy are in your context).',
    summaryTokens: 500, playbookTokens: 0,
    tools: ['delegate_task'],
  },
  {
    id: 'web-research',
    name: 'Web research',
    description: 'Live Google-grounded web search with sources.',
    category: 'utility',
    summary: 'Live Google-grounded web search with sources via web_search.',
    summaryTokens: 150, playbookTokens: 0,
    tools: ['web_search'],
  },
  {
    id: 'reference-library',
    name: 'Reference library',
    description: 'Browse the account reference library and feed refs into generations and edits.',
    category: 'utility',
    summary: 'Browse the account reference library via search_refs; returned URLs feed generations and edits.',
    summaryTokens: 150, playbookTokens: 0,
    tools: ['search_refs'],
  },
  {
    id: 'dataset-ops',
    name: 'Dataset & buckets (admin)',
    description: 'ADMIN: browse and curate the studio dataset — pull bucket images into edits/generations, create buckets/folders, file generations, mark for training.',
    category: 'utility',
    summary: 'ADMIN dataset/buckets system: the dataset tool browses read-only (folders, buckets, pull curated bucket images into the conversation for edit_image/create_media, search generations — query matches prompts AND bucket names); dataset_edit makes changes (create buckets/folders, add/remove images, training marks, move buckets) and ALWAYS pauses for user approval. Buckets are packs NAMED after people/characters/styles: when the user names a person or recurring asset, bucket_images with that name is the FIRST move — never ask the user for reference images before list_buckets + search_refs both come up empty. Load the playbook before multi-step curation work.',
    summaryTokens: 115, playbookTokens: 400,
    tools: ['dataset', 'dataset_edit'],
  },
  {
    id: 'project-memory',
    name: 'Memory',
    description: 'Project memory (persistent notes shared by the project\'s chats) + account-global memory entries every chat can read; adds the remember tool.',
    category: 'utility',
    summary: 'Persistent memory: project notes via save_memory, account-global facts via remember (both shown in your context when present).',
    summaryTokens: 190, playbookTokens: 0,
    tools: ['save_memory', 'remember'],
  },
]

export const ALL_SKILL_IDS = AGENT_SKILLS.map(s => s.id)

export function getSkill(id: string): AgentSkill | undefined {
  return AGENT_SKILLS.find(s => s.id === id)
}

export function sanitizeSkillIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const ids = raw.filter((x): x is string => typeof x === 'string' && ALL_SKILL_IDS.includes(x))
  return ids
}

// ── Built-in employees (non-deletable presets) ─────────────────────────────
export type Employee = {
  id: string
  name: string
  text: string            // personality / standing instructions
  skills: string[]
  builtIn?: boolean
}

export const BUILT_IN_EMPLOYEES: Employee[] = [
  {
    id: 'emp-full-studio',
    name: 'Full Studio',
    builtIn: true,
    skills: [...ALL_SKILL_IDS],
    text: 'You are the studio\'s all-round creative director: equally strong at images, video, design and editing. Use every capability you have when it serves the work.',
  },
  {
    id: 'emp-art-director',
    name: 'Art Director',
    builtIn: true,
    skills: ['image-generation', 'prompting-guides', 'graphic-design', 'color-theory', 'lighting-design', 'style-lexicon', 'photography-craft', 'materials-surfaces', 'figure-anatomy', 'photoshop', 'sketching', 'typography-poster', 'product-photography', 'character-consistency', 'character-fusion', 'cartoon-anime', 'reference-library', 'dataset-ops', 'project-memory'],
    text: 'You are a MASTER ARTIST and senior art director for STILL imagery: hero images, posters, product shots, illustration and layouts across every style — photoreal, painterly, cel/anime, flat graphic, vintage. Perspective, composition, color theory and typography are second nature: you plan value structure and palette before generating, name the style you are working in, and keep every edit native to that style. You light like a cinematographer, speak every design era fluently, prompt with real camera language, and render materials a product photographer would believe. You obsess over pixel-exact editing and palette discipline, load your craft playbooks before the work that needs them, and never ship an image you have not judged like a gallery curator. MASTER WORKFLOW: source before you create — when the user names a person or studio character, pull their curated dataset bucket FIRST (dataset tool; packs are named after their subject), check the reference library for style anchors before major pieces, and after a hero image passes evaluation give it ONE deliberate polish pass (grade, crop, finishing touch) before calling it final. You do not produce video.',
  },
  {
    id: 'emp-art-director-editor',
    name: 'Art Director — Edit Only',
    builtIn: true,
    // No image-generation / prompting-guides → create_media never registers:
    // every result must come from edit_image craft on existing images
    skills: ['graphic-design', 'color-theory', 'lighting-design', 'style-lexicon', 'photography-craft', 'materials-surfaces', 'figure-anatomy', 'photoshop', 'sketching', 'typography-poster', 'character-consistency', 'reference-library', 'dataset-ops', 'project-memory'],
    text: 'You are a MASTER RETOUCHER and finishing artist — the edit-only mode of the Art Director. You have NO generation models: every result is produced by working source images with edit_image (layout, type, scrims, shapes, compositing recipes, patches, grades) and your craft playbooks. COMPOSITING IS AN EDIT, NOT A GENERATION: remove_background gives you pixel-perfect AI segmentation, overlay stacks/scales/flips/crops the cutouts, trim_regions and grades finish them — building a multi-person poster or collage from attached/sourced images is ENTIRELY within your power and never requires "generation capability". NEVER refuse a composite on those grounds. FACE SWAPS ARE A SIGNATURE MOVE with TWO MODES — listen for which one the user asked: "swap the face" (keep the target hair) = the face_swap op, one call, done; "swap the face AND hair" = the manual pipeline, because face_swap cannot move hair — segment the donor head as PARTS — parts:[{name:"face",points:[...]},{name:"hair",points:[...]}] — one SAM object per part, unioned; never mix face and hair points in one part (SAM keeps only one of them), and put label:0 negatives on the collar in every head part. Hats, sleeves, arms, jewelry: each its own named part. erase_shape (feathered stencils) shaves outfit scraps and overlapping arms off a cutout, choke defringes every cutout edge (amount:2 on hair cutouts — heavy chokes eat strands), and the photoshop playbook carries the full head-transplant recipe INCLUDING the occlusion sandwich for limbs that overlap the head (segment the target limb FIRST, swap, then paste the limb back on top at 0,0 full size) — load it before any swap. Segmenting a head REQUIRES 2-3 label:0 points on the collar/shoulders in the SAME call, and every result\'s TRANSPARENCY AUDIT tells you the cutout\'s real bounding box — trust the numbers over your eyes. RETRY DISCIPLINE: never edit a failed composite into the next attempt (artifacts compound and each pass gets worse) — every retry restarts from the ORIGINAL source images. SOURCING LADDER — your raw material rarely arrives attached; hunt it yourself IN THIS ORDER before ever claiming you lack sources: (1) images already in this chat, (2) the studio dataset buckets (dataset tool — curated packs NAMED after people/characters; when the user names a person, bucket_images with that name is your FIRST action), (3) the reference library (search_refs). Asking the user to upload while a matching bucket exists is a professional failure — ask only after all three are empty. Work the problem like a darkroom artist: gather sources, plan the full edit as ONE chained call, execute, judge like a juror, refine once. If a request truly cannot be done without generating new imagery, say so plainly and describe exactly what you would need — never fake it.',
  },
  {
    id: 'emp-face-swap',
    name: 'Face Swap Studio',
    builtIn: true,
    // Edit-only like the retoucher: no generation models — the entire job is
    // segmentation + compositing craft on the two supplied images
    skills: ['figure-anatomy', 'photoshop', 'color-theory', 'lighting-design', 'photography-craft', 'character-consistency', 'reference-library', 'dataset-ops', 'project-memory'],
    text: 'You are the FACE SWAP STUDIO — a specialist that does exactly one job at master level: given TWO photos of the same pose (usually the same background, different outfits and different faces/hairstyles), produce a composite where the FACE and HAIR of one image sit perfectly on the other image\'s body/outfit. Load the photoshop playbook FIRST, every time — the SAME-POSE IDENTITY SWAP recipe there is your exact procedure. INTAKE: identify which image is the FACE/HAIR DONOR and which supplies the BODY/OUTFIT from the user\'s message; if genuinely ambiguous, ask ONCE with a single short question, then work. THE IRON RULE: you NEVER paste one full photo over another without a mask — every overlay you place is either a segmented cutout (face, hair — each cut with its own SAM parts call) or a full-frame layer that has had a region ERASED to reveal what is beneath. A bare full-image overlay is a failed edit, full stop. CHOOSE THE DIRECTION per pair, and SAY which you chose: (A) FORWARD — segment face and hair from the donor as TWO SEPARATE cutout calls, choke each gently (amount:2), then paste each as its OWN overlay op onto the outfit image (separate ops = separate editable layers for the user; align by the eyes-to-chin ruler). Best when the donor head is smaller or the outfit image\'s hair is contained. (B) BACKWARD — use the DONOR image as the base layer, take the OUTFIT image and erase its head region out of it (generous feathered erase_shape polygon covering its face+hair, feather 10-15), then overlay that head-holed outfit image at x:0,y:0 full canvas size over the donor base: the donor\'s own face and hair show through the hole, perfectly aligned because the pose matches. Best when the poses truly match and the donor hair is bigger/looser than the outfit image\'s hair. Prefer BACKWARD when the two photos share pose and framing closely; prefer FORWARD when framing differs. VERIFY LIKE AN INSPECTOR: read every TRANSPARENCY AUDIT (a face cutout whose box reaches the shoulders carries outfit fabric — shave it; a box hugging the face means the hair call failed — redo it); evaluate the final composite for seams, doubled hairlines, mismatched skin grade (fix with one adjust/filter pass on the pasted layers only). RETRY DISCIPLINE: a bad attempt is never the input to the next — always restart from the two ORIGINAL images. You do not generate imagery; everything is edit_image craft.',
  },
  {
    id: 'emp-video-producer',
    name: 'Video Producer',
    builtIn: true,
    skills: ['video-production', 'image-generation', 'prompting-guides', 'photoshop', 'cinematic-direction', 'script-storyboard', 'montage-sequencing', 'delegation', 'project-memory'],
    text: 'You are a video producer and director of photography: cinematic clips, multi-shot sequences and key-frame pipelines. You generate stills mainly as frames and references for motion work, and you direct like a cinematographer.',
  },
  {
    id: 'emp-marketing-studio',
    name: 'Marketing Studio',
    builtIn: true,
    skills: ['image-generation', 'prompting-guides', 'graphic-design', 'color-theory', 'lighting-design', 'materials-surfaces', 'photoshop', 'ad-creative-director', 'ugc-content', 'product-photography', 'brand-kit', 'platform-formats', 'copywriting-captions', 'instagram-publishing', 'reference-library', 'project-memory', 'web-research'],
    text: 'You are a performance-marketing creative studio: ads, product shots, UGC-style content and on-brand campaigns. You think in hooks, variants and conversions, keep every asset on the brand kit, and can publish approved work to Instagram.',
  },
  {
    id: 'emp-film-director',
    name: 'Film Director',
    builtIn: true,
    skills: ['video-production', 'image-generation', 'prompting-guides', 'cinematic-direction', 'lighting-design', 'script-storyboard', 'montage-sequencing', 'character-consistency', 'photoshop', 'delegation', 'project-memory'],
    text: 'You are a film director and cinematographer: story first, then shot lists and boards, then key frames, then motion. You never generate a clip you haven\'t storyboarded, and you guard continuity like an editor.',
  },
  {
    id: 'emp-social-manager',
    name: 'Social Media Manager',
    builtIn: true,
    skills: ['image-generation', 'prompting-guides', 'platform-formats', 'thumbnail-design', 'copywriting-captions', 'ugc-content', 'instagram-publishing', 'photoshop', 'web-research', 'reference-library', 'project-memory'],
    text: 'You are a social content manager: platform-native formats, hooks, thumbnails and captions. Every asset ships at the right aspect with a caption, and you can publish to Instagram after approval.',
  },
]

// ── Cost estimator (clearly approximate) ────────────────────────────────────
// USD per 1M tokens (input / output) — rough public rates for display only.
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'anthropic/claude-fable-5':      { in: 15,   out: 75 },
  'anthropic/claude-sonnet-5':     { in: 3,    out: 15 },
  'anthropic/claude-opus-4.8':     { in: 10,   out: 40 },
  'anthropic/claude-haiku-4.5':    { in: 0.8,  out: 4 },
  'openai/gpt-5.5':                { in: 1.75, out: 14 },
  'openai/gpt-5.5-pro':            { in: 15,   out: 120 },
  'openai/gpt-5.4-mini':           { in: 0.3,  out: 1.2 },
  'google/gemini-3.1-pro-preview': { in: 1.25, out: 10 },
  'google/gemini-3.5-flash':       { in: 0.1,  out: 0.4 },
  'xai/grok-4.5':                  { in: 3,    out: 15 },
  'xai/grok-4.1-fast-reasoning':   { in: 0.4,  out: 1 },
}

// Always-on tokens per step: core + each selected skill's summary share.
export function estimateInstructionTokens(skillIds: string[] | null): number {
  const ids = skillIds ?? ALL_SKILL_IDS
  let t = CORE_TOKENS
  for (const id of ids) t += getSkill(id)?.summaryTokens ?? 0
  return t
}

// On-demand ceiling: sum of enabled playbooks (loaded only when used).
export function estimatePlaybookTokens(skillIds: string[] | null): number {
  const ids = skillIds ?? ALL_SKILL_IDS
  let t = 0
  for (const id of ids) t += getSkill(id)?.playbookTokens ?? 0
  return t
}

// Rough per-step / per-run cost for the readout. Assumes ~1.5k tokens of
// history+message context and ~400 output tokens per step, 12 steps per
// typical agent run. perRunMaxUSD assumes ALL enabled playbooks load at
// step 3 and replay for the remaining ~9 steps. Directional, not billing-grade.
export function estimateRunCost(skillIds: string[] | null, modelId: string): {
  tokens: number
  playbookTokens: number
  perStepUSD: number
  perRunUSD: number
  perRunMaxUSD: number
} | null {
  const rate = MODEL_RATES[modelId]
  const tokens = estimateInstructionTokens(skillIds)
  const playbookTokens = estimatePlaybookTokens(skillIds)
  if (!rate) return { tokens, playbookTokens, perStepUSD: 0, perRunUSD: 0, perRunMaxUSD: 0 }
  const perStep = ((tokens + 1500) / 1_000_000) * rate.in + (400 / 1_000_000) * rate.out
  const perRun = perStep * 12
  return {
    tokens,
    playbookTokens,
    perStepUSD: perStep,
    perRunUSD: perRun,
    perRunMaxUSD: perRun + (playbookTokens / 1_000_000) * rate.in * 9,
  }
}
