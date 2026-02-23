# Backend

Convex serverless backend. 5 agents defined in `agent/agents.ts`. Entry point: `http.ts`.

## Commands

```bash
bun run dev         # Convex dev server (watches + syncs)
bun run deploy      # Deploy to Convex cloud
```

## Convex Conventions

See `convex_rules.md` for full reference. Key gotchas:

- Always include `args` and `returns` validators
- Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- File names: **no hyphens** (use underscores)
- `ActionCtx` has no `ctx.db` — only `QueryCtx` and `MutationCtx` do
