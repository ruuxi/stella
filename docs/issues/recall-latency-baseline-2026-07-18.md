# Recall latency baseline — 2026-07-18

This is the telemetry-first baseline for the v1 Recall latency overhaul. It
captures the current behavior before any retrieval, routing, deduplication, or
batching changes.

## Isolation and method

- Code under test: `/Users/rahulnanda/projects/stella` at the parent of this
  phase's telemetry commit.
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
| Total latency | 20.090s | 26.740s | 11.181s | 27.900s |
| Seed size | 45,187 chars | 52,822 chars | 31,236 chars | 62,539 chars |
| Model calls | 1 | 1 | 1 | 1 |
| Tool rounds | 0 | 3 | 0 | 4 |

`modelCalls` counts Recall's model-runtime invocations. On the current Claude
Code route, one invocation owns its internal tool loop; `toolRounds` counts the
search requests observed inside that invocation.

### Phase timing

| Phase | Median | P90 |
| --- | ---: | ---: |
| Route resolution | 0.187ms | 0.365ms |
| Host context | 12.373ms | 13.799ms |
| Seed searches, wall time | 63.217ms | 93.010ms |
| Prompt assembly | 0.239ms | 0.289ms |
| Model runtime | 20.020s | 26.664s |

At the median, model runtime is 99.65% of end-to-end latency. The phase medians
are independently calculated and therefore are not expected to add up exactly
to the median total.

### Per-source retrieval timing

These are per-run medians for the eager seed. File reads run in parallel before
the SQL-backed sources, so the source medians should not be added to infer seed
wall time.

| Source | Kind | Median | P90 | Median rendered chars |
| --- | --- | ---: | ---: | ---: |
| Local context events (800-event read) | SQL | 12.372ms | 13.798ms | n/a |
| Chronicle files | file | 0.682ms | 0.817ms | 29 |
| Resident memory files | file | 2.415ms | 3.097ms | 4,214 |
| Memory keyword search | file | 10.294ms | 13.965ms | 17,177 |
| Agent thread search | SQL | 21.011ms | 24.764ms | 10,466 |
| Transcript search + neighbors | SQL | 33.336ms | 61.800ms | 16,994 |
| Live thread status | SQL | 2.073ms | 3.087ms | 228 |

Only three runs initiated deeper searches. Even their observed retrieval work
was small relative to model time: the largest aggregate was 80.402ms for two
transcript searches; the same run also spent 8.163ms on one thread search and
12.026ms on one memory-file search.

### Per-run totals

| Query shape | Total | Seed chars | Model time | Tool rounds |
| --- | ---: | ---: | ---: | ---: |
| Memory-system history | 26.740s | 42,816 | 26.664s | 0 |
| Prior CarPlay thread | 11.181s | 52,822 | 11.098s | 0 |
| Browser cleanup race | 25.585s | 51,279 | 25.541s | 0 |
| Utility-model policy | 18.600s | 52,367 | 18.511s | 0 |
| Release workflow | 17.733s | 62,539 | 17.644s | 0 |
| Prompt contract | 19.665s | 47,557 | 19.593s | 0 |
| Product-decision lookup | 26.268s | 37,048 | 26.163s | 4 |
| Episodic lookup | 27.900s | 41,604 | 27.762s | 1 |
| Multi-source billing history | 20.516s | 31,236 | 20.448s | 0 |
| Deliberate no-match | 16.642s | 32,275 | 16.596s | 3 |

## Comparison with the diagnosis baseline

The earlier diagnosis reported a 28s median, 88s p90, and an approximately
45KB seed. Against those reference numbers, this run is 7.91s (28.2%) lower at
the median and 61.26s (69.6%) lower at p90, while the seed is effectively
unchanged at 45,187 median characters.

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
- The oversized seed remains: median 45,187 characters, reaching 62,539.
- Model/runtime time dominates end to end, including Claude Code's internal
  tool loop.
- The common sample needed no deeper tool search in 7 of 10 runs; the remaining
  runs used 1, 3, or 4 tool rounds.
- The missing standalone dev-harness runtime prevented a desktop-driven run;
  the read-only direct path was used instead, as allowed for this phase.
