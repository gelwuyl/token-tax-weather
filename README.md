# token-tax-weather

Context weather and cache-served token counts above the prompt; warming state,
a price comparison, and suggested commands beside the model picker.

- **The band** answers what the context window is doing: how full it is, how much
  room is left, how far away `/autocompact` is, and how many tokens the prompt
  cache served.
- **The status line** carries whether `/keepwarm` is armed, when it will ping, and
  what the cache-read rate means for the current context — or, while the band is
  down, the same window facts in a compact form.
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

The band is supported on **desktop** and **terminal**. Where no connected surface
supports it, the status line carries the same window facts itself — the
[VS Code and mobile form](#the-vs-code-and-mobile-form-while-no-surface-raises-the-band). That is a
substitution, not an extra readout beside the band.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a six-hour warming window, with a ping after 50 minutes of idle time |
| `/keepwarm 90m`, `/keepwarm 2h30m`, `/keepwarm 6h` | Arms a window of that length |
| `/keepwarm 6h every 20m` | Starts the search at a 20-minute idle interval; the window must come before `every`. The interval then moves as the pings narrow the TTL — see [How the ping interval finds itself](#how-the-ping-interval-finds-itself) |
| `/keepwarm always` | Same six-hour window as the bare command, for compatibility with `cache-tax`; not unbounded or remembered across sessions |
| `/keepwarm off` | Disarms warming |
| `/keepwarm status` | Reports what is armed |
| `/cache-tax` | Shows the full card: cache state, context, the window and the autocompact threshold, token counts, rates, the price comparison, and warming break-even |
| `/cache-tax-diagnostic` | Read-only report of whether the host exposes pricing information; prints no settings values |

**There is no `/keepwarm on`.** Run bare `/keepwarm` to arm it. A displayed `on`
is a state label, not a command. Likewise, `/keepwarm` at the end of a notice is a
suggestion to run that command.

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

| Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- |
| **forecast** | `☀ Clear` · `☁ Cloudy` · `☂ Showers` · `☇ Storm` · `↯ Compact soon` | Always | The band's colour: yellow, cyan, blue, magenta, red, at 25%, 50%, 75% and 90% of the window |
| **fill** | `<context> / <window> (<percent>%)` | Always | The percentage is the engine's own and need not equal `context ÷ window` |
| **to go** | `<tokens> to go (<to-go%>)` · `compact due` | A context exists, and the engine reports an autocompact threshold | The distance to the point `/autocompact` fires. Absent with nothing in use, where it would only restate the threshold; `compact due` once past it |
| **sparkline** | up to twelve bars from `▁▂▃▄▅▆▇█` | A completed reading exists, and 56+ columns | One bar per reading, its height that reading's share of the window |
| **trend** | `▲ +<tokens>` · `▼ <tokens>` · `steady` | Two or more readings, and 72+ columns | The move since the previous reading. The arrow carries the direction, so the words do not |
| **cache** | `<tokens> cache turn` | The last turn served something from cache | Cache-served tokens only, summed over that turn's model calls |
| **usage** | `<tokens> usage session` | Anything has been served since `/clear` | The same quantity over every turn since `/clear`; a compaction does not reset it |

Shapes, widest to narrowest:

```text
↯  Compact soon  326.5k / 362k (90%)  ·  compact due  ·  ▅▅▆▆▇▇  ·  ▲ +12k  ·  150.9k cache turn  ·  41.6M usage session
☇  Storm  299.9k / 362k (83%)  ·  20.1k to go (5.6%)  ·  ▃▄▅▅▆▇  ·  ▲ +12k  ·  150.9k cache turn  ·  41.6M usage session
☁  Cloudy  164.1k / 362k (46%)  ·  155.9k to go (43.1%)  ·  ▁▂▃▃▄▅  ·  ▲ +12k
☀  Clear  60.2k / 362k (17%)  ·  259.8k to go (71.8%)
☁  Cloudy  164.1k / 362k (46%)
```

- **Every percentage in the band is of the window**, so all of them read against
  one denominator.
- **Only the sparkline and the trend are dropped for width.** No figure is.
- **`cache` and `usage` are the same quantity over two spans** — the turn just
  finished, and every turn since `/clear`. They coincide on a session's first
  turn, which is one turn being both the last one and the whole session so far. A
  turn makes one model call per step and every call reads the context again, so a
  turn's total can run to many times the context it read: `6.6M cache turn` beside
  a 157.9k context is about 42 calls, not a miscount. Both are **cache-served
  tokens only** — never all input and output, and never spend.
- **The window's headroom is reported as `to go` only.** The breakdown also
  carries a free-space row, and the band leaves it out because the two track each
  other; `/cache-tax` reports the free figure for anyone who wants it.

### The status line

The row beside the model picker is **one line, not a set of tiers**. A notice
outranks everything; otherwise the band decides which facts the line carries,
because the band and the line share the work between them.

| | Drawn when | Carries | Why |
| --- | --- | --- | --- |
| **a notice** | an event needs attention now | what happened, the figure, what to do | it is a one-off thing to read now, so it outranks everything, the band's own surface included |
| **the desktop and terminal form** | no notice, and a connected surface draws the band | state, ping, cost, command hints | the band already carries the window, so this line carries what the band cannot — the warming and what to run |
| **the VS Code and mobile form** | no notice, and no connected surface draws the band | state, ping, context, cache, cost | nothing else is showing the window, so this line has to |

Only one of the three can ever draw. On the desktop and terminal surfaces you only
ever see the desktop and terminal form; the other is for a session attached to VS
Code or a phone. The app clips this row and reveals the rest on hover, so the
plugin writes the whole string and a long line costs nothing. It is plain text —
the price carries no colour, so its form is the whole of what it can say.

#### When the line repaints

The band is redrawn by the app whenever it redraws the composer, so it is always
current. **The status line is not**: it is a value the app holds until something
sets it again.

| Repaints at | Why then |
| --- | --- |
| session start, and again 3 seconds later | the desktop surface attaches just after the session starts, so the first paint can be dropped |
| a resumed session | a cold-resume notice has to be shown before any turn runs |
| a prompt is sent | the surface is certainly live by then, and a guard notice belongs to the prompt it warns about |
| a turn finishes | the context, the cache figure and the price have all changed |
| `/keepwarm` is run, and when a window arms or stops | the state it reports is the thing that just changed |

So a countdown in that row stands still until the next turn or command, and a line
left across a long idle gap reads older than it is. Switching to another session
shows that session's own row, painted at its own last event. Because a notice is
put on this row and taken off again at the end of its turn, it is a **thing to
read now** rather than a durable state: visible for at least the turn it belongs
to, and a cold-write notice for the turn after it as well.

#### A notice

One-off messages about an event, not the ongoing state; a newer one replaces the
older. Each is three parts — what happened, the figure, and what to do:

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

A figure the plugin cannot price reads `n/a`, and the resume form then falls back
to `cold resume · the next message re-writes the context`. A guard never blocks or
drops a prompt. The rates behind each figure are in `/cache-tax`.

#### The desktop and terminal form, while the band is drawing

```text
<state> · [<duration> left] · [ping] · [<cost>] · [/keepwarm to arm the window] · /cache-tax for the full card
```

| # | Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- | --- |
| 1 | **state** | `off` · `on` · `stopped: <reason>` | Always | `stopped` names why a window gave up, which is the difference between one you never armed and one that was armed and stopped |
| 2 | **window** | `<duration> left` | A warming window is armed | The time left in the window `/keepwarm` armed — a budget this plugin chose, not a cache lifetime a provider promised |
| 3 | **ping** | `ping in <duration>` · `(held <gap>)` · `(went at <gap>)` · `ping after first turn` · `ping after next turn` | A warming window is armed | The gap is what the last ping proved about the provider's TTL, and it moved the interval the next ping uses. The two `ping after` forms stand in for the countdown while there is no warm reading to count from |
| 4 | **cost** | `$<from cache> of $<no cache>, <share>%` · `n/a` | A context exists | What one read of this context costs from cache, what the same context costs uncached, and the first as a share of the second |
| 5 | **arm hint** | `/keepwarm to arm the window` | No warming window is armed | The command that changes the state in slot 1 |
| 6 | **card hint** | `/cache-tax for the full card` | Always | Everything this row has no width for |

```text
off · $0.0020 of $0.03, 7% · /keepwarm to arm the window · /cache-tax for the full card
on · 6h00m left · ping in 50m · $0.0020 of $0.03, 7% · /cache-tax for the full card
on · 6h00m left · ping in 50m (held 50m) · $0.0020 of $0.03, 7% · /cache-tax for the full card
on · 5h10m left · ping in 25m (went at 50m) · $0.0020 of $0.03, 7% · /cache-tax for the full card
on · 6h00m left · ping after first turn · /cache-tax for the full card
stopped: ping not sent (nothing-to-fork) · $0.0020 of $0.03, 7% · /keepwarm to arm the window · /cache-tax for the full card
```

**The cost slot names both prices rather than a signed difference.** A bare signed
figure on a clipped row was read as one of the costs it sits between, which is why
`$0.0020 of $0.03` is spelled out. The share repeats the ratio in the form that is
read fastest: it is the same for every context size with a given model, so it says
how good the deal is, while the money says what the deal is worth on the context
in hand. There is no share when there is no money to take one of, so `n/a` stands
alone.

#### The VS Code and mobile form, while no surface raises the band

The same facts, compactly, with the context as a bare token count because there is
no room for the window beside it. It is the desktop and terminal form plus the
window, minus the hints.

```text
<state> · [ping] · <context> · [<tokens> cache turn] · [<cost>]
```

| # | Slot | Forms | Shown when | What it means |
| --- | --- | --- | --- | --- |
| 1 | **state** | As the desktop and terminal form's | Always | The same word in both forms, with no `keepwarm` prefix in either |
| 2 | **ping** | As the desktop and terminal form's | A warming window is armed | |
| 3 | **context** | `ctx <tokens>` · `no context yet` | Always | A bare count, because this row has no width for the window beside it |
| 4 | **cache** | `<tokens> cache turn` | The last turn served something from cache | As the band's slot |
| 5 | **cost** | As the desktop and terminal form's | A context exists | |

```text
off · ctx 199.1k · 190.4k cache turn · $0.0060 of $0.09, 7%
6h00m left · ping in 50m · ctx 199.1k · 190.4k cache turn · $0.0060 of $0.09, 7%
6h00m left · ping after next turn · ctx 199.1k · $0.0060 of $0.09, 7%
off · no context yet
```

The **forecast, fill, to-go, sparkline, trend, session usage and command hints**
are all dropped here: this row has no width for them, and no band above it carries
them either — which is why the window slots are here and not there.

## What `/keepwarm` actually sends

Warming is **a model request, not a header**. Arming a window sends nothing at
all; it only sets a timer. When the timer fires, the plugin calls the engine's
fork, which re-sends the session's own transcript as the main thread last sent
it — its model, system prompt, tools and messages — with one short message after
it:

```text
Reply with the single word: warm
```

The engine describes that call as existing "so the API serves that prefix from its
cache". It is tool-less, and the message itself is never cached. It goes wherever
your session's requests already go: the plugin sets no cache directive, names no
provider, and never talks to a provider API itself. It asks the engine, and the
engine routes the request exactly as it routes your own prompt.

**Why a request is what warms a cache.** Prompt caching is provider-side: the
provider keeps a processed prefix and charges a reduced rate to read it again, and
every provider that does this expires the stored prefix after some idle time.
Sending the prefix again is what resets that clock. So a ping is not asking anyone
to keep something — it is *using* the cache, which is the thing that stops the
cache from being dropped.

**Whether it works where you are is reported, not assumed.** The ping's reply
carries the engine's own token counts, and the plugin reads them:

| The ping's reply | What the plugin does |
| --- | --- |
| read > 0, and a write under 10% of that read | counts the prefix served from cache; the window stays armed |
| read 0, or a write as large as the read | stops the window, saying `the cache was gone` and giving both counts |

`/cache-tax` prints the last ping's two counts and its cost, and a stopped window
carries the same reason on the status line. So a setup where warming does nothing
announces itself here rather than on a bill.

**Each outcome also measures the provider's expiry clock, which nothing else can.**
The plugin cannot read that clock — the engine does not expose it, and the
`window` `/keepwarm` arms is a budget this plugin chooses, not a lifetime the
provider promised. But every ping was preceded by a known idle gap, and its
outcome is a fact about the clock:

| The ping came back | What the gap proves |
| --- | --- |
| warm after a gap of *N* | the provider's TTL is **at least** *N* |
| cold after a gap of *N* | the provider's TTL is **under** *N* |

So the card reads `last ping … (warm after 50m idle, so the provider's TTL is at
least that)`, or the same sentence with *under* where the ping came back cold.
Both bounds also reach the status line, folded into the ping slot they came from:
`ping in 50m (held 50m)` after a warm ping, `ping in 25m (went at 50m)` after a
cold one. Neither takes a slot of its own, and both are worth saying, because
each moves the interval the window pings at next. The bound costs nothing to
learn: it comes from a request the window was going to send anyway.

### How the ping interval finds itself

`every` is the interval a window **starts** at, not one it is stuck with. Each
ping narrows the bracket around the TTL, and the next interval is the midpoint of
whatever the pings have settled. With a TTL of about 45 minutes and the default
50-minute start:

| The ping at | Brackets to | Next ping |
| --- | --- | --- |
| 50m, cold | TTL is under 50m | 25m |
| 25m, warm | TTL is at least 25m | 38m |
| 38m, warm | TTL is at least 38m | 44m |
| 44m, warm | TTL is at least 44m | 47m |
| 47m, cold | TTL is under 47m | 45m |
| 45m, cold | TTL is under 45m |

settles at 42m |

The search stops once the bracket is down to a two-minute margin, and settles at
the longest gap **proven** to work, less that margin. That is what the last two
rows buy: a window that only ever halved would have stopped at the first gap that
worked — 25m — and pinged there for the rest of its six hours, sending about 1.8
times as many requests as one pinging at 42m against the same 45-minute TTL.

Two things the search will not do. It will not go below one minute, because below
that it is not warming a cache but polling one. And it stops outright when a ping
**neither reads nor writes** a cache entry, because that is not a short TTL but no
caching at all — the case where continuing would spend on every interval and have
nothing to show for any of it.

The interval it settles on is remembered in the session's store, so a window
re-armed in the same session — or opened in the next one — resumes at the interval
the last one learned instead of starting the search over. `/keepwarm … every 30m`
resets the search and starts from 30m, because a number you name is newer than
anything the pings found.

Three consequences worth being explicit about:

- **Automatic caching needs no header.** Anthropic's API takes explicit
  `cache_control` breakpoints; several other providers cache a long-enough prompt
  on their own, with nothing in the request to mark it. A ping warms either kind,
  because both kinds are warmed by reuse. This is why the plugin can stay
  provider-agnostic: it never has to know which kind it is talking to.
- **The plugin cannot turn on caching the harness is not already asking for.** If
  nothing upstream marks a prefix as cacheable, a ping reads nothing and the
  window stops. That is the plugin reporting your setup accurately, not the ping
  failing.
- **A router's response cache is a different thing.** OpenRouter and similar
  gateways also keep a cache of *whole responses* keyed on the exact request. That
  is not prompt caching, this plugin neither controls nor observes it, and a
  prompt-cache hit is no evidence of a response-cache hit — see
  [Privacy and limits](#privacy-and-limits).

The break-even is in [Reading the price comparison](#reading-the-price-comparison):
warming pays only when a cache read costs less than the write it avoids. With the
shipped rates, where `cacheWrite` is `0`, it does not.

## Reading the price comparison

`/cache-tax` shows **what one read of the context you have right now costs**, three
ways, each measured against the same baseline:

```text
cost        for 66.7k tokens   no cache $0.03 = 100%
                               from cache $0.0020 = 7% of that
                               re-write $0.00 = 0% of that
```

- **`no cache`** is the baseline: the whole context sent as ordinary input.
- **`from cache`** is the same context read from a warm cache.
- **`re-write`** is the context written to the cache afresh, after it has expired.

The share beside each is of the baseline, so the comparison can be read without
knowing any rate. A share that is real but rounds away shows `<1%` rather than
`0%`, which keeps "nearly nothing" apart from "nothing".

The **effect** is `from cache` minus `no cache` — the difference between two of
those figures:

- **A saving** is shown in parentheses, `($0.03)`: reading this context from cache
  costs less than uncached input. Parentheses are accounting's own mark for a
  credit, and avoid a minus sign that could be read as a hyphen.
- **A surcharge** carries a leading `+`, `+$0.03`: reading it from cache costs
  more than uncached input.
- **Zero** is `+$0.00`: the two input costs are equal. It is a real answer, and it
  never takes parentheses.
- **`n/a`:** no rates are configured for the model.

The card carries the signed difference because it has room to say what a sign
means. **The status line does not**, so it carries the two costs themselves —
`$0.0020 of $0.03, 7%` — which no reader can mistake for a saving when they are a
cost. The share is the same figure in both places; see
[the desktop and terminal form](#the-desktop-and-terminal-form-while-the-band-is-drawing).

It is a hypothetical comparison for **one read of the current context**. It is
not the turn's bill, accumulated savings, or warming break-even. Its value does
not tell you whether the cache is warm; it depends only on rates and context
size. The `/cache-tax` card separately explains whether warming can pay for itself.

Providers publish rates per million tokens, and this plugin's are no exception —
but a rate is not a bill, so the card shows the bill for the context in hand. The
rates themselves, and where each one came from, are the subject of
`/cache-tax-diagnostic`.

## The rates

Prices are user-supplied USD per million tokens in `token-tax-weather/hooks/register.ts`:

```ts
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0348, cacheRead: 0.005, cacheWrite: 0, output: 0.1392 },
}
```

Rows match the engine's exact model ID, not the picker's display label. A model
with no row shows `n/a`; the plugin never borrows another model's price.

Both rows read at a fraction of their input rate, so the cache is a saving on
either. Both also have a zero cache-write price, which means a cold re-write is
billed at nothing — so **paid warming cannot pay for itself at these rates**,
however good the read discount looks. Filling in a real cache-write price is what
would make the break-even line mean something.

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
