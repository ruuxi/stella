import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ChatContext,
  DesktopReleaseSourceHistoryRef,
  SelfModHmrState,
  StellaReleaseArtifactRef,
} from "../../runtime/contracts/index.js";
import type { TaskLifecycleStatus } from "../../runtime/contracts/agent-runtime.js";
import type { LocalChatUpdatedPayload } from "../../runtime/contracts/local-chat.js";
import type { RadialTriggerCode } from "../src/shared/lib/radial-trigger.js";
import type { MiniDoubleTapModifier } from "../src/shared/lib/mini-double-tap.js";
import type { MorphTimingSettings } from "../src/shared/contracts/morph-timing.js";
import type { OfficePreviewSnapshot } from "../../runtime/contracts/office-preview.js";
import type { RealtimeVoicePreferences } from "../../runtime/contracts/local-preferences.js";
import type {
  ThirdPartyMigrationPreview,
  ThirdPartyMigrationReport,
  ThirdPartyMigrationSelection,
  ThirdPartyMigrationSource,
} from "../src/shared/contracts/migration.js";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_CAPTURE_REGION_FAILED,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
  IPC_MEDIA_COPY_IMAGE,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
  IPC_MIGRATION_DETECT_SOURCES,
  IPC_MIGRATION_PREVIEW,
  IPC_MIGRATION_RUN,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_DISPLAY_LIST_CANVAS_HTML,
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
  OnboardingWelcomeHtmlRequest,
  OnboardingWelcomeHtmlResponse,
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
  IPC_DIAGNOSTICS_REPORT_ERROR,
  IPC_DIAGNOSTICS_OPEN_LOGS,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_LIST_CODEX_MODELS,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_GET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_GET_RADIAL_TRIGGER,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_MINI_DOUBLE_TAP,
  IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_SET_RADIAL_TRIGGER,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_PREFERENCES_GET_WAKE_WORD,
  IPC_PREFERENCES_SET_WAKE_WORD,
  IPC_PREFERENCES_GET_PERSONALITY_VOICE,
  IPC_PREFERENCES_SET_PERSONALITY_VOICE,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_SHELL_LIST_OPENERS,
  IPC_SHELL_OPEN_WITH,
  IPC_SHELL_OPEN_PATH,
  IPC_SYSTEM_OPEN_FDA,
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_UI_STATE_KV_SNAPSHOT,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
  IPC_UPDATES_RECORD_SOURCE_HISTORY,
  IPC_UPDATES_REFRESH_NATIVE_HELPERS,
  IPC_UPDATES_ROLLBACK_CANCELED,
  IPC_UPDATES_TRY_APPLY_CLEAN,
  IPC_VOICE_CREATE_OPENAI_SESSION,
  IPC_VOICE_EXECUTE_TOOL,
  IPC_VOICE_ORCHESTRATOR_CONFIG,
  IPC_VOICE_CREATE_XAI_SESSION,
  IPC_VOICE_CREATE_INWORLD_SESSION,
  IPC_VOICE_REPORT_SESSION_ERROR,
  IPC_VOICE_SESSION_ERROR,
} from "../src/shared/contracts/ipc-channels.js";
import type {
  RuntimeSocialSessionStatus,
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
} from "../../runtime/protocol/index.js";

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

// Shared UI state (~/.stella/ui-state.json) snapshot, read synchronously so
// the boot script and module-load preference reads see it before first paint.
contextBridge.exposeInMainWorld(
  "__stellaUiState",
  (() => {
    try {
      const snapshot = ipcRenderer.sendSync(IPC_UI_STATE_KV_SNAPSHOT) as unknown;
      return snapshot && typeof snapshot === "object" ? snapshot : {};
    } catch {
      return {};
    }
  })(),
);

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  arch: process.arch,

  files: {
    /**
     * Absolute on-disk path for a picker/drag-drop `File`, or "" for
     * synthetic files (e.g. clipboard images). Lets the composer attach
     * images by path so the renderer never loads the original bytes.
     */
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
  },

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
    readFile: (
      filePath: string,
      options?: { conversationId?: string | null },
    ) =>
      ipcRenderer.invoke("display:readFile", {
        filePath,
        conversationId: options?.conversationId,
      }) as Promise<
        | {
            bytes: Uint8Array;
            sizeBytes: number;
            mimeType: string;
            missing: false;
          }
        | { missing: true; mimeType: string; path: string }
      >,
    listCanvasHtml: () =>
      ipcRenderer.invoke(IPC_DISPLAY_LIST_CANVAS_HTML) as Promise<
        Array<{
          filePath: string;
          slug: string;
          title: string;
          createdAt: number;
        }>
      >,
    listTrash: () => ipcRenderer.invoke(IPC_DISPLAY_TRASH_LIST),
    forceDeleteTrash: (payload: { id?: string; all?: boolean }) =>
      ipcRenderer.invoke(IPC_DISPLAY_TRASH_FORCE_DELETE, payload),
  },

  officePreview: {
    list: (options?: { conversationId?: string | null }) =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_LIST, options ?? {}) as Promise<
        OfficePreviewSnapshot[]
      >,
    start: (filePath: string, options?: { conversationId?: string | null }) =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_START, {
        filePath,
        conversationId: options?.conversationId,
      }) as Promise<{
        sessionId: string;
        title: string;
        sourcePath: string;
      }>,
    onUpdate: onIpc<OfficePreviewSnapshot>(IPC_OFFICE_PREVIEW_UPDATE),
  },

  migration: {
    detectSources: () =>
      ipcRenderer.invoke(IPC_MIGRATION_DETECT_SOURCES) as Promise<
        ThirdPartyMigrationPreview[]
      >,
    preview: (payload: {
      source: ThirdPartyMigrationSource;
      sourceRoot?: string;
    }) =>
      ipcRenderer.invoke(
        IPC_MIGRATION_PREVIEW,
        payload,
      ) as Promise<ThirdPartyMigrationPreview>,
    run: (payload: {
      source: ThirdPartyMigrationSource;
      sourceRoot?: string;
      selection?: ThirdPartyMigrationSelection;
    }) =>
      ipcRenderer.invoke(
        IPC_MIGRATION_RUN,
        payload,
      ) as Promise<ThirdPartyMigrationReport>,
  },

  ui: {
    getState: () => ipcRenderer.invoke("ui:getState"),
    setState: (partial: Record<string, unknown>) =>
      ipcRenderer.invoke("ui:setState", partial),
    onState: onIpc<Record<string, unknown>>("ui:state"),
    onOpenChatSidebar: onIpcSignal("chat:openSidebar"),
    setAppReady: (ready: boolean) => ipcRenderer.send("app:setReady", ready),
    reload: () => ipcRenderer.send("app:reload"),
    relaunch: () => ipcRenderer.send("app:relaunch"),
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
    onRegionCaptureFailed: onIpcSignal(IPC_CAPTURE_REGION_FAILED),
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
    submitWindowAttachClick: (point: { x: number; y: number }) =>
      ipcRenderer.send("windowAttach:click", point),
    cancelWindowAttach: () => ipcRenderer.send("windowAttach:cancel"),
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
    beginWindowAttach: () =>
      ipcRenderer.invoke("capture:beginWindowAttach") as Promise<
        | {
            ok: true;
            window: {
              app: string;
              title: string;
              bounds: { x: number; y: number; width: number; height: number };
            };
            miniBounds: { x: number; y: number; width: number; height: number };
          }
        | { cancelled: true }
        | { ok: false; reason: string; message: string }
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
    onAddIcon: onIpcWithEvent<{ iconDataUrl: string | null }>(
      "radial:addIcon",
    ),
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
    onStartRegionCapture: onIpc<{
      mode?: "capture" | "window-attach";
    }>("overlay:startRegionCapture"),
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
      timing?: MorphTimingSettings["hmr"] | null;
    }>("overlay:morphForward"),
    onMorphBounds: onIpc<{
      transitionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>("overlay:morphBounds"),
    onMorphHandoff: onIpc<{
      transitionId: string;
      screenshotDataUrl: string;
      requiresFullReload: boolean;
      flavor?: "hmr" | "onboarding";
      timing?: MorphTimingSettings["hmr"] | null;
    }>("overlay:morphHandoff"),
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
    listInstalled: () => ipcRenderer.invoke("theme:listInstalled"),
  },

  uiState: {
    apply: (changes: Record<string, string | null>) =>
      ipcRenderer.send(IPC_UI_STATE_KV_APPLY, changes),
    clear: () => ipcRenderer.send(IPC_UI_STATE_KV_CLEAR),
    onChanged: onIpc<Record<string, string | null>>(IPC_UI_STATE_KV_CHANGED),
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
      voiceSession?: { durationMs: number };
    }) => ipcRenderer.send("voice:persistTranscript", payload),
    orchestratorChat: (payload: { conversationId: string; message: string }) =>
      ipcRenderer.invoke("voice:orchestratorChat", payload) as Promise<string>,
    getOrchestratorConfig: (payload: { conversationId: string }) =>
      ipcRenderer.invoke(
        IPC_VOICE_ORCHESTRATOR_CONFIG,
        payload,
      ) as Promise<RuntimeVoiceOrchestratorConfig>,
    executeTool: (payload: RuntimeVoiceToolCallPayload) =>
      ipcRenderer.invoke(
        IPC_VOICE_EXECUTE_TOOL,
        payload,
      ) as Promise<RuntimeVoiceToolCallResult>,
    webSearch: (payload: { query: string; category?: string }) =>
      ipcRenderer.invoke("voice:webSearch", payload) as Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>,
    createOpenAISession: (payload: {
      instructions?: string;
      tools?: RuntimeVoiceOrchestratorConfig["tools"];
    }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_OPENAI_SESSION, payload) as Promise<{
        provider: "openai";
        clientSecret: string;
        model: string;
        voice: string;
        expiresAt?: number;
        sessionId?: string;
      }>,
    createXaiSession: (payload: {
      instructions?: string;
      tools?: RuntimeVoiceOrchestratorConfig["tools"];
    }) =>
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
    setRtcShortcut: (shortcut: string) =>
      ipcRenderer.invoke("voice-rtc:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    getRtcShortcut: () =>
      ipcRenderer.invoke("voice-rtc:getShortcut") as Promise<string>,
    reportSessionError: (message: string) =>
      ipcRenderer.send(IPC_VOICE_REPORT_SESSION_ERROR, message),
    onSessionError: onIpc<string>(IPC_VOICE_SESSION_ERROR),
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
      ipcRenderer.invoke(
        "dictation:getSoundEffectsEnabled",
      ) as Promise<boolean>,
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
      model?: string;
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
      clientRequestId?: string;
      selfModMetadata?: {
        packageId?: string;
        releaseNumber?: number;
        mode?: "author" | "install" | "update" | "uninstall" | "desktop-update";
        expectedChangedFiles?: string[];
      };
    }) =>
      ipcRenderer.invoke("agent:startChat", payload) as Promise<{
        requestId: string;
      }>,
    sendInput: (payload: {
      conversationId: string;
      threadId: string;
      message: string;
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
            commitHash: string;
            files: string[];
            batchIndex: number;
            status?: "pending" | "applied";
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
        commitHash: string;
        files: string[];
        batchIndex: number;
        status?: "pending" | "applied";
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
    selfModApply: (commitHash?: string) =>
      ipcRenderer.invoke("selfmod:apply", { commitHash }),
    selfModRevert: (commitHash?: string, steps?: number) =>
      ipcRenderer.invoke("selfmod:revert", { commitHash, steps }),
    getCrashRecoveryStatus: () =>
      ipcRenderer.invoke("selfmod:crashRecoveryStatus"),
    discardUnfinishedSelfModChanges: (conversationId?: string) =>
      ipcRenderer.invoke("selfmod:discardUnfinished", { conversationId }),
    getLastSelfModCommit: () => ipcRenderer.invoke("selfmod:lastCommit"),
    listSelfModCommits: (limit?: number) =>
      ipcRenderer.invoke("selfmod:recentCommits", { limit }) as Promise<
        Array<{
          commitHash: string;
          name: string;
          description: string;
          timestampMs: number;
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
    getLockedComputerUseStatus: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE) as Promise<{
        ok: boolean;
        enabled: boolean;
        installed: boolean;
        active: boolean;
        locked: boolean;
        suppressedUntilManualUnlock: boolean;
        message: string;
        warnings: string[];
      }>,
    setLockedComputerUseEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
        enabled,
      ) as Promise<{
        ok: boolean;
        enabled: boolean;
        installed: boolean;
        active: boolean;
        locked: boolean;
        suppressedUntilManualUnlock: boolean;
        message: string;
        warnings: string[];
      }>,
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
      ipcRenderer.invoke(IPC_PREFERENCES_SET_READ_ALOUD, enabled) as Promise<{
        enabled: boolean;
      }>,
    getOnboardingCompleted: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
      ) as Promise<boolean>,
    setOnboardingCompleted: (completed: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
        completed,
      ) as Promise<{ completed: boolean }>,
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
    reportError: (payload: {
      message?: string;
      stack?: string;
      source?: string;
      kind?: string;
    }) => ipcRenderer.send(IPC_DIAGNOSTICS_REPORT_ERROR, payload),
    openLogs: () =>
      ipcRenderer.invoke(IPC_DIAGNOSTICS_OPEN_LOGS) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    getWakeWordEnabled: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_WAKE_WORD) as Promise<boolean>,
    setWakeWordEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_WAKE_WORD, enabled) as Promise<{
        enabled: boolean;
      }>,
    getPersonalityVoice: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_PERSONALITY_VOICE) as Promise<
        string | null
      >,
    setPersonalityVoice: (voiceId: string) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_PERSONALITY_VOICE,
        voiceId,
      ) as Promise<{ ok: boolean; voiceId: string }>,
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
        agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
        codexModel: string;
        codexReasoningEffort:
          | "default"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
        claudeCodeModel: string;
        claudeCodeReasoningEffort:
          | "default"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
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
      agentRuntimeEngine?: "default" | "claude_code_local" | "codex_cli";
      codexModel?: string;
      codexReasoningEffort?:
        | "default"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh";
      claudeCodeModel?: string;
      claudeCodeReasoningEffort?:
        | "default"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh";
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
        agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
        codexModel: string;
        codexReasoningEffort:
          | "default"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
        claudeCodeModel: string;
        claudeCodeReasoningEffort:
          | "default"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
        maxAgentConcurrency: number;
        imageGeneration: {
          provider: "stella" | "openai" | "openrouter" | "fal";
          model?: string;
        };
        realtimeVoice: RealtimeVoicePreferences;
      } | null>,
    listCodexModels: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_LIST_CODEX_MODELS) as Promise<{
        models: Array<{
          id: string;
          model: string;
          displayName: string;
          description: string;
          hidden: boolean;
          supportedReasoningEfforts: Array<{
            reasoningEffort:
              | "none"
              | "minimal"
              | "low"
              | "medium"
              | "high"
              | "xhigh";
            description: string;
          }>;
          defaultReasoningEffort:
            | "none"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh";
          inputModalities: string[];
          additionalSpeedTiers: string[];
          isDefault: boolean;
        }>;
      }>,
    listClaudeCodeModels: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS) as Promise<{
        models: Array<{
          id: string;
          displayName: string;
          source: "alias" | "anthropic";
        }>;
      }>,
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
    detectTechnicalUserSignals: () =>
      ipcRenderer.invoke("system:detectTechnicalUserSignals") as Promise<{
        signals: Array<
          | "claude-app"
          | "chatgpt-app"
          | "cursor-app"
          | "claude-cli"
          | "codex-cli"
          | "opencode-cli"
          | "pi-cli"
          | "openclaw-cli"
          | "hermes-cli"
        >;
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
    onConnectorCredentialRequest: onIpcWithEvent<{
      requestId: string;
      tokenKey: string;
      displayName: string;
      mode: "api_key" | "oauth";
      completionMode?: "approve" | "wait";
      description?: string;
      placeholder?: string;
      oauthUserCode?: string;
      oauthVerificationUri?: string;
    }>("connector-credential:request"),
    onConnectorCredentialComplete: onIpcWithEvent<{
      requestId: string;
      ok: boolean;
      reason?: string;
    }>("connector-credential:complete"),
    submitConnectorCredential: (payload: {
      requestId: string;
      value: string;
      label?: string;
    }) => ipcRenderer.invoke("connector-credential:submit", payload),
    cancelConnectorCredential: (payload: { requestId: string }) =>
      ipcRenderer.invoke("connector-credential:cancel", payload),
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
        installState: {
          status: "complete";
          desktopReleaseTag: string | null;
          desktopReleaseCommit: string;
          localHeadCommit: string | null;
          nativeHelpersSha: string | null;
          completedAt: string;
        } | null;
        lastUpdateAttempt: {
          status: "updating" | "complete" | "failed";
          targetTag: string | null;
          targetCommit: string;
          startedAt: string;
          finishedAt: string | null;
          reason: string | null;
          operationId: string | null;
          phase:
            | "started"
            | "source-pack-preflight"
            | "source-pack-write"
            | "source-pack-commit"
            | "git-fetch"
            | "git-merge"
            | "dependency-install"
            | "native-refresh"
            | "record-complete"
            | "agent-fallback"
            | null;
          mode: "source-pack" | "git" | "native-helpers" | "agent" | null;
          recoveryAction: "resume" | "discard" | "needs-agent" | null;
          startingHeadCommit: string | null;
          updatedAt: string | null;
          changedFiles: string[];
          ownedTempPaths: string[];
          nativeHelpersManifestUrl: string | null;
        } | null;
      } | null>,
    tryApplyCleanUpdate: (payload: {
      baseCommit: string;
      targetCommit: string;
      releaseTag: string;
      sourcePackRef?: {
        kind: "url";
        url: string;
        sha256: string;
        sizeBytes: number;
      };
      artifactRefs?: StellaReleaseArtifactRef[];
    }) =>
      ipcRenderer.invoke(IPC_UPDATES_TRY_APPLY_CLEAN, payload) as Promise<
        | {
            status: "applied";
            manifest: {
              version: string;
              platform: string;
              installPath: string;
              installedAt: string;
              desktopReleaseTag: string | null;
              desktopReleaseCommit: string | null;
              desktopInstallBaseCommit: string | null;
              installState: {
                status: "complete";
                desktopReleaseTag: string | null;
                desktopReleaseCommit: string;
                localHeadCommit: string | null;
                nativeHelpersSha: string | null;
                completedAt: string;
              } | null;
              lastUpdateAttempt: {
                status: "updating" | "complete" | "failed";
                targetTag: string | null;
                targetCommit: string;
                startedAt: string;
                finishedAt: string | null;
                reason: string | null;
                operationId: string | null;
                phase:
                  | "started"
                  | "source-pack-preflight"
                  | "source-pack-write"
                  | "source-pack-commit"
                  | "git-fetch"
                  | "git-merge"
                  | "dependency-install"
                  | "native-refresh"
                  | "record-complete"
                  | "agent-fallback"
                  | null;
                mode: "source-pack" | "git" | "native-helpers" | "agent" | null;
                recoveryAction: "resume" | "discard" | "needs-agent" | null;
                startingHeadCommit: string | null;
                updatedAt: string | null;
                changedFiles: string[];
                ownedTempPaths: string[];
                nativeHelpersManifestUrl: string | null;
              } | null;
            } | null;
            headCommit: string;
            changedFiles: string[];
            dependencyInstallRan: boolean;
            nativeHelpersRefreshed: boolean;
          }
        | {
            status: "needs-agent";
            reason: string;
            headCommit?: string;
            changedFiles?: string[];
            sourcePackFile?: string;
            sourcePackConflictFile?: string;
            sourcePackConflictJson?: string;
          }
      >,
    recordSourceHistory: (payload: {
      targetCommit: string;
      releaseTag: string;
      sourceHistoryRef?: DesktopReleaseSourceHistoryRef;
    }) =>
      ipcRenderer.invoke(IPC_UPDATES_RECORD_SOURCE_HISTORY, payload) as Promise<
        { ok: true; revisionId: string } | { ok: false; reason: string }
      >,
    refreshNativeHelpers: (
      releaseTag: string,
      artifactRefs?: StellaReleaseArtifactRef[],
    ) =>
      ipcRenderer.invoke(IPC_UPDATES_REFRESH_NATIVE_HELPERS, {
        releaseTag,
        ...(artifactRefs ? { artifactRefs } : {}),
      }) as Promise<{
        ok: boolean;
        manifestUrl: string;
        stdout: string;
        stderr: string;
      }>,
    recordAppliedCommit: (
      commit: string,
      tag?: string,
      options?: {
        mode?: "git-ancestry" | "release-pointer";
        startingHeadCommit?: string;
      },
    ) =>
      ipcRenderer.invoke(IPC_UPDATES_RECORD_APPLIED_COMMIT, {
        commit,
        tag,
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.startingHeadCommit
          ? { startingHeadCommit: options.startingHeadCommit }
          : {}),
      }) as Promise<{
        version: string;
        platform: string;
        installPath: string;
        installedAt: string;
        desktopReleaseTag: string | null;
        desktopReleaseCommit: string | null;
        desktopInstallBaseCommit: string | null;
        installState: {
          status: "complete";
          desktopReleaseTag: string | null;
          desktopReleaseCommit: string;
          localHeadCommit: string | null;
          nativeHelpersSha: string | null;
          completedAt: string;
        } | null;
        lastUpdateAttempt: {
          status: "updating" | "complete" | "failed";
          targetTag: string | null;
          targetCommit: string;
          startedAt: string;
          finishedAt: string | null;
          reason: string | null;
          operationId: string | null;
          phase:
            | "started"
            | "source-pack-preflight"
            | "source-pack-write"
            | "source-pack-commit"
            | "git-fetch"
            | "git-merge"
            | "dependency-install"
            | "native-refresh"
            | "record-complete"
            | "agent-fallback"
            | null;
          mode: "source-pack" | "git" | "native-helpers" | "agent" | null;
          recoveryAction: "resume" | "discard" | "needs-agent" | null;
          startingHeadCommit: string | null;
          updatedAt: string | null;
          changedFiles: string[];
          ownedTempPaths: string[];
          nativeHelpersManifestUrl: string | null;
        } | null;
      } | null>,
    rollbackCanceledUpdate: (payload: {
      startingHeadCommit: string;
      releaseTag?: string;
      changedFiles?: string[];
    }) =>
      ipcRenderer.invoke(IPC_UPDATES_ROLLBACK_CANCELED, payload) as Promise<
        | {
            status: "rolled-back";
            headCommit: string;
            restoredFiles: string[];
          }
        | {
            status: "skipped";
            reason: string;
            headCommit?: string;
          }
      >,
  },

  onboarding: {
    synthesizeCoreMemory: (payload: OnboardingSynthesisRequest) =>
      ipcRenderer.invoke(
        "onboarding:synthesizeCoreMemory",
        payload,
      ) as Promise<OnboardingSynthesisResponse>,
    generateWelcomeHtml: (payload: OnboardingWelcomeHtmlRequest) =>
      ipcRenderer.invoke(
        "onboarding:generateWelcomeHtml",
        payload,
      ) as Promise<OnboardingWelcomeHtmlResponse>,
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
          axTree?: string | null;
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
        pendingItems: number;
        detail?: string;
      }>,
    wipeMemories: () =>
      ipcRenderer.invoke("chronicle:wipeMemories") as Promise<{
        ok: boolean;
        reason?: string;
      }>,
  },

  meetings: {
    status: () =>
      ipcRenderer.invoke("meetings:status") as Promise<{
        available: boolean;
        running?: boolean;
        recording?: boolean;
        paused?: boolean;
        sessionId?: string | null;
        startedAtMs?: number | null;
        segmentSeconds?: number;
        screenPermission?: boolean;
        micPermission?: boolean;
      }>,
    start: (payload?: { sessionId?: string; segmentSeconds?: number }) =>
      ipcRenderer.invoke("meetings:start", payload ?? {}) as Promise<{
        ok: boolean;
        sessionId?: string;
        dir?: string;
        segmentSeconds?: number;
        system?: boolean;
        mic?: boolean;
        startedAtMs?: number;
        reason?: string;
      }>,
    pause: () =>
      ipcRenderer.invoke("meetings:pause") as Promise<{ ok: boolean }>,
    resume: () =>
      ipcRenderer.invoke("meetings:resume") as Promise<{ ok: boolean }>,
    stop: () =>
      ipcRenderer.invoke("meetings:stop") as Promise<{
        ok: boolean;
        sessionId?: string;
        dir?: string;
        durationMs?: number;
        systemSegments?: number;
        micSegments?: number;
        reason?: string;
      }>,
    openFolder: (payload?: { sessionId?: string }) =>
      ipcRenderer.invoke("meetings:openFolder", payload ?? {}) as Promise<{
        ok: boolean;
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
    listFeatureRoster: (payload?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke("store:listFeatureRoster", payload),
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
    publishSelectedFeatures: (payload: {
      attachedFeatureNames: string[];
      attachedFeatureIds?: string[];
      packageId: string;
      asUpdate: boolean;
      displayName?: string;
      description?: string;
      category?: string;
      manifest: Record<string, unknown>;
      releaseNotes?: string;
    }) => ipcRenderer.invoke("store:publishSelectedFeatures", payload),
    uninstallPackage: (packageId: string) =>
      ipcRenderer.invoke("store:uninstallMod", { packageId }),
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
    prewarm: (payload?: {
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
    }) => ipcRenderer.invoke("storeWeb:prewarm", payload),
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
    createNewDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:createNewDefaultConversationId"),
    setActiveConversationId: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("localChat:setActiveConversationId", payload),
    listEvents: (payload: { conversationId: string; maxItems?: number }) =>
      ipcRenderer.invoke("localChat:listEvents", payload),
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
    listMessagesAfter: (payload: {
      conversationId: string;
      afterTimestampMs: number;
      afterId: string;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke("localChat:listMessagesAfter", payload),
    listActivity: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => ipcRenderer.invoke("localChat:listActivity", payload),
    listFiles: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => ipcRenderer.invoke("localChat:listFiles", payload),
    persistDiscoveryWelcome: (payload: {
      conversationId: string;
      message: string;
      firstReport?: unknown;
    }) => ipcRenderer.invoke("localChat:persistDiscoveryWelcome", payload),
    listSyncMessages: (payload: {
      conversationId: string;
      maxMessages?: number;
      includeDeveloperArtifacts?: boolean;
    }) => ipcRenderer.invoke("localChat:listSyncMessages", payload),
    syncMessages: (payload: {
      conversationId: string;
      sinceCursor?: string | null;
      maxMessages?: number;
      includeDeveloperArtifacts?: boolean;
    }) => ipcRenderer.invoke("localChat:syncMessages", payload),
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
    toggleMiniWindow: () => ipcRenderer.send("pet:toggleMiniWindow"),
  },

  nativeIntegrations: {
    list: () => ipcRenderer.invoke("nativeIntegrations:list"),
    enable: (payload: { id: string }) =>
      ipcRenderer.invoke("nativeIntegrations:enable", payload),
    disable: (payload: { id: string }) =>
      ipcRenderer.invoke("nativeIntegrations:disable", payload),
  },
});
