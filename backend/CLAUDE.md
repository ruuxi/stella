# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stellar Backend is a Convex-powered backend for an AI assistant platform. It provides:
- Conversation management with multi-device support
- Streaming AI chat via HTTP endpoints using the Vercel AI SDK
- Configurable agents with system prompts and tool allowlists
- Skills system for dynamic prompt augmentation
- Plugin system for extensible tools
- Subagent task delegation with depth limits

## Commands

```bash
bun convex dev      # Start Convex dev server (watches for changes, syncs to cloud)
```

## Architecture

### Core Data Flow

1. **Chat Request** (`http.ts`): HTTP POST to `/api/chat` with conversationId and userMessageId
2. **Prompt Building** (`prompt_builder.ts`): Combines agent system prompt with enabled skills
3. **Tool Execution** (`device_tools.ts`): Tools dispatch requests to target devices via events table, poll for results
4. **Streaming Response**: Uses Vercel AI SDK `streamText()` with tool calling

### Key Tables (schema.ts)

- **conversations**: Owner-scoped chat sessions, indexed by owner+default and owner+updated
- **events**: All conversation events (messages, tool requests/results, task events) with device targeting
- **agents**: Agent configurations with system prompts, tool allowlists, skill defaults
- **skills**: Markdown instructions injected into agent prompts based on agentType
- **plugins/plugin_tools**: External tool definitions with JSON Schema inputs
- **tasks**: Subagent task tracking with parent relationships and depth limits

### Agent Types

- `general`: Default agent with full tool access (Read, Write, Edit, Glob, Grep, Bash, etc.)
- `self_mod`: Self-modification agent for platform changes

### Tool System

Device tools (`device_tools.ts`) work via request/response pattern through the events table:
1. Backend inserts `tool_request` event targeting a deviceId
2. Client device polls and executes locally
3. Client inserts `tool_result` event with same requestId
4. Backend polls for result (750ms interval, 120s timeout)

Plugin tools convert JSON Schema to Zod schemas dynamically (`plugins.ts:jsonSchemaToZod`).

### Task/Subagent System

Tasks (`tasks.ts`) enable agent-to-agent delegation:
- `Task` tool delegates to subagent types
- `TaskOutput` retrieves results by task ID
- Depth limiting via `maxTaskDepth` (default 2) prevents infinite recursion
- Task events track lifecycle (task_started, task_completed, task_failed)

## Convex Conventions

Follow the guidelines in `convex_rules.md`:
- Always include `args` and `returns` validators on functions
- Use `v.null()` for functions that don't return values
- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- Use `withIndex()` for queries, never `filter()`
- Reference functions via `api.filename.functionName` or `internal.filename.functionName`
- Define schemas in `convex/schema.ts` with appropriate indexes

## Environment Variables

- `AI_GATEWAY_MODEL`: Required model identifier for the AI gateway (used by streamText)
