import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { UiState } from "../types.js";
import type { WindowManager } from "../windows/window-manager.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import { createMonotonicSeqGenerator } from "./monotonic-seq.js";
import { applyShortcutRegistration } from "./shortcut-registration.js";
import type { VoiceRuntimeSnapshot } from "../../../runtime/contracts/index.js";
import {
  getRealtimeVoicePreferences,
  loadLocalPreferences,
  resolveRealtimeVoiceId,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import {
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_INWORLD_REALTIME_VOICE,
  DEFAULT_OPENAI_REALTIME_VOICE,
  DEFAULT_XAI_REALTIME_VOICE,
} from "../../../runtime/contracts/realtime-voice-catalog.js";
import { AGENT_STREAM_EVENT_TYPES } from "../../../runtime/contracts/agent-runtime.js";
import { getLocalLlmCredential } from "../../../runtime/kernel/storage/llm-credentials.js";
import { getLocalLlmOAuthApiKey } from "../../../runtime/kernel/storage/llm-oauth-credentials.js";
import { redactMemoryText } from "../../../runtime/kernel/memory/redaction.js";
import type {
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
} from "../../../runtime/protocol/index.js";
import {
  IPC_VOICE_CREATE_OPENAI_SESSION,
  IPC_VOICE_EXECUTE_TOOL,
  IPC_VOICE_ORCHESTRATOR_CONFIG,
  IPC_VOICE_CREATE_XAI_SESSION,
  IPC_VOICE_CREATE_INWORLD_SESSION,
  IPC_VOICE_REPORT_SESSION_ERROR,
  IPC_VOICE_SESSION_ERROR,
} from "../../src/shared/contracts/ipc-channels.js";

type VoiceHandlersOptions = {
  uiState: UiState;
  getAppReady: () => boolean;
  windowManager: WindowManager;
  getPetWindow?: () => BrowserWindow | null;
  broadcastUiState: () => void;
  /** Centralized "go to voice now" handler — opens the floating pet
   *  and toggles the realtime voice session. Voice no longer has its
   *  own creature overlay; the pet sprite animates listening /
   *  speaking instead. */
  togglePetVoice: () => void;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
  getOverlayController?: () => OverlayWindowController | null;
  stellaAppDir: string;
  stellaDataDirPath: string;
};

const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_XAI_REALTIME_MODEL = "grok-voice-think-fast-1.0";

// Inworld's STUN/TURN credentials are short-lived but stable enough across
// rapid voice-session restarts (e.g. wake-word retries) that re-fetching
// on every connect adds tens-to-hundreds of ms of avoidable latency. Cache
// per Bearer token for 5 minutes — short enough that credential rotation
// recovers on its own, long enough to absorb restart bursts.
type InworldIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};
const INWORLD_ICE_CACHE_TTL_MS = 5 * 60 * 1000;
const inworldIceCache = new Map<
  string,
  { fetchedAt: number; iceServers: InworldIceServer[] }
>();

const fetchInworldIceServers = async (
  apiKey: string,
): Promise<InworldIceServer[]> => {
  const cached = inworldIceCache.get(apiKey);
  if (cached && Date.now() - cached.fetchedAt < INWORLD_ICE_CACHE_TTL_MS) {
    return cached.iceServers;
  }
  try {
    const response = await fetch(
      "https://api.inworld.ai/v1/realtime/ice-servers",
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok) {
      console.warn(
        "[voice] Inworld ice-servers fetch failed:",
        response.status,
        await response.text(),
      );
      return cached?.iceServers ?? [];
    }
    const data = (await response.json()) as {
      ice_servers?: InworldIceServer[];
    };
    const iceServers = Array.isArray(data.ice_servers) ? data.ice_servers : [];
    inworldIceCache.set(apiKey, { fetchedAt: Date.now(), iceServers });
    return iceServers;
  } catch (err) {
    console.warn(
      "[voice] Inworld ice-servers fetch error:",
      (err as Error).message,
    );
    return cached?.iceServers ?? [];
  }
};

const DEFAULT_RUNTIME_STATE: VoiceRuntimeSnapshot = {
  sessionState: "idle",
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
};

export const registerVoiceHandlers = (options: VoiceHandlersOptions) => {
  let currentVoiceRtcShortcut = "";
  let runtimeState: VoiceRuntimeSnapshot = DEFAULT_RUNTIME_STATE;
  const nextTaskEventSeq = createMonotonicSeqGenerator();

  const ts = () => {
    const d = new Date();
    return `${d.toLocaleTimeString("en-US", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };

  const emitVoiceAgentEvent = (eventPayload: Record<string, unknown>) => {
    const fullWindow = options.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send("agent:event", eventPayload);
    }
    options.getBroadcastToMobile?.()?.("agent:event", eventPayload);
  };

  const emitVoiceDisplayPayload = (payload: Record<string, unknown>) => {
    for (const window of options.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send("display:update", payload);
    }
    options.getBroadcastToMobile?.()?.("display:update", payload);
  };

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  const errorMessage = (value: unknown): string =>
    value instanceof Error ? value.message : String(value ?? "Unknown error");

  const htmlDisplayPayloadFromVoiceTool = (
    payload: RuntimeVoiceToolCallPayload,
    result: RuntimeVoiceToolCallResult,
  ): Record<string, unknown> | null => {
    if (payload.name !== "html" || result.error) return null;
    const details = asRecord(result.details);
    const filePath =
      typeof details?.filePath === "string" && details.filePath.trim()
        ? details.filePath.trim()
        : "";
    if (!filePath) return null;
    return {
      kind: "canvas-html",
      filePath,
      ...(typeof details?.title === "string" && details.title.trim()
        ? { title: details.title.trim() }
        : {}),
      ...(typeof details?.slug === "string" && details.slug.trim()
        ? { slug: details.slug.trim() }
        : {}),
      ...(typeof details?.createdAt === "number" &&
      Number.isFinite(details.createdAt)
        ? { createdAt: details.createdAt }
        : {}),
    };
  };

  const emitVoiceToolStart = (payload: RuntimeVoiceToolCallPayload) => {
    emitVoiceAgentEvent({
      type: AGENT_STREAM_EVENT_TYPES.TOOL_START,
      runId: payload.requestId || `voice:${payload.callId}`,
      conversationId: payload.conversationId,
      requestId: payload.requestId,
      seq: nextTaskEventSeq(),
      agentType: "orchestrator",
      toolCallId: payload.callId,
      toolName: payload.name,
      args: payload.args,
    });
  };

  const emitVoiceToolEnd = (
    payload: RuntimeVoiceToolCallPayload,
    result: RuntimeVoiceToolCallResult,
  ) => {
    emitVoiceAgentEvent({
      type: AGENT_STREAM_EVENT_TYPES.TOOL_END,
      runId: payload.requestId || `voice:${payload.callId}`,
      conversationId: payload.conversationId,
      requestId: payload.requestId,
      seq: nextTaskEventSeq(),
      agentType: "orchestrator",
      toolCallId: payload.callId,
      toolName: payload.name,
      resultPreview: result.output,
      ...(result.details !== undefined ? { details: result.details } : {}),
      ...(result.fileChanges?.length
        ? { fileChanges: result.fileChanges }
        : {}),
      ...(result.producedFiles?.length
        ? { producedFiles: result.producedFiles }
        : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  };

  const emitVoiceHmrState = (state: unknown) => {
    const targetWindow = options.windowManager.getFullWindow();
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send("agent:selfModHmrState", state);
    }
  };

  const broadcastRuntimeState = () => {
    const windows = options.windowManager.getAllWindows();
    const petWindow = options.getPetWindow?.() ?? null;
    if (petWindow && !petWindow.isDestroyed() && !windows.includes(petWindow)) {
      windows.push(petWindow);
    }
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("voice:runtimeState", runtimeState);
    }
    options.getBroadcastToMobile?.()?.("voice:runtimeState", runtimeState);
  };

  // The voice runtime lives in the hidden, screen-spanning overlay window, so
  // a toast raised there is painted where the user can never see it. Route
  // actionable voice errors to the full app window, where the toast and its
  // sign-in/settings CTA work as expected.
  const emitVoiceSessionErrorToast = (message: unknown) => {
    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!trimmed) return;
    const target = options.windowManager.getFullWindow();
    if (target && !target.isDestroyed()) {
      target.webContents.send(IPC_VOICE_SESSION_ERROR, trimmed);
    }
  };

  ipcMain.on(IPC_VOICE_REPORT_SESSION_ERROR, (_event, message: string) => {
    emitVoiceSessionErrorToast(message);
  });

  const toggleVoiceRtc = () => {
    if (!options.getAppReady()) return;
    options.togglePetVoice();
  };

  const loadConfiguredShortcut = () => {
    return loadLocalPreferences(options.stellaAppDir).voiceRtcShortcut;
  };

  const saveConfiguredShortcut = (shortcut: string) => {
    const prefs = loadLocalPreferences(options.stellaAppDir);
    prefs.voiceRtcShortcut = shortcut;
    saveLocalPreferences(options.stellaAppDir, prefs);
  };

  const initialVoiceRtcShortcut = applyShortcutRegistration({
    label: "Voice realtime",
    requestedShortcut: loadConfiguredShortcut(),
    currentShortcut: currentVoiceRtcShortcut,
    callback: toggleVoiceRtc,
  });
  currentVoiceRtcShortcut = initialVoiceRtcShortcut.activeShortcut;
  if (!initialVoiceRtcShortcut.ok) {
    console.warn("[voice]", initialVoiceRtcShortcut.error);
  }

  ipcMain.handle("voice-rtc:setShortcut", (_event, shortcut: string) => {
    const result = applyShortcutRegistration({
      label: "Voice realtime",
      requestedShortcut: shortcut,
      currentShortcut: currentVoiceRtcShortcut,
      callback: toggleVoiceRtc,
    });
    currentVoiceRtcShortcut = result.activeShortcut;
    if (!result.ok) {
      console.warn("[voice]", result.error);
    } else {
      saveConfiguredShortcut(result.activeShortcut);
    }
    return result;
  });

  ipcMain.handle("voice-rtc:getShortcut", () => currentVoiceRtcShortcut);

  ipcMain.handle("voice:getCoreMemory", async () => {
    try {
      const content = await fs.readFile(
        path.join(options.stellaDataDirPath, "core-memory.md"),
        "utf-8",
      );
      return redactMemoryText(content);
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    IPC_VOICE_CREATE_OPENAI_SESSION,
    async (
      _event,
      payload: {
        instructions?: string;
        tools?: Array<{
          type: "function";
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        }>;
      },
    ) => {
      const preferences = getRealtimeVoicePreferences(options.stellaAppDir);
      if (preferences.provider !== "openai") {
        throw new Error("OpenAI is not selected for voice.");
      }
      const apiKey =
        getLocalLlmCredential(options.stellaAppDir, "openai")?.trim() ||
        (await getLocalLlmOAuthApiKey(options.stellaAppDir, "openai"))?.trim();
      if (!apiKey) {
        throw new Error("Connect OpenAI in Settings to use it for voice.");
      }
      const model = preferences.model?.startsWith("openai/")
        ? preferences.model.slice("openai/".length)
        : preferences.model || DEFAULT_OPENAI_REALTIME_MODEL;
      const voice = resolveRealtimeVoiceId(
        preferences,
        "openai",
        DEFAULT_OPENAI_REALTIME_VOICE,
      );
      const response = await fetch(
        "https://api.openai.com/v1/realtime/client_secrets",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session: {
              type: "realtime",
              model,
              instructions:
                typeof payload?.instructions === "string"
                  ? payload.instructions
                  : undefined,
              ...(payload?.tools?.length
                ? { tools: payload.tools, tool_choice: "auto" }
                : {}),
              audio: {
                output: {
                  voice,
                },
              },
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Failed to create OpenAI voice session: ${response.status} ${await response.text()}`,
        );
      }
      const data = (await response.json()) as {
        value?: unknown;
        client_secret?: { value?: unknown; expires_at?: unknown };
        expires_at?: unknown;
        session?: { id?: unknown; model?: unknown };
      };
      const clientSecret =
        typeof data.value === "string"
          ? data.value
          : typeof data.client_secret?.value === "string"
            ? data.client_secret.value
            : null;
      if (!clientSecret) {
        throw new Error(
          "OpenAI voice session response did not include a client secret.",
        );
      }
      return {
        provider: "openai" as const,
        clientSecret,
        model:
          typeof data.session?.model === "string" ? data.session.model : model,
        voice,
        expiresAt:
          typeof data.expires_at === "number"
            ? data.expires_at
            : typeof data.client_secret?.expires_at === "number"
              ? data.client_secret.expires_at
              : undefined,
        sessionId:
          typeof data.session?.id === "string" ? data.session.id : undefined,
      };
    },
  );

  ipcMain.handle(
    IPC_VOICE_CREATE_XAI_SESSION,
    async (
      _event,
      payload: {
        instructions?: string;
        tools?: Array<{
          type: "function";
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        }>;
      },
    ) => {
      const preferences = getRealtimeVoicePreferences(options.stellaAppDir);
      if (preferences.provider !== "xai") {
        throw new Error("xAI is not selected for voice.");
      }
      const apiKey =
        getLocalLlmCredential(options.stellaAppDir, "xai")?.trim() ||
        (await getLocalLlmOAuthApiKey(options.stellaAppDir, "xai"))?.trim();
      if (!apiKey) {
        throw new Error("Connect xAI in Settings to use it for voice.");
      }
      const model = preferences.model?.startsWith("xai/")
        ? preferences.model.slice("xai/".length)
        : preferences.model || DEFAULT_XAI_REALTIME_MODEL;
      const voice = resolveRealtimeVoiceId(
        preferences,
        "xai",
        DEFAULT_XAI_REALTIME_VOICE,
      );

      const instructions =
        typeof payload?.instructions === "string"
          ? payload.instructions
          : undefined;

      // Try minting a true ephemeral token first. xAI's Voice Agent API
      // is OpenAI-Realtime-compatible, so we target the analogous
      // /v1/realtime/client_secrets endpoint. If xAI hasn't shipped that
      // (or returns a 404/405), fall back to using the API key as the
      // subprotocol token directly — xAI accepts long-lived auth on the
      // WebSocket too. Either way the renderer treats the response shape
      // identically.
      let clientSecret: string | null = null;
      let expiresAt: number | undefined;
      try {
        const response = await fetch(
          "https://api.x.ai/v1/realtime/client_secrets",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              session: {
                type: "realtime",
                model,
                instructions,
                ...(payload?.tools?.length
                  ? { tools: payload.tools, tool_choice: "auto" }
                  : {}),
                voice,
              },
            }),
          },
        );
        if (response.ok) {
          const data = (await response.json()) as {
            value?: unknown;
            client_secret?: { value?: unknown; expires_at?: unknown };
            expires_at?: unknown;
          };
          if (typeof data.value === "string") {
            clientSecret = data.value;
          } else if (typeof data.client_secret?.value === "string") {
            clientSecret = data.client_secret.value;
          }
          if (typeof data.expires_at === "number") {
            expiresAt = data.expires_at;
          } else if (typeof data.client_secret?.expires_at === "number") {
            expiresAt = data.client_secret.expires_at;
          }
        } else if (response.status !== 404 && response.status !== 405) {
          // Non-fallback HTTP error — surface it so the user can fix.
          throw new Error(
            `Failed to create xAI voice session: ${response.status} ${await response.text()}`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Failed to")) {
          throw err;
        }
        // Network/parse error — fall through to direct-key fallback.
        console.debug(
          "[voice] xAI ephemeral token mint failed, falling back to API key:",
          (err as Error).message,
        );
      }

      if (!clientSecret) {
        clientSecret = apiKey;
      }

      return {
        provider: "xai" as const,
        clientSecret,
        model,
        voice,
        expiresAt,
      };
    },
  );

  ipcMain.handle(
    IPC_VOICE_CREATE_INWORLD_SESSION,
    async (
      _event,
      _payload: {
        instructions?: string;
      },
    ) => {
      const preferences = getRealtimeVoicePreferences(options.stellaAppDir);
      if (preferences.provider !== "inworld") {
        throw new Error("Inworld is not selected for voice.");
      }
      const apiKey =
        getLocalLlmCredential(options.stellaAppDir, "inworld")?.trim() ||
        (await getLocalLlmOAuthApiKey(options.stellaAppDir, "inworld"))?.trim();
      if (!apiKey) {
        throw new Error("Connect Inworld in Settings to use it for voice.");
      }
      const model = preferences.model?.startsWith("inworld/")
        ? preferences.model.slice("inworld/".length)
        : preferences.model || DEFAULT_INWORLD_REALTIME_MODEL;
      const voice = resolveRealtimeVoiceId(
        preferences,
        "inworld",
        DEFAULT_INWORLD_REALTIME_VOICE,
      );

      // Inworld's WebRTC SDP endpoint requires a complete offer with ICE
      // candidates baked in, so we need their STUN/TURN servers up front.
      const iceServers = await fetchInworldIceServers(apiKey);

      // Inworld doesn't use ephemeral tokens — the API key is the Bearer
      // for the SDP exchange. In BYOK mode we hand the user's own key
      // back to the renderer because it's their key on their machine.
      // (Stella-managed Inworld goes through a backend SDP proxy so the
      // org key never reaches the renderer; that's a different path.)
      return {
        provider: "inworld" as const,
        clientSecret: apiKey,
        model,
        voice,
        iceServers,
      };
    },
  );

  ipcMain.on(
    "voice:persistTranscript",
    (
      _event,
      payload: {
        conversationId: string;
        role: "user" | "assistant";
        text: string;
        uiVisibility?: "visible" | "hidden";
        voiceSession?: { durationMs: number };
      },
    ) => {
      console.log(
        `[${ts()}] [Voice RTC] ${payload.role.toUpperCase()}: ${payload.text}`,
      );
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        return;
      }
      stellaHostRunner.persistVoiceTranscript(payload).catch((err) => {
        console.debug(
          "[voice] transcript persistence failed (best-effort):",
          (err as Error).message,
        );
      });
    },
  );

  ipcMain.handle(
    "voice:orchestratorChat",
    async (_event, payload: { conversationId: string; message: string }) => {
      console.log(
        `[${ts()}] [Voice] orchestratorChat request:`,
        payload.message,
      );
      if (!options.uiState.isVoiceRtcActive) {
        throw new Error("Voice mode is no longer active.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not initialized");
      }

      return await stellaHostRunner.handleVoiceChat(payload, {
        onStream: () => {},
        onToolStart: (event) => {
          emitVoiceAgentEvent({ ...event, type: "tool-start" });
        },
        onToolEnd: (event) => {
          emitVoiceAgentEvent({ ...event, type: "tool-end" });
        },
        onAgentEvent: (event) => {
          emitVoiceAgentEvent({
            type: event.type,
            runId: event.rootRunId ?? "voice",
            seq: nextTaskEventSeq(),
            agentId: event.agentId,
            agentType: event.agentType,
            description: event.description,
            parentAgentId: event.parentAgentId,
            result: event.result,
            error: event.error,
            statusText: event.statusText,
          });
        },
        onSelfModHmrState: (state) => {
          emitVoiceHmrState(state);
        },
        onRunFinished: (event) => {
          if (event.outcome === "error") {
            console.error(
              `[${ts()}] [Voice] orchestratorChat error:`,
              event.error ?? event.reason,
            );
          }
          emitVoiceAgentEvent({ ...event, type: "run-finished" });
        },
      });
    },
  );

  ipcMain.handle(
    IPC_VOICE_ORCHESTRATOR_CONFIG,
    async (_event, payload: { conversationId: string }) => {
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not initialized");
      }
      return await stellaHostRunner.getVoiceOrchestratorConfig(payload);
    },
  );

  ipcMain.handle(
    IPC_VOICE_EXECUTE_TOOL,
    async (
      _event,
      payload: RuntimeVoiceToolCallPayload,
    ) => {
      if (!options.uiState.isVoiceRtcActive) {
        throw new Error("Voice mode is no longer active.");
      }
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        throw new Error("Stella runtime not initialized");
      }
      emitVoiceToolStart(payload);
      try {
        const result = await stellaHostRunner.executeVoiceTool(payload);
        emitVoiceToolEnd(payload, result);
        const displayPayload = htmlDisplayPayloadFromVoiceTool(payload, result);
        if (displayPayload) {
          emitVoiceDisplayPayload(displayPayload);
        }
        return result;
      } catch (error) {
        const message = errorMessage(error);
        emitVoiceToolEnd(payload, {
          output: `Error: ${message}`,
          error: message,
        });
        throw error;
      }
    },
  );

  ipcMain.handle(
    "voice:webSearch",
    async (
      _event,
      payload: {
        query: string;
        category?: string;
      },
    ) => {
      const stellaHostRunner = options.getStellaHostRunner();
      if (!stellaHostRunner) {
        return { text: "Stella runtime not initialized.", results: [] };
      }
      return await stellaHostRunner.voiceWebSearch(payload);
    },
  );

  ipcMain.handle("voice:getRuntimeState", () => runtimeState);

  ipcMain.on(
    "voice:runtimeState",
    (_event, nextState: VoiceRuntimeSnapshot) => {
      runtimeState = {
        sessionState: nextState?.sessionState ?? "idle",
        isConnected: Boolean(nextState?.isConnected),
        isSpeaking: Boolean(nextState?.isSpeaking),
        isUserSpeaking: Boolean(nextState?.isUserSpeaking),
        micLevel: Number.isFinite(nextState?.micLevel)
          ? Math.max(0, Number(nextState.micLevel))
          : 0,
        outputLevel: Number.isFinite(nextState?.outputLevel)
          ? Math.max(0, Number(nextState.outputLevel))
          : 0,
      };
      broadcastRuntimeState();
    },
  );
};
