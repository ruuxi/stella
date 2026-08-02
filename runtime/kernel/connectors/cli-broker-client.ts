/**
 * Client for the worker's private CLI bridge. Connector actions and inline
 * Store connection requests cross this narrow local socket; credentials and
 * arbitrary transports do not.
 *
 * Wire protocol mirrors `runtime/worker/cli-bridge-server.ts`: one
 * connection = one line of JSON request, one line of JSON response,
 * server closes. Keeps the CLI's dependency surface small (no shared
 * RPC client framework needed) and avoids holding a long-lived socket
 * open across the auth dialog.
 */

import { connect, type Socket } from "node:net";

export type BackendConnectorActionResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      reason:
        | "not_signed_in"
        | "auth_expired"
        | "connector_unavailable"
        | "action_not_allowed"
        | "backend_error"
        | "bridge_unavailable"
        | string;
      status?: number;
      message?: string;
      requestId?: string;
    };

export type BackendConnectorActionsResult =
  | {
      ok: true;
      id: string;
      actionCount: number;
      actions: Array<{
        name: string;
        title?: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>;
      nextCursor: string | null;
    }
  | {
      ok: false;
      reason:
        | "not_signed_in"
        | "auth_expired"
        | "connector_unavailable"
        | "backend_error"
        | "bridge_unavailable"
        | string;
      status?: number;
      message?: string;
    };

export type DesktopPermissionRequestResult =
  | { ok: true; granted: boolean; alreadyGranted: boolean }
  | { ok: false; reason: string };

export type ConnectorConnectionResult =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
let nextRequestId = 1;

const sendRequest = (
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = nextRequestId++;
    let buffer = "";
    let settled = false;

    const socket: Socket = connect(socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`cli-bridge: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex);
      try {
        const message = JSON.parse(line) as
          | { id: string | number; result: unknown }
          | { id: string | number; error: { message: string } };
        if ("error" in message) {
          fail(
            new Error(message.error?.message ?? "cli-bridge: handler error"),
          );
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(message.result);
      } catch (error) {
        fail(
          new Error(
            `cli-bridge: invalid response (${(error as Error).message})`,
          ),
        );
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      if (settled) return;
      // Closed before any response arrived.
      fail(new Error("cli-bridge: connection closed without a response"));
    });
  });

/**
 * Ask the desktop to offer connecting a native Store integration via an
 * inline connect card in the active chat. Blocks until the user accepts
 * (and the OAuth/enable flow finishes), declines, or the request times
 * out — the calling agent stays mid-turn the whole time, so on
 * `{ ok: true }` it can continue the original task immediately.
 */
export const requestConnectorConnectionFromBridge = async ({
  socketPath,
  id,
  name,
  description,
  iconUrl,
  category,
  reason,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  socketPath: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  /** One-line agent-provided context shown on the card ("To check your recent purchases"). */
  reason?: string;
  timeoutMs?: number;
}): Promise<ConnectorConnectionResult> => {
  const result = await sendRequest(
    socketPath,
    "connector.requestConnection",
    { id, name, description, iconUrl, category, reason },
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === true) {
    return {
      ok: true,
      status:
        record.status === "already_connected"
          ? "already_connected"
          : "connected",
    };
  }
  return {
    ok: false,
    reason:
      typeof record.reason === "string" && record.reason
        ? record.reason
        : "unknown",
  };
};

export const requestBackendConnectorActionFromBridge = async ({
  socketPath,
  connectorId,
  action,
  input,
  requestId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  socketPath: string;
  connectorId: string;
  action: string;
  input: Record<string, unknown>;
  requestId?: string;
  timeoutMs?: number;
}): Promise<BackendConnectorActionResult> => {
  const result = await sendRequest(
    socketPath,
    "connector.runBackendAction",
    { connectorId, action, input, requestId },
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === true) return { ok: true, result: record.result };
  return {
    ok: false,
    reason:
      typeof record.reason === "string" && record.reason
        ? record.reason
        : "bridge_unavailable",
    ...(typeof record.status === "number" ? { status: record.status } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.requestId === "string"
      ? { requestId: record.requestId }
      : {}),
  };
};

export const requestBackendConnectorActionsFromBridge = async ({
  socketPath,
  connectorId,
  query,
  cursor,
  limit = 25,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  socketPath: string;
  connectorId: string;
  query?: string;
  cursor?: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<BackendConnectorActionsResult> => {
  const result = await sendRequest(
    socketPath,
    "connector.listBackendActions",
    { connectorId, query, cursor, limit },
    timeoutMs,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (record.ok !== true) {
    return {
      ok: false,
      reason:
        typeof record.reason === "string" && record.reason
          ? record.reason
          : "bridge_unavailable",
      ...(typeof record.status === "number" ? { status: record.status } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    };
  }
  const rawActions = Array.isArray(record.actions) ? record.actions : null;
  const actions = rawActions
    ? rawActions.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const action = value as Record<string, unknown>;
        if (
          typeof action.name !== "string" ||
          !action.inputSchema ||
          typeof action.inputSchema !== "object" ||
          Array.isArray(action.inputSchema)
        ) {
          return [];
        }
        return [
          {
            name: action.name,
            ...(typeof action.title === "string"
              ? { title: action.title }
              : {}),
            ...(typeof action.description === "string"
              ? { description: action.description }
              : {}),
            inputSchema: action.inputSchema as Record<string, unknown>,
          },
        ];
      })
    : [];
  if (
    typeof record.id !== "string" ||
    typeof record.actionCount !== "number" ||
    !rawActions ||
    actions.length !== rawActions.length
  ) {
    return { ok: false, reason: "invalid_response" };
  }
  return {
    ok: true,
    id: record.id,
    actionCount: record.actionCount,
    actions,
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
  };
};

export const requestDesktopPermissionFromBridge = async ({
  socketPath,
  kind,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  socketPath: string;
  kind: "accessibility" | "screen";
  timeoutMs?: number;
}): Promise<DesktopPermissionRequestResult> => {
  const result = await sendRequest(
    socketPath,
    "system.requestPermission",
    { kind },
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (
    record.ok === true &&
    typeof record.granted === "boolean" &&
    typeof record.alreadyGranted === "boolean"
  ) {
    return {
      ok: true,
      granted: record.granted,
      alreadyGranted: record.alreadyGranted,
    };
  }
  return {
    ok: false,
    reason:
      typeof record.reason === "string" && record.reason
        ? record.reason
        : "unavailable",
  };
};
