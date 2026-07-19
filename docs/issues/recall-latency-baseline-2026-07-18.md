# Recall latency baseline — 2026-07-18

This is the corrected-semantics telemetry-first baseline for the v1 Recall
latency overhaul. It captures the current behavior before any retrieval,
routing, deduplication, or batching changes.

> **Corrected semantics:** this measurement supersedes the figures originally
> committed in `d64707e69`. That first pass timed the whole Claude Code runtime
> as `modelMs`, including time spent executing retrieval tools, and counted
> individual tool calls as `toolRounds`. The corrected collector subtracts the
> union of tool-execution intervals from Claude model wall time, deduplicates
> Claude's thinking/text envelopes by model message id, and counts one tool
> round per model turn that issues one or more tool calls. Native Stella and
> Codex-provider calls already execute tools outside the timed model call, so
> all engine paths now have the same definitions.

## Isolation and method

- Code under test: `[REDACTED HOME]/projects/stella` with the telemetry stack
  from `d64707e69` plus the corrected semantics described above.
- Sample: 10 sequential representative lookups covering durable memory, prior
  agent work, product decisions, episodic history, multi-source history, and a
  deliberate no-match.
- Runtime path: direct `runRecall`, using the same utility-route resolver as the
  production runner. The live desktop process was not invoked or controlled.
- Data access: `~/.stella/stella.sqlite` opened with `readOnly: true` and
  `PRAGMA query_only = ON`; memory and Chronicle markdown files were read only.
- Host app/browser context: intentionally absent (`calls=0`) because this run
  did not query the live app. The local-event SQL read remained enabled at the
  production limit of 800 events.
- All 10 runs completed with an `answer` outcome; no timeouts or transport
  errors occurred.

Reproduction from the repository root:

```bash
node node_modules/esbuild/bin/esbuild runtime/scripts/benchmark-recall-latency.ts \
  --bundle --platform=node --format=esm \
  --banner:js="import { createRequire as __stellaCreateRequire } from 'node:module'; const require = __stellaCreateRequire(import.meta.url);" \
  --outfile=/tmp/stella-recall-latency.mjs
node /tmp/stella-recall-latency.mjs
```

The runner prints timing telemetry and never prints or persists Recall answers.

## Baseline result

| Metric | Median | P90 | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| Total latency (**document-only historical result**) | 18.106s | 28.271s | 16.469s | 36.529s |
| Seed size | 45,091 chars | 52,821 chars | 29,708 chars | 62,538 chars |
| Model calls | 1 | 3 | 1 | 3 |
| Tool rounds | 0 | 2 | 0 | 2 |

`modelCalls` counts true model turns. `toolRounds` counts the subset of those
turns that issue one or more tools, regardless of whether a round issues one
search or several parallel searches. `modelMs` is pure model/runtime wall time:
tool execution remains visible in the per-source timings and `totalMs`, but is
excluded from `modelMs` even when Claude Code owns the tool loop internally.

### Phase timing

| Phase | Median | P90 |
| --- | ---: | ---: |
| Route resolution | 0.102ms | 0.161ms |
| Host context | 9.583ms | 11.566ms |
| Seed searches, wall time | 44.679ms | 65.575ms |
| Prompt assembly | 0.185ms | 0.351ms |
| Model runtime, excluding tool execution | 18.051s | 28.187s |

At the median, model runtime is 99.70% of end-to-end latency. The phase medians
are independently calculated and therefore are not expected to add up exactly
to the median total.

### Per-source retrieval timing

These are per-run medians for the eager seed. File reads run in parallel before
the SQL-backed sources, so the source medians should not be added to infer seed
wall time.

| Source | Kind | Median | P90 | Median rendered chars |
| --- | --- | ---: | ---: | ---: |
| Local context events (800-event read) | SQL | 9.582ms | 11.566ms | n/a |
| Chronicle files | file | 0.495ms | 0.730ms | 29 |
| Resident memory files | file | 1.649ms | 2.375ms | 4,214 |
| Memory keyword search | file | 7.533ms | 10.656ms | 17,177 |
| Agent thread search | SQL | 7.096ms | 10.320ms | 10,533 |
| Transcript search + neighbors | SQL | 27.355ms | 50.271ms | 16,994 |
| Live thread status | SQL | 0.932ms | 1.277ms | 227 |

Four runs initiated deeper searches. Even their observed retrieval work was
small relative to model time. The most search-heavy run made five tool calls in
two true rounds: two transcript searches took 56.317ms in aggregate, one thread
search took 5.805ms, and two memory-file searches took 16.000ms. Those intervals
remain in `totalMs` but are excluded from `modelMs` by wall-clock union, so
parallel tool calls are never double-subtracted.

### Per-run totals

| Query shape | Total | Seed chars | Model time | Tool rounds |
| --- | ---: | ---: | ---: | ---: |
| Memory-system history | 16.469s | 43,054 | 16.404s | 0 |
| Prior CarPlay thread | 17.003s | 52,821 | 16.891s | 0 |
| Browser cleanup race | 16.707s | 51,280 | 16.634s | 0 |
| Utility-model policy | 19.407s | 52,783 | 19.366s | 0 |
| Release workflow | 17.832s | 62,538 | 17.773s | 0 |
| Prompt contract | 28.271s | 47,128 | 28.187s | 2 |
| Product-decision lookup | 21.998s | 37,117 | 21.862s | 2 |
| Episodic lookup | 36.529s | 42,076 | 36.432s | 1 |
| Multi-source billing history | 17.484s | 31,235 | 17.451s | 0 |
| Deliberate no-match | 18.379s | 29,708 | 18.328s | 1 |

## Comparison with the diagnosis baseline

The earlier diagnosis reported a 28s median, 88s p90, and an approximately
45KB seed. Against those reference numbers, this run is 9.894s (35.3%) lower at
the median and 59.729s (67.9%) lower at p90, while the seed is effectively
unchanged at 45,091 median characters.

This comparison is directional, not a controlled before/after experiment: the
query set is representative rather than identical, provider latency varies,
and the measured current dev path selected `claude-code/haiku` for every run.
The prior diagnosis expected the saved `claudeCodeModel: fable` preference to
override the light-tier mapping. Current code still places that saved preference
ahead of the Haiku light default in `getClaudeCodeAgentModelId`, but Recall
passes the application repo path into the model selector, so this direct
production-path replay did not load the saved data-dir preference and selected
Haiku. This discrepancy must be reconciled before the later routing phase; no
routing behavior was changed in this telemetry phase.

## What this baseline establishes

- SQLite/file retrieval is not the latency bottleneck: the full eager seed is
  assembled in tens of milliseconds.
- The oversized seed remains: median 45,091 characters, reaching 62,538.
- Model/runtime time dominates end to end, including Claude Code's internal
  model turns but excluding tool-execution wall time.
- The common sample needed no deeper tool search in 6 of 10 runs; the remaining
  runs used one or two true tool rounds.
- The dev harness runtime was present during the corrected rerun. The read-only
  direct path was retained for exact comparability with the original query set;
  no live desktop process was invoked or controlled.

## Raw audit artifact and same-snapshot replay

The original corrected-semantics figures above remain the phase-(a)/(b)
yardstick. The first benchmark script did not retain its complete per-run JSON,
so phase (c) replayed commit `c2161d8a88f4d587fce9d39ba9970d3c450545b2`
against the exact frozen snapshot used for the quick-win comparison. The raw
artifact is
[`recall-latency-baseline-2026-07-18.raw.json`](./recall-latency-baseline-2026-07-18.raw.json).
It contains the emitted summary plus every run's query, model id, outcome,
phase timings, source timings, seed size, model-call count, and tool-round
count.

Snapshot SHA-256:
`31c0479e5e078df5a5a98c7abfa5b83e226c22da97c56e7eeebc6e0212add0ff`.
The snapshot was made with SQLite's backup API from read-only `~/.stella`, then
the copied database alone was changed from WAL to DELETE journal mode so it
could be reopened read-only without mutable sidecar files. Preferences,
memory, and Chronicle inputs were copied once and never changed between sets.

The same-snapshot replay completed 10/10 with zero errors on
`claude-code/haiku`: median 21.004s, p90 43.642s; median/p90 seed
45,363.5/52,965 characters; median/p90 model calls 1.5/4; median/p90 tool
rounds 0.5/3. Phase medians were route 0.152ms, host context 19.025ms, seed
search 85.852ms, assembly 0.307ms, and pure model time 20.886s. Phase p90s
were 0.463ms, 51.175ms, 122.722ms, 0.624ms, and 43.262s respectively.
