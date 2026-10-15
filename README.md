# token-tax-weather

**A forecast band above the prompt, a quiet state line beside the model picker.**

Every long-running agent session lives under atmospheric pressure. Context accumulates turn by turn, the prompt cache cools in the silence between human thoughts, and autocompaction looms at the window's edge. `token-tax-weather` gives this invisible physics a visible, unobtrusive horizon right where you compose your next thought:

- **The AbovePrompt band** charts the live weather of your context window: current atmospheric fill, remaining headroom before `/autocompact`, a 3-bar trajectory sparkline, directional delta trend, turn cache efficiency, and token generation speed.
- **The status line** anchors persistent telemetry beside the model picker: whether `/keepwarm` is armed, absolute clock times for the next ping and window expiry, cumulative session tokens saved, and the model's rate discount — or, where no connected surface can paint the band, the context facts themselves.
- **A notice** briefly supersedes the status line when a threshold is breached or an action demands attention: cold resumes, expiring caches, and unbudgeted writes.

## Install

```text
/plugin marketplace add gelwuyl/token-tax-weather
/plugin install token-tax-weather@token-tax-weather
```

**With the `claude` CLI:**

```bash
claude plugin marketplace add gelwuyl/token-tax-weather
```

```bash
claude plugin install token-tax-weather@token-tax-weather
```

**The band needs desktop or terminal.** Where no connected surface supports it, the status line carries the window facts itself — a substitution, not an extra readout beside the band.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a six-hour warming window, pinging after 50 minutes of idle |
| `/keepwarm 90m`, `/keepwarm 2h30m`, `/keepwarm 6h` | Arms a window of that length |
| `/keepwarm 6h every 20m` | Starts the search at a 20-minute idle interval; the window must precede `every`. The interval then converges as pings bracket the provider TTL |
| `/keepwarm always` | Six-hour window, for `cache-tax` compatibility; not unbounded, not remembered across sessions |
| `/keepwarm off` | Disarms warming |
| `/keepwarm status` | Reports what is armed |
| `/cache-tax` | The full card: cache state, context, window, autocompact threshold, token counts, rates, price comparison, warming break-even |
| `/cache-tax-diagnostic` | Read-only report of whether the host exposes pricing; prints no settings values |

- **There is no `/keepwarm on`.** Run bare `/keepwarm` to arm it. A displayed `on` is an operational state label, not an executable command.

### How `/keepwarm` works

**Warming is an actual model request, not an HTTP header.** It is a conversation kept alive across silence. Prompt caching is provider-side: the host keeps the processed token prefix in memory, bills a fraction of the input rate to read it, and evicts it after an unadvertised idle duration. Re-sending the prefix resets that timer. A ping does not petition a server to preserve state — it *exercises* the cache, which is the singular physical event that keeps it warm.

- **Arming sends nothing.** It simply arms a quiet timer.
- **When the timer fires**, the plugin invokes the engine's fork, replaying the session's exact prefix — model, system prompt, active tools, and conversation history — capped with a single prompt:
  ```text
  Reply with the single word: warm
  ```
  The call is tool-less, routed through your session's existing authenticated path, and the trailing ping word is never cached.
- **Survival is verified empirically, never assumed.** The reply returns the engine's verified token counts:
  - `read > 0` and `write < 10% read`: The prefix was served warm; the window remains safely armed.
  - `read 0` or a write comparable to the read: The cache has evaporated; the window disarms immediately, logging `the cache was gone` to the status line and `/cache-tax`.

### How the ping interval converges

**`every` defines the starting frontier, not a permanent cadence.** Each ping tests the provider's unadvertised TTL clock against a known idle duration, tightening a binary search bracket around the boundary:

| Ping attempt | Bracket established | Next scheduled ping |
| --- | --- | --- |
| 50m, cold | TTL is strictly under 50m | 25m |
| 25m, warm | TTL is at least 25m | 38m |
| 38m, warm | TTL is at least 38m | 44m |
| 44m, warm | TTL is at least 44m | 47m |
| 47m, cold | TTL is strictly under 47m | 45m |
| 45m, cold | TTL is strictly under 45m | Settles stably at 42m |

The search halts once the bracket narrows to a two-minute margin, locking into the longest proven survival gap less that buffer. This avoids the wasteful polling of naive halving (which would have stuck at 25m, sending nearly 1.8× more requests). Cadence is clamped at one minute minimum, stops immediately if the route caches nothing at all, and persists in session storage so subsequent windows resume at the learned interval.

**Four operational boundaries:**
- **Provider-agnostic by design.** Anthropic explicit breakpoints and automatic gateway prefix caching are both preserved identically through reuse, requiring no custom headers.
- **Warming cannot create caching upstream.** If the harness or provider does not mark the prefix as cacheable, pings record zero reads and the window halts.
- **Gateway response caches are separate.** Router-level whole-response caches (such as OpenRouter's) are orthogonal to prompt caching and unaffected by pings.
- **Warming spends model tokens.** When `cacheWrite` is zero, a cold re-write costs nothing in dollars — so warming protects interactive latency, not financial spend.

## The band

The composer is where intent becomes a prompt. The band sits directly above it, transforming the hidden physics of the engine into quiet peripheral awareness — so you sense the weight of the conversation and the proximity of compaction before you press Return.

```text
<forecast>  <context> / <window> (<percent>%) · [sparkline] · [trend] · [<to go> to go (<to-go%>)] · [<n> calls / <tokens> cache / <hit>%] · [<speed> tok/s]
```

**Slots with no data are omitted, never left blank; `·` separates slots and `/` separates fields within one.** Token counts use `k` or `M`, to one decimal place, trailing `.0` dropped.

**The coloured slots lead.** The forecast, the fill, and the sparkline share the forecast's hue, anchoring the visual weight on the left; the dim operational metrics follow in quiet alignment.

| Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- |
| **forecast** | `☀ Clear` · `☁ Cloudy` · `☂ Showers` · `☇ Storm` · `↯ Compact soon` | Always | The atmospheric barometer: yellow (<25%), cyan (25–50%), blue (50–75%), magenta (75–90%), and red (90%+). The forecast sets the dominant color for the entire leading group |
| **fill** | `<context> / <window> (<percent>%)` | Always | The engine's empirical ground truth — the actual prompt footprint ingested by the model on the last turn, measured against the window ceiling. Both the fill percentage and headroom `to go` share this exact denominator |
| **sparkline** | up to three bars from `▁▂▃▄▅▆▇█` | A completed reading exists, and 56+ columns | A three-bar seismic trajectory. Scaled against the window and painted in the forecast's hue, showing whether context is cresting or stabilizing across recent turns without demanding numeric reading |
| **trend** | `▲ +<tokens>` · `▼ <tokens>` · `steady` | Two or more readings, and 72+ columns | Directional velocity of context since the last turn. The glyph carries direction; color communicates consequence: green on reduction (`▼`), yellow on growth (`▲`), urgent red when growth enters `Compact soon`, and dim for quiet equilibrium (`steady`) |
| **to go** | `<tokens> to go (<to-go%>)` · `compact due` | A context exists, and the engine reports an autocompact threshold | Remaining headroom before `/autocompact` triggers and shears history. Stays unobtrusively dim while headroom remains; flashes red in exact synchrony with the forecast ramp at 90% |
| **turn cache** | `<n> calls / <tokens> cache / <hit>%` | A turn has completed | The mechanical efficiency of the turn just gone: roundtrip model calls, prompt tokens served warm from cache, and cache hit percentage. Never silent: cold turns report `0 cache / 0%` with honest precision |
| **speed** | `<speed> tok/s` | Generation timing is recorded | Model generation throughput averaged across all calls of the completed turn |

**Widest to narrowest:**

```text
↯  Compact soon  326.5k / 362k (90%)  ·  ▆▇█  ·  ▲ +12k  ·  compact due  ·  42 calls / 13.7M cache / 99%  ·  68 tok/s
☇  Storm  299.9k / 362k (83%)  ·  ▄▅▆  ·  ▲ +12k  ·  20.1k to go (5.6%)  ·  42 calls / 12.6M cache / 99%  ·  68 tok/s
☁  Cloudy  164.1k / 362k (46%)  ·  ▂▃▄  ·  ▲ +12k  ·  155.9k to go (43.1%)  ·  1 call / 164.1k cache / 99%
☀  Clear  60.2k / 362k (17%)  ·  259.8k to go (71.8%)  ·  1 call / 0 cache / 0%
☁  Cloudy  164.1k / 362k (46%)  ·  1 call / 0 cache / 0%
```

- **Every percentage in the band shares the window as its single denominator**, preventing misleading mental conversions across varying bases.
- **Only the sparkline and trend drop under narrow viewports.** Concrete metrics remain anchored for as long as terminal width allows.
- **The turn cache slot unifies three interdependent facts** — model calls, cache volume, and hit rate. Dividing cache volume by calls reveals the effective context carried per step.
- **`cache` reports zero rather than fading into silence.** A cold turn explicitly prints `0 cache / 0%`, confirming the cache served nothing rather than leaving the operator to wonder if telemetry dropped.
- **The session token count lives on the status line**, keeping the AbovePrompt band dedicated to the tactical dynamics of the current turn.
- **The fill is the engine's reported input side, not a synthetic sum of category estimates.** It represents the exact input tokens the model processed (uncached, cache-read, and cache-written combined). `/cache-tax` prints both `context` and `rows` side by side so discrepancies in local category estimates remain transparent.
- **Headroom is reported solely as `to go` to compaction.** Rather than confusing users with multiple conflicting free-space numbers, `to go` measures the true operational distance from current fill to the autocompact threshold.

## The status line

**The band is live atmospheric weather; the status line is grounded operational navigation.** It sits beside the model picker, providing a single consolidated status readout that prioritizes urgent events over ongoing background state.

| The line | Drawn when | Carries |
| --- | --- | --- |
| **a notice** | an event demands immediate attention | what happened, the cost impact, and what to do — an ephemeral high-priority alert that outranks all standard telemetry |
| **the desktop and terminal form** | no notice, and a connected surface draws the band | warming state, clock-time pings, session savings, rate discount, and command hints |
| **the VS Code and mobile form** | no notice, and no connected surface draws the band | state, ping, bare context count, turn cache, speed, and savings — self-contained fallback telemetry |

**Only one of the three can ever draw.** On the desktop and terminal surfaces you only ever see the desktop and terminal form; the other is for a session attached to VS Code or a phone. The app clips this row and reveals the rest on hover, so the plugin writes the whole string and a long line costs nothing. It is plain text — the price carries no colour, so its form is the whole of what it can say.

### When the line repaints

**The band is redrawn by the app whenever it redraws the composer, so it is always current. The status line is not** — it is a value the app holds until something sets it again.

| Repaints at | Why then |
| --- | --- |
| session start, and again 3 seconds later | the desktop surface attaches just after the session starts, so the first paint can be dropped |
| a resumed session | a cold-resume notice has to be shown before any turn runs |
| a prompt is sent | the surface is certainly live by then, and a guard notice belongs to the prompt it warns about |
| a turn finishes | the context, the cache figure and the price have all changed |
| `/keepwarm` is run, and when a window arms or stops | the state it reports is the thing that just changed |

**So the row names moments, not waits.** A countdown written into a row that does not tick decays where it sits: `6h00m left`, read forty minutes later, overstates what is left by forty minutes, and nothing on the row corrects it. A clock time says the same thing at every reading, which is why the row writes `ends 7:00pm` and `ping at 1:50pm` and stays true until the next paint. **The `/cache-tax` card keeps its durations** — it is a printout, read as it is written, and there the wait is the useful figure.

**Switching to another session shows that session's own row**, painted at its own last event. Because a notice is put on this row and taken off again at the end of its turn, it is a **thing to read now** rather than a durable state: visible for at least the turn it belongs to, and a cold-write notice for the turn after it as well.

### A notice

**One-off messages about an event, not the ongoing state; a newer one replaces the older.** Each has three parts — what happened, the figure, and what to do.

| Notice | Form | Raised when | Clears |
| --- | --- | --- | --- |
| **resume** | `cold resume · first message ≈<usd>` | a resumed or forked session's prompt cache is likely expired | at the end of the turn it belongs to |
| **guard** | `cold <age> · re-write ≈<usd> · sending` | a prompt is sent after the estimated cache lifetime has elapsed | at the end of the turn it belongs to |
| **cold write** | `cold write <tokens> · <usd> · /keepwarm` | a turn records a large fresh cache write | at the end of the turn *after* it, since it is raised at the end of its own |

```text
cold resume · first message ≈$4.01
cold 2h00m · re-write ≈$4.01 · sending
cold write 200.5k · $4.01 · /keepwarm
```

**A figure the plugin cannot price reads `n/a`**, and the resume form then falls back to `cold resume · the next message re-writes the context`. A guard never blocks or drops a prompt. The rates behind each figure are in `/cache-tax`.

### The desktop and terminal form, while the band is drawing

```text
<state> · [ends <clock>] · [ping] · [<cost>] · [/keepwarm to arm the window] · /cache-tax for the full card
```

| # | Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- | --- |
| 1 | **state** | `off` · `on` · `stopped: <reason>` | Always | `stopped` names why a window gave up **early**, which is what tells a failure from a window that simply ran out its hours — that one reads `off`, as an unarmed window does |
| 2 | **window** | `ends <clock>` | A warming window is armed | When the window `/keepwarm` armed runs out — a budget this plugin chose, not a cache lifetime a provider promised |
| 3 | **ping** | `ping at <clock>` · `(held <gap>)` · `(went at <gap>)` · `ping after first turn` · `ping after next turn` | A warming window is armed | The gap is what the last ping proved about the provider's TTL, and it moved the interval the next ping uses. The two `ping after` forms stand in for the time while there is no warm reading to count from |
| 4 | **cost** | `<tokens> session, <saving>% saved` · `n/a` | A context exists | **Session savings and rate discount.** Shows total cache tokens saved across all turns since `/clear`, paired with the model's rate discount. Displays `0 session, 93% saved` before any turn has hit cache. |
| 5 | **arm hint** | `/keepwarm to arm the window` | No warming window is armed | The command that changes the state in slot 1 |
| 6 | **card hint** | `/cache-tax for the full card` | Always | Everything this row has no width for |

```text
off · 41.6M session, 93% saved · /keepwarm to arm the window · /cache-tax for the full card
on · ends 7:00pm · ping at 1:50pm · 41.6M session, 93% saved · /cache-tax for the full card
on · ends 7:00pm · ping at 2:40pm (held 50m) · 41.6M session, 93% saved · /cache-tax for the full card
on · ends 7:00pm · ping at 2:15pm (went at 50m) · 41.6M session, 93% saved · /cache-tax for the full card
on · ends 7:00pm · ping after first turn · 93% saved · /cache-tax for the full card
stopped: ping not sent (nothing-to-fork) · 41.6M session, 93% saved · /keepwarm to arm the window · /cache-tax for the full card
```

**The cost slot pairs session tokens with the rate discount.** The **session tokens** count what the cache has saved across all completed turns since `/clear` (`0 session` before the first cached turn). The **saving** is what a carried token costs against an uncarried one. **A surcharge or a zero keeps its signed money** — `+$0.03`, `+$0.00` — because a percentage could not say it. **No rates at all is `n/a`**.

### The VS Code and mobile form, while no surface raises the band

**The same facts, compactly, with the context as a bare token count** — there is no room for the window beside it. It is the desktop and terminal form plus the window, minus the hints.

```text
<state> · [ping] · <context> · [<n> calls / <tokens> cache / <hit>%] · [<speed> tok/s] · [<cost>]
```

| # | Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- | --- |
| 1 | **state** | `off` · `ends <clock>` · `stopped: <reason>` | Always | The same facts as the other form's state slot, with no `on`: an armed window is already saying when it ends |
| 2 | **ping** | As the desktop and terminal form's | A warming window is armed | |
| 3 | **context** | `ctx <tokens>` · `no context yet` | Always | A bare count, because this row has no width for the window beside it |
| 4 | **cache** | `<n> calls / <tokens> cache / <hit>%` | A turn has completed | The band's turn cache slot, in the same words, because this row is the only surface showing it |
| 5 | **speed** | `<speed> tok/s` | Generation timing is recorded | Model generation throughput |
| 6 | **cost** | As the desktop and terminal form's | A context exists | |

```text
off · ctx 199.1k · 1 call / 190.4k cache / 99% · 41.6M session, 93% saved
ends 7:00pm · ping at 1:50pm · ctx 199.1k · 1 call / 190.4k cache / 99% · 41.6M session, 93% saved
ends 7:00pm · ping after next turn · ctx 199.1k · 1 call / 0 cache / 0% · 41.6M session, 93% saved
off · no context yet
```

**The forecast, fill, sparkline, trend, to-go, session and command hints are all dropped here** — this row has no width for them, and no band above it carries them either, which is why the window slots are here and not there.

## Rates and price comparison

**Providers quote rates per million tokens, but a rate is not a bill.** `/cache-tax` translates raw rates into concrete dollars for the exact context currently in memory, comparing three distinct scenarios against the uncached baseline:

```text
cost        for 66.7k tokens   no cache $0.03 = 100%
                               from cache $0.0020 = 7% of that
                               re-write $0.00 = 0% of that
```

- **`no cache`** is the baseline: the entire context billed as fresh, uncached input.
- **`from cache`** is the same context read from a warm prompt cache.
- **`re-write`** is the context written to cache anew after eviction.
- **The share beside each is relative to the baseline**, so efficiency is obvious without mental arithmetic. A real but rounding share prints `<1%` rather than `0%` to keep "nearly nothing" distinct from "nothing".

**The net financial effect is `from cache` minus `no cache`:**
- **A saving is parenthesised**, `($0.03)`: reading from cache costs less than the baseline. Parentheses are accounting's native mark for a credit, avoiding ambiguity with hyphens.
- **A surcharge carries a leading `+`**, `+$0.03`: reading from cache costs more than uncached input.
- **Zero is `+$0.00`**: input and cache-read costs are equal.
- **`n/a`**: no rates are configured for the active model.

### Rate configuration and discount math

**Prices are user-supplied USD per million tokens**, defined in `token-tax-weather/hooks/register.ts`:

```ts
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0348, cacheRead: 0.005, cacheWrite: 0, output: 0.1392 },
}
```

- **Keys match the engine's exact model ID**, never the UI picker's display label. Unconfigured models display `n/a`; rates are never borrowed across models.
- **The rate discount is invariant to context size.** The status line displays `41.6M session, 93% saved` (or `0 session, 93% saved` before cache hits). The percentage is `(input - cacheRead) ÷ input` — because token count cancels out of the fraction, the discount percentage is constant across all context sizes, while the dollar value it represents grows with every turn.
- **The break-even reality.** When a provider prices `cacheWrite` at zero, a cold re-write incurs no dollar surcharge. At those rates, paid warming cannot pay for itself in monetary savings alone; its true return is eliminating the time-to-first-token latency penalty of re-ingesting massive context windows.

## Privacy and limits

- **Local token counts and the engine's free context breakdown.** That is what the readout is built from.
- **Diagnostics print no settings values.**
- **No automatic warming, and no provider probe.** An explicitly armed `/keepwarm` window does send model requests.
- **Prompt-cache observations do not establish an OpenRouter response-cache hit.** This plugin neither controls nor reports that separate cache's TTL or HIT/MISS.

## Development

```bash
npx -y @anthropic-ai/claude-code@2.1.293 plugin test ./token-tax-weather
```

```bash
npx -y @anthropic-ai/claude-code@2.1.293 plugin validate ./token-tax-weather
```

**Tests mount the real surface and inspect its drawn tree.** The engine generates API declarations under `.claude-plugin/types/` when it loads the plugin; they are gitignored. Type-check after those declarations exist.

## Relation to cache-tax

**This supersedes [`cache-tax`](https://www.npmjs.com/package/cache-tax) 2.1.3** and registers the same `/keepwarm` and `/cache-tax` commands. Enable only one; a plugin that finds the names already taken skips them and reports the conflict.
