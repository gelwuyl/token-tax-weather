# token-tax-weather

Context weather and cache-served token counts above the prompt; warming state,
a price comparison, and suggested commands beside the model picker.

- **The band** answers what the context window is doing: how full it is, how much
  room is left, how far away `/autocompact` is, and how many tokens the prompt
  cache served.
- **The status line** carries whether `/keepwarm` is armed, when it will ping, and
  what the cache-read rate means for the current context — or, where the band is
  not drawn, the same window facts in a compact form.
- **Notices** temporarily replace the status line's normal text when something
  needs attention.

## Install

```text
/plugin marketplace add gelwuyl/token-tax-weather
/plugin install token-tax-weather@token-tax-weather
```

Or, with the `claude` CLI:

```bash
claude plugin marketplace add gelwuyl/token-tax-weather
```

```bash
claude plugin install token-tax-weather@token-tax-weather
```

The band is supported on **desktop** and **terminal**. When no connected surface
supports the band, the status line carries a compact **fallback** instead. The
fallback is not an extra readout alongside the band.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a six-hour warming window, with a ping after 50 minutes of idle time |
| `/keepwarm 90m`, `/keepwarm 2h30m`, `/keepwarm 6h` | Arms a window of that length |
| `/keepwarm 6h every 20m` | Uses a 20-minute idle interval; the window must come before `every` |
| `/keepwarm always` | Same six-hour window as the bare command, for compatibility with `cache-tax`; not unbounded or remembered across sessions |
| `/keepwarm off` | Disarms warming |
| `/keepwarm status` | Reports what is armed |
| `/cache-tax` | Shows the full card: cache state, context, the window and the autocompact threshold, token counts, rates, the price comparison, and warming break-even |
| `/cache-tax-diagnostic` | Read-only report of whether the host exposes pricing information; prints no settings values |

**There is no `/keepwarm on`.** Run bare `/keepwarm` to arm it. A displayed
`keepwarm on` is a state label, not a command. Likewise, `/keepwarm` at the end
of a notice is a suggestion to run that command.

Warming sends model requests and can cost money. Prompt caching can already work
without warming; `/keepwarm` only tries to preserve a cached context during idle
time. It does not enable OpenRouter response caching.

## Display grammar

Square brackets below mean an optional slot; angle brackets mean a value.
The separator between slots is `·`. Slots with no data are omitted, not left blank.
Token counts use `k` or `M`, with up to one decimal and a trailing `.0` dropped.

### The band

```text
<forecast>  <context> / <window> (<percent>%) · [<to go> to go (<to-go%>)] · [sparkline] · [trend] · [<tokens> cache turn] · [<tokens> usage session]
```

The slots, in the order they appear:

| Slot | Forms | Shown when |
| --- | --- | --- |
| **forecast** | `☀ Clear` · `☁ Cloudy` · `☂ Showers` · `☇ Storm` · `↯ Compact soon` | Always. The band is yellow, cyan, blue, magenta or red in that order, at 25%, 50%, 75% and 90% of the window |
| **fill** | `<context> / <window> (<percent>%)` | Always |
| **to go** | `<tokens> to go (<to-go%>)`, or `compact due` once the context has passed the threshold | A context exists and the engine reports an autocompact threshold |
| **sparkline** | up to twelve bars from `▁▂▃▄▅▆▇█`, one bar per recent reading, each bar's height that reading's share of the window | A completed reading exists, and the band is 56 columns or wider |
| **trend** | `▲ +<tokens> last turn` · `▼ <tokens> last turn` · `steady` | Two or more readings exist, and the band is 72 columns or wider |
| **cache** | `<tokens> cache turn` | The last turn served something from cache |
| **usage** | `<tokens> usage session` | Anything has been served since `/clear` |

Shapes, widest to narrowest. The window and the threshold are one session's; the
percentages are the engine's own and need not equal `context ÷ window`.

```text
↯  Compact soon  326.5k / 362k (90%)  ·  compact due  ·  ▅▅▆▆▇▇  ·  ▲ +12k last turn  ·  150.9k cache turn  ·  41.6M usage session
☇  Storm  299.9k / 362k (83%)  ·  20.1k to go (5.6%)  ·  ▃▄▅▅▆▇  ·  ▲ +12k last turn  ·  150.9k cache turn  ·  41.6M usage session
☁  Cloudy  164.1k / 362k (46%)  ·  155.9k to go (43.1%)  ·  ▁▂▃▃▄▅  ·  ▲ +12k last turn
☀  Clear  60.2k / 362k (17%)  ·  259.8k to go (71.8%)
☁  Cloudy  164.1k / 362k (46%)
```

- **Every percentage in the band is of the window**, so all of them are read
  against one denominator.
- **Only the sparkline and the trend are dropped for width.** The token counts and
  the window figures are never dropped.
- **The band reports the window's headroom as `to go` only.** The breakdown also
  carries a free-space row, and the band leaves it out: free space is the window's
  room, while `to go` is the room before `/autocompact` fires, so the two always
  track each other and drawing both read as a near-duplicate. `/cache-tax`
  reports the free figure for anyone who wants it.
- **`to go` is absent until a context exists**, because with nothing in use it
  would only restate the threshold. It reads `compact due` once the context has
  passed the threshold, which is the point `/autocompact` fires.
- **`cache` and `usage` are volumes, not cache sizes.** A turn can make several
  model calls over one context, so a turn's cache-served total can exceed the
  context it was reading. `usage` means **cache-served tokens only** — never all
  input and output tokens, and never total spend. `/clear` resets it; a compaction
  does not.

### The status line

The row beside the model picker is **one line, not a set of tiers**. Two questions
decide what it says:

1. **Is a notice up?** If so, that is the line, and nothing else. A notice outranks
   everything, on every surface, the band's included.
2. **Otherwise, is the band drawing?** That decides which facts the line carries.

So there is a **notice**, and below it a **line with two forms**. Only one of the
two forms can ever draw, and a notice pre-empts both:

| | Drawn when | Carries |
| --- | --- | --- |
| **a notice** | an event needs attention now | what happened, the figure, what to do |
| **the warming form** | no notice, and the band is drawing | warming state, ping, price, command hints |
| **the window form** | no notice, and no surface raises the band | warming state, ping, context, cache, price |

The two forms exist because the band and the line share the work. Where the band
draws it already carries the window, so the line says what the band cannot — the
warming and the command worth running. Where no band draws, nothing else is
showing the window, so the line has to. On the desktop and terminal surfaces you
only ever see the warming form; the window form is for a session attached to VS
Code or a phone.

The app clips this row and reveals the rest on hover, so the plugin writes the
whole string and a long line costs nothing. It is plain text: the price comparison
carries no colour, and the sign is the whole of what it can say.

#### A notice

One-off messages about an event, not the ongoing state. A newer notice replaces
the older one. Each is three parts — what happened, the figure, and what it means
for you:

```text
cold resume · first message ≈<usd>
cold <age> · re-write ≈<usd> · sending
cold write <tokens> · <usd> · /keepwarm
```

| Notice | Raised when |
| --- | --- |
| **resume** | a resumed or forked session's prompt cache is likely expired |
| **guard** | a prompt is sent after the estimated cache lifetime has elapsed |
| **cold write** | a turn records a large fresh cache write |

Examples:

```text
cold resume · first message ≈$4.01
cold 2h00m · re-write ≈$4.01 · sending
cold write 200.5k · $4.01 · /keepwarm
```

A figure the plugin cannot price reads `n/a`, and the resume form then falls back
to `cold resume · the next message re-writes the context`. The resume and guard
notices clear at the end of the turn they belong to; the cold-write notice is
raised at the end of its turn and so outlives it by one. A guard never blocks or
drops a prompt. The rates behind each figure are in `/cache-tax`.

#### The warming form, where the band is drawing

```text
<state> · [<duration> left] · [ping] · [<effect>] · [/keepwarm to arm the window] · /cache-tax for the full card
```

| # | Slot | Forms | Shown when |
| --- | --- | --- | --- |
| 1 | **state** | `keepwarm off` · `keepwarm on` · `keepwarm stopped: <reason>` | Always |
| 2 | **window** | `<duration> left` | A warming window is armed |
| 3 | **ping** | `ping in <duration>` · `ping after first turn` · `ping after next turn` | A warming window is armed |
| 4 | **effect** | `+$<amount>` · `($<amount>)` · `+$0.00` · `n/a` | A context exists |
| 5 | **arm hint** | `/keepwarm to arm the window` | No warming window is armed |
| 6 | **card hint** | `/cache-tax for the full card` | Always |

Examples:

```text
keepwarm off · ($0.09) · /keepwarm to arm the window · /cache-tax for the full card
keepwarm on · 6h00m left · ping in 50m · ($0.09) · /cache-tax for the full card
keepwarm on · 6h00m left · ping after first turn · /cache-tax for the full card
keepwarm on · 6h00m left · ping after next turn · ($0.09) · /cache-tax for the full card
keepwarm stopped: ping not sent (nothing-to-fork) · ($0.09) · /keepwarm to arm the window · /cache-tax for the full card
```

- **`window` is the warming budget**, not a provider-confirmed cache lifetime. It
  is the time left in the window `/keepwarm` armed.
- **The two `ping after` forms** stand in for the countdown while there is no warm
  reading to count from: before the session's first turn, and after the estimated
  cache lifetime has elapsed.
- **The effect is absent before any context exists**, which is why the third
  example has no price.
- **`stopped` names why a window gave up**, which is the difference between a
  window you never armed and one that was armed and stopped.

#### The window form, where no surface raises the band

The same facts, compactly, with the context as a bare token count because there is
no room for the window beside it. It is the warming form plus the window, minus
the hints.

```text
<warming> · [ping] · <context> · [<tokens> cache turn] · [<effect>]
```

| # | Slot | Forms | Shown when |
| --- | --- | --- | --- |
| 1 | **warming** | `off` · `<duration> left` · `stopped: <reason>` | Always |
| 2 | **ping** | As the warming form's | A warming window is armed |
| 3 | **context** | `ctx <tokens>` · `no context yet` | Always |
| 4 | **cache** | `<tokens> cache turn` | The last turn served something from cache |
| 5 | **effect** | As the warming form's | A context exists |

Examples:

```text
off · ctx 199.1k · 190.4k cache turn · ($0.08)
6h00m left · ping in 50m · ctx 199.1k · 190.4k cache turn · ($0.08)
6h00m left · ping after next turn · ctx 199.1k · ($0.08)
off · no context yet
```

- **The forecast, fill, to-go, sparkline, trend, session usage and command hints
  are all dropped here.** This line has no width for them, and there is no
  band above it carrying them either — which is why the window slots are here and
  not there.
- **`warming` drops the `keepwarm` prefix.** The state word is the same, but this
  form is already the longest the row has to hold.

## Reading the price comparison

The **effect** is:

```text
context tokens × (cache-read rate − uncached-input rate) / 1,000,000
```

- **A saving** is shown in parentheses, `($0.12)`: reading this context from
  cache costs less than uncached input. Parentheses are accounting's own mark for
  a credit, and avoid a minus sign that could be read as a hyphen.
- **A surcharge** carries a leading `+`, `+$0.12`: reading it from cache costs
  more than uncached input.
- **Zero** is `+$0.00`: the two input costs are equal. It is a real answer, and it
  never takes parentheses.
- **`n/a`:** no rates are configured for the model.

It is a hypothetical comparison for **one read of the current context**. It is
not the turn's bill, accumulated savings, or warming break-even. Its value does
not tell you whether the cache is warm; it depends only on rates and context
size. The `/cache-tax` card separately explains whether warming can pay for itself.

## The rates

Prices are user-supplied USD per million tokens in `token-tax-weather/hooks/register.ts`:

```ts
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0007, cacheRead: 0.005, cacheWrite: 0, output: 0.6 },
}
```

Rows match the engine's exact model ID, not the picker's display label. A model
with no row shows `n/a`; the plugin never borrows another model's price. With a
zero cache-write price, avoiding a cold write saves nothing, so paid warming
cannot pay for itself at these rates.

## Privacy and limits

The readout uses local token counts and the engine's free context breakdown.
Diagnostics print no settings values. There is no automatic warming or provider
probe. An explicitly armed `/keepwarm` window does send model requests.

Prompt-cache observations do not establish an OpenRouter response-cache hit.
This plugin neither controls nor reports that separate cache's TTL or HIT/MISS.

## Development

```bash
npx -y @anthropic-ai/claude-code@2.1.293 plugin test ./token-tax-weather
```

```bash
npx -y @anthropic-ai/claude-code@2.1.293 plugin validate ./token-tax-weather
```

Tests mount the real surface and inspect its drawn tree. The engine generates
API declarations under `.claude-plugin/types/` when it loads the plugin; they are
gitignored. Type-check after those declarations exist.

## Relation to cache-tax

This supersedes [`cache-tax`](https://www.npmjs.com/package/cache-tax) 2.1.3 and
registers the same `/keepwarm` and `/cache-tax` commands. Enable only one; a plugin
that finds the names already taken skips them and reports the conflict.
