# Band and status-line split — Approved Blueprint

## Problem / Objective

The combined band repeats information that can be carried more clearly beside the
model picker. Split context and cache-volume measurements from warming state and
the price comparison. Make the README an exact command and display-grammar
reference rather than a session log.

Approval: on 2026-10-11, the user selected **Your split**, **cache / usage**,
**tokens of window (pct%)**, and **Keep the hints**. These supersede the previous
combined-band presentation without changing pricing, cache accounting, or paid
warming behaviour.

## Approach & Implementation Decisions

The existing render and status interfaces remain the only UI seams. No new
surface, provider probe, settings interface, or gateway change is introduced.

- **Band:** forecast, context tokens of window tokens with percentage in
  parentheses, optional sparkline, optional trend, cache-served tokens this turn,
  and cache-served tokens this session.
- **State line:** warming on/off/stopped, remaining warming-window duration as a
  separate slot, next-ping timing, the signed context price comparison, and hints.
  The arm hint appears only while unarmed; the full-card hint remains present.
- **Fallback:** the existing compact status readout remains when no connected
  surface supports the band. Its turn-total label becomes `cache`.
- **Notices:** retain precedence and existing turn-bound lifetimes on every
  surface. A notice replaces the normal status form, not the band.
- **Card:** use `cache` for the last turn's cache-served total and `usage` for the
  cache-served session total. Preserve the explanation of repeated model calls.

`usage` is not all input/output tokens or total spend. It accumulates cache-read
counters across turns, resets on `/clear`, and survives compaction. `effect` is a
hypothetical cache-read versus uncached-input comparison for one current context,
not the turn's bill, accumulated savings, warming break-even, or proof of warmth.
The status interface accepts plain text, so moving effect there gives up its
colour while preserving the sign.

Token abbreviations retain their existing rounding and omit a trailing `.0`.
Percentage and forecast continue to be derived from the measured compaction
window, with the model window used only as the existing fallback.

## Testing Decisions

Use the existing engine event fixtures and real surface mount. Assert exact slot
order and text, absence of warming/ping/money in the band, money on the state
line, surface-roster selection, notice precedence, unknown/zero prices, no-context
omission, and session-total reset and retention. No new test seam is required.

Use the matching 2.1.293 plugin test and validate commands. Type-check against the
engine-generated declarations, which are local build artifacts and not published.
Verify installed and source copies agree byte-for-byte after synchronisation.

A live Desktop demonstration remains the primary acceptance gate. Mounted trees,
validation, and type-checking verify behaviour but do not substitute for seeing
the revised split in the running Desktop session. Do not restart Desktop or make
paid provider calls automatically; explicitly report that limit.

## User Stories / Scope

| Ticket | End-to-end behaviour | Blocking edges | Acceptance and failure modes |
| --- | --- | --- | --- |
| Split the readout | A user sees context and cache volume in the band, and warming and money beside the picker, with no duplicated fields | Approved choices | Mounted band and status match the chosen grammar; unknown rates remain unknown; plain-text prices retain their signs |
| Make the grammar referable | A user can identify each slot and run an exact supported command from the README | Split the readout | Tables and scenario templates match the implementation; no session logs; `usage`, warming budget, effect, and break-even remain distinct |
| Stage the verified update | The updated plugin is available in the local installed copies without restarting the app | Both tickets | Tests, validation, and type-check pass; copies agree; actual runtime reload remains explicitly unverified until the user restarts |

## Out of Scope

Gateway changes; editing or printing `.env`; paid model probes; automatic warming
or restarts; implementing an unbounded `always` window; removing bandless-surface
support; new public APIs; and merging or publishing the feature without the
required integration approval.
