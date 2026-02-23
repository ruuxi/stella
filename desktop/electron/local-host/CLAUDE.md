# Local Host Tool System

Executes tools locally on the user's device on behalf of the backend agent system.

## How It Works

1. `runner.ts` subscribes to Convex for `tool_request` events targeted at this device (real-time subscription via `client.onUpdate()`)
2. Tool handlers in `tools-*.ts` files execute locally (file I/O, shell, etc.)
3. Results sent back as `tool_result` events

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

Handlers are registered in `tools.ts` as keys of a plain object (e.g., `"Read": (args, ctx) => handleRead(args, ctx)`).

## Adding a New Tool

1. Create or update a `tools-*.ts` file for the appropriate domain
2. Register the handler in `tools.ts`
3. Backend must also define the tool in `backend/convex/agent/device_tools.ts`

## Key Patterns

- **Output truncation**: Large outputs are truncated (see `tools-utils.ts` for `MAX_OUTPUT = 30_000`)
- **Path handling**: Normalize all file paths using `tools-utils.ts` utilities (`expandHomePath`, `ensureAbsolutePath`, `toPosix`)
- **Error handling**: Return `{ error: "message" }` rather than throwing
- **Self-mod interception**: When `agentType` is `self_mod`, file operations under `frontend/src/` are redirected to staging in `tools-file.ts` (not `tools_self_mod.ts`)
- **Self-mod tools**: `tools_self_mod.ts` provides explicit management tools (`SelfModStart`, `SelfModApply`, `SelfModRevert`, `SelfModStatus`, `SelfModPackage`)
- **Command safety**: `command_safety.ts` provides shell command blocklisting and path guards
- **Secret resolution**: `tools.ts` has a `resolveSecretValue` pipeline for skill secret mounts

## Runner Responsibilities (beyond tool execution)

- **Manifest sync**: Watches `~/.stella/skills/` and `~/.stella/agents/`, diffs against sync manifest, syncs to Convex
- **Device heartbeat**: Sends heartbeats every 30s to `agent/device_resolver.heartbeat`
- **Core memory sync**: Watches `~/.stella/state/CORE_MEMORY.MD` and syncs to Convex
- **Deferred delete**: Moves `rm`/`del` targets to trash (`~/.stella/state/deferred-delete/trash/`) with 24h retention
- **Identity map**: Replaces alias names in tool args with real names using `identity_map.ts`
