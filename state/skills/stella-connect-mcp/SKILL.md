---
name: stella-connect-mcp
description: Import MCP servers into Stella Connect and call integrations through the stella-connect CLI.
---

# Stella Connect MCP

Use this skill when adding, changing, importing, or debugging Stella Connect integrations.

Stella's General agent does not receive connector schemas as tools. It uses `exec_command` and the `stella-connect` CLI, keeping connector discovery and execution outside the model-facing tool list.

## Fast Map

- CLI entrypoint: `runtime/kernel/cli/stella-connect.ts`
- Connector bridge: `runtime/kernel/connectors/connector-bridge.ts`
- API connector client: `runtime/kernel/connectors/api-client.ts`
- OAuth helper: `runtime/kernel/connectors/oauth.ts`
- Connector state and install/remove helpers: `runtime/kernel/connectors/state.ts`
- Connector types: `runtime/kernel/connectors/types.ts`
- Official connector definitions: `runtime/kernel/connectors/official-connectors.ts`
- General-agent prompt guidance: `runtime/extensions/stella-runtime/agents/general.md`
- Connector UI surfaces: search `desktop/src/global` for integration/store connect flows before changing UI.

## Runtime Shape

List installed connectors:

```bash
stella-connect installed
```

Inspect available actions:

```bash
stella-connect tools <connector-id>
```

Call a connector action:

```bash
stella-connect call <connector-id> <action-name> --json '{"key":"value"}'
```

API-style connectors use a path as the second argument:

```bash
stella-connect call <api-id> /v1/example --method GET --query-json '{"limit":10}'
```

## Import Existing MCP

Convert an existing local server into a Stella CLI-backed connector:

```bash
stella-connect import-mcp --id my-service --name "My Service" --command npx --args-json '["-y","my-mcp-server"]'
```

Convert a hosted endpoint:

```bash
stella-connect import-mcp --id my-service --name "My Service" --url https://example.com/mcp
```

The import command introspects available actions, writes connector state under `state/connectors/`, and creates a focused skill under `state/skills/<connector-id>/SKILL.md`.

## Adding An Official Connector

Most connector additions start in `runtime/kernel/connectors/official-connectors.ts`.

1. Add or update an `OfficialConnectorDefinition`.
2. Use a stable lowercase marketplace key.
3. Fill `displayName`, `description`, `category`, `officialSource`, `integrationPath`, `auth`, and `status`.
4. Add either `commands` for CLI-backed connector bridges, `apis` for REST-style API connectors, or both.
5. If user config is needed, add `configFields`; secret fields should use `secret: true`.
6. Set `source.marketplaceKey` on command/API entries so install/remove can track them.

Installed connector state lives under:

```text
state/connectors/commands.json
state/connectors/api-connectors.json
```

Product connector definitions belong in `runtime/kernel/connectors/official-connectors.ts`; do not hand-edit installed state unless intentionally testing local state.

## Testing

Run focused general-tool tests after changing the prompt/tool surface:

```bash
bun test desktop/tests/runtime/kernel/tools/codex-tools.test.ts
```

Run Electron typecheck after TypeScript changes:

```bash
bun run electron:typecheck
```
