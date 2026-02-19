# Agent System - Flow Reference

## Agent Hierarchy

5 agents in a flat 2-level hierarchy:

```
Orchestrator (default coordinator for delegated work)
  |-- General     (files, shell, web, coding, APIs)
  |-- Explore     (read-only: file search, web research)
  |-- Self-Mod    (Stella's own UI/styles/layouts)
  `-- Browser     (Playwright-controlled Chrome)
```

`/api/chat` can run `orchestrator`, `general`, or `self_mod` directly (default is orchestrator). The orchestrator is the only built-in coordinator for subagent delegation and auto-delivery.

Subagents are background workers that execute and return results. There is no direct subagent-to-subagent channel; top-level subagent results are routed back through the orchestrator via `deliverTaskResult`.

Built-in subagents (`self_mod`, `explore`, `browser`) use `maxTaskDepth: 0` (cannot create nested tasks). `general` uses `maxTaskDepth: 2` (can spawn explore sub-agents). The orchestrator uses `maxTaskDepth: 2`.

## Task Lifecycle

### 1. User Message -> Top-Level Agent

`http.ts` receives POST `/api/chat` and calls `streamText()` with the selected top-level agent (`orchestrator` by default, or `general` / `self_mod` when requested). The selected agent sees the user message, responds (streaming), and can use whatever tools are in its allowlist.

### 2. TaskCreate -> runSubagent (immediate return)

`tools/orchestration.ts`: the orchestrator calls `TaskCreate(prompt, subagent_type, ...)`.

The tool calls `internal.agent.tasks.runSubagent` which:
- Resolves thread (if `thread_name` or `thread_id` provided)
- Inserts a task record (status: `"running"`)
- Emits a `task_started` event (UI shows spinner)
- Schedules `executeSubagent` via `ctx.scheduler.runAfter(0, ...)`
- Returns immediately with `"Task running. Task ID: ..."`

The orchestrator gets the task ID back instantly and can continue (reply to user, launch more tasks in parallel).

### 3. executeSubagent (background)

`agent/tasks.ts` runs asynchronously after the orchestrator turn ends.

`executeSubagentRun` handles core execution:
1. Build system prompt via `prompt_builder.ts` (base prompt + enabled skills)
2. Load base tools + skill summaries (tool access from allowlist, skills are prompt guidance)
3. Load thread context when threaded (general/self_mod only): summary pair + token-bounded recent tail
4. Build messages array: summary -> thread messages -> task prompt (+ optional command instructions + dynamic system context)
5. Call `generateText()` with subagent tools, system prompt, and messages
6. Save thread messages, trigger compaction when token pressure is high
7. Complete task record as `"completed"` with result text

### 4. Result Delivery (auto-delivery)

After `executeSubagentRun` returns, `executeSubagent` checks whether this is a top-level task (`!parentTaskId`).

If yes, it schedules `deliverTaskResult`, which re-invokes the orchestrator as a fresh `generateText()` call:
- Sends a focused delivery message: `[System: Subagent task completed] ... --- Result --- <agent output>`
- Calls `generateText()` with orchestrator system prompt + tools
- Orchestrator reads the result and decides what to tell the user (or calls `NoResponse()`)
- If it generates text, it is saved as `assistant_message` for the frontend

The orchestrator does not need to poll; results arrive automatically.

### 5. TaskOutput (manual check)

The orchestrator also has `TaskOutput(task_id)` for manual checks on running tasks. It returns status, elapsed time, and recent activity.

## Memory Usage

### Orchestrator mode

For itself (answering the user directly):
- `RecallMemories(query)` - direct tool, result returned in the same turn
- `SaveMemory(content)` - stores useful long-term context

### General mode

For delegated execution tasks:
- General can call `RecallMemories(query)` directly when it needs prior context
- Orchestrator does not pass memory payloads into `TaskCreate`
- Orchestrator history is not injected into subagent runs

## Threading

Threads give general and self_mod agents persistent memory across tasks.

- `thread_name`: human-readable key (for example, `"sidebar-refactor"`), creates or reuses by name
- `thread_id`: direct reference to continue an existing thread
- Explore and browser do not support threads

What is stored: all messages (user prompts, assistant responses, tool interactions) in `thread_messages` with sequential ordinals.

Compaction: when token pressure is high, old messages are summarized into `thread.summary`, originals deleted, and a recent token-budget tail is kept.

Limits: max 16 active threads per conversation. LRU eviction when full.

## Message Construction Order

Final messages sent to `generateText()`:

```
1. Thread summary pair (synthetic user/assistant if thread has summary)
2. Thread messages (recent token-bounded tail from the thread)
3. Final user message:
   a. Task prompt
   b. <command-instructions> block (if `command_id` resolved)
   c. <system-context> block (dynamic context from prompt_builder)
```

## Tool Assembly

Tools are assembled in `tools/index.ts` in layered tiers:

| Tier | Source | Examples |
|------|--------|----------|
| Backend (always) | `tools/backend.ts` | WebSearch, WebFetch, OpenCanvas, CloseCanvas, IntegrationRequest, ListResources |
| Device (if Electron connected) | `agent/device_tools.ts` | Read, Write, Edit, Bash, Glob, Grep, KillShell |
| Cloud (if no device and `spriteName` is present) | `tools/cloud.ts` | Bash, Read, Write, Edit via Sprites VM |
| Orchestration | `tools/orchestration.ts` | TaskCreate, TaskOutput, TaskCancel, RecallMemories, SaveMemory |

Tools are filtered by each agent's `toolsAllowlist` in `agents.ts`. Skills do not grant tools.

When no device context exists, orchestration uses deviceless tools: memory tools always, and task tools when conversation + user-message context are present.

## File Map

| File | Purpose |
|------|---------|
| `prompts/orchestrator.ts` | Orchestrator system prompt: routing, delegation, examples |
| `prompts/general.ts` | General agent prompt: coding guidelines, tool patterns |
| `prompts/self_mod.ts` | Self-mod agent prompt: staging workflow, UI modification |
| `prompts/explore.ts` | Explore agent prompt: read-only investigation |
| `prompts/browser.ts` | Browser agent prompt: Playwright automation |
| `agent/tasks.ts` | Task creation, execution, threading, result delivery |
| `agent/agents.ts` | Agent definitions, tool allowlists, model configs |
| `agent/prompt_builder.ts` | Builds system prompt + dynamic context per agent |
| `agent/model_resolver.ts` | Resolves model config with user overrides + BYOK |
| `tools/orchestration.ts` | TaskCreate, TaskOutput, TaskCancel, memory tools |
| `tools/backend.ts` | Backend tools (web, canvas, store, scheduling) |
| `tools/index.ts` | Layered tool assembly + allowlist filtering |
| `data/memory.ts` | Memory recall, save, extraction (embedding-based) |
| `data/threads.ts` | Thread CRUD, message storage, compaction |
