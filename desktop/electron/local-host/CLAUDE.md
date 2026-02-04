# Local Host Tool System

This directory implements the local tool execution system that runs on the user's device.

## How It Works

1. **Polling**: `runner.ts` polls Convex for `tool_request` events targeted at this device
2. **Execution**: Tool handlers execute locally (file I/O, shell commands, web requests)
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
| `tools-shell.ts` | Bash, SkillBash, KillShell |
| `tools-web.ts` | WebFetch, WebSearch |
| `tools-state.ts` | TodoWrite, TestWrite, Task, TaskOutput |
| `tools-user.ts` | AskUserQuestion, RequestCredential |
| `tools-database.ts` | SqliteQuery |

### Other Modules

| File | Purpose |
|------|---------|
| `device.ts` | Persistent device ID generation |
| `skills.ts` | Load skills from `~/.stella/skills/` |
| `agents.ts` | Load agents from `~/.stella/agents/` |
| `plugins.ts` | Load plugins from `~/.stella/plugins/` |
| `stella-home.ts` | `~/.stella/` directory utilities |
| `browser-data.ts` | Browser history/bookmark extraction |
| `app-discovery.ts` | Installed app discovery |
| `dev-projects.ts` | Development project discovery |
| `shell-history.ts` | Shell history parsing |
| `manifests.ts` | Manifest file parsing |

## Adding a New Tool

1. **Create or update a `tools-*.ts` file** for the appropriate domain:

```typescript
// tools-example.ts
import type { ToolHandler } from "./tools-types";

export const exampleHandler: ToolHandler = async (args, context) => {
  // Validate args
  const { someParam } = args as { someParam: string };

  // Execute tool logic
  const result = await doSomething(someParam);

  // Return result (will be JSON serialized)
  return { success: true, data: result };
};
```

2. **Register in `tools.ts`**:

```typescript
import { exampleHandler } from "./tools-example";

// In createToolHost() or the handlers object:
handlers.set("Example", exampleHandler);
```

3. **Backend must also define the tool** in `backend/convex/device_tools.ts`

## Tool Handler Interface

```typescript
type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>;

interface ToolContext {
  deviceId: string;
  conversationId: string;
  requestId: string;
  // IPC helpers for UI interaction
  sendToRenderer: (channel: string, data: unknown) => void;
}
```

## Testing

- Unit tests in `__tests__/` directory
- Manual test files: `*.manual-test.ts` (not run in CI)
- Run tests: `bun run test:run` from frontend root

## Key Patterns

### Output Truncation
Large outputs are truncated to prevent memory issues. See `tools-utils.ts` for limits.

### Path Handling
All file paths should be normalized. Use utilities from `tools-utils.ts`.

### Error Handling
Tool handlers should catch errors and return structured error responses rather than throwing.
