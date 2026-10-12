import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  CommandRunInput, CommandSpec, ModelForkResult, On, PromptSubmitInput, RenderSurface,
  ContextWindowSource, SessionContextUsage, SessionStartInput, Settings, SettingsSource, TurnCompleteInput, TurnUsage,
} from 'claude-code'

import { RATES, costSlotText, fmtClock, fmtShare, fmtSignedUsd, hitPct, ratesFor, savedPct } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
// The clock starts at a named local wall-clock — 1:00pm on 12 October 2026 — so
// the row's clock times, which the tests assert exactly, are the same in every
// zone: both the fixture's start and the mod's formatter read the host's local
// time, and a bare epoch would put a different clock in each.
const START = new Date(2026, 9, 12, 13, 0, 0).getTime()
const MODEL = 'claude-fable-5'
// A model with no RATES row: the explicit unknown-cost path.
const UNCONFIGURED = 'claude-no-such-model'
const WARM_PROMPT = 'Reply with the single word: warm'
// The namespace the Custom Mod owns; the Original Mod's bare keys must be ignored.
const DEADLINE_KEY = 'token-tax-weather:deadline:S1'
// The idle footer: what the costing is based on while nothing is armed. Before
// the first turn the engine has told this mod no model, and the line says so.
const NO_MODEL_FOOTER = 'off · no context yet'
const IDLE_FOOTER = 'off · ctx 200.5k · 1 call · 200k cache turn · 99% from cache, 93% saved'
// The line where the band is raised: the band carries the readout, so this slot
// carries the warming state, signed money, and hints.
const HINT_FOOTER = 'off · 99% from cache, 93% saved · /keepwarm to arm the window · /cache-tax for the full card'
const NO_CONTEXT_HINT_FOOTER = 'off · /keepwarm to arm the window · /cache-tax for the full card'

// The band above the prompt is raised on `desktop` and `terminal` only, so the
// shared session is a `vscode` one: the status line is the fallback there, and
// the footer assertions below are about the status line. The band has its own
// session, and its own describe block.
const session: SessionStartInput = { surface: 'vscode', isInteractive: true, cwd: '/work' }
const bandSession: SessionStartInput = { surface: 'desktop', isInteractive: true, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: MODEL, ...over,
})

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: string, args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

// A fired timer starts an async ping; drain microtasks so it settles before asserting.
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }

// The model calls a turn makes, driven the way the engine's own loop drives them:
// one `turn.step` per call, its `index` the position in the turn from 0. The mod
// counts these, so a test that wants a multi-call turn has to make one — a turn
// that reports no step still made one call, which is the floor the mod applies.
const callStep = async ($: Engine, index: number) => {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: MODEL, messageCount: 1 })) {
    // The step's chunks are the model's reply arriving; nothing here reads them.
  }
}

// 'unanswered' is this build's `nothing-to-fork` arm: the union has no null arm.
type ForkAnswer = 'unanswered' | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, opts: {
  store?: Map<string, unknown>
  commands?: string[]
  live?: { tokens?: number }
  sid?: string
  model?: string
  forks?: ForkAnswer[]
  settings?: Partial<Record<SettingsSource | 'merged', Settings>>
  /** The model's window, the plain `$.session.usage()` answer. */
  window?: number
  /** When set, `{ breakdown }` answers a compaction window of this size. */
  rawMax?: number
  /** When set, the breakdown carries a `free` row of this many tokens. */
  free?: number
  autocompactSource?: string
  /**
   * What the live `$.session.surfaces()` reports. Left out, it mirrors the one
   * surface `$.session.start` was handed, as the engine documents: the start
   * event's `e.surface` is `$.session.surfaces()[0]`. Give it to model a client
   * attaching after start — the roster the band's reach is read from.
   */
  surfaces?: readonly RenderSurface[]
} = {}) {
  const store = opts.store
  const sets: string[] = []
  const deletes: string[] = []
  if (store) {
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => { sets.push(e.key); store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', ($, e) => { deletes.push(e.key); store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else {
    mock.store(on, {})
  }
  const forks: string[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  const commands: CommandSpec[] = []
  const forkScript = opts.forks ?? []
  let startSurface: RenderSurface | null = null
  on('session.start', ($, e) => { startSurface = e.surface; return { cwd: e.cwd } })
  on('session.surfaces', () => ({ value: opts.surfaces ?? (startSurface ? [startSurface] : []) }))
  on('session.id', () => ({ value: opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: opts.model ?? MODEL }))
  const window = opts.window ?? 1000000
  const usageArgs: Array<{ breakdown?: string } | undefined> = []
  on('session.usage', ($, e) => {
    usageArgs.push(e)
    const tokens = opts.live?.tokens
    const context: SessionContextUsage = { window, tokens }
    // Only a call that asked for the breakdown is answered with one — that is what
    // makes the mod's own choice of `summary` visible to a test.
    if (e?.breakdown && opts.rawMax) {
      // Only the fields the mod reads are filled: the band measures against
      // `rawMaxTokens` and reports the fill, and never touches the grid, the
      // memory files or the per-tool schemas.
      context.breakdown = {
        gridRows: [],
        model: opts.model ?? MODEL,
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        rawMaxTokens: opts.rawMax,
        maxTokens: opts.rawMax,
        autocompactSource: (opts.autocompactSource ?? 'settings') as ContextWindowSource,
        autoCompactThreshold: opts.rawMax - 20000,
        isAutoCompactEnabled: true,
        percentage: tokens ? (tokens / opts.rawMax) * 100 : 0,
        totalTokens: tokens ?? 0,
        categories: opts.free == null ? [] : [{
          name: 'Free space', tokens: opts.free, color: 'inactive', isDeferred: false, kind: 'free' as const,
        }],
        apiUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    }
    return { value: { startedAt: START, context, rateLimits: [] } }
  })
  on('settings.read', ($, e) => ({ value: opts.settings?.[e.source ?? 'merged'] ?? {} }))
  on('command.register', ($, e) => { commands.push(e); return { value: { command: e.name } } })
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // `turn.step` streams, so the bottom of its chain is a generator returning the
  // step's result. The mod counts the steps and reads nothing else here, so this
  // answers with an empty response of the shape the engine declares.
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  // The band's element table, as a surface would hand it back: plain objects, so a
  // test can read a tree's colours and children without a painter.
  // Nothing mocks `ui.resolve` or `ui.render`: `$.ui.mount` supplies the surface's
  // own element table, which validates every tree the plugins return. A table
  // stubbed by hand would accept props the real one refuses.
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const a = forkScript.shift()
    if (a === undefined || a === 'unanswered') return { value: { isAnswered: false, reason: 'nothing-to-fork' } as ModelForkResult }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { store, sets, deletes, forks, status, logs, entered, commands, usageArgs }
}

// What one `AbovePrompt` band would draw, as the surface would draw it. The
// mount supplies the real element table, so an invalid tree is refused here
// rather than passing a stub. Null means the hook passed: the band stays empty.
async function bandOf($: Engine, over: { surface?: RenderSurface; hasSurvey?: boolean; columns?: number } = {}) {
  try {
    const ui = await $.ui.mount({
      plugin: 'token-tax-weather',
      surface: over.surface ?? 'desktop',
      component: 'AbovePrompt',
      requestId: 'band',
      props: {
        hasSurvey: over.hasSurvey ?? false,
        isWorking: false,
        bodyColumns: over.columns ?? 120,
        maxRows: 10,
        scroll: { bodyRows: 10, offset: 0 },
        view: {},
      },
    })
    const parts = await ui.findAll({ type: 'Text' })
    if (!parts.length) return null
    return {
      text: parts.map(part => part.text).join(''),
      colors: parts
        .filter(part => part.props.color)
        .map(part => ({ text: part.text, color: String(part.props.color) })),
    }
  } catch {
    // The hook passed, so nothing drew the band and the mount has no drawing to
    // hold: the band is empty, which is what every caller of this asks about.
    return null
  }
}

describe('guard', () => {
  test('a cold turn warns without dropping the prompt', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const result = await $.prompt.submit(prompt('hi'))
    expect(result.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    // The warning is a status-line notice now, not a transcript line, and it is
    // written to fit the one line the app gives that slot.
    const warning = w.status.at(-1) ?? ''
    expect(warning).toMatch(/^cold \d+.* · re-write ≈\$/)
    expect(warning).toMatch(/ · sending$/)
    expect(warning.length).toBeLessThanOrEqual(NOTICE_MAX)
    expect(w.logs.join('\n')).not.toMatch(/re-write ≈/)
  })
})

describe('warming', () => {
  test('a cold write never arms warming or a deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { store: new Map(), live: { tokens: 100000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ cache_creation_input_tokens: 60000 }) }))
    expect(w.forks).toEqual([])
    expect(w.sets.filter(k => k.includes('deadline'))).toEqual([])
    await clock.advance(12 * HOUR)
    await flush()
    expect(w.forks).toEqual([])
  })

  test('session start paints the footer only when this mod owns the session', async ($, on) => {
    mock.clock(on, { now: START })
    const mine = world(on, {})
    await $.session.start(session)
    expect(mine.status).toEqual([NO_MODEL_FOOTER])
  })

  test('session start paints nothing while the Original Mod owns the command names', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { commands: ['keepwarm', 'cache-tax'] })
    await $.session.start(session)
    // Painting into the shared slot would clobber the Original Mod's footer.
    expect(w.status).toEqual([])
  })

  test('no path paints while the Original Mod owns the command names', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { commands: ['keepwarm', 'cache-tax'] })
    await $.session.start(session)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await $.command.run(run('cache-tax', ''))
    expect(w.status).toEqual([])
  })

  test('a prompt repaints the footer, so a paint lost at session start comes back', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.prompt.submit(prompt('hi'))
    // Session start, then the prompt: the surface is certainly attached by then.
    expect(w.status).toEqual([NO_MODEL_FOOTER, NO_MODEL_FOOTER])
  })

  test('the turn repaints the footer with the context size the engine reports', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(IDLE_FOOTER)
  })

  test('a model with no rates is flagged, never priced with another model\'s rates', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { model: UNCONFIGURED })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: UNCONFIGURED }) }))
    expect(w.status.at(-1)).toBe('off · ctx 200.5k · 1 call · 200k cache turn · n/a')
  })

  test('a configured model carries no unpriced flag', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).not.toMatch(/unpriced/)
  })

  test('a stop notice lasts until the turn after it, then the idle line returns', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: ['unanswered'] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    expect(w.status.at(-1)).toMatch(/^stopped: /)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(IDLE_FOOTER)
  })

  test('an armed window names when it ends and when the next ping comes, not how long either waits', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('ends 7:00pm · ping at 1:50pm · ctx 200.5k · 1 call · 200k cache turn · 99% from cache, 93% saved')
  })

  test('an armed window says so when it has no rates for the model', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { model: UNCONFIGURED })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: UNCONFIGURED }) }))
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('ends 7:00pm · ping at 1:50pm · ctx 200.5k · 1 call · 200k cache turn · n/a')
  })

  test('the fields keep their order whatever the state', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    // times first, then tokens, then money — the same order in every state.
    expect(w.status.at(-1)).toBe('off · no context yet')
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(IDLE_FOOTER)
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('ends 7:00pm · ping at 1:50pm · ctx 200.5k · 1 call · 200k cache turn · 99% from cache, 93% saved')
    await clock.advance(60 * MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(w.status.at(-1)).toBe(IDLE_FOOTER)
  })

  test('token figures keep a decimal, so the context and the served read stay distinct', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 299912 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 141912 }) }))
    // Whole-thousands rounding would print both of these as 300k and 142k and
    // make the cache read look like half the context by coincidence of rounding.
    expect(w.status.at(-1)).toBe('off · ctx 299.9k · 1 call · 141.9k cache turn · 99% from cache, 93% saved')
  })

  test("the Original Mod's settings keys arm nothing", async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['always', true],
      ['deadline', START + 6 * HOUR],
      ['every', 5 * MIN],
      ['guard', 'warn'],
    ])
    const w = world(on, { store })
    await $.session.start(session)
    expect(w.forks).toEqual([])
    expect(w.sets.filter(k => k.includes('deadline'))).toEqual([])
    // The pricing label is informational; no warming status may be painted.
    expect(w.status.join('|')).not.toMatch(/keepwarm/)
    await clock.advance(12 * HOUR)
    await flush()
    expect(w.forks).toEqual([])
  })
})

describe('command registration', () => {
  test('three commands register when none are taken', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { commands: [] })
    await $.session.start(session)
    expect(w.commands.map(c => c.name)).toEqual(['keepwarm', 'cache-tax', 'cache-tax-diagnostic'])
  })

  test('a taken keepwarm name is skipped with an explanation', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { commands: ['keepwarm'] })
    await $.session.start(session)
    expect(w.commands.map(c => c.name)).toEqual(['cache-tax', 'cache-tax-diagnostic'])
    expect(w.logs.join('\n')).toMatch(/\/keepwarm is already registered by another plugin/)
  })
})

describe('/keepwarm', () => {
  test('bare arms a six-hour window', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, { store })
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', ''))
    expect(result.text).toMatch(/^keepwarm on for 6h00m, a ping 50m after each idle stretch/)
    expect(store.has(DEADLINE_KEY)).toBe(true)
  })

  test('90m arms ninety minutes', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', '90m'))
    expect(result.text).toMatch(/on for 1h30m/)
  })

  test('2h30m arms a combined two-and-a-half-hour window', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', '2h30m'))
    expect(result.text).toMatch(/keepwarm on for 2h30m/)
  })

  test('a malformed window is rejected', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', 'soon'))
    expect(result.text).toBe('keepwarm takes a window such as 6h or 90m, or always, off, or status')
  })

  test('a two-minute period is accepted', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', '6h every 2m'))
    expect(result.text).toMatch(/a ping 2m after each idle stretch/)
  })

  test('a thirty-second period is rejected', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', '6h every 30s'))
    expect(result.text).toBe('every takes a period of at least 1m')
  })

  test('off clears the window', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', ''))
    expect(store.has(DEADLINE_KEY)).toBe(true)
    const result = await $.command.run(run('keepwarm', 'off'))
    expect(result.text).toBe('keepwarm is off')
    expect(store.has(DEADLINE_KEY)).toBe(false)
  })

  test('status reports off when nothing is armed', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    const result = await $.command.run(run('keepwarm', 'status'))
    expect(result.text).toBe('keepwarm is off')
  })
})

describe('pinging', () => {
  test('an armed window pings with the warm prompt', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: [{ read: 200000, write: 0 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    expect(w.forks).toEqual([WARM_PROMPT])
  })

  // The engine reports no cache TTL, so the only evidence of the provider's
  // expiry clock is what a ping it was sending anyway came back with: warm
  // proves the clock outlasts the idle gap, cold proves it does not.
  test('a warm ping records the idle gap, which bounds the provider TTL from below', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { forks: [{ read: 200000, write: 0 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/last ping   read 200k from cache, wrote 0, \$0\.0060 \(warm after 50m idle, so the provider's TTL is at least that\)/)
  })

  test('a cold ping halves the interval and carries on, rather than ending the window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: [{ read: 0, write: 102800 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    // The ceiling is now 50m and the floor is still nothing, so the midpoint is
    // half of it — and the window is still armed, because the rewrite the ping
    // just paid for has already been paid.
    expect(w.status.at(-1)).toBe('ends 7:00pm · ping at 2:15pm (went at 50m) · ctx 200.5k · 1 call · 200k cache turn · 99% from cache, 93% saved')
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/last ping   read 0 from cache, wrote 102\.8k, \$0\.0000 \(the cache was gone after 50m idle, so the provider's TTL is under that\)/)
  })

  // The search closes on the TTL from both sides. Halving alone would stop at the
  // first gap that happened to work, so a TTL of 45m reached through a cold 50m
  // would leave the window pinging at 25m for as long as it was armed.
  test('a warm ping after a cold one bisects upward, not back down', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {
      forks: [{ read: 0, write: 102800 }, { read: 200000, write: 0 }],
    })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    expect(w.status.at(-1)).toContain('ping at 2:15pm (went at 50m)')
    // Warm at 25m: the floor moves to 25m while the ceiling stays at 50m, so the
    // next probe is the midpoint of the two, not a second halving to 12m.
    await clock.advance(25 * MIN + 1)
    await flush()
    expect(w.forks).toEqual([WARM_PROMPT, WARM_PROMPT])
    // The midpoint of 25m and 50m is 37.5m from the ping that just ran at 2:15pm.
    expect(w.status.at(-1)).toContain('ping at 2:52pm (held 25m)')
  })

  test('a provider that caches nothing stops the window rather than pinging on', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: [{ read: 0, write: 0 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    // Neither read nor written: this is not a cold cache but an absent one, so
    // there is no TTL to search for.
    expect(w.status.at(-1)).toMatch(/^stopped: ping read 0, wrote 0 \(\$0\.0000\): the provider cached nothing, so there is no expiry to tune around/)
  })

  test('an interval already at the floor stops rather than pinging at it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: [{ read: 0, write: 102800 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h every 1m'))
    await clock.advance(MIN + 1)
    await flush()
    expect(w.status.at(-1)).toMatch(/^stopped: ping read 0, wrote 102\.8k \(\$0\.0000\): the cache was gone after 1m idle, and 1m is the shortest interval, so there is nothing here to keep warm/)
  })

  test('a warm ping says on the line what its gap proved about the provider TTL', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: [{ read: 200000, write: 0 }] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    // Before any ping has run there is nothing proved, so the slot is only a time.
    expect(w.status.at(-1)).toContain('ping at 1:50pm ·')
    expect(w.status.at(-1)).not.toContain('held')
    await clock.advance(50 * MIN + 1)
    await flush()
    expect(w.status.at(-1)).toContain('ping at 2:40pm (held 50m)')
  })

  test('an unanswered fork stops the window with a reason', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { forks: ['unanswered'] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN + 1)
    await flush()
    expect(w.status.at(-1)).toBe('stopped: ping not sent (nothing-to-fork) · ctx 200.5k · 1 call · 200k cache turn · 99% from cache, 93% saved')
  })
})

// The cost slot carries two shares, and they are different kinds of figure. The
// hit rate measures the turn that just ran. The saving is a *rate*: both prices
// are `context × rate`, so the context divides out of their ratio and what is left
// is the model's two rates — the same figure at every context size. The slot used
// to carry that ratio as a cost (7%, lower is better), which could not move at all.
describe('the cost slot', () => {
  test('the saving is the same at every context size, because the context cancels', () => {
    // Doubling both prices is what doubling the context does to them.
    expect(savedPct(0.0020, 0.03)).toBe(93)
    expect(savedPct(0.0040, 0.06)).toBe(93)
    // Opus has its own pair of rates, so its own constant.
    expect(savedPct(0.005, 0.0348)).toBe(86)
  })

  test('a saving is null when nothing can be computed from it', () => {
    expect(savedPct(null, 0.03)).toBe(null)
    expect(savedPct(0.0020, null)).toBe(null)
    // A zero baseline has no share to take, as the cost share already holds.
    expect(savedPct(0.0020, 0)).toBe(null)
  })

  test('a hit rate that is real but not whole reads 99%, never 100%', () => {
    // 200k of a 200.5k prompt is 99.75%: rounding to whole would claim the cache
    // carried a prompt it did not, which is the mirror of the `<1%` rule.
    expect(hitPct(200000, 200502)).toBe('99%')
    expect(hitPct(100, 100)).toBe('100%')
    // Nothing measured yet: no share to state.
    expect(hitPct(0, 0)).toBe('')
  })

  test('a surcharge keeps its signed money, because a percentage could not say it', () => {
    // A model whose read rate is above its input rate: `-14% saved` would be a
    // saving with a minus sign, and `0% saved` would mean two different things.
    expect(costSlotText('99%', -14, 0.03)).toBe('+$0.03')
    // Zero is likewise a real answer rather than a rate.
    expect(costSlotText('99%', 0, 0)).toBe('+$0.00')
  })

  test('the slot pairs the two shares, and states whichever it has', () => {
    expect(costSlotText('99%', 93, -0.08)).toBe('99% from cache, 93% saved')
    // The degenerate case: no turn measured, so no hit rate. The plugin reaches no
    // such state — the slot needs a context, and the turn that reports one is the
    // turn that names the model the rates come from — but the formatter does not
    // invent a figure it does not have.
    expect(costSlotText('', 93, -0.08)).toBe('93% saved')
    // No rates at all: the unknown keeps its own form, as it always has.
    expect(costSlotText('', null, null)).toBe('n/a')
  })
})

// The status line is a value the app holds until something sets it again, so
// anything in it that measures forward decays as it is held: `6h00m left`, read
// forty minutes after it was written, overstates what is left by forty minutes,
// and nothing on the row corrects it. The row therefore names the moments
// themselves, which say the same thing at every reading.
describe('the clock the row names', () => {
  test('fmtClock reads the host zone on the twelve-hour clock', () => {
    // Both the instant and its formatting are built from local components, so the
    // expectation holds in any zone rather than only where the author sat.
    const now = new Date(2026, 9, 12, 13, 0, 0).getTime()
    expect(fmtClock(new Date(2026, 9, 12, 19, 0, 0).getTime(), now)).toBe('7:00pm')
    expect(fmtClock(new Date(2026, 9, 12, 13, 5, 0).getTime(), now)).toBe('1:05pm')
    // Midnight and noon are the two hours a bare `h % 12` would print as `0`.
    expect(fmtClock(new Date(2026, 9, 12, 0, 30, 0).getTime(), now)).toBe('12:30am')
    expect(fmtClock(new Date(2026, 9, 12, 12, 0, 0).getTime(), now)).toBe('12:00pm')
  })

  test('a moment on another day carries its weekday, so the row cannot be read as today', () => {
    // 12 October 2026 is a Monday; 13 October is the Tuesday after it.
    expect(fmtClock(new Date(2026, 9, 13, 1, 0, 0).getTime(), new Date(2026, 9, 12, 13, 0, 0).getTime())).toBe('Tue 1:00am')
  })

  test('a held row is not rewritten as time passes, and does not need to be', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    const painted = w.status.at(-1)
    // Ten minutes of idle with the ping still forty minutes out: nothing repaints.
    await clock.advance(10 * MIN)
    await flush()
    expect(w.status.at(-1)).toBe(painted)
    // And the figures held across that gap are still the true ones — the whole
    // reason the row names a moment rather than a wait.
    expect(painted).toContain('ends 7:00pm · ping at 1:50pm')
  })

  test('a turn moves the ping with it, and leaves the window where it was', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toContain('ping at 1:50pm')
    // A turn at 1:20pm re-arms the ping from itself, fifty minutes on.
    await clock.advance(20 * MIN)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toContain('ping at 2:10pm')
    // The window's own end does not move: a turn does not extend the budget.
    expect(w.status.at(-1)).toContain('ends 7:00pm')
  })

  test('a window that ends on another day says which day', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, {})
    await $.session.start(session)
    await $.turn.complete(turn())
    // Armed at 1:00pm for twelve hours, so it ends at 1:00am the next morning.
    await $.command.run(run('keepwarm', '12h'))
    expect(w.status.at(-1)).toContain('ends Tue 1:00am')
  })
})

describe('user-supplied rates', () => {
  test('ratesFor is null for an unconfigured model', () => {
    expect(ratesFor(UNCONFIGURED)).toBe(null)
  })

  test('ratesFor returns the configured four rates for a configured model', () => {
    expect(ratesFor(MODEL)).toEqual(RATES[MODEL])
  })

  test('/cache-tax on a configured model shows all four rates, labeled user-supplied', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { model: MODEL })
    await $.session.start(session)
    await $.turn.complete(turn())
    const result = await $.command.run(run('cache-tax', ''))
    // The comparison is shown as costs for the context in hand, each against the
    // uncached price, so no per-million rate appears in the card at all.
    expect(result.text).toMatch(/cost        for 200\.5k tokens   no cache \$0\.09 = 100%/)
    expect(result.text).toMatch(/from cache \$0\.0060 = 7% of that/)
    expect(result.text).toMatch(/re-write \$0\.00 = 0% of that/)
    expect(result.text).not.toMatch(/USD\/MTok/)
    expect(result.text).not.toMatch(/unit prices/)
    // Fable's read rate is far below its input rate, so the cache is a saving
    // and the card must say so with a negative figure, not a positive one.
    // A saving renders in parentheses, so the card must not print a bare minus.
    expect(result.text).toMatch(/cache effect  \(\$0\.08\) for this context/)
    expect(result.text).not.toMatch(/cache effect  -/)
    expect(result.text).not.toMatch(/cache effect  \+/)
    expect(result.text).not.toMatch(/none configured/)
    // A zero cache-write rate means warming can never pay for itself.
    expect(result.text).toMatch(/warming cannot pay for itself at these rates/)
  })

  test('the Opus row carries its own four rates, not the Fable ones', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { model: 'claude-opus-5-5' })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-opus-5-5' }) }))
    const result = await $.command.run(run('cache-tax', ''))
    expect(result.text).toMatch(/cost        for 200\.5k tokens   no cache \$0\.0070 = 100%/)
    // The Opus read rate is about a seventh of its input rate, which the share
    // makes plain: the cache is a saving here, and the figure says so without a
    // rate table being read.
    expect(result.text).toMatch(/from cache \$0\.0010 = 14% of that/)
    // Its write rate is still zero, so a cold re-write is billed at nothing and
    // warming is a net cost — the card must not imply otherwise.
    expect(result.text).toMatch(/warming cannot pay for itself at these rates/)
    expect(result.text).not.toMatch(/0\.43/)
    expect(result.text).not.toMatch(/USD\/MTok/)
  })

  test('/cache-tax on an unconfigured model shows no cost line', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { model: UNCONFIGURED })
    await $.session.start(session)
    // The turn's own usage carries the model, so it must be the unconfigured one.
    await $.turn.complete(turn({ usage: usage({ model: UNCONFIGURED }) }))
    const result = await $.command.run(run('cache-tax', ''))
    expect(result.text).toMatch(/cost        none configured for this model/)
    expect(result.text).not.toMatch(/cache effect/)
  })

  test('unconfigured costs are n/a, never NaN or Infinity', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { model: UNCONFIGURED, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: UNCONFIGURED }) }))
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    const warning = w.status.at(-1) ?? ''
    expect(warning).toMatch(/n\/a/)
    expect(warning).not.toMatch(/NaN|Infinity/)
    const card = (await $.command.run(run('cache-tax', ''))).text
    expect(card).not.toMatch(/NaN|Infinity/)
  })

  test('command output never leaks another settings value', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { model: MODEL, settings: {
      policy: { modelPricing: { multiplier: 1, overrides: {} }, env: { SYNTHETIC_SECRET: 'never-display-this' } },
    } })
    await $.session.start(session)
    const result = await $.command.run(run('cache-tax-diagnostic', ''))
    expect(result.text).not.toMatch(/never-display-this|SYNTHETIC_SECRET/)
  })
})

describe('the band above the prompt', () => {
  test('measures against the autocompact window, not the model\'s', async ($, on) => {
    mock.clock(on, { now: START })
    // A 1M model window, but /autocompact holds this session at 362k. Measuring
    // against the model's window would report 20% where the truth is 55%.
    world(on, { live: { tokens: 200000 }, window: 1000000, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($)
    expect(band?.text).toContain('200k / 362k (55%)')
    expect(band?.text).not.toContain('1000k')
  })

  test('the breakdown is asked for the free way, never the full one', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    // `full` sends one token-count request per tool and per memory file; `summary`
    // sends none. The mod must never ask for `full`.
    expect(w.usageArgs.length).toBeGreaterThan(0)
    expect(w.usageArgs.filter(a => a?.breakdown === 'full')).toEqual([])
  })

  test('falls back to the model window when the host offers no breakdown', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, window: 1000000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($)
    expect(band?.text).toContain('200k / 1M (20%)')
  })

  test('a saving reports signed money on status, not on the band', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 299912 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 141912 }) }))
    // Fable reads at 0.03 against an input of 0.43, so the cache lowers the bill.
    // The band carries the window/tokens readout with no money; status line carries signed money.
    const band = await bandOf($)
    expect(band?.text).not.toContain('($0.12)')
    expect(band?.text).not.toMatch(/[-+]\$/)
    expect(w.status.at(-1)).toBe('off · 99% from cache, 93% saved · /keepwarm to arm the window · /cache-tax for the full card')
  })

  // No row in the table has a read rate above its input rate any more, so the
  // surcharge shape is reached through the formatter's own test rather than
  // through a model. This one holds the two-figure slot on the second model.
  test('the second model reports its own two costs on status, and no money on the band', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { model: 'claude-opus-5-5', live: { tokens: 299912 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-opus-5-5' }) }))
    // Opus reads at 0.005 against an input of 0.0348, so the cache lowers it.
    const band = await bandOf($)
    expect(band?.text).not.toContain('$0.0015')
    expect(band?.text).not.toMatch(/[-+]\$/)
    expect(w.status.at(-1)).toBe('off · 99% from cache, 86% saved · /keepwarm to arm the window · /cache-tax for the full card')
  })

  test('a survey holds the band, and the hook yields to it', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    expect(await bandOf($, { hasSurvey: true })).toBe(null)
  })

  test('the band is not drawn while the Original Mod owns the session', async ($, on) => {
    mock.clock(on, { now: START })
    // The Original Mod has already registered these names, so this mod claims
    // none — and must then stay silent rather than speak for a session it does
    // not own.
    world(on, { live: { tokens: 200000 }, rawMax: 362000, commands: ['keepwarm', 'cache-tax', 'cache-tax-diagnostic'] })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    expect(await bandOf($)).toBe(null)
  })

  test('where the band is raised the line carries the state and the hints, not the readout', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    // The band says the readout in colour, so this slot says the rest: whether
    // warming is on, and what to run. Saying the readout again would be noise.
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
    expect(w.status.at(-1) ?? '').not.toMatch(/ctx /)
  })

  test('no band is drawn before there is a window to measure against', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { window: 0 })
    await $.session.start(bandSession)
    expect(await bandOf($)).toBe(null)
  })
})

// The surface that decides the status line is asked fresh each paint, not read
// from the one frozen at session start: a client can attach after that event,
// when `e.surface` was still null. The captured value is still reported, so the
// card's own line keeps the pair distinct.
describe('the live surface roster decides the status line', () => {
  test('a live desktop surface takes the readout off the line even when the captured surface is empty', async ($, on) => {
    mock.clock(on, { now: START })
    // A client attached after start: the start event saw no surface, the roster now says desktop.
    const w = world(on, { live: { tokens: 200000 }, surfaces: ['desktop'] })
    await $.session.start({ ...session, surface: null })
    await $.turn.complete(turn())
    // The captured value is `''`, which raises no band. The live roster is what
    // decides, so the readout must not be here — and the hint line must be.
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
    expect(w.status.at(-1) ?? '').not.toMatch(/ctx /)
  })

  test('a live vscode surface draws the readout', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { surfaces: ['vscode'] })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(IDLE_FOOTER)
  })

  test('a session drawing on several surfaces at once takes the readout off the line', async ($, on) => {
    mock.clock(on, { now: START })
    // A terminal and a phone: the band is up on the terminal, so the readout stays off the line.
    const w = world(on, { live: { tokens: 200000 }, surfaces: ['terminal', 'vscode'] })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
    expect(w.status.at(-1) ?? '').not.toMatch(/ctx /)
  })
})

// A turn's usage is its model calls summed, so the cache read is a quantity read
// this turn, never a size the cache holds — and the call count is the fact that
// makes a figure larger than the context legible rather than a miscount.
describe('the cache read is a per-turn quantity, not a size held', () => {
  test("the readout names the calls the read came over, never a cache size", async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/· 1 call · 200k cache turn ·/)
    expect(w.status.join('\n')).not.toMatch(/cached/)
  })

  test('a long agentic turn reports the calls it made, so its read reads as a total', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 155200 }, rawMax: 362000 })
    await $.session.start(bandSession)
    // Fourteen model calls, each re-reading the same 155.2k context from cache.
    for (let i = 0; i < 14; i++) await callStep($, i)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 2200000 }) }))
    const band = await bandOf($)
    // The count is what stops `2.2M` reading as a miscount beside a 155.2k context.
    expect(band?.text).toContain('14 calls / 2.2M cache turn')
    const text = (await $.command.run(run('cache-tax', ''))).text
    expect(text).toMatch(/cache       2,200,000 tokens served from cache this turn over 14 calls — 99% of the turn's prompt, ≈14 × the 155\.2k context/)
    // The old line claimed a share of context and capped it at 100%; that claim is gone.
    expect(text).not.toMatch(/% of context/)
  })

  test('a turn that reported no step is still one call, never zero', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toContain('1 call · ')
    // The floor is one: a zero here would read as a turn that cost nothing.
    expect(w.status.at(-1)).not.toContain('0 calls')
  })

  test('a single-call turn says the read plainly, with no noisy ≈1 ×', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    const text = (await $.command.run(run('cache-tax', ''))).text
    expect(text).toMatch(/cache       200,000 tokens served from cache this turn over 1 call — 99% of the turn's prompt\n/)
    // A multiple is only named when the call count explains it; one call cannot.
    expect(text).not.toMatch(/≈1 ×/)
    expect(text).not.toMatch(/≈/)
  })
})

describe('the card reports both surfaces', () => {
  test('the surfaces line names the captured surface and the live roster', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, surfaces: ['desktop', 'vscode'] })
    await $.session.start(session)
    const text = (await $.command.run(run('cache-tax', ''))).text
    expect(text).toMatch(/surfaces    captured vscode · live desktop, vscode/)
  })

  test('the surfaces line reads sensibly when both are empty', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, surfaces: [] })
    await $.session.start({ ...session, surface: null })
    const text = (await $.command.run(run('cache-tax', ''))).text
    expect(text).toMatch(/surfaces    captured \(none\) · live \(none\)/)
  })
})

// A cold resume is the engine's own computed fields for a settings hook; the
// notice it seeds is what a person reads once and acts on, so it belongs on the
// status line rather than in the transcript.
const resume: Parameters<Engine['classic']['SessionStart']>[0] = {
  source: 'resume', model: MODEL, context_tokens: 200000,
  seconds_since_last_response: 2 * HOUR, prompt_cache_likely_expired: true,
}

// The status line shares one row with the model picker, and the app clips what
// does not fit. So a notice is written to a budget rather than to a sentence,
// and this is that budget: the longest notice the mod is allowed to raise.
const NOTICE_MAX = 44

describe('status-line notices', () => {
  test('a cold resume pins the notice on the band surface, and the turn clears it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.classic.SessionStart(resume)
    // The band surface normally leaves the status line empty, but a notice is not
    // the readout: it is pinned wherever it is set, the band's own surface included.
    expect(w.status.at(-1)).toMatch(/^cold resume · /)
    expect((w.status.at(-1) ?? '').length).toBeLessThanOrEqual(NOTICE_MAX)
    await $.turn.complete(turn())
    // No cold write this turn, so the notice is cleared and the line is the hint
    // line again — which is what the band surface shows when no notice is up.
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
  })

  test('a notice outranks the fallback on a surface the band never reaches', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    // With no notice the readout is the fallback facts.
    expect(w.status.at(-1) ?? '').toMatch(/^off · /)
    await $.classic.SessionStart(resume)
    // A live notice takes precedence over them.
    expect(w.status.at(-1)).toMatch(/^cold resume · /)
    expect(w.status.at(-1) ?? '').not.toMatch(/^off · /)
  })

  test('a cold write is a status notice that survives its turn and is cleared by the next', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { store: new Map(), live: { tokens: 100000 } })
    await $.session.start(session)
    // A full rewrite this turn: 60k written against a 100k context.
    await $.turn.complete(turn({ usage: usage({ cache_creation_input_tokens: 60000 }) }))
    expect(w.status.at(-1)).toMatch(/^cold write 60k · /)
    expect((w.status.at(-1) ?? '').length).toBeLessThanOrEqual(NOTICE_MAX)
    // The transcript no longer carries it.
    expect(w.logs.join('\n')).not.toMatch(/cold write/)
    // It outlives its own turn; the next ordinary turn clears it and the readout returns.
    await $.turn.complete(turn())
    expect(w.status.at(-1) ?? '').toMatch(/^off · /)
  })

  test('the command-name clash stays a transcript line, never a status notice', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { commands: ['keepwarm'] })
    await $.session.start(session)
    // The setup diagnostic is read back later, so it keeps to the transcript.
    expect(w.logs.join('\n')).toMatch(/\/keepwarm is already registered by another plugin/)
    expect(w.status.join('\n')).not.toMatch(/already registered/)
  })
})

// Where the band is raised the readout is already on screen in colour, so this
// slot is free. It carries what the band does not: whether warming is on, and
// the command worth running. The overflow past the slot's width is the surface's
// to reveal on hover, so the line is written whole rather than trimmed.
describe('the line the band frees', () => {
  test('nothing armed offers to start a window', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
  })

  test('an armed window names the state, the ping, and nothing to run but the card', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    // Armed and warm: a ping is already coming, so there is nothing to suggest
    // and the line does not invent one.
    expect(w.status.at(-1)).toBe('on · ends 7:00pm · ping at 1:50pm · 99% from cache, 93% saved · /cache-tax for the full card')
  })

  test('a window that stopped says why, and offers to start another', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    // The first ping fires 50m in, and this build's fork answers nothing-to-fork,
    // so the window stops there. A stopped window is not an unarmed one, and the
    // line is the only place that difference is visible outside the card.
    await clock.advance(51 * MIN)
    await flush()
    expect(w.status.at(-1)).toBe(
      'stopped: ping not sent (nothing-to-fork) · 99% from cache, 93% saved · /keepwarm to arm the window · /cache-tax for the full card',
    )
  })

  test('a notice still outranks the line', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.classic.SessionStart(resume)
    expect(w.status.at(-1)).toMatch(/^cold resume · /)
  })
})

// The cache-turn slot is the turn just gone; the session total is what the cache
// has served since /clear. Both are shown, because they answer different
// questions: what this turn cost, and what the cache has been worth overall.
describe('the session read total', () => {
  test('accumulates over turns and names the turn count on the card', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-tax', ''))
    // Two turns of the fixture's 200k read each.
    expect(card.text).toMatch(/usage       400,000 tokens served from cache over 2 turns since \/clear/)
  })

  test('one turn is reported as one turn, not one turns', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/over 1 turn since \/clear/)
  })

  test('the band carries the running total beside the turn it continues', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    const band = await bandOf($)
    expect(band?.text).toContain('1 call / 200k cache turn')
    expect(band?.text).toContain('400k session')
  })

  test('the band shows no session slot before a turn has reported one', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    const band = await bandOf($)
    expect(band?.text ?? '').not.toContain('this session')
    expect(band?.text ?? '').not.toContain('usage')
  })

  test('/clear starts the tally over, because it starts the conversation over', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.classic.SessionStart({ ...resume, source: 'clear' })
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).not.toMatch(/usage/)
    expect(card.text).not.toMatch(/session read/)
  })
})

describe('approved band and status split', () => {
  test('exact approved split and field order across band and status line', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    await $.turn.complete(turn())
    // 1. Band: forecast · <ctx tokens> of <window tokens> (<pct>%) · sparkline · trend · <n> to go · <n> calls / <n> cache turn · <n> session
    const band = await bandOf($, { columns: 120 })
    // The fixture's threshold stands in for the engine's: `rawMax` less 20000, so
    // 362k less 20k against a 200k context leaves 142k to go.
    expect(band?.text).toBe('☂  Showers  200k / 362k (55%)  ·  ▄▄  ·  steady  ·  142k to go (39.2%)  ·  1 call / 200k cache turn  ·  400k session')
    // No warming state, ping, money, or hints in band
    expect(band?.text).not.toMatch(/keepwarm|ping|left|\$|\/keepwarm|\/cache-tax/)

    // 2. Status unarmed: off · signed effect · /keepwarm to arm the window · /cache-tax for the full card
    expect(w.status.at(-1)).toBe('off · 99% from cache, 93% saved · /keepwarm to arm the window · /cache-tax for the full card')

    // 3. Status armed: on · ends <clock> · [ping] · signed effect · /cache-tax for the full card
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('on · ends 7:00pm · ping at 1:50pm · 99% from cache, 93% saved · /cache-tax for the full card')
    // Separate state and time with middot not comma
    expect(w.status.at(-1)).not.toContain('keepwarm on,')
  })

  // The fixture reads `opts.live.tokens` on every call, so a test can move the
  // context between turns and give the trend something to compare. One mount per
  // test: a second mount under the same requestId has no drawing to hold.
  test('a rise names the move, not the turn it moved on', async ($, on) => {
    mock.clock(on, { now: START })
    const live = { tokens: 200000 }
    world(on, { live, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    live.tokens = 255100
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    expect(band?.text).toContain('▲ +55.1k')
    expect(band?.text).not.toContain('last turn')
  })

  test('a fall names the move too, and carries no sign of its own', async ($, on) => {
    mock.clock(on, { now: START })
    const live = { tokens: 255100 }
    world(on, { live, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    live.tokens = 200000
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    expect(band?.text).toContain('▼ 55.1k')
    expect(band?.text).not.toContain('last turn')
  })

  test('the band carries the distance to autocompact but not the free space', async ($, on) => {
    mock.clock(on, { now: START })
    // The breakdown reports a free row, and the band still leaves it out: free
    // space and the distance to autocompact always track each other, so drawing
    // both read as a near-duplicate. The card reports it instead.
    world(on, { live: { tokens: 200000 }, rawMax: 362000, free: 136600 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    // The distance follows the history, so the fill is no longer beside it.
    expect(band?.text).toContain('142k to go (39.2%)')
    expect(band?.text).not.toContain('136.6k')
    const card = (await $.command.run(run('cache-tax', ''))).text
    expect(card).toMatch(/free        136,600 tokens left in the window \(37\.7%\)/)
  })

  test('the distance to autocompact takes the alarm colour only once the window is red', async ($, on) => {
    mock.clock(on, { now: START })
    // 330k of a 362k window is 91%: past the ramp's red step, and still short of
    // the fixture's threshold at rawMax less 20000, so there is a distance to draw.
    world(on, { live: { tokens: 330000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    expect(band?.text).toContain('12k to go (3.3%)')
    // The slot turns red at the moment the forecast does — one ramp, one threshold,
    // rather than a token count of its own that would suit only one window size.
    expect(band?.colors).toContainEqual({ text: '  ·  12k to go (3.3%)', color: 'red' })
  })

  test('the distance to autocompact stays dim while there is room', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    expect(band?.text).toContain('142k to go (39.2%)')
    // Dim carries no colour prop, which is what `colors` is filtered on: roomy is
    // a fact, not an alarm.
    expect(band?.colors.map(c => c.text)).not.toContain('  ·  142k to go (39.2%)')
  })

  test('a context past the autocompact threshold says so rather than counting up', async ($, on) => {
    mock.clock(on, { now: START })
    // Past the fixture's threshold (rawMax less 20000), which is what /autocompact
    // fires at, so there is no distance left to report.
    world(on, { live: { tokens: 350000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($, { columns: 120 })
    expect(band?.text).toContain('compact due')
    expect(band?.text).not.toMatch(/to go/)
  })

  test('unknown effect reports n/a on status and keeps money off the band', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { model: UNCONFIGURED, live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn({ usage: usage({ model: UNCONFIGURED }) }))
    const band = await bandOf($)
    expect(band?.text).not.toContain('n/a')
    expect(band?.text).not.toMatch(/[-+]\$/)
    expect(w.status.at(-1)).toBe('off · n/a · /keepwarm to arm the window · /cache-tax for the full card')

    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('on · ends 7:00pm · ping at 1:50pm · n/a · /cache-tax for the full card')
  })

  // A zero effect cannot be reached through the engine fixtures: it needs a model
  // whose read and input rates are equal, and the rates table is module-private
  // state that a test cannot write — the exported `RATES` is a different instance
  // from the one the loaded plugin reads. So the formatter is tested directly,
  // which is where the three shapes are actually decided.
  test('the signed effect marks a saving with parentheses, a surcharge with +, and zero with +$0.00', () => {
    expect(fmtSignedUsd(-0.12)).toBe('($0.12)')
    expect(fmtSignedUsd(-0.0013)).toBe('($0.0013)')
    expect(fmtSignedUsd(0.0013)).toBe('+$0.0013')
    // Zero is a real answer, not an unknown, and it never takes parentheses.
    expect(fmtSignedUsd(0)).toBe('+$0.00')
    expect(fmtSignedUsd(null)).toBe('n/a')
  })

  test('a cost is shown as a share of the uncached price, and a small one is not rounded to nothing', () => {
    expect(fmtShare(0.006, 0.086)).toBe(' = 7% of that')
    expect(fmtShare(0.001, 0.00014)).toBe(' = 714% of that')
    // Zero is zero, and says so rather than taking the below-one form.
    expect(fmtShare(0, 0.09)).toBe(' = 0% of that')
    // A share that is real but rounds away keeps its distinction from zero.
    expect(fmtShare(0.0001, 0.09)).toBe(' = <1% of that')
    expect(fmtShare(0.0008, 0.09)).toBe(' = <1% of that')
    // Exactly one per cent is a whole per cent, not a below-one one.
    expect(fmtShare(0.0009, 0.09)).toBe(' = 1% of that')
    // Unknown at either end, and a baseline a share cannot be taken of.
    expect(fmtShare(null, 0.09)).toBe('')
    expect(fmtShare(0.006, null)).toBe('')
    expect(fmtShare(0.006, 0)).toBe('')
  })

  test('no signed money reaches the band', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    await $.turn.complete(turn())
    const band = await bandOf($)
    expect(band?.text).not.toMatch(/\(?\$\d/)
    expect(band?.text).not.toMatch(/n\/a/)
    expect(w.status.at(-1)).toBe(HINT_FOOTER)
  })

  test('no-context case omits effect from status and cache/usage labels from band', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { rawMax: 362000 })
    await $.session.start(bandSession)
    const band = await bandOf($)
    expect(band?.text).toBe('☀  Clear  0 / 362k (0%)')
    expect(band?.text).not.toContain('cache')
    expect(band?.text).not.toContain('usage')
    expect(band?.text).not.toMatch(/keepwarm|ping|left|\$|\/keepwarm|\/cache-tax/)
    // Effect is omitted when ctx is 0
    expect(w.status.at(-1)).toBe(NO_CONTEXT_HINT_FOOTER)
  })

  test('a turn that served nothing reports the zero rather than going silent', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, { live: { tokens: 200000 }, rawMax: 362000 })
    await $.session.start(bandSession)
    // A cold turn: the calls happened, and none of them found a cache.
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0 }) }))
    const band = await bandOf($)
    // The zero is a reading, not an absence: the turn made calls and the cache
    // served none of them, which is exactly the thing worth knowing.
    expect(band?.text).toContain('1 call')
    expect(band?.text).toContain('0 cache turn')
    // The session total has nothing to add to that, so it stays out.
    expect(band?.text).not.toContain('usage')

    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/cache       none served from cache over 1 call — the last turn reported nothing/)
  })
})
