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
