# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Knowledge Index](state/knowledge/index.md) — all operational manuals, workflows, and domain knowledge
- [Capabilities](state/capabilities/index.md) — reusable executable capabilities Stella builds over time
- [Notes](state/notes/) — daily task summaries (append-only)
- [Outputs](state/outputs/) — reusable generated artifacts
- [Raw](state/raw/) — unprocessed source material

## Fast Paths

- Browser automation: [stella-browser](state/knowledge/stella-browser.md)
- Office documents: [stella-office](state/knowledge/stella-office.md)
- Electron app control: [electron](state/knowledge/electron.md)
- Managed media API docs: [managed-media-sdk](state/knowledge/managed-media-sdk.md)
- Feature packaging and sharing: [blueprint-management](state/knowledge/blueprint-management.md)
- User profile and context: [user-profile](state/knowledge/user-profile/index.md)

## Reference Docs

- [stella-browser command reference](state/knowledge/references/commands.md)
- [Snapshot and refs](state/knowledge/references/snapshot-refs.md)

## Memory Structure

- `knowledge/` — how things work, how to do things. Mutable. Update when reality changes.
- `capabilities/` — reusable executable capabilities. Keep docs in `index.md` and code in `program.ts`.
- `notes/` — what happened, what was tried, what's open. Append-only. Never modify a past day's entry.
- `raw/` — unprocessed source material. Immutable after capture. Synthesize into `knowledge/`.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Dream

Run the [consolidation protocol](state/DREAM.md) periodically to promote durable insights from notes into knowledge, review capability health, and prune stale entries.