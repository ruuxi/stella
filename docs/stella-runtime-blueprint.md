# Stella Runtime Blueprint

## Status

Implemented in repo on 2026-03-21.

This document now describes the production runtime architecture that was actually
cut into `stella-monorepo`, along with the one meaningful deviation from the
original target plan.

This document is intentionally opinionated:

- No legacy compatibility is required.
- No fallback to the current in-process runtime is required.
- No in-process dual-runtime path should survive the final cutover.

The goal is to replace the current Electron-owned runtime with a production-ready architecture that:

- keeps Electron focused on native host concerns
- lets Stella modify most of its own capabilities without restarting the app window
- uses a versioned protocol as the primary contract
- uses a `pi`-style composition model inside the runtime without turning "plugins" into a product feature

### Implementation Summary

- Electron main is now a host kernel backed by `desktop/packages/stella-runtime-client`.
- Runtime execution now flows through `desktop/packages/stella-runtime-daemon` and `desktop/packages/stella-runtime-worker`.
- Commands now load through `desktop/packages/stella-runtime-capabilities`, including bundled markdown commands and a built-in `stella-ui` capability command.
- Electron bootstrap no longer owns chat, scheduler, social-session, store-mod, or runtime-store lifecycles.

### Implemented Adjustment

The original blueprint targeted daemon-owned durable runtime state.

The shipped architecture instead gives durable runtime state ownership to the
worker while keeping it fully out of Electron main.

That adjustment was intentional:

- the current runner and store layer still rely on synchronous in-process access
- moving ownership straight into the daemon would have forced a much larger runner rewrite
- the worker still gives Stella a single runtime-state owner outside Electron
- the daemon still owns supervision, worker generations, config propagation, CLI socket/token service, and buffered run-event resume state

## References

### Stella current architecture

- `desktop/electron/bootstrap/runtime.ts`
- `desktop/electron/bootstrap/ipc.ts`
- `desktop/electron/bootstrap/context.ts`
- `desktop/electron/stella-host-runner.ts`
- `desktop/electron/core/runtime/**`
- `desktop/electron/core/runtime/extensions/**`

### Codex reference

- `../codex/codex-rs/app-server/README.md`
- `../codex/codex-rs/app-server-client/README.md`
- `../codex/codex-rs/app-server/src/in_process.rs`
- `../codex/codex-rs/app-server/src/transport.rs`
- `../codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

### pi-mono reference

- `../pi-mono/packages/coding-agent/docs/extensions.md`
- `../pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `../pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `../pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `../pi-mono/packages/coding-agent/src/core/event-bus.ts`
- `../pi-mono/packages/coding-agent/src/core/session-manager.ts`

## Decision Summary

Stella will use a four-layer desktop architecture:

1. Electron host kernel
2. Runtime daemon
3. Runtime worker
4. Runtime capability modules

Electron remains the native host.

The daemon remains the stable protocol endpoint and supervisor.

The worker remains the mutable execution engine.

Capability modules hold most AI-editable behavior:

- commands
- tools
- hooks
- providers
- prompts
- resource roots

Most self-modification should land in capability modules or renderer code, not in Electron host code and not in runtime kernel code.

## Non-Goals

- Preserve the old in-process `stellaHostRunner` implementation.
- Keep the current IPC surface as the primary internal API.
- Let arbitrary application code hot-patch itself in Electron main.
- Turn extensions/plugins into a user-facing marketplace concept.
- Build compatibility bridges for old runtime state or old method shapes.

## Core Principles

- Protocol-first boundaries beat in-process imports.
- Electron is a host kernel, not an agent runtime container.
- Mutable capability code belongs behind registries.
- Reload by swapping workers, not by mutating long-lived Node state in place.
- Host-enforced approvals stay in the host.
- One subsystem owns each durable state domain.

## Topology

```text
Renderer (React/Vite)
  |
  | preload bridge
  v
Electron Main / Host Kernel
  |
  | bidirectional JSON-RPC over stdio JSONL
  v
Runtime Daemon
  |
  | internal child-process JSON-RPC
  v
Runtime Worker
  |
  | registry-based loading
  v
Capability Modules
```

## Why Two Runtime Layers

The daemon and worker should be separate.

If Stella edits capability code, the worker can be replaced without losing the main daemon connection.

That gives Stella a stable protocol endpoint even while its execution engine changes.

The daemon owns:

- client connection lifecycle
- request routing
- request ids and correlation ids
- worker supervision
- generation management
- reload orchestration
- health and lag reporting
- runtime config propagation
- buffered run-event resume state
- CLI socket/token serving

The worker owns:

- durable runtime state ownership
- orchestrator execution
- tool execution
- command execution
- prompt assembly
- provider dispatch
- hook execution
- capability registration

## Package Layout

Create the following packages under `desktop/packages/`:

- `stella-runtime-protocol`
- `stella-runtime-client`
- `stella-runtime-daemon`
- `stella-runtime-worker`
- `stella-runtime-capabilities`
- `stella-runtime-cli`

### stella-runtime-protocol

Single source of truth for:

- request and response types
- notification types
- server-request types
- error codes
- protocol versions
- schema export

Export generated TypeScript schema artifacts from this package.

### stella-runtime-client

Lives in Electron main.

Responsibilities:

- spawn daemon
- perform initialize handshake
- keep one active connection
- map request ids
- reconnect only if daemon dies
- proxy runtime notifications to renderer and mobile surfaces
- expose host request handlers back to daemon

### stella-runtime-daemon

Stable runtime endpoint.

Responsibilities:

- serve JSON-RPC
- own stores for conversations, runs, tasks, command state, self-mod state
- supervise worker generations
- reload or restart workers
- multiplex events to connected consumers
- translate worker host requests to Electron host requests

### stella-runtime-worker

Mutable execution engine.

Responsibilities:

- execute runs and tasks
- load capability modules
- maintain registries
- emit run and tool events
- request host actions
- stay disposable

### stella-runtime-capabilities

Contains the capability runtime API and registries.

Suggested internal folders:

- `commands/`
- `tools/`
- `hooks/`
- `providers/`
- `prompts/`
- `resources/`
- `state/`
- `loader/`
- `api/`

### stella-runtime-cli

Holds the thin CLI shims.

Responsibilities:

- `stella` dynamic command dispatch
- `stella-ui` command family if kept as a separate UX surface
- connect to daemon, not to Electron implementation details

## Electron Host Kernel

Electron main keeps only capabilities that truly require the live app process or native APIs.

Keep in Electron:

- window creation and management
- overlay windows
- `webContents` control
- preload bridge
- screen capture and region capture
- native dialogs
- auth deep links and protocol handlers
- notifications
- shortcuts and native input hooks
- privileged approvals
- credential prompts
- trusted external-link policy

Move out of Electron:

- agent orchestration
- command registry
- tool registry
- provider registry
- prompt registry
- shell and file tools
- most scheduling logic
- most project/dev orchestration
- self-mod execution logic
- conversation/run/task state management

## Host Request Surface

Use bidirectional JSON-RPC.

Electron calls runtime methods.

Runtime sends host requests back over the same connection.

Do not build a second ad-hoc IPC contract beside the protocol package.

Suggested host request namespaces:

- `host.window.*`
- `host.overlay.*`
- `host.ui.*`
- `host.capture.*`
- `host.notification.*`
- `host.auth.*`
- `host.credentials.*`
- `host.system.*`
- `host.shortcuts.*`
- `host.project.*`

Examples:

- `host.window.show`
- `host.window.focus`
- `host.ui.snapshot`
- `host.ui.act`
- `host.capture.screen`
- `host.capture.region`
- `host.notification.show`
- `host.system.openExternal`
- `host.credentials.request`

All approval and privileged action enforcement stays in Electron main.

The worker may request.

The host decides.

## Protocol

Use JSON-RPC 2.0 with `"jsonrpc":"2.0"` omitted on the wire, matching the Codex pattern.

### Primary transport

Bidirectional stdio with newline-delimited JSON.

This is the required production transport.

### Secondary transport

WebSocket may exist for dev tooling or test harnesses.

It must not be the primary production contract.

### Initialization

Every connection must begin with:

- `initialize`
- `initialized`

The initialize payload should include:

- client name
- client version
- platform metadata
- capability flags
- protocol version

### Protocol versioning

Start with `v1/` namespaces in the protocol package.

Do not publish unversioned method enums.

### Backpressure

Use bounded channels throughout the stack.

When ingress is saturated, return an explicit overload error.

When event consumers lag, emit `runtime/lagged`.

Never silently drop terminal events.

### Required terminal notifications

- `run/completed`
- `run/failed`
- `run/canceled`
- `command/completed`
- `runtime/reloading`
- `runtime/ready`
- `approval/requested`

## Runtime API Groups

Suggested client-to-runtime method groups:

- `runtime.health`
- `runtime.reloadCapabilities`
- `runtime.restartWorker`
- `conversation.list`
- `conversation.read`
- `conversation.create`
- `conversation.rename`
- `run.start`
- `run.cancel`
- `run.resumeEvents`
- `task.read`
- `task.cancel`
- `command.list`
- `command.run`
- `capability.list`
- `capability.read`

Suggested runtime notifications:

- `runtime.ready`
- `runtime.reloading`
- `runtime.lagged`
- `conversation.updated`
- `run.event`
- `command.outputDelta`
- `capability.changed`
- `approval.requested`

## Capability Runtime

This is the key `pi`-inspired adjustment.

Do not think of this as a plugin marketplace.

Think of it as Stella's internal composition model for AI-editable code.

### Capability API

Create a typed `CapabilityAPI` exposed to capability modules.

It should support:

- `on(event, handler)`
- `registerTool(definition)`
- `registerCommand(name, definition)`
- `registerProvider(name, definition)`
- `registerPrompt(name, definition)`
- `registerResourceRoots(definition)`
- `events.on`
- `events.emit`
- `state.get`
- `state.set`
- `state.appendEvent`
- `context.appendMessage`
- `context.sendFollowUp`

### Lifecycle model

Borrow the `pi` bind pattern:

- load modules first
- collect registrations
- bind runtime actions after registries exist
- only then allow immediate mutation APIs to take effect

This avoids bootstrap ordering bugs and keeps registries deterministic.

### Capability module types

Supported module families:

- command modules
- tool modules
- hook modules
- provider modules
- prompt modules
- resource modules

Resource modules can contribute:

- extra skill roots
- extra prompt roots
- extra agent roots
- extra capability roots

### Internal event model

Use a richer event surface than Stella's current `HookEmitter`.

Suggested events:

- `runtime_start`
- `runtime_shutdown`
- `resources_discover`
- `conversation_start`
- `before_run`
- `before_agent_start`
- `before_provider_request`
- `turn_start`
- `turn_end`
- `tool_call`
- `tool_result`
- `command_start`
- `command_end`
- `before_compact`

### Capability state

Borrow the spirit of `pi`'s custom session entries, but use a cleaner Stella-specific store.

Provide namespaced durable state:

- `module_id`
- `scope`
- `entity_id`
- `key`
- `json_value`

Recommended scopes:

- `global`
- `conversation`
- `run`
- `task`

Do not require capability modules to invent their own persistence format in random files.

## Command Model

Commands are runtime modules.

They are not Electron features.

Every command should expose:

- id
- description
- argument schema or parser
- source path
- capability requirements
- execute handler

The runtime must support:

- list commands
- execute command
- inspect command source path
- autocomplete metadata

The AI can add and remove commands by editing capability modules and reloading the worker.

No Electron changes should be required for ordinary command creation.

## stella-ui Redesign

`stella-ui` should stop being implemented as a custom Electron command surface.

Keep only a generic host UI automation bridge:

- `host.ui.snapshot`
- `host.ui.act`
- `host.ui.observe`

Move the higher-level `stella-ui` behavior to runtime command modules inside `stella-runtime-cli` and `stella-runtime-capabilities`.

This means:

- `snapshot`
- `click`
- `fill`
- `select`
- `generate`

are runtime concerns built on host primitives, not Electron-owned behaviors.

## Storage Ownership

One subsystem owns each state domain.

### Runtime worker owns

- conversations
- run streams and buffers
- tasks
- command history
- self-mod run metadata
- capability state
- runtime thread history
- scheduler state
- social-session state

### Runtime daemon owns

- worker generations
- runtime config snapshot
- buffered run-event resume state
- CLI socket/token state

### Electron host owns

- UI state
- window state
- overlay state
- auth and native OS state
- approval UI state

Do not let both main and worker write the same runtime database.

## Reload and Restart Tiers

Use four explicit tiers:

1. Renderer reload
2. Capability reload
3. Worker restart
4. Host restart

### Renderer reload

Used for `desktop/src/**` changes.

Handled by Vite HMR.

### Capability reload

Used for changes to command, tool, hook, provider, prompt, or resource modules.

Implementation:

- daemon starts a fresh worker generation
- new generation loads registries
- daemon health-checks it
- daemon swaps active generation
- future runs use new generation

Do not unload modules in place.

### Worker restart

Used for deeper runtime engine changes.

Still keeps Electron alive.

### Host restart

Used only for actual Electron host kernel changes.

## Build and Packaging

Use compiled JS artifacts for daemon and worker in production.

Suggested outputs:

- `dist-runtime-protocol/`
- `dist-runtime-client/`
- `dist-runtime-daemon/`
- `dist-runtime-worker/`
- `dist-runtime-cli/`

If Stella is later packaged, AI-editable runtime code must live in a writable workspace outside the packaged app bundle.

Do not rely on `asar` contents for self-modifiable code.

## Current File Ownership Map

### Keep and slim in Electron

- `desktop/electron/bootstrap/lifecycle.ts`
- `desktop/electron/bootstrap/context.ts`
- `desktop/electron/bootstrap/ipc.ts`
- `desktop/electron/windows/**`
- `desktop/electron/preload.ts`
- `desktop/electron/services/auth-service.ts`
- `desktop/electron/services/capture-service.ts`
- `desktop/electron/services/credential-service.ts`
- `desktop/electron/services/external-link-service.ts`
- `desktop/electron/services/security-policy-service.ts`
- `desktop/electron/services/ui-state-service.ts`

### Remove from Electron ownership and relocate

- `desktop/electron/stella-host-runner.ts`
- `desktop/electron/core/runtime/**`
- `desktop/electron/system/stella-ui-cli.mjs`
- `desktop/electron/system/stella-ui-server.ts` except the minimal host-side bridge pieces
- `desktop/electron/services/dev-project-service.ts`
- `desktop/electron/services/local-scheduler-service.ts`
- `desktop/electron/services/social-session-service.ts`

### Replace entirely

- `desktop/electron/core/runtime/extensions/loader.ts`
- `desktop/electron/core/runtime/extensions/hook-emitter.ts`
- `desktop/electron/core/runtime/extensions/types.ts`

These are useful prototypes, but not sufficient as the final capability runtime.

## Mobile Bridge

The current mobile bridge should not continue to piggyback on Electron IPC registrations.

In the target architecture, mobile should speak to the runtime daemon protocol or a daemon-owned adapter.

Do not make `ipcMain` registration capture the system of record for remote clients.

## Testing Strategy

### Protocol tests

- schema generation tests
- method compatibility tests
- error envelope tests
- initialize handshake tests

### Daemon tests

- worker supervision
- reload behavior
- overload behavior
- lagged consumer behavior
- terminal event delivery

### Worker tests

- capability loader tests
- registration conflict tests
- command listing and execution
- tool and hook interception
- provider registration

### Host integration tests

- host request routing
- approval enforcement
- credential prompts
- UI snapshot and action requests

### End-to-end tests

- renderer self-mod with no worker restart
- command module self-mod with worker swap only
- runtime engine self-mod with worker restart only
- host kernel change requiring Electron restart

## Cutover Phases

### Phase 1 - Completed

- Added `desktop/packages/stella-runtime-protocol/**` and `desktop/packages/stella-runtime-client/**`.
- Added JSON-RPC peer + JSONL transport helpers and a supervised Electron-side runtime client.
- Evidence:
  - `desktop/packages/stella-runtime-protocol/src/index.ts`
  - `desktop/packages/stella-runtime-protocol/src/rpc-peer.ts`
  - `desktop/packages/stella-runtime-client/src/index.ts`

### Phase 2 - Completed

- Added the daemon and worker sidecar processes.
- The daemon now supervises worker generations, forwards RPC, buffers run events, and exposes the CLI socket/token bridge.
- Evidence:
  - `desktop/packages/stella-runtime-daemon/src/server.ts`
  - `desktop/packages/stella-runtime-worker/src/server.ts`
  - `desktop/packages/stella-runtime-worker/src/entry.ts`

### Phase 3 - Completed With Design Adjustment

- Runtime state ownership moved out of Electron and into the worker.
- Electron bootstrap no longer creates or owns chat/runtime/store/scheduler/social-session services.
- Adjustment from the original target:
  - durable state lives in the worker rather than the daemon to preserve the current synchronous runner/store contracts
- Evidence:
  - `desktop/electron/bootstrap/runtime.ts`
  - `desktop/electron/bootstrap/context.ts`
  - `desktop/packages/stella-runtime-worker/src/server.ts`

### Phase 4 - Completed

- Electron now talks to the sidecar through the runtime client adapter.
- Main-process IPC handlers now proxy local chat, schedule, store, system, and agent flows into the runtime sidecar.
- Evidence:
  - `desktop/electron/runtime-client-adapter.ts`
  - `desktop/electron/bootstrap/ipc.ts`
  - `desktop/electron/ipc/local-chat-handlers.ts`
  - `desktop/electron/ipc/schedule-handlers.ts`
  - `desktop/electron/ipc/store-handlers.ts`
  - `desktop/electron/ipc/system-handlers.ts`

### Phase 5 - Completed

- Introduced the capability runtime, capability state tables, bundled markdown command loading, and runtime command execution.
- Commands can now be added through capability modules and markdown command roots without changing Electron.
- Evidence:
  - `desktop/packages/stella-runtime-capabilities/src/runtime.ts`
  - `desktop/packages/stella-runtime-capabilities/src/markdown-commands.ts`
  - `desktop/packages/stella-runtime-capabilities/src/types.ts`

### Phase 6 - Completed

- Rebuilt `stella-ui` as runtime capability logic on top of `host.ui.snapshot`, `host.ui.observe`, and `host.ui.act`.
- Deleted the old Electron-owned `stella-ui` server and CLI.
- Evidence:
  - `desktop/packages/stella-runtime-capabilities/src/commands/stella-ui.ts`
  - `desktop/packages/stella-runtime-cli/src/stella-ui.ts`
  - deleted `desktop/electron/system/stella-ui-server.ts`
  - deleted `desktop/electron/system/stella-ui-cli.mjs`

### Phase 7 - Completed

- Electron no longer instantiates the in-process runtime.
- The only production execution path is:
  - Electron host kernel
  - runtime client
  - runtime daemon
  - runtime worker
  - capability modules
- Note:
  - `desktop/electron/stella-host-runner.ts` remains as a thin naming shim over the runtime client factory, not as an alternate runtime path

### Phase 8 - Completed

- Hardened the sidecar seam after an independent regression review.
- The runtime client now replays cached configuration after daemon respawn.
- The daemon now forwards worker host requests back to Electron for credentials, UI automation, display updates, window control, and HMR transitions.
- Worker task lifecycle notifications now use monotonic synthetic sequence numbers instead of wall-clock timestamps, avoiding dropped events during fast transitions.
- Self-mod HMR resume is restored through an explicit host-transition handshake between Electron, daemon, and worker.
- Schedule update broadcasts are restored end-to-end from the worker scheduler through the daemon and client back to Electron windows/mobile surfaces.
- Runtime configuration propagation now includes `convexSiteUrl`, not just `convexUrl`, auth token, and cloud-sync state.
- Local chat IPC now waits for the sidecar-backed runtime to become ready during cold start instead of failing the first bootstrap request.
- Electron now registers the host HMR transition callback for sidecar self-mod runs, so renderer HMR resume is not silently skipped.
- Reset and hard-reset flows now await sidecar shutdown before starting replacement runtime processes.
- Evidence:
  - `desktop/packages/stella-runtime-client/src/index.ts`
  - `desktop/packages/stella-runtime-daemon/src/server.ts`
  - `desktop/packages/stella-runtime-worker/src/server.ts`
  - `desktop/packages/stella-runtime-protocol/src/index.ts`
  - `desktop/electron/runtime-client-adapter.ts`

## Verification

- `npm run electron:typecheck` - passed
- `npm run test:electron` - passed (`70` test files, `206` tests passed, `1` skipped)
- Added focused regression coverage for the new runtime seam:
  - `desktop/tests/packages/stella-runtime-protocol/rpc-peer.test.ts`
  - `desktop/tests/packages/stella-runtime-capabilities/runtime.test.ts`
- Completed an independent regression review after cutover and reconciled the findings in code:
  - fixed daemon-respawn config replay
  - fixed worker-to-host request forwarding
  - fixed self-mod HMR resume bridging
  - fixed task-event sequencing under fast run transitions
  - restored schedule update notifications to the UI/mobile surfaces
  - completed `convexSiteUrl` propagation across the sidecar boundary
  - added a cold-start readiness gate for local chat bootstrap IPC
  - registered the host HMR transition callback in Electron bootstrap
  - awaited daemon/worker shutdown during reset-driven runtime replacement

## Additional Work Completed Outside Original Scope

- Removed dead Electron bootstrap state for the old runtime-owned stores and services.
- Restored runtime-driven `killAllShells` shutdown cleanup so background shells do not depend on worker-process exit semantics.
- Updated stale tests to current runtime behavior for local CLI working-directory selection and relative file-path handling.
- Kept Electron dev rebuilds fast by classifying worker/capability changes into worker reloads or daemon restarts instead of full Electron restarts.

## Acceptance Criteria

The architecture is complete when all of the following are true:

- Editing most runtime behavior does not restart the Electron app window.
- Adding or removing a Stella command does not require changing Electron code.
- `stella-ui` is implemented as runtime logic over generic host UI primitives.
- Runtime reloads preserve the Electron connection and visible UI state.
- Only native host changes require Electron restart.
- Protocol types are versioned and generated from one source of truth.
- Runtime state has a single owner outside Electron main.
- Electron no longer owns an in-process runtime execution path.

## Final Recommendation

Use Codex as the transport and protocol reference.

Use `pi-mono` as the runtime composition reference.

For Stella, the winning combination is:

- Codex-style app-server boundary
- pi-style internal capability registration
- Electron as a host kernel only
- worker swap instead of in-place Node teardown

That is the production-ready architecture for a desktop assistant that can modify most of its own capabilities live.

## Post-Implementation Fixes

- Restored schedule update broadcasts so dashboard and conversation schedule views refresh without reopening the app.
- Completed `convexSiteUrl` propagation across the Electron host, runtime client, daemon, and worker boundary.
- Added cold-start connectivity gates for local chat, schedule, and store IPC so first-render requests wait for the sidecar process without requiring full orchestrator/auth readiness.
- Registered the Electron host HMR transition callback for self-mod flows so renderer HMR resume is not silently skipped.
- Awaited sidecar shutdown during reset and hard-reset flows so replacement runtimes do not race stale daemon/worker processes.
- Preserved `rootRunId` when translating task lifecycle events back through the runtime client adapter.
- Swallowed transient sidecar disconnect failures in background adapter polling so health and active-run checks degrade to not-ready/null instead of leaking unhandled promise rejections.
- Split adapter event deduplication into separate run-event and task-event sequence lanes so task lifecycle updates are not dropped when their synthetic sequence overlaps with stream/tool events.
- Restored self-mod HMR progress state propagation through the host transition path so applying/reloading/idle updates continue to reach `agent:selfModHmrState` listeners during sidecar-driven morphs.
- Made `socialSessions:getStatus` wait briefly for the sidecar transport and otherwise degrade to the usual stopped snapshot instead of throwing during startup races.
- Waited for in-flight social session reconciliation before claiming pending host turns so turn processing cannot outrun session-store hydration.
- Restored `localChat:updated` broadcasts for worker-owned social-session turn writes so shared-session user/assistant messages refresh desktop and mobile listeners without a manual reopen.
- Updated `electron:dev` to watch the full built desktop output and force an Electron restart when main-owned runtime packages such as `stella-runtime-client` or `stella-runtime-protocol` change.
- Moved runtime-side informational logging off stdout so the stdio JSON-RPC transport is no longer competing with normal worker startup/runtime logs.
- Hardened markdown command loading so malformed `~/.stella/commands/*.md` files are skipped per-file, logged, and no longer take down capability loading during worker startup or reload.
- Added CRLF-safe markdown frontmatter parsing so Windows-authored command metadata is preserved instead of being echoed back as command body text.
- Made the runtime CLI resolve daemon state from `STELLA_HOME` or `STELLA_ROOT` before falling back to `process.cwd()`, while still honoring explicit `STELLA_UI_*` overrides.
- Restored immediate Electron window launch, but moved runtime readiness gating into the renderer so returning users now see a global `Preparing Stella...` state until the sidecar-backed host runner is ready.
- Kept the cold-start UX fix in place for slow sidecar startup by showing the renderer startup shell immediately instead of blocking the whole Electron window on runtime readiness.
- Added background host-runner retry during app startup so a failed first sidecar init attempt can recover without leaving the window stranded on a dead runtime.
- Restored authoritative `agent:healthCheck` and `agent:getActiveRun` reads by awaiting fresh sidecar state instead of returning stale cached adapter snapshots.
- Extracted the duplicated IPC-side runtime readiness poll loop into `desktop/electron/ipc/runtime-availability.ts` so local chat, schedule, store, and social-session startup checks use one shared connection gate.
- Normalized the local chat handler indentation while touching the shared runtime-availability path so the file is back to formatter-consistent structure.
- Split bootstrap shutdown semantics into explicit awaited vs fire-and-forget paths by keeping `shutdownBootstrapRuntime(...)` as the awaited implementation and renaming the non-awaiting wrapper to `scheduleBootstrapRuntimeShutdown(...)`.
- Moved social-session ownership fully into the worker package by relocating the service, filesystem helper, and sync store to `desktop/packages/stella-runtime-worker/src/social-sessions/`, rewiring the worker server to use them directly, and deleting the old Electron-side modules.
- Extracted shared `RuntimeActiveRun` and `RuntimeAutomationTurn*` contracts into the protocol package and adopted them across the worker social-session service, runtime client, runtime client adapter, Electron lifecycle targets, and core runner types.
- Updated dev-reload classification and regression tests so worker-owned social-session changes stay on sidecar reloads without referencing the deleted Electron-side service path.
- Changed the shared IPC runtime-availability helper to use short `waitUntilConnected(...)` attempts so cold-start local chat / schedule / store requests can recover onto a replacement runner instead of remaining pinned to a dead adapter for the full timeout.
- Restored `localChat:updated` broadcasts for busy/error shared-session turns after the user message is persisted, so shared-session conversations refresh even when the host is occupied or the automation turn fails before an assistant reply is written.
- Removed the redundant `runtimeReady` gate inside `FullShellReadySurface`, so the normal runtime-ready shell path mounts `FullShellRuntime` immediately for home/chat/social entry instead of waiting for the “New App” flow to flip a local flag.
- Added focused regression tests for the new readiness gates, HMR bridge, reset sequencing, and task event translation:
  - `desktop/tests/electron/ipc/local-chat-handlers.test.ts`
  - `desktop/tests/electron/ipc/runtime-availability.test.ts`
  - `desktop/tests/electron/ipc/schedule-handlers.test.ts`
  - `desktop/tests/electron/ipc/store-handlers.test.ts`
  - `desktop/tests/electron/ipc/system-handlers.test.ts`
  - `desktop/tests/electron/core/bootstrap-runtime.test.ts`
  - `desktop/tests/electron/core/bootstrap-resets.test.ts`
  - `desktop/tests/electron/runtime-client-adapter.test.ts`
  - `desktop/tests/renderer/app/shell/FullShellReadySurface.test.tsx`
  - `desktop/tests/packages/stella-runtime-capabilities/runtime.test.ts`
  - `desktop/tests/packages/stella-runtime-cli/shared.test.ts`
- Added exponential daemon-respawn backoff in the runtime client so crash-looping sidecars no longer restart in a tight loop, and emit explicit disconnect/reloading signals while backing off.
- Replaced the adapter/client store-release type mismatch with the shared protocol `StorePublishArgs` contract so the runtime client adapter, worker bridge, and runner store operations no longer rely on `as never` casts at that seam.
- Formalized host display updates as `{ html }` payloads across the worker -> daemon -> host boundary so the Electron host extracts real HTML instead of risking accidental object stringification.
- Removed the `RunnerPublicApi.__context` escape hatch by adding explicit public methods for active-task counting and self-mod HMR resume, then updated the worker health/HMR paths to use those supported APIs.
- Normalized worker-side event forwarding to use `{ ...ev, type }` ordering so transport-assigned event types cannot be overridden by an incoming payload field.
- Replaced the adapter's 50ms busy-wait loops with event-backed waits for runtime connection/readiness, and now emit refreshed `runtime.ready` notifications after runtime configuration changes so readiness waiters can resolve without polling.
- Added focused regression coverage for the new daemon backoff and host display update contract in `desktop/tests/packages/stella-runtime-client/index.test.ts`.
- Replaced the social-session startup fallback's string-matched transport errors with typed runtime-unavailable RPC errors, and propagated that typed availability signal through the client adapter, runtime client request path, daemon worker bridge, and IPC runtime-availability helper.
- Removed the dead `host.ui.observe` transport/API path from the protocol, Electron host handlers, worker bridge, capability host contract, and `stella-ui` command surface so only the real `snapshot` UI primitive remains.
- Updated the devtool hard-reset path to await runtime shutdown before clearing session storage and deleting `.stella`, while keeping lifecycle/app-quit shutdown on the explicit fire-and-forget path.
- Added regression coverage for the awaited devtool hard-reset sequencing in `desktop/tests/electron/devtool/dev-server.test.ts`.
- Changed runtime config propagation in the Electron adapter so pre-start `setConvexUrl` / `setAuthToken` / related updates are queued locally without issuing doomed fire-and-forget RPC calls, while started runtimes still apply patches immediately and now log configure failures instead of silently swallowing them.
- Added focused adapter regression coverage for queued pre-start config replay and post-start configure failure logging in `desktop/tests/electron/runtime-client-adapter.test.ts`.
- Moved protected device-identity access back behind the Electron host boundary by adding host RPCs for `deviceId` lookup and heartbeat signing, so the worker no longer touches `safeStorage` while running under `ELECTRON_RUN_AS_NODE`.
- Verified the secure-storage startup fix with `bun run electron:dev`: the previous `Protected storage is unavailable` sidecar crash loop no longer reproduces, and the runtime proceeds through extension load, mobile-bridge startup, and devtool connection.
- Restored error logging on the explicit fire-and-forget `scheduleBootstrapRuntimeShutdown(...)` path so quit-style shutdown failures are surfaced to logs instead of disappearing silently.
- Stabilized the `FullShell` renderer smoke coverage by preloading the lazy ready-shell modules and awaiting the mounted ready surface before assertions, so the bootstrap shell test no longer races the Suspense-loaded path.
- Normalized the daemon-to-worker trust boundary so the daemon remains the only public RPC surface: every forwarded local-chat, store-mod, schedule, social-session, and shell-by-port call now maps from a public method to an `INTERNAL_WORKER_*` worker method, and the worker no longer registers those public names directly.
- Added the dedicated `desktop/packages/stella-boundary-contracts/` package and moved the cross-boundary DTOs there, then rewired renderer, Electron, runtime client, daemon, worker, protocol, and regression tests to import those types from the shared contracts package instead of app-local `src/shared/contracts/electron-data.ts`.
- Removed the temporary `desktop/src/shared/contracts/electron-data.ts` compatibility shim entirely, so `desktop/packages/stella-boundary-contracts/src/index.ts` is now the only source of truth for those boundary contracts.
- Added the sanctioned local facade `desktop/src/shared/contracts/boundary.ts` and rewrote the repo to import boundary contracts through that barrel instead of reaching into `desktop/packages/stella-boundary-contracts/src/index.ts` directly from Electron, runtime packages, renderer code, or tests.
- Replaced IPC runtime availability polling with event-driven runner availability by teaching `RuntimeClientAdapter` to publish authoritative connection/readiness snapshots, adding runner-replacement subscriptions in bootstrap lifecycle bindings, and updating `desktop/electron/ipc/runtime-availability.ts` plus the local-chat / schedule / store / social-session handlers to wait on connection events instead of a 50ms loop.
- Updated preload typecheck wiring so `tsconfig.preload.json` points at the sanctioned boundary facade rather than explicitly including the boundary package internals.
- Added focused regression coverage for the event-driven runner-availability path and updated the existing IPC readiness tests to exercise runner-replacement notifications:
  - `desktop/tests/electron/ipc/runtime-availability.test.ts`
  - `desktop/tests/electron/ipc/local-chat-handlers.test.ts`
  - `desktop/tests/electron/ipc/schedule-handlers.test.ts`
  - `desktop/tests/electron/ipc/store-handlers.test.ts`
  - `desktop/tests/electron/ipc/system-handlers.test.ts`
- Verification:
  - `npm run electron:typecheck`
  - `npm run test:electron` -> 76 files passed, 229 tests passed, 1 skipped
