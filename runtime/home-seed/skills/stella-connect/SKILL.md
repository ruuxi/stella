---
name: stella-connect
description: Use Stella Store integrations through the stella-connect CLI.
---

# Stella Connect

Stella Connect runs integrations from Stella's Store catalog. Connector action
schemas stay deferred: inspect only the integration needed for the current task,
then call its backend action through the secure local broker.

## Connection flow

The orchestrator owns discovery and connection:

1. A user message that names a supported service triggers a hidden availability reminder.
2. The orchestrator loads the deferred `connector_status` tool with `tool_search`.
3. `connector_status` shows the inline connect card when needed.
4. Accepting opens Composio OAuth in the user's browser.
5. Stella enables the integration and writes its per-integration skill only after the backend confirms the connected account.

Agents should use an enabled integration from the `<skills>` block. If the
needed integration is not enabled, proceed by another available method and
report the limitation. Do not add or import a separate MCP/API connector.

## Commands

```bash
stella-connect installed
stella-connect apps
stella-connect discover "outlook"
stella-connect tools outlook "email search"
stella-connect catalog-actions outlook "email search"
stella-connect call outlook OUTLOOK_QUERY_EMAILS --json '{"query":"subject:receipt"}'
```

`tools` and `catalog-actions` fetch action metadata on demand through Stella's
secure worker bridge. `call` invokes the selected action through the same
backend-owned connector boundary.

The Store is the enable/disable surface. Disabled integrations cannot be called
even if an old generated skill remains.

`request-connection <id>` is card plumbing. Use it only when the user explicitly
asked in the current turn to connect that service. On a declined response, do
not re-offer unless the user explicitly asks again.
