# Skills

Skills are reusable instruction blocks that can be appended to an agent's system prompt.

Skills live on disk at:

- `~/.stellar/skills/<skillId>/SKILL.md`

## `SKILL.md` format

Use YAML frontmatter followed by Markdown instructions.

```md
---
id: code-review
name: Code Review
description: Find bugs and missing tests.
agentTypes: [general, self_mod]
toolsAllowlist: [Read, Grep, Bash]
tags: [code, review]
execution: backend
requiresSecrets: [notion]
publicIntegration: false
version: 1
---

When reviewing code:
- Focus on regressions and missing tests.
```

## Sync behavior

The local host scans `~/.stellar/skills` and syncs manifests to the backend via `skills.upsertMany`.

Enabled skills are selected server-side by agent type and appended to the system prompt.

## Optional metadata

- `execution`: `"backend"` or `"device"` to describe where the skill runs.
- `requiresSecrets`: list of credential providers required (e.g., `notion`).
- `publicIntegration`: `true` when Stellar provides the API key on the backend.
