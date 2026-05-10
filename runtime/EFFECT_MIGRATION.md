# Effect-TS migration plan for Stella's runtime

This document is the implementation brief for re-introducing the `runtime/effect/`
shadow tree, modeled on how [`opencode`](https://github.com/anomalyco/opencode)
uses Effect-TS. The prior Stella effect tree was removed; we are starting fresh.

**Audience:** an implementation agent that will land this end-to-end. Read this
file top to bottom before touching code. When in doubt about Effect APIs, look
inside `node_modules/effect/dist/**` and the vendored opencode snapshots under
`runtime/effect/specs/` (created in M0) rather than guessing — the Effect 4
beta surface drifts.

**Foundation deps already installed at workspace root:**

- `effect@4.0.0-beta.59`
- `@effect/platform-node@4.0.0-beta.57`
- `@effect/opentelemetry@4.0.0-beta.57`

These match opencode's pins so the vendored reference snapshots compile against
the same surface.

---

## 0. Mental model

### Where Stella is today

- A **worker process** (`runtime/worker/entry.ts` → `runtime/worker/server.ts`,
  ~3000 lines) calls `peer.registerRequestHandler(METHOD_NAMES.X, async (params) => …)`
  for every method (~63 sites). All side effects (Convex calls, SQLite writes,
  `runner.ts` calls) live inside handler closures.
- A **host process** (`runtime/host/index.ts`, ~2300 lines) owns the inverse:
  `peer.registerRequestHandler(METHOD_NAMES.HOST_*, …)` for credentials, display,
  notification, window callbacks. Stream events come back via
  `peer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_EVENT, …)` and fan out
  through a typed `EventEmitter`.
- The **kernel** under `runtime/kernel/` is composed by
  `createStellaHostRunner(options)` (`runtime/kernel/runner.ts`), which builds a
  `RunnerContext` struct with ~50 fields under `state:` and threads it through
  plain closures. Construction order matters; there is no compositional way to
  say "service A depends on B and C".
- **Hooks** are a single `HookEmitter` instance (`runtime/kernel/extensions/hook-emitter.ts`)
  with `register` / `emit` / `emitAll` / `clearBySource`. Bundled hooks live in
  `runtime/extensions/stella-runtime/hooks/`; user-extension hooks hot-reload
  via fs watcher with ESM cache busting.
- **Per-conversation state** lives in flat `Map<conversationId, OrchestratorSession>` /
  `Map<runId, AbortController>` / `Map<runId, AgentCallbacks>` tables on
  `RunnerContext.state`. Cleanup is manual.

### Where Stella is going

- **Worker** = a single `WorkerRuntime` (`ManagedRuntime`) over a
  `WorkerLayer = Layer.mergeAll(...)` of every kernel service's `defaultLayer`.
  RPC handlers are `JsonRpcEndpoint`s registered in groups; each handler is an
  `Effect.fn("Worker.X")(function*() {…})` that yields services via
  `yield* Foo.Service`.
- **Host** = a small `HostRuntime` (`ManagedRuntime`) over a `HostLayer`
  (Electron-side services: device identity, credentials store, display bridge,
  runtime auth refresh, window manager). Same `JsonRpcEndpoint` pattern, but the
  API is registered on the worker peer's *outgoing* side.
- **Kernel** stays intact, but every "noun" (`Bus`, `Hooks`, `Storage`,
  `RuntimeStore`, `Tools`, `Agent`, `Session`, `Compaction`, `LLM`, `Provider`,
  `SelfMod`, `Memory`, `Discovery`, `Voice`, `SocialSession`, `Schedule`,
  `Store`, `Runner`) becomes:

  ```ts
  class Service extends Context.Service<Self, Interface>()("@stella/<Name>") {}
  interface Interface { readonly method(...): Effect.Effect<A, E, R> }
  export const layer = Layer.effect(Service, Effect.gen(...))
  export const defaultLayer = layer.pipe(Layer.provide(...))
  ```

- **Per-conversation state** moves onto a
  `ConversationRef = Context.Reference<…>` (defaultValue: undefined) plus a
  `ConversationState.make(initFn)` factory that wraps a
  `ScopedCache<conversationId, A, E, R>`. Same pattern for `RunRef` / `RunState`.
  Disposers register into a `conversation-registry.ts` so the conversation
  lifecycle controller can invalidate per-conversation state on dispose. This
  mirrors opencode's `InstanceState`/`InstanceRef`/`InstanceStore` trio, with
  the key changed from `directory` → `conversationId`.
- **Streams** replace event emitters. `RuntimeBus.subscribe(EventDef)` returns
  `Stream<Payload<EventDef>>`. The host's typed event emitter becomes a `Stream`
  derived from `Stream.fromPubSub`.
- **Schemas** standardize on `effect/Schema` for protocol payloads, hook
  payloads, and stored row shapes. An `effect-zod`-style AST walker (lifted from
  opencode's `core/src/effect-zod.ts`) lets the AI SDK and tool catalog keep
  their zod inputs without forcing a rewrite of every tool definition.
- **Logging + tracing** — every service method is wrapped in
  `Effect.fn("Module.method")`. `Observability.layer` produces OTLP traces
  conditionally on env vars (off by default; matches opencode). Stella's
  existing `runtime/kernel/debug.ts` becomes a `Logger.make` bridge so existing
  log call-sites still emit to the same files.
- **Hooks** become two layered things: a "bundled hooks" `Layer` (what opencode
  would call the orchestrator-personality / self-mod / memory-review /
  dream-notify / home-suggestions services), and a "user extension hooks"
  runtime registry the F1 reload swaps. The existing `HookEmitter`'s
  last-write-wins / `emitAll` / merge-on-`agent_end` semantics are preserved
  exactly.

### Non-negotiables

- **JSON-RPC stays.** Stella's transport remains the existing `JsonRpcPeer` +
  `WorkerPeerBroker` over UDS / stdio. The new code wraps the existing peer; it
  does not replace it.
- **No backwards-compat shims.** Per the workspace's "no live users yet" rule,
  every migration is a hard cut. No dual-writing fields, no compatibility
  caveats, no migrations of persisted data.
- **Boundary isolation.** Legacy `runtime/**` code MUST NOT import
  `runtime/effect/**`. `runtime/effect/**` MUST NOT re-export legacy modules
  under their original names. A boundary script enforces this.
- **Per-service hard cuts.** When a service migrates, its legacy implementation
  is deleted in the same PR. No `HookEmitter` and `Hooks.Service` coexisting
  past their migration milestone.

---

## 1. Top-level layout

Create exactly this tree:

```
runtime/effect/
├── core/                              # shared primitives (mirrors opencode/core/effect/)
│   ├── memo-map.ts                    # Layer.makeMemoMapUnsafe()
│   ├── runtime.ts                     # makeRuntime(service, layer)
│   ├── observability.ts               # OTel + Logger layer
│   ├── logger.ts                      # Logger.make bridging to existing debug.ts
│   ├── service-use.ts                 # Proxy(tag) → typed accessors
│   ├── config-service.ts              # ConfigService.Service<Self>()(id, fields)
│   └── zod.ts                         # walk Effect Schema → zod
│
├── jsonrpc/                           # the JSON-RPC analog of effect/unstable/httpapi
│   ├── api.ts                         # JsonRpcApi.make / addJsonRpcGroup / annotate
│   ├── group.ts                       # JsonRpcGroup<Name>
│   ├── endpoint.ts                    # JsonRpcEndpoint<Method, Params, Result, Error>
│   ├── builder.ts                     # JsonRpcBuilder.group(api, "name", handlers => ...)
│   ├── error.ts                       # JsonRpcError tagged errors
│   ├── server.ts                      # bind a built API to a JsonRpcPeer
│   └── client.ts                      # typed RPC client derived from the same API value
│
├── jsonl/                             # transport adapter (wraps existing runtime/protocol/jsonl.ts)
│   ├── peer.ts                        # JsonRpcPeer wrapped as Effect Service
│   └── broker.ts                      # WorkerPeerBroker → BrokerService
│
├── runtime/                           # the kernel layer graph (Stella's "AppLayer")
│   ├── conversation-ref.ts            # Context.Reference<ConversationContext|undefined>
│   ├── conversation-state.ts          # ScopedCache helper + disposer registry
│   ├── conversation-store.ts          # InstanceStore equivalent (load/dispose by id)
│   ├── run-ref.ts                     # Context.Reference<RunContext|undefined>
│   ├── runner.ts                      # opencode's Runner<A,E> state machine, ported
│   ├── als-bridge.ts                  # restore-ALS-around-fn helpers (small; Stella uses ALS less than opencode)
│   ├── bootstrap-runtime.ts           # ManagedRuntime for cold-start services
│   └── app-runtime.ts                 # WorkerRuntime / HostRuntime managed runtimes
│
├── services/                          # Effect-native Service modules
│   ├── bus/                           # @stella/Bus — typed PubSub
│   ├── hooks/                         # @stella/Hooks — preserves last-write-wins + emitAll merge
│   ├── storage/                       # @stella/Storage — bun:sqlite wrapped as Effect
│   ├── runtime-store/                 # @stella/RuntimeStore — chat/sessions/threads/memory
│   ├── run-events/                    # @stella/RunEvents — RunEventLog as Stream-emitting service
│   ├── compaction/                    # @stella/Compaction — replaces BackgroundCompactionScheduler
│   ├── tools/                         # @stella/Tools — tool host as Service
│   ├── llm/                           # @stella/LLM — streamText-equivalent returning Stream
│   ├── provider/                      # @stella/Provider — runtime/ai providers wrapped
│   ├── agent/                         # @stella/Agent — agent definition lookup, defaults
│   ├── session/                       # @stella/Session — orchestrator + subagent session manager
│   ├── self-mod/                      # @stella/SelfMod — git/hmr/feature-namer/store-mod-service
│   ├── memory/                        # @stella/Memory — chronicle/dream/memory-store
│   ├── discovery/                     # @stella/Discovery — collect-all-signals + browser-data
│   ├── voice/                         # @stella/Voice — RealtimeVoiceService
│   ├── social-session/                # @stella/SocialSession
│   ├── schedule/                      # @stella/Schedule
│   ├── store/                         # @stella/Store + @stella/StoreThread
│   ├── convex/                        # @stella/Convex — ConvexClient lifecycle as Service
│   ├── credentials/                   # @stella/Credentials (host-side)
│   ├── display/                       # @stella/Display (host-side)
│   ├── notification/                  # @stella/Notification (host-side)
│   ├── window/                        # @stella/Window (host-side)
│   ├── device-identity/               # @stella/DeviceIdentity (host-side)
│   ├── runtime-auth/                  # @stella/RuntimeAuth (host-side)
│   └── extensions/                    # @stella/Extensions — F1 user-extension loader as Service
│
├── api/                               # JSON-RPC API definitions (the surface from runtime/protocol/index.ts)
│   ├── method-names.ts                # METHOD_NAMES — keep one source of truth
│   ├── notification-names.ts          # NOTIFICATION_NAMES — keep one source of truth
│   ├── schemas/                       # Schema.Struct definitions per payload
│   │   ├── runtime.ts                 # RuntimeInitializeParams, RuntimeConfigureParams, ...
│   │   ├── run.ts                     # RuntimeChatPayload, RuntimeAgentEventPayload, ...
│   │   ├── voice.ts
│   │   ├── store.ts
│   │   ├── store-thread.ts
│   │   ├── schedule.ts
│   │   ├── self-mod.ts
│   │   ├── social-session.ts
│   │   ├── local-chat.ts
│   │   ├── projects.ts
│   │   ├── discovery.ts
│   │   ├── host-credentials.ts
│   │   ├── host-display.ts
│   │   ├── host-window.ts
│   │   └── ...
│   ├── groups/                        # JsonRpcGroup definitions (one per domain)
│   │   ├── lifecycle.ts               # initialize, runtime.configure, runtime.health, runtime.restartWorker
│   │   ├── run.ts                     # run.startChat / run.cancel / run.ackEvents / ...
│   │   ├── agent.ts
│   │   ├── voice.ts
│   │   ├── thread.ts
│   │   ├── local-chat.ts
│   │   ├── store.ts
│   │   ├── store-thread.ts
│   │   ├── store-mods.ts
│   │   ├── self-mod.ts
│   │   ├── schedule.ts
│   │   ├── social-sessions.ts
│   │   ├── projects.ts
│   │   ├── shell.ts
│   │   ├── discovery.ts
│   │   ├── search.ts
│   │   └── host/                      # the inverse direction: worker→host
│   │       ├── device.ts
│   │       ├── credentials.ts
│   │       ├── display.ts
│   │       ├── notification.ts
│   │       ├── system.ts
│   │       ├── window.ts
│   │       ├── hmr.ts
│   │       └── runtime-auth.ts
│   ├── notifications/                 # RuntimeBus event definitions
│   │   ├── run-event.ts
│   │   ├── runtime-ready.ts
│   │   ├── voice-event.ts
│   │   ├── local-chat-updated.ts
│   │   ├── store-thread-updated.ts
│   │   └── ...
│   └── client-api.ts                  # WorkerApi / HostApi top-level
│
├── handlers/                          # the worker's RPC implementations
│   ├── lifecycle-handlers.ts
│   ├── run-handlers.ts
│   ├── agent-handlers.ts
│   ├── voice-handlers.ts
│   ├── local-chat-handlers.ts
│   ├── store-handlers.ts
│   ├── store-thread-handlers.ts
│   ├── self-mod-handlers.ts
│   └── ...
│
├── host-handlers/                     # the host's implementations of the worker→host callbacks
│   ├── device-handlers.ts
│   ├── credentials-handlers.ts
│   ├── display-handlers.ts
│   ├── notification-handlers.ts
│   ├── window-handlers.ts
│   └── runtime-auth-handlers.ts
│
├── specs/                             # vendored opencode references (kept fresh for catch-up)
│   ├── opencode-app-runtime.ts        # snapshot of opencode/src/effect/app-runtime.ts
│   ├── opencode-bus.ts                # snapshot of opencode/src/bus/index.ts
│   ├── opencode-runner.ts
│   ├── opencode-instance-state.ts
│   ├── opencode-instance-store.ts
│   ├── opencode-effect-zod.ts
│   ├── opencode-config-service.ts
│   ├── opencode-llm.ts
│   └── README.md
│
├── test/                              # vitest-runnable parity + service tests
│   ├── parity.ts
│   ├── jsonrpc.test.ts
│   ├── conversation-state.test.ts
│   ├── runner.test.ts
│   ├── compaction.test.ts
│   ├── hooks.test.ts
│   └── ...
│
├── scripts/
│   └── check-boundary.mjs             # see §12
│
└── README.md                          # quickstart: "what is this tree, how to add a service"
```

### Reference source paths in this monorepo

When the implementation agent needs to read opencode for reference, the local
checkout is at:

- `../projects/opencode/packages/core/src/effect/` — `core/` helpers (paste-and-rename)
- `../projects/opencode/packages/core/src/effect-zod.ts` — Schema → zod walker
- `../projects/opencode/packages/opencode/src/effect/` — `runtime/` shape
  (`app-runtime.ts`, `bootstrap-runtime.ts`, `bridge.ts`, `instance-ref.ts`,
  `instance-state.ts`, `instance-registry.ts`, `run-service.ts`, `runner.ts`,
  `service-use.ts`, `config-service.ts`)
- `../projects/opencode/packages/opencode/src/bus/index.ts` — reference Service shape
- `../projects/opencode/packages/opencode/src/session/llm.ts` — `Stream.scoped`
  + `Effect.acquireRelease(AbortController)` pattern for LLM streaming
- `../projects/opencode/packages/opencode/src/session/session.ts` — reference for
  a large multi-method Service
- `../projects/opencode/packages/opencode/src/storage/storage.ts` — reference for
  the storage Service shape
- `../projects/opencode/packages/opencode/src/project/instance-store.ts` —
  reference for the `ConversationStore` Service (cached load/reload/dispose with
  `Deferred` deduplication)
- `../projects/opencode/packages/opencode/src/server/routes/instance/httpapi/api.ts`
  — reference for the API composition pattern that `JsonRpcApi.make` should
  mimic
- `../projects/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/v2/session.ts`
  — reference for the `HttpApiBuilder.group(...)` shape that `JsonRpcBuilder.group`
  should mimic

These should be vendored into `runtime/effect/specs/` (paste-only, no edits) in
M0 so they remain a stable reference even if `../projects/opencode` advances.

---

## 2. The JSON-RPC analog of `effect/unstable/httpapi`

Because we keep JSON-RPC, we write the equivalent of opencode's
`effect/unstable/httpapi` ourselves. The interface should feel identical so
anyone familiar with opencode's `HttpApi` can read Stella's `JsonRpcApi`
immediately.

**Investigate `node_modules/effect/dist/**/unstable/httpapi/**` for the
opencode-supplied prior art on type signatures, error type-level inference, and
group/api composition shape. Mimic that surface closely.**

### Endpoint

```ts
// runtime/effect/jsonrpc/endpoint.ts
export const JsonRpcEndpoint = <const Method extends string>(method: Method) => ({
  setParams: <P extends Schema.Top>(params: P) => ...,
  setSuccess: <S extends Schema.Top>(success: S) => ...,
  setError: <E extends Schema.Top>(error: E) => ...,
  // ↳ produces: JsonRpcEndpoint<Method, P, S, E>
})
```

### Group + API

```ts
// runtime/effect/api/groups/run.ts
export const RunGroup = JsonRpcGroup.make("run")
  .add(
    JsonRpcEndpoint("run.startChat")
      .setParams(RuntimeChatPayload)
      .setSuccess(Schema.Struct({ runId: Schema.String }))
      .setError(JsonRpcError.RuntimeUnavailable),
  )
  .add(
    JsonRpcEndpoint("run.cancel")
      .setParams(Schema.Struct({ runId: Schema.String }))
      .setSuccess(Schema.Void),
  )
  .add(...)
  // notifications:
  .addNotification(RunEventNotification)        // "run.event"
  .addNotification(SelfModHmrStateNotification) // "run.selfModHmrState"

// runtime/effect/api/client-api.ts
export const WorkerApi = JsonRpcApi.make("stella-worker")
  .addGroup(LifecycleGroup)
  .addGroup(RunGroup)
  .addGroup(AgentGroup)
  .addGroup(VoiceGroup)
  .addGroup(StoreGroup)
  .addGroup(StoreThreadGroup)
  .addGroup(SelfModGroup)
  .addGroup(...)
  .annotate(JsonRpcApi.ProtocolVersion, STELLA_RUNTIME_PROTOCOL_VERSION)
```

### Handlers

```ts
// runtime/effect/handlers/run-handlers.ts
export const runHandlers = JsonRpcBuilder.group(WorkerApi, "run", (handlers) =>
  Effect.gen(function* () {
    const runner = yield* Runner.Service
    const runtimeStore = yield* RuntimeStore.Service
    const runEvents = yield* RunEvents.Service

    return handlers
      .handle("run.startChat", Effect.fn(function* (params) {
        const runId = yield* runner.startChat(params)
        return { runId }
      }))
      .handle("run.cancel", Effect.fn(function* ({ runId }) {
        yield* runner.cancel(runId)
      }))
      .handle(...)
  }),
)
```

### Server (bind to broker)

```ts
// runtime/effect/jsonrpc/server.ts
export const bindToBroker = <ApiType extends JsonRpcApi.Any>(
  api: ApiType,
  broker: WorkerPeerBroker,                  // legacy peer-broker stays
  handlerLayer: Layer.Layer<JsonRpcHandlers<ApiType>, never, AppServices>,
) => Effect.Effect<void, never, AppServices>
```

Internally `bindToBroker`:

1. Walks the API at runtime to enumerate endpoints.
2. For each endpoint, registers a handler on the broker that:
   - Decodes incoming params via the endpoint's `Schema` (errors → `INVALID_PARAMS`).
   - Runs the handler `Effect` through the active runtime (`WorkerRuntime.runPromiseExit`).
   - On success, encodes the result through the `success` schema.
   - On typed failure, surfaces it as the matching `JsonRpcError` envelope.
3. Walks declared notifications to produce typed publish helpers used by the bus.

Notable details:

- **METHOD_NOT_FOUND** preserved by walking `WorkerApi.endpoints` at bind time;
  legacy ad-hoc handlers can coexist via a `bindLegacyHandlers(broker, …)` shim
  during migration.
- **Bidirectional**: the host registers `HostApi` as the inbound spec, and
  `worker → host` calls go through `JsonRpcClient.from(HostApi, broker.request)`
  which produces typed `Effect.Effect<Result, HostError>` accessors. So
  `requestCredential`, `displayUpdate`, `signHeartbeat`, etc. become typed
  Effect calls instead of
  `peer.request<HostHeartbeatSignature>("host.deviceHeartbeat.sign", { signedAtMs })`.
- **Retry-on-disconnect semantics** (the broker option already exists) becomes
  `JsonRpcClient.requestRetryOnDisconnect(...)` — typed.
- **Tagged errors** are `Schema.TaggedErrorClass`es, e.g.
  `class RuntimeUnavailable extends Schema.TaggedErrorClass<…>()("JsonRpcError.RuntimeUnavailable", { … }) {}`.
  Error code mapping (`RPC_ERROR_CODES.RUNTIME_UNAVAILABLE = -32801` etc.) is
  preserved from `runtime/protocol/index.ts`.

This is the **only major new abstraction we are introducing that opencode didn't
already give us**. Everything else is paste-and-rename.

---

## 3. Service-by-service mapping (kernel)

Each row: **what's there today** → **what it becomes** → **dependencies (the `R`
in `Effect.Effect<A, E, R>`)**.

| Today | Effect Service | Provides | Depends on |
|---|---|---|---|
| `runtime/kernel/extensions/hook-emitter.ts` | `Hooks` (`@stella/Hooks`) | `register` / `emit` / `emitAll` / `clearBySource` | none |
| `runtime/kernel/storage/database.ts` + `database-init.ts` | `Storage` (`@stella/Storage`) | `use<T>(fn: (db) => T): Effect<T>` and a `transactional` variant; built once at worker start | none |
| `runtime/kernel/storage/runtime-store.ts` (= `session-store.ts`) | `RuntimeStore` (`@stella/RuntimeStore`) | `loadThreadMessages`, `appendThreadMessage`, `listActiveThreads`, `getOrchestratorReminderState`, `replaceThreadMessages`, …, all returning `Effect` | `Storage`, `Bus` (publishes `localChat.updated`-shaped notifications) |
| `runtime/kernel/storage/run-event-log.ts` | `RunEvents` (`@stella/RunEvents`) | `record(event)` / `resume(runId, fromSeq)` / `subscribe(runId): Stream<RuntimeAgentEventPayload>` / `forget(runId)` | `Storage` |
| `runtime/kernel/agent-runtime/compaction-scheduler.ts` | `Compaction` (`@stella/Compaction`) | `schedule(args): Effect<void>` / `drain(): Effect<void>` (must be awaited on shutdown — see §13 risks) | `RuntimeStore`, `LLM` |
| `runtime/kernel/tools/host.ts` | `Tools` (`@stella/Tools`) | `getToolCatalog`, `executeTool(name, args, ctx, signal): Effect<ToolResult, ToolError>`, `registerExtensionTools`, `killAllShells`, `killShellsByPort`, `shutdown` | `Hooks`, `Storage`, `Provider`, `Memory`, `Convex` |
| `runtime/ai/providers/*.ts` + `runtime/ai/models.ts` | `Provider` (`@stella/Provider`) | `getModel(id)` / `listModels()` / `streamText(input): Stream<StreamEvent, ProviderError>` | `Convex` (for the Stella-hosted gateways) |
| `runtime/kernel/runner/convex-session.ts` | `Convex` (`@stella/Convex`) | `setUrl`, `setAuthToken`, `setHasConnectedAccount`, `query(ref, args)`, `action(ref, args)`, `subscribeQuery(ref, args)`, `webSearch` | none (lifecycle only) |
| `runtime/kernel/agents/agents.ts` | `Agent` (`@stella/Agent`) | `list()`, `get(id)`, `defaultAgent()` (mirrors opencode's Agent service) | `Storage` (loads parsed agents from disk) |
| `runtime/kernel/agent-runtime/orchestrator-session.ts` + `subagent-session.ts` | `Session` (`@stella/Session`) | `getOrCreateOrchestrator(conversationId): Effect<OrchestratorSession>`, `runOrchestratorTurn(opts): Stream<RuntimeStreamEvent>`, `runSubagent(opts): Stream<…>`, `disposeAll()` | `Tools`, `Provider`, `LLM`, `RuntimeStore`, `Hooks`, `RunEvents`, `Compaction`, `Memory` |
| `runtime/kernel/agent-runtime/run-execution.ts` + `run-completion.ts` | `LLM` (`@stella/LLM`) | `stream(input): Stream<…>` (mirrors opencode's `LLM` service, including `Stream.scoped` + `Effect.acquireRelease(AbortController)` shape) | `Provider`, `Hooks` |
| `runtime/kernel/runner.ts` (`createStellaHostRunner`) | `Runner` (`@stella/Runner`) — Service shape = `RunnerPublicApi` from `runner/types.ts`, every method returning `Effect` | `start`, `stop`, `handleLocalChat`, `sendMessage`, `runAutomationTurn`, `runBlockingLocalAgent`, `createBackgroundAgent`, `cancelLocalChat`, `getActiveOrchestratorRun`, … | every other service via the merged `WorkerLayer` |
| `runtime/kernel/runner/orchestrator-coordinator.ts` (queued turns) | `TurnCoordinator` (`@stella/TurnCoordinator`) — port opencode's `Runner<A, E>` | `enqueue(turn): Effect<…>`, `cancel`, `state` (Idle / Running / Shell / ShellThenRun) — exactly opencode's `runner.ts` ported | uses Effect's `SynchronizedRef` / `Deferred` / `Latch` / `Fiber` |
| `runtime/kernel/self-mod/*` | `SelfMod` (`@stella/SelfMod`) (with sub-services for HMR controller, contention tracker, feature namer) | `beginRun`, `finalizeRun`, `revertFeature`, `recentFeatures`, `crashRecoveryStatus`, etc. | `RuntimeStore`, `Storage`, `Provider`, `Hooks` |
| `runtime/kernel/memory/*` | `Memory` (`@stella/Memory`) | `readCoreMemory`, `runChronicleSummary`, `triggerDream` | `Storage`, `Provider` |
| `runtime/discovery/*` | `Discovery` (`@stella/Discovery`) | `collectAllSignals`, `collectBrowserData`, `coreMemoryExists`, `writeCoreMemory`, `detectPreferredBrowser`, `listBrowserProfiles` | none (filesystem only) |
| `runtime/worker/voice/service.ts` | `Voice` (`@stella/Voice`) | `persistTranscript`, `orchestratorChat`, `webSearch` | `Runner`, `Provider`, `Convex` |
| `runtime/worker/social-sessions/service.ts` | `SocialSession` (`@stella/SocialSession`) | `createSession`, `updateStatus`, `queueTurn`, `getStatus` | `Runner`, `Storage`, `Convex` |
| `runtime/kernel/local-scheduler-service.ts` | `Schedule` (`@stella/Schedule`) | `listCronJobs`, `addCronJob`, `updateCronJob`, `removeCronJob`, `runCronJob`, heartbeats, conversation events | `Storage`, `Runner` |
| `runtime/kernel/runner/store-operations.ts` + `store-thread-helpers.ts` | `Store` (`@stella/Store`) + `StoreThread` (`@stella/StoreThread`) | publish/install blueprint, list packages/releases, store-thread send/cancel/deny/mark-published | `Storage`, `Convex`, `Runner` |
| `runtime/kernel/extensions/loader.ts` | `Extensions` (`@stella/Extensions`) | `loadAll`, `reloadUserExtensions(); status: "applied" \| "busy"`, `startWatcher` / `stopWatcher` | `Hooks`, `Tools`, `Provider`, `Agent` |

### Host-side services (smaller tree)

| Today | Effect Service |
|---|---|
| `RuntimeHostHandlers.getDeviceIdentity` | `@stella/DeviceIdentity` |
| `RuntimeHostHandlers.signHeartbeatPayload` | `@stella/DeviceIdentity` |
| `RuntimeHostHandlers.requestCredential` | `@stella/Credentials` |
| `RuntimeHostHandlers.requestRuntimeAuthRefresh` | `@stella/RuntimeAuth` |
| `RuntimeHostHandlers.updateDisplay` | `@stella/Display` |
| `RuntimeHostHandlers.showNotification` | `@stella/Notification` |
| `RuntimeHostHandlers.openExternal` | `@stella/System` |
| `RuntimeHostHandlers.showWindow` / `focusWindow` | `@stella/Window` |
| `RuntimeHostHandlers.runHmrTransition` | `@stella/HmrBridge` |

These compose into a `HostLayer` provided by Electron's main process.

---

## 4. The two `ManagedRuntime`s

```ts
// runtime/effect/runtime/bootstrap-runtime.ts — small subset for cold start
export const BootstrapLayer = Layer.mergeAll(
  Storage.defaultLayer,
  Convex.defaultLayer,
  Bus.defaultLayer,
  Hooks.defaultLayer,
  Extensions.defaultLayer,
).pipe(Layer.provide(Observability.layer))

export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer, { memoMap })

// runtime/effect/runtime/app-runtime.ts — full worker
export const WorkerLayer = Layer.mergeAll(
  Storage.defaultLayer,
  Convex.defaultLayer,
  Bus.defaultLayer,
  Hooks.defaultLayer,
  Extensions.defaultLayer,
  Provider.defaultLayer,
  LLM.defaultLayer,
  RuntimeStore.defaultLayer,
  RunEvents.defaultLayer,
  Compaction.defaultLayer,
  Tools.defaultLayer,
  Agent.defaultLayer,
  Session.defaultLayer,
  Memory.defaultLayer,
  Discovery.defaultLayer,
  SelfMod.defaultLayer,
  Schedule.defaultLayer,
  Store.defaultLayer,
  StoreThread.defaultLayer,
  Voice.defaultLayer,
  SocialSession.defaultLayer,
  TurnCoordinator.defaultLayer,
  Runner.defaultLayer,
).pipe(
  Layer.provide(ConversationStore.layer),     // InstanceStore equivalent
  Layer.provide(Observability.layer),
)

const rt = ManagedRuntime.make(WorkerLayer, { memoMap })
export type WorkerServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>

export const WorkerRuntime = wrapWithAttach(rt)
// ↑ mirrors opencode's AppRuntime: every run* wraps via attach()
```

**Critical:** `memoMap` is a single shared `Layer.makeMemoMapUnsafe()` value (in
`runtime/effect/core/memo-map.ts`) shared between `BootstrapRuntime` and
`WorkerRuntime` so any layer needed in both — Storage, Convex, Bus, Hooks,
Extensions — is built **once** for the lifetime of the worker process. This is
exactly the trick opencode uses and is probably the most non-obvious thing the
prior Stella effect tree got wrong.

The host gets its own `HostRuntime` over a much smaller `HostLayer`.
Communication crosses the JSON-RPC boundary, so neither side needs to know about
the other's services.

---

## 5. Per-conversation / per-run state

The flat `Map`s on `RunnerContext.state` (`orchestratorSessions`,
`conversationCallbacks`, `runCallbacksByRunId`, `activeRunAbortControllers`,
`queuedOrchestratorTurns`) all become per-conversation or per-run scoped state.

```ts
// runtime/effect/runtime/conversation-ref.ts
export const ConversationRef = Context.Reference<ConversationContext | undefined>(
  "~stella/ConversationRef",
  { defaultValue: () => undefined },
)
export const RunRef = Context.Reference<RunContext | undefined>(
  "~stella/RunRef",
  { defaultValue: () => undefined },
)

// runtime/effect/services/session/index.ts
export const layer = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const provider = yield* Provider.Service
    const ...

    // Per-conversation orchestrator session, ScopedCache keyed on conversationId.
    const orchestratorSessions = yield* ConversationState.make<OrchestratorSession>(
      Effect.fn("Session.orchestrator")(function*(ctx) {
        const session = new OrchestratorSession(ctx.conversationId)
        yield* Effect.addFinalizer(() => Effect.promise(() => session.dispose()))
        return session
      }),
    )

    // ... runtime-side handlers all use ConversationState.get(orchestratorSessions)
    //     to fetch-or-build the session for the current ConversationRef.

    return Session.Service.of({ runOrchestratorTurn, runSubagent, ... })
  }),
)
```

The `ConversationStore` Service (mirrors opencode's `InstanceStore`) handles
`load(conversationId)` / `dispose(conversationId)` with `Deferred`-deduplicated
in-flight loads, and `provide(conversationId, effect)` runs an effect with
`ConversationRef` provided. Disposers register through a global
`conversation-registry.ts`.

For Stella this is actually simpler than opencode: opencode supports many
directories per process; Stella's worker runs against one `stellaRoot` but many
conversations. The pattern is identical, only the key changes
(`directory` → `conversationId`).

---

## 6. Hooks

Stella's hooks are the most direct deviation from opencode (opencode doesn't
have a hook concept; it uses Service composition). Preserve the existing
`HookEmitter` semantics exactly:

- last-write-wins per event
- special merge-on-`agent_end` (additive object merge, filtering `undefined`)
- short-circuit on `before_tool { cancel: true }`
- `emitAll` for prepend / append composition
- `clearBySource` for F1 reload

Expose it as an Effect Service:

```ts
// runtime/effect/services/hooks/index.ts
export interface Interface {
  readonly emit: <E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: HookFilterContext,
  ) => Effect.Effect<HookEventMap[E]["result"] | undefined>
  readonly emitAll: <E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: HookFilterContext,
  ) => Effect.Effect<HookEventMap[E]["result"][]>
  readonly register: (hook: HookDefinition) => Effect.Effect<void>
  readonly registerAll: (hooks: HookDefinition[]) => Effect.Effect<void>
  readonly clearBySource: (source: "bundled" | "extension") => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@stella/Hooks") {}

export const layer = Layer.effect(Service, Effect.gen(function*() {
  const ref = yield* SynchronizedRef.make<HookDefinition[]>([])
  // emit / register / clearBySource closures over ref
  return Service.of({ emit, emitAll, register, registerAll, clearBySource })
}))
```

Bundled hooks under `runtime/extensions/stella-runtime/hooks/*` become small
`Layer`s that depend on `Hooks.Service` and call `register` in their layer-init
effect. They opt into the additive-merge semantics by returning partial objects
from `agent_end` — same as today.

User-extension hooks loaded by `runtime/effect/services/extensions/index.ts`
register through the same surface. F1 reload calls
`Hooks.clearBySource("extension")` then re-registers.

The migration is **mechanical** for hook files. They keep their shape; only the
registration call site changes.

---

## 7. AI providers + LLM streaming

We do not rewrite the providers. We wrap the call site in an Effect-native
`LLM.Service` whose `stream(input)` returns a `Stream.Stream<StreamEvent, ProviderError>`.

Mirror opencode's `Stream.scoped(Stream.unwrap(Effect.gen(...)))` pattern from
`session/llm.ts:419-433` — this gives us free `AbortController` cleanup on
consumer drop:

```ts
const stream: Interface["stream"] = (input) =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const ctrl = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (ctrl) => Effect.sync(() => ctrl.abort()),
        )

        const result = yield* run({ ...input, abort: ctrl.signal })

        return Stream.fromAsyncIterable(
          result.fullStream,
          (e) => (e instanceof Error ? e : new Error(String(e))),
        )
      }),
    ),
  )
```

`Provider.Service` exposes the resolved-route lookup
(`runtime/kernel/runner/model-selection.ts`) as
`getModel(agentType, override?): Effect<ResolvedLlmRoute, ProviderError>`.
All Stella-provider authentication and retries happen inside the Service.

The migration of `runtime/ai/utils/retry.ts` → opencode-style
`core/util/retry.ts` is a near-paste; keep the same exponential-backoff envelope
(3 fast tries → 64s max, 10 total) the workspace already pins.

For tool schemas (today: zod-style JSON Schema for the AI SDK), lift opencode's
`effect-zod.ts` AST walker into `runtime/effect/core/zod.ts`. Tool definitions
in `runtime/kernel/tools/defs/*` either get rewritten as `Schema.Struct`s and
converted to zod via the walker for the AI-SDK boundary, or they keep their zod
shape and only the Effect Service gates use Schema for protocol payloads. Per
opencode's pattern, **both** end up coexisting.

---

## 8. Schemas

Stella's existing schema surface is fragmented:

- `runtime/protocol/schemas.ts` is small.
- `runtime/contracts/index.ts` is mostly TS-only types.
- `runtime/ai/utils/typebox-helpers.ts` covers AI provider validation.
- Backend `backend/convex/runtime_ai/` has its own zod surface.
- Tool param schemas use JSON Schema literals.

After migration, **protocol payloads** all live as `effect/Schema` modules under
`runtime/effect/api/schemas/*.ts`, with
`.annotate({ identifier: "Stella.<Name>" })` so the JSON-RPC client/server can
produce stable identifiers in errors and OTLP traces. Tagged errors
(`Schema.TaggedErrorClass`) replace the ad-hoc `Error` subclasses in
`runtime/protocol/rpc-peer.ts:RpcError`.

Bus event payloads register the same way opencode's
`BusEvent.define(type, properties)` does — registered in a Map, later collapsed
into a `Schema.Union(...)` for typed subscribers.

For external contracts (Convex, the desktop renderer over IPC), keep
zod-derived schemas using the walker. Rationale: backend uses zod, IPC schemas
in `desktop/src/shared/contracts/` are already zod, and the AI SDK tool-call
surface is zod.

---

## 9. Logging + observability

`runtime/kernel/debug.ts` (`createRuntimeLogger("…")`) becomes a thin shim over
Effect's logger:

```ts
// runtime/effect/core/logger.ts
export const logger = Logger.make((opts) => {
  const extra = clean(opts.fiber.getRef(References.CurrentLogAnnotations))
  // ... lift annotations + spans to JSON
  const log = createRuntimeLogger(extra.service ?? "default")  // existing function
  // dispatch by opts.logLevel
})
export const layer = Logger.layer([logger], { mergeWithExisting: false })
```

Every service method is wrapped in `Effect.fn("Bus.publish")(function*() {...})`
(or `Effect.fnUntraced` for hot paths) so the legacy `runtime/kernel/debug.ts`
log files get tagged spans for free.

`runtime/effect/core/observability.ts` returns either the plain logger layer or
an OTLP layer if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, gated through a
`ConfigService` over `OTEL_*` env vars. This is exactly opencode's
`core/effect/observability.ts:108`.

---

## 10. The cross-boundary plumbing

A handful of small bridges keep legacy code and Effect code interoperable
during migration:

1. **`runtime/effect/runtime/als-bridge.ts`** — Stella uses AsyncLocalStorage
   less than opencode (no `Instance.context` / `WorkspaceContext` equivalents)
   but the renderer-IPC handlers in `desktop/electron/ipc/agent-handlers.ts`
   rely on the per-call conversationId being available implicitly. Add a tiny
   `conversation-als.ts` only if migrations show specific call sites need it.
2. **Legacy peer broker is preserved**: `runtime/worker/peer-broker.ts` keeps
   its current shape. `runtime/effect/jsonrpc/server.ts:bindToBroker(api, broker, handlerLayer)`
   registers Effect-native handlers next to whatever legacy
   `peer.registerRequestHandler(...)` calls still exist. Migration is per-method:
   any method covered by an effect handler is bound through Effect; anything
   not yet covered keeps its legacy registration. The boundary check ensures we
   don't accidentally double-register.
3. **Two-direction client**: the host's outgoing requests
   (`runtime-availability-bridge.ts`, `runtime-host-adapter.ts`) get a typed
   `JsonRpcClient.from(WorkerApi, peer.request)` wrapper. The renderer keeps
   its existing IPC contract — the contract layer is unchanged, only the
   worker-side implementation moves to Effect.
4. **Backend Convex parallel**: the `backend/convex/runtime_ai/` parallel tree
   stays as-is. Stella's `Provider.Service` calls Convex through
   `Convex.Service.action(...)`, which is unchanged from the renderer's
   perspective.

---

## 11. Testing strategy

`vitest.config.ts` gets a separate **`runtime-effect`** project (mirroring the
workspace's prior tree shape), so:

- legacy tests in `desktop/tests/runtime/**` keep running unchanged
- new tests in `runtime/effect/test/**` only have the Effect tree on their
  import path

Two test classes:

**Parity tests** (`runtime/effect/test/parity.ts`, mirrors opencode's prior
layout): construct the legacy implementation, construct the Effect
implementation (via a small `TestLayer` providing fakes), run both with the
same input, assert identical output. Covers:

- `HookEmitter` vs `Hooks.Service` (last-write-wins; merge-on-`agent_end`;
  short-circuit; `emitAll` order)
- `BackgroundCompactionScheduler` vs `Compaction.Service` (active+pending
  coalescing; ordered onSuccess chain; drain semantics)
- `RpcError` envelopes vs `JsonRpcError` Schema-encoded errors
- `OrchestratorSession.runTurn` vs `Session.runOrchestratorTurn`

**Service tests**: standalone tests for new services (`runtime-state.test.ts`,
`bus.test.ts`, etc.) that run them under a `ManagedRuntime.make(TestLayer)`.

---

## 12. Boundary script

Extend `runtime/scripts/check-boundary.mjs` to enforce **both** directions:

- `runtime/**` (legacy) cannot import `runtime/effect/**`
- `runtime/effect/**` cannot re-export legacy modules under their original names

Same fence opencode-spec used and that the prior Stella effect tree had. Add
`runtime/effect/scripts/check-boundary.mjs` and wire it into the root
`check:boundary` script in `package.json`.

The renderer (`desktop/src/`) and the legacy `runtime/**` tree must remain
strictly separated from `runtime/effect/**` until each service's migration
milestone replaces its legacy counterpart.

---

## 13. Risks / non-trivial decisions

1. **Effect 4 is beta.** Pinning to the same beta as opencode keeps the
   vendored reference snapshots compiling. When upgrading, upgrade both Stella
   and `runtime/effect/specs/*.ts` together.
2. **Two runtimes vs. one.** Stella's worker initializes Convex + extensions
   before the runner is ready — two runtimes is the right shape (matches
   opencode).
3. **`memoMap` sharing.** Easy to forget. The prior tree may have made each
   runtime build its own dependencies. **Share one `Layer.makeMemoMapUnsafe()`
   value across both runtimes.**
4. **`Stream` vs `EventEmitter` for the host's typed events.** Two options:
   keep `RuntimeHost extends EventEmitter` and have it forward from a `Stream`
   internally (zero churn for Electron consumers), or migrate consumers to
   `Stream`. **M9 picks the former** — the renderer-side IPC contract doesn't
   change.
5. **Hooks merge semantics.** The `agent_end` additive-merge rule is non-obvious
   and easy to break under last-write-wins. Parity tests in M3 lock this down.
6. **`Effect.fn` tracing overhead.** Opencode wraps everything in
   `Effect.fn("Module.method")(...)` for OTLP spans. When OTel is off this is
   essentially free. Do the same; for hot-path internal helpers use
   `Effect.fnUntraced` (matches opencode's convention).
7. **Mid-stream cancellation.** Opencode's
   `Stream.scoped + Effect.acquireRelease(AbortController)` shape gives us free
   upstream cancellation when a consumer drops the stream. The existing
   `activeRunAbortControllers` Map can go away once `Session.Service` returns
   Streams instead of "fire-and-forget plus a side-Map of controllers".
8. **JSON-RPC bidirectional client typing.** The only piece without a direct
   opencode template, so the design space is open. The client side walks the API
   and produces typed `request` / `notify` accessors — straightforward but worth
   a careful first pass since every host→worker call site reads through it.
9. **No backwards-compat shims.** Stella has no live users. Hard-cut each
   method instead of dual-writing. Migration milestones are sized so each can
   fully replace its legacy code at the end of its PR.
10. **`Compaction.drain()` MUST be awaited on shutdown.** The existing
    `BackgroundCompactionScheduler.drain()` semantics around session-stale
    notifications must be preserved — return a real `Promise<void>` (resolved
    after all in-flight + pending compactions complete) from the
    `Compaction.Service` Effect equivalent. Parity tests must cover this.

---

## 14. Migration milestones

Fine-grained so each milestone leaves the worker in a runnable state.

### M0 — foundation (no behavior change)

- Create `runtime/effect/` shadow tree with `core/`, `runtime/`, `specs/`, and
  the boundary check.
- Vendor opencode references into `runtime/effect/specs/` (paste-only, no edits).
- Add `runtime-effect` vitest project to `vitest.config.ts`.
- Land `core/memo-map.ts`, `core/runtime.ts`, `core/observability.ts`,
  `core/logger.ts`, `core/service-use.ts`, `core/config-service.ts`,
  `core/zod.ts` — paste-and-rename from opencode.
- Smoke test: `BootstrapRuntime` starts and shuts down; logger lines reach the
  existing debug.ts files.

### M1 — JSON-RPC analog of `effect/unstable/httpapi`

- Implement `runtime/effect/jsonrpc/{api,group,endpoint,builder,error,server,client}.ts`
  from scratch, with type-level inference parity against opencode's HttpApi
  shape. **Read `node_modules/effect/dist/**/unstable/httpapi/**` for surface
  reference.**
- Land tests under `runtime/effect/test/jsonrpc.test.ts` covering: handler
  dispatch, schema-driven param/result encoding, METHOD_NOT_FOUND, typed
  errors, notification fan-out, the legacy `bindLegacyHandlers` shim.
- No worker code uses it yet.

### M2 — first slice through the surface: `runtime.health` + `run.ackEvents`

- Define `Schema` modules for `RuntimeHealthSnapshot`, `RuntimeAgentEventPayload`,
  `RunResumeEventsResult`, etc.
- Define `LifecycleGroup` and `RunGroup` (skeleton).
- Implement the smallest two handlers as `runHandlers = JsonRpcBuilder.group(...)`.
- `bindToBroker(WorkerApi, broker, runHandlersLayer)` runs alongside legacy
  registrations.
- Hard-cut: legacy `peer.registerRequestHandler(METHOD_NAMES.RUN_HEALTH_CHECK, …)`
  and `RUN_ACK_EVENTS` are removed.
- Both directions of `runtime/host/index.ts`'s typed event emitter for these
  endpoints are preserved.

### M3 — `Storage` + `Bus` + `Hooks` + `Convex` + `Extensions` services

- Migrate the five "always-needed" services. They have few dependencies and
  are touched by everything downstream, so doing them early gives every later
  service something to depend on.
- Bundled-hook files under `runtime/extensions/stella-runtime/hooks/*` become
  small Layers depending on `Hooks.Service`.
- F1 reload (extension watcher) moves into `Extensions.Service`.

### M4 — `RuntimeStore`, `RunEvents`, `Compaction`

- Three storage-side services; modest fan-out.
- Replace `RunnerContext.state.compactionScheduler` with
  `Compaction.Service.schedule(...)`.
- Verify `BackgroundCompactionScheduler.drain()` parity.
- Run `runtime/effect/test/compaction.test.ts` parity tests.

### M5 — `Provider`, `LLM`, `Tools`

- Wrap `runtime/ai/providers/*` behind `Provider.Service`.
- `LLM.Service.stream(input)` returns `Stream<StreamEvent, ProviderError>` —
  opencode's exact `Stream.scoped(Stream.unwrap(...))` shape.
- `Tools.Service` wraps `runtime/kernel/tools/host.ts` and the per-extension
  tool registration.
- This is the largest single milestone — both because of the surface area and
  because it's the path the LLM stream takes to the user.

### M6 — `Agent`, `Session`, `TurnCoordinator`

- Port opencode's `Runner<A, E>` (`runtime/effect/services/turn-coordinator/runner.ts`)
  — direct paste with renamed types.
- Move `OrchestratorSession` and `SubagentSession` behind `Session.Service`.
- Replace flat maps on `RunnerContext.state` with `ConversationState.make` +
  `RunState.make` scoped caches.

### M7 — `Memory`, `SelfMod`, `Discovery`, `Schedule`, `Voice`, `SocialSession`, `Store`, `StoreThread`

- Each is a self-contained Service migration; can be parallelized across
  separate PRs.
- After each lands, the corresponding handlers in `runtime/worker/server.ts`
  move from legacy `peer.registerRequestHandler(...)` to `JsonRpcBuilder.group`.

### M8 — `Runner` (the top-level entry point)

- `Runner.Service` becomes the orchestrator that ties M3–M7 together.
- `runtime/kernel/runner.ts:createStellaHostRunner` is reduced to a thin compat
  shim (eventually deleted). The `RunnerPublicApi` is now exposed by
  `Runner.Service`.
- `runtime/worker/server.ts` becomes a thin file that builds `WorkerLayer`,
  calls `bindToBroker(WorkerApi, broker, allHandlersLayer)`, and registers
  lifecycle / shutdown wiring.

### M9 — host side (`HostApi` + `HostLayer`)

- Mirror M8 for the Electron-side: `runtime/effect/host-handlers/*.ts` register
  against `HostApi`, the renderer-side IPC is untouched, but
  `runtime/host/index.ts` shrinks to a thin wrapper around
  `HostRuntime.runPromise(...)`.

### M10 — cleanup

- Delete `HookEmitter` class once all sites use `Hooks.Service`.
- Delete `BackgroundCompactionScheduler` once `Compaction.Service` is the only
  path.
- Delete `WorkerPeerBroker.registerRequestHandler` once every method is bound
  through `JsonRpcBuilder` (the broker stays for transport + multi-host fan-out,
  but its API surface narrows).
- Drop the `RunnerContext` mega-struct.

---

## 15. What this buys us (concretely)

- **Layer composition** — adding a new service (e.g. a future "Energy" tracker)
  is one file: declare interface, implement layer, add to `WorkerLayer`. Today
  the same change touches `RunnerContext.state` + `createStellaHostRunner` +
  `runner/types.ts` + every constructor that needs it.
- **`InstanceState`-style scoped caches** — `OrchestratorSession` lifecycle
  becomes "register a finalizer" instead of "remember to call `.dispose()` from
  `runtime-initialization.ts:stop`". Per-run/per-conversation state leaks go
  away by construction.
- **Free OTel** — every `Effect.fn` call site is a span. No
  `createRuntimeLogger("…")` ceremony at the top of every file.
- **Typed JSON-RPC** — METHOD_NAMES + ad-hoc payload casts collapse into one
  Schema-driven API value that produces both a server (via `JsonRpcBuilder`) and
  a client (via `JsonRpcClient.from`). Renames flow through TypeScript.
- **Stream-native streaming** — `Run.event` notifications and `LLM.stream`
  outputs become real `Stream`s; resumeRunEvents + the per-run cap
  (~2000 events / 1800 floor / 15-min TTL) is just `Stream.bufferSliding`
  config.
- **`memoMap` singleton sharing** — bootstrap and full-app runtime share
  Convex/Storage/Bus without anyone having to remember.
- **Service tests over fakes** — `Layer.succeed(Foo.Service, fakeFoo)` lets us
  test `Session.Service` without spinning a SQLite database, a Convex client,
  and a real Pi Agent.
- **`Effect.fn` typed errors** — typed
  `JsonRpcError.RuntimeUnavailable | StorageError | ProviderError` in the
  handler signature instead of "any error becomes RpcError(INTERNAL_ERROR)".

---

## 16. Implementation guidance

- **Read opencode first, code second.** Every pattern in this document has a
  direct reference at one of the paths in §1. Open the file, read it, then
  paste-and-rename. Do not "improve" the pattern on the first pass — get parity,
  then iterate.
- **`node_modules/effect/dist/` is the source of truth for the Effect API
  surface.** The beta API drifts between minor versions; if a signature here
  disagrees with what's in node_modules, node_modules wins. Update this doc
  rather than fight the types.
- **One Service = one folder.** `runtime/effect/services/<name>/index.ts`
  exports `Service`, `Interface`, `layer`, and `defaultLayer`. Big services
  (`Session`, `Runner`, `Tools`) get sibling files for state, helpers, and
  per-conversation logic — but the public surface stays one barrel.
- **`Service.of({...})` at the end of every `layer = Layer.effect(...)`.**
  Opencode does this consistently; it's how the type-level interface check fires
  at construction. Don't skip it.
- **Refer to opencode's `Effect.fn` naming convention.** `"Bus.publish"`,
  `"Session.runTurn"`, `"InstanceStore.boot"`. `<ServiceName>.<methodName>` with
  no prefix. Hot paths (per-event, per-tool-call) use `Effect.fnUntraced`.
- **Don't reach for `Layer.scoped` until you need it.** Most Services are
  `Layer.effect(Service, Effect.gen(...))`. Use scoped only for services whose
  init effect itself needs scope (e.g. opens a file handle that must close
  with the layer).
- **Per-conversation state never lives on the top-level layer.** Always behind
  `ConversationState.make(...)`. If you find yourself adding a
  `Map<conversationId, X>` field to a Service, stop and reach for
  `ConversationState` instead.
- **Hooks are observation-or-modification, never persistence.** If a hook needs
  to write SQLite, it does it through `Storage.Service` / `RuntimeStore.Service`
  yielded via the `RuntimeRunServices` payload on `agent_end`. Don't import
  storage modules directly into hook files.
- **Tests under `runtime/effect/test/` use a `TestLayer` composing
  `Layer.succeed(Foo.Service, fake)` for every dependency.** Don't reach into
  the real layer graph for unit tests; use it only for integration parity tests.
- **When in doubt, ask the user.** This doc is the plan; if reality diverges
  (an opencode pattern doesn't fit, a Schema shape needs a discriminator, a
  Service genuinely needs a different lifecycle), stop and surface the question
  rather than papering over.

---

## 17. Suggested first PR

`M0` + `M1` together: the foundation files plus the JSON-RPC analog with tests.
After that lands, the second PR (`M2`) is a proof-of-life: two real handlers
running through the Effect path next to all the existing legacy ones, with the
boundary check enforcing isolation.
