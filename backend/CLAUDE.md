# Stella Backend

Convex-powered backend for an AI assistant platform. Streaming chat, multi-agent system, skills, memory, channel integrations, and an app store.

## Commands

```bash
bun run dev         # Start Convex dev server (watches + syncs)
bun run deploy      # Deploy to Convex cloud (production)
```

## Directory Structure

```
convex/
├── agent/          # Agent system (invoke, model config, prompt building, device tools, tasks)
├── tools/          # Tool definitions (backend, cloud, orchestration, types)
├── data/           # Data access (skills, store_packages, memory, threads, commands, secrets, etc.)
├── channels/       # Messaging integrations (telegram, discord, slack, google_chat, teams)
├── scheduling/     # Heartbeats and user cron jobs
├── prompts/        # System prompt templates per agent
├── automation/     # Automated workflows
├── lib/            # Shared utilities
├── http.ts         # HTTP endpoints (chat, webhooks, synthesis)
└── schema.ts       # All table definitions
```

## Core Data Flow

1. HTTP POST `/api/chat` → agent selection (default: `orchestrator`) → `streamText()`
2. Prompt built via `agent/prompt_builder.ts` (agent prompt + enabled skills)
3. Tools assembled in `tools/index.ts` (backend + device/cloud + orchestration tiers)
4. Device tools: backend inserts `tool_request` event → client executes → inserts `tool_result`

## Agents

5 builtin agents in `agent/agents.ts`. Orchestrator delegates to subagents via `TaskCreate`. See `docs/agent-flow.md` for the full task lifecycle, threading, and message construction details.

| Agent | Purpose |
|-------|---------|
| `orchestrator` | Default entry point, delegates to subagents, scheduling, memory |
| `general` | Full tool access for coding/files/web tasks |
| `self_mod` | Platform self-modification |
| `explore` | Read-only file search and web research |
| `browser` | Playwright-controlled Chrome automation |

## Convex Conventions

See `convex_rules.md` for full reference. Key rules:

- Always include `args` and `returns` validators on functions
- Use `v.null()` for void returns
- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- Use `withIndex()` for queries, never `filter()`
- File names: alphanumeric, underscores, periods only — **no hyphens**
- `ActionCtx` has no `ctx.db` — only `QueryCtx` and `MutationCtx` do

## Deployment

1. Set environment variables in Convex dashboard
2. `bun run deploy`
