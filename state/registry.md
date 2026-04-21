# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Skills Index](state/skills/index.md) — all skills (manuals, workflows, and any frozen executable programs)
- [Notes](state/notes/) — daily task summaries (append-only)
- [Outputs](state/outputs/) — reusable generated artifacts
- [Raw](state/raw/) — unprocessed source material

## Fast Paths

- Browser automation: [stella-browser](state/skills/stella-browser/SKILL.md)
- Office documents: [stella-office](state/skills/stella-office/SKILL.md)
- Desktop app automation: [stella-computer](state/skills/stella-computer/SKILL.md)
- Electron app control: [electron](state/skills/electron/SKILL.md)
- Modify Stella's own desktop app: [stella-desktop](state/skills/stella-desktop/SKILL.md)
- Managed media API docs: [managed-media-sdk](state/skills/managed-media-sdk/SKILL.md)
- Feature packaging and sharing: [blueprint-management](state/skills/blueprint-management/SKILL.md)
- User profile and context: [user-profile](state/skills/user-profile/SKILL.md)

## Reference Docs

- [stella-browser command reference](state/skills/stella-browser/references/commands.md)
- [Snapshot and refs](state/skills/stella-browser/references/snapshot-refs.md)

## Memory Structure

- `skills/<name>/SKILL.md` — how things work, when to use them, decision logic. Mutable. Update when reality changes. Optionally ships a `scripts/program.ts` for deterministic execution when a skill instructs a future agent to run it via shell.
- `notes/` — what happened, what was tried, what's open. Append-only. Never modify a past day's entry.
- `raw/` — unprocessed source material. Immutable after capture. Synthesize into `skills/` when useful.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Code Mode

The General agent runs everything through `Exec` (Codex-style code mode). Capabilities live on the global `tools` object inside each program: `tools.read_file`, `tools.write_file`, `tools.apply_patch`, `tools.shell`, `tools.glob`, `tools.search`, `tools.web_*`, plus agent-specific tools like tasks, scheduling, display, and memory when allowed. The runtime inlines a full skill catalog while `state/skills/` stays small, then falls back to automatic Explore discovery when the catalog grows too large. Built-in helpers: `text(value)`, `image(absolutePath)`, `store(key, value)` / `load(key)`, `notify(text)`, `yield_control()`, `exit(value?)`, plus `// @exec: yield_after_ms=…` for long-running cells resumed by `Wait({ cell_id })`.

## Dream

Run the [consolidation protocol](state/DREAM.md) periodically to promote durable insights from notes into skills, review skill health, and prune stale entries.
