# Recall latency phase (d), round-5 correction — 2026-07-18

This is the correctness-qualified replacement for the round-4 phase-(d)
measurement. The implementation is commits `7a36236acc70a8b4e99645f72fb8fdcf4bef5fd5`,
`2bef89149b6fd6311d53773719c524c0f8b50711`,
`675f65ea02d9f03a3fba5e7b74db7d9f02c6bfa3`,
`276bcc78404f4d6be60d7f8714e39763bbb84c4b`,
`4b356de9db04e3492aeeabb6165b494e6c9bf94f`, and
`8bb44874130f84168caefaa018b74f1fa65811c9`. No v2 code is included.

## Isolation and protocol

- Direct `runRecall` only; no live app, browser context, or dev desktop process.
- Canonical ten queries in the established order, sequentially in each set.
- SQLite was copied from read-only `~/.stella` with `.backup`; preferences,
  memories, and Chronicle were copied once. The copy alone pins
  `claudeCodeModel: haiku` for the old-control replay.
- Frozen input SHA-256:
  `a3a07ceda9eeab4e256c4c59b9dc0581aa802c22f18eb4895fce829710b5557a`.
- The c216 control and final Haiku/Fable runs all use that exact snapshot.
- Every final run retains its full secret-, email-, phone-, and postal-address-
  redacted brief plus query, model id, structured outcome, phases, source
  timings, seed size, model calls, and tool rounds.

Raw artifacts:

- [`control-c216`](./recall-latency-phase-d-round5-2026-07-18.control-c216.raw.json)
- [`Haiku pinned`](./recall-latency-phase-d-round5-2026-07-18.haiku.raw.json)
- [`Fable pinned`](./recall-latency-phase-d-round5-2026-07-18.fable.raw.json)
- [`audit/discard manifest`](./recall-latency-phase-d-round5-2026-07-18.audit.json)

## Controlled result: c216 to corrected phase (d), Haiku pinned

| Metric | c216 control | Corrected phase (d) | Delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Total median | 23.492s | 238.531ms | -23.254s (-98.98%) |
| Total p90 | 47.317s | 10.779s | -36.538s (-77.22%) |
| Total min / max | 16.512s / 50.886s | 32.545ms / 11.618s | — |
| Seed median / p90 | 47,429.5 / 53,688 chars | 979 / 12,000 chars | -97.94% / -77.65% |
| Model calls median / p90 / max | 1.5 / 3 / 4 | 0 / 1 / 1 | — |
| Tool rounds median / p90 / max | 0.5 / 2 / 3 | 0 / 0 / 0 | eliminated |

### Phase breakdown

| Phase | c216 median | Corrected median | c216 p90 | Corrected p90 |
| --- | ---: | ---: | ---: | ---: |
| Route | 0.096ms | 0.006ms | 0.141ms | 0.009ms |
| Host context | 22.725ms | 0.022ms | 27.441ms | 0.092ms |
| Retrieval / seed search | 84.675ms | 185.804ms | 105.602ms | 219.080ms |
| Assembly | 0.199ms | 0.012ms | 0.336ms | 0.029ms |
| Pure model wall time | 23.382s | 0ms | 47.131s | 10.652s |

Corrected per-source retrieval medians (p90) were durable memory 4.717ms
(117.118ms), episodic/FTS retrieval 180.081ms (212.165ms), thread/delegated
work 0ms (28.101ms), and the FTS health probe 0.340ms (3.190ms). Zero thread
median means fewer than half the query routes consulted that source; it does
not mean a thread query took zero time.

## Brief audit and fast-path result

The old **6/6** common-hit claim is withdrawn. Round 4 did not persist briefs,
and review proved that unrelated results could jointly satisfy the old pack-
level anchor test.

With complete briefs retained, the final Haiku set has:

- **6/10 zero-model routes (60%)**: one direct fact, four deterministic
  no-matches, and the deliberate no-match.
- **1/9 successful direct-answer hit rate (11.1%)**, excluding the deliberate
  no-match. The one answer (`memory_system`) is a relevant single memory entry
  and took **32.545ms**.
- **1/1 audited direct-answer precision in this sample**. This is not a global
  accuracy claim; the other old “hits” are now rejected rather than returned.
- Four synthesis routes: browser cleanup, prompt contract, episodic drive, and
  billing. Each made one model call and zero tool rounds. The first three
  returned structured `no-match`; billing returned the supported answer.
- The six zero-model runs took 32.545–253.077ms. The five zero-model no-match
  outcomes are visible verbatim in the raw file.

The intentionally strict gate trades some recall for precision on this frozen
snapshot. In particular, CarPlay, utility-policy, release, and radial queries
no longer return unrelated rows just because separate anchors appear somewhere
in a large pack. Exact-phrase and bare-repository deterministic shapes remain
covered by focused tests; ambiguity, multi-intent, and episodic shapes synthesize.

## Route change, kept separate

| Metric | Fable pinned | Haiku pinned | Observed Haiku delta |
| --- | ---: | ---: | ---: |
| Samples / errors | 10 / 0 | 10 / 0 | — |
| Resolved model | `claude-code/fable` | `claude-code/haiku` | policy route only |
| Total median | 183.884ms | 238.531ms | +54.647ms (+29.72%) |
| Total p90 | 5.415s | 10.779s | +5.363s (+99.04%) |
| Seed median / p90 | 979 / 12,000 | 979 / 12,000 | identical |
| Model calls median / p90 / max | 0 / 1 / 1 | 0 / 1 / 1 | identical |

This is observational provider variance across four model-bearing runs. It is
not folded into the architectural delta and does not change the required route:
the active Claude Code engine resolves Recall to Haiku, never saved Fable.

## Historical view and audit boundary

| Stage | Median | P90 | Seed median | Model-call median | Audit status |
| --- | ---: | ---: | ---: | ---: | --- |
| Original corrected baseline | 18.106s | 28.271s | 45,091 | 1 | document-only historical result |
| Auditable c216 replay (phase-c snapshot) | 21.004s | 43.642s | 45,363.5 | 1.5 | raw per-run telemetry |
| Phase (c), Haiku pinned | 21.354s | 32.593s | 8,864 | 2 | raw; p90 -25.3% **OBSERVATIONAL** (5/10 improved, 5/10 regressed) |
| Round-4 phase (d), Haiku pinned | 121.941ms | 13.363s | 8,517 | 0 | timings confirmed; direct-hit claim unauditable and withdrawn |
| Fresh c216 control, round-5 snapshot | 23.492s | 47.317s | 47,429.5 | 1.5 | full briefs + telemetry |
| Corrected phase (d), round-5 snapshot | 238.531ms | 10.779s | 979 | 0 | full briefs + telemetry |

The original 18.106s number is explicitly document-only. The 21.004s replay
is the older auditable raw control. The fresh 23.492s c216 replay is the exact-
snapshot control for the round-5 comparison. The prior -99.44% phase-(d)
median was independently timing-confirmed, but it depended on unsafe direct
answers; the correctness-qualified same-snapshot result is **-98.98% median**.

## Discarded-run reconciliation

The round-4 raw artifact contains four discarded entries, not two: one-query
preflight, pre-reset Haiku session-limit run, invalid c216 HOME-redirect run,
and the first valid c216 aggregate superseded by the full-telemetry replay.
All four are now named in the audit manifest.

Round 5 additionally records every diagnostic set in the manifest. Safe raw
sets are committed. The first preflight is metadata-only because it exposed the
postal-address redaction gap that the next commit fixed; persisting that brief
would defeat the redaction. One intermediate file was overwritten during the
audit loop before promotion; its console summary is recorded and it is not used
in any aggregate. No discarded set contributes to the tables above.

## Validation

- 84 focused tests passed across the architectural path, routing-index caps,
  prompt contract, Dream usage/debounce, FTS probes/store behavior, and batched
  transcript reads before measurement; the final confidence suite has 8/8
  tests.
- Renderer, Electron, and preload TypeScript checks passed.
- Runtime boundary check, ESLint, and `git diff --check` passed.
- Final raw JSON passed a secret/email/private-key scan.
