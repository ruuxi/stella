# Stellar Home (`~/.stellar`)

Stellar uses a single default home directory at:

- Windows: `%USERPROFILE%\\.stellar`
- macOS/Linux: `~/.stellar`

This directory is the default workspace and contains agent instructions, skills, plugins, and local state.

## Layout

```text
~/.stellar/
  agents/
    <agentId>/AGENT.md
  skills/
    <skillId>/SKILL.md
  plugins/
    <pluginId>/plugin.json
  state/
    device.json
    todos/
    tests/
  logs/
```

## Migration

On startup, Stellar performs a one-time best-effort migration from the Electron `userData` directory into `~/.stellar/state` for:

- `device.json`
- `todos/*`
- `tests/*`

A migration marker file is written to `~/.stellar/migration.v1.json`.
