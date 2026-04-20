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
- [stella-computer](stella-computer/SKILL.md) — macOS desktop automation through Accessibility-first refs
- [electron](electron/SKILL.md) — Electron app automation through Chromium remote debugging

## Product and Integration Docs

- [blueprint-management](blueprint-management/SKILL.md) — feature packaging and sharing
- [managed-media-sdk](managed-media-sdk/SKILL.md) — managed media API notes
- [user-profile](user-profile/SKILL.md) — user profile and context (populated by onboarding)

## Backlinks

- [Life Registry](../registry.md)
