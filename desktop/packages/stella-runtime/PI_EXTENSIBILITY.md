# Pi Extensibility Reference (Stella Runtime)

## Purpose
This document is a complete capability map for extensibility in `frontend/packages/stella-runtime`.
It is written for coding agents that need to extend behavior safely and intentionally.

It covers two layers:

1. Pi core extensibility (vendored `coding-agent` extension system)
2. Stella host extensibility (local runtime, tools, manifests, safety, multi-agent orchestration)

---

## Extensibility Layers At A Glance

| Layer | What it extends | Typical mechanism |
| --- | --- | --- |
| Pi core | Agent lifecycle, tool system, commands, UI, model/provider routing | `pi.on(...)`, `pi.registerTool(...)`, `pi.registerCommand(...)`, `pi.registerProvider(...)` |
| Stella host | Device tools, skills/agents from `~/.stella`, self-mod workflows, local task orchestration | Tool handlers, local manifest parsing, task manager, runtime router |

Use Pi core when you need generic extension behavior.
Use Stella host when you need Stella-specific device/runtime behavior.

---

## 1) Pi Core Extensibility

### 1.1 Resource Discovery And Loading
Pi can load resources from:

- Auto-discovered global and project directories
- Explicit extension/resource paths
- Package sources (npm/git/local package roots)
- Runtime-discovered paths from extensions

Extensions can add resource paths via `resources_discover`:

- `skillPaths`
- `promptPaths`
- `themePaths`

This hook runs on startup and on reload.

### 1.2 Full Event Surface
Pi exposes these event families:

- Resource lifecycle:
  - `resources_discover`
- Session lifecycle:
  - `session_start`
  - `session_before_switch` (cancelable)
  - `session_switch`
  - `session_before_fork` (cancelable)
  - `session_fork`
  - `session_before_compact` (cancelable, can return custom compaction)
  - `session_compact`
  - `session_before_tree` (cancelable, can return custom summary/instructions/label)
  - `session_tree`
  - `session_shutdown`
- Agent lifecycle:
  - `context` (can replace LLM message array)
  - `before_agent_start` (can inject message and/or override system prompt)
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
  - `model_select`
- Interception hooks:
  - `tool_call` (can block)
  - `tool_result` (can patch `content`, `details`, `isError`)
  - `user_bash` (can override operations/result)
  - `input` (can `continue`, `transform`, or fully `handled`)

### 1.3 Event Execution Semantics

- Handlers run in extension load order.
- `session_before_*` hooks can short-circuit by canceling.
- `tool_result` behaves like middleware: each handler sees prior modifications.
- `input` chains transformations until a handler returns `handled`.
- Extension errors are reported via extension error channel and runtime continues where possible.
- `tool_call` interception is fail-safe in wrapper flow: failures block tool execution.

### 1.4 Extension API Methods
Core extension API supports:

- Event subscription: `pi.on(...)`
- Tool registration: `pi.registerTool(...)`
- Command registration: `pi.registerCommand(...)`
- Shortcut registration: `pi.registerShortcut(...)`
- Flag registration and reads: `pi.registerFlag(...)`, `pi.getFlag(...)`
- Message rendering: `pi.registerMessageRenderer(...)`
- Message send APIs:
  - `pi.sendMessage(...)`
  - `pi.sendUserMessage(...)`
  - `pi.appendEntry(...)`
- Session metadata:
  - `pi.setSessionName(...)`
  - `pi.getSessionName()`
  - `pi.setLabel(...)`
- Runtime control/query:
  - `pi.exec(...)`
  - `pi.getActiveTools()`
  - `pi.getAllTools()`
  - `pi.setActiveTools(...)`
  - `pi.getCommands()`
- Model control:
  - `pi.setModel(...)`
  - `pi.getThinkingLevel()`
  - `pi.setThinkingLevel(...)`
- Provider/model registry mutation:
  - `pi.registerProvider(...)`
  - `pi.unregisterProvider(...)`
- Shared extension event bus:
  - `pi.events.emit(...)`
  - `pi.events.on(...)`

### 1.5 Tool Extensibility
Pi tool extensibility includes:

- Registering new LLM-callable tools
- Overriding built-ins by registering the same name
- Intercepting any tool call/result (`tool_call`, `tool_result`)
- Custom tool call/result renderers in interactive mode
- Running with no built-in tools if desired

Built-in tools commonly overridden in examples: `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`.

### 1.6 Input And Command Pipeline
Prompt processing order is:

1. Extension commands (immediate execution)
2. `input` event interception
3. Skill command and prompt-template expansion
4. Agent turn execution

During streaming, user messages are queueable as steer or follow-up messages.
Queued delivery intentionally rejects extension-command execution in that path.

### 1.7 UI Extensibility (`ctx.ui`)
UI surface includes:

- Dialogs: `select`, `confirm`, `input`, `editor`
- Notifications/status:
  - `notify`
  - `setStatus`
  - `setWorkingMessage`
- Layout/widgets:
  - `setWidget`
  - `setFooter`
  - `setHeader`
  - `setTitle`
- Editor control:
  - `pasteToEditor`
  - `setEditorText`
  - `getEditorText`
  - `setEditorComponent`
- Custom components:
  - `custom(...)` (including overlay mode/options)
- Theme control:
  - `theme`
  - `getAllThemes`
  - `getTheme`
  - `setTheme`
- Tool output expansion controls:
  - `getToolsExpanded`
  - `setToolsExpanded`

Mode caveat:

- Interactive mode: full UI
- RPC mode: UI methods mapped to protocol messages where supported
- Print/JSON-like non-interactive modes: UI is unavailable/no-op; check `ctx.hasUI`

### 1.8 Session And Compaction Extensibility
Pi allows deep session behavior customization:

- Canceling and controlling session switch/fork/tree navigation
- Custom compaction output via `session_before_compact`
- Custom tree summary output via `session_before_tree`
- Programmatic compaction trigger via `ctx.compact(...)`
- Reloading extensions/resources at runtime (`ctx.reload()` or `/reload`)

### 1.9 Model And Provider Extensibility
Pi supports dynamic provider/model mutation:

- Register a new provider and models
- Override existing provider base URL/settings
- Register OAuth-backed providers
- Unregister providers and restore overridden built-ins

Behavior:

- During initial load, provider registrations are queued
- After runtime binding, provider mutations apply immediately

### 1.10 What Pi Does Not Expose As A Single API
There is no dedicated `registerMode(...)` API.
Mode-like behavior is composed through hooks, commands, UI, and tool control.

---

## 2) Stella Host Extensibility (This Repository)

### 2.1 Host Runner Surface
Stella wraps Pi with a host runner that adds:

- Runtime lifecycle (`start`, `stop`)
- Health checking
- Local chat run start/cancel
- Tool execution delegation
- Shell lifecycle control
- Local persistence and memory wiring

### 2.2 Dynamic Skills And Agents From `~/.stella`
At startup, Stella loads:

- Skills from `~/.stella/skills/*/SKILL.md`
- Agents from `~/.stella/agents/*/AGENT.md`

Skill parsing supports:

- Frontmatter
- Optional sidecar `stella.yaml` with precedence
- Metadata such as:
  - `id`, `name`, `description`, `agentTypes`, `version`, `enabled`
  - `toolsAllowlist`, `tags`, `execution`, `publicIntegration`
  - `requiresSecrets`, `secretMounts`

Agent parsing supports:

- `systemPrompt`
- `agentTypes`
- `toolsAllowlist`
- `defaultSkills`
- `model`
- `maxTaskDepth`

### 2.3 Stella Tool Host Modules
Stella composes a modular tool host:

- File tools: `Read`, `Write`, `Edit`
- Search tools: `Glob`, `Grep`
- Shell tools: `OpenApp`, `Bash`, `KillShell`, `ShellStatus`, `SkillBash`
- State/task tools: `Task`, `TaskCreate`, `TaskCancel`, `TaskOutput`
- User tools: `AskUserQuestion`, `RequestCredential`
- Self-mod recovery is Git-based via Electron IPC (`selfmod:*`), not dedicated device tools
- Package/store tool: `ManagePackage`
- Placeholder media tool: `MediaGenerate` (not configured)

### 2.4 Local Tool Overrides In Pi Runtime Path
Inside Stella runtime tool creation, Stella locally overrides:

- `WebFetch`
- `ActivateSkill`
- `NoResponse`
- `SaveMemory`
- `RecallMemories`

These bypass backend passthrough and run in local runtime.

### 2.5 Multi-Agent Task Extensibility
Stella local task manager adds:

- Task queueing with concurrency limits
- Task create/get/cancel APIs
- Bi-directional task messaging:
  - orchestrator to sub-agent
  - sub-agent to orchestrator
- Inbox draining by recipient
- FS conflict locks across write/edit/shell paths
- Per-task context, thread, and system prompt override support

### 2.6 Engine Routing Extensibility
Sub-agent execution can route by preferences/model:

- Default Pi agent runtime path
- Local Codex app-server runtime
- Local Claude Code runtime

General-agent preferences include:

- Selected engine (`default`, `codex_local`, `claude_code_local`)
- Concurrency for Codex local engine

### 2.7 Local-First Storage Extensibility
Runtime persistence includes:

- Thread messages
- Run event streams
- Memory entries (save + recall)

Storage shape:

- JSONL files as source log
- SQLite index for efficient reads where available
- Fallback to JSONL reads when index is unavailable/out-of-sync

### 2.8 Self-Modification Extensibility
Stella file tools write directly to disk. Self-mod provenance and revert are handled through Git:

- Writes/edits in frontend source paths can be staged per feature
- Active feature tracking and auto-feature creation
- Revert by batch history
- Package feature into blueprint payload for reuse/deployment

### 2.9 Local Package Management Extensibility
`ManagePackage` supports:

- Install:
  - skill
  - theme
  - canvas/mini-app
- Uninstall:
  - skill
  - theme
  - canvas
  - mod (returns requires-revert guidance)

### 2.10 Secrets And Credential Flow
Skill runtime supports secret mounts:

- Environment variable mounts
- Secret file mounts

Resolution flow:

1. Attempt secret resolve by provider
2. If missing and credential request UI exists, request credential
3. Retry resolution and inject into shell execution context

### 2.11 Safety Extensibility Layer
Stella adds practical safety controls around extensibility:

- Dangerous command rejection for shell tools
- Blocked system-directory path guards for file/search tools
- Deferred delete wrappers for destructive shell operations
  - Intercepts `rm`, `rmdir`, `unlink`, PowerShell delete forms, and Python delete patterns
  - Moves targets to Stella trash with retention-based purge
- Shell wrappers apply on both Windows and Unix-like shells

### 2.12 Cross-Platform Behavior (Important)
Current host behavior includes:

- Windows shell execution via Git Bash for consistent command behavior
- App launching:
  - Windows: `cmd /c start`
  - macOS: `open -a`
  - Linux fallback: direct launch or `xdg-open`
- Safety path guards include both Unix system dirs and Windows system dirs

---

## 3) Practical Extension Paths For Another Agent

### Path A: Add/modify a Pi extension
Choose this when you need lifecycle hooks, command/UI augmentation, or tool interception without changing Stella tool host internals.

### Path B: Add/modify Stella device tools
Choose this when you need new local capabilities (filesystem, shell, app launch, package/install, task orchestration behavior).

### Path C: Add/modify skill or agent manifests
Choose this for behavior shaping via prompts/instructions, tool allowlists, model defaults, and secret requirements.

### Path D: Add model/provider behavior
Choose this for provider routing, custom APIs, OAuth providers, or model catalog overrides.

### Path E: Add orchestration engine routing
Choose this when introducing a new local execution backend analogous to current local Codex/Claude runtimes.

---

## 4) Guardrails For Safe Extensions

- Treat all extensions as full-permission code.
- Prefer explicit allowlists for tools in agent definitions.
- Keep safety gates in place for destructive command and path operations.
- Ensure long-running/background tasks are cancelable.
- Use truncation and concise result payloads to protect model context.
- Validate cross-platform behavior for Windows and macOS command paths.

---

## 5) Quick Reference Checklist

Before shipping any extensibility change, verify:

- Hook ordering assumptions are explicit.
- Cancel/override behavior is intentional for `session_before_*`, `tool_call`, `tool_result`, `input`.
- Non-interactive mode behavior is handled (`ctx.hasUI` checks).
- Reload behavior is supported where dynamic updates are expected.
- Tool outputs are bounded and actionable.
- Safety controls still apply after your changes.
- Multi-agent task queueing and cancellation still work under concurrency.

---

This is the complete extensibility surface currently present in the Stella runtime used by the app.

