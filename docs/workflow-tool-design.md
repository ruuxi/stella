# Design of record: the Stella workflow tool (`run_workflow`)

Status: design only — nothing here is implemented. Reference point is Anthropic's
Claude Code workflows (code.claude.com/docs/en/workflows), from which Stella
deliberately diverges; see §16.

## 1. What this is and why

Today the orchestrator hand-drives every multi-agent pattern: `spawn_agent` a
reviewer, wait for the hidden `[Agent completed]` follow-up, read the report,
triage it, `send_input` a fix to the builder thread, spawn fresh reviewers, and
loop — one orchestrator turn per step. The loop's control flow (round counts,
which findings were already dismissed, when "done" is done) lives only in the
orchestrator's context window, burning turns and tokens on bookkeeping that is
not judgment.

The workflow tool reifies that loop. The orchestrator describes the workflow in
natural language, exactly as it would brief a sub-agent. A **workflow-authoring
LLM** — a new agent type running on the orchestrator's exact engine, model,
and reasoning configuration —
writes a JS/TS script against a small workflow SDK and runs it directly as
trusted code (no sandbox — §7). The script spawns and joins leaf agents, applies real
control flow (loops, barriers, retries, dedupe sets), and calls back into LLM
judgment nodes where a decision is needed. When the authoring LLM decides the
work is done, it finalizes with a result — the workflow completes exactly like
any spawned agent completing, delivering its report to the orchestrator through
the existing lifecycle follow-up path.

`spawn_agent` / `send_input` / `pause_agent` are kept unchanged and remain the
right tool for simple delegation (one task, one report). The workflow tool is
for the patterns that today take five or more orchestrator turns: review →
triage → fix → re-review loops, fan-out audits with adversarial verification,
migration sweeps, judge panels.

### Name

- **Tool name: `run_workflow`.** The desktop UI already reserves this name in
  the tool-activity exclusion list (`desktop/src/features/chat/lib/tool-activity.ts:85`),
  so the chat surface is expecting it; keep it.
- **Feature name: "Constellation."** Claude Code gates its equivalent behind
  the `ultracode` keyword. Stella does not need a keyword: the orchestrator has
  standing judgment about when to delegate, and workflow-vs-spawn_agent is the
  same kind of choice as spawn-vs-inline, steered by prompt guidance rather
  than a magic token. But the feature needs a user-facing name for docs, the
  card, and conversation ("run a constellation on this"). *Constellation* is
  Stella-native — many stars arranged into one figure — and reads correctly in
  the UI ("Constellation · Review & fix · 4 running / 11 done"). The word
  never appears in the tool schema; it is purely presentational.

## 2. Where it lives in Stella's architecture

Stella's runtime is Pi-shaped: kernel primitives under `runtime/kernel/`,
Stella-specific behavior in extensions under `runtime/extensions/`, tools as
`ToolDefinition`s registered through `runtime/kernel/tools/defs/index.ts`, and
the desktop renderer consuming lifecycle events. The workflow feature slots in
as one new kernel module plus one tool def, one agent definition, one prompt,
and two UI surfaces:

| Piece | Location | Pattern it follows |
| --- | --- | --- |
| Workflow runtime (scheduler, journal, SDK bindings, script host) | `runtime/kernel/workflow/` (new) | sibling of `runtime/kernel/agents/` |
| Tool def `run_workflow` | `runtime/kernel/tools/defs/workflow.ts`, registered in `defs/index.ts` | `createAgentTools(stateContext)` DI pattern — closes over `agentApi`/`LocalAgentManager` at construction (`runtime/kernel/tools/defs/task.ts:22`); capability never flows through `ToolContext` |
| `workflow` agent type | `AGENT_IDS.WORKFLOW` in `runtime/contracts/agent-runtime.ts:1` + an `AgentDefinition` in `BUILTIN_AGENT_DEFINITIONS` | the `general` agent def (`agent-runtime.ts:153`) |
| Authoring-LLM system prompt | `runtime/extensions/stella-runtime/agents/workflow.md` | markdown agents, loaded via `loadParsedAgentsFromDir` |
| SDK operating guidance (patterns, examples) | `runtime/home-seed/skills/stella-workflows/SKILL.md` | "keep schemas narrow… put larger operating guidance into a skill" (stella-runtime-extension skill) |
| Leaf-agent execution | `LocalAgentManager.runEphemeralAgent` (`runtime/kernel/agents/local-agent-manager.ts:1471`) | **already built for this feature, currently zero callers** — its docstring: "the execution primitive for workflow scripts — their agents report to the script, not to the orchestrator" |
| Journal storage | new `workflow_runs` + `workflow_journal` tables in `runtime/kernel/storage/database-init.ts`, methods on `SessionStore` | `runtime_thread_entries` / `run_event_log` precedent |
| Chat card | `desktop/src/app/chat/WorkflowCard.tsx` (new) + a `workflowRun` field on `AssistantRowViewModel` | `BackgroundWorkCard` derivation (`use-event-rows.ts:150`) |
| Activity row | new `workflow` row variant in `features/chat/lib/event-transforms.ts` | `TaskGroup` rollup semantics |

Three seams in the existing code confirm the runtime was already shaped for
this and should be consumed, not re-invented:

1. `runEphemeralAgent` (above) — single agent turn outside the durable task
   surface: no work slot, no lifecycle event, no orchestrator follow-up.
2. `sendAgentMessage` already special-cases `agentType === "workflow"`
   (`local-agent-manager.ts:1747`) — the guard text changes under this design
   (§10) but the branch point exists.
3. `runSubagent`'s `selfModFeature` parameter (`local-agent-manager.ts:466`)
   exists specifically so all steps of one workflow commit to ONE self-mod
   feature instead of fragmenting per-step. The workflow runtime passes its
   `{featureId: workflowThreadId, featureTitle: description}` into every leaf
   run.

### Execution topology

```
orchestrator turn
  └─ run_workflow(description, prompt)          ← tool returns thread_id immediately
       └─ workflow thread (agentType "workflow", durable runtime_threads row)
            authoring LLM  ── run_script ──▶  workflow script (trusted JS/TS)
                 ▲                              │ agent()/llm()/parallel()/pipeline()
                 │ script result / error        ▼
                 │                      workflow scheduler (semaphore, journal)
                 │                              │
                 └── advise(snapshot) ──▶ orchestrator/user
                                                ├─ runEphemeralAgent (leaf, one-shot)
                                                ├─ persistent leaf thread (builder)
                                                └─ llm node (single model call)
```

The authoring LLM is a normal Stella agent session (a `SubagentSession` under
`LocalAgentManager`, so pause/queue/abort machinery applies) whose tool catalog
is exactly: `run_script`, `advise`, and read-only context tools (`Read`/`grep`
class) for scouting before authoring. It has no `spawn_agent`: all spawning
goes through the script, so every agent is journaled.

## 3. Invocation

`run_workflow` behaves like `spawn_agent`: orchestrator-only
(`agentTypes: [AGENT_IDS.ORCHESTRATOR]`), fire-and-forget, returns a durable
`thread_id` immediately, completion arrives later as the standard hidden
`[Agent completed]` follow-up (`buildAgentEventPrompt`,
`runtime/kernel/runner/shared.ts:109`).

```jsonc
// parameters (JSON Schema)
{
  "description": { "type": "string" },   // 2–6 words; becomes the thread name, card title
  "prompt":      { "type": "string" },   // the full natural-language brief; the authoring LLM's only task context
  "resume_from": { "type": "string" }    // optional: a prior workflow thread_id — new run, journal replay (§8)
}
// required: ["description", "prompt"]
```

Deliberately absent: `model` (§4 — the authoring LLM always mirrors the
orchestrator), `script` (the orchestrator never writes scripts; authoring is
the workflow LLM's job), agent archetypes, budgets. The prompt is the entire
interface, same as `spawn_agent`.

The tool result mirrors `handleSpawnAgent`'s shape
(`runtime/kernel/tools/state.ts:344`): `{ thread_id, created: true,
running_in_background: true, follow_up_on_completion: true, note: "Workflow
has started but is NOT finished yet…" }`.

## 4. Strict engine + model + reasoning inheritance

**Rule: `run_workflow` snapshots the parent orchestrator run's exact
`{ engine, model, reasoning }`, and every workflow-authoring turn and judgment
`llm()` call runs on that snapshot. There is no authoring or judgment override
and no fallback to another engine, model, or reasoning configuration.** This
applies to Stella `default`, native Claude Code (`claude_code_local`), and
native Codex (`codex_cli`). Sub-agents spawned by the script MAY take a
per-agent `model` with exactly `spawn_agent`'s grammar (`stella/light`,
`anthropic/…`, `openrouter/…`, `codex`, `claude-code`, `codex/<m>`,
`claude-code/<m>` — parsed by the existing `parseSpawnAgentModel`,
`runtime/kernel/tools/state.ts:87`); when omitted, a leaf inherits the
workflow's exact parent snapshot too. An explicit per-agent override is the
only permitted exception to parent-engine inheritance.

### Resolution and propagation

The snapshot is taken **from the invoking run, not re-derived from
preferences**, so a mid-conversation model switch can't desync the workflow
from the turn that launched it:

1. The orchestrator runner already registers per-run callbacks keyed by
   `rootRunId` (`runCallbacksByRunId`, `runtime/kernel/runner/agent-orchestration.ts`).
   Extend that registration to also expose the run's resolved
   `{ agentEngine, modelRef/resolvedLlm, reasoning }`. Engine and model already
   exist on the orchestrator's `LocalAgentContext` (`agentEngine` computed at
   `runtime/kernel/runner/context.ts:864`, model at `:940`); the selected
   reasoning configuration must travel with the same per-run record.
2. `run_workflow`'s handler looks the snapshot up via `context.rootRunId`
   (present on `ToolContext`, `runtime/kernel/tools/types.ts:20`). There is no
   preference re-resolution fallback: if the invoking run's exact snapshot is
   unavailable, workflow creation fails clearly before authoring starts.
3. The snapshot `{ engine, model, reasoning }` is stored on the workflow's
   `RuntimeAgentRecord` / run row and pinned for the run's lifetime. Every
   authoring turn and judgment call receives all three pinned values; global
   preferences are never consulted once the workflow starts.
4. Native external dispatch is strict:
   - `codex_cli` executes authoring and judgment through the native Codex
     engine/session path with the snapshotted Codex model and reasoning.
   - `claude_code_local` executes authoring and judgment through the native
     Claude Code engine/session path with the snapshotted Claude model and
     reasoning.
   - Both retain normal progress streaming through their native engine
     adapters. A tool-bridge spike may prove that `run_script`/`advise` and
     progress events work inside those native sessions, but that bridge is
     transport only; it may never substitute inference on Stella's provider
     path or any other engine.
5. If the selected native engine cannot start, loses authentication, lacks the
   selected model/reasoning mode, or cannot execute a workflow authoring or
   judgment call, the workflow fails with a clear engine-specific error. It
   never silently reroutes, changes models, drops reasoning, or degrades to a
   generic provider call.
6. A **resume** (`resume_from`) is a new invocation and re-snapshots the parent
   orchestrator's *then-current* `{ engine, model, reasoning }` — "always
   current" beats "sticky to the original run".

Leaf agents: the scheduler translates each `agent()` call's `model` opt through
`parseSpawnAgentModel` into `model` / `spawnEngine` on the ephemeral run's
context fetch, identical to `spawn_agent`'s channel
(`AgentToolRequest.model|spawnEngine`, `tools/types.ts:127`). No `model` opt →
the exact `{ engine, model, reasoning }` snapshot is passed down explicitly
(this is a behavior *change* relative to `spawn_agent`, whose children fall
back to their own agent-type preference — inside a workflow, strict parent
inheritance is the default).

Judgment nodes (`llm()`) always run through the snapshotted engine's own
adapter/session with the snapshotted model and reasoning — never the
`stella/light` utility pin and never a provider route belonging to another
engine — because triage/decide-done is precisely the judgment configuration
the user chose.

One asymmetry here is deliberately **provisional, not locked in**: leaf
`agent()` calls accept a per-agent `model` override while `llm()` judgment
nodes currently do not. A separate per-node **model-selection design** is
being written in parallel with this doc and is expected to let judgment nodes
pick a model too, with pre-included selection guidance. When that doc lands it
supersedes this paragraph's no-override rule; the two documents must be
reconciled at that point rather than either silently winning. Until then,
strict snapshot inheritance is the implemented default for `llm()`.

## 5. Three-layer separation

The design's core discipline, enforced by the SDK shape and the authoring
prompt:

1. **Deterministic control flow is real code.** Loops, joins, retries, round
   counters, dedupe sets, thresholds, majority votes — plain JS in the script.
   Never ask a model to count rounds or remember which findings were already
   dismissed; that state lives in variables and survives in the journal.
2. **Judgment is an explicit LLM node inside the workflow.** `llm(prompt,
   {schema})` — a single, tool-less model call on the workflow's inherited
   model, prompted dynamically with the data in flight ("here are 9 findings
   and the builder's report; which are real and worth fixing this round?").
   Triage, decide-done, scoring, synthesis are all this layer. Cheap,
   journaled, replayable.
3. **Leaf work is agents.** `agent(prompt, opts)` runs a full tool-using agent
   turn via `runEphemeralAgent`. **There are no predefined agent archetypes —
   no "reviewer", "fixer", "researcher" registry. Role is always in the
   prompt**, authored fresh by the workflow LLM for the task at hand. The only
   agent definition involved is `general` (which is what `spawn_agent`
   hard-pins today anyway, `state.ts:250`).

The authoring LLM sits above all three: it writes the script, reads its
returned value or error, optionally edits and re-runs (with journal replay),
and finally composes the workflow's result text — the same "final text is the
report" contract every Stella agent has.

## 6. The workflow SDK

Plain JavaScript (TS type annotations accepted and stripped — see §7). The
script body runs in an async context; top-level `await` and a final `return`
are the norm. Globals:

```ts
// ---- leaf agents -------------------------------------------------------
function agent(prompt: string, opts?: {
  label?: string;          // display label for card/journal (default: derived from prompt)
  model?: string;          // spawn_agent grammar; omit → inherit parent engine+model+reasoning
  schema?: object;         // JSON Schema; result is validated/parsed, auto-retried (≤2) on mismatch
  timeoutMs?: number;      // per-call guard; default none
}): Promise<any>;
// Resolves to the agent's final text (string), or the parsed object when
// schema is given. Resolves to null if the run is aborted or dies on a
// terminal provider error after internal retries — filter with .filter(Boolean).

// ---- persistent leaf thread (multi-turn agent, e.g. a builder) ----------
function thread(label: string, opts?: { model?: string; system?: string }): WorkflowThread;
interface WorkflowThread {
  send(prompt: string, opts?: { schema?: object }): Promise<any>; // one turn, context accumulates
  readonly id: string;
}

// ---- judgment node (no tools, single call, workflow model) --------------
// NOTE: no per-node model opt today — provisional pending the parallel
// model-selection design (§4), which is expected to add one with guidance.
function llm(prompt: string, opts?: { schema?: object; system?: string }): Promise<any>;

// ---- composition ---------------------------------------------------------
function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
// BARRIER: awaits every thunk; a thrown thunk resolves to null in the array,
// the call itself never rejects. Use ONLY when a later step genuinely needs
// ALL prior results together (dedup across the full set, zero-count early exit,
// "compare against the other findings" prompts).

function pipeline(items: any[], ...stages: Array<(prev: any, item: any, index: number) => any>): Promise<any[]>;
// STREAMING — the default composition. Each item advances to its next stage the
// moment it is ready; item A can be in stage 3 while item B is in stage 1.
// Wall-clock cost = the slowest single item's chain, not the sum of each
// stage's slowest member. A stage that throws drops that item to null and
// skips its remaining stages.

// ---- quality-pattern helpers (thin, journaled compositions of the above) --
function adversarialVerify(claim: string, opts?: {
  skeptics?: number;       // default 3 — N independent agents each prompted to REFUTE the claim
  context?: string;        // evidence handed to every skeptic
  threshold?: number;      // default majority; claim survives if refutals < threshold
}): Promise<{ survives: boolean; votes: Array<{ refuted: boolean; reason: string }> }>;

function judgePanel(task: string, opts?: {
  attempts?: number | string[];  // default 3; or explicit per-attempt angle prompts
  judges?: number;               // default 3 independent scorers per attempt
  synthesize?: boolean;          // default true: final llm() merges winner + best runner-up ideas
}): Promise<{ winner: any; scores: number[][]; synthesis?: string }>;

function loopUntilDry<T>(finder: (round: number, seen: ReadonlySet<string>) => Promise<T[]>, opts?: {
  dryRounds?: number;            // default 2 consecutive empty rounds ends the loop
  key?: (item: T) => string;     // dedupe key; repeats never count as "fresh"
  maxRounds?: number;            // safety valve only; default none (lifetime cap is the backstop)
}): Promise<T[]>;

function sweep(angles: Array<{ label: string; prompt: string; model?: string }>): Promise<Array<{ label: string; result: any }>>;
// multi-modal sweep: parallel searchers, each blind to the others' angle

// ---- narration & control --------------------------------------------------
function phase(title: string): void;              // card/activity phase; groups subsequent agents
function log(message: string): void;              // one narrator line on the card + journal
function advise(emission: {
  whatIDid: string;
  relevantFindings: string[];
  currentState: string;
  whyFlagging: string;
  question?: string;
  recommendation?: string;
  audience?: "orchestrator" | "user" | "both"; // default: orchestrator
}): void; // FIRE-AND-FORGET; returns immediately and never pauses (§12)
```

`pipeline` is the default the authoring prompt teaches; `parallel` is reserved
for genuine cross-item barriers. The four quality helpers are *conveniences*,
not privileged runtime constructs — each is expressible in ~10 lines of
`agent`/`llm`/`parallel`, and the authoring LLM composes novel harnesses freely
when the task calls for it. They exist so the common shapes are one journaled
call with tested vote/dedupe logic instead of re-derived boilerplate.

Structured output: Stella's `ToolResult.result` is untyped
(`tools/types.ts:44`) and there is no structured-output tool, so `schema` is
enforced at the SDK boundary — the leaf's prompt gets a "return only JSON
matching this schema" suffix, the result is parsed and validated, and on
mismatch the same session is re-asked once or twice before the call rejects.

## 7. Execution model and determinism (no sandbox)

The authored control-flow script runs **directly as trusted code** in the
workflow runtime worker — the same trust level as the authoring model itself.
There is no QuickJS/WASM interpreter and no hardened `node:vm`; sandboxing was
dropped deliberately. The authoring LLM is the orchestrator's own
engine+model+reasoning configuration
and does what it is briefed to do, so wrapping its orchestration glue in a
realm jail bought isolation the threat model does not require, at real cost in
async host bridging. The execution model is:

- **The SDK globals in §6 are ordinary functions in scope**, executing on the
  host under the scheduler (spawning agents, model calls, journal writes).
  Standard JS built-ins (`JSON`, `Math`, `Array`, `Set`, `Map`, `RegExp`, …)
  are available. Node/Bun APIs are not technically blocked — there is no
  sandbox — but importing or calling them (`fs`, `fetch`, `child_process`, …)
  is **lint-flagged** (below), for journal-integrity reasons, not security: an
  inline `fs` read or `fetch` is leaf work performed *outside the journal*, so
  it silently re-executes on every resume and leaves no trace in the debug
  record. Real work belongs in leaf agents, where it is journaled; the script
  is orchestration glue.
- **Determinism is a soft convention — but the lint is active, not advisory.**
  With no interpreter to trap on, `Date.now()`, `Math.random()`, and argless
  `new Date()` no longer throw, and §8's effect-replay means they cannot
  corrupt a resume's *correctness*. They can silently destroy its *value*: a
  `Date.now()` interpolated into a prompt changes that call's fingerprint,
  diverges the match right there, and re-executes everything issued after it —
  re-spawning expensive agents to recompute results the journal already holds.
  So the pre-execution lint **does flag** (not "may flag") ambient-
  nondeterminism calls and Node/Bun imports, and its findings are **surfaced
  in the `run_script` result** alongside the run digest — the authoring LLM is
  the one entity positioned to fix the script, and the cost of missing the
  warning is a full re-run. The lint warns; it never blocks execution.
- **TS accepted:** scripts are type-stripped / transpiled (the repo already
  ships `typescript-7`) before execution, so the authoring LLM may write
  either JS or TS.
- **Interrupt:** the host holds an abort handle; pause/send_input (§10) and
  shutdown abort the running script mid-await. In-flight leaf agents receive
  the abort signal through the existing cancel path.

The *leaf agents* were never sandboxed either — they are ordinary Stella
agents with their normal tool catalogs (shell, files, browser). Dropping the
orchestration-layer sandbox simply makes the whole feature one trust domain:
the authoring model, its script, and its leaves all run as trusted Stella
code. Replayability now comes from the journal (§8), not from a deterministic
interpreter.

## 8. Journaled resume (`resume_from`)

Every effectful SDK call — `agent()`, `thread().send()`, `llm()`, and each
internal call a quality helper makes — is journaled to SQLite. The row is
written **at issue time** — the moment the script makes the call — and its
result column is filled in on completion:

```
workflow_runs:    run_id PK, workflow_thread_id, conversation_id, description,
                  engine, model, reasoning_json, script_text, status, created_at, finished_at, result
workflow_journal: run_id, issue_seq, kind ('agent'|'thread_send'|'llm'), fingerprint,
                  fingerprint_occurrence, prompt_text, opts_json, result_json,
                  status ('issued'|'done'|'failed'|'aborted'), issued_at, finished_at
```

`fingerprint` = hash of `(kind, prompt, opts)` — the call's identity.
`issue_seq` is assigned when the call is *issued*, never when it completes.
This distinction is load-bearing under concurrency: inside `parallel()` /
`pipeline()`, **completion** order is nondeterministic (whichever agent
happens to finish first), while **issue** order is the order the script's code
reaches each call — the only order a re-executed script reliably reproduces.
A journal keyed by completion order would make every concurrent section
spuriously "diverge" on resume even when nothing changed.

**Resume via effect-replay** (not code re-execution): on `resume_from`, the
runtime re-runs the new script live, and each effectful call it issues is
matched against the prior run's journal:

- **Match by fingerprint over the not-yet-consumed rows, with per-fingerprint
  occurrence counting.** An issued call consumes the *n*-th unconsumed journal
  row carrying its fingerprint, where *n* is the count of identical
  fingerprints this run has already issued — so two byte-identical calls (a
  retry loop re-issuing the same `(kind, prompt, opts)`) map to their own rows
  instead of both matching the first. Neither journal position nor completion
  order participates in the match, so concurrent sections replay cleanly no
  matter how scheduling luck ordered their completions last time.
- Every matched call whose journaled status is `done` returns the journaled
  result immediately **without re-performing the side effect** — no agent
  re-spawned, no model re-called.
- Replay ends at the first issued call with **no matching unconsumed `done`
  row** — an edited prompt/opts, a genuinely new call, or a row left
  `issued`/`aborted` because it was in flight when the prior run stopped. That
  call and everything issued after it run live; an interrupted effect is
  always re-executed rather than trusted.

Because resume replays effect *results* rather than trusting the surrounding
control-flow code to recompute identically, ambient nondeterminism in the JS
(a timestamp, a random branch) cannot corrupt a resume's correctness — but a
nondeterministic value **interpolated into a prompt** changes that call's
fingerprint and silently forfeits the cache from that point on, which is why
§7's lint actively flags it. Already-journaled side effects are **never**
re-executed.

### `thread()` under effect-replay

Persistent leaf threads must survive across runs on the same workflow thread.
`thread("builder")` binds by label to the child thread row
`<workflowThreadId>::wf::thread-builder`, creating it only if absent — on
resume this is a **re-bind, not a re-create**: the child row and its full
transcript are still there (the workflow that owns them is what's resuming,
§17's lifetime rule is not violated), and each replayed `thread().send()`
consumes its journal row like any other effect. The journaled reply is
returned, the builder is not re-invoked, and its transcript already contains
those turns; when execution crosses into live mode, the next `send()` simply
appends to the existing transcript as if the run had never stopped.

The sharp edge is an **aborted in-flight `send()`**: pause/`send_input` abort
the script mid-await (§10), so a builder can be left with a half-completed
turn whose transcript entries were already written. Decision: **the aborted
turn is rolled back.** When a `thread().send()`'s journal row ends `aborted`,
the runtime deletes that turn's transcript entries (the delivered prompt and
any partial assistant/tool entries, identifiable by the turn's run id) from
the child thread before the workflow resumes. The re-issued live `send()`
therefore lands on a context ending at the last *completed* turn — not on a
half-answer followed by a duplicate of the same prompt. Rollback is bounded
because a leaf turn's transcript is workflow-scoped state; what it cannot undo
is external side effects the half-turn already performed (files written,
commands run) — the same partial-work reality any aborted agent leaves behind,
so the authoring prompt tells re-issued builder prompts to have the builder
reassess on-disk state before continuing. One-shot `agent()` calls have no
such edge: an aborted ephemeral agent is discarded wholesale, its journal row
never reads `done`, and resume simply runs it fresh.

The journal is also the **debug record**: the authoring LLM reads back a
per-call digest (label, status, result excerpt, duration) after each
`run_script`, and the full `result_json` rows answer "why did the workflow
return an empty list" without re-running anything. The workflow card links to
it (§13). **Retention (resolved, §17): nothing outlives the workflow.** The
journal, every child thread row, and all workflow state are scoped to the
workflow thread's lifetime — they live and die with that thread row and are
never promoted to survive independently; there is no separate TTL because
there is nothing to retain past the workflow itself.

Two distinct resume paths share this machinery:

- **Intra-run iteration:** the authoring LLM's second `run_script` call (after
  an error or a mid-course correction) automatically resumes from its own last
  run — this is the normal edit-and-continue loop and needs no orchestrator
  involvement.
- **Cross-invocation resume:** the orchestrator passes `resume_from` with a
  prior workflow `thread_id` — used after a pause, a crash, or when chaining
  work that extends a previous run (§14). The new authoring session gets the
  prior script + journal digest injected as context.

There is **no checkpoint concept** — no periodic snapshots, no approval gates.
The journal *is* the recovery story; anything else the pause/send_input path
covers (§10).

## 9. Caps and concurrency

Rahul's explicit choices, verbatim into the design:

- **Max concurrent agents: user-configurable, default 16.** New
  `workflowMaxConcurrentAgents` key in `LocalPreferences`
  (`runtime/kernel/preferences/local-preferences.ts:73`), surfaced in desktop
  settings next to the engine/model pickers. Effective limit =
  `max(1, min(configured, os.cpus().length − 2))` — the CPU clamp reflects
  that leaf agents run local tool work (shell, builds), not just API calls.
  Enforced by a semaphore in the workflow scheduler; excess `agent()` calls
  queue and run as slots free. This pool is the workflow's own and is **not**
  shared with the roster-slot accounting (`MAX_ACTIVE_RUNTIME_THREADS = 16`,
  `runtime/kernel/runtime-threads.ts:10`) because ephemeral leaves take no
  roster slot.
- **Lifetime cap: ~1000 agents per run** — a runaway-loop backstop set far
  above any legitimate workflow, counted across `agent()`/`thread().send()`
  calls including helper-internal ones. Hitting it fails the current
  `run_script` with a clear error; the journal survives, the authoring LLM
  decides what to report.
- **Deliberately NO max-iterations, cost, or time budgets, and NO checkpoint
  system.** A workflow that loops too long or heads the wrong way is handled
  the way a wayward agent is today: the orchestrator (or the user, via the
  card) **pauses it or send_inputs it** (§10). Budget machinery would add a
  second, worse steering channel and an arbitrary knob nobody can set well.
- **Runaway visibility without a budget knob.** During a runaway loop, nobody
  with judgment is naturally awake: the authoring LLM is blocked inside
  `run_script`, the orchestrator hears nothing until completion, and the card
  only surfaces `lifetimeSpent` past 50% of the lifetime cap (§13) — ~500
  agents, far too late. So the **scheduler itself emits an auto-advisory**
  through the existing advisor path (§12, `audience: "orchestrator"`) at
  fixed milestones: every 100 agents spawned, and whenever 30 minutes pass
  without a `phase()` change. The emission is a compact scheduler-built
  snapshot — agents spawned/running/done, current phase and its age, the last
  few `log()` lines. It is a **signal to the one entity with judgment and
  standing context, not a limit**: nothing slows or stops, and the
  orchestrator decides whether to ignore, pause, or `send_input`. The
  no-budgets stance stays intact.

## 10. Stella integration: threads, Recall, pause, send_input

**The workflow is a thread.** `run_workflow` creates a durable
`runtime_threads` row (slugged human key via the existing
`resolveOrCreateActiveThread` path, `session-store.ts:3582`) with
`agent_type = "workflow"`, occupying **one** work slot regardless of fan-out —
the same footprint discipline as a `grp-` group. Its `runtime_agents` record
carries the live `TaskLifecycleStatus`, and its `result` column receives the
authoring LLM's final report, which makes it show up in Recall's Thread Index
with a `resultExcerpt` for free (`RecallIndexThreadRow`,
`session-store.ts:169`).

**Sub-agents are threads under it.** Each `agent()` call gets a lightweight
thread row keyed `<workflowThreadId>::wf::<seq>-<slug>` with
`parent_agent_id = <workflowThreadId>` and `agent_type = "general"`, but is
**slotless**: excluded from work-slot accounting, from the orchestrator's
"# Other Threads" roster, and from orchestrator lifecycle follow-ups (they
report to the script, per `runEphemeralAgent`'s contract — that primitive is
extended to optionally persist the thread row + transcript entries it
currently skips). This diverges from the current `::subagent::` blanket
exclusion: workflow children **are** findable via Recall's `searchThreads` and
transcript search, **and** they **are** carried in Recall's top-level Thread
Index (resolved, §17). Because workflow children do not emit periodic reasoning
summaries the way `spawn_agent` agents do (§11), each child's
`RecallIndexThreadRow` is keyed by its **description plus its most recent
assistant text** (the latest assistant output on that child thread) in place of
the reasoning-summary signal a normal delegated thread would supply — so a
child still carries a meaningful, searchable snippet without a summary stream,
and "where did that one finding come from?" resolves later. The workflow's own
row (phase/progress + result excerpt) still represents the run as a whole. All
child rows — including persistent `thread()` leaves, which are the same rows,
just multi-turn — are scoped to the workflow's lifetime and are never promoted
to a standalone slotted thread (§17).

**Pause** — `pause_agent(workflow_thread_id)` works unchanged through
`cancelAgent` with the `AGENT_PAUSE_CANCEL_REASON` sentinel
(`local-agent-manager.ts:643`): the running script is aborted, in-flight leaves are
cancelled, journal rows for completed calls survive, no noisy `[Task
canceled]` follow-up fires. The thread stays on the roster as `paused`.

**send_input** — the existing hard rejection for workflow threads
(`local-agent-manager.ts:1747`, "workflow runs are script-driven, not
conversational") is **removed** and replaced with the same
abort-and-redeliver semantics every agent has (`sendAgentMessage` →
`interruptedForFollowUp` → `deliverFollowUpAsNextTurn`): the message aborts
the running script (journal intact), and the **authoring LLM** — not the
script — receives it as its next turn, alongside a journal digest and a
reminder that re-running with resume replays the completed prefix. So
"actually, skip the perf findings and land it" lands mid-run, the authoring
LLM edits the script or just finalizes, and nothing already computed is lost.
This is the steering channel that replaces budgets (§9). A `send_input` to a
*paused* workflow re-hydrates it the same way it does any paused thread.

**Thread summaries / Dream:** the `workflow` agent definition gets
`recordsThreadSummary: true`, so the existing
`thread-summaries-record.hook.ts` feeds the workflow's final report into the
Dream inbox like any long-running delegated thread.

## 11. Sub-agent display: reasoning summaries off

Reasoning summaries for agents spawned **under a workflow** are off — sixteen
concurrent reasoning tickers is noise, and the activity surface for a workflow
is the rolled-up card (§13), not per-child chatter.

Mechanics (there is currently no per-agent summaries flag — the nearest levers
are provider options): add a `reasoningDisplay: "off"` option on the ephemeral
run context, plumbed to the provider adapters' existing knobs
(`thinkingDisplay` on Anthropic, `runtime/ai/providers/anthropic.ts:1105`;
`reasoningSummary` on the OpenAI Responses adapters,
`openai-responses.ts:296`, `openai-codex-responses.ts:384`) **and** — the part
that matters for the UI — simply not wiring `onReasoning` for ephemeral leaf
runs, so no `AGENT_REASONING` stream events are emitted
(`run-events.ts:209` → `worker/server.ts:2233`) and the
`agent_progress_summaries` engine never sees them. Reasoning *effort* is
untouched — the models still think; Stella just doesn't narrate it.

The **workflow thread itself** (the authoring LLM) keeps normal reasoning
summaries: one ticker for the whole constellation, which is exactly the right
amount of liveness for the activity view.

## 12. Advisor: fire-and-forget escalation

The workflow LLM can emit an advisory or escalation to its parent
orchestrator/user **without ending or pausing the workflow**, via the `advise`
tool on the authoring session, also exposed to scripts as `advise()` (which
bridges to the same host call):

```ts
advise({
  whatIDid: string;
  relevantFindings: string[];
  currentState: string;
  whyFlagging: string;
  question?: string;
  recommendation?: string;
  audience?: "orchestrator" | "user" | "both"; // default: orchestrator
}): void
```

`advise` is **FIRE-AND-FORGET only**. It queues the emission, returns
immediately, and workflow execution continues. It never waits for a reply,
parks the script, pauses the workflow, or creates a pending response slot.
Delivery uses the existing lifecycle path
(`deps.sendMessage(...{uiVisibility: "hidden", deliverAs: "followUp",
customType: "runtime.workflow_advisory"})`, mirroring
`agent-orchestration.ts:436`), with `audience` controlling whether the message
is addressed to the parent orchestrator, surfaced to the user, or both. It can
also render as a quiet line on the workflow card.

Every emission is a fresh, compact, self-contained call-site snapshot: what
the workflow did, the relevant findings, its current state, why it is flagging
now, and the exact question and/or recommendation. That removes stale-context
risk without any advisor response-routing or resumption protocol. The
orchestrator may relay it, ignore it, or explicitly start/steer follow-up work;
none of those actions resolve an advisor call because there is nothing pending
to resolve.

The same channel carries the **scheduler's milestone auto-advisories** (§9):
compact scheduler-built snapshots emitted while the authoring LLM is blocked
inside `run_script` (every 100 agents spawned; 30 minutes without a `phase()`
change). They use the same emission shape and render the same way on the card
— the runaway-visibility signal rides the advisor path rather than adding a
second mechanism.

If the workflow genuinely cannot continue without user judgment, it does not
sit suspended inside `advise`. It emits the snapshot if useful, then
terminates normally with a clear `needs-user` outcome containing the decision
needed and the safe current state. The user can explicitly start or resume
follow-up work afterward. The final report still happens exactly once, as the
authoring LLM's completing turn.

## 13. UI: the workflow artifact card and the activity view

### The workflow card (chat transcript)

A dedicated card, sibling of `BackgroundWorkCard`/`AgentCompletionCard`, not a
reuse — the single-agent card answers "is my one delegate still alive?"; the
workflow card must answer "what shape is this run, where is it, and how much
has it done?" without the user opening anything.

Wiring follows the established per-turn derivation pattern exactly (there is
no tool→card registry): a `workflowRun?` field on `AssistantRowViewModel`
(`desktop/src/features/chat/conversation-row-types.ts:120` region), a
`deriveWorkflowRun(events)` in `features/chat/lib/` anchored — like
`getBackgroundWork` (`use-event-rows.ts:118-149`) — on **lifecycle events, not
the tool_result** (the spawn result only persists a preview string; events are
reload-safe), rendered from `AssistantMessageRow` (`MessageRow.tsx:583-667`
render order), with `eventRowEqual` and the visible-content guards extended.
Live updates ride the same per-frame re-projection background cards use today
(`use-event-rows.ts:549-558`).

**Runtime feed:** a new `workflow-progress` lifecycle event (extending
`AgentLifecycleEvent`, `local-agent-manager.ts:264`), emitted by the workflow
scheduler on phase change, count change (throttled), `log()`, and advisory.
Persisted as local-chat rows like all lifecycle events, so the card
reconstructs after reload.

**Concrete data the card needs from the runtime:**

| Field | Source |
| --- | --- |
| `workflowThreadId`, `runId`, `description` | spawn event / `workflow_runs` |
| `status` (`running/paused/completed/failed/canceled`) | `runtime_agents.status` + pause sentinel |
| `phase` (current title) + `phaseIndex/phaseCount` when the script declared phases | `phase()` calls via `workflow-progress` |
| agent counters `{ spawned, running, done, failed }` | scheduler, throttled |
| `lifetimeSpent` (n of 1000) — only surfaced past 50% | scheduler |
| latest `log()` line + latest advisory excerpt | `workflow-progress` |
| `startedAtMs`, `finishedAtMs` | run row |
| result summary + produced-file entries on completion | terminal event (`result`, `producedFiles` — same fields the agent card uses) |
| `journalRunId` for the "open journal" affordance | run row |

**Rendering:** collapsed, one calm line —
`◇ Review & fix auth flow · Fix — round 3 · 4 running / 11 done` with the
existing `TextShimmer` liveness treatment while running; paused/failed reuse
the `data-state` styling vocabulary of `BackgroundWorkCard`. Expanded: the
phase list with per-phase counts, the last few `log()` lines, and advisories.
On completion the card settles like `AgentCompletionCard` (muted check,
produced-file pills via `openDisplayPayloadTab`, summary markdown) plus a
journal link. **Never** a per-child list in chat.

### Activity view (clean, low-noise — the explicit contrast)

Today each spawned general agent is a `TaskRow` in `LeftSidebarSections.tsx`,
with groups collapsing under a `GroupRow` whose header is deliberately just "N
tasks" (`getTaskGroupStatusText`, `event-transforms.ts:986`). A 40-agent
workflow must not render 40 rows or even one expandable firehose of 40.

- The workflow renders as **one row**, a new `workflow` `ActivityRow` variant
  (alongside `task`/`group`, `event-transforms.ts:719`): status glyph,
  workflow name, and a rolled-up subtitle —
  `Fix · round 3 · 4 running / 11 done`. Phase replaces child narration as the
  row's "what is it doing" signal.
- The **only** reasoning ticker under the row is the workflow thread's own
  (§11); child agents are gated out of `isActivityFeedTask`
  (`event-transforms.ts:186`) by their `::wf::` key so they never become
  individual rows or feed `AgentProgressSummaries`.
- Expansion shows phases with counts and the produced-files strip (the
  existing `agentFiles` map keyed to the workflow thread), *not* child rows.
  Full per-child inspection is the journal / `ActivityHistoryDialog`, which
  may list children on demand — pull, never push.
- Running/done ordering, first-seen pinning, and the history overflow dialog
  all apply unchanged; a workflow is one item in those lists.

Single-agent card vs workflow card, in one line each: the agent card is a
**receipt** (one delegate, alive or done, files out); the workflow card is a
**gauge** (shape, phase, throughput, steer-me affordance).

## 14. Big jobs: chain single-phase workflows across turns

For large efforts (audit a whole subsystem, migrate 200 call sites, design →
implement → verify), the recommended pattern is **several single-phase
workflows chained across orchestrator turns**, not one monolithic script:

- Each run's report returns to the orchestrator, which decides the next phase
  with full judgment — the human stays one `send_input` away between phases.
- Failure blast radius is one phase; `resume_from` makes intra-phase recovery
  cheap, and a new phase can cite the prior workflow's thread (Recall finds
  it) instead of replaying it.
- A monolithic script front-loads planning the authoring LLM will do better
  after seeing phase-1 results; single phases keep each script small enough to
  audit at a glance.

The authoring prompt encodes this: *when the brief contains multiple
qualitatively different phases whose later shape depends on earlier results,
do the first phase well, return its results, and recommend the next workflow
in the final report.* Typical chain: understand (parallel readers → map) →
design (judge panel) → implement (builder + reviewers, the §15 loop) → verify
(adversarial sweep). The orchestrator's own prompt guidance likewise says:
simple delegation → `spawn_agent`; one complex pattern → `run_workflow`;
campaign → chained workflows.

## 15. Worked example: review → triage → fix → fresh re-review

The exact loop the orchestrator currently hand-drives across ~a dozen turns —
one durable builder thread, disposable fresh-eyes reviewers each round, an LLM
triage node, loop-until-clean — as a single workflow script:

```ts
const FINDINGS = { type: "object", properties: { findings: { type: "array", items: {
  type: "object", properties: { file: { type: "string" },
  severity: { type: "string" }, claim: { type: "string" } },
  required: ["file", "claim"] } } }, required: ["findings"] };
const TRIAGE = { type: "object", properties: {
  fix: { type: "array", items: { type: "object" } },
  dismiss: { type: "array", items: { type: "object" } } }, required: ["fix", "dismiss"] };

phase("Build");
const builder = thread("builder");   // durable leaf: keeps its context across every round
let build = await builder.send(
  `Implement the composer attachment redesign per this spec: <spec…>. ` +
  `Run the focused tests. Report files touched and anything you deferred.`);

const handled = [];                  // deterministic memory: every claim already fixed or dismissed
let round = 0, clean = false;

while (!clean && round < 8) {        // hard bound is a shape choice, not a budget
  round += 1;
  phase(`Review · round ${round}`);
  // disposable reviewers: fresh agents every round — no anchoring on their own past reviews
  const reviews = await parallel([
    () => agent(`Fresh-eyes correctness review of: ${build}. Read the touched files; ` +
                `hunt real bugs only. Report file + a one-line claim per finding.`, { schema: FINDINGS, label: `fresh r${round}` }),
    () => agent(`Adversarial review of the same change: races, unmount/teardown, ` +
                `stale-state edge cases. Try to break it.`, { schema: FINDINGS, label: `edges r${round}` }),
    () => agent(`Regression review: existing callers/consumers of the touched files. ` +
                `What did this change silently break?`, { schema: FINDINGS, label: `regress r${round}` }),
  ]);
  const findings = reviews.filter(Boolean).flatMap(r => r.findings);
  if (findings.length === 0) { clean = true; break; }

  // judgment node doubles as the dedupe: fresh eyes never re-emit anyone's stable key,
  // so repeats are caught semantically here against the handled list — not by string match
  const triage = await llm(
    `Builder's latest report:\n${build}\n\nNew findings:\n${JSON.stringify(findings)}\n\n` +
    `Already handled in prior rounds (fixed or dismissed):\n${JSON.stringify(handled)}\n\n` +
    `First drop every finding that is a rewording of an already-handled item — same file, ` +
    `same underlying claim. Of the rest: which are real defects worth fixing this round, ` +
    `which are noise or working-as-intended? Be strict; dismissed items join the handled list.`,
    { schema: TRIAGE });
  handled.push(...triage.dismiss.map(f => ({ file: f.file, claim: f.claim })));
  if (triage.fix.length === 0) { clean = true; break; }

  phase(`Fix · round ${round}`);
  build = await builder.send(
    `Reviewers confirmed these defects:\n${JSON.stringify(triage.fix)}\n` +
    `Fix each, re-run the focused tests, report what changed.`);
  handled.push(...triage.fix.map(f => ({ file: f.file, claim: f.claim })));
  log(`round ${round}: fixed ${triage.fix.length}, dismissed ${triage.dismiss.length}`);
}

if (!clean) advise({
  whatIDid: `Ran ${round} build/review/fix rounds`,
  relevantFindings: ["Fresh findings keep surfacing in the same area"],
  currentState: "Latest fixes are applied and tested, but the review is not clean",
  whyFlagging: "The pattern now looks like a design issue rather than isolated bugs",
  recommendation: "Review the auth-module design before starting another fix round",
});
return { clean, rounds: round, resolved: handled.length, builderReport: build };
```

Everything the orchestrator used to hold in its head is now typed state: the
handled list, the round counter, the clean condition. Note the dedupe is
deliberately **semantic, not key-based**: fresh reviewers are valuable
precisely because they share no vocabulary with prior rounds, so the same
defect resurfaces reworded — asking them for "stable keys" and exact-matching
in a `Set` is wishful, and would quietly re-litigate every finding. Routing
all findings through the triage node with the handled list in-prompt is what
makes "dismissed items will not be revisited" actually hold; the code keeps
the deterministic memory, the LLM node does the matching only an LLM can do.
The orchestrator's total involvement: one `run_workflow` call and one
completion report.

## 16. Divergences from Claude Code workflows

| Dimension | Claude Code | Stella |
| --- | --- | --- |
| Who authors the script | The main-loop model writes the script inline in the tool call | A dedicated workflow-authoring LLM, briefed in natural language by the orchestrator; the orchestrator never sees JS |
| Authoring model | Main-loop model implicitly | **Pinned to the invoking orchestrator run's exact engine + model + reasoning.** Native Claude Code stays native Claude Code; native Codex stays native Codex. No authoring/judgment override or fallback exists |
| Native engine failure | N/A | Fail clearly with an engine-specific error; never reroute to a hosted provider, another engine/model, or reduced reasoning |
| Agent archetypes | `agentType`/custom subagent registry option | **None.** Role is always in the prompt; every leaf is the `general` agent |
| Budgets | Token-budget global (`budget.total/spent/remaining`), budget-scaled loops | **No iteration/cost/time budgets.** Steering is pause / `send_input` on the workflow thread; the only hard limits are concurrency and the ~1000-agent lifetime backstop |
| Checkpoints | (and elsewhere, checkpoint/approval machinery) | **No checkpoints.** Journal + pause + send_input cover recovery and steering |
| Opt-in gating | Explicit user opt-in ("ultracode" keyword / session mode) | No keyword; orchestrator judgment under prompt guidance, like every other delegation choice |
| Persistence & memory | Run artifacts in session dir; journal files | Workflow is a first-class **Stella thread**: Recall-indexed with result excerpt, Dream thread-summary, durable SQLite journal, resumable across sessions |
| Mid-run interaction | One-way (user watches /workflows); agents can't call home | **Fire-and-forget advisor channel** (`advise(snapshot)`, never blocking) + `send_input` abort-and-redeliver into the authoring LLM |
| Sub-agent display | Progress tree of agents per phase | Reasoning summaries **off** for all workflow children; one rolled-up card + one activity row; per-child detail is pull-only (journal) |
| Multi-turn leaves | Stateless `agent()` calls (workflow() nesting for composition) | `thread()` persistent leaves (the builder pattern) alongside one-shot `agent()` |
| Nested workflows | One nesting level allowed | **Forbidden in v1** — a workflow cannot call `run_workflow` (the tool is absent from the authoring LLM's catalog); chain single-phase workflows across turns instead (§14) |
| Orchestration sandbox | (script runs in the CC process) | **None** — the authored script runs as trusted code at the authoring model's trust level; replayability comes from the journal, not a deterministic interpreter (§7) |
| UI | Terminal progress tree | Dedicated workflow artifact card in chat + low-noise activity row (§13) |

Kept deliberately compatible: the SDK verbs (`agent`/`parallel`/`pipeline`/
`phase`/`log`), streaming-pipeline-by-default with barriers as the exception,
effect-replay resume semantics (§8), determinism as a soft convention (§7), and the
quality-pattern vocabulary (adversarial verify, judge panel, loop-until-dry,
multi-modal sweep) — these are good ideas with no Stella-specific reason to
diverge.

## 17. Decisions — no open questions

Rahul has resolved all seven original open questions. No design questions
remain.

### Resolved

1. **No sandbox (§7).** The authored control-flow script runs directly as
   trusted code — the authoring model's own trust level — not in QuickJS-WASM
   and not in a hardened `node:vm`. The sandbox is no longer a security
   boundary in this design. Rationale: the authoring LLM is the orchestrator's
   own engine+model+reasoning configuration and does what it is briefed to do;
   realm isolation bought guarantees the threat model does not need, at real
   bridging cost.
2. **Determinism + resume (§7, §8).** Determinism is a soft authoring
   convention, not an enforced guarantee — `Date.now()`, `Math.random()`, and
   argless `new Date()` no longer throw, but the pre-execution lint
   **actively flags** them (and Node/Bun imports) in the `run_script` result,
   because a nondeterministic value interpolated into a prompt silently
   forfeits the replay cache from that point on. Resume is **effect-replay**:
   journal rows are written at issue time, matched by fingerprint with
   per-fingerprint occurrence counting over unconsumed rows, and journaled
   effect *results* are returned without re-execution; live execution begins
   at the first unmatched call. Resume never depends on re-executing
   control-flow code, so ambient nondeterminism cannot corrupt it. Aborted
   in-flight `thread().send()` turns roll back their transcript entries
   before resume (§8).
3. **Recall exposure of workflow children (§10).** Children **are** indexed in
   Recall's top-level Thread Index, each keyed by its description plus its most
   recent assistant text in place of a reasoning summary (children don't emit
   summary streams, §11), and are searchable via `searchThreads` and transcript
   search.
4. **Retention / lifetime — nothing outlives the workflow (§8, §10).**
   Children, the journal, and all workflow state are scoped to the workflow
   thread's lifetime and are never promoted to survive independently. The
   former "promote a builder `thread()` to a standalone slotted thread" option
   is dropped, and the journal-TTL question is resolved as "bound to the
   workflow thread row — nothing to retain past the workflow itself."
5. **Nested workflows — forbidden in v1 (§14).** A workflow cannot invoke
   `run_workflow`; the tool is simply absent from the authoring LLM's catalog
   (§2). Multi-phase campaigns chain single-phase workflows across orchestrator
   turns instead. Not revisited in v1.
6. **Advisor is fire-and-forget only (§12).** `advise(snapshot)` always returns
   immediately and never blocks or pauses execution. Each emission carries a
   fresh compact call-site snapshot, so there is no reply-routing, wait
   timeout, resumption, or self-finalization protocol. A workflow that truly
   needs user judgment terminates with an explicit `needs-user` outcome; any
   follow-up is started or resumed explicitly.
7. **Native external-engine fidelity is strict (§4).** Workflow authoring and
   judgment inherit the invoking orchestrator run's exact
   `{ engine, model, reasoning }`. Native Codex calls stay on the native Codex
   engine/session path; native Claude Code calls stay on the native Claude
   Code engine/session path. A native adapter/tool-bridge spike and tests must
   prove progress streaming and workflow-tool support, but cannot substitute a
   hosted or different-engine call. Any inability to honor the snapshot is a
   clear terminal engine-specific failure, never a fallback.

Implementation still requires a proof spike and tests for both native engine
adapters. That is verification work under a closed policy, not a remaining
design question.

### Cross-doc dependency (provisional, not open)

`llm()` judgment nodes currently take no per-node model override while
`agent()` leaves do (§4, §6). That asymmetry is **provisional**: a separate
per-node model-selection design, being written in parallel with this doc, is
expected to grant judgment nodes model choice with pre-included selection
guidance. When it lands, it supersedes the no-override rule here and the two
documents must be reconciled — do not implement the asymmetry as if final.
