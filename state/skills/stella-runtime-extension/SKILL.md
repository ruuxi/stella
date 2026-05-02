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
- `agent_end`
- `turn_start`
- `turn_end`
- `before_compact`
- `before_provider_request`

Providers implement `ProviderDefinition` from `runtime/kernel/extensions/types.ts`. Use providers only when adding a real model backend or compatibility layer; routine model defaults usually belong in backend model config instead.

## Prompt Changes

Agent prompts live in `runtime/extensions/stella-runtime/agents/*.md`. Keep prompt changes small and outcome-first. Do not add tool schema reference sections; tool schemas are already attached by the runtime.

General-agent prompts should stay lean. Move detailed reusable procedure into `state/skills/<skill-id>/SKILL.md` and have the prompt point to the skill by name.

## Validation

Run the narrowest relevant checks:

```bash
bun test desktop/tests/runtime/kernel/tools/codex-tools.test.ts
bun run --cwd desktop electron:typecheck
```

For loader or agent prompt changes, also search for direct factory references:

```bash
rg -n "loadExtensions|registerAgent|registerTool|registerProvider|registerPrompt|create[A-Za-z]+Tool" runtime desktop backend
```

Do not add compatibility shims unless the user explicitly asks for them. Stella has no live production users yet.
