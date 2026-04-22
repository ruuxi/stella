# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Skills Index](state/skills/index.md) — all skills (manuals, workflows, and any frozen executable programs)
- [Memories](state/memories/MEMORY.md) — Dream-curated task ledger and active focus (consumed by the Orchestrator)
- [Outputs](state/outputs/) — reusable generated artifacts
- [Raw](state/raw/) — unprocessed source material

## Fast Paths

- Browser automation: [stella-browser](state/skills/stella-browser/SKILL.md)
- Office documents: [stella-office](state/skills/stella-office/SKILL.md)
- macOS desktop app automation: typed `computer_*` tools (no skill — schemas are self-documenting)
- Electron app control: [electron](state/skills/electron/SKILL.md)
- Modify Stella's own desktop app: [stella-desktop](state/skills/stella-desktop/SKILL.md)
- Managed media API docs: [https://stella.sh/docs/media](https://stella.sh/docs/media) (the General agent prompt covers `image_gen` usage and when to read the docs)
- Feature packaging and sharing: [blueprint-management](state/skills/blueprint-management/SKILL.md)
- User profile and context: [user-profile](state/skills/user-profile/SKILL.md)

## Reference Docs

- [stella-browser command reference](state/skills/stella-browser/references/commands.md)
- [Snapshot and refs](state/skills/stella-browser/references/snapshot-refs.md)

## Memory Structure

- `skills/<name>/SKILL.md` — how things work, when to use them, decision logic. Mutable. Update when reality changes. Optionally ships a `scripts/program.ts` for deterministic execution when a skill instructs a future agent to run it via shell.
- `memories/MEMORY.md` — Dream-curated task ledger. Each block is a related cluster of past General agent work. Consumed by the Orchestrator on first turn.
- `memories/memory_summary.md` — short rolling "what is the user actively working on right now" view. Consumed by the Orchestrator every turn.
- `raw/` — unprocessed source material. Immutable after capture. Synthesize into `skills/` when useful.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Tools

The General agent now uses a codex-style tool pack: `exec_command`, `write_stdin`, `apply_patch`, `web`, `RequestCredential`, `multi_tool_use.parallel`, `view_image`, and `image_gen`. Internal specialist agents still use narrower tools like `Read`, `Grep`, `Dream`, and the scheduling surfaces when allowed. The runtime inlines a full skill catalog while `state/skills/` stays small, then falls back to automatic Explore discovery when the catalog grows too large.

## Dream

Run the [consolidation protocol](state/DREAM.md) periodically to promote durable insights from notes into skills, review skill health, and prune stale entries.