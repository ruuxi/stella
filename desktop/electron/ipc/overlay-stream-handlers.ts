import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { readAssistantText, streamSimple } from "../core/ai/stream.js";
import { resolveLlmRoute } from "../core/runtime/model-routing.js";
import {
  getDefaultModel,
  getModelOverride,
} from "../core/runtime/preferences/local-preferences.js";
import {
  buildStellaChatContext,
  type ChatMessage,
} from "../core/runtime/stella-provider.js";

type OverlayStreamHandlersOptions = {
  getStellaHomePath: () => string | null;
  getConvexSiteUrl: () => string | null;
  getAuthToken: () => Promise<string | null> | string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type AutoPanelStartPayload = {
  requestId?: string;
  agentType?: string;
  messages?: ChatMessage[];
};

const activeStreams = new Map<string, AbortController>();

const AUTO_PANEL_CHUNK_CHANNEL = "overlay:autoPanelChunk";
const AUTO_PANEL_COMPLETE_CHANNEL = "overlay:autoPanelComplete";
const AUTO_PANEL_ERROR_CHANNEL = "overlay:autoPanelError";

const toRequestKey = (senderId: number, requestId: string) =>
  `${senderId}:${requestId}`;

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isChatMessageArray = (value: unknown): value is ChatMessage[] =>
  Array.isArray(value);

const sendToRenderer = (
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  payload: Record<string, unknown>,
) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send(channel, payload);
  }
};

export const registerOverlayStreamHandlers = (
  options: OverlayStreamHandlersOptions,
) => {
  ipcMain.handle(
    "overlay:autoPanelStart",
    async (event, payload: AutoPanelStartPayload) => {
      if (!options.assertPrivilegedSender(event, "overlay:autoPanelStart")) {
        throw new Error("Blocked untrusted request.");
      }

      const requestId = asTrimmedString(payload?.requestId);
      if (!requestId) {
        throw new Error("Missing auto panel request ID.");
      }

      const agentType = asTrimmedString(payload?.agentType) || "auto";
      const messages = isChatMessageArray(payload?.messages)
        ? payload.messages
        : [];
      const streamKey = toRequestKey(event.sender.id, requestId);

      activeStreams.get(streamKey)?.abort();

      const abortController = new AbortController();
      activeStreams.set(streamKey, abortController);

      void (async () => {
        try {
          const stellaHomePath = options.getStellaHomePath();
          if (!stellaHomePath) {
            throw new Error("Local Stella home is unavailable.");
          }

          const authToken = await Promise.resolve(options.getAuthToken());
          const resolvedRoute = resolveLlmRoute({
            stellaHomePath,
            modelName:
              getModelOverride(stellaHomePath, agentType)
              ?? getDefaultModel(stellaHomePath, agentType),
            agentType,
            proxy: {
              baseUrl: options.getConvexSiteUrl(),
              getAuthToken: () => authToken,
            },
          });

          const stream = streamSimple(
            resolvedRoute.model,
            buildStellaChatContext(messages),
            {
              apiKey: resolvedRoute.getApiKey(),
              signal: abortController.signal,
            },
          );

          let fullText = "";

          for await (const streamEvent of stream) {
            if (streamEvent.type !== "text_delta") {
              continue;
            }

            fullText += streamEvent.delta;
            sendToRenderer(event, AUTO_PANEL_CHUNK_CHANNEL, {
              requestId,
              chunk: streamEvent.delta,
            });
          }

          const finalMessage = await stream.result();
          if (
            abortController.signal.aborted
            || finalMessage.stopReason === "aborted"
          ) {
            return;
          }

          if (finalMessage.stopReason === "error") {
            throw new Error(finalMessage.errorMessage || "Auto panel request failed");
          }

          sendToRenderer(event, AUTO_PANEL_COMPLETE_CHANNEL, {
            requestId,
            text: fullText || readAssistantText(finalMessage),
          });
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }

          sendToRenderer(event, AUTO_PANEL_ERROR_CHANNEL, {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (activeStreams.get(streamKey) === abortController) {
            activeStreams.delete(streamKey);
          }
        }
      })();
      return { ok: true as const };
    },
  );

  ipcMain.on(
    "overlay:autoPanelCancel",
    (event, payload: { requestId?: string } | string) => {
      if (!options.assertPrivilegedSender(event, "overlay:autoPanelCancel")) {
        return;
      }

      const requestId =
        typeof payload === "string"
          ? payload.trim()
          : asTrimmedString(payload?.requestId);
      if (!requestId) {
        return;
      }

      const streamKey = toRequestKey(event.sender.id, requestId);
      const controller = activeStreams.get(streamKey);
      if (!controller) {
        return;
      }

      activeStreams.delete(streamKey);
      controller.abort();
    },
  );
};
