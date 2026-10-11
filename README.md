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
☂  Showers  55% of 362k  ·  ▃▄▅▅▆▇  ·  ▲ +12k last turn  ·  read 141.9k this turn  ·  6h00m left · ping in 50m  ·  -$0.12
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

## The two families

Everything this plugin draws belongs to one of two families, and these are the
names used for them throughout this README.

**The readout** is the continuously-updating state: how full the window is, what
the cache is doing, what it costs. It has two renderings, and only one of them
ever draws.

| Rendering | Where | In colour |
| --- | --- | --- |
| **the band** | desktop and terminal, above the prompt | yes |
| **the fallback** | the status line, on the surfaces that raise no band | no |

**The state line** is what the status line carries where the band is up: the mod's
own state, and the command worth running. The band already says the readout, so
this slot says what the band cannot.

**The notices** are the one-off messages. There are three: the **resume notice**,
the **guard notice** and the **cold-write notice**.

So the status line is **one slot with three possible occupants**, in this order of
precedence:

1. a **notice**, when one is up — it outranks everything, on every surface
2. else the **state line**, where the band is up
3. else the **fallback**, where the band is not

Among notices, the last one raised replaces the one before: there is a single slot.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a six-hour window that pings the cache so it does not expire |
| `/keepwarm 90m`, `2h30m`, `6h` | Arms a window of that length |
| `/keepwarm 6h every 20m` | A window, pinging every 20 minutes instead of every 50. The period has to come *after* the window — a bare `/keepwarm every 20m` has no window and is refused |
| `/keepwarm always` | The same six-hour window as the bare command, kept for parity with `cache-tax`. It is **not** an unbounded window and is not remembered across sessions |
| `/keepwarm off` | Disarms it |
| `/keepwarm status` | Reports what is armed |
| `/cache-tax` | The full card: state, window, prices, the cache's effect, break-even |
| `/cache-tax-diagnostic` | Read-only. What the host's pricing interface exposes, and nothing else |

## Grammar

### The band

One line. The slots come in this order, and every one of them is optional — a slot
with nothing to say is dropped rather than left blank.

| Slot | Shows | Appears | Forms |
| --- | --- | --- | --- |
| **forecast** | the window's fill, as a weather band | always | `☀ Clear` under 25% · `☁ Cloudy` under 50% · `☂ Showers` under 75% · `☇ Storm` under 90% · `↯ Compact soon` at 90% and above — coloured yellow, cyan, blue, magenta, red |
| **fill** | that fill as a percentage, and the window it is measured against | always | `<n>% of <window>` |
| **sparkline** | the last twelve readings | the band is 56 columns or wider | twelve bars from `▁▂▃▄▅▆▇█`; a bar's height is that reading's share of the window |
| **trend** | the change since the reading before | the band is 72 columns or wider, and two readings exist | `▲ +<n> last turn` · `▼ <n> last turn` · `steady` |
| **read** | tokens the cache served this turn | a turn has served something | `read <n> this turn` |
| **session read** | the same figure, summed since `/clear` | a turn has served something | `read <n> this session` |
| **warming** | whether a warming window is armed | always | `off` · `<duration> left` |
| **ping** | when the next ping comes | a window is armed | `ping in <duration>` · `ping after first turn` · `ping after next turn` |
| **effect** | what the cache does to the bill for this context | a context exists | `±$<n>`, or `n/a` with no rates for the model |

```text
☂  Showers  55% of 362k  ·  ▃▄▅▅▆▇  ·  ▲ +12k last turn  ·  read 190.4k this turn  ·  read 1.2M this session  ·  6h00m left · ping in 50m  ·  -$0.08
```

`<window>` is the window `/autocompact` fires on, not the model's raw limit. The
**read** slot counts every model call the turn made — a turn of fourteen calls
over one context reads that context fourteen times — so it can run to a multiple
of the context beside it. That is not the cache growing; the cache holds one
context. `/cache-tax` divides the total by the context and reports the multiple.
For the **effect** slot, see [Reading the figure](#reading-the-figure): it is
decided by the model's rates and the context size alone, so it is **not** an
indicator of whether the cache is warm.

A slot can be missing for width or for want of data, and the two are told apart by
what is still there:

| Missing slot | Why |
| --- | --- |
| sparkline | band under 56 columns, or no completed reading yet |
| trend | band under 72 columns, or fewer than two readings |
| read, session read | the turn served nothing from cache — these are never dropped for width |
| effect | no context yet |

### The status line

One slot, on the row shared with the model picker. Whatever does not fit is clipped
by the app and shown when you hover it, so a long line costs nothing here.

**A notice**, when one is up. It outranks the other two occupants on every surface,
the band's own included. Three parts, in this order: what happened, the number,
and what it means for you.

| Notice | Raised when | Grammar | Example |
| --- | --- | --- | --- |
| **resume notice** | a session resumes or forks and its prompt cache is likely expired | `cold resume · first message ≈<usd>` | `cold resume · first message ≈$4.01` |
| **guard notice** | a prompt is sent after the cache has gone cold | `cold <age> · re-write ≈<usd> · sending` | `cold 2h00m · re-write ≈$4.01 · sending` |
| **cold-write notice** | a turn wrote a fresh cache entry | `cold write <tokens> · <usd> · /keepwarm` | `cold write 200.5k · $4.01 · /keepwarm` |

That last part is a command to run, not a state: `/keepwarm` on its own arms a
window, and there is no `/keepwarm on`. A notice stays up while the turn it belongs
to runs and clears when that turn finishes — except the cold-write notice, which is
raised at the end of its turn and so outlives it by one. The rates behind each
figure, and the advice a cold cache deserves, are in `/cache-tax`.

**The state line**, where the band is up.

| Slot | Shows | Appears | Forms |
| --- | --- | --- | --- |
| **state** | whether a warming window is armed | always | `keepwarm off` · `keepwarm on, <duration> left` · `keepwarm stopped: <why>` |
| **ping** | when the next ping comes | a window is armed | as the band's |
| **hint** | the command worth running | the card always; the window only while nothing is armed | `/keepwarm to arm the window` · `/cache-tax for the full card` |

```text
keepwarm off · /keepwarm to arm the window · /cache-tax for the full card
keepwarm on, 6h00m left · ping in 50m · /cache-tax for the full card
keepwarm stopped: ping not sent (nothing-to-fork) · /keepwarm to arm the window · /cache-tax for the full card
```

`stopped` names why a window gave up, which is the difference between a window you
never armed and one that was armed and stopped — a difference the band cannot show,
where both read `off`.

**The fallback**, where the band is not raised: the same facts as the band, in a
fixed order and without colour, with the context as a token count because there is
no room for the window beside it.

| Slot | Forms |
| --- | --- |
| **warming** | as the band's |
| **ping** | as the band's |
| **context** | `ctx <tokens>` · `no context yet` |
| **read** | `read <n> this turn` |
| **effect** | `±$<n>` · `n/a` |

```text
off · ctx 199.1k · read 190.4k this turn · -$0.08
6h00m left · ping in 50m · ctx 199.1k · read 190.4k this turn · -$0.08
6h00m left · ping after first turn · ctx 199.1k · read 190.4k this turn · -$0.08
6h00m left · ping after next turn · ctx 199.1k · read 190.4k this turn · -$0.08
off · ctx 199.1k · -$0.08
off · no context yet
```

The sparkline, the trend and the session read are dropped here: there is no width
for them. The two `ping after` forms stand in for the countdown while there is no
reading to count from — before the session's first turn, and after the cache has
gone cold.

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
