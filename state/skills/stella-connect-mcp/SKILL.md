---
name: stella-connect-mcp
description: Import an MCP server as a Stella CLI connector and call its actions through the stella-connect CLI.
---

# Stella Connect (MCP → CLI)

Stella does not ship a preset connector catalog. The user (or the agent on their behalf) adds an MCP server with `stella-connect import-mcp`; the CLI probes the server, persists it under `state/connectors/`, and writes a per-connector skill under `state/skills/<id>/SKILL.md` so future runs discover it via the normal skill catalog. Connector action schemas are never preloaded into the model context — they're inspected on demand via `stella-connect tools` and invoked via `stella-connect call`.

## Source layout

- CLI entrypoint: `runtime/kernel/cli/stella-connect.ts`
- MCP bridge (stdio/streamable_http): `runtime/kernel/connectors/connector-bridge.ts`
- REST connector client: `runtime/kernel/connectors/api-client.ts`
- OAuth + token storage: `runtime/kernel/connectors/oauth.ts`
- Configured-connector state: `runtime/kernel/connectors/state.ts`
- Types: `runtime/kernel/connectors/types.ts`

## Adding an MCP

Stdio command:

```bash
stella-connect import-mcp \
  --id my-service \
  --name "My Service" \
  --command npx \
  --args-json '["-y","my-mcp-server"]'
```

Streamable HTTP URL:

```bash
stella-connect import-mcp \
  --id my-service \
  --name "My Service" \
  --url https://example.com/mcp
```

The import probes available actions, writes `state/connectors/commands.json`, and creates `state/skills/my-service/SKILL.md`.

## Calling a connector

```bash
stella-connect installed                    # list what's configured
stella-connect tools my-service             # list actions
stella-connect call my-service <action> --json '{"key":"value"}'
```

REST-style API connectors use a path as the second argument:

```bash
stella-connect call my-api /v1/example --method GET --query-json '{"limit":10}'
```

## Auth

When an MCP requires auth, declare it on `import-mcp` so the bridge knows how to attach credentials:

```bash
stella-connect import-mcp \
  --id my-service --name "My Service" --url https://example.com/mcp \
  --auth-type api_key --auth-token-key my-service \
  --auth-header-name Authorization --auth-scheme bearer
```

Authenticated hosted MCPs can't be probed at import time (no credential exists for the new `tokenKey` yet), so `import-mcp` **defers the probe** when it sees an auth failure: the connector is still persisted and a skill stub is written. The output includes `probeDeferred: true` and a `hint` telling you which `tokenKey` to bind. Once the credential is bound, run:

```bash
stella-connect refresh-skill my-service
```

to re-probe and rewrite the skill's `## Actions` list. Real probe failures (network, malformed server, unauthenticated 500s) still surface as errors instead of being swallowed.

Any `stella-connect call` / `tools` / `refresh-skill` invocation that hits HTTP 401/403/407 — or runs against a connector with no stored credential — exits with **status 2** and prints a structured payload on stdout: `{ "ok": false, "error": "auth_required", "tokenKey": "...", "displayName": "...", ... }`. Branch on that to decide whether to prompt the user vs. surface a real failure.

For the credential itself, use the `RequestCredential` tool — the user sees a secure dialog, the value never reaches model context, and the tool returns a `secretId` handle. Persisting that secret to the connector's `tokenKey` is currently a TODO (the credential broker lives in the desktop process, not the CLI). For now, configure auth via env vars at import time (`--env-json '{"API_KEY":"…"}'`) or have the user paste the key into the dialog and let the agent invoke a follow-up that writes it through `saveConnectorAccessToken`.

## Removing a connector

```bash
stella-connect remove <id>
```

Drops the entry from `state/connectors/{commands,api-connectors}.json`. Stored tokens under `state/connectors/.credentials.json` are not deleted automatically — drop them manually if the connector is gone for good.
