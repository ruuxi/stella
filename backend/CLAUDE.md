# Backend

Convex serverless backend. Offline fallback orchestrator defined in `agent/agents.ts`. Entry point: `http.ts`. All agent execution happens on the local PI runtime — the backend only responds when the user's machine is offline (web search, scheduling, NoResponse).

## Commands

```bash
bun run dev         # Convex dev server (watches + syncs)
bun run deploy      # Deploy to Convex cloud
```

## Convex Conventions

See `convex_rules.md` for full reference. Key gotchas:

- Always include `args` validators
- Only add `returns` validators on public `query`/`mutation`/`action` functions (runtime contract for the frontend). Omit `returns` on `internalQuery`/`internalMutation`/`internalAction` — rely on TypeScript inference instead
- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- File names: **no hyphens** (use underscores)
- `ActionCtx` has no `ctx.db` — only `QueryCtx` and `MutationCtx` do
