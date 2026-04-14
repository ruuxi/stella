# Subagent Extension Reference

This example shows the minimal Stella pattern for Pi-style subagent registration:

- agent prompts live as markdown files
- an extension `index.ts` registers those agents
- Stella's runtime keeps background execution in the task manager instead of in the extension itself

Reference points:

- Pi upstream example: `/Users/rahulnanda/projects/pi-mono/packages/coding-agent/examples/extensions/subagent`
- Stella built-in runtime extension: [`../../stella-runtime/index.ts`](../../stella-runtime/index.ts)

Important difference from Pi:

- Pi does not provide fire-and-forget background execution by default.
- Stella keeps that behavior in `desktop/runtime/kernel/tasks/local-task-manager.ts` and `desktop/runtime/kernel/runner/task-orchestration.ts`.
- This example only covers agent registration and prompt layout, not task scheduling.

## Layout

```text
subagent-reference/
├── README.md
├── index.ts
└── agents/
    ├── scout.md
    └── worker.md
```

## Usage

Copy or adapt this layout when you need a project-local extension that contributes specialized agents without adding a separate package install step.
