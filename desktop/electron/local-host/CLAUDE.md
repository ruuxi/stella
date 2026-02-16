# Local Host Tool System

Executes tools locally on the user's device on behalf of the backend agent system.

## How It Works

1. `runner.ts` polls Convex for `tool_request` events targeted at this device
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

Handlers are registered in `tools.ts` by name (e.g., `handlers.set("Read", readHandler)`).

## Adding a New Tool

1. Create or update a `tools-*.ts` file for the appropriate domain
2. Register the handler in `tools.ts`
3. Backend must also define the tool in `backend/convex/agent/device_tools.ts`

## Key Patterns

- **Output truncation**: Large outputs are truncated (see `tools-utils.ts` for limits)
- **Path handling**: Normalize all file paths using `tools-utils.ts` utilities
- **Error handling**: Return `{ error: "message" }` rather than throwing
- **Self-mod interception**: When `agentType` is `self_mod`, file writes are redirected to staging via `tools_self_mod.ts`
