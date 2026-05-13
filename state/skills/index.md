---
name: skills-index
description: Index of Stella's skills under state/skills. Each skill is a folder with SKILL.md plus optional scripts, references, and assets.
---

# Skills Index

Each skill is a folder. The folder name is the skill ID. Inside:

- `SKILL.md` — frontmatter (`name`, `description`) plus instructions, decision logic, gotchas. Always present.
- `scripts/program.ts` — optional. Deterministic executable program runnable as a plain shell entrypoint when the `SKILL.md` tells a future agent to use it. Add this when an approach has been used reliably across multiple sessions and re-derivation cost is unacceptable.
- `references/`, `templates/`, `assets/` — optional supporting files the skill references by relative path.
- `input.schema.json`, `output.schema.json` — optional input/output schemas for documentation.

## Core Tooling

- [stella-browser](stella-browser/SKILL.md) — browser automation through Stella's Chrome extension bridge
- [stella-office](stella-office/SKILL.md) — office document creation and editing
- [stella-media](stella-media/SKILL.md) — image, video, audio, music, and 3D generation through Stella's managed media gateway
- [pdf](pdf/SKILL.md) — PDF reading, generation, page operations, and render-based quality checks
- [skill-creator](skill-creator/SKILL.md) — create and update Stella skills under `state/skills`
- [stella-computer](stella-computer/SKILL.md) — desktop-app automation through the `stella-computer` CLI
- [stella-connect-mcp](stella-connect-mcp/SKILL.md) — import MCP servers into Stella Connect and call integrations through the `stella-connect` CLI
- [electron](electron/SKILL.md) — Electron app automation through Chromium remote debugging
- [user-profile](user-profile/SKILL.md) — structured onboarding memory for the user, including projects, apps, interests, and environment

## Product and Integration Docs

- [stella-desktop](stella-desktop/SKILL.md) — Stella's own Electron desktop app (processes, routing, sidebar apps, dialogs, UI state)
- [create-stella-app](create-stella-app/SKILL.md) — scaffold a Stella sidebar app in one shell call, then edit only the generated page

## Backlinks

- [Life Registry](../registry.md)
