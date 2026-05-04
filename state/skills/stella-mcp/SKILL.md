---
name: stella-mcp
description: Add or modify Stella Connect MCP and API connector integrations.
---

# Stella MCP

Use this skill when adding, changing, or debugging Stella Connect integrations, MCP servers, API connectors, or the `MCP` deferred tool.

Stella's General agent sees one compact `MCP` tool. Connector tools are discovered and called on demand instead of preloading every schema.

## Fast Map

- Deferred `MCP` tool: `runtime/kernel/tools/defs/mcp.ts`
- MCP client: `runtime/kernel/mcp/client.ts`
- API connector client: `runtime/kernel/mcp/api-client.ts`
- OAuth helper: `runtime/kernel/mcp/oauth.ts`
- Connector state and install/remove helpers: `runtime/kernel/mcp/state.ts`
- Connector types: `runtime/kernel/mcp/types.ts`
- Official connector definitions: `runtime/kernel/mcp/official-connectors.ts`
- General-agent prompt guidance: `runtime/extensions/stella-runtime/agents/general.md`
- Connector UI surfaces: search `desktop/src/global` for integration/store connect flows before changing UI.

## Runtime Shape

The model calls:

```ts
MCP({ action: "servers" })
MCP({ action: "tools", server: "<server-id>" })
MCP({
  action: "call",
  server: "<server-id>",
  tool: "<tool-name>",
  arguments: {}
})
```

API-style connectors use:

```ts
MCP({ action: "apis" })
MCP({
  action: "api_call",
  server: "<api-id>",
  path: "/v1/example",
  method: "GET",
  query: {}
})
```

`server` may also name a local pseudo-server such as `computer-use`. Pseudo-servers can be implemented inside `runtime/kernel/tools/defs/mcp.ts` without running a real MCP server.

## Adding An Official Connector

Most connector additions start in `runtime/kernel/mcp/official-connectors.ts`.

1. Add or update an `OfficialConnectorDefinition`.
2. Use a stable lowercase marketplace key.
3. Fill `displayName`, `description`, `category`, `officialSource`, `integrationPath`, `auth`, and `status`.
4. Add either `servers` for MCP servers, `apis` for REST-style API connectors, or both.
5. If user config is needed, add `configFields`; secret fields should use `secret: true`.
6. Set `source.marketplaceKey` on server/API entries so install/remove can track them.

Server configs follow `McpServerConfig`:

- `transport`: `"stdio"` or `"streamable_http"`
- `command` and `args` for stdio servers
- `url` and optional `headers` for streamable HTTP
- `auth.type`: `"oauth"`, `"api_key"`, or `"none"`

API configs follow `ApiConnectorConfig`:

- `baseUrl`
- optional auth config
- `source.marketplaceKey`

## State Files

Installed connector state lives under:

```text
state/mcp/servers.json
state/mcp/api-connectors.json
```

Do not hand-edit these for product changes unless you are intentionally testing local state. Product connector definitions belong in `runtime/kernel/mcp/official-connectors.ts`.

## Local Pseudo-Servers

Use a local pseudo-server when a Stella-native tool group should be discoverable through `MCP` but does not need a real MCP process.

Pattern:

1. Add a stable pseudo-server id in `runtime/kernel/tools/defs/mcp.ts`.
2. Include it in `action: "servers"`.
3. Return its tool metadata from `action: "tools"`.
4. Dispatch `action: "call"` to existing local handlers through the tool host or a local implementation.
5. Keep detailed usage guidance in a skill under `state/skills/` rather than in the always-loaded tool description.

The `computer-use` pseudo-server is the reference pattern.

## Testing

Use focused tests for the deferred tool envelope:

```bash
bun test desktop/tests/runtime/kernel/tools/codex-tools.test.ts
```

Run Electron typecheck after TypeScript changes:

```bash
bun run electron:typecheck
```

If a connector requires credentials or external network access, test install/list behavior separately from live calls. The `MCP` tool should return clear errors when setup is missing.
