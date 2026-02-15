# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stella Backend is a Convex-powered backend for an AI assistant platform. It provides:
- Conversation management with multi-device support
- Streaming AI chat via HTTP endpoints using the Vercel AI SDK
- Multi-agent system with 5 builtin agents and per-agent model configuration
- Skills system for dynamic prompt augmentation
- Subagent task delegation with depth limits
- Channel integrations (Telegram, Discord, Slack, Google Chat, Teams, WhatsApp/Signal)
- Memory system with vector search
- Self-modification system for platform changes
- App store for skills and themes

## Commands

```bash
bun run dev         # Start Convex dev server (watches for changes, syncs to cloud)
bun run deploy      # Deploy to Convex cloud (production)
```

## Architecture

### Directory Structure

```
convex/
├── agent/          # Agent system (invoke, model config, prompt building, device tools, tasks)
├── tools/          # Tool definitions (backend, cloud, orchestration, types)
├── data/           # Data access (skills, store_packages, memory, threads, commands, secrets, etc.)
├── channels/       # Messaging integrations (telegram, discord, slack, google_chat, teams)
├── scheduling/     # Heartbeats and user cron jobs
├── prompts/        # System prompt templates
├── automation/     # Automated workflows
├── lib/            # Shared utilities
├── auth.ts         # Better-auth configuration
├── conversations.ts
├── events.ts
├── http.ts         # HTTP endpoints (chat, webhooks, synthesis)
└── schema.ts       # All table definitions
```

### Core Data Flow

1. **Chat Request** (`http.ts`): HTTP POST to `/api/chat` with conversationId and userMessageId
2. **Agent Selection** (`http.ts`): Defaults to `orchestrator`, can be overridden to `general`, `self_mod`, etc.
3. **Prompt Building** (`agent/prompt_builder.ts`): Combines agent system prompt with enabled skills
4. **Tool Assembly** (`tools/index.ts`): Three-tier tool system (see below)
5. **Streaming Response**: Uses Vercel AI SDK `streamText()` with tool calling

### Key Tables (schema.ts)

Core:
- **conversations**: Owner-scoped chat sessions
- **events**: All conversation events (messages, tool requests/results, task events) with device targeting
- **attachments**: File attachments for conversations

Agent system:
- **agents**: Agent configurations with system prompts, tool allowlists, skill defaults
- **commands**: Bundled command definitions (content, plugin, enabled flag)
- **skills**: Markdown instructions injected into agent prompts (with execution, secretMounts fields)
- **tasks**: Subagent task tracking with parent relationships and depth limits

Data & secrets:
- **secrets**: Encrypted user secrets vault
- **secret_access_audit**: Audit trail for secret access
- **user_preferences**: Per-user settings
- **memories**: Episodic memory with vector index (1536-dim embeddings)
- **memory_extraction_batches**: Batch tracking for memory extraction jobs

Integrations:
- **integrations_public**: Public API integration definitions
- **user_integrations**: Per-user integration configs

Infrastructure:
- **remote_computers**: Remote computer connections
- **cloud_devices**: Sprites cloud sandboxes
- **heartbeat_configs**: Scheduling system
- **channel_connections**: Messaging channel links
- **bridge_sessions**: WhatsApp/Signal bridge sessions
- **bridge_outbound**: Outbound messages for bridge sessions
- **slack_installations**: Slack workspace installation data
- **cron_jobs**: User-scheduled cron jobs
- **linq_chats**: Linq messaging channel chats
- **devices**: Device online status and platform tracking
- **threads**: Thread persistence for subagent conversations
- **thread_messages**: Individual messages within threads

App store:
- **store_packages**: Package definitions (with search index)
- **store_installs**: Installed packages per user
- **canvas_states**: Canvas persistence per conversation
- **self_mod_features**: Self-modification feature tracking

### Agent Types

5 builtin agents defined in `agent/agents.ts`:

| Agent | Purpose | Key Tools |
|-------|---------|-----------|
| `orchestrator` | Default entry point, delegates to subagents, handles scheduling/memory | TaskCreate, TaskOutput, TaskCancel, OpenCanvas, CloseCanvas, AskUserQuestion, RecallMemories, SaveMemory, Heartbeat*, Cron*, SpawnRemoteMachine, NoResponse |
| `general` | Full tool access for general tasks, can spawn explore sub-agents | Read, Write, Edit, Bash, KillShell, Glob, Grep, WebFetch, WebSearch, RequestCredential, IntegrationRequest, SkillBash, OpenApp, ListResources, StoreSearch, ManagePackage, GenerateApiSkill, MediaGenerate, ActivateSkill, TaskCreate, TaskOutput |
| `self_mod` | Platform self-modification | Read, Write, Edit, Bash, KillShell, Glob, Grep, OpenCanvas, CloseCanvas, OpenApp, WebFetch, WebSearch, AskUserQuestion, ActivateSkill, SelfMod* tools |
| `explore` | Lightweight read-only exploration | Read, Glob, Grep, WebFetch, WebSearch |
| `browser` | Browser automation | Bash, KillShell, Read, OpenCanvas, CloseCanvas, ActivateSkill |

Per-agent model configuration in `agent/model.ts`.

### Three-Tier Tool System

Tools are assembled in `tools/index.ts`:

1. **Backend tools** (always available): WebSearch, WebFetch, IntegrationRequest, ActivateSkill, HeartbeatGet, HeartbeatUpsert, HeartbeatRun, CronList, CronAdd, CronUpdate, CronRemove, CronRun, OpenCanvas, CloseCanvas, StoreSearch, GenerateApiSkill, SelfModInstallBlueprint, SpawnRemoteMachine, ListResources, NoResponse
2. **Cloud tools** (when no local device, but cloud sandbox available): Bash, Read, Write, Edit, Glob, Grep via Sprites
3. **Device tools** (`agent/device_tools.ts`): When Electron app is running — 18 tools executed locally via request/response through the events table

Device tool pattern:
1. Backend inserts `tool_request` event targeting a deviceId
2. Client device polls and executes locally
3. Client inserts `tool_result` event with same requestId
4. Backend polls for result (750ms interval, 120s timeout)

**Orchestration tools** (TaskCreate, TaskOutput, TaskCancel, AgentInvoke, RecallMemories, SaveMemory) are created separately via `tools/orchestration.ts`.

### Task/Subagent System

Tasks (`agent/tasks.ts`) enable agent-to-agent delegation:
- Three tools: `TaskCreate` (delegate), `TaskOutput` (poll result), `TaskCancel` (stop)
- Depth limiting via `maxTaskDepth` (default 2) prevents infinite recursion
- Background execution with `run_in_background` option
- Task events track lifecycle (task_started, task_completed, task_failed, task_checkin)

`AgentInvoke` (`agent/invoke.ts`) provides bounded structured agent calls.

## Convex Conventions

Follow the guidelines in `convex_rules.md` (comprehensive reference):
- Always include `args` and `returns` validators on functions
- Use `v.null()` for functions that don't return values
- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- Use `withIndex()` for queries, never `filter()`
- Reference functions via `api.filename.functionName` or `internal.filename.functionName`
- Define schemas in `convex/schema.ts` with appropriate indexes
- File names: alphanumeric, underscores, periods only (no hyphens)
- `ActionCtx` has no `ctx.db` — only `QueryCtx` and `MutationCtx` do

## Deployment

1. Ensure all environment variables are set in Convex dashboard
2. Run `bun run deploy` from backend directory
3. Verify deployment in Convex dashboard logs

