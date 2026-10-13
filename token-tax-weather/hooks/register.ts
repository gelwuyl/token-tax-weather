import type {
  BoxProps,
  CommandSpec,
  ElementConstructor,
  EngineInterface,
  Register,
  RenderElement,
  RenderSurface,
  SettingsReadArgs,
  SettingsSource,
  TextProps,
} from 'claude-code'

// token-tax-weather — supersedes the Original Mod (cache-tax 2.1.3).
//
// Ported from the Original Mod with six deliberate changes:
//   1. the hard-coded first-party PRICES table is replaced by user-supplied rates
//   2. uncached input is its own rate, not half the cache-write rate
//   3. the guard warns only; no prompt is ever dropped
//   4. warming is never armed automatically, only by an explicit command
//   5. the status line is repainted as state changes — session start, every
//      turn, every command — instead of being written once and left to go stale
//   6. output never repeats the plugin name the host already prints

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
/**
 * The safety margin subtracted from a gap a ping survived, and the width at
 * which the search stops looking. One figure does both jobs because a bracket
 * narrower than the margin cannot say anything the margin does not already
 * cover: below it, the conservative answer and the precise one are the same
 * interval.
 */
const TUNE_MARGIN_MS = 2 * 60 * 1000

// Namespaced so the Custom Mod never inherits the Original Mod's window, ping
// period, or `always` flag — inheriting `always` would arm paid warming on its
// own at session start.
const KEY_DEADLINE = 'token-tax-weather:deadline'
const KEY_EVERY = 'token-tax-weather:every'
const KEY_GUARD = 'token-tax-weather:guard'

const rateKeys = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
type Rates = { input: number; cacheRead: number; cacheWrite: number; output: number }

// USER-SUPPLIED rates in USD per million tokens, keyed by the exact model ID the
// engine reports. Desktop does not hand its managed four rates to a plugin, so
// every cost below is only as right as this table, and is always labeled
// user-supplied. Zero is a valid rate — cacheWrite is zero here, which means a
// cold re-write is billed at nothing and break-even reports not-applicable. A
// model with no row shows an explicit unknown cost rather than borrowing
// another model's rates.
//
// These are the operator's own figures, moved between models on request. On
// 2026-10-10 the Fable row took over the numbers first given for Opus, and Opus
// took the second set. Both are stated per million tokens; if an operator quotes
// a provider's per-1K numbers instead, the whole table is 1000x out.
//
// Note on the Opus row: its cacheRead (0.005) is now below its input (0.0348),
// so reading the prompt cache costs less than sending the same context uncached.
// The cacheWrite is zero, so a cold re-write is billed at nothing and warming
// still cannot pay for itself at these rates. The card reports what the
// arithmetic says; it does not pretend the figures are typical.
//
// Add rows in this shape, then update the plugin:
//
//   'claude-opus-5-5': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
//
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0348, cacheRead: 0.005, cacheWrite: 0, output: 0.1392 },
}

const RATE_SOURCE = 'user-supplied rates'

type PingRecord = { at: number; idle: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'warn'

export type State = {
  sid: string
  deadline: number
  every: number
  /**
   * The two bounds the pings have put on the provider's cache TTL, which nothing
   * in the engine reports: `warmAt` is the longest idle gap a ping survived, a
   * proven floor, and `coldAt` the shortest one that failed, a proven ceiling.
   * Together they close on the TTL from both sides — walking down from a failure
   * alone would settle for the first gap that happened to work, so a 45m TTL
   * reached through a cold 50m would leave the window pinging at 25m forever.
   * Zero and null before any ping has answered.
   */
  warmAt: number
  coldAt: number | null
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  /**
   * What the breakdown's own rows add up to, free space, compaction buffer and
   * deferred schemas aside. Kept only to be shown beside `ctx` on the card: the
   * rows are the engine's estimates of what fills the window, and this band draws
   * the engine's `context.tokens` instead, so the two disagreeing is the fact that
   * explains a band that looks wrong next to the context popover.
   */
  rowsTokens: number
  compacted: boolean
  guard: GuardMode
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  /** Cache-read tokens of the last completed main turn: what the cache actually served. */
  lastRead: number
  /**
   * The last completed main turn's whole prompt, summed over its calls: the three
   * input fields, which are disjoint slices of one prompt. `lastRead` against this
   * is the turn's hit rate — how much of what was sent the cache carried — and it
   * is a measurement, where the read rate against the input rate is only a price.
   */
  lastPrompt: number
  /**
   * Cache-read tokens summed over every main turn since the last /clear: the
   * running total, where `lastRead` is only the turn just gone. A compaction does
   * not start a new conversation, so it survives `session.compact` the same way
   * the cold-write tally below does; only /clear resets it.
   */
  readSession: number
  /** Completed main turns since the last /clear: what `readSession` was summed over. */
  turns: number
  /**
   * Model calls the last completed main turn made, from the engine's own step
   * index. A turn makes one model call per step, and the engine numbers a turn's
   * steps from 0, so the highest index seen is one less than the count.
   *
   * This is the fact that makes `lastRead` legible: a turn's usage is its calls
   * summed, so a long agentic turn reads the context once per call and the total
   * runs to many times the context. `150.9k cache turn` beside a 157.9k context
   * reads as a miscount until the call count that produced it is on the row too.
   */
  calls: number
  /** Steps seen in the turn now running; moved into `calls` when that turn completes. */
  steps: number
  /** Output tokens generated across all steps of the last completed main turn. */
  turnOut: number
  /** Generation duration in milliseconds summed across the model calls of the last turn. */
  turnDurationMs: number
  /** Generation speed in tokens per second for the last completed turn, or null. */
  speedToksPerSec: number | null
  /** Live accumulator of step output tokens for the turn in flight. */
  accumStepsOut: number
  /** Live accumulator of step duration in milliseconds for the turn in flight. */
  accumStepsDurationMs: number
  /** True once this mod's command names are the session's, so the footer slot is ours to write. */
  owns: boolean
  /** The window the fill is measured against: the compaction window /autocompact sets, else the model's. */
  window: number
  /** The fill as a whole percentage of `window`. */
  percent: number
  /** Where that window came from (the engine's `ContextWindowSource`), or null when only the model's is known. */
  windowSource: string | null
  /**
   * Tokens the window has left, from the breakdown's `free` row. The band does not
   * draw it — it measures nearly the same thing as `compactAt` and so read as a
   * near-duplicate — but `/cache-tax` reports it, because the card is where the
   * complete set of figures belongs. Zero when the host reports no breakdown.
   */
  free: number
  /**
   * The token count auto-compaction fires at, as the engine reports it, or null
   * when it is off or unreported. Kept so `/cache-tax` can show the engine's own
   * threshold rather than a guess derived from the window.
   */
  compactAt: number | null
  /** Recent readings of the context size, oldest first: the sparkline and the per-turn trend. */
  history: number[]
  /**
   * The clock as of the last event that could change what the band says. A
   * `ui.render` hook draws synchronously and `$.clock.now()` only answers a
   * promise, so the countdown reads this rather than asking again; every event
   * that repaints stamps it first.
   */
  now: number
  /** The surface this session runs on: the band is raised on `desktop` and `terminal` only. */
  surface: string
  /**
   * The one-off line pinned on the status line ahead of the readout, or null for
   * none. It carries a cache-state notice — a cold resume, a cold send, a recorded
   * cold write — rather than the continuously-updating facts, so it is read once
   * and not scrolled back to. A second notice simply replaces the first: last
   * writer wins, which is what the status line itself does.
   */
  notice: string | null
}

/** The configured rates for a model, or null when none are configured. Exact ID only. */
export function ratesFor(model: string | null): Rates | null {
  if (!model) return null
  const row = RATES[model] ?? RATES[model.toLowerCase()]
  if (!row) return null
  const ok = rateKeys.every(k => typeof row[k] === 'number' && Number.isFinite(row[k]) && row[k] >= 0)
  return ok ? row : null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * A clock time in the host's own zone — `7:00pm`, or `Tue 7:00pm` when the moment
 * falls on a different day than `now` does.
 *
 * The status line is a value the app holds between paints, so anything in it that
 * measures forward decays the moment it is set: `6h00m left`, read forty minutes
 * later, is forty minutes wrong, and wrong in the direction that overstates what
 * is left. An absolute time says the same thing at every reading. It is the one
 * form that survives being held, which is why the row uses it and the `/cache-tax`
 * card — a printout read as it is written — keeps its durations.
 *
 * Null when the host cannot format a clock, which leaves the caller its duration.
 */
export function fmtClock(ms: number, now: number): string | null {
  try {
    const at = new Date(ms)
    const h = at.getHours()
    const m = at.getMinutes()
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    const clock = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
    const from = new Date(now)
    const sameDay = at.getFullYear() === from.getFullYear()
      && at.getMonth() === from.getMonth()
      && at.getDate() === from.getDate()
    return sameDay ? clock : `${DAYS[at.getDay()]} ${clock}`
  } catch {
    return null
  }
}

function fmtUsd(usd: number | null): string {
  if (usd == null) return 'n/a'
  // Sub-cent figures are normal at these rates; two decimals would read as $0.00.
  if (usd > 0 && usd < 0.01) return '$' + usd.toFixed(4)
  return '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

/**
 * A signed difference. A surcharge carries a leading `+`; a saving is wrapped in
 * parentheses — accounting's own mark for a credit, which reads as a saving
 * without a minus sign that could be mistaken for a hyphen mid-line. Zero is
 * `+$0.00`, a real answer rather than an unknown. `n/a` is the unknown: this mod
 * has no rates for the model, so it computes no figure at all.
 */
export function fmtSignedUsd(usd: number | null): string {
  if (usd == null) return 'n/a'
  return usd < 0 ? `(${fmtUsd(-usd)})` : `+${fmtUsd(usd)}`
}

/**
 * Rounding to whole thousands hid the difference the line exists to show: a 300k
 * context served from a 299k cache and a 300k one served from 141k read the same.
 * One decimal for the thousands and millions keeps the two figures apart, and the
 * trailing `.0` is dropped so an exact thousand still reads as a round number.
 */
function fmtTok(n: number): string {
  if (n >= 1e6) return trimZero((n / 1e6).toFixed(1)) + 'M'
  if (n >= 1000) return trimZero((n / 1000).toFixed(1)) + 'k'
  return String(n)
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** ctx × the cache-write rate: what re-writing the context after expiry is billed. */
function coldUsd(s: State): number | null {
  const r = ratesFor(s.lastModel)
  return r ? s.ctx * r.cacheWrite / 1e6 : null
}

/** ctx × the cache-read rate: what a turn whose context is served from cache costs. */
function warmUsd(s: State): number | null {
  const r = ratesFor(s.lastModel)
  return r ? s.ctx * r.cacheRead / 1e6 : null
}

/** ctx × the uncached input rate: what the same context costs with no cache reuse at all. */
function uncachedUsd(s: State): number | null {
  const r = ratesFor(s.lastModel)
  return r ? s.ctx * r.input / 1e6 : null
}

/** One hypothetical context read, not the turn's summed bill or the cache's current warmth. */
function cacheEffectUsd(s: State): number | null {
  const uncached = uncachedUsd(s)
  const warm = warmUsd(s)
  return uncached == null || warm == null ? null : warm - uncached
}

/**
 * The share of the last turn's prompt tokens the cache served — a measurement of
 * what happened, where the read rate against the input rate is only a price.
 *
 * A share that is real but not quite whole reads `99%` rather than `100%`, because
 * rounding a hit rate up to whole would claim the cache carried a prompt it did
 * not. It is the mirror of the `<1%` the cost share already uses, and it is why
 * the ceiling here is 99 and not the nearest integer.
 */
export function hitPct(read: number, prompt: number): string {
  if (prompt <= 0) return ''
  const pct = (read / prompt) * 100
  return `${pct >= 100 ? 100 : Math.min(99, Math.round(pct))}%`
}

/**
 * The share a cached read saves against the same context sent uncached.
 *
 * Unlike the hit rate this is a *rate*, not a measurement, and it is worth being
 * plain about why: both prices are `context × rate / 1e6`, so the context appears
 * on both sides of the division and cancels. What is left is the two rates, the
 * same figure for every context size and every turn with a given model — only the
 * money it is worth moves with the context. Null where no rates are configured,
 * and zero or less when a read costs as much as uncached input or more.
 */
export function savedPct(warm: number | null, uncached: number | null): number | null {
  if (warm == null || uncached == null || uncached <= 0) return null
  return Math.round((1 - warm / uncached) * 100)
}

/**
 * A cost as a share of the uncached price, bare — the form the status line has
 * room for. A non-zero share that rounds away is `<1%` rather than `0%`, which
 * is the difference between a figure that is nothing and one that is merely
 * small. Empty when either end is unknown, or when the baseline is zero and a
 * share would be a division by it.
 */
export function fmtSharePct(usd: number | null, base: number | null): string {
  if (usd == null || base == null || base <= 0) return ''
  const pct = (usd / base) * 100
  return pct <= 0 ? '0%' : pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

/** The same share as a clause, for the card, which has room to say what of. */
export function fmtShare(usd: number | null, base: number | null): string {
  const pct = fmtSharePct(usd, base)
  return pct ? ` = ${pct} of that` : ''
}

/**
 * The status line's cost slot, in the two shares that read fastest: how much of
 * the last turn's prompt the cache carried, and how much a carried token saves.
 *
 * It used to name the two prices, `$0.0047 of $0.07`, with the first as a share of
 * the second. That share was the *cost* ratio, and it was the wrong figure to sit
 * in a live row: both prices are `context × rate`, so the context cancels out of
 * their ratio, and what remained was the model's two rates — always 7% for one
 * model, always 14% for another, whatever the session was doing. A reading that
 * cannot move is not a reading. Both replacements do move, and both read higher
 * as cheaper, which the cost ratio did not.
 *
 * The prices themselves are not lost: `/cache-tax` prints all three, each against
 * the uncached baseline, where there is room to say what a sign means.
 */
/** Formats generation speed in tokens per second, or empty string if not measured. */
export function fmtSpeed(speed: number | null): string {
  if (speed == null || speed <= 0 || !Number.isFinite(speed)) return ''
  return `${speed >= 10 ? Math.round(speed) : speed.toFixed(1)} tok/s`
}

/** Formats the turn's cache telemetry: calls / tokens cache / hit%. */
function turnCacheText(s: State): string {
  const hit = hitPct(s.lastRead, s.lastPrompt)
  return `${callCountText(s)} / ${fmtTok(s.lastRead)} cache / ${hit || '0%'}`
}

/**
 * The status line's cost slot: total tokens saved this session (since /clear),
 * and the rate discount for the model.
 *
 * Moving session tokens here from the band keeps the band focused on the turn
 * that just completed (calls / tokens cache / hit% · speed), while the status
 * line anchors the persistent session facts (state, timer, session tokens,
 * and rate discount).
 */
export function costSlotText(sessionTokens: number, saved: number | null, effect: number | null): string {
  // No rates for the model: nothing computable, so the unknown keeps its own form.
  if (saved == null) return fmtSignedUsd(effect)
  // A read that costs as much as uncached input, or more, is not a saving, and
  // `0% saved` would have to mean both "no discount" and "a surcharge". The signed
  // money carries that distinction instead, as it always has.
  if (saved <= 0) return fmtSignedUsd(effect)
  return `${fmtTok(sessionTokens)} session, ${saved}% saved`
}

function effectSlot(s: State): string {
  return costSlotText(s.readSession, savedPct(warmUsd(s), uncachedUsd(s)), cacheEffectUsd(s))
}

/** Everything a fork bills: the cache read, any cache write, uncached input at its own rate, and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, r: Rates): number {
  return (u.cache_read_input_tokens * r.cacheRead + u.cache_creation_input_tokens * r.cacheWrite + u.input_tokens * r.input + u.output_tokens * r.output) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const r = ratesFor(s.lastModel)
  if (!r || s.ctx <= 0 || r.cacheRead <= 0) return null
  return Math.floor(r.cacheWrite / r.cacheRead)
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

// One line, because the status line is one line in a slot the app fixes the
// width of. What fits is how long the cache has been gone and what sending
// anyway costs; the rates behind that figure, and what a warm turn would have
// cost instead, are in /cache-tax, which has room for them.
function guardText(s: State, now: number): string {
  return `cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} · re-write ≈${fmtUsd(coldUsd(s))}`
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.rowsTokens = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.coldWritePending = false
  s.misses = []
  s.lastRead = 0
  s.lastPrompt = 0
  s.readSession = 0
  s.turns = 0
  s.calls = 0
  s.steps = 0
  s.turnOut = 0
  s.turnDurationMs = 0
  s.speedToksPerSec = null
  s.accumStepsOut = 0
  s.accumStepsDurationMs = 0
  s.percent = 0
  s.free = 0
  s.compactAt = null
  s.history = []
  s.notice = null
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  // Same one-line budget as the guard. The advice that used to ride along here
  // -- /clear and paste a summary if you only need the conclusions -- is in the
  // /cache-tax card, which is where there is room to read it.
  return usd === 'n/a'
    ? 'cold resume · the next message re-writes the context'
    : `cold resume · first message ≈${usd}`
}

/** The card's warming slot: off, a countdown, or why it stopped. */
function warmingText(s: State, now: number): string {
  if (s.stopped) return `stopped: ${s.stopped}`
  if (!s.deadline) return 'off'
  return `${fmtDuration(s.deadline - now)} left`
}

/**
 * The same slot as the row writes it: when the armed window ends, as a clock
 * time. Falls back to the countdown where the host cannot format one, and to
 * nothing at all while no window is armed.
 */
function endsText(s: State, now: number): string | null {
  if (!s.deadline) return null
  const clock = fmtClock(s.deadline, now)
  return clock ? `ends ${clock}` : `${fmtDuration(s.deadline - now)} left`
}

/**
 * What the last ping proved about the provider's expiry clock, in the ping slot
 * it came from: a warm ping after a gap means the clock outlasts that gap, a
 * cold one means it does not. Either is worth saying, because either moved the
 * interval the window will use next.
 */
function heldText(s: State): string {
  if (!s.last) return ''
  return s.last.warm ? ` (held ${fmtDuration(s.last.idle)})` : ` (went at ${fmtDuration(s.last.idle)})`
}

/**
 * The interval to ping at next, from the bounds the pings have bracketed. The
 * midpoint of a bracket is the fastest way to close it, and a bracket already
 * down to the margin settles at the largest gap proven to work, less the margin.
 *
 * With no ceiling yet — the first ping came back warm — there is nothing to
 * search between, so the configured interval stands: it is proven, and the user
 * picked it as the long end.
 */
function retune(s: State): number {
  const lo = s.warmAt
  const hi = s.coldAt
  if (hi == null) return Math.max(MIN_PING_MS, lo || s.every)
  if (hi - lo <= TUNE_MARGIN_MS) return Math.max(MIN_PING_MS, lo - TUNE_MARGIN_MS)
  return Math.max(MIN_PING_MS, Math.floor((lo + hi) / 2))
}

/** When the next ping can come, or null while nothing is armed. */
function nextPingText(s: State, now: number): string | null {
  if (!s.deadline) return null
  if (!s.lastRequestAt) return 'ping after first turn'
  if (isCold(s, now)) return 'ping after next turn'
  const at = s.lastRequestAt + s.every
  const clock = fmtClock(at, now)
  return `${clock ? `ping at ${clock}` : `ping in ${fmtDuration(at - now)}`}${heldText(s)}`
}

// The under-composer line, in one fixed field order so the same fact always
// appears in the same place — times first, then token counts, then money:
//
//   <warming> · [ping] · <context> · [cache] · [±]
//
// warming  off | ends <clock> | stopped: <why>
// ping     present only while a window is armed
// context  no context yet | ctx <tokens> — what the cache could be holding
// cache    absent until a turn reports a cache read: how much it read this turn
// final    absent until a context exists: what the cache does to the bill for
//          this context, bare and signed. `-` is a saving — the read rate is
//          below the input rate, so being warm lowers the bill by that much (the
//          usual case); `+` is a surcharge — the read rate is above the input
//          rate, so the cache costs more than it saves. `n/a` while this mod has
//          no rates for the model in use, so a figure it cannot compute is never
//          shown as zero. The sign is left to carry the meaning on its own; the
//          wording that would explain it is what the card is for.
//
// The model itself is left out: the picker beside this line already names it, and
// `/cache-tax` prints the exact ID the rates are keyed on. That model comes from
// the last turn's own usage and never from a session lookup — at session start
// the host may not yet have chosen one, and a footer must not be left waiting.
function statusText(s: State, now: number): string {
  const parts = [s.stopped ? `stopped: ${s.stopped}` : (endsText(s, now) ?? 'off')]
  const ping = nextPingText(s, now)
  if (ping) parts.push(ping)
  parts.push(s.ctx > 0 ? `ctx ${fmtTok(s.ctx)}` : 'no context yet')
  // The same reading the band carries: calls / tokens cache / hit%
  if (s.calls > 0) parts.push(turnCacheText(s))
  const speed = fmtSpeed(s.speedToksPerSec)
  if (speed) parts.push(speed)
  if (s.ctx > 0) parts.push(effectSlot(s))
  return parts.join(' · ')
}

// Desktop clips long status strings and reveals their full text on hover.
function hintsFor(s: State): string[] {
  const hints: string[] = []
  if (!s.deadline) hints.push('/keepwarm to arm the window')
  hints.push('/cache-tax for the full card')
  return hints
}

// $.ui.status accepts plain text, so the effect is distinguished by sign, not colour.
// The state word drops the `keepwarm` prefix, as the other form's already does:
// the row is one line in a fixed slot, and the command it names is on the same
// line as a hint anyway.
function hintText(s: State, now: number): string {
  const parts = [s.stopped ? `stopped: ${s.stopped}` : s.deadline ? 'on' : 'off']
  const ends = endsText(s, now)
  if (ends) parts.push(ends)
  const ping = nextPingText(s, now)
  if (ping) parts.push(ping)
  if (s.ctx > 0) parts.push(effectSlot(s))
  return [...parts, ...hintsFor(s)].join(' · ')
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// --- The AbovePrompt band ----------------------------------------------------
// Only one plugin can draw AbovePrompt: returning a tree stops the hook chain.

/** Readings the sparkline shows, oldest first. */
const HISTORY = 12
const SPARK = '▁▂▃▄▅▆▇█'

/**
 * The forecast, by share of the window used. The colours are literal rather than
 * theme keys on purpose: this is a ramp the person reads as a ramp, and it stays
 * the same ramp whatever the theme does to `warning` or `error`.
 */
const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
]

function forecastFor(percent: number) {
  return FORECAST.find(f => percent < f.upTo) ?? FORECAST[FORECAST.length - 1]!
}

/**
 * One bar per reading, its height the share of the window it filled — not the
 * share of the busiest reading shown, which is what token-weather scales by and
 * which makes the same bar mean a different number of tokens in every window.
 * Scaling to the window keeps a bar comparable with the percentage beside it.
 */
function sparkline(history: number[], window: number): string {
  if (!window || !history.length) return ''
  return history
    .map(t => {
      const level = Math.floor((t / window) * (SPARK.length - 1))
      return SPARK[Math.min(SPARK.length - 1, Math.max(0, level))]!
    })
    .join('')
}

/**
 * How much the context moved on the last turn, or null while there is no turn to
 * compare. The arrow carries the direction and the slot's position carries the
 * "since the reading before it", so the words are left out: the band is a row of
 * figures, and every other slot names its own unit rather than its tense.
 */
/**
 * The model calls the last turn made, in the band's own words. This is the
 * denominator the cache figure beside it has always lacked: `150.9k cache turn`
 * against a 157.9k context looks like a miscount until the ~42 calls that read
 * that context are on the row with it.
 */
function callCountText(s: State): string {
  return `${s.calls} call${s.calls === 1 ? '' : 's'}`
}

function trendText(history: number[]): string | null {
  if (history.length < 2) return null
  const delta = history[history.length - 1]! - history[history.length - 2]!
  if (delta === 0) return 'steady'
  return `${delta > 0 ? '▲ +' : '▼ '}${fmtTok(Math.abs(delta))}`
}

/**
 * The window the fill is measured against, and the fill itself. `rawMaxTokens` is
 * what /autocompact actually fires against — the model's limit, or the smaller
 * compaction window when a setting names one — so it is the honest denominator;
 * `context.window` is only the model's and would understate the fill whenever
 * autocompact has set something smaller, which is the case that matters.
 *
 * `breakdown: 'summary'` estimates locally and sends no request. `full` would
 * send one count request per tool and per memory file, which the standing
 * local-only constraint rules out.
 */
async function refreshWindow($: EngineInterface, s: State) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const context = usage.context
    const breakdown = context.breakdown
    if (breakdown && breakdown.rawMaxTokens > 0) {
      s.window = breakdown.rawMaxTokens
      s.windowSource = breakdown.autocompactSource
      const free = breakdown.categories.find(c => c.kind === 'free' || c.name === 'Free space')
      s.free = free && free.tokens > 0 ? free.tokens : 0
      s.compactAt = typeof breakdown.autoCompactThreshold === 'number' ? breakdown.autoCompactThreshold : null

      // What the rows add up to, kept only for the card: the row total is an
      // estimate, so it is never the fill this band draws.
      const rows = breakdown.categories.filter(c =>
        c.kind !== 'free' && c.kind !== 'buffer' && c.kind !== 'deferred' &&
        !c.isDeferred && c.name !== 'Free space' && c.name !== 'Autocompact buffer')
      s.rowsTokens = rows.length > 0 ? rows.reduce((sum, c) => sum + (c.tokens > 0 ? c.tokens : 0), 0) : 0
      // The fill is the engine's own figure wherever it reports one. `context.tokens`
      // is the last response's whole input — uncached, cache-read and cache-written
      // together — so it is the prompt the model actually answered over, and it is
      // the same number the engine's own context popover shows. The breakdown's rows
      // are estimates meant to explain that figure, not to replace it: summing them
      // drifts from it whenever a row is deferred, unlisted or unaccounted, which is
      // exactly what put this band at odds with the popover.
      const live = typeof context.tokens === 'number' && context.tokens > 0 ? context.tokens : null
      if (live != null) {
        s.ctx = live
        // Both figures are read against the window this band reports, so the fill and
        // the distance to autocompact below share one denominator.
        s.percent = Math.round((live / s.window) * 100)
      } else if (typeof breakdown.totalTokens === 'number' && breakdown.totalTokens > 0) {
        s.ctx = breakdown.totalTokens
        s.percent = Math.round(breakdown.percentage)
      } else if (breakdown.percentage > 0) {
        s.ctx = Math.round(s.window * (breakdown.percentage / 100))
        s.percent = Math.round(breakdown.percentage)
      }
      return
    }
    if (context.window > 0) {
      s.window = context.window
      if (typeof context.tokens === 'number' && context.tokens > 0) {
        s.ctx = context.tokens
      }
      s.percent = Math.round(context.percent ?? (s.ctx / context.window) * 100)
      s.windowSource = null
    }
    // No breakdown means no free row and no threshold; a stale pair is worse than
    // an absent one, so both are cleared rather than kept.
    s.free = 0
    s.compactAt = null
  } catch {
    // No session bound, or a host that answers no breakdown: keep the last reading.
  }
}

/**
 * Width is the band's own box, not the viewport; a docked pane reduces it.
 * Only the sparkline and trend are dropped for width, never the token counts.
 *
 * The order is the window first and the history second: the forecast and the fill
 * it measures, then the room still free and the distance to the point
 * /autocompact fires, then the readings that say how the fill got here (the
 * sparkline and the trend) and what the cache served along the way. The two
 * window figures sit together because they answer one question between them —
 * how much room is left — and the two history slots follow because they are
 * derived from the readings rather than being measurements of this moment.
 */
function band(
  Box: ElementConstructor<BoxProps>,
  Text: ElementConstructor<TextProps>,
  props: { bodyColumns: number },
  s: State,
) {
  const columns = props.bodyColumns || 80
  const f = forecastFor(s.percent)
  // The table's constructors take children among the props and hand back an
  // element with them beside `props`, which is the shape the engine draws.
  const t = (textProps: TextProps, text: string) => Text({ ...textProps, children: text })
  const dim = (text: string) => t({ dimColor: true }, text)
  const parts: RenderElement[] = [
    t({ color: f.color, bold: true }, `${f.icon}  ${f.word}`),
    t({ color: f.color }, `  ${fmtTok(s.ctx)} / ${fmtTok(s.window)} (${s.percent}%)`),
  ]
  // The sparkline sits with the fill it continues: the same figure drawn, in the
  // same colour, so the row leads with its two coloured slots before the dim ones.
  const spark = columns >= 56 ? sparkline(s.history, s.window) : ''
  if (spark) parts.push(dim('  ·  '), t({ color: f.color }, spark))
  const trend = columns >= 72 ? trendText(s.history) : null
  if (trend) parts.push(dim(`  ·  ${trend}`))
  // The distance to the point /autocompact actually fires. This is the window
  // figure worth acting on: the free space the breakdown also reports measures
  // nearly the same thing and reads as a near-duplicate beside it, so only this
  // one is drawn. Absent until a context exists — with nothing in use the figure
  // would only restate the threshold.
  //
  // It follows the history rather than the fill because it is the one slot whose
  // meaning changes as it shrinks: roomy is a fact, nearly gone is a call to act.
  // So it is dim while there is room and takes the forecast's own alarm colour
  // once the window reaches the red step — the same moment the forecast turns,
  // rather than a token count of its own, which would only suit one window size.
  if (s.compactAt != null && s.ctx > 0) {
    const toGo = s.compactAt - s.ctx
    // The share is of the window, like the fill's, so both read against one
    // denominator even though only the fill is a complement of it.
    const share = s.window > 0 ? ` (${((toGo / s.window) * 100).toFixed(1)}%)` : ''
    const text = toGo > 0 ? `${fmtTok(toGo)} to go${share}` : 'compact due'
    parts.push(f.color === 'red' ? t({ color: 'red' }, `  ·  ${text}`) : dim(`  ·  ${text}`))
  }
  // The turn's cache telemetry: calls made / tokens served / percentage cached.
  if (s.calls > 0) parts.push(dim(`  ·  ${turnCacheText(s)}`))
  const speed = fmtSpeed(s.speedToksPerSec)
  if (speed) parts.push(dim(`  ·  ${speed}`))
  return Box({ flexDirection: 'row', paddingX: 1, children: parts })
}

// Status text is shared across connected surfaces. Use the fallback only when
// none supports the band; a notice temporarily replaces either status form.
//
// Which surface this is cannot be read from the one captured at session start: a
// desktop client can attach a moment after that event, when `e.surface` was still
// null and the captured value became `''`, and the band it raises is up now. So
// the decision is made from the live roster each time the line is painted.
const BAND_SURFACES = new Set(['desktop', 'terminal'])

/**
 * The surfaces the session draws on right now, so the band's reach is read fresh
 * rather than from the one frozen at session start: a client can attach after
 * that, when `e.surface` was still null. Null means the ask failed; the engine's
 * `surfaces()` is documented never to reject, but a host that answers nothing is
 * told apart from an empty roster so a caller can fall back rather than mistake
 * silence for "nothing draws".
 */
async function liveSurfaces($: EngineInterface): Promise<readonly RenderSurface[] | null> {
  try {
    return await $.session.surfaces()
  } catch {
    return null
  }
}

// The one place that writes the status line, so a notice and the readout never
// race each other for it. Painted only while this mod owns the session's command
// names — the slot holds one entry per plugin. A live notice outranks everything
// and shows on every surface, the band's included: it is a one-off thing to read
// now, not the facts the band keeps current, so it is worth saying even where the
// band is up.
async function publish($: EngineInterface, s: State) {
  s.now = await $.clock.now()
  if (!s.owns) return
  if (s.notice) {
    $.ui.status(s.notice)
    return
  }
  // A client can attach after session.start, so ask the live roster on every paint.
  const live = await liveSurfaces($)
  const raised = live ? live.some(surface => BAND_SURFACES.has(surface)) : BAND_SURFACES.has(s.surface)
  $.ui.status(raised ? hintText(s, s.now) : statusText(s, s.now))
  try {
    $.ui.invalidate('ui.render')
  } catch {}
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The guard mode stays global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window. Other sessions' keys are never touched. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(everyKey(s))
  }
}

async function stop($: EngineInterface, s: State, why: string | null) {
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  await publish($, s)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const delay = Math.min(s.deadline - now, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  await publish($, s)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (now - s.lastRequestAt < s.every - 1000) return
  if (isCold(s, now)) return arm($, s)
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, s, `ping failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // This build's fork never answers null: the union is an answer, or a reason.
  if (!reply) return stop($, s, 'ping not sent')
  if (!reply.isAnswered) return stop($, s, `ping not sent (${reply.reason})`)
  const u = reply.usage
  const r = ratesFor(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = r ? pingUsd(u, r) : null
  // How long the cache had been left alone before this ping. The outcome turns
  // that gap into a fact about the provider's expiry clock, which the engine does
  // not expose: a warm ping proves the clock outlasts the gap, a cold one proves
  // it does not. Either way the bound comes from a request the window was going
  // to send anyway, so learning it costs nothing extra.
  const idle = now - s.lastRequestAt
  s.last = { at: now, idle, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (warm) {
    s.warmAt = Math.max(s.warmAt, idle)
  } else if (u.cache_creation_input_tokens <= 0) {
    // Not a cold cache — no cache. The reply neither read an entry nor wrote one,
    // so this provider is not caching the prefix at all: there is no expiry to
    // search for, and leaving the window armed would ping on a clock that no
    // longer advances, once a second, for the rest of it.
    return stop($, s, `ping read 0, wrote 0 (${fmtUsd(usd)}): the provider cached nothing, so there is no expiry to tune around`)
  } else {
    s.coldAt = s.coldAt == null ? idle : Math.min(s.coldAt, idle)
    // A cache that goes cold inside the shortest interval the window allows is
    // not a short TTL to search around; the search has run out of room.
    if (s.coldAt <= MIN_PING_MS) {
      return stop($, s, `ping read ${fmtTok(u.cache_read_input_tokens)}, wrote ${fmtTok(u.cache_creation_input_tokens)} (${fmtUsd(usd)}): the cache was gone after ${fmtDuration(idle)} idle, and ${fmtDuration(MIN_PING_MS)} is the shortest interval, so there is nothing here to keep warm`)
    }
  }
  s.every = retune(s)
  await $.store.set(everyKey(s), s.every)
  // The fork re-sent the prefix, so a cold ping leaves the cache written afresh.
  s.lastRequestAt = now
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  if (every !== PING_AFTER_MS) {
    // An interval the user names replaces whatever the pings had bracketed: the
    // command is the newer word on how often to ping.
    s.warmAt = 0
    s.coldAt = null
    s.every = every
  } else {
    // The default defers to the bracket, so a window re-armed in the same session
    // resumes at the interval the last one learned instead of starting the search
    // over. The learned interval is written below, so it outlives the session too.
    s.every = retune(s)
  }
  if (s.every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), s.every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

/**
 * Where the window the band measures against came from, said plainly. `settings`
 * and `env` are a person's own `/autocompact` value; `model-default` is the
 * model's own limit; `unknown-model` means the engine could not settle one and
 * the percentage should be read as a guess, which is worth knowing when a
 * gateway serves a model ID the engine does not recognise.
 */
function windowNote(s: State): string {
  switch (s.windowSource) {
    case 'settings': return ', set by /autocompact'
    case 'env': return ', set by the environment'
    case 'clientdata': return ', set by the client'
    case 'experiment': return ', set by an experiment'
    case 'model-default': return ", the model's own window"
    case 'auto': return ', settled automatically'
    case 'unknown-model': return ', the model is unknown to the engine, so this is a guess'
    default: return ', no compaction window reported, so the model window is used'
  }
}

function card(s: State, now: number, surfaces: readonly RenderSurface[] | null): string {
  const lines: string[] = []
  const r = ratesFor(s.lastModel)
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens, the most the cache can be holding`)
  lines.push(`window      ${s.window ? `${fmtTok(s.window)} (${s.percent}% used)` : 'not reported yet'}${windowNote(s)}`)
  // The two readings side by side, because the band draws the first and the engine's
  // context popover draws something the second resembles: the row total is the
  // breakdown's own estimate of what fills the window, and the band uses the engine's
  // reported figure instead. Printing both is what tells a wrong-looking fill from a
  // band that is right and a row estimate that is not.
  if (s.rowsTokens > 0 && s.window > 0) {
    lines.push(`rows        ${s.rowsTokens.toLocaleString('en-US')} tokens by the breakdown's own rows ` +
      `(${((s.rowsTokens / s.window) * 100).toFixed(1)}%) — an estimate, not the fill the band draws`)
  }
  // The band leaves this one out because it tracks `compact` too closely; the card
  // is where the complete set of figures belongs.
  if (s.free > 0 && s.window > 0) {
    lines.push(`free        ${s.free.toLocaleString('en-US')} tokens left in the window (${((s.free / s.window) * 100).toFixed(1)}%)`)
  }
  if (s.compactAt != null && s.window > 0) {
    // The engine's own threshold, so the fill can be read against the point where
    // /autocompact actually fires rather than against the window.
    const left = s.compactAt - s.ctx
    lines.push(`compact     auto-compaction at ${s.compactAt.toLocaleString('en-US')} tokens ` +
      `(${Math.round((s.compactAt / s.window) * 100)}% of the window), ${left > 0 ? `${fmtTok(left)} to go` : 'already past it'}`)
  }
  // Both surfaces, so the next session can see what the start value actually was
  // against what the session draws on now — the pair that decides the status line.
  const live = surfaces == null ? 'unavailable' : surfaces.length ? surfaces.join(', ') : '(none)'
  lines.push(`surfaces    captured ${s.surface || '(none)'} · live ${live}`)
  // What the cache read this turn, not a size it holds: a turn's usage is its
  // model calls summed, so a long agentic turn reads the context once per call
  // and the total can run to many times the context it was reading.
  const overCalls = s.calls > 0 ? ` over ${callCountText(s)}` : ''
  if (s.lastRead > 0) {
    const total = `${s.lastRead.toLocaleString('en-US')} tokens served from cache this turn${overCalls}`
    // The share of the turn's own prompt, which the status line carries bare: here
    // there is room to say what it is a share of.
    const hit = hitPct(s.lastRead, s.lastPrompt)
    const ofPrompt = hit ? ` — ${hit} of the turn's prompt` : ''
    // The multiple is worth naming only when the call count explains it: a read
    // many times the context takes many calls, and printing it beside a count of
    // one would be two figures on one line contradicting each other.
    const multiple = s.ctx > 0 && s.calls > 1 ? Math.round(s.lastRead / s.ctx) : 0
    lines.push(multiple >= 2
      ? `cache       ${total}${ofPrompt}, ≈${multiple} × the ${fmtTok(s.ctx)} context — one read per model call`
      : `cache       ${total}${ofPrompt}`)
  } else if (s.lastRequestAt) {
    lines.push(`cache       none served from cache${overCalls} — the last turn reported nothing`)
  }
  if (s.speedToksPerSec != null && s.speedToksPerSec > 0) {
    lines.push(`speed       ${fmtSpeed(s.speedToksPerSec)} generation throughput (${s.turnOut.toLocaleString('en-US')} tokens across ${s.turnDurationMs}ms)`)
  }
  // The running total and what it was summed over, so the figure on the band is
  // one command away from being checkable rather than taken on trust.
  if (s.turns > 0) {
    lines.push(`usage       ${s.readSession.toLocaleString('en-US')} tokens served from cache over ${s.turns} turn${s.turns === 1 ? '' : 's'} since /clear`)
  }
  if (r) {
    // The three figures for one read of the context in hand, each as a share of
    // the uncached price. Providers publish rates per million tokens, but a
    // person reads a bill for the context they actually have, so the comparison
    // is shown as costs and the rates stay in /cache-tax-diagnostic, which is
    // the command whose subject they are.
    const uncached = uncachedUsd(s)
    const warm = warmUsd(s)
    const cold = coldUsd(s)
    const head = `for ${fmtTok(s.ctx)} tokens`
    const pad = ' '.repeat(13 + head.length + 3)
    lines.push(`cost        ${head}   no cache ${fmtUsd(uncached)} = 100%`)
    lines.push(`${pad}from cache ${fmtUsd(warm)}${fmtShare(warm, uncached)}`)
    lines.push(`${pad}re-write ${fmtUsd(cold)}${fmtShare(cold, uncached)}`)
    const effect = cacheEffectUsd(s)
    lines.push(`cache effect  ${fmtSignedUsd(effect)} for this context at ${RATE_SOURCE}: "from cache" minus "no cache". A saving is parenthesised — the read rate is below the input rate, so being warm lowers the bill by that much. A surcharge takes a leading + — the read rate is above the input rate, so the cache costs more than it saves`)
  } else {
    lines.push(`cost        none configured for this model, so no cost can be shown (n/a)`)
  }
  // The line the shortened notices gave up. Said here, where there is room, and
  // only when it applies.
  if (isCold(s, now)) lines.push('cold note   the next message re-writes the context at the write rate. /keepwarm holds it; /clear and paste a summary if you only need the conclusions.')
  const armed = s.deadline ? `on, ${warmingText(s, now)}` : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.stopped ? `stopped, ${s.stopped}` : armed}`)
  if (s.last) {
    // The outcome is a fact about the provider's expiry clock, which nothing in
    // the engine reports: a warm ping proves the clock outlasts the idle gap it
    // followed, a cold one proves it does not.
    const bound = s.last.warm
      ? `warm after ${fmtDuration(s.last.idle)} idle, so the provider's TTL is at least that`
      : `the cache was gone after ${fmtDuration(s.last.idle)} idle, so the provider's TTL is under that`
    lines.push(`last ping   read ${fmtTok(s.last.read)} from cache, wrote ${fmtTok(s.last.write)}, ${fmtUsd(s.last.usd)} (${bound})`)
  }
  const pings = breakEvenPings(s)
  if (pings != null && pings > 0) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  else if (r && r.cacheWrite <= 0) lines.push('break-even  warming cannot pay for itself at these rates: a cold re-write is billed at nothing, so every ping is a net cost')
  else if (r) lines.push('break-even  not applicable: a zero cache-read rate, or no context yet')
  lines.push(`guard       warn only, always. This mod never drops a prompt.`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    sid: '', deadline: 0, every: PING_AFTER_MS, warmAt: 0, coldAt: null, lastRequestAt: 0, lastModel: null, ctx: 0, rowsTokens: 0, compacted: false,
    guard: 'warn', coldWritePending: false, misses: [], pending: null, last: null, stopped: null, lastRead: 0, lastPrompt: 0,
    readSession: 0, turns: 0, calls: 0, steps: 0,
    turnOut: 0, turnDurationMs: 0, speedToksPerSec: null, accumStepsOut: 0, accumStepsDurationMs: 0,
    owns: false,
    window: 0, percent: 0, windowSource: null, free: 0, compactAt: null,
    history: [], now: 0, surface: '', notice: null,
  }
}

// --- Host pricing provenance -------------------------------------------------
// Desktop does not expose its managed four rates to a plugin. This section
// reports what the settings interface actually shows, so the absence of
// accepted pricing is visible rather than guessed at. It never becomes the
// source of a cost: costs come from the user-supplied RATES table above.

type Pricing = { rates: Rates; multiplier: number }
type Snapshot = { available: boolean; present: boolean; exact: boolean; pricing?: Pricing }
type Diagnostic = {
  model: string
  state: 'accepted pricing available' | 'candidate/unconfirmed' | 'pricing unavailable'
  reason: string
  pricing?: Pricing
  sources: string[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000
}

function validMultiplier(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10
}

// Select pricing fields immediately. Never retain, print, or persist settings.
async function snapshot($: EngineInterface, model: string, args?: SettingsReadArgs): Promise<Snapshot> {
  try {
    const { modelPricing } = await $.settings.read(args)
    const config = record(modelPricing)
    const overrides = record(config?.overrides)
    const exact = overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, model)
    const row = exact ? record(overrides?.[model]) : undefined
    const multiplier = config?.multiplier === undefined ? 1 : config.multiplier
    let pricing: Pricing | undefined
    if (row && rateKeys.every(key => validRate(row[key])) && validMultiplier(multiplier)) {
      pricing = {
        rates: { input: row.input as number, output: row.output as number,
          cacheRead: row.cacheRead as number, cacheWrite: row.cacheWrite as number },
        multiplier,
      }
    }
    return { available: true, present: modelPricing !== undefined, exact, pricing }
  } catch {
    // A host exception can contain settings or credentials; do not echo it.
    return { available: false, present: false, exact: false }
  }
}

function samePricing(a: Pricing | undefined, b: Pricing): boolean {
  return a !== undefined && a.multiplier === b.multiplier &&
    rateKeys.every(key => a.rates[key] === b.rates[key])
}

async function diagnose($: EngineInterface): Promise<Diagnostic> {
  let model: string
  try {
    model = await $.session.model()
    if (!model) throw new Error('no model')
  } catch {
    return { model: '(unavailable)', state: 'pricing unavailable',
      reason: 'Active model is not exposed by the host.', sources: [] }
  }

  const policy = await snapshot($, model, { source: 'policy' })
  const ordinary: Array<{ source: SettingsSource; snapshot: Snapshot }> = []
  for (const source of ['user', 'project', 'local', 'flag'] as const) {
    ordinary.push({ source, snapshot: await snapshot($, model, { source }) })
  }
  const merged = await snapshot($, model)
  const sources = [
    `policy: ${!policy.available ? 'unavailable' : !policy.present ? 'absent' :
      policy.exact ? 'exact override present' : 'no exact override'}`,
    ...ordinary.map(({ source, snapshot: s }) =>
      `${source}: ${!s.available ? 'unavailable' : s.present ? 'modelPricing present (ignored by host pricing)' : 'absent'}`),
    `merged: ${!merged.available ? 'unavailable' : merged.present ? 'modelPricing present (not proof of acceptance)' : 'absent'}`,
  ]
  const base = { model, sources }
  if (policy.pricing) {
    return { ...base, state: 'accepted pricing available', pricing: policy.pricing,
      reason: 'Managed policy exact model override; documented accepted pricing source. Multiplier defaults to 1 only when absent.' }
  }
  if (policy.exact) {
    return { ...base, state: 'pricing unavailable',
      reason: 'Managed exact override is invalid: four finite rates in 0..10000 and, when supplied, a finite multiplier >0 and <=10 are required. No fallback guessed.' }
  }
  if (merged.pricing) {
    const ignored = ordinary.filter(({ snapshot: s }) => samePricing(s.pricing, merged.pricing!))
    if (policy.available && ignored.length > 0) {
      return { ...base, state: 'pricing unavailable',
        reason: `Merged exact row matches ignored ${ignored.map(s => s.source).join('/')} settings; it is not accepted pricing. SDK fallback is not exposed by this settings interface.` }
    }
    return { ...base, state: 'candidate/unconfirmed', pricing: merged.pricing,
      reason: 'Merged exact row has no verified accepted provenance. Do not use for costs; managed source or host SDK fallback acceptance cannot be established.' }
  }
  return { ...base, state: 'pricing unavailable',
    reason: !policy.available ? 'Managed pricing snapshot unavailable; host SDK fallback is not exposed.' :
      'No valid managed exact override. Ordinary sources are ignored; host SDK fallback may not appear in settings. Canonical matching is unimplemented.' }
}

function display(d: Diagnostic, model: string): string {
  const r = ratesFor(model)
  const lines = ['Pricing diagnostic (read-only)', `Active model: ${d.model}`,
    r ? `Cost rates this mod uses: ${RATE_SOURCE} (USD / million tokens)`
      : `Cost rates this mod uses: none configured for this model — costs show as n/a. Add a row to RATES in hooks/register.ts.`]
  if (r) {
    lines.push(`  input=${r.input}; output=${r.output}; cacheRead=${r.cacheRead}; cacheWrite=${r.cacheWrite}`)
  }
  lines.push(`Desktop-managed pricing: ${d.state}`, `Provenance / reason: ${d.reason}`)
  if (d.pricing) {
    const { rates, multiplier } = d.pricing
    lines.push(`Host-selected rates (USD / million tokens, before multiplier${d.state === 'candidate/unconfirmed' ? '; UNCONFIRMED' : ''}):`,
      `  input=${rates.input}; output=${rates.output}; cacheRead=${rates.cacheRead}; cacheWrite=${rates.cacheWrite}`,
      `Multiplier: ${multiplier}`)
  }
  lines.push('Source snapshots (pricing fields only):', ...d.sources.map(source => `  ${source}`),
    'Matching: exact model ID only; canonical matching is unimplemented.',
    'Behavior: nothing here warms or sends on its own — a model call happens only while a /keepwarm window is armed. No prompt is ever dropped, and no settings are written.',
    'Prompt Cache / Response Cache observations: not exposed to a plugin by this engine build; the gateway-side response-cache controls are a separate ticket.')
  return lines.join('\n')
}

async function refresh($: EngineInterface, s: State): Promise<string> {
  const d = await diagnose($)
  await publish($, s)
  return display(d, d.model)
}

export const register: Register = on => {
  const s = freshState()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.sid = await $.session.id()
    // Keep the captured surface as a fallback if the live roster cannot be read.
    s.surface = e.surface ?? ''
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'warn'
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    // Registering a name another plugin already owns would double the hook.
    // While the Original Mod is enabled its names are taken, so say so once.
    const taken = new Set((await $.command.list()).map(c => c.name))
    let claimed = false
    const specs: CommandSpec[] = [
      { name: 'keepwarm',
        description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (token-tax-weather)',
        argumentHint: '[6h | always | off | status]', immediate: true },
      { name: 'cache-tax',
        description: 'Prompt cache state, cold price and this session\'s cold writes (token-tax-weather)',
        argumentHint: '[status]', immediate: true },
    ]
    for (const spec of specs) {
      if (taken.has(spec.name)) {
        $.ui.log(`/token-tax-weather: /${spec.name} is already registered by another plugin, so this mod did not claim it. Disable the Original Mod (cache-tax) to use this mod's /${spec.name}.`)
        continue
      }
      await $.command.register(spec)
      claimed = true
    }
    const diagnostic: CommandSpec = { name: 'cache-tax-diagnostic',
      description: 'Read-only pricing provenance diagnostic; no inference or warming.', immediate: true }
    await $.command.register(diagnostic)
    // The under-composer line has one slot per plugin and the Original Mod also
    // draws into it, so paint only when this mod owns the session — otherwise
    // the two footers clobber each other and truncate.
    s.owns = claimed
    // The window /autocompact measures against, so the band's percentage is the
    // one compaction will actually fire on rather than the model's raw limit.
    await refreshWindow($, s)
    await publish($, s)
    // The Desktop surface attaches a moment after this event, so the paint above
    // can be dropped; paint once more shortly after, and after that the prompts,
    // turns and commands keep the line current.
    $.clock.after(3000, () => { void publish($, s) })
    return r
  })

  // The band above the prompt. One instance and one plugin: a hook that returns a
  // tree answers the site and the chain stops beneath it, so a second plugin
  // hooked here never draws. A survey holds the band while it is up, and nothing
  // is drawn at all until this mod owns the session's command names — otherwise
  // this band and the Original Mod's status line would both speak for one session.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!s.owns || e.props.hasSurvey || !s.window) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return band(Box, Text, e.props, s)
  })

  // The resume fields Claude Code computes for settings hooks seed the guard
  // before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    // A cold resume is a notice on the status line, not a transcript line: it is
    // read now, and it stays up until the first turn finishes.
    if (line) s.notice = line
    // The seeded clock decides whether a restored window pings before the first turn: never when it is cold.
    await arm($, s)
    // arm() only paints when a window is armed; a bare resume still has to show.
    if (line) await publish($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      await stop($, s, null)
      return { text: 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      // Kept for parity with the Original Mod, but nothing arms itself here:
      // `always` only pre-arms this session, it is not remembered across them.
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: `keepwarm on for ${fmtDuration(DEFAULT_WINDOW_MS)} this session. This mod never re-arms itself at session start, so run /keepwarm again in a new session.` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0] ?? '')
      if (window == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
        every = period
      }
      await startWindow($, s, window, every)
      return { text: armedText(s, now, window) }
    }
    return { text: s.deadline || s.stopped ? statusText(s, now) : 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      return { text: 'guard is warn only. This mod shows the cold price and sends your prompt anyway; it never drops one.' }
    }
    return { text: card(s, now, await liveSurfaces($)) }
  })

  on('command.run', { command: 'cache-tax-diagnostic' }, async $ => {
    return { text: await refresh($, s) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (isCold(s, now) && s.ctx >= BIG_TOKENS) {
      // Warn only: the prompt always goes through, whatever the guard says. The
      // warning is a notice on the status line, not a transcript line, and it
      // stays up while the turn it belongs to runs.
      s.notice = `${guardText(s, now)} · sending`
      s.coldWritePending = true
    }
    // The surface may still have been attaching when session start painted, so
    // repaint here: by the first prompt the slot is certainly live.
    await publish($, s)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const stepStart = await $.clock.now()
      s.lastRequestAt = stepStart
      // The engine numbers a turn's steps from 0, so the highest index seen is one
      // less than the calls the turn has made.
      s.steps = Math.max(s.steps, e.index + 1)
      const res = yield* next(e)
      const stepEnd = await $.clock.now()
      const stepDuration = Math.max(1, stepEnd - stepStart)
      const outTokens = res?.usage?.output_tokens ?? 0
      s.accumStepsOut += outTokens
      s.accumStepsDurationMs += stepDuration
      return res
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    // The turn's call count, read before the next turn's steps start arriving. A
    // turn that reported no step still made at least one call, so the floor is one
    // rather than zero — a zero here would read as a turn that cost nothing.
    s.calls = Math.max(1, s.steps)
    s.steps = 0
    if (s.accumStepsDurationMs > 0 && s.accumStepsOut > 0) {
      s.turnOut = s.accumStepsOut
      s.turnDurationMs = s.accumStepsDurationMs
      s.speedToksPerSec = Math.round((s.turnOut / (s.turnDurationMs / 1000)) * 10) / 10
    } else {
      s.turnOut = 0
      s.turnDurationMs = 0
      s.speedToksPerSec = null
    }
    s.accumStepsOut = 0
    s.accumStepsDurationMs = 0
    const u = e.usage
    // The notice this turn raises, if any. It is set after the clear below, so a
    // cold write — a call to action — outlives its own turn by one, unlike the
    // notice from the prompt or the resume it supersedes.
    let notice: string | null = null
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      // What the cache actually served this turn — the honest "warmed" figure,
      // as against the context size, which is only what it could be holding. The
      // running total is accumulated here rather than derived from the history,
      // which keeps only the last twelve readings and would undercount a long
      // session.
      s.lastRead = u.cache_read_input_tokens
      // The turn's whole prompt: the three input fields are disjoint slices of one
      // prompt, so their sum is what the cache was offered. Read against it, the
      // served tokens are the turn's hit rate.
      s.lastPrompt = u.input_tokens + u.cache_read_input_tokens + write
      s.readSession += u.cache_read_input_tokens
      s.turns += 1
      const full = prev > 20000 && write >= 0.5 * prev
      if ((full || s.coldWritePending) && write > 0) {
        const rates = ratesFor(s.lastModel)
        const usd = rates ? write * rates.cacheWrite / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // No warming is armed here: a cold write is recorded and reported, never
        // answered with spending. /keepwarm is the only thing that arms a window.
        notice = `cold write ${fmtTok(write)}${usd == null ? '' : ` · ${fmtUsd(usd)}`} · /keepwarm`
      }
    }
    s.coldWritePending = false
    s.stopped = null
    // A notice is a one-shot too: it stays up while the turn it belongs to runs,
    // and the ordinary readout returns once that turn is over. Cleared here, at the
    // end of the turn, before the paints below; the cold write this turn raised is
    // the one thing set after the clear, so it stays until the next turn.
    s.notice = null
    if (notice) s.notice = notice
    await refreshWindow($, s)
    // The band's history: one reading per completed turn, oldest first.
    s.history.push(s.ctx)
    if (s.history.length > HISTORY) s.history = s.history.slice(-HISTORY)
    await arm($, s)
    if (!s.deadline) await publish($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      disarm(s)
    }
    return r
  })
}
