import { expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, CommandSpec, On, Settings, SettingsSource } from 'claude-code'

tier('user')

// A surface the band is not raised on: these tests are about the status line,
// which is the fallback there. The band has its own session and its own tests.
const session = { surface: 'vscode' as const, isInteractive: true, cwd: '/synthetic' }
const run: CommandRunInput = { command: 'cache-tax-diagnostic', args: '',
  origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
const zeroPricing = { multiplier: 2, overrides: {
  'gateway-alias': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} }

function world(on: On, sources: Partial<Record<SettingsSource | 'merged', Settings>>) {
  const status: Array<string | undefined> = []
  const commands: CommandSpec[] = []
  const reads: string[] = []
  let modelCalls = 0
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: { window: 1000000, tokens: 0 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'gateway-alias' }))
  on('settings.read', ($, e) => {
    const source = e.source ?? 'merged'
    reads.push(source)
    return { value: sources[source] ?? {} }
  })
  on('command.list', () => ({ value: [] }))
  on('command.register', ($, e) => { commands.push(e); return { value: { command: e.name } } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('model.fork', () => { modelCalls++; throw new Error('Inference is forbidden') })
  on('model.complete', () => { modelCalls++; throw new Error('Inference is forbidden') })
  return { status, commands, reads, modelCalls: () => modelCalls }
}

// The Custom Mod registers its two warming commands plus the diagnostic on
// session start, none on again, and paints no status line of its own.
function assertNoInference(w: ReturnType<typeof world>) {
  expect(w.commands).toEqual([
    { name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (token-tax-weather)',
      argumentHint: '[6h | always | off | status]', immediate: true },
    { name: 'cache-tax',
      description: "Prompt cache state, cold price and this session's cold writes (token-tax-weather)",
      argumentHint: '[status]', immediate: true },
    { name: 'cache-tax-diagnostic',
      description: 'Read-only pricing provenance diagnostic; no inference or warming.', immediate: true },
  ])
  // Only the command run itself reads settings: session start never does.
  expect(w.reads).toEqual(['policy', 'user', 'project', 'local', 'flag', 'merged'])
  expect(w.modelCalls()).toBe(0)
}

test('Desktop command and footer preserve a managed zero-priced exact row without exposing other settings', async ($, on) => {
  const w = world(on, { policy: { modelPricing: zeroPricing, env: { SYNTHETIC_SECRET: 'never-display-this' } },
    user: { modelPricing: { overrides: { 'gateway-alias': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } } } },
    merged: { modelPricing: zeroPricing } })
  await $.session.start(session)
  const result = await $.command.run(run)
  // No plugin-name prefix: the host already prints which command ran.
  expect((result.text ?? '').split('\n')[0]).toBe('Pricing diagnostic (read-only)')
  expect(result.text).toMatch(/Active model: gateway-alias/)
  expect(result.text).toMatch(/Desktop-managed pricing: accepted pricing available/)
  expect(result.text).toMatch(/Managed policy exact model override/)
  expect(result.text).toMatch(/input=0; output=0; cacheRead=0; cacheWrite=0/)
  expect(result.text).toMatch(/Multiplier: 2/)
  expect(result.text).toMatch(/Behavior: nothing here warms or sends on its own/)
  expect(result.text).not.toMatch(/never-display-this|SYNTHETIC_SECRET|input=9/)
  // The session start paints the compact label, and the command run paints it again.
  expect(w.status).toEqual([
    'off · no context yet',
    'off · no context yet',
  ])
  assertNoInference(w)
})

test('ignored ordinary pricing in the merge is not accepted or displayed as selected rates', async ($, on) => {
  const w = world(on, { user: { modelPricing: zeroPricing }, merged: { modelPricing: zeroPricing } })
  await $.session.start(session)
  const result = await $.command.run(run)
  expect(result.text).toMatch(/Desktop-managed pricing: pricing unavailable/)
  expect(result.text).toMatch(/Merged exact row matches ignored user settings/)
  expect(result.text).toMatch(/user: modelPricing present \(ignored by host pricing\)/)
  expect(result.text).not.toMatch(/Selected rates|Multiplier:|accepted pricing available/)
  expect(w.status.at(-1)).toBe('off · no context yet')
  assertNoInference(w)
})

test('absent pricing is explicit about unavailable SDK fallback and canonical matching', async ($, on) => {
  const w = world(on, {})
  await $.session.start(session)
  const result = await $.command.run(run)
  expect(result.text).toMatch(/Desktop-managed pricing: pricing unavailable/)
  expect(result.text).toMatch(/host SDK fallback may not appear in settings/)
  expect(result.text).toMatch(/canonical matching is unimplemented/)
  expect(result.text).not.toMatch(/Selected rates|Multiplier:/)
  assertNoInference(w)
})

test('unattributed merged row remains candidate and never claims accepted fallback', async ($, on) => {
  const w = world(on, { merged: { modelPricing: zeroPricing } })
  await $.session.start(session)
  const result = await $.command.run(run)
  expect(result.text).toMatch(/Desktop-managed pricing: candidate\/unconfirmed/)
  expect(result.text).toMatch(/UNCONFIRMED/)
  expect(result.text).toMatch(/Do not use for costs/)
  expect(result.text).not.toMatch(/accepted pricing available/)
  expect(w.status.at(-1)).toBe('off · no context yet')
  assertNoInference(w)
})

for (const [name, input, multiplier] of [
  ['rate above 10000', 10001, 1],
  ['zero multiplier', 0, 0],
  ['multiplier above 10', 0, 11],
] as const) {
  test(`invalid managed pricing is unavailable: ${name}`, async ($, on) => {
    const pricing = { multiplier, overrides: {
      'gateway-alias': { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    } }
    const w = world(on, { policy: { modelPricing: pricing }, merged: { modelPricing: pricing } })
    await $.session.start(session)
    const result = await $.command.run(run)
    expect(result.text).toMatch(/Desktop-managed pricing: pricing unavailable/)
    expect(result.text).toMatch(/rates in 0\.\.10000/)
    expect(result.text).toMatch(/multiplier >0 and <=10/)
    expect(result.text).not.toMatch(/Selected rates|accepted pricing available/)
    assertNoInference(w)
  })
}
