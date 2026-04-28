import { loadBundledAgents } from "../agents/agents.js";
import { loadExtensions } from "../extensions/loader.js";
import { loadGoogleWorkspaceTools } from "../google-workspace/load-google-workspace-tools.js";
import { registerModel } from "../../ai/models.js";
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
      stellaRoot: context.stellaStatePath,
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

  const initializeRuntime = () => {
    const extensionsLoad = loadExtensions(context.paths.extensionsPath)
      .then((extensions) => {
        context.state.loadedAgents =
          extensions.agents.length > 0 ? extensions.agents : loadBundledAgents();
        context.hookEmitter.registerAll(extensions.hooks);
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
          }
          logger.info(
            `extensions.provider.registered.${providerDef.name}`,
            {
              modelCount: providerDef.models.length,
            },
          );
        }
        logger.info("extensions.ready", {
          tools: extensions.tools.length,
          hooks: extensions.hooks.length,
          providers: extensions.providers.length,
          prompts: extensions.prompts.length,
        });
      })
      .catch((error) => {
        context.state.loadedAgents = loadBundledAgents();
        console.error(
          "[stella:extensions] Failed to load extensions:",
          (error as Error).message,
        );
      });

    context.state.initializationPromise = Promise.all([extensionsLoad]).then(() => {
      context.state.isInitialized = true;
    });

    return context.state.initializationPromise;
  };

  const start = () => {
    if (context.state.isRunning) return;
    context.state.isRunning = true;
    context.state.isInitialized = false;
    void initializeRuntime();
  };

  const stop = () => {
    logger.warn("runner.stop", {
      activeOrchestratorRunId: context.state.activeOrchestratorRunId,
      activeAbortControllers: context.state.activeRunAbortControllers.size,
      conversationCallbacks: context.state.conversationCallbacks.size,
      runCallbacksByRunId: context.state.runCallbacksByRunId.size,
    });
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
    context.state.queuedOrchestratorTurns.length = 0;
    context.state.activeToolExecutionCount = 0;
    context.state.interruptAfterTool = false;
    context.state.activeInterruptedReplayTurn = null;
    for (const controller of context.state.activeRunAbortControllers.values()) {
      controller.abort();
    }
    context.state.activeRunAbortControllers.clear();
    context.state.conversationCallbacks.clear();
    context.state.runCallbacksByRunId.clear();
    context.state.interruptedRunIds.clear();
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
  };

  return {
    ensureGoogleWorkspaceToolsLoaded,
    initializeRuntime,
    start,
    stop,
  };
};
