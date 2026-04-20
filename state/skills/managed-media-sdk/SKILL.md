---

## name: Managed Media SDK

description: Fetch the live managed media API docs before wiring Stella media generation or media analysis features.

# Managed Media SDK

Use this entry when you are building or changing Stella features that call the managed backend media APIs.

## When To Read This

- Before wiring media generation features.
- Before wiring media analysis features.
- When you need the current request or polling contract instead of guessing from old code.

## Live Docs

The docs are published from the current Stella site deployment.

- If your Stella base already looks like `https://host/api/stella/v1`, the media docs live at `https://host/api/media/v1/docs`.
- Fetch the live docs before implementation:

```bash
curl -L "https://host/api/media/v1/docs"
```

## Notes

- The docs endpoint is public.
- Media generation and job polling still require Stella auth from the client.
- Prefer the live docs over stale examples or memory when changing backend media flows.

## Related Files

- Runtime URL helpers: `runtime/kernel/convex-urls.ts`
- Renderer structure guide: `src/STELLA.md`

## Backlinks

- [Life Registry](state/registry.md)
- [Skills Index](state/skills/index.md)

