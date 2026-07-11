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
LLM** — a new agent type running on the orchestrator's own model and engine —
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
                 └── advise() ──▶ orchestrator  ├─ runEphemeralAgent (leaf, one-shot)
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

## 4. Model + engine inheritance

**Rule: the workflow-authoring LLM always runs on the orchestrator's current
model AND engine (Stella `default` / `claude_code_local` / `codex_cli`). There
is no parameter to change this.** Sub-agents spawned by the script MAY take a
per-agent `model` with exactly `spawn_agent`'s grammar (`stella/light`,
`anthropic/…`, `openrouter/…`, `codex`, `claude-code`, `codex/<m>`,
`claude-code/<m>` — parsed by the existing `parseSpawnAgentModel`,
`runtime/kernel/tools/state.ts:87`); when omitted, a leaf inherits the
workflow's snapshot too.

### Resolution and propagation

The snapshot is taken **from the invoking run, not re-derived from
preferences**, so a mid-conversation model switch can't desync the workflow
from the turn that launched it:

1. The orchestrator runner already registers per-run callbacks keyed by
   `rootRunId` (`runCallbacksByRunId`, `runtime/kernel/runner/agent-orchestration.ts`).
   Extend that registration to also expose the run's resolved
   `{ modelRef, resolvedLlm, agentEngine }` — all three already exist on the
   orchestrator's `LocalAgentContext` (`agentEngine` computed at
   `runtime/kernel/runner/context.ts:864`, model at `:940`).
2. `run_workflow`'s handler looks the snapshot up via `context.rootRunId`
   (present on `ToolContext`, `runtime/kernel/tools/types.ts:20`). Fallback,
   for edge paths with no live run entry: `getModelOverride(stellaDataDir,
   "orchestrator")` + `getAgentRuntimeEngine(stellaDataDir)`
   (`runtime/kernel/preferences/local-preferences.ts:333,349`) — the same two
   sources the orchestrator itself resolves from.
3. The snapshot `{ engine, model }` is stored on the workflow's
   `RuntimeAgentRecord` / run row and pinned for the run's lifetime. Every
   authoring-LLM turn passes it as `spawnEngine: { engine, model }`
   (`SpawnEngineSelection`, `runtime/contracts/agent-engine.ts:24`), which
   `buildAgentContext` already honors over the global preference
   (`context.ts:864`: `args.spawnEngine?.engine ?? getAgentRuntimeEngine(…)`).
4. Engine dispatch is the existing path: `runExternalSubagentTurn`
   (`runtime/kernel/agent-runtime/external-engines.ts:1221`) routes to the
   Claude Code or Codex hosted turn, else the native Pi runtime.
   **Important:** the workflow agent must run in the *bridged* (takeover-style)
   external mode, not the "vanilla" mode that `spawn_agent`'s explicit
   `claude-code` selector triggers (`external-engines.ts:521`) — vanilla drops
   the Stella tool bridge and system-prompt override, and the authoring LLM is
   nothing without `run_script`. This needs a discriminator on
   `SpawnEngineSelection` (e.g. `bridged: true`) or a parallel field on
   `AgentToolRequest` so the vanilla branch doesn't fire.
5. A **resume** (`resume_from`) is a new invocation and re-snapshots the
   orchestrator's *then-current* model+engine — "always current" beats "sticky
   to the original run".

Leaf agents: the scheduler translates each `agent()` call's `model` opt through
`parseSpawnAgentModel` into `model` / `spawnEngine` on the ephemeral run's
context fetch, identical to `spawn_agent`'s channel
(`AgentToolRequest.model|spawnEngine`, `tools/types.ts:127`). No `model` opt →
the workflow snapshot is passed down explicitly (this is a behavior *change*
relative to `spawn_agent`, whose children fall back to their own agent-type
preference — inside a workflow, inheritance is the predictable default).

Judgment nodes (`llm()`) always run the workflow snapshot model via
`resolveLlmRoute` directly — never the `stella/light` utility pin — because
triage/decide-done is precisely the judgment the user chose that model for.

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
  model?: string;          // spawn_agent model grammar; omit → inherit workflow engine+model
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
function advise(message: string, opts?: { wait?: boolean }): Promise<string | void>; // §12
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
dropped deliberately. The authoring LLM is the orchestrator's own model+engine
and does what it is briefed to do, so wrapping its orchestration glue in a
realm jail bought isolation the threat model does not require, at real cost in
async host bridging. The execution model is:

- **The SDK globals in §6 are ordinary functions in scope**, executing on the
  host under the scheduler (spawning agents, model calls, journal writes).
  Standard JS built-ins (`JSON`, `Math`, `Array`, `Set`, `Map`, `RegExp`, …)
  are available; so, in principle, are Node/Bun APIs — the design no longer
  blocks them, though the authoring prompt tells the LLM the script is
  orchestration glue only and that real work belongs in leaf agents.
- **Determinism is a soft convention, not an enforced guarantee.** With no
  interpreter to trap on, `Date.now()`, `Math.random()`, and argless
  `new Date()` no longer throw. The authoring prompt and the SDK skill still
  *advise* against ambient nondeterminism in control flow (it muddies the
  debug journal), and a lint/advisory pass MAY flag such calls, but
  determinism is no longer required for correctness: §8's resume model is
  **effect-replay**, which replays journaled effect *results* rather than
  trusting the code to recompute identically, so a stray timestamp or random
  branch cannot corrupt a resume.
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
internal call a quality helper makes — is journaled to SQLite as it completes:

```
workflow_runs:    run_id PK, workflow_thread_id, conversation_id, description,
                  engine, model, script_text, status, created_at, finished_at, result
workflow_journal: run_id, seq, kind ('agent'|'thread_send'|'llm'), fingerprint,
                  prompt_text, opts_json, result_json, status, started_at, finished_at
```

`fingerprint` = hash of `(kind, prompt, opts)` — the call's identity.

**Resume via effect-replay** (not code re-execution): the journal records the
*result* of every effectful call in order. On `resume_from`, the runtime
re-runs the new script live, but every effectful call it reaches is matched —
in sequence — against the prior run's journal by position and `fingerprint`.
For the **longest unchanged prefix**, the runtime returns the journaled result
immediately **without re-performing the side effect** — no agent is
re-spawned, no model re-called; execution goes live only from the first call
whose fingerprint diverges (edited, reordered, or new) onward. Because resume
replays *effect results* rather than trusting the surrounding control-flow code
to recompute identically, ambient nondeterminism in the JS (a timestamp, a
random branch) cannot desync a resume — only a change to the effectful calls
themselves can. Already-journaled side effects are **never** re-executed.

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

## 12. Advisor: contacting the orchestrator mid-run

The workflow LLM can inform or ask the orchestrator **without ending the
workflow**, via the `advise` tool on the authoring session, also exposed to
scripts as `advise()` (which bridges to the same host call):

```ts
advise(message: string, opts?: { wait?: boolean }): Promise<string | void>
```

- `wait: false` (default) — **inform**: fire-and-forget. Delivered as a hidden
  follow-up into the orchestrator session through the existing lifecycle
  delivery path (`deps.sendMessage(...{uiVisibility: "hidden", deliverAs:
  "followUp", customType: "runtime.workflow_advisory"})`, mirroring
  `agent-orchestration.ts:436`), with `audience` semantics so it can also be
  rendered as a quiet line on the workflow card. The orchestrator can relay to
  the user, ignore, or steer back with `send_input`. Use: "round 3: findings
  are all in the auth module — widening reviewer focus there."
- `wait: true` — **ask**: the workflow parks (the script await simply doesn't
  resolve; concurrency slots drain naturally) until the orchestrator answers
  via `send_input` to the workflow thread. Because that reply arrives through
  §10's abort-and-redeliver path, the runtime special-cases a pending
  `advise(wait)` to deliver the reply as the *resolution of the await* rather
  than aborting the script — the one place send_input does not tear the
  running script down. Use: "both fix strategies pass tests; A is simpler, B is
  faster — pick one." A configurable staleness nudge (not a timeout — nothing
  auto-fails) re-advises after long silence.

This keeps the contract crisp: `advise` is mid-run and never terminal; the
final report happens exactly once, as the authoring LLM's completing turn.

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
  type: "object", properties: { key: { type: "string" }, file: { type: "string" },
  severity: { type: "string" }, claim: { type: "string" } },
  required: ["key", "file", "claim"] } } }, required: ["findings"] };
const TRIAGE = { type: "object", properties: {
  fix: { type: "array", items: { type: "object" } },
  dismiss: { type: "array", items: { type: "object" } } }, required: ["fix", "dismiss"] };

phase("Build");
const builder = thread("builder");   // durable leaf: keeps its context across every round
let build = await builder.send(
  `Implement the composer attachment redesign per this spec: <spec…>. ` +
  `Run the focused tests. Report files touched and anything you deferred.`);

const handled = new Set();           // deterministic memory: never re-litigate a finding
let round = 0, clean = false;

while (!clean && round < 8) {        // hard bound is a shape choice, not a budget
  round += 1;
  phase(`Review · round ${round}`);
  // disposable reviewers: fresh agents every round — no anchoring on their own past reviews
  const reviews = await parallel([
    () => agent(`Fresh-eyes correctness review of: ${build}. Read the touched files; ` +
                `hunt real bugs only. Findings with stable keys.`, { schema: FINDINGS, label: `fresh r${round}` }),
    () => agent(`Adversarial review of the same change: races, unmount/teardown, ` +
                `stale-state edge cases. Try to break it.`, { schema: FINDINGS, label: `edges r${round}` }),
    () => agent(`Regression review: existing callers/consumers of the touched files. ` +
                `What did this change silently break?`, { schema: FINDINGS, label: `regress r${round}` }),
  ]);
  const fresh = reviews.filter(Boolean).flatMap(r => r.findings)
    .filter(f => !handled.has(f.key));
  if (fresh.length === 0) { clean = true; break; }

  // judgment node: dynamic triage on the workflow's own model
  const triage = await llm(
    `Builder's latest report:\n${build}\n\nNew findings:\n${JSON.stringify(fresh)}\n\n` +
    `Triage: which are real defects worth fixing this round, which are noise or ` +
    `working-as-intended? Be strict; dismissed items will not be revisited.`,
    { schema: TRIAGE });
  for (const f of triage.dismiss) handled.add(f.key);
  if (triage.fix.length === 0) { clean = true; break; }

  phase(`Fix · round ${round}`);
  build = await builder.send(
    `Reviewers confirmed these defects:\n${JSON.stringify(triage.fix)}\n` +
    `Fix each, re-run the focused tests, report what changed.`);
  for (const f of triage.fix) handled.add(f.key);
  log(`round ${round}: fixed ${triage.fix.length}, dismissed ${triage.dismiss.length}`);
}

if (!clean) await advise(`Not clean after 8 rounds; findings keep surfacing in the same area — likely a design issue, not bugs.`);
return { clean, rounds: round, resolved: [...handled].length, builderReport: build };
```

Everything the orchestrator used to hold in its head is now typed state: the
dedupe set, the round counter, the clean condition. The orchestrator's total
involvement: one `run_workflow` call and one completion report.

## 16. Divergences from Claude Code workflows

| Dimension | Claude Code | Stella |
| --- | --- | --- |
| Who authors the script | The main-loop model writes the script inline in the tool call | A dedicated workflow-authoring LLM, briefed in natural language by the orchestrator; the orchestrator never sees JS |
| Authoring model | Main-loop model implicitly | **Pinned by rule to the orchestrator's current model AND engine** (Stella / Claude Code / Codex), snapshotted from the invoking run; no override parameter exists |
| Agent archetypes | `agentType`/custom subagent registry option | **None.** Role is always in the prompt; every leaf is the `general` agent |
| Budgets | Token-budget global (`budget.total/spent/remaining`), budget-scaled loops | **No iteration/cost/time budgets.** Steering is pause / `send_input` on the workflow thread; the only hard limits are concurrency and the ~1000-agent lifetime backstop |
| Checkpoints | (and elsewhere, checkpoint/approval machinery) | **No checkpoints.** Journal + pause + send_input cover recovery and steering |
| Opt-in gating | Explicit user opt-in ("ultracode" keyword / session mode) | No keyword; orchestrator judgment under prompt guidance, like every other delegation choice |
| Persistence & memory | Run artifacts in session dir; journal files | Workflow is a first-class **Stella thread**: Recall-indexed with result excerpt, Dream thread-summary, durable SQLite journal, resumable across sessions |
| Mid-run interaction | One-way (user watches /workflows); agents can't call home | **Advisor channel** (`advise` inform/ask) + `send_input` abort-and-redeliver into the authoring LLM |
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

## 17. Decisions and remaining open questions

Rahul has resolved five of the original open questions; two remain.

### Resolved

1. **No sandbox (§7).** The authored control-flow script runs directly as
   trusted code — the authoring model's own trust level — not in QuickJS-WASM
   and not in a hardened `node:vm`. The sandbox is no longer a security
   boundary in this design. Rationale: the authoring LLM is the orchestrator's
   own model+engine and does what it is briefed to do; realm isolation bought
   guarantees the threat model does not need, at real bridging cost.
2. **Determinism + resume (§7, §8).** Determinism is a soft authoring
   convention, not an enforced guarantee — `Date.now()`, `Math.random()`, and
   argless `new Date()` no longer throw (optionally lint-flagged). Resume
   switches to **effect-replay**: journaled effect *results* are replayed in
   order for the longest unchanged prefix and never re-executed; live
   execution resumes only past the first diverging effectful call. Resume no
   longer depends on re-executing control-flow code, so ambient nondeterminism
   cannot corrupt it.
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

### Still open (need a human call)

6. **External-engine bridging fidelity.** Authoring on `claude_code_local` /
   `codex_cli` requires the bridged (non-vanilla) hosted turn carrying
   `run_script`/`advise` (§4). If the CC/Codex tool bridges can't stream
   `run_script` progress updates cleanly, fallback options are: authoring LLM
   on the native engine whenever the orchestrator's *model* is reachable
   natively, or accepting coarser progress. Needs a spike before committing to
   "always engine-mirrored" with no caveat.
7. **`advise(wait: true)` staleness behavior.** Design says nudge, never
   auto-fail. If Rahul prefers parked workflows to eventually self-finalize
   with partial results, that changes the advisor contract.
