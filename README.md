# token-tax-weather

Two questions about a Claude Code session, answered in one coloured band above
the prompt:

- **How full is the context window?** A forecast — `☀ Clear`, `☁ Cloudy`,
  `☂ Showers`, `☇ Storm`, `↯ Compact soon` — measured against the window
  `/autocompact` actually fires on, not the model's raw limit.
- **What is the prompt cache doing to the bill?** A signed figure, green when
  being warm is saving you money and red when the cache-read rate is above the
  plain input rate and it is costing you instead.

```
☂  Showers  55% of 362k  ·  ▃▄▅▅▆▇  ·  ▲ +12k last turn  ·  cached 141.9k  ·  6h00m left · ping in 50m  ·  -$0.12
```

To the left is the weather; to the right, the tax.

## Install

```
/plugin marketplace add <owner>/<repo>
/plugin install token-tax-weather@token-tax-weather
```

Or, with the `claude` CLI:

```sh
claude plugin marketplace add <owner>/<repo>
claude plugin install token-tax-weather@token-tax-weather
```

The band is raised on the **desktop** and **terminal** surfaces. On the
surfaces that do not raise it the same facts go to the status line instead,
without colour, so the two never both draw the readout.

## Notices

The band carries the continuously-updating facts: the forecast, the cache read,
the countdown, the price. The one-off notices are different. A cold resume, a
cold send the guard warns about, and a cold write it records are pinned on the
status line under the prompt — not in the transcript — so they are read once
where you are working, rather than scrolled back to. A notice stays up while the
turn it belongs to runs and clears when that turn finishes; a second notice
simply replaces the first. Unlike the readout, a notice is shown on every
surface, the band's own included.

Each notice is written to fit one line. The status line shares its row with the
model picker and the app clips what does not fit, so a notice says what happened
and what it costs, and stops there — hovering shows the same text, no more. The
rates behind the figure, and what to do about a cold cache, are in `/cache-tax`,
which has the room for them.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a six-hour window that pings the cache so it does not expire |
| `/keepwarm 90m`, `2h30m`, `6h` | Arms a window of that length |
| `/keepwarm every 50m` | Arms it, pinging every 50 minutes |
| `/keepwarm always` | Arms it with no deadline, this session |
| `/keepwarm off` | Disarms it |
| `/keepwarm status` | Reports what is armed |
| `/cache-tax` | The full card: state, window, prices, the cache's effect, break-even |
| `/cache-tax-diagnostic` | Read-only. What the host's pricing interface exposes, and nothing else |

## What the band can say

The band is one line, and every slot in it is optional — a slot with nothing to
say is dropped rather than left blank. Against a 362k window (the size
`/autocompact` fires on, not the model's raw limit) the five forecasts read:

```text
☀  Clear         18% of 362k · ▁▁▂▁▂▁▂▂▁▂▂▁ · ▼ 4k last turn · cached 62.1k · off · -$0.03
☁  Cloudy        37% of 362k · ▂▃▃▄▃▄▄▅▄▄▃▄ · steady · cached 128.9k · off · -$0.05
☂  Showers       55% of 362k · ▄▄▅▅▆▅▆▆▅▆▆▇ · ▲ +12k last turn · cached 190.4k · 6h00m left · ping in 50m · -$0.08
☇  Storm         82% of 362k · ▆▇▆▇█▇▇█▇▆▇█ · ▲ +40k last turn · cached 281.2k · off · -$0.12
↯  Compact soon  95% of 362k · ███████▇████ · ▲ +60k last turn · cached 320.5k · off · -$0.14
```

- **`☀ Clear`** under 25%, **`☁ Cloudy`** under 50%, **`☂ Showers`** under 75%,
  **`☇ Storm`** under 90%, **`↯ Compact soon`** at 90% and above — coloured
  yellow, cyan, blue, magenta and red.
- **The sparkline** is the last twelve readings, one bar each, the bar's height
  the share of the window at that reading.
- **The trend** is the change since the reading before: `▲ +12k last turn`,
  `▼ 4k last turn`, or `steady`. Absent until there are two readings to compare.
- **`cached 128.9k`** is what the last turn actually served from cache. That is a
  different measurement from the context figure beside it — one is what the cache
  *could* hold, the other what it *did* serve — so the two are never conflated,
  and the slot is absent when the last turn reported no cache read at all.
- **`off`** is the warming slot: no window is armed. `/keepwarm` replaces it with
  a countdown, `6h00m left`, and adds `ping in 50m` while a window is running.
- **The final figure** is the cache's effect on the bill for this context. See
  [Reading the figure](#reading-the-figure) — it is decided by the model's rates
  and the context size alone, so it is not an indicator of whether the cache is
  warm.

The band sizes itself to the box it is drawn in, which is narrower than the window
while a pane is docked beside the transcript. The widest slots go first, so a
narrow band is a shorter band rather than a wrapped one:

| The band's width | What is dropped |
| --- | --- |
| under 56 columns | the sparkline |
| under 72 columns | the trend |
| always | nothing else — the cache read, the warming state and the price are never dropped |

A slot can also be missing for want of data rather than width: the sparkline needs
a completed reading, the trend needs two, and the cache read appears only once a
turn has actually served something from cache. The two are told apart by what is
still there — a band with no `cached` slot is reporting that the last turn served
nothing, since that slot is never dropped for width.

### The same states on the status line

Where the band is raised — **desktop** and **terminal** — the status line is left
empty on purpose. The band is already saying all of it in colour, and the same
thing is never said twice, so the status line there carries only the one-off
[notices](#notices).

On the surfaces that raise no band the same facts fall back to the status line,
without colour and in a fixed order:

```text
off · ctx 133.9k · cached 128.9k · -$0.05
6h00m left · ping in 50m · ctx 133.9k · cached 128.9k · -$0.05
6h00m left · ping after first turn · ctx 133.9k · cached 128.9k · -$0.05
6h00m left · ping after next turn · ctx 133.9k · cached 128.9k · -$0.05
off · ctx 133.9k · -$0.05
off · no context yet
```

The order is warming, ping, context, cache read, effect. The context appears as a
token count rather than a percentage, because there is no room for the window
beside it, and the sparkline and trend are dropped entirely. The two `ping after`
forms stand in for the countdown while there is no reading to count from — before
this session's first turn, and after the cache has gone cold.

## What it never does

- **It never drops a prompt.** The guard warns that the cache went cold and sends
  your message anyway.
- **It never warms on its own.** No timer arms itself; `/keepwarm` is the only
  thing that spends anything, and it is always yours to run.
- **It never invents a price.** Costs come from the rate table below, which you
  edit. A model with no row shows `n/a` rather than a number from another model.

## The rates

Unit prices in USD per million tokens, in `hooks/register.ts`:

```ts
export const RATES: Record<string, Rates> = {
  'claude-fable-5': { input: 0.43, cacheRead: 0.03, cacheWrite: 0, output: 0.87 },
  'claude-opus-5-5': { input: 0.0007, cacheRead: 0.005, cacheWrite: 0, output: 0.6 },
}
```

Matched on the engine's exact model ID, not the name the picker shows. Add a row
for each model you use; nothing else needs changing.

## Reading the figure

The final number on the band is `context × (cacheRead − input)` — what the cache
does to the bill for that context, **not** an indicator of whether the cache is
currently warm. It is decided entirely by the model's rates and the context
size, so it is the same number whether the cache is hot or has been cold for a
day.

- **Negative** (green): the read rate is below the input rate, so being warm
  lowers the bill by that much. The usual case.
- **Positive** (red): the read rate is above the input rate, so serving from
  cache costs more than not caching and losing the cache would be the saving.

Whether the cache is warm right now is the `<time> left` field, not this one.

## Privacy

Everything it reads is local session state: token counts the engine already
reports, and the context breakdown it computes itself with no network request.
It sends nothing anywhere, and `/cache-tax-diagnostic` prints no settings values
— only whether the host's pricing interface exposes any.

## Development

```sh
claude plugin test ./token-tax-weather
claude plugin validate ./token-tax-weather
```

The tests mount the real surface and read the drawn tree, so a tree the surface
would refuse fails the suite rather than passing a stub. The engine writes this
build's API declarations into `.claude-plugin/types/` when it loads the plugin;
that folder is generated and gitignored, and `tsc -p token-tax-weather` needs a
load first.

## Relation to cache-tax

This supersedes [`cache-tax`](https://www.npmjs.com/package/cache-tax) 2.1.3. It
registers `/keepwarm` and `/cache-tax` under the same names, so run only one of
the two — whichever loads second skips the names already taken and says so.
