/**
 * Checking the plan against what the run actually did.
 *
 * propose_plan gives a list of sentences ("Render 6 master plates with Nano
 * Banana Pro", "Shot 4 — Kling 3.0, 5s"). The run gives queue ids and step
 * records. Nothing links the two, so the only honest way to show progress is
 * to bucket both sides by KIND and consume them in order: the first video
 * step takes the first shots submitted, the first image step takes the first
 * plates, and so on.
 *
 * That is an inference, not a join, and it is wrong if the employee renders
 * out of the order it wrote — but it is the comparison the plan is for: a
 * step still sitting on "pending" while later ones are green is exactly the
 * inconsistency worth seeing.
 */

export type PlanKind = "image" | "video" | "audio" | "assemble" | "board" | "check" | "other"
export type GenState = "running" | "done" | "failed"
export type RowState = "pending" | "running" | "done" | "failed" | "partial"

export type Gen = { id: string; state: GenState }

export type PlanRow = {
  text: string
  kind: PlanKind
  /** how many generations the sentence says it will make (0 = not a generation) */
  planned: number
  actual: Gen[]
  done: number
  failed: number
  state: RowState
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

/** Units that make a leading number a DURATION, not a count of things. */
const UNITS = /^(s|sec|secs|second|seconds|m|min|mins|minute|minutes|fps|k|p)$/i

const COUNT_NOUNS =
  /(shot|clip|plate|still|image|frame|video|scene|generation|render|board|angle|beat)s?\b/i

/**
 * How many things a step says it will make.
 *
 * Only a number that LEADS a plural noun counts: "6 master plates" is six
 * plates, but "Shot 3" is one shot with an index, and "5 second clips" is a
 * duration. Reading indexes as counts made a single shot claim five renders.
 */
export function countIn(text: string): number {
  // A RANGE AFTER THE NOUN, which is how a shot list is actually written:
  // "Render Shots 1-4", "Shots 5-8", "plates 2\u20136". The leading-number rule
  // below never saw these, so a step that made four shots reported 1/1 and
  // pushed the other three into "beyond the plan".
  const range = new RegExp(
    COUNT_NOUNS.source.replace(/\\b$/, '') + String.raw`\s+(\d{1,2})\s*(?:-|\u2013|\u2014|to|through|thru)\s*(\d{1,2})\b`,
    'i',
  ).exec(text)
  if (range) {
    const a = Number(range[range.length - 2])
    const b = Number(range[range.length - 1])
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return Math.min(b - a + 1, 24)
  }

  const re = new RegExp(
    // The number has to START a word, not merely follow a non-word char:
    // "16:9" was matching as the number 9, so "Render 11 4K 16:9 Production
    // Plates" counted nine plates instead of eleven.
    String.raw`(?:^|[\s(])(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b((?:\s+[\w.:,-]+){0,3}?)\s+` +
      COUNT_NOUNS.source,
    "i",
  )
  const m = re.exec(text)
  if (!m) return 1
  const between = (m[2] ?? "").trim().split(/[\s-]+/).filter(Boolean)
  // Only the word DIRECTLY after the number turns it into a measurement:
  // "5 second clips" is one clip, but "three 5 second establishing clips" is
  // three of them, and bailing on a unit found anywhere lost the second case.
  if (between.length > 0 && UNITS.test(between[0])) return 1
  const raw = m[1].toLowerCase()
  const n = WORD_NUMBERS[raw] ?? Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 1
}

export function kindOf(text: string): PlanKind {
  const t = text.toLowerCase()
  // Presenting the board is a GATE, not a generation. It reads as an image
  // step because it is full of the word "stills", which made it consume one of
  // the plates and then sit on pending forever once they ran out.
  if (/storyboard|present the board|board of stills|sign-?off/.test(t)) return "board"
  if (/assembl|stitch|final cut|cut together|edit together|concat|deliver the film/.test(t)) return "assemble"
  if (/music|score|audio|voice ?over|narrat|sound design|foley|\bvo\b/.test(t)) return "audio"
  if (/shot|clip|video|animat|motion|i2v|t2v|r2v|seedance|kling|\bwan\b|veo|sora|hailuo|minimax|first.?last/.test(t)) return "video"
  if (/plate|still|image|frame|portrait|board|upscal|nano banana|seedream|flux|imagen|topaz|generat/.test(t)) return "image"
  if (/review|check|judge|inspect|verify|evaluat|approve/.test(t)) return "check"
  return "other"
}

function settle(actual: Gen[], planned: number): RowState {
  if (actual.length === 0) return "pending"
  if (actual.some(g => g.state === "running")) return "running"
  const failed = actual.filter(g => g.state === "failed").length
  const done = actual.length - failed
  if (done === 0) return "failed"
  // Short of what it promised, or some of it broke: not a clean tick.
  if (failed > 0 || (planned > 0 && actual.length < planned)) return "partial"
  return "done"
}

/**
 * Walk the plan in order, handing each step the generations of its own kind
 * that have not been claimed yet.
 */
export function matchPlan(
  steps: string[],
  pools: Partial<Record<PlanKind, Gen[]>>,
): PlanRow[] {
  const cursor: Partial<Record<PlanKind, number>> = {}
  const rows: PlanRow[] = []

  for (const text of steps) {
    const kind = kindOf(text)
    const pool = pools[kind] ?? []
    let at = cursor[kind] ?? 0
    // Non-generative kinds are one-per-step; generative ones take what the
    // sentence claims.
    const planned = kind === "image" || kind === "video" ? countIn(text) : kind === "other" ? 0 : 1
    const take = Math.max(planned, 1)

    // A RETRY IS THE SAME STEP, NOT A NEW ONE.
    //
    // Assembling and scoring happen once per plan but often twice in practice:
    // the first attempt is refused by a guard, the second succeeds. Consuming
    // the pool strictly in order gave the step the FAILED attempt and pushed
    // the successful one into "beyond the plan" — which is how a finished film
    // sat under a red cross and a 6/7. For these one-shot kinds, skip failed
    // attempts when a later one worked: the step is judged on its outcome.
    if (take === 1 && pool.length > at) {
      const nextOk = pool.findIndex((g, i) => i >= at && g.state !== "failed")
      if (nextOk > at) at = nextOk
    }

    const actual = pool.slice(at, at + take)
    cursor[kind] = at + actual.length

    const failed = actual.filter(g => g.state === "failed").length
    rows.push({
      text,
      kind,
      planned: kind === "other" ? 0 : planned,
      actual,
      done: actual.filter(g => g.state === "done").length,
      failed,
      state: kind === "other" ? "pending" : settle(actual, planned),
    })
  }

  // Anything the run made beyond what the plan accounted for is the other half
  // of the same question, so it is reported rather than dropped.
  const extra: Partial<Record<PlanKind, number>> = {}
  for (const k of Object.keys(pools) as PlanKind[]) {
    const over = (pools[k]?.length ?? 0) - (cursor[k] ?? 0)
    if (over > 0) extra[k] = over
  }
  ;(rows as PlanRow[] & { extra?: typeof extra }).extra = extra
  return rows
}

export function extraOf(rows: PlanRow[]): Partial<Record<PlanKind, number>> {
  return (rows as PlanRow[] & { extra?: Partial<Record<PlanKind, number>> }).extra ?? {}
}
