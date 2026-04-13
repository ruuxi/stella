# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Knowledge Index](life/knowledge/index.md) — all operational manuals, workflows, and domain knowledge
- [Capabilities](life/capabilities/index.md) — reusable executable capabilities Stella builds over time
- [Notes](life/notes/) — daily task summaries (append-only)
- [Outputs](life/outputs/) — reusable generated artifacts
- [Raw](life/raw/) — unprocessed source material

## Fast Paths

- Browser automation: [stella-browser](life/knowledge/stella-browser.md)
- Office documents: [stella-office](life/knowledge/stella-office.md)
- Electron app control: [electron](life/knowledge/electron.md)
- Managed media API docs: [managed-media-sdk](life/knowledge/managed-media-sdk.md)
- Feature packaging and sharing: [blueprint-management](life/knowledge/blueprint-management.md)
- User profile and context: [user-profile](life/knowledge/user-profile/index.md)

## Reference Docs

- [stella-browser command reference](life/knowledge/references/commands.md)
- [Snapshot and refs](life/knowledge/references/snapshot-refs.md)

## Memory Structure

- `knowledge/` — how things work, how to do things. Mutable. Update when reality changes.
- `capabilities/` — reusable executable capabilities. Keep docs in `index.md` and code in `program.ts`.
- `notes/` — what happened, what was tried, what's open. Append-only. Never modify a past day's entry.
- `raw/` — unprocessed source material. Immutable after capture. Synthesize into `knowledge/`.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Dream

Run the [consolidation protocol](life/DREAM.md) periodically to promote durable insights from notes into knowledge, review capability health, and prune stale entries.