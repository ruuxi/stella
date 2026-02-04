# Plugins

Plugins can contribute tools, skills, and agents.

Plugins live on disk at:

- `~/.stella/plugins/<pluginId>/plugin.json`

## `plugin.json` format

```json
{
  "id": "git-tools",
  "name": "Git Tools",
  "version": "1.0.0",
  "description": "Git helpers",
  "skills": ["skills/git/SKILL.md"],
  "agents": ["agents/reviewer/AGENT.md"],
  "tools": [
    {
      "name": "GitStatus",
      "description": "Show git status",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repoPath": { "type": "string" }
        },
        "required": ["repoPath"]
      },
      "handler": "tools/git-status.js"
    }
  ]
}
```

## Tool handlers

Tool handlers are loaded on the local host via dynamic import. A handler can export:

- `default`, or
- `handler`, or
- `run`

The handler signature is:

```ts
export default async function run(args, context) {
  return { result: "..." };
}
```

## Sync behavior

On startup and periodically, the local host:

1. Loads plugins and their tools.
2. Loads plugin-provided skills and agents.
3. Syncs manifests to the backend via `plugins.upsertMany`, `skills.upsertMany`, and `agents.upsertMany`.
