---
name: stella-runtime-extension
description: Extend Stella's Pi-shaped runtime with agents, tools, hooks, providers, and prompt templates.
---

# Stella Runtime Extension

Use this skill when modifying Stella's runtime extension surface: adding or changing agents, tools, lifecycle hooks, providers, prompt templates, or the built-in `stella-runtime` extension.

Stella's runtime extension system is Pi-shaped. The extension loader discovers files under `runtime/extensions/` and registers them through `ExtensionFactory`.

## Fast Map

- Extension contracts: `runtime/kernel/extensions/types.ts`
- Extension loader: `runtime/kernel/extensions/loader.ts`
- Built-in extension: `runtime/extensions/stella-runtime/`
- Built-in agent prompts: `runtime/extensions/stella-runtime/agents/*.md`
- Built-in Stella hooks: `runtime/extensions/stella-runtime/hooks/*.hook.ts`
- Minimal agent-extension example: `runtime/extensions/examples/subagent-reference/`
- Parsed markdown agents: `runtime/kernel/agents/markdown-agent-loader.ts`
- Built-in tool definitions: `runtime/kernel/tools/defs/`
- Tool host registration: `runtime/kernel/tools/defs/index.ts` and `runtime/kernel/tools/host.ts`

## Extension Layout

Use a folder under `runtime/extensions/<extension-id>/`.

For an extension that registers agents:

```text
runtime/extensions/<extension-id>/
├── index.ts
└── agents/
    └── <agent-id>.md
```

For file-discovered extension parts:

```text
runtime/extensions/
├── tools/*.tool.ts
├── hooks/*.hook.ts
├── providers/*.provider.ts
└── prompts/*.prompt.md
```

The loader also imports extension folders that have `index.ts`. Those factories receive an API with:

- `registerAgent(agent)`
- `registerTool(tool)`
- `registerProvider(provider)`
- `registerPrompt(prompt)`
- `on(event, handler, filter?)`

The factory's second argument is `ExtensionServices`. Use it for runtime-owned services such as `stellaHome`, `stellaRoot`, `store`, `memoryStore`, and `selfModMonitor` instead of reaching through runner internals.

## Built-In Stella Runtime

Stella-specific behavior should live in `runtime/extensions/stella-runtime/`, not as hardcoded branches in the kernel. Existing hooks there cover:

- Personality injection
- Self-mod baseline capture and detect-applied
- Stale-user and dynamic-memory reminders
- Memory injection cadence and bundle assembly
- Memory review, Dream scheduler notifications, home suggestion refresh, and thread-summary recording

When moving behavior out of the kernel, preserve capability gates through `AgentCapabilities` in `runtime/contracts/agent-runtime.ts` and register the hook from `runtime/extensions/stella-runtime/index.ts`.

## Adding An Agent

Prefer markdown agents for Stella runtime agents.

1. Add `runtime/extensions/<extension-id>/agents/<agent-id>.md`.
2. Use frontmatter fields such as `name`, `description`, `tools`, and `maxAgentDepth`.
3. Register the folder from `index.ts`:

```ts
import { loadParsedAgentsFromDir } from "../../kernel/agents/markdown-agent-loader.js";
import type { ExtensionFactory } from "../../kernel/extensions/types.js";

const AGENTS_DIR = new URL("./agents/", import.meta.url);

const extension: ExtensionFactory = (pi) => {
  for (const agent of loadParsedAgentsFromDir(AGENTS_DIR)) {
    pi.registerAgent(agent);
  }
};

export default extension;
```

Use the built-in `runtime/extensions/stella-runtime/index.ts` and `runtime/extensions/examples/subagent-reference/` as the reference pattern.

## Adding A Tool

For core Stella tools, prefer the built-in tool path:

1. Add `runtime/kernel/tools/defs/<name>.ts`.
2. Export a `ToolDefinition` or factory with `name`, `description`, `parameters`, and `execute`.
3. Register it in `runtime/kernel/tools/defs/index.ts`.
4. Add the tool name to the relevant agent's `tools:` frontmatter.

For extension-owned tools, create `runtime/extensions/tools/<name>.tool.ts` or register a tool from an extension `index.ts`.

Tool definitions return `ToolResult` and receive `ToolContext`. Keep schemas narrow and descriptions concise; put larger operating guidance into a skill under `state/skills/`.

## Adding Hooks Or Providers

Hook events are typed in `runtime/kernel/extensions/types.ts`. Available hook points include:

- `before_tool`
- `after_tool`
- `before_agent_start`
- `before_user_message`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `before_compact`
- `session_compact`
- `before_provider_request`
- `after_provider_response`
- `session_start`
- `session_shutdown`

Use `before_agent_start` for system-prompt changes and `before_user_message` for hidden prompt messages around the user turn. Hooks may be filtered by agent type; prefer capability checks for behavioral gates that should follow an agent definition.

Providers implement `ProviderDefinition` from `runtime/kernel/extensions/types.ts`. Use providers only when adding a real model backend or compatibility layer; routine model defaults usually belong in backend model config instead.

## Prompt Changes

Agent prompts live in `runtime/extensions/stella-runtime/agents/*.md`. Keep prompt changes small and outcome-first. Do not add tool schema reference sections; tool schemas are already attached by the runtime.

General-agent prompts should stay lean. Move detailed reusable procedure into `state/skills/<skill-id>/SKILL.md` and have the prompt point to the skill by name.

## Validation

Run the narrowest relevant checks:

```bash
bun run test:run -- tests/runtime/kernel/tools/codex-tools.test.ts
bun run electron:typecheck
```

For lifecycle hook changes, add focused tests under `desktop/tests/runtime/extensions/` or `desktop/tests/runtime/kernel/extensions/` and run:

```bash
bun run test:run -- runtime/extensions/<extension-or-hook>.test.ts
bun run check:boundary
```

For loader or agent prompt changes, also search for direct factory references:

```bash
rg -n "loadExtensions|registerAgent|registerTool|registerProvider|registerPrompt|create[A-Za-z]+Tool" runtime desktop backend
```

Do not add compatibility shims unless the user explicitly asks for them. Stella has no live production users yet.
