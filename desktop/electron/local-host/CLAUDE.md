# Local Host Tool System

This directory implements the local tool execution system that runs on the user's device.

## How It Works

1. **Polling**: `runner.ts` polls Convex for `tool_request` events targeted at this device
2. **Execution**: Tool handlers execute locally (file I/O, shell commands, etc.)
3. **Response**: Results are sent back to Convex as `tool_result` events

## File Organization

| File | Purpose |
|------|---------|
| `runner.ts` | Main polling loop, request/response handling |
| `tools.ts` | Tool host factory, handler registry |
| `tools-types.ts` | Shared type definitions |
| `tools-utils.ts` | Common utilities (path handling, output formatting) |

### Tool Handlers by Domain

| File | Tools |
|------|-------|
| `tools-file.ts` | Read, Write, Edit |
| `tools-search.ts` | Glob, Grep |
| `tools-shell.ts` | Bash, KillShell, SkillBash |
| `tools-state.ts` | Task, TaskOutput |
| `tools-user.ts` | AskUserQuestion, RequestCredential |
| `tools-database.ts` | SqliteQuery |
| `tools_store.ts` | InstallSkillPackage, InstallThemePackage, InstallCanvasPackage, InstallPluginPackage, UninstallPackage |
| `tools_self_mod.ts` | SelfModStart, SelfModApply, SelfModRevert, SelfModStatus, SelfModPackage |

Note: WebFetch and WebSearch were promoted to backend tools (Convex actions) and are no longer registered as device tools. The `tools-web.ts` file still exists but its handlers are commented out of the registry.

### Other Modules

| File | Purpose |
|------|---------|
| `device.ts` | Persistent device ID generation |
| `skills.ts` | Load skills from `~/.stella/skills/` |
| `agents.ts` | Load agents from `~/.stella/agents/` |
| `plugins.ts` | Load plugins from `~/.stella/plugins/` |
| `stella-home.ts` | `~/.stella/` directory utilities |
| `skill_import.ts` | Import skills from `~/.claude/skills/` into `~/.stella/skills/` |
| `identity_map.ts` | Persistent pseudonymization (maps real names to aliases) |
| `manifests.ts` | Manifest file parsing |
| `bridge_manager.ts` | Local bridge lifecycle (deploy/start/stop/stopAll/isRunning) |

### User Signal Collection

| File | Purpose |
|------|---------|
| `collect-all.ts` | Orchestrates parallel collection of all signal sources |
| `discovery_types.ts` | Type definitions for discovery categories |
| `browser-data.ts` | Browser history extraction |
| `browser_bookmarks.ts` | Browser bookmark extraction |
| `safari_data.ts` | Safari history and bookmarks (macOS) |
| `app-discovery.ts` | Installed app discovery |
| `dev-projects.ts` | Development project discovery |
| `dev_environment.ts` | Git config, dotfiles, runtimes, package managers |
| `shell-history.ts` | Shell history parsing |
| `messages_notes.ts` | iMessage, Notes, Reminders, Calendar |
| `system_signals.ts` | Screen Time, Dock pins, filesystem signals |

## Adding a New Tool

1. **Create or update a `tools-*.ts` file** for the appropriate domain:

```typescript
// tools-example.ts
import type { ToolHandler } from "./tools-types";

export const exampleHandler: ToolHandler = async (args, context) => {
  const { someParam } = args as { someParam: string };
  const result = await doSomething(someParam);
  return { result: { success: true, data: result } };
};
```

2. **Register in `tools.ts`**:

```typescript
import { exampleHandler } from "./tools-example";

// In createToolHost() handler registry:
handlers.set("Example", exampleHandler);
```

3. **Backend must also define the tool** in `backend/convex/agent/device_tools.ts`

## Tool Handler Interface

```typescript
type ToolResult = { result?: unknown; error?: string };

type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>;

type ToolContext = {
  conversationId: string;
  deviceId: string;
  requestId: string;
  agentType?: string;
};
```

## Testing

- Unit tests: `*.test.ts` files (run with `bun run test:electron` from frontend root)
- Manual test files: `*.manual-test.ts` (not run in CI)

## Key Patterns

### Output Truncation
Large outputs are truncated to prevent memory issues. See `tools-utils.ts` for limits.

### Path Handling
All file paths should be normalized. Use utilities from `tools-utils.ts`.

### Error Handling
Tool handlers should catch errors and return `{ error: "message" }` rather than throwing.

### Self-Mod Interception
When `agentType` is `self_mod`, file write/edit operations are redirected to staging via `tools_self_mod.ts`.
