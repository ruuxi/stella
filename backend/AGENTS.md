# Backend

Convex serverless backend. Offline fallback responder is defined in `agent/agents.ts`. Entry point: `http.ts`. All primary agent execution happens on the local PI runtime; the backend only responds when the user's machine is offline, handles managed AI/auth HTTP endpoints, and preserves connector delivery handoff.

## Commands

```bash
bun run dev         # Convex dev server (watches + syncs)
bun run deploy      # Deploy to Convex cloud
```

## Storage

- Auth/identity, account mode, cloud-backed records, Stella provider/auth HTTP flows, and connector handoff live on Convex.
- Offline orchestrator: backend-owned, separate from normal desktop persistence — only active if the user's local machine is offline.

## Provider & Routing

- **Stella provider default**: text/model requests default to `stella/default`; the backend resolves the current recommended model, while users can still pin explicit models or use local BYOK keys.
- **Separate service routes**: non-LLM services keep their own paths/providers; for example, music uses its own route and provider flow.

## Convex Conventions

See `convex_rules.md` for full reference. Key gotchas:

- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- File names: **no hyphens** (use underscores)
- `ActionCtx` has no `ctx.db` — only `QueryCtx` and `MutationCtx` do
