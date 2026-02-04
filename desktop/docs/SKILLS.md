# Skills

Skills are reusable instruction blocks that can be appended to an agent's system prompt.

Skills live on disk at:

- `~/.stella/skills/<skillId>/SKILL.md`

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
secretMounts:
  env:
    NOTION_API_KEY:
      provider: notion
      label: "Notion API Key"
version: 1
---

When reviewing code:
- Focus on regressions and missing tests.
```

## Sync behavior

The local host scans `~/.stella/skills` and syncs manifests to the backend via `skills.upsertMany`.

Enabled skills are selected server-side by agent type and appended to the system prompt.

## Optional metadata

- `execution`: `"backend"` or `"device"` to describe where the skill runs.
- `requiresSecrets`: list of credential providers required (e.g., `notion`).
- `publicIntegration`: `true` when Stella provides the API key on the backend.
- `secretMounts`: map of env vars and files that should be populated from secrets.
  - `env`: map of ENV_VAR → provider (or `{ provider, label, description, placeholder }`)
  - `files`: map of file path → provider (or `{ provider, ... }`)

If `secretMounts` is omitted, Stella will attempt to infer env vars and token file paths from the markdown as a best-effort convenience.
If `secretMounts` is provided (even partially), Stella will use it as the source of truth and skip inference.

## Using credentials

- Use `RequestCredential` to collect a user key (returns a `secretId`).
- Use `IntegrationRequest` to call external APIs with either:
  - `mode: "private"` + `secretId`, or
  - `mode: "public"` + `publicKeyEnv` (backend-managed key).
- Use `SkillBash` when running local CLI commands from a skill so secrets are injected automatically.
