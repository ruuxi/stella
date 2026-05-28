---
name: stella-connect
description: Use Store integrations and imported MCP/API connectors through the stella-connect CLI.
---

# Stella Connect

Stella Connect has two paths:

- Store integrations: the user enables them in Store, Stella writes a small skill under `~/.stella/skills/<id>/SKILL.md`, and future runs call them with `stella-connect`.
- Imported MCP/API connectors: the user or agent adds them with `stella-connect import-mcp`; the CLI probes the server, persists it under `~/.stella/connectors/`, and writes the same kind of per-connector skill.

Connector action schemas are never preloaded into the model context. Inspect them on demand with `stella-connect tools` and invoke them with `stella-connect call`.

## Source layout

- CLI entrypoint: `runtime/kernel/cli/stella-connect.ts`
- MCP bridge (stdio/streamable_http): `runtime/kernel/connectors/connector-bridge.ts`
- REST connector client: `runtime/kernel/connectors/api-client.ts`
- Native Store integration catalog/state: `runtime/kernel/connectors/native-integrations.ts`
- OAuth + token storage: `runtime/kernel/connectors/oauth.ts`
- Configured-connector state: `runtime/kernel/connectors/state.ts`
- Types: `runtime/kernel/connectors/types.ts`

## Store integrations

```bash
stella-connect apps
stella-connect installed
stella-connect tools gmail
stella-connect call gmail gmail.search --json '{"query":"from:someone@example.com"}'
```

The Store is the normal enable/disable surface. The CLI also has `enable-native <id>` and `disable-native <id>` for diagnostics and local repair. Disabled integrations cannot be called even if an old skill file remains.

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

The import probes available actions, writes `~/.stella/connectors/commands.json`, and creates `~/.stella/skills/my-service/SKILL.md`.

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

Two auth types are supported. Declare one on `import-mcp` so the bridge knows what to do when the MCP returns 401/403.

**OAuth — prefer this** when the MCP supports it (Linear, Atlassian Rovo, Notion, Asana, and most modern hosted MCPs). Stella opens the user's default browser, runs PKCE Authorization Code with dynamic client registration, and persists the resulting access token. No token to paste. While the browser tab is open, the user sees a "Connecting <X>…" indicator with Cancel:

```bash
stella-connect import-mcp \
  --id linear --name "Linear" --url https://mcp.linear.app/sse \
  --auth-type oauth --auth-token-key linear
```

**API key** for MCPs that hand the user a bearer token in their dev dashboard:

```bash
stella-connect import-mcp \
  --id my-service --name "My Service" --url https://example.com/mcp \
  --auth-type api_key --auth-token-key my-service \
  --auth-header-name Authorization --auth-scheme bearer
```

When the CLI hits a 401/403 (during `import-mcp` probe, `tools`, `call`, or `refresh-skill`) AND the connector has an `auth-token-key` AND the worker exposed its CLI bridge socket (env `STELLA_CLI_BRIDGE_SOCK`, normally always set under Stella), the CLI **pauses and pops the matching dialog** inline. For OAuth: browser opens, user authorizes, token saves. For api_key: paste-key modal, user pastes, token saves. Either way the desktop writes to `~/.stella/connectors/.credentials.json` and the CLI retries the original call once — you just see the successful result in your tool output, no extra steps needed.

For `tools`, `call`, and `refresh-skill`: if the user dismisses the dialog, the bridge is unreachable, or the second attempt also fails (bad key), the CLI exits with **status 2** and prints `{ "ok": false, "error": "auth_required", "tokenKey": "...", "displayName": "...", ... }` on stdout. Treat that as "user declined / key is bad" and either ask the user what went wrong or move on; don't immediately retry the same command without a different plan.

For `import-mcp` specifically, an auth failure (user cancel, bad key, or bridge unreachable) is **non-fatal** — the connector is still persisted and the output carries `probeDeferred: true` plus a `hint`. Action list is left as a stub. Once the credential is bound (e.g. on a later retry or out of band), run `stella-connect refresh-skill <id>` to populate `## Actions`. This is intentional: the user explicitly declared the connector's auth shape on the import command, so throwing away the persisted entry on a probe miss would just force them to retype the whole `--auth-*` flag set.

Non-auth probe failures (network, malformed server, unauthenticated 500s) still surface as plain errors so a broken connector doesn't get silently imported.

The `RequestCredential` agent tool still exists for non-connector secrets — use it for things like provider API keys that flow through `secretId`. Connector tokens specifically should let the auto-popup handle them; no manual `RequestCredential` orchestration needed.

## Removing a connector

```bash
stella-connect remove <id>
```

Drops the entry from `~/.stella/connectors/{commands,api-connectors}.json`. Stored tokens under `~/.stella/connectors/.credentials.json` are not deleted automatically — drop them manually if the connector is gone for good.
