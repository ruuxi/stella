import { pathToFileURL } from "node:url";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  assertComputerUseRequest,
  type ComputerUseActionCommand,
  type ComputerUseActionReceipt,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseTarget,
  type JsonObject,
} from "./contract.js";
import type { ComputerUseSession } from "./session.js";
import {
  formatWindowsWindowList,
  lookupWindowsComputerElement,
  readWindowsComputerSnapshot,
  rememberWindowsComputerSnapshot,
  requestWindowsComputerHelper,
  windowsComputerScreenshotPath,
  windowsComputerSnapshotLines,
  withWindowsComputerSessionLock,
  type WinHelperRequest,
  type WinHelperResponse,
  type WinSnapshot,
} from "../cli/stella-computer-windows.js";

export type WindowsComputerHelperRequest = (
  sessionId: string,
  request: WindowsComputerHelperOperation,
  signal?: AbortSignal,
) => Promise<WinHelperResponse>;

export type WindowsComputerHelperBatchRequest = Readonly<{
  tool: "batch";
  commands: readonly WinHelperRequest[];
}>;

export type WindowsComputerHelperOperation =
  | WinHelperRequest
  | WindowsComputerHelperBatchRequest;

type WindowsComputerHelperBatchResult = Readonly<{
  index: number;
  ok: boolean;
  result?: WinHelperResponse;
  error?: string;
}>;

type WindowsComputerHelperBatchResponse = WinHelperResponse &
  Readonly<{
    completed?: number;
    results?: WindowsComputerHelperBatchResult[];
  }>;

export type WindowsComputerUseSessionOptions = Readonly<{
  requestHelper?: WindowsComputerHelperRequest;
}>;

const responseEnvelope = (request: ComputerUseRequest) => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const errorResponse = (
  request: ComputerUseRequest,
  code: string,
  message: string,
  retryable = false,
): Extract<ComputerUseResponse, { type: "error" }> => ({
  ...responseEnvelope(request),
  type: "error",
  error: { code, message, retryable },
});

const windowIdNumber = (
  target: Extract<ComputerUseTarget, { type: "window" }>,
) => {
  const parsed = Number(target.windowId.trim().replace(/^hwnd:/i, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid Windows window ID: ${target.windowId}`);
  }
  return Math.trunc(parsed);
};

const targetDetails = (target: ComputerUseTarget) => {
  if (target.type === "app") {
    return { app: target.app, snapshotAlias: target.app };
  }
  const windowId = windowIdNumber(target);
  return {
    app: target.app ?? `hwnd:${windowId}`,
    windowId,
    snapshotAlias: `hwnd:${windowId}`,
  };
};

const requireSnapshot = (sessionId: string, target: ComputerUseTarget) => {
  const details = targetDetails(target);
  const snapshot = readWindowsComputerSnapshot(
    sessionId,
    details.snapshotAlias,
  );
  if (!snapshot) {
    throw new Error(
      `No app state is available for ${details.snapshotAlias}. Call get_app_state before sending actions.`,
    );
  }
  return { details, snapshot };
};

const actionOperation = (
  sessionId: string,
  command: ComputerUseActionCommand,
): WinHelperRequest => {
  const { details, snapshot } = requireSnapshot(sessionId, command.target);
  const shared = {
    app: details.app,
    windowId: details.windowId ?? snapshot.windowId,
    windowBounds: snapshot.windowBounds ?? null,
    dispatch: "background" as const,
    defer_observation: true,
    screenshot_policy: "auto" as const,
  };
  const action = command.action;
  switch (action.type) {
    case "click_element":
      return {
        ...shared,
        tool: "click",
        element: lookupWindowsComputerElement(snapshot, action.elementId),
        mouse_button: action.mouseButton,
        click_count: action.clickCount,
      };
    case "click_point":
      return {
        ...shared,
        tool: "click",
        x: action.point.x,
        y: action.point.y,
        mouse_button: action.mouseButton,
        click_count: action.clickCount,
        screenshot_width: snapshot.screenshot?.widthPx ?? undefined,
        screenshot_height: snapshot.screenshot?.heightPx ?? undefined,
      };
    case "drag":
      return {
        ...shared,
        tool: "drag",
        from_x: action.from.x,
        from_y: action.from.y,
        to_x: action.to.x,
        to_y: action.to.y,
        screenshot_width: snapshot.screenshot?.widthPx ?? undefined,
        screenshot_height: snapshot.screenshot?.heightPx ?? undefined,
      };
    case "perform_secondary_action":
      return {
        ...shared,
        tool: "perform_secondary_action",
        element: lookupWindowsComputerElement(snapshot, action.elementId),
        action: action.action,
      };
    case "press_key":
      return { ...shared, tool: "press_key", key: action.key };
    case "scroll":
      return {
        ...shared,
        tool: "scroll",
        element: lookupWindowsComputerElement(snapshot, action.elementId),
        direction: action.direction,
        pages: action.pages,
      };
    case "select_text":
      return {
        ...shared,
        tool: "select_text",
        element: lookupWindowsComputerElement(snapshot, action.elementId),
        text: action.text,
        prefix: action.prefix,
        suffix: action.suffix,
        selection: action.selectionType,
      };
    case "set_value":
      return {
        ...shared,
        tool: "set_value",
        element: lookupWindowsComputerElement(snapshot, action.elementId),
        value: action.value,
      };
    case "type_text":
      return { ...shared, tool: "type_text", text: action.text };
  }
};

const jsonObject = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const actionReceipt = (
  command: ComputerUseActionCommand,
  response: WinHelperResponse,
): ComputerUseActionReceipt => {
  const deferred = response.deferred ?? true;
  return {
    type: "action",
    action: command.action.type,
    target: command.target,
    status: deferred ? "accepted" : "completed",
    deferred,
    details: jsonObject({
      receipt: response.receipt ?? null,
      revision: response.revision ?? null,
      deferred,
    }),
  };
};

const snapshotState = (
  sessionId: string,
  requestedTarget: ComputerUseTarget,
  snapshot: WinSnapshot,
) => {
  const canonicalApp =
    snapshot.app.bundleIdentifier?.trim() || snapshot.app.name.trim();
  const alias = targetDetails(requestedTarget).snapshotAlias;
  const screenshot = snapshot.screenshotPngBase64
    ? {
        type: "image" as const,
        url: pathToFileURL(windowsComputerScreenshotPath(sessionId, alias))
          .href,
        mimeType: "image/png",
        ...(snapshot.screenshot?.widthPx
          ? { width: Math.round(snapshot.screenshot.widthPx) }
          : {}),
        ...(snapshot.screenshot?.heightPx
          ? { height: Math.round(snapshot.screenshot.heightPx) }
          : {}),
      }
    : null;
  return {
    app: canonicalApp,
    text: windowsComputerSnapshotLines(snapshot).join("\n"),
    screenshot,
    ...(snapshot.appInstructions?.trim()
      ? { instructions: snapshot.appInstructions.trim() }
      : {}),
  };
};

const helperFailure = (response: WinHelperResponse, fallback: string) =>
  response.error?.trim() || fallback;

export const createWindowsComputerUseSession = (
  options: WindowsComputerUseSessionOptions = {},
): ComputerUseSession => {
  const requestHelper =
    options.requestHelper ??
    ((sessionId, operation, signal) =>
      requestWindowsComputerHelper(
        sessionId,
        operation as WinHelperRequest,
        signal,
      ));

  const request: ComputerUseSession["request"] = async (
    typedRequest,
    requestOptions,
  ) => {
    assertComputerUseRequest(typedRequest);
    const signal = requestOptions?.signal;
    return await withWindowsComputerSessionLock(
      typedRequest.sessionId,
      async () => {
        try {
          if (typedRequest.type === "list_apps") {
            const response = await requestHelper(
              typedRequest.sessionId,
              { tool: "list_apps" },
              signal,
            );
            return response.ok
              ? {
                  ...responseEnvelope(typedRequest),
                  type: "list_apps" as const,
                  text:
                    response.text?.trim() ||
                    "No running top-level apps are visible to this Windows runtime.",
                }
              : errorResponse(
                  typedRequest,
                  "windows_helper_failed",
                  helperFailure(
                    response,
                    "Windows runtime failed to list apps.",
                  ),
                );
          }

          if (typedRequest.type === "list_windows") {
            const response = await requestHelper(
              typedRequest.sessionId,
              { tool: "list_windows" },
              signal,
            );
            return response.ok
              ? {
                  ...responseEnvelope(typedRequest),
                  type: "list_windows" as const,
                  text:
                    response.text?.trim() ||
                    formatWindowsWindowList(response.windows),
                }
              : errorResponse(
                  typedRequest,
                  "windows_helper_failed",
                  helperFailure(
                    response,
                    "Windows runtime failed to list windows.",
                  ),
                );
          }

          if (typedRequest.type === "resolve_target") {
            const target = targetDetails(typedRequest.selector);
            const response = await requestHelper(
              typedRequest.sessionId,
              {
                tool: "get_app_state",
                app: target.app,
                windowId: target.windowId,
                screenshot_policy: "never",
              },
              signal,
            );
            if (!response.ok || !response.snapshot) {
              return errorResponse(
                typedRequest,
                "windows_target_resolution_failed",
                helperFailure(
                  response,
                  `Windows runtime could not resolve ${target.snapshotAlias}.`,
                ),
              );
            }
            rememberWindowsComputerSnapshot(
              typedRequest.sessionId,
              target.snapshotAlias,
              response.snapshot,
            );
            const bundleIdentifier =
              response.snapshot.app.bundleIdentifier?.trim() ||
              response.snapshot.app.name.trim();
            return {
              ...responseEnvelope(typedRequest),
              type: "target_policy" as const,
              policy: {
                bundleIdentifier,
                displayName: response.snapshot.app.name.trim(),
                decision: "allowed" as const,
                allowPersistentApproval: true,
              },
            };
          }

          if (typedRequest.type === "get_app_state") {
            const target = targetDetails(typedRequest.target);
            const response = await requestHelper(
              typedRequest.sessionId,
              {
                tool: "get_app_state",
                app: target.app,
                windowId: target.windowId,
                screenshot_policy: typedRequest.screenshotPolicy,
              },
              signal,
            );
            if (!response.ok || !response.snapshot) {
              return errorResponse(
                typedRequest,
                "windows_state_failed",
                helperFailure(
                  response,
                  "Windows runtime did not return app state.",
                ),
              );
            }
            rememberWindowsComputerSnapshot(
              typedRequest.sessionId,
              target.snapshotAlias,
              response.snapshot,
            );
            return {
              ...responseEnvelope(typedRequest),
              type: "app_state" as const,
              state: snapshotState(
                typedRequest.sessionId,
                typedRequest.target,
                response.snapshot,
              ),
            };
          }

          const executeAction = async (command: ComputerUseActionCommand) => {
            const response = await requestHelper(
              typedRequest.sessionId,
              actionOperation(typedRequest.sessionId, command),
              signal,
            );
            if (!response.ok) {
              throw new Error(
                helperFailure(
                  response,
                  `Windows runtime failed to execute ${command.action.type}.`,
                ),
              );
            }
            return actionReceipt(command, response);
          };

          if (typedRequest.type === "action") {
            return {
              ...responseEnvelope(typedRequest),
              type: "action" as const,
              receipt: await executeAction(typedRequest.command),
            };
          }

          const operations = typedRequest.commands.map((command) =>
            actionOperation(typedRequest.sessionId, command),
          );
          const response = (await requestHelper(
            typedRequest.sessionId,
            { tool: "batch", commands: operations },
            signal,
          )) as WindowsComputerHelperBatchResponse;
          const results = response.results;
          if (!Array.isArray(results)) {
            throw new Error(
              helperFailure(
                response,
                "Windows runtime returned an invalid batch response.",
              ),
            );
          }
          const receipts = typedRequest.commands.map((command, index) => {
            const item = results[index];
            if (!item || item.index !== index) {
              throw new Error(`Windows runtime omitted batch result ${index}.`);
            }
            if (!item.ok || !item.result?.ok) {
              throw new Error(
                item.error?.trim() ||
                  item.result?.error?.trim() ||
                  `Windows runtime failed batch command ${index}.`,
              );
            }
            return actionReceipt(command, item.result);
          });
          if (
            !response.ok ||
            response.completed !== typedRequest.commands.length ||
            results.length !== typedRequest.commands.length
          ) {
            throw new Error(
              helperFailure(
                response,
                `Windows runtime completed ${response.completed ?? results.length} of ${typedRequest.commands.length} batch commands.`,
              ),
            );
          }
          return {
            ...responseEnvelope(typedRequest),
            type: "batch" as const,
            receipt: { type: "batch" as const, receipts },
          };
        } catch (error) {
          const aborted =
            signal?.aborted ||
            (error instanceof Error && error.name === "AbortError");
          return errorResponse(
            typedRequest,
            aborted ? "request_aborted" : "windows_session_failed",
            error instanceof Error ? error.message : String(error),
            false,
          );
        }
      },
      signal,
    );
  };

  return Object.freeze({ request });
};
