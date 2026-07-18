# Recall latency phase (c) quick wins — 2026-07-18

This records the route, de-duplication, structured-status, eager-seed-cap, and
telemetry-parity quick wins at commit
`436260aa6d022cfd05cf024a69a40b4fc9473d4e`. It does not include the phase-(d)
single-pass or intent-routing work.

## Isolation and reconstruction

- Direct `runRecall` path only; no live desktop process and no browser/app
  context.
- Same ten queries, same order, sequential execution in every official set.
- One frozen snapshot for every set. Snapshot SHA-256:
  `31c0479e5e078df5a5a98c7abfa5b83e226c22da97c56e7eeebc6e0212add0ff`.
- SQLite was copied from read-only `~/.stella` with the backup API. Only the
  copy's journal mode was normalized from WAL to DELETE for read-only opening;
  the source database was never changed. Preferences, memory, and Chronicle
  files were copied once alongside it.
- Raw artifact:
  [`recall-latency-phase-c-2026-07-18.raw.json`](./recall-latency-phase-c-2026-07-18.raw.json).
  It includes the preflight sample and all 30 official per-run records with
  query, model id, outcome, source timings, phases, seed chars, model calls,
  and tool rounds.
- Corrected baseline replay raw artifact:
  [`recall-latency-baseline-2026-07-18.raw.json`](./recall-latency-baseline-2026-07-18.raw.json).

## Pinned Haiku: like-for-like quick-win delta

Both sets ran `claude-code/haiku`. This comparison therefore does not include
the Fable-to-Haiku route change.

| Metric | Corrected baseline replay | Quick wins, Haiku pinned | Delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Total median | 21.004s | 21.354s | +0.350s (+1.67%) |
| Total p90 | 43.642s | 32.593s | -11.049s (-25.32%) |
| Total min / max | 15.186s / 59.757s | 12.637s / 33.711s | — |
| Seed median | 45,363.5 chars | 8,864 chars | -36,499.5 (-80.46%) |
| Seed p90 | 52,965 chars | 8,871 chars | -44,094 (-83.25%) |
| Seed min / max | 31,311 / 63,629 | 7,281 / 8,900 | — |
| Model calls median / p90 / max | 1.5 / 4 / 4 | 2 / 3 / 5 | — |
| Tool rounds median / p90 / max | 0.5 / 3 / 3 | 1 / 2 / 4 | — |

The median change is within provider/model-turn variance and is not presented
as a speedup. The controlled improvements are the deterministic seed reduction
and the materially lower observed tail.

### Phase breakdown

| Phase | Baseline median | Quick-win median | Baseline p90 | Quick-win p90 |
| --- | ---: | ---: | ---: | ---: |
| Route | 0.152ms | 0.006ms | 0.463ms | 0.010ms |
| Host context | 19.025ms | 9.268ms | 51.175ms | 34.385ms |
| Seed search | 85.852ms | 73.141ms | 122.722ms | 109.360ms |
| Assembly | 0.307ms | 0.251ms | 0.624ms | 0.495ms |
| Pure model wall time | 20.886s | 21.258s | 43.262s | 32.488s |

Quick-win eager-source medians (p90): local events 9.267ms (34.384ms),
Chronicle 0.714ms (1.857ms), memory files 2.164ms (4.403ms), memory search
9.115ms (13.865ms), thread search 16.019ms (29.968ms), transcript search
49.236ms (68.411ms), and live thread status 1.200ms (3.848ms). Tool-source
medians were memory 3.907ms, threads 0ms, and transcripts 27.308ms; zero means
fewer than half the runs used that source after the eager seed.

## Route-change control, measured separately

These two independent sets use the quick-win code and identical snapshot/query
order. The control explicitly pins Fable; the production-active set resolves
the saved Claude Code engine through the new authoritative Recall route and
uses Haiku. This isolates the route/model choice from the earlier code/seed
comparison, but it does not eliminate ordinary nondeterminism in model tool
choices.

| Metric | Quick wins, Fable pinned | Quick wins, active Haiku | Observed delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Resolved model | `claude-code/fable` | `claude-code/haiku` | saved Fable ignored |
| Total median | 20.462s | 27.014s | +6.552s (+32.02%) |
| Total p90 | 31.525s | 36.237s | +4.712s (+14.95%) |
| Total min / max | 8.687s / 37.648s | 13.033s / 57.823s | — |
| Seed median / p90 | 8,868 / 8,875 | 8,868 / 8,875 | no change |
| Model calls median / p90 / max | 2 / 5 / 5 | 2 / 3 / 4 | — |
| Tool rounds median / p90 / max | 1 / 4 / 4 | 1 / 2 / 3 | — |

Active-Haiku phase medians (p90) were route 0.046ms (0.053ms), host context
17.947ms (26.728ms), seed search 61.695ms (90.310ms), assembly 0.207ms
(0.342ms), and pure model wall time 26.897s (36.090s). Fable phase medians
(p90) were 0.007ms (0.010ms), 11.343ms (30.729ms), 64.142ms (146.782ms),
0.239ms (0.839ms), and 20.315s (31.299s), respectively.

The active-route set was slower in this sample. Nearly all of the difference
is model wall time, not routing or retrieval. The correct conclusion is that
the route fix is a policy/cost/correctness fix whose latency effect was noisy
and adverse in these ten independent runs—not that Haiku was proven faster.

## Route-resolution proof

Automated route tests use saved preferences and assert these exact outcomes:

| Active orchestrator engine | Recall execution | Resolved model |
| --- | --- | --- |
| Stella | managed native provider | `stella/deepseek/deepseek-v4-flash` |
| Claude Code, saved `claudeCodeModel: fable` | Claude Code | `claude-code/haiku` |
| Codex/ChatGPT | direct OpenAI provider (`openai-codex-responses`) | `openai-codex/gpt-5.6-luna` |

The Codex/ChatGPT route is `direct-provider`; it does not invoke the Codex CLI
and does not use the Stella relay. The Claude path resolves preferences from
the data directory, passes the repository only as CLI `cwd`, and carries an
explicit Haiku model override. Thus repository-path versus data-directory
configuration no longer changes the selected Recall model.
