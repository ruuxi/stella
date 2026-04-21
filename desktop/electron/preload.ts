import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ChatContext,
  SelfModHmrState,
} from "../src/shared/contracts/boundary.js";
import type { OfficePreviewSnapshot } from "../src/shared/contracts/office-preview.js";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
  IPC_HOME_PIN_SUGGESTION,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_UPDATE,
} from "../src/shared/contracts/ipc-channels.js";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "../src/shared/contracts/onboarding.js";
import type { DiscoveryKnowledgeSeedPayload } from "../src/shared/contracts/discovery.js";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  IPC_AUTH_RUNTIME_REFRESH_REQUESTED,
  IPC_BACKUP_GET_STATUS,
  IPC_BACKUP_LIST,
  IPC_BACKUP_RESTORE,
  IPC_BACKUP_RUN_NOW,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_PREFERENCES_SYNC_MODELS,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
} from "../src/shared/contracts/ipc-channels.js";
import type { RuntimeSocialSessionStatus } from "../../runtime/protocol/index.js";

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

const invokeBrowserFetch = async <T>(
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
    restoreSize: () => ipcRenderer.send("window:restoreSize"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    show: (target: "mini" | "full") => ipcRenderer.send("window:show", target),
  },

  display: {
    onUpdate: onIpc<string | unknown>("display:update"),
    readFile: (filePath: string) =>
      ipcRenderer.invoke("display:readFile", { filePath }) as Promise<{
        contentsBase64: string;
        sizeBytes: number;
        mimeType: string;
      }>,
  },

  officePreview: {
    list: () =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_LIST) as Promise<OfficePreviewSnapshot[]>,
    onUpdate: onIpc<OfficePreviewSnapshot>(IPC_OFFICE_PREVIEW_UPDATE),
  },

  ui: {
    getState: () => ipcRenderer.invoke("ui:getState"),
    setState: (partial: Record<string, unknown>) =>
      ipcRenderer.invoke("ui:setState", partial),
    onState: onIpc<Record<string, unknown>>("ui:state"),
    onOpenChatSidebar: onIpcSignal("chat:openSidebar"),
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
    setContext: (context: ChatContext | null) =>
      ipcRenderer.send("chatContext:set", context),
    onContext: onIpc<Record<string, unknown> | null>("chatContext:updated"),
    screenshot: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:capture", point),
    visionScreenshots: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:captureVision", point) as Promise<Array<{
        dataUrl: string;
        width: number;
        height: number;
        displayId: number;
        screenNumber: number;
        label: string;
        isPrimaryFocus: boolean;
        coordinateSpace: {
          x: number;
          y: number;
          logicalWidth: number;
          logicalHeight: number;
          sourceWidth: number;
          sourceHeight: number;
          targetWidth: number;
          targetHeight: number;
        };
      }>>,
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
    cursorDisplayInfo: () =>
      ipcRenderer.invoke("capture:cursorDisplayInfo") as Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
        scaleFactor: number;
      }>,
    pageDataUrl: () =>
      ipcRenderer.invoke("capture:pageDataUrl") as Promise<string | null>,
    onRegionReset: onIpcSignal("region:reset"),
  },

  overlay: {
    setInteractive: (interactive: boolean) =>
      ipcRenderer.send("overlay:setInteractive", interactive),
    showWindowHighlight: (payload: {
      bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      tone?: "default" | "subtle";
    }) => ipcRenderer.send("overlay:showWindowHighlight", payload),
    hideWindowHighlight: () => ipcRenderer.send("overlay:hideWindowHighlight"),
    previewWindowHighlightAtPoint: (point: { x: number; y: number }) =>
      ipcRenderer.send("overlay:previewWindowHighlightAtPoint", point),
    onStartRegionCapture: onIpcSignal("overlay:startRegionCapture"),
    onEndRegionCapture: onIpcSignal("overlay:endRegionCapture"),
    onWindowHighlight: onIpc<{
      x: number;
      y: number;
      width: number;
      height: number;
      tone?: "default" | "subtle";
    } | null>("overlay:windowHighlight"),
    onShowVoice: onIpc<{ x: number; y: number; mode: "realtime" }>(
      "overlay:showVoice",
    ),
    onHideVoice: onIpcSignal("overlay:hideVoice"),
    onShowScreenGuide: onIpc<{
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>;
    }>("overlay:showScreenGuide"),
    onHideScreenGuide: onIpcSignal("overlay:hideScreenGuide"),
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
  },

  mini: {},

  theme: {
    onChange: onIpcWithEvent<{ key: string; value: string }>("theme:change"),
    broadcast: (key: string, value: string) =>
      ipcRenderer.send("theme:broadcast", { key, value }),
    listInstalled: () => ipcRenderer.invoke("theme:listInstalled"),
  },

  screenGuide: {
    show: (annotations: Array<{
      id: string;
      label: string;
      x: number;
      y: number;
    }>) =>
      ipcRenderer.send("screenGuide:show", { annotations }),
    hide: () => ipcRenderer.send("screenGuide:hide"),
  },

  voice: {
    persistTranscript: (payload: {
      conversationId: string;
      role: "user" | "assistant";
      text: string;
      uiVisibility?: "visible" | "hidden";
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
        uiVisibility?: "visible" | "hidden";
      } | null>,
    getAppSessionStartedAt: () =>
      ipcRenderer.invoke("agent:getAppSessionStartedAt") as Promise<number>,
    startChat: (payload: {
      conversationId: string;
      userPrompt: string;
      selectedText?: string | null;
      chatContext?: import("../../runtime/contracts/index.js").ChatContext | null;
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
        requestId: string;
      }>,
    cancelChat: (runId: string) => ipcRenderer.send("agent:cancelChat", runId),
    resumeConversationExecution: (payload: {
      conversationId: string;
      lastSeq: number;
    }) =>
      ipcRenderer.invoke("agent:resume", payload) as Promise<{
        activeRun: {
          runId: string;
          conversationId: string;
          requestId?: string;
          userMessageId?: string;
          uiVisibility?: "visible" | "hidden";
        } | null;
        events: Array<{
          type:
            | "run-started"
            | "run-finished"
            | "status"
            | "stream"
            | "tool-start"
            | "tool-end"
            | "error"
            | "end"
            | "task-started"
            | "task-reasoning"
            | "task-completed"
            | "task-failed"
            | "task-canceled"
            | "task-progress";
          runId: string;
          conversationId?: string;
          requestId?: string;
          agentType?: string;
          seq: number;
          userMessageId?: string;
          uiVisibility?: "visible" | "hidden";
          rootRunId?: string;
          chunk?: string;
          statusState?: "running" | "compacting";
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          resultPreview?: string;
          error?: string;
          fatal?: boolean;
          finalText?: string;
          persisted?: boolean;
          outcome?: "completed" | "error" | "canceled";
          reason?: string;
          replacedByRunId?: string;
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
          reasoningText?: string;
        }>;
        tasks: Array<{
          runId: string;
          taskId: string;
          agentType?: string;
          description?: string;
          anchorTurnId?: string;
          parentTaskId?: string;
          status: "running" | "completed" | "error" | "canceled";
          statusText?: string;
          reasoningText?: string;
          result?: string;
          error?: string;
        }>;
      }>,
    onStream: onIpc<{
      type:
        | "run-started"
        | "run-finished"
        | "status"
        | "stream"
        | "tool-start"
        | "tool-end"
        | "error"
        | "end"
        | "task-started"
        | "task-reasoning"
        | "task-completed"
        | "task-failed"
        | "task-canceled"
        | "task-progress";
      runId: string;
      conversationId?: string;
      requestId?: string;
      agentType?: string;
      seq: number;
      userMessageId?: string;
      uiVisibility?: "visible" | "hidden";
      rootRunId?: string;
      chunk?: string;
      statusState?: "running" | "compacting";
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      resultPreview?: string;
      html?: string;
      error?: string;
      fatal?: boolean;
      finalText?: string;
      persisted?: boolean;
      outcome?: "completed" | "error" | "canceled";
      reason?: string;
      replacedByRunId?: string;
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
      reasoningText?: string;
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
    triggerViteError: () => ipcRenderer.invoke("devtest:triggerViteError"),
    fixViteError: () => ipcRenderer.invoke("devtest:fixViteError"),
  },

  system: {
    getDeviceId: () => ipcRenderer.invoke("device:getId"),
    startPhoneAccessSession: () =>
      ipcRenderer.invoke("phoneAccess:startSession") as Promise<{
        ok: boolean;
      }>,
    stopPhoneAccessSession: () =>
      ipcRenderer.invoke("phoneAccess:stopSession") as Promise<{ ok: boolean }>,
    configurePiRuntime: (config: {
      convexUrl?: string;
      convexSiteUrl?: string;
    }) => ipcRenderer.invoke("host:configurePiRuntime", config),
    setAuthState: (payload: {
      authenticated: boolean;
      token?: string;
      hasConnectedAccount?: boolean;
    }) =>
      ipcRenderer.invoke("auth:setState", payload),
    completeRuntimeAuthRefresh: (payload: {
      requestId: string;
      authenticated: boolean;
      token?: string;
      hasConnectedAccount?: boolean;
    }) =>
      ipcRenderer.invoke(IPC_AUTH_RUNTIME_REFRESH_COMPLETE, payload),
    setCloudSyncEnabled: (payload: { enabled: boolean }) =>
      ipcRenderer.invoke("host:setCloudSyncEnabled", payload),
    onAuthCallback: onIpc<{ url: string }>("auth:callback"),
    onRuntimeAuthRefreshRequested: onIpc<{
      requestId: string;
      source: "heartbeat" | "subscription" | "register";
    }>(IPC_AUTH_RUNTIME_REFRESH_REQUESTED),
    quitForRestart: () =>
      ipcRenderer.invoke(IPC_APP_QUIT_FOR_RESTART) as Promise<{ ok: boolean }>,
    openFullDiskAccess: () => ipcRenderer.send("system:openFullDiskAccess"),
    getPermissionStatus: () =>
      ipcRenderer.invoke("permissions:getStatus") as Promise<{
        accessibility: boolean;
        screen: boolean;
        microphone: boolean;
        microphoneStatus:
          | "not-determined"
          | "granted"
          | "denied"
          | "restricted"
          | "unknown";
      }>,
    openPermissionSettings: (kind: string) =>
      ipcRenderer.invoke("permissions:openSettings", { kind }),
    requestPermission: (kind: string) =>
      ipcRenderer.invoke("permissions:request", { kind }) as Promise<{
        granted: boolean;
        alreadyGranted: boolean;
        openedSettings?: boolean;
      }>,
    resetMicrophonePermission: () =>
      ipcRenderer.invoke(IPC_PERMISSIONS_RESET_MICROPHONE) as Promise<{
        ok: boolean;
      }>,
    openExternal: (url: string) => ipcRenderer.send("shell:openExternal", url),
    showItemInFolder: (filePath: string) =>
      ipcRenderer.send("shell:showItemInFolder", filePath),
    shellKillByPort: (port: number) =>
      ipcRenderer.invoke("shell:killByPort", { port }),
    getLocalSyncMode: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_SYNC_MODE) as Promise<string>,
    setLocalSyncMode: (mode: string) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_SYNC_MODE, mode),
    getBackupStatus: () =>
      ipcRenderer.invoke(IPC_BACKUP_GET_STATUS),
    backUpNow: () =>
      ipcRenderer.invoke(IPC_BACKUP_RUN_NOW),
    listBackups: (limit?: number) =>
      ipcRenderer.invoke(IPC_BACKUP_LIST, { limit }),
    restoreBackup: (snapshotId: string) =>
      ipcRenderer.invoke(IPC_BACKUP_RESTORE, { snapshotId }),
    syncLocalModelPreferences: (payload: {
      defaultModels: Record<string, string>;
      resolvedDefaultModels: Record<string, string>;
      modelOverrides: Record<string, string>;
      generalAgentEngine: "default" | "claude_code_local";
      selfModAgentEngine: "default" | "claude_code_local";
      maxAgentConcurrency: number;
    }) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SYNC_MODELS,
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
  },

  onboarding: {
    synthesizeCoreMemory: (payload: OnboardingSynthesisRequest) =>
      ipcRenderer.invoke(
        "onboarding:synthesizeCoreMemory",
        payload,
      ) as Promise<OnboardingSynthesisResponse>,
  },

  discovery: {
    checkCoreMemoryExists: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_CORE_MEMORY_EXISTS),
    checkKnowledgeExists: () => ipcRenderer.invoke(IPC_DISCOVERY_KNOWLEDGE_EXISTS),
    collectData: (options?: {
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke(IPC_DISCOVERY_COLLECT_BROWSER_DATA, options),
    detectPreferred: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_DETECT_PREFERRED_BROWSER),
    listProfiles: (browserType: string) =>
      ipcRenderer.invoke(IPC_DISCOVERY_LIST_BROWSER_PROFILES, browserType),
    writeCoreMemory: (content: string) =>
      ipcRenderer.invoke(IPC_DISCOVERY_WRITE_CORE_MEMORY, content),
    writeKnowledge: (payload: DiscoveryKnowledgeSeedPayload) =>
      ipcRenderer.invoke(IPC_DISCOVERY_WRITE_KNOWLEDGE, payload),
    collectAllSignals: (options?: {
      categories?: string[];
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke(IPC_DISCOVERY_COLLECT_ALL_SIGNALS, options),
  },

  browser: {
    fetchJson: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch(IPC_BROWSER_FETCH_JSON, { url, init }),
    fetchText: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch(IPC_BROWSER_FETCH_TEXT, { url, init }),
    onBridgeStatus: onIpc<{
      state:
        | "connecting"
        | "connected"
        | "reconnecting"
        | "host_registration_failed";
      attempt: number;
      nextRetryMs?: number;
      error?: string;
      notifyUser?: boolean;
    }>("browser:bridgeStatus"),
  },

  home: {
    listRecentApps: (limit?: number) =>
      ipcRenderer.invoke(IPC_HOME_LIST_RECENT_APPS, { limit }) as Promise<{
        apps: Array<{
          name: string;
          bundleId?: string;
          pid: number;
          isActive: boolean;
          windowTitle?: string;
        }>;
      }>,
    getActiveBrowserTab: (bundleId: string) =>
      ipcRenderer.invoke(IPC_HOME_GET_ACTIVE_BROWSER_TAB, {
        bundleId,
      }) as Promise<{
        tab: {
          browser: string;
          bundleId?: string;
          url: string;
          title?: string;
        } | null;
      }>,
    captureAppWindow: (
      target:
        | string
        | { appName?: string | null; pid?: number | null },
    ) => {
      const payload =
        typeof target === "string"
          ? { appName: target }
          : { appName: target?.appName ?? null, pid: target?.pid ?? null };
      return ipcRenderer.invoke(
        IPC_HOME_CAPTURE_APP_WINDOW,
        payload,
      ) as Promise<{
        capture: {
          title: string;
          screenshot: {
            dataUrl: string;
            width: number;
            height: number;
          };
        } | null;
      }>;
    },
    onPinSuggestion: onIpc<{
      chip:
        | {
            kind: "app";
            pid: number;
            name: string;
            bundleId?: string;
            isActive: boolean;
            windowTitle?: string;
          }
        | {
            kind: "tab";
            browser: string;
            bundleId: string;
            url: string;
            title?: string;
            host: string;
          };
    }>(IPC_HOME_PIN_SUGGESTION),
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

  chronicle: {
    status: () =>
      ipcRenderer.invoke("chronicle:status") as Promise<{
        available: boolean;
        status?: {
          enabled: boolean;
          running: boolean;
          paused?: boolean;
          fps?: number;
          captures?: number;
          lastCaptureAt?: number | null;
        };
      }>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("chronicle:setEnabled", { enabled }) as Promise<{
        ok: boolean;
        enabled?: boolean;
        running?: boolean;
        permission?: boolean;
        reason?: string;
      }>,
    openMemoriesFolder: () =>
      ipcRenderer.invoke("chronicle:openMemoriesFolder") as Promise<{
        ok: boolean;
      }>,
    dreamNow: () =>
      ipcRenderer.invoke("chronicle:dreamNow") as Promise<{
        ok: boolean;
        reason?: string;
        pendingThreadSummaries: number;
        pendingExtensions: number;
        detail?: string;
      }>,
    wipeMemories: () =>
      ipcRenderer.invoke("chronicle:wipeMemories") as Promise<{
        ok: boolean;
        reason?: string;
      }>,
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

  localChat: {
    getOrCreateDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:getOrCreateDefaultConversationId"),
    listEvents: (payload: {
      conversationId: string;
      maxItems?: number;
      windowBy?: "events" | "visible_messages";
    }) =>
      ipcRenderer.invoke("localChat:listEvents", payload),
    getEventCount: (payload: {
      conversationId: string;
      countBy?: "events" | "visible_messages";
    }) =>
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
    create: (payload: { roomId: string; workspaceLabel?: string }) =>
      ipcRenderer.invoke(IPC_SOCIAL_SESSIONS_CREATE, payload),
    updateStatus: (payload: {
      sessionId: string;
      status: RuntimeSocialSessionStatus;
    }) => ipcRenderer.invoke(IPC_SOCIAL_SESSIONS_UPDATE_STATUS, payload),
    queueTurn: (payload: {
      sessionId: string;
      prompt: string;
      agentType?: string;
      clientTurnId?: string;
    }) => ipcRenderer.invoke(IPC_SOCIAL_SESSIONS_QUEUE_TURN, payload),
    getStatus: () => ipcRenderer.invoke(IPC_SOCIAL_SESSIONS_GET_STATUS),
  },

  googleWorkspace: {
    getAuthStatus: () =>
      ipcRenderer.invoke("googleWorkspace:authStatus") as Promise<{
        connected: boolean;
        unavailable?: boolean;
        email?: string;
        name?: string;
      }>,
    connect: () =>
      ipcRenderer.invoke("googleWorkspace:connect") as Promise<{
        connected: boolean;
        unavailable?: boolean;
        email?: string;
        name?: string;
      }>,
    disconnect: () =>
      ipcRenderer.invoke("googleWorkspace:disconnect") as Promise<{
        ok: boolean;
      }>,
    onAuthRequired: onIpcSignal("googleWorkspace:authRequired"),
  },
});
