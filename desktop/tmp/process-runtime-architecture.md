# Process Runtime Rewrite Architecture

## Goal

Make process lifecycle ownership explicit and centralized without turning Electron main into a god object.

The rewrite should improve:

- shutdown correctness
- startup/retry readability
- timer ownership
- process tree cleanup
- adding/removing sidecars

The rewrite should **not** centralize protocol logic, auth logic, or UI/domain behavior.

## Core Principle

Split the system into:

1. `control plane`
2. `resource adapters`
3. `domain services`

### 1. Control Plane

Owns lifecycle policy only.

Responsibilities:

- registration of managed resources
- startup ordering
- shutdown phases
- retries/backoff
- idle policies
- process-tree cleanup
- timer ownership
- fatal vs recoverable failure policy

It should not know:

- browser bridge protocol commands
- mobile bridge auth/registration payloads
- worker RPC method semantics
- UI window implementation details

### 2. Resource Adapters

Thin wrappers that translate a service or child process into a lifecycle-managed resource.

Responsibilities:

- expose `start()`
- expose `stop()`
- report health/failure/exit
- optionally expose `beforeStart()` or `isPinned()`

Adapters should be small and mostly declarative.

### 3. Domain Services

Keep domain logic here.

Examples:

- browser bridge socket/session logic
- mobile bridge HTTP/WebSocket/auth logic
- wake-word detection logic
- runtime client RPC logic

These services should not own app-wide shutdown policy.

## Target File Shape

### Keep / Strengthen

- `desktop/electron/process-runtime.ts`
  - central lifecycle runtime
- `desktop/electron/bootstrap/context.ts`
  - dependency assembly only
- `desktop/electron/bootstrap/runtime.ts`
  - startup orchestration only
- `desktop/electron/bootstrap/lifecycle.ts`
  - Electron event wiring only

### Add

- `desktop/electron/process-resources/`
  - one adapter per managed runtime resource

Suggested files:

- `desktop/electron/process-resources/browser-bridge-resource.ts`
- `desktop/electron/process-resources/cloudflare-tunnel-resource.ts`
- `desktop/electron/process-resources/runtime-worker-resource.ts`
- `desktop/electron/process-resources/mobile-bridge-resource.ts`
- `desktop/electron/process-resources/wake-word-resource.ts`

### Keep But Simplify

- `desktop/electron/services/stella-browser-bridge-service.ts`
- `desktop/electron/services/mobile-bridge/tunnel-service.ts`
- `desktop/electron/services/mobile-bridge/service.ts`

These should become domain/service objects, not lifecycle owners.

## Resource Model

Every managed thing should be described with one of a few shapes.

### Required Resource

If it exits unexpectedly, the app/runtime should shut down or restart its parent scope.

Examples:

- top-level dev-runner child processes
- possibly the runtime worker, depending on scope

Shape:

```ts
type RequiredResource = {
  id: string;
  phase: "startup" | "runtime";
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onUnexpectedExit?: (details: ExitDetails) => Promise<void> | void;
};
```

### Recoverable Resource

If it exits unexpectedly, it should reconnect/restart with policy owned by the control plane.

Examples:

- browser bridge daemon
- cloudflare tunnel

Shape:

```ts
type RecoverableResource = {
  id: string;
  start: () => Promise<RunningHandle>;
  stop: () => Promise<void>;
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
  };
};
```

### Idle Resource

Starts on demand, stops when unused unless pinned.

Examples:

- runtime worker

Shape:

```ts
type IdleResource = {
  id: string;
  ensureStarted: () => Promise<void>;
  stop: (reason: "idle" | "shutdown" | "restart") => Promise<void>;
  isPinned: () => Promise<boolean> | boolean;
  noteActivity: () => void;
};
```

### Passive Resource

Has no restart policy and no child process tree; just stop it in a shutdown phase.

Examples:

- overlay destroy
- wake-word dispose
- selected-text cleanup

## Shutdown Phases

Make phases first-class and stable.

### `before-quit`

Intent: stop live activity and prevent new work.

Examples:

- stop auth refresh
- kill active shells
- stop browser bridge
- stop cloudflare tunnel
- dispose wake word
- stop mobile bridge
- destroy overlay
- clear managed timers

### `will-quit`

Intent: final cleanup after quit is underway.

Examples:

- unregister global shortcuts
- stop radial gesture service
- stop runtime worker/host services

### Rule

New resource additions must declare which phase owns them.

That removes “remember to manually add another stop call later.”

## Process Runtime API

The runtime should converge toward a small API surface like this:

```ts
type ProcessRuntime = {
  registerCleanup(
    phase: "before-quit" | "will-quit",
    key: string,
    cleanup: () => Promise<void> | void,
  ): () => void;

  registerRecoverableChild(config: {
    key: string;
    start: () => Promise<ChildProcess>;
    stop?: () => Promise<void> | void;
    retry: { baseDelayMs: number; maxDelayMs: number };
    onState?: (state: ResourceState) => void;
  }): RecoverableHandle;

  registerIdleResource(config: {
    key: string;
    ensureStarted: () => Promise<void>;
    stop: (reason: "idle" | "shutdown" | "restart") => Promise<void>;
    isPinned?: () => Promise<boolean> | boolean;
    idleTimeoutMs: number;
  }): IdleHandle;

  setManagedTimeout(fn: () => void, delayMs: number): () => void;
  setManagedInterval(fn: () => void, delayMs: number): () => void;

  runPhase(phase: "before-quit" | "will-quit"): Promise<void>;
  isShuttingDown(): boolean;
};
```

## What Moves Out Of Current Services

### Browser Bridge Service

Move out:

- reconnect timer ownership
- reconnect backoff policy
- daemon child-process tree kill helper
- startup/stop registration in app lifecycle

Keep in service:

- daemon command protocol
- readiness probing
- stale port/session cleanup
- status payload creation

### Cloudflare Tunnel Service

Move out:

- retry timer ownership
- restart backoff policy
- child-process tree kill helper
- app quit registration

Keep in service:

- token fetch
- tunnel URL parsing
- stdout/stderr interpretation

### Runtime Worker

Move out:

- worker idle timer ownership
- worker lifecycle state transitions
- “pinned” lifecycle policy
- process stop/drain timing

Keep in runtime client/service:

- RPC protocol
- request/response semantics
- health snapshot contents
- scheduler/project/chat storage integration

This is probably the highest-value rewrite after sidecars.

## What Stays Outside The Runtime

### WindowManager / Full Window / Recovery

Renderer crash recovery stays a UI concern.

The runtime can expose:

- `isShuttingDown`
- optional `handleRendererUnavailable()`

But it should not own:

- recovery page loading
- window creation
- mini/full window presentation

### Mobile Bridge Domain Logic

The runtime should own when to stop/start the mobile bridge, not how it authorizes requests or proxies the renderer.

## Proposed Ownership After Rewrite

### `bootstrap/context.ts`

Owns:

- object graph assembly
- service construction
- process runtime construction
- resource adapter construction

Should not own:

- shutdown call lists

### `bootstrap/lifecycle.ts`

Owns:

- Electron event binding

Should only do:

- `before-quit => processRuntime.runPhase("before-quit")`
- `will-quit => processRuntime.runPhase("will-quit")`
- `window-all-closed => app.quit()`

### `bootstrap/runtime.ts`

Owns:

- startup ordering
- background initialization sequencing
- window launch sequencing

Should not own:

- raw timeout bookkeeping
- sidecar-specific retry rules

### `process-resources/*`

Own:

- mapping a concrete service to runtime registration

Should not own:

- app-wide policy beyond the one resource

## What Files Likely Shrink A Lot

- `desktop/electron/bootstrap/lifecycle.ts`
- `desktop/electron/bootstrap/runtime.ts`
- `desktop/electron/services/stella-browser-bridge-service.ts`
- `desktop/electron/services/mobile-bridge/tunnel-service.ts`
- `desktop/packages/runtime-client/index.ts`

## Maintainability Wins Expected

### Good

- fewer lifecycle bugs like “forgot to stop X on quit”
- fewer duplicated child-process kill paths
- easier to add new sidecars
- cleaner reasoning about shutdown order
- cleaner tests around phases and policies

### Risk

The main risk is over-centralization.

Avoid:

- stuffing service logic into `process-runtime.ts`
- inventing a giant abstract framework
- making everything generic before the real cases are modeled

The runtime should stay narrow and policy-oriented.

## Recommended Rewrite Order

### Phase 1

Already started:

- central shutdown phases
- shared timer ownership
- shared child tree kill helper

### Phase 2

Extract sidecar adapters:

- browser bridge resource
- cloudflare tunnel resource

Result:

- service files stop owning retries
- `bootstrap/runtime.ts` only wires adapters

### Phase 3

Extract worker lifecycle adapter:

- idle timer
- pinned checks
- restart/shutdown policy

This is the biggest simplification opportunity in the codebase.

### Phase 4

Compress bootstrap files:

- move remaining cleanup/startup glue into adapters
- leave bootstrap as assembly + ordering only

## Success Criteria

We should consider the rewrite successful if:

- adding a new sidecar means registering one adapter, not editing multiple shutdown sites
- all timers that matter are owned by the runtime
- unexpected child exits have one obvious policy owner
- services can be read mostly for domain logic, not app lifecycle plumbing
- Electron quit hooks are thin and stable
