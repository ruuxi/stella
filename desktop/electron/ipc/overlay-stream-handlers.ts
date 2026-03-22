import {
  ipcMain,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { ChatMessage } from "../../src/shared/stella-api.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

type OverlayStreamHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
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

type ActiveOverlayRequest = {
  senderId: number;
  rendererRequestId: string;
  runtimeRequestId: string;
};

const AUTO_PANEL_CHUNK_CHANNEL = "overlay:autoPanelChunk";
const AUTO_PANEL_COMPLETE_CHANNEL = "overlay:autoPanelComplete";
const AUTO_PANEL_ERROR_CHANNEL = "overlay:autoPanelError";

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isChatMessageArray = (value: unknown): value is ChatMessage[] =>
  Array.isArray(value);

const toOwnerKey = (senderId: number, requestId: string) =>
  `${senderId}:${requestId}`;

const waitForRunner = async (
  options: OverlayStreamHandlersOptions,
  timeoutMs = 10_000,
) =>
  await waitForConnectedRunner(options.getStellaHostRunner, {
    timeoutMs,
    unavailableMessage: "Runtime not available.",
    onRunnerChanged: options.onStellaHostRunnerChanged,
  });

const sendToRenderer = (
  senderId: number,
  channel: string,
  payload: Record<string, unknown>,
) => {
  const target = webContents.fromId(senderId);
  if (target && !target.isDestroyed()) {
    target.send(channel, payload);
  }
};

export const registerOverlayStreamHandlers = (
  options: OverlayStreamHandlersOptions,
) => {
  const activeRequests = new Map<string, ActiveOverlayRequest>();
  const activeRequestIdsByOwner = new Map<string, string>();
  let currentRunner: StellaHostRunner | null = null;
  let unsubscribeRunnerEvents: (() => void) | null = null;

  const clearActiveRequest = (runtimeRequestId: string) => {
    const active = activeRequests.get(runtimeRequestId);
    if (!active) {
      return;
    }
    activeRequests.delete(runtimeRequestId);
    activeRequestIdsByOwner.delete(
      toOwnerKey(active.senderId, active.rendererRequestId),
    );
  };

  const flushActiveRequests = (error: string) => {
    const requests = Array.from(activeRequests.values());
    activeRequests.clear();
    activeRequestIdsByOwner.clear();
    for (const request of requests) {
      sendToRenderer(request.senderId, AUTO_PANEL_ERROR_CHANNEL, {
        requestId: request.rendererRequestId,
        error,
      });
    }
  };

  const bindRunnerEvents = (runner: StellaHostRunner | null) => {
    if (currentRunner === runner) {
      return;
    }
    const previousRunner = currentRunner;
    unsubscribeRunnerEvents?.();
    unsubscribeRunnerEvents = null;
    currentRunner = runner;

    if (previousRunner && previousRunner !== runner && activeRequests.size > 0) {
      flushActiveRequests(
        "Auto panel request interrupted while Stella restarted.",
      );
    }

    if (!runner) {
      return;
    }

    unsubscribeRunnerEvents = runner.onOverlayAutoPanelEvent((eventPayload) => {
      const active = activeRequests.get(eventPayload.requestId);
      if (!active) {
        return;
      }

      if (eventPayload.kind === "chunk") {
        sendToRenderer(active.senderId, AUTO_PANEL_CHUNK_CHANNEL, {
          requestId: active.rendererRequestId,
          chunk: eventPayload.chunk,
        });
        return;
      }

      if (eventPayload.kind === "complete") {
        clearActiveRequest(eventPayload.requestId);
        sendToRenderer(active.senderId, AUTO_PANEL_COMPLETE_CHANNEL, {
          requestId: active.rendererRequestId,
          text: eventPayload.text,
        });
        return;
      }

      clearActiveRequest(eventPayload.requestId);
      sendToRenderer(active.senderId, AUTO_PANEL_ERROR_CHANNEL, {
        requestId: active.rendererRequestId,
        error: eventPayload.error,
      });
    });
  };

  options.onStellaHostRunnerChanged?.((runner) => {
    bindRunnerEvents(runner);
  });
  bindRunnerEvents(options.getStellaHostRunner());

  ipcMain.handle(
    "overlay:autoPanelStart",
    async (event, payload: AutoPanelStartPayload) => {
      if (!options.assertPrivilegedSender(event, "overlay:autoPanelStart")) {
        throw new Error("Blocked untrusted request.");
      }

      const runner = await waitForRunner(options);
      bindRunnerEvents(runner);

      const requestId = asTrimmedString(payload?.requestId);
      if (!requestId) {
        throw new Error("Missing auto panel request ID.");
      }

      const ownerKey = toOwnerKey(event.sender.id, requestId);
      const previousRuntimeRequestId = activeRequestIdsByOwner.get(ownerKey);
      if (previousRuntimeRequestId) {
        clearActiveRequest(previousRuntimeRequestId);
        void runner.cancelOverlayAutoPanelStream(previousRuntimeRequestId);
      }

      const runtimeRequestId = `${ownerKey}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
      activeRequests.set(runtimeRequestId, {
        senderId: event.sender.id,
        rendererRequestId: requestId,
        runtimeRequestId,
      });
      activeRequestIdsByOwner.set(ownerKey, runtimeRequestId);

      try {
        await runner.startOverlayAutoPanelStream({
          requestId: runtimeRequestId,
          agentType: asTrimmedString(payload?.agentType) || "auto",
          messages: isChatMessageArray(payload?.messages) ? payload.messages : [],
        });
      } catch (error) {
        clearActiveRequest(runtimeRequestId);
        throw error;
      }

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

      const ownerKey = toOwnerKey(event.sender.id, requestId);
      const runtimeRequestId = activeRequestIdsByOwner.get(ownerKey);
      if (!runtimeRequestId) {
        return;
      }

      clearActiveRequest(runtimeRequestId);
      void options.getStellaHostRunner()?.cancelOverlayAutoPanelStream(runtimeRequestId);
    },
  );
};
