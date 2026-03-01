# Stella Backend Convex Architecture

## Quick Reference

### "Add a new tool"
1. Device tools: `device_tools.ts` → createCoreDeviceTools()
2. Backend tools: `tools/backend.ts` → createBackendTools()
3. Orchestration tools: `tools/orchestration.ts` → createOrchestrationTools()
4. Register in `tools/index.ts` createTools() assembly

### "Change agent prompts"
→ `prompts/` folder — one file per agent type
→ `prompts/index.ts` — barrel re-exports

### "Change automation/scheduling"
→ `heartbeat.ts` — Heartbeat config (KEEP: crons.ts dependency)
→ `cron_jobs.ts` — Cron jobs (KEEP: crons.ts dependency)
→ `automation/runner.ts` — Shared runAgentTurn()
→ `automation/utils.ts` — Heartbeat utilities

### "Change chat streaming"
→ `http.ts` — POST /api/chat endpoint
→ `prompt_builder.ts` — System prompt assembly
→ `model.ts` — Model configuration

### "Change memory system"
→ `memory.ts` — Search, ingest, decay (cohesive module)

## Directory Structure

```
convex/
├── prompts/          # Agent system prompts (split by type)
│   ├── index.ts      # Barrel file re-exporting all prompts
│   ├── orchestrator.ts
│   ├── general.ts
│   ├── memory.ts
│   ├── explore.ts
│   ├── browser.ts    # Largest prompt (~470 lines)
│   ├── self_mod.ts
│   └── synthesis.ts  # Core memory synthesis + builder functions
│
├── tools/            # Tool factory and implementations
│   ├── index.ts      # createTools() factory + re-exports
│   ├── types.ts      # PluginToolDescriptor, ToolOptions, BASE_TOOL_NAMES
│   ├── backend.ts    # IntegrationRequest, ActivateSkill, Scheduler
│   └── orchestration.ts  # Task, TaskOutput, AgentInvoke, MemorySearch
│
├── automation/       # Shared scheduling utilities
│   ├── index.ts      # Barrel file
│   ├── utils.ts      # Heartbeat utilities (tokens, prompts, stripping)
│   └── runner.ts     # runAgentTurn() for heartbeat/cron execution
│
├── _generated/       # Convex generated files (don't edit)
├── http.ts           # HTTP endpoints (/api/chat, /api/synthesize)
├── schema.ts         # Database schema
├── heartbeat.ts      # Heartbeat scheduling (crons.ts dependency)
├── cron_jobs.ts      # Cron scheduling (crons.ts dependency)
├── memory.ts         # Memory system (crons.ts dependency)
├── device_tools.ts   # Core device tools (Read, Write, Bash, etc.)
├── plugins.ts        # Plugin system + jsonSchemaToZod
├── agents.ts         # Agent definitions and builtins
├── agent.ts          # agent.invoke action
├── tasks.ts          # Subagent task system
├── prompt_builder.ts # System prompt assembly
├── model.ts          # Model configuration
├── auth.ts           # Authentication
├── secrets.ts        # Secret management
├── events.ts         # Event storage and queries
├── conversations.ts  # Conversation management
└── ...               # Other modules
```

## Protected Files (avoid renaming/moving)

These files are referenced via `internal.*` paths:

- `heartbeat.ts` — Self-schedules via `ctx.scheduler.runAfter`
- `cron_jobs.ts` — Self-schedules via `ctx.scheduler.runAfter`
- `memory.ts` — Referenced as `internal.memory.decayMemories`

Moving/renaming these would break scheduling.

## Module Responsibilities

### prompts/
Pure constants and builder functions for agent system prompts. No dependencies on Convex runtime.

### tools/
Tool definitions for the AI SDK. Split by category:
- **types.ts**: Shared types and constants
- **backend.ts**: Tools that interact with external services (integrations, skills, scheduler)
- **orchestration.ts**: Tools for agent coordination (Task, TaskOutput, AgentInvoke, MemorySearch)
- **index.ts**: Assembly point that combines device tools, backend tools, orchestration tools, and plugin tools

### automation/
Shared utilities for scheduled/automated agent runs:
- **utils.ts**: Heartbeat token handling, prompt resolution
- **runner.ts**: `runAgentTurn()` used by both heartbeat and cron jobs

## Data Flow

1. **Chat Request** → `http.ts` POST /api/chat
2. **Prompt Building** → `prompt_builder.ts` combines agent prompt + skills
3. **Tool Creation** → `tools/index.ts` assembles all tool categories
4. **Streaming** → Vercel AI SDK `streamText()` with tool calling
5. **Tool Execution** → Device tools dispatch to client via events table

## Key Patterns

### Tool Execution
Device tools (`device_tools.ts`) use request/response via events table:
1. Backend inserts `tool_request` event
2. Client device polls and executes locally
3. Client inserts `tool_result` event
4. Backend polls for result (750ms interval, 120s timeout)

### Subagent Delegation
Tasks (`tasks.ts`) enable agent-to-agent delegation with depth limiting (default 2).
