# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Knowledge Index](knowledge/index.md) — all operational manuals, workflows, and domain knowledge
- [Capabilities](capabilities/index.md) — reusable executable capabilities Stella builds over time
- [Notes](notes/) — daily task summaries (append-only)
- [Outputs](outputs/) — reusable generated artifacts
- [Raw](raw/) — unprocessed source material

## Fast Paths

- Browser automation: [stella-browser](knowledge/stella-browser.md)
- Office documents: [stella-office](knowledge/stella-office.md)
- Electron app control: [electron](knowledge/electron.md)
- Managed media API docs: [managed-media-sdk](knowledge/managed-media-sdk.md)
- Feature packaging and sharing: [blueprint-management](knowledge/blueprint-management.md)
- User profile and context: [user-profile](knowledge/user-profile/index.md)

## Reference Docs

- [stella-browser command reference](knowledge/references/commands.md)
- [Snapshot and refs](knowledge/references/snapshot-refs.md)

## Memory Structure

- `knowledge/` — how things work, how to do things. Mutable. Update when reality changes.
- `capabilities/` — reusable executable capabilities. Keep docs in `index.md` and code in `program.ts`.
- `notes/` — what happened, what was tried, what's open. Append-only. Never modify a past day's entry.
- `raw/` — unprocessed source material. Immutable after capture. Synthesize into `knowledge/`.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Dream

Run the [consolidation protocol](DREAM.md) periodically to promote durable insights from notes into knowledge, review capability health, and prune stale entries.