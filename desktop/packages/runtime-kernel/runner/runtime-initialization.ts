import { loadAgentsFromHome } from "../agents/agents.js";
import { loadExtensions } from "../extensions/loader.js";
import { loadGoogleWorkspaceMcpTools } from "../mcp/google-workspace-mcp.js";
import { registerModel } from "../../ai/models.js";
import type { Api, Model } from "../../ai/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunnerContext } from "./types.js";

const logger = createRuntimeLogger("runtime-init");

export const createRuntimeInitialization = (
  context: RunnerContext,
  deps: {
    refreshLoadedSkills: () => Promise<unknown>;
    disposeConvexClient: () => void;
    syncRemoteTurnBridge: () => void;
    shutdownTasks: () => void;
    onGoogleWorkspaceAuthRequired?: () => void;
  },
) => {
  const initializeRuntime = () => {
    const skillsLoad = deps.refreshLoadedSkills().then(() => undefined).catch(() => undefined);
    const agentsLoad = loadAgentsFromHome(context.paths.agentsPath)
      .then((agents) => {
        context.state.loadedAgents = agents;
      })
      .catch(() => {
        context.state.loadedAgents = [];
      });
    const extensionsLoad = loadExtensions(context.paths.extensionsPath)
      .then((extensions) => {
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
        console.error(
          "[stella:extensions] Failed to load extensions:",
          (error as Error).message,
        );
      });

    const googleWorkspaceMcpLoad = loadGoogleWorkspaceMcpTools({
      frontendRoot: context.frontendRoot,
      stellaHomePath: context.stellaHomePath,
      onAuthRequired: deps.onGoogleWorkspaceAuthRequired,
      onAuthStateChanged: (authenticated) => {
        context.state.googleWorkspaceMcpAuthenticated = authenticated;
      },
    })
      .then(async ({ tools, disconnect, callTool, hasStoredCredentials }) => {
        context.state.googleWorkspaceMcpDisconnect = disconnect;
        context.state.googleWorkspaceMcpCallTool = callTool;
        context.state.googleWorkspaceMcpToolNames =
          tools.length > 0 ? tools.map((tool) => tool.name) : [];
        if (tools.length > 0) {
          context.toolHost.registerExtensionTools(tools);
        }
        // Seed auth state from stored credentials so the UI can show
        // "Connected" without making an MCP call that triggers OAuth.
        if (hasStoredCredentials) {
          context.state.googleWorkspaceMcpAuthenticated = true;
        }
      })
      .catch((error) => {
        console.error(
          "[stella:google-workspace-mcp] Failed to load:",
          (error as Error).message,
        );
        context.state.googleWorkspaceMcpToolNames = [];
      });

    context.state.initializationPromise = Promise.all([
      skillsLoad,
      agentsLoad,
      extensionsLoad,
      googleWorkspaceMcpLoad,
    ]).then(() => {
      context.state.isInitialized = true;
      deps.syncRemoteTurnBridge();
    });

    return context.state.initializationPromise;
  };

  const start = () => {
    if (context.state.isRunning) return;
    context.state.isRunning = true;
    context.state.isInitialized = false;
    deps.syncRemoteTurnBridge();
    void initializeRuntime();
  };

  const stop = () => {
    logger.warn("runner.stop", {
      activeOrchestratorRunId: context.state.activeOrchestratorRunId,
      activeAbortControllers: context.state.activeRunAbortControllers.size,
      conversationCallbacks: context.state.conversationCallbacks.size,
    });
    context.state.isRunning = false;
    context.state.isInitialized = false;
    context.state.initializationPromise = null;
    deps.syncRemoteTurnBridge();
    deps.disposeConvexClient();
    deps.shutdownTasks();
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.queuedOrchestratorTurns.length = 0;
    context.state.activeToolExecutionCount = 0;
    context.state.interruptAfterTool = false;
    context.state.activeInterruptedReplayTurn = null;
    for (const controller of context.state.activeRunAbortControllers.values()) {
      controller.abort();
    }
    context.state.activeRunAbortControllers.clear();
    context.state.conversationCallbacks.clear();
    context.state.interruptedRunIds.clear();
    void context.selfModHmrController?.forceResumeAll();
    context.toolHost.killAllShells();
    const disconnectGoogleWorkspaceMcp = context.state.googleWorkspaceMcpDisconnect;
    context.state.googleWorkspaceMcpDisconnect = null;
    context.state.googleWorkspaceMcpCallTool = null;
    context.state.googleWorkspaceMcpToolNames = null;
    context.state.googleWorkspaceMcpAuthenticated = null;
    if (disconnectGoogleWorkspaceMcp) {
      void disconnectGoogleWorkspaceMcp().catch(() => undefined);
    }
  };

  const recoverCrashedRuns = async () => {
    // JSONL runtime is append-only and local-first; no crash recovery migration needed.
  };

  return {
    initializeRuntime,
    start,
    stop,
    recoverCrashedRuns,
  };
};
