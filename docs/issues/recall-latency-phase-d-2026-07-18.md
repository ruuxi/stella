# Recall latency phase (d) — architectural overhaul — 2026-07-18

Implementation commit: `75cf48242f0f76a763f36d377e62006cff152250`.
This phase adds deterministic intent routing, a zero-model direct-results path,
one-pass/one-call synthesis, a resident memory routing index, usage feedback,
FTS degradation alarms, and batched secondary reads. It does not include a v2
port.

## Isolation and protocol

- Direct `runRecall` path only; no live desktop process, browser context, or
  live-app mutation.
- Canonical ten queries, same order, sequential execution.
- Frozen read-only data copy: SQLite backup plus copied preferences, memories,
  and Chronicle files. SHA-256:
  `9eab35346cb1eeb3ff7151432a41712fab33166f0d01549f799baa116b447442`.
- The frozen preference copy was pinned to `claudeCodeModel: haiku` only so the
  old c216 control could use the same model. Current-code runs used explicit
  route pins, which ignore that preference.
- The phase-(c) temp snapshot no longer existed. Therefore the exact controlled
  comparison in this note is a fresh c216 replay and phase-(d) run on the new
  frozen snapshot. Historical phase-(c) figures are retained below but are not
  claimed to be byte-identical-snapshot comparisons.
- Full emitted summaries and per-run telemetry (model id, outcome, source
  timings, seed chars, model calls, tool rounds, intent, fast-path flag, and
  source inbox/thread-run IDs) are in
  [`recall-latency-phase-d-2026-07-18.raw.json`](./recall-latency-phase-d-2026-07-18.raw.json).

## Controlled result: c216 baseline to phase (d), Haiku pinned

| Metric | c216 control | Phase (d) | Delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Total median | 21.895s | 0.122s | -21.774s (-99.44%) |
| Total p90 | 41.269s | 13.363s | -27.906s (-67.62%) |
| Total min / max | 12.881s / 48.012s | 1.601ms / 15.596s | — |
| Seed median / p90 | 46,654.5 / 52,857 chars | 8,517 / 8,517 chars | -81.74% / -83.89% |
| Model calls median / p90 / max | 2 / 4 / 4 | 0 / 1 / 1 | — |
| Tool rounds median / p90 / max | 1 / 3 / 3 | 0 / 0 / 0 | eliminated |

### Phase breakdown

| Phase | c216 median | Phase-d median | c216 p90 | Phase-d p90 |
| --- | ---: | ---: | ---: | ---: |
| Route | 0.122ms | 0.008ms | 0.328ms | 0.013ms |
| Host context | 35.409ms | 0.014ms | 44.307ms | 0.032ms |
| Retrieval / seed search | 96.472ms | 44.213ms | 138.836ms | 232.963ms |
| Assembly | 0.237ms | 0.014ms | 0.622ms | 0.056ms |
| Pure model wall time | 21.646s | 0ms | 41.073s | 13.338s |

The phase-d median model time is zero because seven of ten queries made no
model call. The p90 still reflects the residual episodic/multi-source synthesis
cases, which each made exactly one Haiku call.

## Fast path

- Zero-model routing rate: **7/10 (70%)** across the complete mixed benchmark.
- Successful direct-result hit rate: **6/9 (66.7%)** after excluding the
  deliberate no-match from the denominator.
- On the six representative common matches (repo/memory fact, prior thread,
  utility policy, release rules, prompt contract, and prior product decision):
  **6/6 hit rate**, median **22.007ms**, p90 **240.577ms**, range
  **1.601–240.577ms**.
- The deliberate Zephyr no-match also stayed deterministic: **162.570ms,
  zero model calls**, after the memory-index-first pass and one anchored
  transcript fallback.

The six common direct results were 25.949ms, 81.311ms, 18.065ms, 1.601ms,
10.317ms, and 240.577ms. The three residual synthesis cases took 15.596s,
7.080s, and 13.363s, with one model call each and zero tool rounds.

## Route change measured separately

Both current-code sets used the identical frozen snapshot and query order. The
only intended difference was the explicit Claude model pin.

| Metric | Fable pinned | Haiku pinned | Observed Haiku delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Total median | 139.765ms | 121.941ms | -17.824ms (-12.75%) |
| Total p90 | 9.456s | 13.363s | +3.907s (+41.31%) |
| Model calls median / p90 / max | 0 / 1 / 1 | 0 / 1 / 1 | no routing-loop change |
| Seed median / p90 | 8,517 / 8,517 | 8,517 / 8,517 | no change |

This route delta is observational provider variance across only three
model-bearing queries. It is kept separate from the architectural comparison;
Haiku is the required policy route, not a claimed latency win over Fable.

## Historical three-stage view

| Stage | Median | P90 | Seed median | Model-call median |
| --- | ---: | ---: | ---: | ---: |
| Corrected baseline (original snapshot) | 18.106s | 28.271s | 45,091 | 1 |
| Phase (c), Haiku pinned (phase-c snapshot) | 21.354s | 32.593s | 8,864 | 2 |
| Phase (d), Haiku pinned (new frozen snapshot) | 0.122s | 13.363s | 8,517 | 0 |

The previously cited phase-(c) p90 reduction of **25.3% is OBSERVATIONAL**:
only 5/10 paired queries improved and 5/10 regressed. It is not used as the
causal yardstick here. The fresh same-snapshot c216 replay above is the
controlled architectural yardstick.

## Per-fix attribution

1. **Intent routing + no-LLM path:** directly explains the seven zero-call
   results, the 0ms median model phase, and most of the median collapse.
2. **Single indexed pass + one synthesis:** residual cases now have
   `modelCalls=1`, `toolRounds=0`, deterministic merge/packing, and at most one
   anchored retrieval fallback. This removes the old serial multi-round tail.
3. **Routing index:** `memory_index.md` is seeded before resident-memory
   injection, searched before `memory_summary.md`/`MEMORY.md`, and Dream is
   instructed to maintain task families, aliases, repos, paths, decisions, and
   retrieval hooks. The frozen snapshot predates its population, so this run
   does not claim a separate latency gain from future index learning.
4. **Usage feedback:** surfaced thread evidence includes inbox/thread/run IDs;
   production calls `recordUsage()`, requeues the row, and Dream orders pending
   rows by usage/recency. The read-only benchmark correctly logged those writes
   as skipped; source IDs remain in raw results.
5. **Batching and alarms:** transcript neighbors are expanded by one SQL query;
   irrelevant intents no longer load 800 local events (live intent loads only
   five). Missing/unbackfilled transcript or thread FTS now emits
   `[stella:recall:fts-degraded]` and fails retrieval before the store can enter
   its LIKE fallback.
6. **Captured engine and no-match parity:** the tool forwards the active run's
   `modelConfigSnapshot`; disk preference changes cannot reroute Recall
   mid-turn. Case-insensitive `Nothing relevant found...` variants share one
   classifier in the runner and lookup path.

## Claude CLI-spawn feasibility

Claude Code subscription authentication is owned internally by the CLI and is
not exposed as an Anthropic provider credential. Reusing a stateful CLI session
for unrelated lookups would contaminate independent Recall prompts, so that is
not a clean option.

Implemented compromise: if Stella has an independent Anthropic credential,
Claude-engine Recall resolves `anthropic/claude-haiku-4-5` through the
in-process provider and spawns no CLI. Otherwise the three residual synthesis
cases use one fresh Haiku CLI process each; the seven fast-path cases use no
process and no model. Route tests cover both outcomes plus authoritative saved
Fable rejection.

## Validation and measurement notes

- 67 focused runtime tests passed across context lookup, architectural routing,
  route resolution, batch queries, Dream usage, Dream scheduling, and resident
  memory injection.
- Electron and preload TypeScript checks passed.
- Runtime boundary check and `git diff --check` passed.
- One pre-reset Haiku set was discarded after Claude Code reported its session
  limit during three synthesis cases. One initial c216 attempt was discarded
  because redirecting `HOME` hid Claude CLI auth. Neither contributes to any
  aggregate; both are named in the raw artifact's audit metadata.

