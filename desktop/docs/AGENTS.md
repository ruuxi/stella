# Agents

Agents are instruction sets that define a system prompt, tool preferences, and delegation limits.

Agents live on disk at:

- `~/.stella/agents/<agentId>/AGENT.md`

## `AGENT.md` format

Use YAML frontmatter followed by Markdown instructions.

```md
---
id: coder
name: Coder
agentTypes: [general]
description: Implements and tests changes.
toolsAllowlist: [Read, Write, Edit, Grep, Bash, Task, TaskOutput]
defaultSkills: [typescript, testing]
maxTaskDepth: 2
version: 1
---

You are a careful implementation agent...
```

## Sync behavior

The local host scans `~/.stella/agents` and syncs manifests to the backend via `agents.upsertMany`.

Built-in agents (`general`, `self_mod`) are always ensured server-side.
