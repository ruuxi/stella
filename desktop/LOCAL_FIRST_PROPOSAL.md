# Proposal: Complete Local-First Desktop Architecture

## Context

The desktop is now the primary orchestrator (Phases 0-4 complete), but many data paths still round-trip to Convex unnecessarily. This proposal covers making everything that should be local actually local, ordered by impact.

## Already Done (This Session)

- Shared context assembly pipeline (`@stella/shared`: `eventsToHistoryMessages`, `selectRecentByTokenBudget`, micro-compaction)
- Removed HTTP streaming fallback and `/api/chat` endpoint
- Desktop handles all finalization (reminder counter, suggestions, compaction)
- Cron jobs use inverted execution when desktop is online
- Cloud fallback stripped to chat + web search only
- Suggestions generated locally (catalog read from disk)
- Thread compaction LLM call runs locally

## Remaining Steps (Ordered by Impact)

### Step 1: Split `fetchAgentContextForRuntime` into local config + token mint

**Impact: Highest — blocks every single chat turn**

Currently one blocking server round-trip bundles: system prompt assembly, model resolution, skills list, core memory, thread history, AND proxy token. Only the proxy token actually needs the server.

**Changes:**
- New lightweight Convex action `mintProxyToken` — returns only `{ token, expiresAt }` (~50ms vs ~300ms+ for the full context fetch)
- New local function `buildAgentContextLocally()` in the Electron process that reads from disk/local stores:
  - System prompt: load agent config from `~/.stella/agents/`, apply prompt template
  - Model config: read from local settings or `~/.stella/config.json`
  - Skills: read from `~/.stella/skills/` (already loaded by runner's manifest sync)
  - Core memory: read from `~/.stella/CORE_MEMORY.MD` (already watched by runner)
  - Thread history: read from local thread store (Step 2)
  - Tools allowlist: derived from agent config
- `handleLocalChat` calls `buildAgentContextLocally()` + `mintProxyToken()` in parallel
- The full `fetchAgentContextForRuntime` action stays for cloud fallback / remote turns

**Dependencies:** Step 2 (local threads) for thread history. Can be partially implemented without it by keeping thread history fetch as a separate small query.

### Step 2: Local thread store (SQLite)

**Impact: High — eliminates round-trips for thread read/write and makes compaction fully local**

Thread messages currently live only in Convex. Every turn writes to Convex, and compaction reads from Convex.

**Changes:**
- New `LocalThreadStore` class (SQLite, similar pattern to existing `LocalMemoryStore`):
  - Tables: `threads` (id, name, status, summary, conversationId, totalTokenEstimate) and `thread_messages` (threadId, ordinal, role, content, tokenEstimate)
  - Methods: `saveMessages`, `loadMessages`, `getThread`, `applyCompaction`, `createThread`
- `agent_runtime.ts` writes thread messages to local store after each turn (instead of including them in `batchPersistRunChunk`)
- `local_compaction.ts` reads/writes entirely from local store (remove `loadThreadMessagesForRuntime` and `applyCompactionForRuntime` Convex calls)
- Background sync: push thread data to Convex in connected mode (reuse the `batchPersistRunChunk` pattern or a separate sync job)
- Remove the public `loadThreadMessagesForRuntime` and `applyCompactionForRuntime` endpoints from backend (no longer needed)

### Step 3: Local tool execution for tools that don't need the server

**Impact: Medium — eliminates unnecessary backend passthrough for 6 tools**

These tools currently proxy through `agent/local_runtime:executeTool` but don't need server resources:

**Changes:**
- **WebFetch**: Execute `fetch()` directly in the Electron process. No secrets needed. Already has the URL and prompt.
- **ActivateSkill**: Read skill content from `~/.stella/skills/{skillId}.md` on disk. Skills are already synced locally by the runner.
- **OpenCanvas / CloseCanvas**: Send IPC to the renderer to update workspace state. Pure UI.
- **NoResponse**: Return immediately with a control signal. No server call needed.
- **Memory recall/save (cloud mode)**: Always use the local `LocalMemoryStore` (SQLite BM25 + LLM rerank). Stop falling back to cloud memory when in cloud storage mode — the desktop is always online when these tools are called.

Create `local_tool_overrides.ts` that provides local implementations for these tools, used in `remote_tools.ts` instead of `callBackendTool`.

### Step 4: Local run persistence with background sync

**Impact: Medium — eliminates blocking write to Convex after each turn**

Currently `persistRunToConvex` (`batchPersistRunChunk`) is the sole persistence path. It blocks completion until all chunks are written to Convex.

**Changes:**
- `RunJournal` (already exists, SQLite WAL-mode) becomes the primary persistence layer — it already stores all run events locally
- After a run completes, mark it as "persisted locally" immediately
- Background sync job pushes completed runs to Convex when in connected mode (non-blocking)
- If Convex is unreachable, runs queue locally and sync when connectivity resumes
- `batchPersistRunChunk` stays as the server-side mutation target for the sync job

### Step 5: Local event store for conversation events (cloud mode)

**Impact: Medium — unifies the cloud/local event storage paths**

Currently cloud mode writes events directly to Convex (`events.appendEvent`), while local mode writes to localStorage. Both should write locally first.

**Changes:**
- Replace localStorage-based `local-chat-store.ts` with a SQLite-based local event store (more robust, supports larger conversations, survives localStorage limits)
- Cloud mode: write to local store immediately, sync to Convex in background
- Local mode: write to local store only (same as today but SQLite instead of localStorage)
- `useConversationEvents` hook reads from local store in both modes (Convex reactive query becomes a background sync source, not the primary read)
- `buildLocalHistoryMessages` reads from the local SQLite store

### Step 6: Local task records

**Impact: Low — task CRUD round-trips are infrequent and not in the critical path**

Task records (`createRuntimeTask`, `completeRuntimeTask`, etc.) currently write to Convex.

**Changes:**
- `LocalTaskManager` stores task records in local SQLite
- Background sync pushes to Convex in connected mode
- `TaskOutput` / `TaskCancel` tools read from local store
- Remove direct Convex mutations from the task lifecycle (keep sync-only writes)

### Step 7: Local preferences

**Impact: Low — one query per session**

`getSyncMode` is queried from Convex. Should be a local setting.

**Changes:**
- Read sync mode from `~/.stella/config.json` or a local preferences file
- Sync preference changes to Convex in connected mode
- Remove the `useQuery(getSyncMode)` call from `chat-store.tsx`

## What Stays Server-Side (Never Changes)

- **LLM proxy** — API keys never leave the server
- **Proxy token minting** — authentication + scoped token generation
- **Secret resolution** — encrypted secrets stored server-side
- **Device heartbeat** — cloud presence for inverted execution routing
- **Channel webhooks** — public HTTPS endpoints for Discord/Telegram/etc.
- **Connector delivery** — bot tokens in Convex env vars
- **Cron/heartbeat scheduling triggers** — fire from Convex crons
- **Web search** — search API keys server-side
- **Integration requests** — external API credentials server-side
- **Store search / API skill generation** — server-side catalog + LLM
- **Attachment upload** — Convex file storage
- **Cloud fallback execution** — degraded chat + web search when desktop offline

## Estimated Complexity

| Step | Complexity | New files | Files modified |
|------|-----------|-----------|----------------|
| 1. Split context fetch | Medium | 2 (local context builder, token mint action) | 3 (runner.ts, prompt_builder.ts, agent_runtime.ts) |
| 2. Local thread store | High | 1 (local_thread_store.ts) | 4 (agent_runtime.ts, local_compaction.ts, runner.ts, batchPersistRunChunk) |
| 3. Local tool overrides | Medium | 1 (local_tool_overrides.ts) | 1 (remote_tools.ts) |
| 4. Local run persistence | Medium | 0 (extend RunJournal) | 2 (agent_runtime.ts, runner.ts) |
| 5. Local event store | High | 1 (local_event_store.ts) | 4 (local-chat-store.ts, chat-store.tsx, use-conversation-events.ts, use-streaming-chat.ts) |
| 6. Local task records | Low | 0 (extend LocalTaskManager) | 2 (local_task_manager.ts, runner.ts) |
| 7. Local preferences | Low | 0 | 2 (chat-store.tsx, runner.ts) |
