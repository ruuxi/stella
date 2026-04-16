# Stella Runtime Extension

This is Stella's built-in Pi-style runtime extension.

## What lives here

- `index.ts`: registers the built-in agent definitions
- `agents/*.md`: orchestrator, general, and schedule prompts in markdown instead of hardcoded TypeScript

## Why it exists

Stella's runtime was already partially derived from Pi, but core agent setup had drifted back into hardcoded runtime code. This extension keeps the agent layer shaped like Pi:

- prompts live in markdown
- the extension entry point registers them
- the runtime loader discovers the extension from `runtime/extensions`

## Stella-specific differences

- Stella keeps thread/session state in SQLite, but the schema now mirrors Pi's append-only session structure more closely with session headers and linked entries.
- Stella keeps background execution in the local task manager. Pi's upstream extension examples show delegation patterns, but Stella still owns fire-and-forget task execution.
- Stella's provider surface stays OpenAI-chat-compatible for the app, while the backend Stella provider now executes through the Responses API upstream.

## Reference

- Pi docs: `/Users/rahulnanda/projects/pi-mono/packages/coding-agent/docs`
- Pi subagent example: `/Users/rahulnanda/projects/pi-mono/packages/coding-agent/examples/extensions/subagent`
- Stella reference example: `../examples/subagent-reference`
