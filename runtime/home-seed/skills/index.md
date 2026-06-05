---
name: skills-index
description: Index of Stella's bundled skills. Each skill is a folder with SKILL.md plus optional scripts, references, and assets.
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
- [stella-llm](stella-llm/SKILL.md) — language model calls through Stella's managed auth and provider relay
- [pdf](pdf/SKILL.md) — PDF reading, generation, page operations, and render-based quality checks
- [skill-creator](skill-creator/SKILL.md) — create and update Stella skills
- [stella-computer-macos](stella-computer-macos/SKILL.md) — macOS desktop-app automation through the `stella-computer` CLI
- [stella-computer-windows](stella-computer-windows/SKILL.md) — Windows desktop-app automation through the `stella-computer` CLI
- [stella-connect](stella-connect-mcp/SKILL.md) — use Store integrations and imported MCP/API connectors through the `stella-connect` CLI
- [electron](electron/SKILL.md) — Electron app automation through Chromium remote debugging
- [user-profile](user-profile/SKILL.md) — structured onboarding memory for the user, including projects, apps, interests, and environment
- [stella-design](stella-design/SKILL.md) — frontend design quality guidance for Stella desktop UI and Stella-created apps

## Content and Productivity

- [humanizer](humanizer/SKILL.md) — strip AI-isms from text and add real human voice; use before publishing user-facing prose or when asked to de-slop writing
- [youtube-content](youtube-content/SKILL.md) — fetch a YouTube transcript and turn it into summaries, chapters, threads, blog posts, or quotes
- [x-api](x-api/SKILL.md) — use X (Twitter) through Stella's connected account and the `stella-x-api` CLI
- [apple-reminders](apple-reminders/SKILL.md) — manage Apple Reminders via the `remindctl` CLI, syncing to the user's Apple devices (macOS only)
- [apple-notes](apple-notes/SKILL.md) — manage Apple Notes via the `memo` CLI, syncing to the user's Apple devices (macOS only)

## Product and Integration Docs

- [stella-desktop](stella-desktop/SKILL.md) — Stella's own Electron desktop app (processes, routing, sidebar apps, dialogs, UI state)
- [create-stella-app](create-stella-app/SKILL.md) — scaffold a single-file Stella app under `desktop/src/app/_user/`, then edit only the generated file
