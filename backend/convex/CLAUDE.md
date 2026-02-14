# Agent System — Flow Reference

## Architecture

5 agents in a flat 2-level hierarchy:

```
Orchestrator (default coordinator for delegated work)
  ├── General     (files, shell, web, coding, APIs)
  ├── Explore     (read-only: file search, web research)
  ├── Self-Mod    (Stella's own UI/styles/layouts)
  └── Browser     (Playwright-controlled Chrome)
```

`/api/chat` can run `orchestrator`, `general`, or `self_mod` directly (default is orchestrator). The orchestrator is the only built-in coordinator for subagent delegation and auto-delivery.

Subagents are background workers — they execute and return results. There is no direct subagent-to-subagent channel; top-level subagent results are routed back through the orchestrator via `deliverTaskResult`.

Built-in subagents (`general`, `self_mod`, `explore`, `browser`) use `maxTaskDepth: 0` (cannot create nested tasks). The orchestrator uses `maxTaskDepth: 2`.

## Task Lifecycle

### 1. User Message → Top-Level Agent

`http.ts` receives POST `/api/chat` → calls `streamText()` with the selected top-level agent (`orchestrator` by default, or `general` / `self_mod` when requested). The selected agent sees the user's message, responds (streaming), and can use whatever tools are in its allowlist.

### 2. TaskCreate → runSubagent (immediate return)

`tools/orchestration.ts` — the orchestrator calls `TaskCreate(prompt, subagent_type, ...)`.

The tool calls `internal.agent.tasks.runSubagent` which:
- Resolves thread (if `thread_name` or `thread_id` provided)
- Inserts a task record (status: `"running"`)
- Emits a `task_started` event (UI shows spinner)
- Schedules `executeSubagent` via `ctx.scheduler.runAfter(0, ...)`
- **Returns immediately** with `"Task running. Task ID: ..."`

The orchestrator gets the task ID back instantly and can continue (say something to the user, launch more tasks in parallel).

### 3. executeSubagent (background)

`agent/tasks.ts` — runs asynchronously after the orchestrator's turn ends.

**`executeSubagentRun`** handles the core execution:

1. **Build system prompt** via `prompt_builder.ts` — base agent prompt + enabled skills
2. **Load base tools + skill summaries** — tool access comes from the agent allowlist; skills are prompt guidance
3. **Load thread context** — if threaded (general/self_mod only): load summary pair + all thread messages
4. **Load conversation history** — if `includeHistory=true`: recent context events selected by token budget (tool calls/results + task events included)
5. **Pre-gathered context** — if `recallMemory` or `preExplore` provided (see below)
6. **Build messages array**: summary → thread messages → history → pre-gathered context + prompt
7. **Call `generateText()`** with the subagent's tools, system prompt, and messages
8. **Save thread messages** — append new messages to thread, trigger compaction when thread/context token pressure is high
9. **Complete task record** — mark as `"completed"` with result text

### 4. Result Delivery (auto-delivery)

After `executeSubagentRun` returns, `executeSubagent` checks: is this a top-level task (`!parentTaskId`)?

If yes → schedules `deliverTaskResult` which **re-invokes the orchestrator** as a fresh `generateText()` call:
- Gathers recent conversation context by token budget
- Formats a system message: `[System: Subagent task completed] ... --- Result --- <agent output>`
- Calls `generateText()` with orchestrator's full system prompt + tools
- Orchestrator reads the result, decides what to tell the user (or calls `NoResponse()`)
- If it generates text → saved as `assistant_message` → user sees it

The orchestrator does **not** need to poll — results arrive automatically.

### 5. TaskOutput (manual check)

The orchestrator also has `TaskOutput(task_id)` for manually checking on running tasks. Returns status, elapsed time, and recent activity (tool calls the agent has made). Use case: user asks "is it done yet?" or "what's taking so long?"

## Pre-Gathered Context

`recall_memory` and `pre_explore` on `TaskCreate` let the orchestrator attach context to a task without processing it itself.

### recall_memory

```
TaskCreate(..., recall_memory={ query: "sidebar pattern", categories: [{category: "projects", subcategory: "frontend"}] })
```

Before the main agent runs, the system calls `internal.data.memory.recallMemories`:
- `query` defaults to the first 500 chars of the task prompt if omitted
- `categories` defaults to all categories for the owner if omitted
- Result injected as `<context>## Recalled Memories\n...</context>` before the prompt

### pre_explore

```
TaskCreate(..., pre_explore="Find all sidebar component files and their structure")
```

Before the main agent runs, the system runs an inline explore agent (`generateText` with explore tools):
- Uses the explore agent's system prompt, model config, and tool allowlist
- Result injected as `<context>## Explore Results\n...</context>` before the prompt

Both are best-effort — if either fails, the main agent still runs without that context.

### Orchestrator's Two Modes

**For itself** (answering the user directly):
- `RecallMemories(categories, query)` — direct tool, result returned to orchestrator in same turn
- `TaskCreate(subagent_type="explore", ...)` — standalone explore task, result auto-delivered

**For subagents** (gathering context for a delegated task):
- `recall_memory` on TaskCreate — system handles recall, injects into agent, orchestrator never sees it
- `pre_explore` on TaskCreate — system runs explore inline, injects into agent, orchestrator never sees it

## Threading

Threads give general and self_mod agents persistent memory across tasks.

- **`thread_name`**: human-readable (e.g., `"sidebar-refactor"`). Creates or reuses by name.
- **`thread_id`**: direct reference to continue an existing thread.
- Explore and browser don't support threads.

**What's stored**: all messages (user prompts, assistant responses, tool interactions) in `thread_messages` table with sequential ordinals.

**Compaction**: when token pressure is high, old messages are summarized by LLM into `thread.summary`, originals deleted, and a recent token-budget tail is kept.

**Limits**: max 16 active threads per conversation. LRU eviction when full.

## Message Construction Order

The final messages array sent to `generateText()`:

```
1. Thread summary pair (synthetic user/assistant if thread has summary)
2. Thread messages (all stored messages from the thread)
3. Conversation history (if include_history=true, recent context selected by token budget)
4. Final user message:
   a. <context> block (pre-gathered memory + explore results, if any)
   b. Task prompt
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

Tools are filtered by the agent's `toolsAllowlist` from `agents.ts`. Skills do not grant tools.

When no device context exists, orchestration falls back to a deviceless set: memory tools only (`RecallMemories`, `SaveMemory`) without Task tools.

## File Map

| File | Purpose |
|------|---------|
| `prompts/orchestrator.ts` | Orchestrator system prompt — routing, delegation, examples |
| `prompts/general.ts` | General agent prompt — coding guidelines, tool patterns |
| `prompts/self_mod.ts` | Self-mod agent prompt — staging workflow, UI modification |
| `prompts/explore.ts` | Explore agent prompt — read-only investigation |
| `prompts/browser.ts` | Browser agent prompt — Playwright automation |
| `agent/tasks.ts` | Task creation, execution, threading, result delivery |
| `agent/agents.ts` | Agent definitions, tool allowlists, model configs |
| `agent/prompt_builder.ts` | Builds system prompt + dynamic context per agent |
| `agent/model_resolver.ts` | Resolves model config with user overrides + BYOK |
| `tools/orchestration.ts` | TaskCreate, TaskOutput, TaskCancel, memory tools |
| `tools/backend.ts` | Backend tools (web, canvas, store, scheduling) |
| `tools/index.ts` | Layered tool assembly + allowlist filtering |
| `data/memory.ts` | Memory recall, save, extraction, categories |
| `data/threads.ts` | Thread CRUD, message storage, compaction |
