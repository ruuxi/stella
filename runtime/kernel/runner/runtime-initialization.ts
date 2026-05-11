import { watch as fsWatch, type FSWatcher } from "node:fs";
import { loadBundledAgents } from "../agents/agents.js";
import { loadExtensions } from "../extensions/loader.js";
import type { ExtensionServices } from "../extensions/services.js";
import { loadGoogleWorkspaceTools } from "../google-workspace/load-google-workspace-tools.js";
import { fetchAndRegisterModelsDevDirectProviderModels } from "../../ai/models-dev.js";
import { registerModel, unregisterModel } from "../../ai/models.js";
import type { Api, Model } from "../../ai/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunnerContext } from "./types.js";

const logger = createRuntimeLogger("runtime-init");

export const createRuntimeInitialization = (
  context: RunnerContext,
  deps: {
    disposeConvexClient: () => void;
    shutdownTasks: () => void;
    onGoogleWorkspaceAuthRequired?: () => void;
  },
) => {
  let googleWorkspaceToolsLoadPromise: Promise<void> | null = null;
  let googleWorkspaceToolsLoadGeneration = 0;

  const ensureGoogleWorkspaceToolsLoaded = async () => {
    if (
      context.state.googleWorkspaceCallTool ||
      context.state.googleWorkspaceToolsLoaded
    ) {
      return;
    }
    if (googleWorkspaceToolsLoadPromise) {
      await googleWorkspaceToolsLoadPromise;
      return;
    }

    const loadGeneration = googleWorkspaceToolsLoadGeneration;
    const loadPromise = loadGoogleWorkspaceTools({
      stellaRoot: context.stellaRoot,
      onAuthRequired: deps.onGoogleWorkspaceAuthRequired,
      onAuthStateChanged: (authenticated) => {
        context.state.googleWorkspaceAuthenticated = authenticated;
      },
    })
      .then(async ({ disconnect, callTool, hasStoredCredentials }) => {
        if (
          loadGeneration !== googleWorkspaceToolsLoadGeneration ||
          !context.state.isRunning
        ) {
          await disconnect().catch(() => undefined);
          return;
        }

        context.state.googleWorkspaceDisconnect = disconnect;
        context.state.googleWorkspaceCallTool = callTool;
        context.state.googleWorkspaceToolsLoaded = true;

        // Google Workspace tools are not registered on the agent tool host.
        // IPC (Settings connect card) still uses callTool above.

        // Seed auth state from stored credentials so the UI can show
        // "Connected" without probing an auth-dependent tool call.
        if (hasStoredCredentials) {
          context.state.googleWorkspaceAuthenticated = true;
        }
      })
      .catch((error) => {
        console.error(
          "[stella:google-workspace] Failed to load:",
          (error as Error).message,
        );
        if (loadGeneration === googleWorkspaceToolsLoadGeneration) {
          context.state.googleWorkspaceToolsLoaded = true;
        }
      })
      .finally(() => {
        if (googleWorkspaceToolsLoadPromise === loadPromise) {
          googleWorkspaceToolsLoadPromise = null;
        }
      });

    googleWorkspaceToolsLoadPromise = loadPromise;
    await loadPromise;
  };

  /**
   * Tracks which (provider, modelId) pairs were registered by the most
   * recent extension load. The F1 reload path sweeps this list via
   * `unregisterModel` AFTER the new disk read finishes, so deleted /
   * renamed extension models don't linger in the runtime registry. The
   * model registry itself has no concept of "extension-origin" — a
   * removed extension that simply stopped exporting a model would
   * otherwise keep it bound to a stale handler until worker restart.
   *
   * Built-in models are never recorded here; only models registered
   * through the install step below.
   */
  let extensionRegisteredModels: Array<{
    provider: string;
    modelId: string;
  }> = [];

  /**
   * Keep extension registry swaps synchronous so the orchestrator queue never
   * observes a partially installed extension set.
   */
  const installLoadedExtensions = (
    extensions: Awaited<ReturnType<typeof loadExtensions>>,
  ): void => {
    context.state.loadedAgents =
      extensions.agents.length > 0 ? extensions.agents : loadBundledAgents();
    for (const hook of extensions.hooks) {
      // Force `source: "extension"` even if the disk-loaded hook
      // declared something else. Bundled hooks register through
      // `registerBundledHooks` (a separate code path that runs at
      // worker startup), so anything coming out of `loadExtensions`
      // is by definition user-installable. Without this clamp, a
      // hook that exported `{ source: "bundled", ... }` would survive
      // every subsequent `clearBySource("extension")` sweep and
      // accumulate duplicate registrations on each F1 reload.
      context.hookEmitter.register({
        ...hook,
        source: "extension",
      });
    }
    context.toolHost.registerExtensionTools(extensions.tools);

    for (const providerDef of extensions.providers) {
      for (const modelDef of providerDef.models) {
        const model: Model<Api> = {
          id: modelDef.id,
          name: modelDef.name,
          api: providerDef.api as Api,
          provider: providerDef.name,
          baseUrl: providerDef.baseUrl,
          reasoning: modelDef.reasoning ?? false,
          input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
          cost: {
            input: modelDef.cost?.input ?? 0,
            output: modelDef.cost?.output ?? 0,
            cacheRead: modelDef.cost?.cacheRead ?? 0,
            cacheWrite: modelDef.cost?.cacheWrite ?? 0,
          },
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers: providerDef.headers,
        };
        registerModel(providerDef.name, model);
        extensionRegisteredModels.push({
          provider: providerDef.name,
          modelId: modelDef.id,
        });
      }
      logger.info(`extensions.provider.registered.${providerDef.name}`, {
        modelCount: providerDef.models.length,
      });
    }
    logger.info("extensions.ready", {
      tools: extensions.tools.length,
      hooks: extensions.hooks.length,
      providers: extensions.providers.length,
      prompts: extensions.prompts.length,
    });
  };

  /**
   * Build the runtime services object once. Forwarded to every extension
   * factory invocation (initial load + every F1 reload) so factories can
   * close over the services they need at registration time. Today the
   * runner stores both the repo root and the user-data root under
   * `context.stellaRoot`; when the user-data root migrates to `~/.stella`
   * the `stellaHome` field will diverge.
   */
  const buildExtensionServices = (): ExtensionServices => ({
    stellaHome: context.stellaRoot,
    stellaRoot: context.stellaRoot,
    selfModMonitor: context.selfModMonitor ?? null,
    store: context.runtimeStore,
    memoryStore: context.runtimeStore.memoryStore,
  });

  /**
   * Load extensions from disk and register hooks/tools/providers/agents.
   * Used by initial startup. The F1 reload path uses
   * `loadExtensions` + `installLoadedExtensions` directly so it can
   * sandwich the sweep+install inside one synchronous block.
   */
  const loadAndRegisterExtensions = async (): Promise<void> => {
    try {
      const extensions = await loadExtensions(
        context.paths.extensionsPath,
        buildExtensionServices(),
      );
      installLoadedExtensions(extensions);
    } catch (error) {
      context.state.loadedAgents = loadBundledAgents();
      console.error(
        "[stella:extensions] Failed to load extensions:",
        (error as Error).message,
      );
    }
  };

  const loadAndRegisterModelsDevCatalog = async (): Promise<void> => {
    try {
      const registered = await fetchAndRegisterModelsDevDirectProviderModels();
      logger.info("models-dev.ready", { registered });
    } catch (error) {
      logger.warn("models-dev.load-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const initializeRuntime = () => {
    // Stella's lifecycle hooks (personality, self-mod, …) live in the
    // stella-runtime extension and register through the same loader path
    // as user extensions. There's no separate "bundled" registration
    // step — the loader is the one place hooks/tools/providers/agents
    // get installed. Stella-runtime is just an extension that ships in
    // the source tree.
    const extensionsLoad = loadAndRegisterExtensions();
    const modelsDevLoad = loadAndRegisterModelsDevCatalog();

    context.state.initializationPromise = Promise.all([
      extensionsLoad,
      modelsDevLoad,
    ]).then(() => {
      context.state.isInitialized = true;
    });

    return context.state.initializationPromise;
  };

  /**
   * F1: idle gate for the hot-reload path. A reload is safe when no
   * orchestrator session is streaming and no subagent task is running.
   * Returns the first reason the runtime is busy so callers can log /
   * retry intelligently.
   */
  const computeBusyReason = (): string | null => {
    if (context.state.activeOrchestratorRunId) {
      return `orchestrator run ${context.state.activeOrchestratorRunId} is active`;
    }
    // Long-lived `OrchestratorSession`s are intentionally NOT a busy
    // signal: the underlying Pi Agent is idle between turns, and
    // hot-reloaded extensions don't need it torn down — the next
    // `runTurn` picks up the new tool catalog / hooks naturally. The
    // only orchestrator-side busy condition is an active run, gated
    // above by `activeOrchestratorRunId`.
    const activeAgents =
      context.state.localAgentManager?.getActiveAgentCount() ?? 0;
    if (activeAgents > 0) {
      return `${activeAgents} subagent task${
        activeAgents === 1 ? "" : "s"
      } running`;
    }
    return null;
  };

  /**
   * F1 entry point. Idle-checks, sweeps user-extension hooks/tools, and
   * re-runs the loader. Bundled hooks and built-in tools are untouched.
   * Returns one of:
   *   - "reloaded"        success
   *   - "busy"            runtime is mid-run; caller may retry on idle
   *   - "not-initialized" runtime hasn't finished startup yet
   *   - "load-failed"     disk read failed; old extensions stay live and
   *                       `reason` carries the underlying error message
   *                       so callers (UI, IPC) can surface it instead of
   *                       silently treating it as a successful reload.
   */
  const reloadUserExtensions = async (): Promise<{
    status: "reloaded" | "busy" | "not-initialized" | "load-failed";
    reason?: string;
  }> => {
    if (!context.state.isInitialized) {
      return { status: "not-initialized" };
    }
    const busyReason = computeBusyReason();
    if (busyReason) {
      logger.info("extensions.reload.deferred", { reason: busyReason });
      return { status: "busy", reason: busyReason };
    }
    logger.info("extensions.reload.start");
    // Load-then-swap to keep the reload atomic w.r.t. the orchestrator
    // queue. If we swept first and awaited the disk load between sweep
    // and install, a user message landing during the await would
    // dequeue against an empty extension registry: missing tools,
    // missing extension-provided model providers, mid-flight provider
    // resolution failing over to fallbacks. Doing the disk read FIRST
    // (the only async step) means the OLD registry stays intact during
    // I/O; only the synchronous sweep+install block below mutates live
    // state, and the orchestrator queue can't slip a turn into the
    // middle of a synchronous block.
    let extensions: Awaited<ReturnType<typeof loadExtensions>>;
    try {
      extensions = await loadExtensions(
        context.paths.extensionsPath,
        buildExtensionServices(),
      );
    } catch (error) {
      // Disk-read failure: leave the old extension state in place. The
      // initial-load behavior of falling back to bundled agents only
      // applies to startup; a partial reload that wipes the running
      // registry would be worse than no reload. Surface the failure
      // distinctly from "reloaded" so the watcher's busy-retry loop
      // doesn't masquerade a persistent disk problem as success and so
      // any future UI-driven reload affordance can show the error.
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("extensions.reload.load-failed", { error: reason });
      return { status: "load-failed", reason };
    }
    // Synchronous swap: clear old + install new in one block. No
    // awaits between these statements.
    context.hookEmitter.clearBySource("extension");
    context.toolHost.unregisterExtensionTools();
    const previouslyRegistered = extensionRegisteredModels;
    extensionRegisteredModels = [];
    for (const entry of previouslyRegistered) {
      try {
        unregisterModel(entry.provider, entry.modelId);
      } catch (error) {
        logger.warn("extensions.reload.unregister-model-failed", {
          provider: entry.provider,
          modelId: entry.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    installLoadedExtensions(extensions);
    logger.info("extensions.reload.done");
    return { status: "reloaded" };
  };

  /**
   * F1 file watcher. Debounces filesystem events on the extensions
   * directory and calls `reloadUserExtensions`. If the runtime is busy
   * when a change lands, the watcher schedules a retry on a short timer
   * so the reload eventually applies after the in-flight run completes.
   */
  let extensionWatcher: FSWatcher | null = null;
  let extensionDebounce: NodeJS.Timeout | null = null;
  let extensionRetry: NodeJS.Timeout | null = null;
  const FILE_WATCH_DEBOUNCE_MS = 500;
  const RELOAD_BUSY_RETRY_MS = 2_000;

  const scheduleExtensionReload = () => {
    if (extensionDebounce) {
      clearTimeout(extensionDebounce);
    }
    extensionDebounce = setTimeout(() => {
      extensionDebounce = null;
      void (async () => {
        const result = await reloadUserExtensions();
        if (result.status === "busy") {
          if (extensionRetry) clearTimeout(extensionRetry);
          extensionRetry = setTimeout(() => {
            extensionRetry = null;
            scheduleExtensionReload();
          }, RELOAD_BUSY_RETRY_MS);
        }
      })();
    }, FILE_WATCH_DEBOUNCE_MS);
  };

  const startExtensionWatcher = () => {
    if (extensionWatcher) return;
    try {
      extensionWatcher = fsWatch(
        context.paths.extensionsPath,
        { recursive: true },
        (_eventType, filename) => {
          // Ignore renames into the directory of dotfiles / build
          // artifacts. The loader filters by suffix anyway, but
          // skipping early reduces wakeups.
          if (
            filename &&
            (filename.startsWith(".") || filename.endsWith("~"))
          ) {
            return;
          }
          scheduleExtensionReload();
        },
      );
      extensionWatcher.on("error", (error) => {
        logger.warn("extensions.watch.error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("extensions.watch.started", {
        path: context.paths.extensionsPath,
      });
    } catch (error) {
      logger.warn("extensions.watch.start-failed", {
        error: error instanceof Error ? error.message : String(error),
        path: context.paths.extensionsPath,
      });
    }
  };

  const stopExtensionWatcher = () => {
    if (extensionDebounce) {
      clearTimeout(extensionDebounce);
      extensionDebounce = null;
    }
    if (extensionRetry) {
      clearTimeout(extensionRetry);
      extensionRetry = null;
    }
    if (extensionWatcher) {
      try {
        extensionWatcher.close();
      } catch {
        // Best-effort.
      }
      extensionWatcher = null;
    }
  };

  const start = () => {
    if (context.state.isRunning) return;
    context.state.isRunning = true;
    context.state.isInitialized = false;
    void initializeRuntime().finally(() => {
      // Start the extensions watcher only after initial load completes,
      // so we don't race with the first registration.
      startExtensionWatcher();
    });
  };

  /**
   * Hard cap on how long shutdown will wait for background compactions
   * to settle. Cracked summarization LLM calls or network stalls would
   * otherwise pin the worker indefinitely; after this deadline we
   * proceed with SQLite teardown and any unfinished compaction's write
   * will fail-and-log against the closed handle (the run was already
   * "fire-and-forget" from the user's POV — it had nothing to lose).
   */
  const COMPACTION_DRAIN_TIMEOUT_MS = 5_000;

  const drainCompactionsWithTimeout = async (): Promise<void> => {
    const drain = context.state.compactionScheduler.drain();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), COMPACTION_DRAIN_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        drain.then(() => "drained" as const),
        timeout,
      ]);
      if (result === "timeout") {
        logger.warn("compaction-scheduler.drain-timeout", {
          timeoutMs: COMPACTION_DRAIN_TIMEOUT_MS,
        });
      }
    } catch (error) {
      logger.warn("compaction-scheduler.drain-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const stop = async (): Promise<void> => {
    logger.warn("runner.stop", {
      activeOrchestratorRunId: context.state.activeOrchestratorRunId,
      activeAbortControllers: context.state.activeRunAbortControllers.size,
      conversationCallbacks: context.state.conversationCallbacks.size,
      runCallbacksByRunId: context.state.runCallbacksByRunId.size,
    });
    stopExtensionWatcher();
    googleWorkspaceToolsLoadGeneration += 1;
    googleWorkspaceToolsLoadPromise = null;
    context.state.isRunning = false;
    context.state.isInitialized = false;
    context.state.initializationPromise = null;
    deps.disposeConvexClient();
    deps.shutdownTasks();
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.activeOrchestratorUiVisibility = "visible";
    context.state.activeOrchestratorSession = null;
    // Tear down all long-lived per-conversation orchestrator sessions
    // (E1). Each session disposes its underlying Pi `Agent` so message
    // arrays + closures get reclaimed; future startups rebuild them lazily
    // when the next turn lands.
    for (const session of context.state.orchestratorSessions.values()) {
      try {
        session.dispose();
      } catch (error) {
        logger.warn("orchestrator-session.dispose-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    context.state.orchestratorSessions.clear();
    context.state.queuedOrchestratorTurns.length = 0;
    for (const controller of context.state.activeRunAbortControllers.values()) {
      controller.abort();
    }
    context.state.activeRunAbortControllers.clear();
    context.state.conversationCallbacks.clear();
    context.state.runCallbacksByRunId.clear();
    void context.selfModHmrController?.forceResumeAll();
    context.toolHost.killAllShells();
    const disconnectGoogleWorkspace = context.state.googleWorkspaceDisconnect;
    context.state.googleWorkspaceDisconnect = null;
    context.state.googleWorkspaceCallTool = null;
    context.state.googleWorkspaceToolsLoaded = false;
    context.state.googleWorkspaceAuthenticated = null;
    if (disconnectGoogleWorkspace) {
      void disconnectGoogleWorkspace().catch(() => undefined);
    }
    // Drain any in-flight background compactions so SQLite writes
    // complete before the worker tears down its store handle. Bounded
    // timeout ensures shutdown doesn't pin on a stalled LLM call.
    await drainCompactionsWithTimeout();
  };

  return {
    ensureGoogleWorkspaceToolsLoaded,
    initializeRuntime,
    reloadUserExtensions,
    start,
    stop,
  };
};
