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
// Note on the Opus row: its cacheRead (0.005) is about 7x its input (0.0007), so
// reading the prompt cache costs more than sending the same context uncached.
// The card reports what the arithmetic says; it does not pretend the figures are
// typical.
//
// Add rows in this shape, then update the plugin:
//
//   'claude-opus-5-5': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
//
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0007, cacheRead: 0.005, cacheWrite: 0, output: 0.6 },
}

const RATE_SOURCE = 'user-supplied rates'

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'warn'

export type State = {
  sid: string
  deadline: number
  every: number
  lastRequestAt: number
  lastModel: string | null
  ctx: number
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
   * Cache-read tokens summed over every main turn since the last /clear: the
   * running total, where `lastRead` is only the turn just gone. A compaction does
   * not start a new conversation, so it survives `session.compact` the same way
   * the cold-write tally below does; only /clear resets it.
   */
  readSession: number
  /** Completed main turns since the last /clear: what `readSession` was summed over. */
  turns: number
  /** True once this mod's command names are the session's, so the footer slot is ours to write. */
  owns: boolean
  /** The window the fill is measured against: the compaction window /autocompact sets, else the model's. */
  window: number
  /** The fill as a whole percentage of `window`. */
  percent: number
  /** Where that window came from (the engine's `ContextWindowSource`), or null when only the model's is known. */
  windowSource: string | null
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

function fmtUsd(usd: number | null): string {
  if (usd == null) return 'n/a'
  // Sub-cent figures are normal at these rates; two decimals would read as $0.00.
  if (usd > 0 && usd < 0.01) return '$' + usd.toFixed(4)
  return '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

/** A signed difference: `+$0.12` costs more, `-$0.00` saves. */
function fmtSignedUsd(usd: number | null): string {
  if (usd == null) return 'n/a'
  return (usd >= 0 ? '+' : '-') + fmtUsd(Math.abs(usd))
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

/**
 * The adjustment the cache makes to the bill for this one context: from cache
 * minus no cache, i.e. the cache-read rate against the input rate. **Negative
 * means the cache lowers the bill** — it is a saving of that much, and the usual
 * case where the read rate is far below the input rate (Fable: 0.03 against
 * 0.43). **Positive means the cache raises it** — the read rate is above the
 * input rate, so serving from cache costs more than not caching and the cache is
 * a surcharge, which some operators' rates genuinely do (Opus: 0.005 against
 * 0.0007).
 *
 * This is the reverse of "what a cold send costs": that is the same magnitude
 * with the opposite sign. The sign here reads as an effect on the bill, so with
 * a colour beside it negative is green and positive is red.
 */
function cacheEffectUsd(s: State): number | null {
  const uncached = uncachedUsd(s)
  const warm = warmUsd(s)
  return uncached == null || warm == null ? null : warm - uncached
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
  s.lastRequestAt = 0
  s.compacted = false
  s.coldWritePending = false
  s.misses = []
  s.lastRead = 0
  s.readSession = 0
  s.turns = 0
  s.percent = 0
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

/** The warming slot on its own: off, a countdown, or why it stopped. */
function warmingText(s: State, now: number): string {
  if (s.stopped) return `stopped: ${s.stopped}`
  if (!s.deadline) return 'off'
  return `${fmtDuration(s.deadline - now)} left`
}

/** When the next ping can come, or null while nothing is armed. */
function nextPingText(s: State, now: number): string | null {
  if (!s.deadline) return null
  if (!s.lastRequestAt) return 'ping after first turn'
  if (isCold(s, now)) return 'ping after next turn'
  return `ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
}

// The under-composer line, in one fixed field order so the same fact always
// appears in the same place — durations first, then token counts, then money:
//
//   <warming> · [ping] · <context> · [read] · [±]
//
// warming  off | <time> left | stopped: <why>
// ping     present only while a window is armed
// context  no context yet | ctx <tokens> — what the cache could be holding
// read     absent until a turn reports a cache read: how much it read this turn
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
// `/cache-tax` prints the exact ID the rates are keyed on.
function statusText(s: State, now: number): string {
  const parts = [warmingText(s, now)]
  const ping = nextPingText(s, now)
  if (ping) parts.push(ping)
  parts.push(s.ctx > 0 ? `ctx ${fmtTok(s.ctx)}` : 'no context yet')
  if (s.lastRead > 0) parts.push(`read ${fmtTok(s.lastRead)} this turn`)
  if (s.ctx > 0) {
    const effect = cacheEffectUsd(s)
    parts.push(effect == null ? 'n/a' : fmtSignedUsd(effect))
  }
  return parts.join(' · ')
}

// The commands worth running right now, so the line can name the next move
// rather than only report. With nothing armed a window can be started, and that
// is the whole point of the line; armed and warm there is nothing to suggest,
// because a ping is already coming. The card is always last — it is where the
// figures this line abbreviates are spelled out, so it is the one command that is
// always worth running.
//
// A cold cache gets no clause of its own. It cannot: on a surface that raises the
// band, going cold is never what repaints this line — the first thing a person
// does after the cache lapses is send a prompt, and the guard notice takes the
// slot for that turn. So `/keepwarm` is offered for the state that is actually
// on screen, which is the same command either way.
function hintsFor(s: State): string[] {
  const hints: string[] = []
  if (!s.deadline) hints.push('/keepwarm to arm the window')
  hints.push('/cache-tax for the full card')
  return hints
}

// The line for a surface the band already reaches: the band carries the readout
// in colour, so this says only what the band does not — whether warming is on,
// when the next ping comes, and what to run next. The state is spelled out as
// `keepwarm on` / `keepwarm off` rather than the bare countdown the readout uses,
// so the line stands on its own wherever it is read without the band. A window
// that stopped says why: the reason is the difference between a window that was
// never armed and one that was and gave up, and the slot hovers, so the length of
// it costs nothing.
function hintText(s: State, now: number): string {
  const parts = [s.stopped
    ? `keepwarm stopped: ${s.stopped}`
    : s.deadline ? `keepwarm on, ${fmtDuration(s.deadline - now)} left` : 'keepwarm off']
  // The ping is the readout's own clause; it follows the state only while a
  // window is armed, which is the only state it has anything to say in.
  const ping = nextPingText(s, now)
  if (ping) parts.push(ping)
  return [...parts, ...hintsFor(s)].join(' · ')
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// --- The AbovePrompt band ----------------------------------------------------
// The status line takes a plain string and cannot colour, so once this mod owns
// the session the same facts move to the band above the prompt, where a tree's
// `Text` does take a colour. The band is one instance and one plugin draws it:
// a hook that returns a tree answers the site and the chain stops beneath it, so
// a second plugin hooked on AbovePrompt never draws.

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

/** How much the context moved on the last turn, or null while there is no turn to compare. */
function trendText(history: number[]): string | null {
  if (history.length < 2) return null
  const delta = history[history.length - 1]! - history[history.length - 2]!
  if (delta === 0) return 'steady'
  return `${delta > 0 ? '▲ +' : '▼ '}${fmtTok(Math.abs(delta))} last turn`
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
      s.percent = Math.round(breakdown.percentage)
      s.windowSource = breakdown.autocompactSource
      return
    }
    if (context.window > 0) {
      s.window = context.window
      s.percent = Math.round(context.percent ?? (s.ctx / context.window) * 100)
      s.windowSource = null
    }
  } catch {
    // No session bound, or a host that answers no breakdown: keep the last reading.
  }
}

/**
 * The band's tree. Sized to `columns` (the band's own box, which is narrower than
 * the viewport while a pane is docked beside the transcript): the sparkline and
 * the trend are the first things to go, then the cache read.
 *
 * The field order groups like kinds — the forecast and its measurement, then the
 * token counts, then the durations, then the one price.
 */
function band(
  Box: ElementConstructor<BoxProps>,
  Text: ElementConstructor<TextProps>,
  props: { bodyColumns: number },
  s: State,
) {
  const columns = props.bodyColumns || 80
  const f = forecastFor(s.percent)
  const now = s.now || 0
  // The table's constructors take children among the props and hand back an
  // element with them beside `props`, which is the shape the engine draws.
  const t = (textProps: TextProps, text: string) => Text({ ...textProps, children: text })
  const dim = (text: string) => t({ dimColor: true }, text)
  const parts: RenderElement[] = [
    t({ color: f.color, bold: true }, `${f.icon}  ${f.word}`),
    t({ color: f.color }, `  ${s.percent}% of ${fmtTok(s.window)}`),
  ]
  const spark = columns >= 56 ? sparkline(s.history, s.window) : ''
  if (spark) parts.push(dim('  ·  '), t({ color: f.color }, spark))
  const trend = columns >= 72 ? trendText(s.history) : null
  if (trend) parts.push(dim(`  ·  ${trend}`))
  if (s.lastRead > 0) parts.push(dim(`  ·  read ${fmtTok(s.lastRead)} this turn`))
  // The running total, beside the turn it continues: a turn's read is the figure
  // that moves, the session's is the one that adds up to what the cache has
  // served you since /clear.
  if (s.readSession > 0) parts.push(dim(`  ·  read ${fmtTok(s.readSession)} this session`))
  parts.push(dim(`  ·  ${warmingText(s, now)}`))
  const ping = nextPingText(s, now)
  if (ping) parts.push(dim(` · ${ping}`))
  if (s.ctx > 0) {
    const effect = cacheEffectUsd(s)
    if (effect == null || effect === 0) {
      // `n/a` is a price this mod cannot compute, and a configured zero is a real
      // answer; neither is a saving, so neither is coloured as one.
      parts.push(dim(`  ·  ${fmtSignedUsd(effect)}`))
    } else {
      // Negative lowers the bill (green), positive raises it (red). The theme's
      // own keys, so the colours follow the person's theme rather than a guess.
      parts.push(dim('  ·  '), t({ color: effect < 0 ? 'success' : 'error' }, fmtSignedUsd(effect)))
    }
  }
  return Box({ flexDirection: 'row', paddingX: 1, children: parts })
}

// The line this mod keeps in its own slot under the prompt. The continuously
// updating readout — what is armed when a window is, and otherwise what the
// costing is based on — so the slot says something true about this mod rather
// than sitting empty. It names the model the engine reports, because that exact
// ID decides whether rates are found.
//
// The host already prints the plugin's own name ahead of this text, so the line
// never repeats it.
//
// The model comes from the last turn's own usage and never from a session lookup:
// at session start the host may not yet have told the engine which model to use,
// and a footer must not be left waiting on that. Until the first turn the line
// says so instead of guessing.
//
// Written only while this mod owns the session's command names: the slot holds one
// entry per plugin, so painting into it while the Original Mod owns the session
// would clobber that mod's footer. Repainted on session start, before each prompt,
// and after each turn or command, because a single paint can be lost while the
// surface is still attaching.
//
// The band above the prompt is raised on the desktop and terminal surfaces only,
// and where it is raised it carries the readout in colour. The slot here is then
// free to say what the band does not — whether warming is on and what to run — so
// the readout is never said twice: where the band is up the line is the state and
// the hints together, and where it is not the line carries the readout with the
// hints after it. A live notice is not the readout — it is pinned wherever it is
// set, the band's own surfaces included, and it takes the line until the turn
// that raised it is over.
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
// race each other for it. A live notice outranks everything and shows on every
// surface, the band's included: it is a one-off thing to read now, not the facts
// the band keeps current, so it is worth saying even where the band is up.
async function publish($: EngineInterface, s: State) {
  // Stamped whatever happens: the band draws synchronously and reads this rather
  // than asking the clock again.
  s.now = await $.clock.now()
  if (!s.owns) return
  if (s.notice) {
    $.ui.status(s.notice)
    return
  }
  // With no notice the line is painted from the surfaces, and which of the two
  // forms it takes is decided by whether the band is up. Where the band is up it
  // carries the readout, so the line is free to say what the band does not — the
  // warming state and the command worth running. Where there is no band the
  // readout has to be on this line, and the hints are left off rather than
  // appended: that line is already the longest the slot has to hold, and a hint
  // that pushes the price off the end costs more than it adds. Repainting is also
  // what takes a finished notice off the screen. Whether the band is up is asked
  // fresh; when the ask fails the captured surface is the last honest word, so a
  // silent host never hides the readout by accident.
  const live = await liveSurfaces($)
  const raised = live ? live.some(surface => BAND_SURFACES.has(surface)) : BAND_SURFACES.has(s.surface)
  $.ui.status(raised ? hintText(s, s.now) : statusText(s, s.now))
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
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `ping read ${fmtTok(u.cache_read_input_tokens)}, wrote ${fmtTok(u.cache_creation_input_tokens)} (${fmtUsd(usd)}): the cache was gone`)
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
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
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
  // Both surfaces, so the next session can see what the start value actually was
  // against what the session draws on now — the pair that decides the status line.
  const live = surfaces == null ? 'unavailable' : surfaces.length ? surfaces.join(', ') : '(none)'
  lines.push(`surfaces    captured ${s.surface || '(none)'} · live ${live}`)
  // What the cache read this turn, not a size it holds: a turn's usage is its
  // model calls summed, so a long agentic turn reads the context once per call
  // and the total can run to many times the context it was reading.
  if (s.lastRead > 0) {
    const total = `${s.lastRead.toLocaleString('en-US')} tokens read from cache this turn`
    if (s.ctx > 0 && s.lastRead >= 2 * s.ctx) {
      const multiple = Math.round(s.lastRead / s.ctx)
      lines.push(`cache read  ${total}, ≈${multiple} × the ${fmtTok(s.ctx)} context — one read per model call`)
    } else {
      lines.push(`cache read  ${total}`)
    }
  } else if (s.lastRequestAt) {
    lines.push('cache read  none reported by the last turn, so nothing was served from cache')
  }
  // The running total and what it was summed over, so the figure on the band is
  // one command away from being checkable rather than taken on trust.
  if (s.turns > 0) {
    lines.push(`session read  ${s.readSession.toLocaleString('en-US')} tokens served from cache over ${s.turns} turn${s.turns === 1 ? '' : 's'} since /clear`)
  }
  if (r) {
    lines.push(`unit prices input ${r.input} · read ${r.cacheRead} · write ${r.cacheWrite} · output ${r.output} USD/MTok (${RATE_SOURCE}; prices, not costs)`)
    lines.push(`for ${fmtTok(s.ctx)} tokens   re-write ${fmtUsd(coldUsd(s))} (write rate) · from cache ${fmtUsd(warmUsd(s))} (read rate) · no cache ${fmtUsd(uncachedUsd(s))} (input rate)`)
    const effect = cacheEffectUsd(s)
    lines.push(`cache effect  ${fmtSignedUsd(effect)} for this context: "from cache" minus "no cache". Negative is a saving — the read rate is below the input rate, so being warm lowers the bill by that much. Positive is a surcharge — the read rate is above the input rate, so the cache costs more than it saves`)
  } else {
    lines.push(`unit prices none configured for this model, so no cost can be shown (n/a)`)
  }
  // The line the shortened notices gave up. Said here, where there is room, and
  // only when it applies.
  if (isCold(s, now)) lines.push('cold note   the next message re-writes the context at the write rate. /keepwarm holds it; /clear and paste a summary if you only need the conclusions.')
  const armed = s.deadline ? `on, ${warmingText(s, now)}` : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.stopped ? `stopped, ${s.stopped}` : armed}`)
  if (s.last) lines.push(`last ping   read ${fmtTok(s.last.read)} from cache, wrote ${fmtTok(s.last.write)}, ${fmtUsd(s.last.usd)}${s.last.warm ? ' (warm)' : ' (the cache was gone)'}`)
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
    sid: '', deadline: 0, every: PING_AFTER_MS, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'warn', coldWritePending: false, misses: [], pending: null, last: null, stopped: null, lastRead: 0,
    readSession: 0, turns: 0, owns: false,
    window: 0, percent: 0, windowSource: null, history: [], now: 0, surface: '', notice: null,
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
    // The band is raised on the desktop and terminal surfaces only, so which one
    // this is decides whether the status line is the fallback or is left empty.
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
    if (!e.agentId) s.lastRequestAt = await $.clock.now()
    yield* next(e)
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
      s.readSession += u.cache_read_input_tokens
      s.turns += 1
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const rates = ratesFor(s.lastModel)
        const usd = rates ? write * rates.cacheWrite / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // No warming is armed here: a cold write is recorded and reported, never
        // answered with spending. /keepwarm is the only thing that arms a window.
        notice = `cold write ${fmtTok(write)}${usd == null ? '' : ` · ${fmtUsd(usd)}`} · /keepwarm`
      }
    }
    s.coldWritePending = false
    // The band's history: one reading per completed turn, oldest first.
    s.history.push(s.ctx)
    if (s.history.length > HISTORY) s.history = s.history.slice(-HISTORY)
    // A stop notice is a one-shot: it stays until the turn after it. This turn is
    // also what reveals which model the engine is really using, so the idle footer
    // is repainted here; arm() repaints an armed one itself.
    s.stopped = null
    // A notice is a one-shot too: it stays up while the turn it belongs to runs,
    // and the ordinary readout returns once that turn is over. Cleared here, at the
    // end of the turn, before the paints below; the cold write this turn raised is
    // the one thing set after the clear, so it stays until the next turn.
    s.notice = null
    if (notice) s.notice = notice
    await refreshWindow($, s)
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
