# Stella Extraction Blueprint

## Status

Implemented in repo on 2026-03-21 as the follow-on extraction after the
sidecar runtime cutover documented in `docs/stella-runtime-blueprint.md`.

This blueprint covers the remaining physical extraction work needed to make the
repo match the intended production architecture:

- `desktop/electron/**` is a host kernel only
- runtime/kernel logic no longer lives under `desktop/electron/core/**`
- runtime-owned services no longer live under `desktop/electron/services/**`
- discovery and other Node/OS collectors no longer live under `desktop/electron/system/**`

This is intentionally a strict end-state blueprint:

- no compatibility shims
- no duplicate package and Electron copies
- no permanent direct imports from `desktop/electron/core/**`
- no mixed ownership for voice, self-mod, scheduler, discovery, or dev-project runtime logic

## Purpose

The sidecar split is complete, but the codebase still has extraction debt.

Today the worker/daemon architecture exists, but important runtime code is still
physically stored under Electron paths:

- `desktop/electron/core/**`
- `desktop/electron/services/local-scheduler-service.ts`
- `desktop/electron/services/dev-project-service.ts`
- most of `desktop/electron/system/**`
- runtime-heavy portions of `desktop/electron/ipc/voice-handlers.ts`
- non-host portions of `desktop/electron/self-mod/**`

That structure is transitional, not final.

This blueprint finishes the package and ownership split so that directory
structure, import graph, dev tooling, and restart behavior all match the actual
runtime architecture.

## Decision Summary

Stella should use the following production layering:

1. Renderer UI and media runtime
2. Electron host kernel
3. Runtime client / daemon / worker sidecar stack
4. Extracted runtime packages
5. Capability modules

Electron keeps only native-host responsibilities:

- windows
- overlays
- capture
- shortcuts
- wake-word device control
- auth/session host integration
- approvals and security policy
- preload bridge
- host event fanout to renderer/mobile

Everything else moves out.

## Non-Goals

- Preserve `desktop/electron/core/**` as an accepted package root
- Keep Node/runtime services under Electron because they are already there
- Treat voice or music as indivisible subsystems that must remain in one layer
- Let Electron main resolve models, prompts, tool registries, or runner internals
- Add temporary alias files that survive the final cutover

## Core Principles

- Physical location must match ownership.
- Host code must not import runtime internals from `desktop/electron/core/**`.
- Runtime packages must expose sanctioned public entrypoints.
- Worker-owned code must be reloadable without restarting Electron.
- Cross-layer domains such as voice and self-mod must be explicitly split by concern.
- Renderer media features stay renderer-side unless a native host capability is truly required.

## Target Package Layout

Keep the existing sidecar packages:

- `desktop/packages/boundary-contracts`
- `desktop/packages/runtime-protocol`
- `desktop/packages/runtime-client`
- `desktop/packages/runtime-daemon`
- `desktop/packages/runtime-worker`
- `desktop/packages/runtime-capabilities`
- `desktop/packages/runtime-kernel/cli`

Add the following extracted packages:

- `desktop/packages/ai`
- `desktop/packages/runtime-kernel`
- `desktop/packages/runtime-discovery`

Keep these runtime-kernel subtrees as part of that package rather than as
separate top-level packages:

- `desktop/packages/runtime-kernel/agent-core`
- `desktop/packages/runtime-kernel/home`
- `desktop/packages/runtime-kernel/dev-projects`
- `desktop/packages/runtime-kernel/self-mod`
- `desktop/packages/runtime-kernel/cli`

### Package Responsibilities

#### `ai`

Source of truth for model/provider plumbing currently under
`desktop/electron/core/ai/**`.

Owns:

- provider implementations
- model registry and lookup
- stream helpers
- OAuth/provider utility code that is not Electron-specific

Must not own:

- Electron IPC
- BrowserWindow/webContents logic
- host approvals

#### `runtime-kernel/agent-core`

Source of truth for generic agent loop/types currently under
`desktop/electron/core/agent/**`.

Owns:

- agent loop
- agent definitions/types
- generic proxy helpers

Must not own:

- Electron services
- worker supervision
- app-specific host bridges

#### `runtime-kernel`

Source of truth for the runtime execution kernel currently spread across
`desktop/electron/core/runtime/**` plus worker-owned runtime services.

Owns:

- runner
- tasks
- tool registry and tool handlers
- model routing
- thread/runtime state helpers
- runtime preferences and local credentials
- scheduler service and scheduling contracts
- bundled agent/skill loading used by the worker
- dashboard generation logic

This package is the primary new home for:

- `desktop/electron/core/runtime/**`
- `desktop/electron/services/local-scheduler-service.ts`
- `desktop/electron/core/dashboard-generation.ts`

#### `runtime-discovery`

Source of truth for Node/OS discovery logic that currently lives under
`desktop/electron/system/**`.

Owns:

- browser/app/system/dev/messages/steam/music discovery
- synthesis formatting helpers
- pseudonymization helpers
- Node-only utility code used by discovery pipelines

This package is the new home for:

- `desktop/electron/system/app-discovery.ts`
- `desktop/electron/system/browser-bookmarks.ts`
- `desktop/electron/system/browser-data.ts`
- `desktop/electron/system/collect-all.ts`
- `desktop/electron/system/dev-environment.ts`
- `desktop/electron/system/dev-projects.ts`
- `desktop/electron/system/editor-state.ts`
- `desktop/electron/system/firefox-data.ts`
- `desktop/electron/system/messages-notes.ts`
- `desktop/electron/system/music-library.ts`
- `desktop/electron/system/safari-data.ts`
- `desktop/electron/system/shell-history.ts`
- `desktop/electron/system/signal-processing.ts`
- `desktop/electron/system/steam-library.ts`
- `desktop/electron/system/system-signals.ts`
- related discovery types

#### `runtime-kernel/home`

Source of truth for runtime-home bootstrapping and protected local runtime
filesystem utilities.

Owns:

- runtime home path resolution
- `.stella` bootstrapping and seed logic
- bundled agent seeding helpers
- private/protected local fs helpers
- device and identity persistence helpers

This package is the new home for:

- `desktop/electron/system/stella-home.ts`
- `desktop/electron/system/private-fs.ts`
- `desktop/electron/system/device.ts`
- `desktop/electron/system/identity-map.ts`

It must accept host paths as explicit inputs rather than importing Electron app
objects deep in package internals.

#### `runtime-kernel/dev-projects`

Source of truth for local dev-project discovery and runtime management.

Owns:

- dev-project registry state
- project discovery seeding
- local dev server spawn/stop/logging
- port allocation and health polling

This package is the new home for:

- `desktop/electron/services/dev-project-service.ts`

#### `runtime-kernel/self-mod`

Source of truth for self-mod runtime logic that does not require Electron host
control.

Owns:

- git status / head / apply / revert helpers
- store-mod planning and runtime-side package install state
- self-mod change detection used by the worker
- runtime-side HMR transition state generation

This package is the new home for:

- `desktop/electron/self-mod/git.ts`
- runtime-owned portions of `desktop/electron/self-mod/hmr.ts`
- `desktop/electron/self-mod/store-mod-service.ts`

Electron keeps only host morph/reload presentation logic such as:

- `desktop/electron/self-mod/hmr-morph.ts`
- any BrowserWindow/webContents reload choreography

## Electron Final Shape

After this extraction, Electron should contain only:

- `bootstrap/`
- `ipc/`
- `services/` for genuine host services only
- `wake-word/`
- `windows/`
- `input/`
- `startup/`
- `devtool/`
- any host-only self-mod morph orchestration

`desktop/electron/core/**` should be deleted entirely.

### Host-Only Services

The following remain in Electron:

- `auth-service.ts`
- `capture-service.ts`
- `credential-service.ts`
- `external-link-service.ts`
- `mini-bridge-service.ts`
- `radial-gesture-service.ts`
- `security-policy-service.ts`
- `ui-state-service.ts`
- mobile bridge services
- wake-word controllers and native shortcut control

`local-scheduler-service.ts` and `dev-project-service.ts` do not remain.

## Domain Splits

### Core

`desktop/electron/core/**` should not survive as a directory.

Move:

- `electron/core/ai/**` -> `ai`
- `electron/core/agent/**` -> `runtime-kernel/agent-core`
- `electron/core/runtime/**` -> `runtime-kernel`
- `electron/core/dashboard-generation.ts` -> `runtime-kernel`

Rules:

- worker imports runtime kernel packages, never `electron/core/...`
- daemon imports protocol/client/kernel packages, never `electron/core/...`
- Electron main may import extracted packages, but never through `electron/core/...`

### Voice

Voice is a three-layer domain and must be split explicitly.

#### Keep In Electron

- global shortcut registration
- wake-word detector lifecycle
- wake-word enabled-state broadcast
- overlay/window activation for voice mode
- cross-window/mobile fanout for renderer voice UI state

This remains under Electron host paths such as:

- `desktop/electron/wake-word/**`
- host-facing portions of `desktop/electron/ipc/voice-handlers.ts`

#### Move To Worker / Runtime Packages

- transcript persistence into local chat/runtime state
- orchestrator delegation for voice turns
- voice request queueing and supersession
- runtime-owned web search for voice tools

Recommended target:

- worker-facing voice runtime module under
`desktop/packages/runtime-worker/voice/`
or
`desktop/packages/runtime-capabilities/voice/`

#### Keep In Renderer

- realtime media session
- WebRTC session lifecycle
- microphone capture and audio graph
- assistant audio playback

Current renderer ownership is already correct in:

- `desktop/src/features/voice/services/realtime-voice.ts`
- related renderer hooks and roots

### Music

Music is a two-layer domain.

#### Keep In Renderer

- live music generation
- playback state
- audio context / crossfade / prompt UX

Current renderer ownership is already correct in:

- `desktop/src/features/music/services/lyria-music.ts`
- related hooks and UI

#### Move Out Of Electron

- local music-library discovery
- music taste signal extraction for synthesis

Target package:

- `runtime-discovery`

### Discovery / System

Most of `desktop/electron/system/**` should move out.

The only acceptable reason for code to remain in Electron is direct host API
ownership. Discovery code is Node/OS logic, not Electron host logic.

Specific expectation:

- Electron IPC handlers call worker/daemon or extracted packages
- Electron no longer owns signal collection pipelines
- music discovery moves together with the broader discovery stack

### Scheduler

`desktop/electron/services/local-scheduler-service.ts` is already worker-owned
logically and must become worker-owned physically.

Target package:

- `runtime-kernel`

Additional rule:

- schedule IPC remains in Electron as a host facade only
- schedule execution/state ownership stays outside Electron

### Dev Projects

`desktop/electron/services/dev-project-service.ts` must move out of Electron.

Target package:

- `runtime-kernel/dev-projects`

Additional rule:

- Electron broadcasts project-change events
- worker or extracted package owns project registry and lifecycle

### Self-Mod

Self-mod must be split by runtime-vs-host concern.

#### Move Out Of Electron

- git inspection and revert/apply helpers
- runtime-side store-mod install state
- self-mod change detection and runtime transition state generation

#### Keep In Electron

- renderer morph presentation
- BrowserWindow reload coordination
- overlay morph choreography

The host must present self-mod transitions, not compute runtime patch logic.

## Import Policy

This extraction is not complete until import policy is enforced.

### Rules

1. No cross-package imports from `desktop/electron/core/**`.
2. No direct imports into another package's `src/` internals.
3. Every extracted package exposes sanctioned public entrypoints.
4. Electron imports extracted packages via sanctioned package facades only.
5. Worker and daemon imports must not reach back into Electron for non-host code.

### Sanctioned Facades

Each new package must expose:

- a root `src/index.ts`
- optional explicit subpath entrypoints for stable domains only

Recommended import style:

- `@stella/ai`
- `@stella/agent-core`
- `@stella/runtime-kernel`
- `@stella/runtime-discovery`
- `@stella/runtime-home`
- `@stella/dev-projects`
- `@stella/self-mod-runtime`

If workspace aliases are not available yet, add them as part of this
extraction. Do not normalize on `../../packages/.../src/index.js` as the final
state.

## Main-Process Cleanup Rules

After extraction, the following Electron files must stop importing runtime
internals directly:

- `desktop/electron/ipc/overlay-stream-handlers.ts`
- `desktop/electron/ipc/browser-handlers.ts`
- `desktop/electron/ipc/system-handlers.ts`
- `desktop/electron/system/stella-home.ts`
- any remaining host file reaching into `desktop/electron/core/**`

### Specific Expectations

#### `overlay-stream-handlers.ts`

Must stop resolving models and chat context via Electron-owned runtime imports.

Preferred end state:

- forward request to worker through daemon
or
- call an extracted package facade that is also used by the worker

What must not remain:

- direct imports from runtime model routing, provider, or preference internals
via `electron/core/...`

#### `browser-handlers.ts`

Must stop importing runtime tool internals just to normalize URLs or share shell
assumptions.

End state:

- move shared URL/network guard utilities into an extracted neutral package
inside `runtime-kernel` or a dedicated utility package

#### `system-handlers.ts`

May remain as Electron IPC registration, but must depend only on extracted
packages and host services.

## Dev And Reload Semantics

The dev pipeline must follow the real ownership model after extraction.

### Restart Tiers

1. Renderer-only change
  - Vite HMR
2. Capability or worker-owned package change
  - worker reload or worker generation swap
3. Daemon/protocol/client package change
  - daemon restart, Electron stays up when possible
4. Host-kernel change
  - Electron restart

### Package Classification

- `ai`, `runtime-kernel`, and `runtime-discovery` are worker/daemon-side code,
not Electron-restart code by default
- `runtime-client` and `boundary-contracts` affect Electron main
and must trigger host reload when their built output changes

## Migration Phases

### Phase 1: Package Foundations

Deliver:

- new package directories
- build and test wiring
- sanctioned entrypoints
- path alias strategy

Acceptance:

- every target package builds independently
- no new package is imported through another package's `src/` internals

### Phase 2: Core Extraction

Deliver:

- move `electron/core/ai/**` to `ai`
- move `electron/core/agent/**` to `runtime-kernel/agent-core`
- move `electron/core/runtime/**` and `dashboard-generation.ts` to
`runtime-kernel`
- update worker, capabilities, tests, and Electron callers

Acceptance:

- no production code imports from `desktop/electron/core/**`
- `desktop/electron/core/**` is deleted

### Phase 3: Runtime Services Extraction

Deliver:

- move `local-scheduler-service.ts` to `runtime-kernel`
- move `dev-project-service.ts` to `runtime-kernel/dev-projects`
- move `system/**` discovery code to `runtime-discovery`
- move home/private-fs/device/identity helpers to `runtime-kernel/home`

Acceptance:

- Electron no longer owns scheduler, discovery, dev-project, or runtime-home
logic

### Phase 4: Voice And Music Split

Deliver:

- split `voice-handlers.ts` into host-only handler code plus worker/runtime
voice modules
- move voice transcript persistence, orchestration, and queueing out of
Electron
- move music library discovery with the discovery package

Acceptance:

- voice shortcuts and wake-word still work without runtime code in Electron
- voice orchestrator requests survive worker reload semantics
- music discovery remains available to synthesis flows

### Phase 5: Self-Mod Split

Deliver:

- move git/store-mod/runtime self-mod logic to `runtime-kernel/self-mod`
- keep only host morph/reload choreography in Electron
- update worker and client wiring

Acceptance:

- self-mod runtime edits require worker or daemon reload, not Electron restart,
unless the host kernel actually changed

### Phase 6: Host Kernel Finalization

Deliver:

- clean Electron import graph
- update dev restart classifier
- remove now-empty or runtime-owned Electron directories
- update docs and architectural tests

Acceptance:

- Electron host contains only host-kernel code
- no extraction debt remains in directory structure

## Production Acceptance Criteria

The extraction is not production-ready until all of the following are true:

- `desktop/electron/core/**` does not exist
- worker and daemon packages do not import runtime code from `desktop/electron/**`
- Electron main does not own scheduler, discovery, dev-project, runtime-home,
or non-host self-mod logic
- voice host control still works
- voice runtime workflows no longer require Electron runtime code
- music rendering/playback stays renderer-side
- music library discovery stays outside Electron
- self-mod UI morphing still works
- worker reload semantics remain correct for extracted packages
- dev restart filters classify extracted packages by true ownership
- sanctioned package entrypoints are used consistently

## Verification Matrix

At completion, verify at minimum:

- cold app boot
- local chat bootstrapping
- schedule CRUD and background execution
- store-mod install/apply/remove flows
- social-session background turns
- voice shortcut and wake-word flows
- voice orchestrator chat and transcript persistence
- music generation/playback
- music discovery contribution to synthesis
- dev-project discovery, start, stop, logs
- self-mod HMR morph and runtime reload
- daemon/worker respawn behavior
- Electron dev reload behavior for extracted package edits

## Documentation Updates Required During Implementation

When this blueprint is executed:

- update `docs/stella-runtime-blueprint.md` to note that package extraction debt
is resolved
- record each completed phase with concise evidence of moved paths and
verification results
- explicitly note any deviations from this package map before continuing

## Implementation Progress

### Phase 1 Completed: Package Foundations

Evidence:

- Split runtime ownership into package-root boundaries under
`desktop/packages/**`.
- Switched current production callers off direct `packages/.../src/...` imports
for boundary/protocol/client usage in Electron host code and package tests.
- Updated `desktop/src/shared/contracts/boundary.ts` to consume the sanctioned
`boundary-contracts` package boundary instead of importing package internals.

Verification:

- Confirmed production imports resolve through package-root paths under
`desktop/packages/**`.

Deviation:

- Instead of TypeScript path aliases like `@stella/...`, the extraction keeps
runtime-safe relative imports rooted at `desktop/packages/**`.

### Phase 2 Completed: Core Extraction

Evidence:

- Moved the old `desktop/electron/core/ai/**` sources into
`desktop/packages/ai/**`.
- Moved the old `desktop/electron/core/agent/**` sources into
`desktop/packages/runtime-kernel/agent-core/**`.
- Moved the old `desktop/electron/core/runtime/**` sources plus dashboard
generation into `desktop/packages/runtime-kernel/**`.
- Updated Electron host, runtime client/daemon/worker, capabilities, and tests
to import the new package facades or in-package `src/**` modules by true
ownership.
- Removed the now-empty `desktop/electron/core/**` directories.

Verification:

- Confirmed no production imports remain for `desktop/electron/core/**`.
- Confirmed no production imports reach into another package via
`packages/.../src/...`.
- `npm run electron:typecheck`
- `npm run test:electron`

### Phase 3 Completed: Runtime Services Extraction

Evidence:

- Moved scheduler ownership to
`desktop/packages/runtime-kernel/local-scheduler-service.ts`.
- Moved dev-project runtime ownership to
`desktop/packages/runtime-kernel/dev-projects/dev-project-service.ts`.
- Moved discovery collectors, including music-library discovery, into
`desktop/packages/runtime-discovery/**`.
- Moved runtime-home, private-fs, device, and identity helpers into
`desktop/packages/runtime-kernel/home/**`.
- Removed the now-empty `desktop/electron/system/**` and
`desktop/electron/storage/**` directories.

Verification:

- Confirmed Electron no longer contains runtime discovery/home/storage package
roots.
- Verified the discovery, scheduler, and runtime-home regression suites stay
green under the extracted paths.
- `npm run electron:typecheck`
- `npm run test:electron`

### Phase 4 Completed: Voice And Music Split

Evidence:

- Kept Electron voice ownership limited to host concerns in
`desktop/electron/ipc/voice-handlers.ts`:
shortcuts, wake-word/device coordination, renderer/mobile fanout, and UI
state sync.
- Moved runtime voice transcript persistence, orchestrator chat, and runtime
web-search delegation into
`desktop/packages/runtime-worker/voice/service.ts`.
- Added dedicated protocol/client/daemon/worker voice RPC methods and event
forwarding for transcript persistence, orchestrator chat, web search, agent
events, and self-mod HMR state.
- Kept music rendering/playback renderer-side and kept music-library discovery
in `desktop/packages/runtime-discovery/music-library.ts`.

Verification:

- Verified voice IPC/worker flows via `desktop/tests/electron/ipc/voice-handlers.test.ts`.
- Verified discovery continues to include music-library inputs via the extracted
discovery test coverage.
- `npm run electron:typecheck`
- `npm run test:electron`

### Phase 5 Completed: Self-Mod Split

Evidence:

- Moved runtime self-mod logic into
`desktop/packages/runtime-kernel/self-mod/git.ts`,
`desktop/packages/runtime-kernel/self-mod/hmr.ts`, and
`desktop/packages/runtime-kernel/self-mod/store-mod-service.ts`.
- Kept Electron host ownership limited to UI/window morph choreography in
`desktop/electron/self-mod/hmr-morph.ts`.
- Updated worker/runtime wiring so self-mod runtime changes stay on the sidecar
boundary instead of requiring Electron-host ownership.

Verification:

- Verified self-mod/store-mod regression coverage remains green under the new
ownership split.
- Confirmed Electron only retains host-facing self-mod code.
- `npm run electron:typecheck`
- `npm run test:electron`

### Phase 6 Completed: Host Kernel Finalization

Evidence:

- Normalized dev reload classification so extracted worker-owned packages stay
on worker/daemon reloads while Electron restarts only for true host-owned
package changes.
- Replaced same-package test mocks to target real `src/**` ownership paths,
which removed stale facade-based mocking from the extracted runtime suites.
- Hardened secret-mount recovery in
`desktop/packages/runtime-kernel/tools/utils.ts` so invalid
`readdir` results degrade safely instead of producing startup noise.
- Removed the final empty legacy directories:
`desktop/electron/core/**`, `desktop/electron/system/**`, and
`desktop/electron/storage/**`.

Verification:

- `npm run electron:typecheck`
- `npm run test:electron` -> 77 files passed, 231 tests passed, 1 skipped
- Confirmed `desktop/electron/**` now contains only host-kernel directories and
files.
- Confirmed `rg -n "electron/core|electron/system|electron/storage|packages/.+/src/"`
across `desktop/electron`, `desktop/packages`, and `desktop/src` returns no
production-code matches.

Additional Work Completed Outside Original Scope:

- Tightened package test mocking so extracted runtime/kernel suites mock true
in-package dependency paths instead of relying on public facades for internal
module interception.
- Removed a tools startup regression log by making stale secret-mount recovery
tolerate non-array `readdir` results in mocked or degraded environments.
- Refined the Electron dev restart classifier to restart the host for
host-imported extracted package trees while keeping true sidecar-only
packages on worker/daemon reloads.
- Restored voice self-mod HMR progress propagation across the worker bridge by
using the provided `reportState` callback during host HMR transitions, and
added a focused worker-side regression test for that path.
- Stopped voice startup failures from rethrowing into an unobserved
`handleLocalChatPromise`, so rejected voice requests now fail cleanly without
leaving an unhandled rejection behind in the worker process.
- Moved `overlay:autoPanelStart` LLM route selection and token streaming into
the runtime worker, added overlay stream RPC notifications through the
daemon/client boundary, and reduced Electron to request ownership plus
renderer event forwarding only.
- Moved `DevProjectService` lifecycle ownership into the runtime worker so
Electron now only performs the native directory picker, proxies project
commands through the sidecar, and broadcasts worker-owned `projects:changed`
updates.
- Routed dashboard generation and self-mod Git utility flows through the
sidecar boundary instead of executing runtime-kernel imports directly inside
Electron IPC handlers.
- Removed the temporary facade layer entirely by flattening package sources out
of `src/` and deleting the obsolete package-facade sync step, so the
final structure is now plain package-root source under `desktop/packages/**`.
- Kept the real package boundaries, but dropped the fake-package ceremony:
extracted packages now own code directly at their package roots instead of
`src/**` plus generated facade barrels.
- Added focused regression coverage for the new host-only seams in
`desktop/tests/electron/ipc/overlay-stream-handlers.test.ts`,
`desktop/tests/electron/ipc/project-handlers.test.ts`, and
`desktop/tests/electron/ipc/agent-handlers.test.ts`.

## Final Verification

- `npm run electron:typecheck`
- `npm run test:electron` -> 79 files passed, 236 tests passed, 1 skipped
- Verified the remaining Electron tree is host-kernel only:
bootstrap, preload, IPC, host services, wake-word/input, windows, devtool,
and host-side self-mod morphing.
