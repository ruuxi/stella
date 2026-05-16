import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ChatContext,
  SelfModHmrState,
} from "../../runtime/contracts/index.js";
import type { TaskLifecycleStatus } from "../../runtime/contracts/agent-runtime.js";
import type { LocalChatUpdatedPayload } from "../../runtime/contracts/local-chat.js";
import type { RadialTriggerCode } from "../src/shared/lib/radial-trigger.js";
import type { MiniDoubleTapModifier } from "../src/shared/lib/mini-double-tap.js";
import type { OfficePreviewSnapshot } from "../../runtime/contracts/office-preview.js";
import type { RealtimeVoicePreferences } from "../../runtime/contracts/local-preferences.js";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
  IPC_MEDIA_COPY_IMAGE,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
  IPC_OFFICE_PREVIEW_UPDATE,
  IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE,
} from "../src/shared/contracts/ipc-channels.js";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "../src/shared/contracts/onboarding.js";
import type { DiscoveryKnowledgeSeedPayload } from "../../runtime/contracts/discovery.js";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_APPLY_SESSION_COOKIE,
  IPC_AUTH_CONSUME_PENDING_CALLBACK,
  IPC_AUTH_DELETE_USER,
  IPC_AUTH_GET_CONVEX_TOKEN,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  IPC_AUTH_RUNTIME_REFRESH_REQUESTED,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_AUTH_VERIFY_CALLBACK_URL,
  IPC_BACKUP_GET_STATUS,
  IPC_BACKUP_LIST,
  IPC_BACKUP_RESTORE,
  IPC_BACKUP_RUN_NOW,
  IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_GET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_RADIAL_TRIGGER,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_RADIAL_TRIGGER,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_PREFERENCES_GET_WAKE_WORD,
  IPC_PREFERENCES_SET_WAKE_WORD,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_SHELL_LIST_OPENERS,
  IPC_SHELL_OPEN_WITH,
  IPC_SHELL_OPEN_PATH,
  IPC_SYSTEM_OPEN_FDA,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
  IPC_STORE_BLUEPRINT_NOTIFICATION_ACTIVATED,
  IPC_STORE_SHOW_BLUEPRINT_NOTIFICATION,
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_VOICE_CREATE_OPENAI_SESSION,
  IPC_VOICE_CREATE_XAI_SESSION,
  IPC_VOICE_CREATE_INWORLD_SESSION,
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
  arch: process.arch,

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    isMiniAlwaysOnTop: () => ipcRenderer.invoke("window:isMiniAlwaysOnTop"),
    setMiniAlwaysOnTop: (enabled: boolean) =>
      ipcRenderer.invoke("window:setMiniAlwaysOnTop", enabled),
    show: (target: "mini" | "full") => ipcRenderer.send("window:show", target),
    setNativeButtonsVisible: (visible: boolean) =>
      ipcRenderer.send(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, visible),
  },

  display: {
    onUpdate: onIpc<string | unknown>("display:update"),
    readFile: (filePath: string) =>
      ipcRenderer.invoke("display:readFile", { filePath }) as Promise<{
        bytes: Uint8Array;
        sizeBytes: number;
        mimeType: string;
      }>,
    listTrash: () => ipcRenderer.invoke(IPC_DISPLAY_TRASH_LIST),
    forceDeleteTrash: (payload: { id?: string; all?: boolean }) =>
      ipcRenderer.invoke(IPC_DISPLAY_TRASH_FORCE_DELETE, payload),
  },

  officePreview: {
    list: () =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_LIST) as Promise<
        OfficePreviewSnapshot[]
      >,
    start: (filePath: string) =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_START, { filePath }) as Promise<{
        sessionId: string;
        title: string;
        sourcePath: string;
      }>,
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
    morphStart: (payload?: {
      rect?: { x: number; y: number; width: number; height: number };
    }) =>
      ipcRenderer.invoke("morph:start", payload) as Promise<{ ok: boolean }>,
    morphComplete: (payload?: {
      rect?: { x: number; y: number; width: number; height: number };
    }) =>
      ipcRenderer.invoke("morph:complete", payload) as Promise<{ ok: boolean }>,
    setOnboardingPresentation: (active: boolean) =>
      ipcRenderer.invoke(
        "window:setOnboardingPresentation",
        active,
      ) as Promise<{
        ok: boolean;
      }>,
  },

  capture: {
    getContext: () => ipcRenderer.invoke("chatContext:get"),
    setContext: (context: ChatContext | null) =>
      ipcRenderer.send("chatContext:set", context),
    onContext: onIpc<Record<string, unknown> | null>("chatContext:updated"),
    screenshot: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:capture", point),
    visionScreenshots: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:captureVision", point) as Promise<
        Array<{
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
        }>
      >,
    removeScreenshot: (index: number) =>
      ipcRenderer.send("chatContext:removeScreenshot", index),
    submitRegionSelection: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ipcRenderer.send("region:select", payload),
    prepareRegionSelection: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) =>
      ipcRenderer.invoke("region:prepareSelection", payload) as Promise<{
        screenshot: {
          dataUrl: string;
          width: number;
          height: number;
        } | null;
        window: null;
      } | null>,
    commitPreparedRegionCapture: (
      result: {
        screenshot: {
          dataUrl: string;
          width: number;
          height: number;
        } | null;
        window: {
          app: string;
          title: string;
          bounds: { x: number; y: number; width: number; height: number };
        } | null;
      } | null,
    ) => ipcRenderer.send("region:commitPrepared", result),
    submitRegionClick: (point: { x: number; y: number }) =>
      ipcRenderer.send("region:click", point),
    getWindowCapture: (point: { x: number; y: number }) =>
      ipcRenderer.invoke("region:getWindowCapture", point) as Promise<{
        bounds: { x: number; y: number; width: number; height: number };
        thumbnail: string;
        result: {
          screenshot: {
            dataUrl: string;
            width: number;
            height: number;
          } | null;
          window: {
            app: string;
            title: string;
            bounds: { x: number; y: number; width: number; height: number };
          } | null;
        };
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
    beginRegionCapture: () =>
      ipcRenderer.invoke("capture:beginRegionCapture") as Promise<
        { ok: true } | { cancelled: true }
      >,
  },

  radial: {
    onShow: onIpcWithEvent<{
      centerX: number;
      centerY: number;
      x?: number;
      y?: number;
      screenX?: number;
      screenY?: number;
      compactFocused?: boolean;
      miniAlwaysOnTop?: boolean;
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
    onShowDictation: onIpc<{ x: number; y: number }>("overlay:showDictation"),
    onHideDictation: onIpcSignal("overlay:hideDictation"),
    onShowScreenGuide: onIpc<{
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>;
    }>("overlay:showScreenGuide"),
    onHideScreenGuide: onIpcSignal("overlay:hideScreenGuide"),
    onShowSelectionChip: onIpc<{
      requestId: number;
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }>("overlay:showSelectionChip"),
    onHideSelectionChip: onIpc<{ requestId?: number } | null>(
      "overlay:hideSelectionChip",
    ),
    selectionChipClicked: (requestId: number) =>
      ipcRenderer.send("overlay:selectionChipClicked", { requestId }),
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

  theme: {
    onChange: onIpcWithEvent<{ key: string; value: string }>("theme:change"),
    broadcast: (key: string, value: string) =>
      ipcRenderer.send("theme:broadcast", { key, value }),
    listInstalled: () => ipcRenderer.invoke("theme:listInstalled"),
  },

  screenGuide: {
    show: (
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>,
    ) => ipcRenderer.send("screenGuide:show", { annotations }),
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
    createOpenAISession: (payload: { instructions?: string }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_OPENAI_SESSION, payload) as Promise<{
        provider: "openai";
        clientSecret: string;
        model: string;
        voice: string;
        expiresAt?: number;
        sessionId?: string;
      }>,
    createXaiSession: (payload: { instructions?: string }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_XAI_SESSION, payload) as Promise<{
        provider: "xai";
        clientSecret: string;
        model: string;
        voice: string;
        expiresAt?: number;
      }>,
    createInworldSession: (payload: { instructions?: string }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_INWORLD_SESSION, payload) as Promise<{
        provider: "inworld";
        clientSecret: string;
        model: string;
        voice: string;
        iceServers?: RTCIceServer[];
      }>,
    getCoreMemory: () =>
      ipcRenderer.invoke("voice:getCoreMemory") as Promise<string>,
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
    onActionCompleted: onIpc<{
      conversationId: string;
      status: "completed" | "failed";
      message: string;
    }>("voice:actionCompleted"),
    setRtcShortcut: (shortcut: string) =>
      ipcRenderer.invoke("voice-rtc:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    getRtcShortcut: () =>
      ipcRenderer.invoke("voice-rtc:getShortcut") as Promise<string>,
  },

  dictation: {
    onToggle: onIpc<{
      startId?: string;
      action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
    }>("dictation:toggle"),
    trigger: () =>
      ipcRenderer.invoke("dictation:trigger") as Promise<{ ok: boolean }>,
    getShortcut: () =>
      ipcRenderer.invoke("dictation:getShortcut") as Promise<string>,
    setShortcut: (shortcut: string) =>
      ipcRenderer.invoke("dictation:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    getSoundEffectsEnabled: () =>
      ipcRenderer.invoke("dictation:getSoundEffectsEnabled") as Promise<boolean>,
    setSoundEffectsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        "dictation:setSoundEffectsEnabled",
        enabled,
      ) as Promise<{ enabled: boolean }>,
    localStatus: () =>
      ipcRenderer.invoke("dictation:localStatus") as Promise<{
        available: boolean;
        model: string;
        reason?: string;
      }>,
    downloadLocalModel: () =>
      ipcRenderer.invoke("dictation:downloadLocalModel") as Promise<{
        available: boolean;
        model: string;
        reason?: string;
      }>,
    warmLocal: () =>
      ipcRenderer.invoke("dictation:warmLocal") as Promise<{
        available: boolean;
        model: string;
        reason?: string;
      }>,
    transcribeLocal: (payload: { audioBase64: string }) =>
      ipcRenderer.invoke("dictation:transcribeLocal", payload) as Promise<{
        transcript: string;
        model: string;
      }>,
    onOverlayStart: onIpc<{ sessionId: string }>("dictation:overlayStart"),
    onOverlayStop: onIpc<{ sessionId: string }>("dictation:overlayStop"),
    onOverlayCancel: onIpc<{ sessionId: string }>("dictation:overlayCancel"),
    overlayCompleted: (payload: { sessionId: string; text: string }) =>
      ipcRenderer.send("dictation:overlayCompleted", payload),
    overlayFailed: (payload: { sessionId: string; error?: string }) =>
      ipcRenderer.send("dictation:overlayFailed", payload),
    inAppStarted: (payload: { startId?: string }) =>
      ipcRenderer.send("dictation:inAppStarted", payload),
    activeChanged: (payload: { active: boolean }) =>
      ipcRenderer.send("dictation:activeChanged", payload),
    playSound: (payload: {
      sound: "startRecording" | "stopRecording" | "cancel";
    }) => ipcRenderer.send("dictation:playSound", payload),
  },

  agent: {
    oneShotCompletion: (payload: {
      agentType: string;
      systemPrompt?: string;
      userText: string;
      maxOutputTokens?: number;
      temperature?: number;
      fallbackAgentTypes?: string[];
    }) =>
      ipcRenderer.invoke("agent:oneShotCompletion", payload) as Promise<{
        text: string;
      }>,
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
      chatContext?:
        | import("../../runtime/contracts/index.js").ChatContext
        | null;
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
    sendInput: (payload: {
      conversationId: string;
      threadId: string;
      message: string;
      interrupt?: boolean;
      metadata?: Record<string, unknown>;
    }) =>
      ipcRenderer.invoke("agent:sendInput", payload) as Promise<{
        delivered: boolean;
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
            | "agent-started"
            | "agent-reasoning"
            | "agent-completed"
            | "agent-failed"
            | "agent-canceled"
            | "agent-progress";
          runId: string;
          conversationId?: string;
          requestId?: string;
          agentType?: string;
          seq: number;
          userMessageId?: string;
          uiVisibility?: "visible" | "hidden";
          rootRunId?: string;
          chunk?: string;
          statusState?: "running" | "compacting" | "provider-retry";
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
          agentId?: string;
          description?: string;
          parentAgentId?: string;
          result?: string;
          statusText?: string;
          reasoningText?: string;
        }>;
        tasks: Array<{
          runId: string;
          agentId: string;
          agentType?: string;
          description?: string;
          anchorTurnId?: string;
          parentAgentId?: string;
          status: TaskLifecycleStatus;
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
        | "agent-started"
        | "agent-reasoning"
        | "agent-completed"
        | "agent-failed"
        | "agent-canceled"
        | "agent-progress";
      runId: string;
      conversationId?: string;
      requestId?: string;
      agentType?: string;
      seq: number;
      userMessageId?: string;
      uiVisibility?: "visible" | "hidden";
      rootRunId?: string;
      chunk?: string;
      statusState?: "running" | "compacting" | "provider-retry";
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
      agentId?: string;
      description?: string;
      parentAgentId?: string;
      result?: string;
      statusText?: string;
      reasoningText?: string;
    }>("agent:event"),
    onSelfModHmrState: onIpc<SelfModHmrState>("agent:selfModHmrState"),
    /**
     * Subscribe to runtime client availability transitions. The host
     * adapter fires this whenever the worker connection drops or
     * reattaches — most notably after Electron restarts and reconnects
     * to the still-running detached worker. Renderer hooks listen so
     * they can re-trigger chat-resume the moment the runtime is back.
     */
    onAvailability: onIpc<{
      connected: boolean;
      ready: boolean;
      reason?: string;
    }>("runtime:availability"),
    selfModRevert: (featureId?: string, steps?: number) =>
      ipcRenderer.invoke("selfmod:revert", { featureId, steps }),
    getCrashRecoveryStatus: () =>
      ipcRenderer.invoke("selfmod:crashRecoveryStatus"),
    discardUnfinishedSelfModChanges: () =>
      ipcRenderer.invoke("selfmod:discardUnfinished"),
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
    }) => ipcRenderer.invoke("auth:setState", payload),
    getAuthSession: () => ipcRenderer.invoke(IPC_AUTH_GET_SESSION),
    signInAnonymous: () => ipcRenderer.invoke(IPC_AUTH_SIGN_IN_ANONYMOUS),
    signOutAuth: () =>
      ipcRenderer.invoke(IPC_AUTH_SIGN_OUT) as Promise<{ ok: boolean }>,
    deleteAuthUser: () =>
      ipcRenderer.invoke(IPC_AUTH_DELETE_USER) as Promise<{ ok: boolean }>,
    verifyAuthCallbackUrl: (url: string) =>
      ipcRenderer.invoke(IPC_AUTH_VERIFY_CALLBACK_URL, { url }) as Promise<{
        ok: boolean;
      }>,
    applyAuthSessionCookie: (sessionCookie: string) =>
      ipcRenderer.invoke(IPC_AUTH_APPLY_SESSION_COOKIE, {
        sessionCookie,
      }) as Promise<{ ok: boolean }>,
    getConvexAuthToken: () =>
      ipcRenderer.invoke(IPC_AUTH_GET_CONVEX_TOKEN) as Promise<string | null>,
    completeRuntimeAuthRefresh: (payload: {
      requestId: string;
      authenticated: boolean;
      token?: string;
      hasConnectedAccount?: boolean;
    }) => ipcRenderer.invoke(IPC_AUTH_RUNTIME_REFRESH_COMPLETE, payload),
    setCloudSyncEnabled: (payload: { enabled: boolean }) =>
      ipcRenderer.invoke("host:setCloudSyncEnabled", payload),
    setModelCatalogUpdatedAt: (payload: { updatedAt: number | null }) =>
      ipcRenderer.invoke(IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT, payload),
    onAuthCallback: onIpc<{ url: string }>("auth:callback"),
    consumePendingAuthCallback: () =>
      ipcRenderer.invoke(IPC_AUTH_CONSUME_PENDING_CALLBACK) as Promise<
        string | null
      >,
    onRuntimeAuthRefreshRequested: onIpc<{
      requestId: string;
      source: "heartbeat" | "subscription" | "register";
    }>(IPC_AUTH_RUNTIME_REFRESH_REQUESTED),
    quitForRestart: () =>
      ipcRenderer.invoke(IPC_APP_QUIT_FOR_RESTART) as Promise<{ ok: boolean }>,
    openFullDiskAccess: () => ipcRenderer.send(IPC_SYSTEM_OPEN_FDA),
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
    resetPermission: (kind: string) =>
      ipcRenderer.invoke(IPC_PERMISSIONS_RESET, { kind }) as Promise<{
        ok: boolean;
      }>,
    openExternal: (url: string) => ipcRenderer.send("shell:openExternal", url),
    showItemInFolder: (filePath: string) =>
      ipcRenderer.send("shell:showItemInFolder", filePath),
    saveFileAs: (sourcePath: string, defaultName?: string) =>
      ipcRenderer.invoke(IPC_SHELL_SAVE_FILE_AS, {
        sourcePath,
        defaultName,
      }) as Promise<{
        ok: boolean;
        path?: string;
        canceled?: boolean;
        error?: string;
      }>,
    listExternalOpeners: (filePath: string) =>
      ipcRenderer.invoke(IPC_SHELL_LIST_OPENERS, { filePath }) as Promise<{
        openers: Array<{
          id: string;
          label: string;
          kind: "app" | "default" | "reveal";
        }>;
      }>,
    openWithExternal: (filePath: string, openerId: string) =>
      ipcRenderer.invoke(IPC_SHELL_OPEN_WITH, {
        filePath,
        openerId,
      }) as Promise<{ ok: boolean; error?: string }>,
    openPath: (filePath: string) =>
      ipcRenderer.invoke(IPC_SHELL_OPEN_PATH, { filePath }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    shellKillByPort: (port: number) =>
      ipcRenderer.invoke("shell:killByPort", { port }),
    getLocalSyncMode: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_SYNC_MODE) as Promise<string>,
    setLocalSyncMode: (mode: string) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_SYNC_MODE, mode),
    getRadialTriggerKey: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_RADIAL_TRIGGER,
      ) as Promise<RadialTriggerCode>,
    setRadialTriggerKey: (triggerKey: RadialTriggerCode) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_RADIAL_TRIGGER,
        triggerKey,
      ) as Promise<{ triggerKey: RadialTriggerCode }>,
    getMiniDoubleTapModifier: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_MINI_DOUBLE_TAP,
      ) as Promise<MiniDoubleTapModifier>,
    setMiniDoubleTapModifier: (modifier: MiniDoubleTapModifier) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
        modifier,
      ) as Promise<{ modifier: MiniDoubleTapModifier }>,
    getPreventComputerSleep: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_PREVENT_SLEEP) as Promise<boolean>,
    setPreventComputerSleep: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_PREVENT_SLEEP,
        enabled,
      ) as Promise<{ enabled: boolean }>,
    getSoundNotificationsEnabled: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
      ) as Promise<boolean>,
    setSoundNotificationsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
        enabled,
      ) as Promise<{ enabled: boolean }>,
    getReadAloudEnabled: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_READ_ALOUD) as Promise<boolean>,
    setReadAloudEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_READ_ALOUD,
        enabled,
      ) as Promise<{ enabled: boolean }>,
    setGlobalShortcutsSuspended: (suspended: boolean) =>
      ipcRenderer.invoke(
        IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
        suspended,
      ) as Promise<{ supported: boolean; suspended: boolean }>,
    getGlobalShortcutsSuspended: () =>
      ipcRenderer.invoke(IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED) as Promise<{
        supported: boolean;
        suspended: boolean;
      }>,
    recordHeapTrace: (durationMs?: number) =>
      ipcRenderer.invoke(IPC_DIAGNOSTICS_RECORD_HEAP_TRACE, {
        durationMs,
      }) as Promise<{ ok: boolean; path?: string; error?: string }>,
    getWakeWordEnabled: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_WAKE_WORD) as Promise<boolean>,
    setWakeWordEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_WAKE_WORD, enabled) as Promise<{
        enabled: boolean;
      }>,
    getPersonalityVoice: () =>
      ipcRenderer.invoke("preferences:getPersonalityVoice") as Promise<
        string | null
      >,
    setPersonalityVoice: (voiceId: string) =>
      ipcRenderer.invoke(
        "preferences:setPersonalityVoice",
        voiceId,
      ) as Promise<{
        ok: boolean;
        voiceId: string;
      }>,
    getBackupStatus: () => ipcRenderer.invoke(IPC_BACKUP_GET_STATUS),
    backUpNow: () => ipcRenderer.invoke(IPC_BACKUP_RUN_NOW),
    listBackups: (limit?: number) =>
      ipcRenderer.invoke(IPC_BACKUP_LIST, { limit }),
    restoreBackup: (snapshotId: string) =>
      ipcRenderer.invoke(IPC_BACKUP_RESTORE, { snapshotId }),
    getLocalModelPreferences: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_MODELS) as Promise<{
        defaultModels: Record<string, string>;
        modelOverrides: Record<string, string>;
        assistantPropagatedAgents: string[];
        reasoningEfforts: Record<
          string,
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
        >;
        agentRuntimeEngine: "default" | "claude_code_local";
        maxAgentConcurrency: number;
        imageGeneration: {
          provider: "stella" | "openai" | "openrouter" | "fal";
          model?: string;
        };
        realtimeVoice: RealtimeVoicePreferences;
      } | null>,
    setLocalModelPreferences: (payload: {
      defaultModels?: Record<string, string>;
      modelOverrides?: Record<string, string>;
      assistantPropagatedAgents?: string[];
      reasoningEfforts?: Record<
        string,
        "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
      >;
      agentRuntimeEngine?: "default" | "claude_code_local";
      maxAgentConcurrency?: number;
      imageGeneration?: {
        provider: "stella" | "openai" | "openrouter" | "fal";
        model?: string;
      };
      realtimeVoice?: RealtimeVoicePreferences;
    }) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_MODELS, payload) as Promise<{
        defaultModels: Record<string, string>;
        modelOverrides: Record<string, string>;
        assistantPropagatedAgents: string[];
        reasoningEfforts: Record<
          string,
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
        >;
        agentRuntimeEngine: "default" | "claude_code_local";
        maxAgentConcurrency: number;
        imageGeneration: {
          provider: "stella" | "openai" | "openrouter" | "fal";
          model?: string;
        };
        realtimeVoice: RealtimeVoicePreferences;
      } | null>,
    listLlmCredentials: () =>
      ipcRenderer.invoke("llmCredentials:list") as Promise<
        Array<{
          provider: string;
          label: string;
          status: "active";
          updatedAt: number;
        }>
      >,
    listLlmOAuthProviders: () =>
      ipcRenderer.invoke("llmCredentials:listOAuthProviders") as Promise<
        Array<{ provider: string; label: string }>
      >,
    listLlmOAuthCredentials: () =>
      ipcRenderer.invoke("llmCredentials:listOAuth") as Promise<
        Array<{
          provider: string;
          label: string;
          status: "active";
          updatedAt: number;
        }>
      >,
    loginLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:loginOAuth", { provider }) as Promise<{
        provider: string;
        label: string;
        status: "active";
        updatedAt: number;
      }>,
    deleteLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:deleteOAuth", {
        provider,
      }) as Promise<{
        removed: boolean;
      }>,
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

  updates: {
    getInstallManifest: () =>
      ipcRenderer.invoke(IPC_UPDATES_GET_INSTALL_MANIFEST) as Promise<{
        version: string;
        platform: string;
        installPath: string;
        installedAt: string;
        desktopReleaseTag: string | null;
        desktopReleaseCommit: string | null;
        desktopInstallBaseCommit: string | null;
      } | null>,
    recordAppliedCommit: (commit: string, tag?: string) =>
      ipcRenderer.invoke(IPC_UPDATES_RECORD_APPLIED_COMMIT, {
        commit,
        tag,
      }) as Promise<{
        version: string;
        platform: string;
        installPath: string;
        installedAt: string;
        desktopReleaseTag: string | null;
        desktopReleaseCommit: string | null;
        desktopInstallBaseCommit: string | null;
      } | null>,
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
    checkKnowledgeExists: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_KNOWLEDGE_EXISTS),
    collectData: (options?: {
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke(IPC_DISCOVERY_COLLECT_BROWSER_DATA, options),
    detectPreferred: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_DETECT_PREFERRED_BROWSER),
    listProfiles: (browserType: string) =>
      ipcRenderer.invoke(IPC_DISCOVERY_LIST_BROWSER_PROFILES, browserType),
    writeCoreMemory: (
      content: string,
      options?: { includeLocation?: boolean },
    ) =>
      ipcRenderer.invoke(IPC_DISCOVERY_WRITE_CORE_MEMORY, {
        content,
        includeLocation: options?.includeLocation === true,
      }),
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
          iconDataUrl?: string;
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
      target: string | { appName?: string | null; pid?: number | null },
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
  },

  media: {
    saveOutput: (url: string, fileName: string) =>
      ipcRenderer.invoke(IPC_MEDIA_SAVE_OUTPUT, { url, fileName }) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    getStellaMediaDir: () =>
      ipcRenderer.invoke(IPC_MEDIA_GET_DIR) as Promise<string | null>,
    copyImage: (pngBase64: string) =>
      ipcRenderer.invoke(IPC_MEDIA_COPY_IMAGE, { pngBase64 }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
  },

  memory: {
    status: () =>
      ipcRenderer.invoke("memory:status") as Promise<{
        available: boolean;
        status: {
          enabled: boolean;
          pending: boolean;
          running: boolean;
          permission: boolean;
        };
      }>,
    setEnabled: (enabled: boolean, options?: { pending?: boolean }) =>
      ipcRenderer.invoke("memory:setEnabled", {
        enabled,
        pending: options?.pending ?? false,
      }) as Promise<{
        ok: boolean;
        reason?: string;
        status: {
          enabled: boolean;
          pending: boolean;
          running: boolean;
          permission: boolean;
        };
      }>,
    promotePending: () =>
      ipcRenderer.invoke("memory:promotePending") as Promise<{
        ok: boolean;
        promoted: boolean;
        reason?: string;
      }>,
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
    runCronJob: (payload: { jobId: string }) =>
      ipcRenderer.invoke("schedule:runCronJob", payload),
    removeCronJob: (payload: { jobId: string }) =>
      ipcRenderer.invoke("schedule:removeCronJob", payload),
    updateCronJob: (payload: {
      jobId: string;
      patch: Record<string, unknown>;
    }) => ipcRenderer.invoke("schedule:updateCronJob", payload),
    upsertHeartbeat: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke("schedule:upsertHeartbeat", payload),
    runHeartbeat: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("schedule:runHeartbeat", payload),
    onUpdated: onIpcSignal("schedule:updated"),
  },

  store: {
    readFeatureSnapshot: () => ipcRenderer.invoke("store:readFeatureSnapshot"),
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
    installFromBlueprint: (payload: {
      packageId: string;
      releaseNumber: number;
    }) => ipcRenderer.invoke("store:installFromBlueprint", payload),
    getThread: () => ipcRenderer.invoke("store:getThread"),
    sendThreadMessage: (payload: {
      text: string;
      attachedFeatureNames?: string[];
      editingBlueprint?: boolean;
    }) => ipcRenderer.invoke("store:sendThreadMessage", payload),
    cancelThreadTurn: () => ipcRenderer.invoke("store:cancelThreadTurn"),
    denyLatestBlueprint: () => ipcRenderer.invoke("store:denyLatestBlueprint"),
    markBlueprintPublished: (payload: {
      messageId: string;
      releaseNumber: number;
    }) => ipcRenderer.invoke("store:markBlueprintPublished", payload),
    publishBlueprint: (payload: {
      messageId: string;
      packageId: string;
      asUpdate: boolean;
      displayName?: string;
      description?: string;
      category?: string;
      manifest: Record<string, unknown>;
      releaseNotes?: string;
    }) => ipcRenderer.invoke("store:publishBlueprint", payload),
    uninstallPackage: (packageId: string) =>
      ipcRenderer.invoke("store:uninstallMod", { packageId }),
    listConnectors: () => ipcRenderer.invoke("store:listConnectors"),
    installConnector: (
      marketplaceKey: string,
      credential?: string,
      config?: Record<string, string>,
    ) =>
      ipcRenderer.invoke("store:installConnector", {
        marketplaceKey,
        credential,
        config,
      }),
    showBlueprintNotification: (payload: { messageId: string; name: string }) =>
      ipcRenderer.invoke(IPC_STORE_SHOW_BLUEPRINT_NOTIFICATION, payload),
    onBlueprintNotificationActivated: (
      callback: (payload: { messageId: string | null }) => void,
    ) =>
      onIpc<{ messageId: string | null }>(
        IPC_STORE_BLUEPRINT_NOTIFICATION_ACTIVATED,
      )(callback),
    onThreadUpdated: onIpc<
      import("../../runtime/contracts/index.js").StoreThreadSnapshot
    >("store:threadUpdated"),
  },

  storeWeb: {
    show: (payload?: {
      route?: "store" | "billing";
      tab?: string;
      package?: string;
      packageId?: string;
      embedded?: boolean;
      theme?: {
        mode?: "light" | "dark";
        foreground?: string;
        foregroundWeak?: string;
        border?: string;
        primary?: string;
        surface?: string;
        background?: string;
      };
    }) => ipcRenderer.invoke("storeWeb:show", payload),
    hide: () => ipcRenderer.invoke("storeWeb:hide"),
    setLayout: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ipcRenderer.invoke("storeWeb:setLayout", payload),
    setTheme: (payload: {
      mode?: "light" | "dark";
      foreground?: string;
      foregroundWeak?: string;
      border?: string;
      primary?: string;
      surface?: string;
      background?: string;
    }) => ipcRenderer.invoke("storeWeb:setTheme", payload),
    goBack: () => ipcRenderer.invoke("storeWeb:goBack"),
    goForward: () => ipcRenderer.invoke("storeWeb:goForward"),
    reload: () => ipcRenderer.invoke("storeWeb:reload"),
  },

  storeWebLocal: {
    onAction: (
      callback: (payload: { requestId: string; action: unknown }) => void,
    ) =>
      onIpc<{ requestId: string; action: unknown }>("storeWeb:localAction")(
        callback,
      ),
    reply: (payload: {
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }) =>
      ipcRenderer.send(
        `storeWeb:localActionResult:${payload.requestId}`,
        payload,
      ),
  },

  fashion: {
    pickAndSaveBodyPhoto: () =>
      ipcRenderer.invoke("fashion:pickAndSaveBodyPhoto"),
    getBodyPhotoInfo: () => ipcRenderer.invoke("fashion:getBodyPhotoInfo"),
    getBodyPhotoDataUrl: () =>
      ipcRenderer.invoke("fashion:getBodyPhotoDataUrl"),
    deleteBodyPhoto: () => ipcRenderer.invoke("fashion:deleteBodyPhoto"),
    getLocalImageDataUrl: (path: string) =>
      ipcRenderer.invoke("fashion:getLocalImageDataUrl", { path }),
    startOutfitBatch: (payload: {
      prompt?: string;
      batchId?: string;
      count?: number;
      excludeProductIds?: string[];
      seedHints?: string[];
    }) => ipcRenderer.invoke("fashion:startOutfitBatch", payload),
    pickTryOnImages: () => ipcRenderer.invoke("fashion:pickTryOnImages"),
    /**
     * Resolves an absolute filesystem path for a `File` dropped into the
     * fashion drop zone. Uses Electron's `webUtils.getPathForFile`
     * (Electron ≥32) which works under `contextIsolation: true` where
     * `File.path` is no longer exposed. Returns an empty string if the
     * dropped item is not a real on-disk file (e.g. a generated File).
     */
    getDroppedFilePath: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
    startTryOn: (payload: {
      prompt?: string;
      batchId?: string;
      imagePaths?: string[];
      imageUrls?: string[];
    }) => ipcRenderer.invoke("fashion:startTryOn", payload),
  },

  localChat: {
    getOrCreateDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:getOrCreateDefaultConversationId"),
    listEvents: (payload: {
      conversationId: string;
      maxItems?: number;
      windowBy?: "events" | "visible_messages";
    }) => ipcRenderer.invoke("localChat:listEvents", payload),
    listEventsBefore: (payload: {
      conversationId: string;
      beforeTimestampMs: number;
      beforeId?: string;
      limit?: number;
    }) => ipcRenderer.invoke("localChat:listEventsBefore", payload),
    listMessages: (payload: {
      conversationId: string;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke("localChat:listMessages", payload),
    listMessagesBefore: (payload: {
      conversationId: string;
      beforeTimestampMs: number;
      beforeId: string;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke("localChat:listMessagesBefore", payload),
    getEventCount: (payload: {
      conversationId: string;
      countBy?: "events" | "visible_messages";
    }) => ipcRenderer.invoke("localChat:getEventCount", payload),
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
    onUpdated: onIpc<LocalChatUpdatedPayload | null>("localChat:updated"),
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

  pet: {
    getState: () =>
      ipcRenderer.invoke("pet:getState") as Promise<{
        open: boolean;
        status: {
          state:
            | "idle"
            | "running"
            | "waiting"
            | "review"
            | "failed"
            | "waving";
          title: string;
          message: string;
          isLoading: boolean;
        };
      }>,
    setOpen: (open: boolean) => ipcRenderer.send("pet:setOpen", open),
    onSetOpen: onIpc<boolean>("pet:setOpen"),
    moveWindow: (position: { x: number; y: number }) =>
      ipcRenderer.send("pet:moveWindow", position),
    setComposerActive: (active: boolean) =>
      ipcRenderer.send("pet:setComposerActive", active),
    setInteractive: (active: boolean) =>
      ipcRenderer.send("pet:setInteractive", active),
    requestVoice: () => ipcRenderer.send("pet:requestVoice"),
    requestDictation: () => ipcRenderer.send("pet:requestDictation"),
    onDictationActive: onIpc<boolean>("pet:dictationActive"),
    pushStatus: (status: {
      state: "idle" | "running" | "waiting" | "review" | "failed" | "waving";
      title: string;
      message: string;
      isLoading: boolean;
    }) => ipcRenderer.send("pet:status", status),
    onStatus: onIpc<{
      state: "idle" | "running" | "waiting" | "review" | "failed" | "waving";
      title: string;
      message: string;
      isLoading: boolean;
    }>("pet:status"),
    openChat: () => ipcRenderer.send("pet:openChat"),
    sendMessage: (text: string) => ipcRenderer.send("pet:sendMessage", text),
    onSendMessage: onIpc<string>("pet:sendMessage"),
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
