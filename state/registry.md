---
name: life-registry
description: Orientation index for Stella's state directory, skills, outputs, raw material, and consolidation protocol.
---

# Life Registry

Use this file when you need orientation. Do not treat it as a mandatory first read.

## Entry Points

- [Skills Index](skills/index.md) — all skills (manuals, workflows, and any frozen executable programs)
- [Outputs](outputs/) — reusable generated artifacts

## Fast Paths

- Browser automation: [stella-browser](skills/stella-browser/SKILL.md)
- Office documents: [stella-office](skills/stella-office/SKILL.md)
- Desktop app automation: [computer-use](skills/computer-use/SKILL.md) through the `stella-computer` CLI
- Connected services: [stella-connect-mcp](skills/stella-connect-mcp/SKILL.md) through the `stella-connect` CLI
- Electron app control: [electron](skills/electron/SKILL.md)
- Modify Stella's own desktop app: [stella-desktop](skills/stella-desktop/SKILL.md)
- User profile and context: [user-profile](skills/user-profile/SKILL.md)
- Managed media generation: [stella-media](skills/stella-media/SKILL.md) and [https://stella.sh/docs/media](https://stella.sh/docs/media)

## Reference Docs

- [stella-browser command reference](skills/stella-browser/references/commands.md)
- [Snapshot and refs](skills/stella-browser/references/snapshot-refs.md)

## Memory Structure

- `skills/<name>/SKILL.md` — how things work, when to use them, decision logic. Mutable. Update when reality changes. Optionally ships a `scripts/program.ts` for deterministic execution when a skill instructs a future agent to run it via shell.
- `outputs/` — generated artifacts worth keeping. Only file if likely to matter again.

## Tools

The General agent uses a codex-style tool pack: `exec_command`, `write_stdin`, provider-selected file editing (`apply_patch` for OpenAI-authored models, `Write`/`Edit` for other models), `web`, `RequestCredential`, `multi_tool_use_parallel`, and `view_image`. Stella CLIs such as `stella-browser`, `stella-office`, `stella-computer`, and `stella-connect` are injected into the shell. Internal specialist agents still use narrower tools like `Read`, `Grep`, `Dream`, `image_gen`, and scheduling surfaces when allowed. The runtime inlines a full skill catalog while `state/skills/` stays small, then falls back to automatic Explore discovery when the catalog grows too large.

## Dream

Run the [consolidation protocol](DREAM.md) periodically to promote durable insights from notes into skills, review skill health, and prune stale entries.
