# Stella Home (`~/.stella`)

Stella uses a single default home directory at:

- Windows: `%USERPROFILE%\\.stella`
- macOS/Linux: `~/.stella`

This directory is the default workspace and contains agent instructions, skills, and local state.

## Layout

```text
~/.stella/
  agents/
    <agentId>/AGENT.md
  skills/
    <skillId>/SKILL.md
  state/
    device.json
    todos/
    tests/
  logs/
```

## Migration

On startup, Stella performs a one-time best-effort migration from the Electron `userData` directory into `~/.stella/state` for:

- `device.json`
- `todos/*`
- `tests/*`

A migration marker file is written to `~/.stella/migration.v1.json`.
