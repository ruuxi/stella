import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  MiniBridgeRequest,
  MiniBridgeRequestEnvelope,
  MiniBridgeResponse,
  MiniBridgeResponseEnvelope,
  MiniBridgeUpdate,
  SelfModHmrState,
} from "../src/shared/contracts/boundary.js";

// ---------------------------------------------------------------------------
// IPC listener helpers — eliminate boilerplate for the 3 common patterns.
// ---------------------------------------------------------------------------

/** Subscribe to an IPC channel, stripping the IpcRendererEvent and forwarding data. */
const onIpc =
  <T>(channel: string) =>
  (callback: (data: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };

/** Subscribe to an IPC channel that sends no payload. */
const onIpcSignal =
  (channel: string) =>
  (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };

/** Subscribe to an IPC channel, forwarding both the event and payload. */
const onIpcWithEvent =
  <T>(channel: string) =>
  (callback: (event: IpcRendererEvent, data: T) => void): (() => void) => {
    ipcRenderer.on(channel, callback);
    return () => {
      ipcRenderer.removeListener(channel, callback);
    };
  };

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: …" — unwrap for UI. */
const unwrapIpcInvokeError = (error: unknown): Error => {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const wrapped = error.message.match(
    /^Error invoking remote method '[^']+':\s*(.+)$/s,
  );
  if (!wrapped) {
    return error;
  }
  let inner = wrapped[1].trim();
  const nested = inner.match(/^Error:\s*(.+)$/s);
  if (nested) {
    inner = nested[1].trim();
  }
  return new Error(inner);
};

const invokeBrowserFetch = async <T,>(
  channel: "browser:fetchJson" | "browser:fetchText",
  payload: { url: string; init?: unknown },
): Promise<T> => {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T;
  } catch (error) {
    throw unwrapIpcInvokeError(error);
  }
};

// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    show: (target: "mini" | "full") => ipcRenderer.send("window:show", target),
  },

  display: {
    onUpdate: onIpc<string>("display:update"),
  },

  ui: {
    getState: () => ipcRenderer.invoke("ui:getState"),
    setState: (partial: Record<string, unknown>) =>
      ipcRenderer.invoke("ui:setState", partial),
    onState: onIpc<Record<string, unknown>>("ui:state"),
    setAppReady: (ready: boolean) => ipcRenderer.send("app:setReady", ready),
    reload: () => ipcRenderer.send("app:reload"),
    hardReset: () =>
      ipcRenderer.invoke("app:hardResetLocalState") as Promise<{ ok: boolean }>,
    morphStart: () =>
      ipcRenderer.invoke("morph:start") as Promise<{ ok: boolean }>,
    morphComplete: () =>
      ipcRenderer.invoke("morph:complete") as Promise<{ ok: boolean }>,
  },

  capture: {
    getContext: () => ipcRenderer.invoke("chatContext:get"),
    onContext: onIpc<Record<string, unknown> | null>("chatContext:updated"),
    ackContext: (payload: { version: number }) =>
      ipcRenderer.send("chatContext:ack", payload),
    screenshot: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:capture", point),
    removeScreenshot: (index: number) =>
      ipcRenderer.send("chatContext:removeScreenshot", index),
    submitRegionSelection: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ipcRenderer.send("region:select", payload),
    submitRegionClick: (point: { x: number; y: number }) =>
      ipcRenderer.send("region:click", point),
    getWindowCapture: (point: { x: number; y: number }) =>
      ipcRenderer.invoke("region:getWindowCapture", point) as Promise<{
        bounds: { x: number; y: number; width: number; height: number };
        thumbnail: string;
      } | null>,
    cancelRegion: () => ipcRenderer.send("region:cancel"),
    pageDataUrl: () =>
      ipcRenderer.invoke("capture:pageDataUrl") as Promise<string | null>,
    onRegionReset: onIpcSignal("region:reset"),
  },

  radial: {
    onShow: onIpcWithEvent<{
      centerX: number;
      centerY: number;
      x?: number;
      y?: number;
    }>("radial:show"),
    onHide: onIpcSignal("radial:hide"),
    animDone: () => ipcRenderer.send("radial:animDone"),
    onCursor: onIpcWithEvent<{
      x: number;
      y: number;
      centerX: number;
      centerY: number;
    }>("radial:cursor"),
  },

  overlay: {
    setInteractive: (interactive: boolean) =>
      ipcRenderer.send("overlay:setInteractive", interactive),
    onModifierBlock: onIpc<boolean>("overlay:modifierBlock"),
    onStartRegionCapture: onIpcSignal("overlay:startRegionCapture"),
    onEndRegionCapture: onIpcSignal("overlay:endRegionCapture"),
    onShowMini: onIpc<{ x: number; y: number }>("overlay:showMini"),
    onHideMini: onIpcSignal("overlay:hideMini"),
    onRestoreMini: onIpcSignal("overlay:restoreMini"),
    onShowVoice: onIpc<{ x: number; y: number; mode: "stt" | "realtime" }>(
      "overlay:showVoice",
    ),
    onHideVoice: onIpcSignal("overlay:hideVoice"),
    onDisplayChange: onIpc<{
      origin: { x: number; y: number };
      bounds: { x: number; y: number; width: number; height: number };
    }>("overlay:displayChange"),
    onMorphForward: onIpc<{
      transitionId: string;
      screenshotDataUrl: string;
      x: number;
      y: number;
      width: number;
      height: number;
      flavor?: "hmr" | "onboarding";
    }>("overlay:morphForward"),
    onMorphBounds: onIpc<{
      transitionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>("overlay:morphBounds"),
    onMorphReverse: onIpc<{
      transitionId: string;
      screenshotDataUrl: string;
      requiresFullReload: boolean;
      flavor?: "hmr" | "onboarding";
    }>("overlay:morphReverse"),
    onMorphEnd: onIpc<{ transitionId: string }>("overlay:morphEnd"),
    onMorphState: onIpc<{ transitionId: string; state: SelfModHmrState }>(
      "overlay:morphState",
    ),
    morphReady: (transitionId: string) =>
      ipcRenderer.send("overlay:morphReady", { transitionId }),
    morphDone: (transitionId: string) =>
      ipcRenderer.send("overlay:morphDone", { transitionId }),
    onShowAutoPanel: onIpc<{
      x: number;
      y: number;
      width: number;
      height: number;
      windowText: string;
      windowTitle: string | null;
    }>("overlay:showAutoPanel"),
    onHideAutoPanel: onIpcSignal("overlay:hideAutoPanel"),
    hideAutoPanel: () => ipcRenderer.send("overlay:hideAutoPanel"),
    startAutoPanelStream: (payload: {
      requestId: string;
      agentType?: string;
      messages: Array<{
        role: "system" | "user" | "assistant" | "developer";
        content: string | Array<{ type?: string; text?: string }>;
      }>;
    }) =>
      ipcRenderer.invoke("overlay:autoPanelStart", payload) as Promise<{
        ok: boolean;
      }>,
    cancelAutoPanelStream: (requestId: string) =>
      ipcRenderer.send("overlay:autoPanelCancel", { requestId }),
    onAutoPanelChunk: onIpc<{ requestId: string; chunk: string }>(
      "overlay:autoPanelChunk",
    ),
    onAutoPanelComplete: onIpc<{ requestId: string; text: string }>(
      "overlay:autoPanelComplete",
    ),
    onAutoPanelError: onIpc<{ requestId: string; error: string }>(
      "overlay:autoPanelError",
    ),
  },

  mini: {
    onVisibility: (callback: (visible: boolean) => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { visible?: boolean },
      ) => {
        callback(Boolean(data?.visible));
      };
      ipcRenderer.on("mini:visibility", handler);
      return () => {
        ipcRenderer.removeListener("mini:visibility", handler);
      };
    },
    onDismissPreview: onIpcSignal("mini:dismissPreview"),
    request: (request: MiniBridgeRequest) =>
      ipcRenderer.invoke(
        "miniBridge:request",
        request,
      ) as Promise<MiniBridgeResponse>,
    onUpdate: onIpc<MiniBridgeUpdate>("miniBridge:update"),
    onRequest: onIpc<MiniBridgeRequestEnvelope>("miniBridge:request"),
    respond: (envelope: MiniBridgeResponseEnvelope) =>
      ipcRenderer.send("miniBridge:response", envelope),
    ready: () => ipcRenderer.send("miniBridge:ready"),
    pushUpdate: (update: MiniBridgeUpdate) =>
      ipcRenderer.send("miniBridge:update", update),
  },

  theme: {
    onChange: onIpcWithEvent<{ key: string; value: string }>("theme:change"),
    broadcast: (key: string, value: string) =>
      ipcRenderer.send("theme:broadcast", { key, value }),
    listInstalled: () => ipcRenderer.invoke("theme:listInstalled"),
  },

  voice: {
    submitTranscript: (transcript: string) =>
      ipcRenderer.send("voice:transcript", transcript),
    setShortcut: (shortcut: string) =>
      ipcRenderer.invoke("voice:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    onTranscript: onIpc<string>("voice:transcript"),
    persistTranscript: (payload: {
      conversationId: string;
      role: "user" | "assistant";
      text: string;
    }) => ipcRenderer.send("voice:persistTranscript", payload),
    orchestratorChat: (payload: { conversationId: string; message: string }) =>
      ipcRenderer.invoke("voice:orchestratorChat", payload) as Promise<string>,
    webSearch: (payload: { query: string; category?: string }) =>
      ipcRenderer.invoke("voice:webSearch", payload) as Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>,
    getRuntimeState: () =>
      ipcRenderer.invoke("voice:getRuntimeState") as Promise<{
        sessionState:
          | "idle"
          | "connecting"
          | "connected"
          | "error"
          | "disconnecting";
        isConnected: boolean;
        isSpeaking: boolean;
        isUserSpeaking: boolean;
        micLevel: number;
        outputLevel: number;
      }>,
    onRuntimeState: onIpc<{
      sessionState:
        | "idle"
        | "connecting"
        | "connected"
        | "error"
        | "disconnecting";
      isConnected: boolean;
      isSpeaking: boolean;
      isUserSpeaking: boolean;
      micLevel: number;
      outputLevel: number;
    }>("voice:runtimeState"),
    getWakeWordState: () =>
      ipcRenderer.invoke("voice:getWakeWordState") as Promise<{
        enabled: boolean;
      }>,
    onWakeWordState: onIpc<{ enabled: boolean }>("voice:wakeWordState"),
    pushWakeWordAudio: (buffer: ArrayBuffer) =>
      ipcRenderer.send("voice:wakeWordAudio", buffer),
    pushRuntimeState: (state: {
      sessionState:
        | "idle"
        | "connecting"
        | "connected"
        | "error"
        | "disconnecting";
      isConnected: boolean;
      isSpeaking: boolean;
      isUserSpeaking: boolean;
      micLevel: number;
      outputLevel: number;
    }) => ipcRenderer.send("voice:runtimeState", state),
    setRtcShortcut: (shortcut: string) =>
      ipcRenderer.invoke("voice-rtc:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
  },

  agent: {
    healthCheck: () =>
      ipcRenderer.invoke("agent:healthCheck") as Promise<{
        ready: true;
        runnerVersion: string;
      } | null>,
    getActiveRun: () =>
      ipcRenderer.invoke("agent:getActiveRun") as Promise<{
        runId: string;
        conversationId: string;
      } | null>,
    getAppSessionStartedAt: () =>
      ipcRenderer.invoke("agent:getAppSessionStartedAt") as Promise<number>,
    startChat: (payload: {
      conversationId: string;
      userPrompt: string;
      deviceId?: string;
      platform?: string;
      timezone?: string;
      mode?: string;
      messageMetadata?: Record<string, unknown>;
      attachments?: Array<{
        url: string;
        mimeType?: string;
      }>;
      agentType?: string;
      storageMode?: "cloud" | "local";
    }) =>
      ipcRenderer.invoke("agent:startChat", payload) as Promise<{
        runId: string;
        userMessageId: string;
      }>,
    cancelChat: (runId: string) => ipcRenderer.send("agent:cancelChat", runId),
    resumeStream: (payload: { runId: string; lastSeq: number }) =>
      ipcRenderer.invoke("agent:resume", payload) as Promise<{
        events: Array<{
          type:
            | "stream"
            | "tool-start"
            | "tool-end"
            | "error"
            | "end"
            | "task-started"
            | "task-completed"
            | "task-failed"
            | "task-canceled"
            | "task-progress";
          runId: string;
          agentType?: string;
          seq: number;
          chunk?: string;
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          resultPreview?: string;
          error?: string;
          fatal?: boolean;
          finalText?: string;
          persisted?: boolean;
          selfModApplied?: {
            featureId: string;
            files: string[];
            batchIndex: number;
          };
          taskId?: string;
          description?: string;
          parentTaskId?: string;
          result?: string;
          statusText?: string;
        }>;
        exhausted: boolean;
      }>,
    onStream: onIpc<{
      type:
        | "stream"
        | "tool-start"
        | "tool-end"
        | "error"
        | "end"
        | "task-started"
        | "task-completed"
        | "task-failed"
        | "task-canceled"
        | "task-progress";
      runId: string;
      agentType?: string;
      seq: number;
      chunk?: string;
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      resultPreview?: string;
      html?: string;
      error?: string;
      fatal?: boolean;
      finalText?: string;
      persisted?: boolean;
      selfModApplied?: {
        featureId: string;
        files: string[];
        batchIndex: number;
      };
      taskId?: string;
      description?: string;
      parentTaskId?: string;
      result?: string;
      statusText?: string;
    }>("agent:event"),
    onSelfModHmrState: onIpc<SelfModHmrState>("agent:selfModHmrState"),
    selfModRevert: (featureId?: string, steps?: number) =>
      ipcRenderer.invoke("selfmod:revert", { featureId, steps }),
    getLastSelfModFeature: () => ipcRenderer.invoke("selfmod:lastFeature"),
    listSelfModFeatures: (limit?: number) =>
      ipcRenderer.invoke("selfmod:recentFeatures", { limit }) as Promise<
        Array<{
          featureId: string;
          name: string;
          description: string;
          latestCommit: string;
          latestTimestampMs: number;
          commitCount: number;
          tainted?: boolean;
          taintedFiles?: string[];
        }>
      >,
    startPersonalWebsiteGeneration: (payload: {
      conversationId: string;
      coreMemory: string;
      promptConfig: { systemPrompt: string; userPromptTemplate: string };
    }) =>
      ipcRenderer.invoke(
        "agent:startPersonalWebsiteGeneration",
        payload,
      ) as Promise<void>,
    triggerViteError: () => ipcRenderer.invoke("devtest:triggerViteError"),
    fixViteError: () => ipcRenderer.invoke("devtest:fixViteError"),
  },

  system: {
    getDeviceId: () => ipcRenderer.invoke("device:getId"),
    configurePiRuntime: (config: {
      convexUrl?: string;
      convexSiteUrl?: string;
    }) => ipcRenderer.invoke("host:configurePiRuntime", config),
    setAuthState: (payload: { authenticated: boolean; token?: string }) =>
      ipcRenderer.invoke("auth:setState", payload),
    setCloudSyncEnabled: (payload: { enabled: boolean }) =>
      ipcRenderer.invoke("host:setCloudSyncEnabled", payload),
    onAuthCallback: onIpc<{ url: string }>("auth:callback"),
    openFullDiskAccess: () => ipcRenderer.send("system:openFullDiskAccess"),
    openExternal: (url: string) => ipcRenderer.send("shell:openExternal", url),
    showItemInFolder: (filePath: string) => ipcRenderer.send("shell:showItemInFolder", filePath),
    shellKillByPort: (port: number) =>
      ipcRenderer.invoke("shell:killByPort", { port }),
    getLocalSyncMode: () =>
      ipcRenderer.invoke("preferences:getSyncMode") as Promise<string>,
    setLocalSyncMode: (mode: string) =>
      ipcRenderer.invoke("preferences:setSyncMode", mode),
    syncLocalModelPreferences: (payload: {
      defaultModels: Record<string, string>;
      resolvedDefaultModels: Record<string, string>;
      modelOverrides: Record<string, string>;
      generalAgentEngine: "default" | "claude_code_local";
      selfModAgentEngine: "default" | "claude_code_local";
      maxAgentConcurrency: number;
    }) =>
      ipcRenderer.invoke(
        "preferences:syncLocalModelPreferences",
        payload,
      ) as Promise<{ ok: boolean }>,
    listLlmCredentials: () =>
      ipcRenderer.invoke("llmCredentials:list") as Promise<
        Array<{
          provider: string;
          label: string;
          status: "active";
          updatedAt: number;
        }>
      >,
    saveLlmCredential: (payload: {
      provider: string;
      label: string;
      plaintext: string;
    }) =>
      ipcRenderer.invoke("llmCredentials:save", payload) as Promise<{
        provider: string;
        label: string;
        status: "active";
        updatedAt: number;
      }>,
    deleteLlmCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:delete", { provider }) as Promise<{
        removed: boolean;
      }>,
    resetMessages: () =>
      ipcRenderer.invoke("app:resetLocalMessages") as Promise<{ ok: boolean }>,
    onCredentialRequest: onIpcWithEvent<{
      requestId: string;
      provider: string;
      label?: string;
      description?: string;
      placeholder?: string;
    }>("credential:request"),
    submitCredential: (payload: {
      requestId: string;
      secretId: string;
      provider: string;
      label: string;
    }) => ipcRenderer.invoke("credential:submit", payload),
    cancelCredential: (payload: { requestId: string }) =>
      ipcRenderer.invoke("credential:cancel", payload),
    getIdentityMap: () => ipcRenderer.invoke("identity:getMap"),
    depseudonymize: (text: string) =>
      ipcRenderer.invoke("identity:depseudonymize", text),
  },

  browser: {
    checkCoreMemoryExists: () => ipcRenderer.invoke("browserData:exists"),
    fetchJson: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch("browser:fetchJson", { url, init }),
    fetchText: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch("browser:fetchText", { url, init }),
    collectData: (options?: {
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke("browserData:collect", options),
    detectPreferred: () =>
      ipcRenderer.invoke("browserData:detectPreferredBrowser"),
    listProfiles: (browserType: string) =>
      ipcRenderer.invoke("browserData:listProfiles", browserType),
    writeCoreMemory: (content: string) =>
      ipcRenderer.invoke("browserData:writeCoreMemory", content),
    writeHomeCanvas: (content: string) =>
      ipcRenderer.invoke("browserData:writeHomeCanvas", content) as Promise<{ ok: boolean; error?: string }>,
    collectAllSignals: (options?: {
      categories?: string[];
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke("signals:collectAll", options),
    onBridgeStatus: onIpc<{
      state: "connecting" | "connected" | "reconnecting";
      attempt: number;
      nextRetryMs?: number;
      error?: string;
      notifyUser?: boolean;
    }>("browser:bridgeStatus"),
  },

  media: {
    saveOutput: (url: string, fileName: string) =>
      ipcRenderer.invoke("media:saveOutput", { url, fileName }) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    getStellaMediaDir: () =>
      ipcRenderer.invoke("media:getStellaMediaDir") as Promise<string | null>,
  },

  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    pickDirectory: () => ipcRenderer.invoke("projects:pickDirectory"),
    start: (projectId: string) =>
      ipcRenderer.invoke("projects:start", { projectId }),
    stop: (projectId: string) =>
      ipcRenderer.invoke("projects:stop", { projectId }),
    onChanged: onIpc("projects:changed"),
  },

  schedule: {
    listCronJobs: () => ipcRenderer.invoke("schedule:listCronJobs"),
    listHeartbeats: () => ipcRenderer.invoke("schedule:listHeartbeats"),
    listConversationEvents: (payload: {
      conversationId: string;
      maxItems?: number;
    }) => ipcRenderer.invoke("schedule:listConversationEvents", payload),
    getConversationEventCount: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("schedule:getConversationEventCount", payload),
    onUpdated: onIpcSignal("schedule:updated"),
  },

  store: {
    listSelfModFeatures: (limit?: number) =>
      ipcRenderer.invoke("store:listLocalFeatures", { limit }),
    listFeatureBatches: (featureId: string) =>
      ipcRenderer.invoke("store:listFeatureBatches", { featureId }),
    getReleaseDraft: (payload: { featureId: string; batchIds?: string[] }) =>
      ipcRenderer.invoke("store:createReleaseDraft", payload),
    publishRelease: (payload: {
      featureId: string;
      packageId?: string;
      displayName?: string;
      description?: string;
      releaseNotes?: string;
      batchIds?: string[];
    }) => ipcRenderer.invoke("store:publishRelease", payload),
    listPackages: () => ipcRenderer.invoke("store:listPackages"),
    getPackage: (packageId: string) =>
      ipcRenderer.invoke("store:getPackage", { packageId }),
    listPackageReleases: (packageId: string) =>
      ipcRenderer.invoke("store:listReleases", { packageId }),
    getPackageRelease: (payload: {
      packageId: string;
      releaseNumber: number;
    }) => ipcRenderer.invoke("store:getRelease", payload),
    listInstalledMods: () => ipcRenderer.invoke("store:listInstalledMods"),
    installRelease: (payload: { packageId: string; releaseNumber?: number }) =>
      ipcRenderer.invoke("store:installRelease", payload),
    uninstallPackage: (packageId: string) =>
      ipcRenderer.invoke("store:uninstallMod", { packageId }),
  },

  games: {
    create: (payload: { gameId: string; spacetimedbModule?: string }) =>
      ipcRenderer.invoke("games:create", payload) as Promise<{
        gameId: string;
        path: string;
      }>,
    build: (gameId: string) =>
      ipcRenderer.invoke("games:build", { gameId }) as Promise<{
        gameId: string;
        distPath: string;
      }>,
    deploy: (gameId: string) =>
      ipcRenderer.invoke("games:deploy", { gameId }) as Promise<{
        gameId: string;
        deploymentPath: string;
        assetCount: number;
      }>,
    getJoinInfo: (gameId: string) =>
      ipcRenderer.invoke("games:getJoinInfo", { gameId }) as Promise<{
        gameId: string;
        joinCode: string;
        displayName: string;
        deploymentPath?: string;
      }>,
    list: () =>
      ipcRenderer.invoke("games:list") as Promise<
        Array<{
          gameId: string;
          displayName: string;
          description: string;
          gameType: string;
          joinCode: string;
          status: string;
          deploymentPath?: string;
          createdAt: number;
          updatedAt: number;
        }>
      >,
    archive: (gameId: string) =>
      ipcRenderer.invoke("games:archive", { gameId }) as Promise<{
        archived: boolean;
      }>,
  },

  localChat: {
    getOrCreateDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:getOrCreateDefaultConversationId"),
    listEvents: (payload: { conversationId: string; maxItems?: number }) =>
      ipcRenderer.invoke("localChat:listEvents", payload),
    getEventCount: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("localChat:getEventCount", payload),
    persistDiscoveryWelcome: (payload: {
      conversationId: string;
      message: string;
      suggestions?: unknown[];
    }) => ipcRenderer.invoke("localChat:persistDiscoveryWelcome", payload),
    listSyncMessages: (payload: {
      conversationId: string;
      maxMessages?: number;
    }) => ipcRenderer.invoke("localChat:listSyncMessages", payload),
    getSyncCheckpoint: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("localChat:getSyncCheckpoint", payload),
    setSyncCheckpoint: (payload: {
      conversationId: string;
      localMessageId: string;
    }) => ipcRenderer.invoke("localChat:setSyncCheckpoint", payload),
    onUpdated: onIpcSignal("localChat:updated"),
  },

  socialSessions: {
    getStatus: () => ipcRenderer.invoke("socialSessions:getStatus"),
  },
});
