# Local Host

Device tool executor. `runner.ts` subscribes to Convex for `tool_request` events, dispatches to handlers in `tools-*.ts`, sends back `tool_result` events.

## Adding a New Tool

1. Create or update a `tools-*.ts` file
2. Register the handler in `tools.ts`
3. Define the tool schema in `backend/convex/agent/device_tools.ts`
