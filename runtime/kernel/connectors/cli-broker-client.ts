/**
 * Client for the worker's CLI bridge UDS. The CLI dials it when an
 * MCP/REST call fails with auth, the worker pops a credential dialog
 * via the host, the user submits, the host writes the token directly
 * to `~/.stella/connectors/.credentials.json`, and we get `{ ok: true }`
 * back so the CLI can retry the original operation.
 *
 * Wire protocol mirrors `runtime/worker/cli-bridge-server.ts`: one
 * connection = one line of JSON request, one line of JSON response,
 * server closes. Keeps the CLI's dependency surface small (no shared
 * RPC client framework needed) and avoids holding a long-lived socket
 * open across the auth dialog.
 */

import { connect, type Socket } from "node:net";
import type { ConnectorTokenPayload } from "./oauth.js";

export type ConnectorCredentialResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string };

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

export type ConnectorTokenStoreRequest =
  | { operation: "load"; tokenKey: string }
  | { operation: "save"; tokenKey: string; payload: ConnectorTokenPayload }
  | { operation: "delete"; tokenKeys: string[] };

export type ConnectorTokenStoreResult =
  | { ok: true; payload?: ConnectorTokenPayload | null }
  | { ok: false; reason: string };

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

export const requestConnectorCredentialFromBridge = async ({
  socketPath,
  tokenKey,
  displayName,
  authType,
  resourceUrl,
  oauthClientId,
  oauthResource,
  scopes,
  preregisteredOAuth,
  description,
  placeholder,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  socketPath: string;
  tokenKey: string;
  displayName: string;
  /** `"oauth"` switches the host to the browser-based flow and requires `resourceUrl`. */
  authType?: "api_key" | "oauth";
  /** MCP server URL used for protected-resource metadata discovery when `authType==="oauth"`. */
  resourceUrl?: string;
  oauthClientId?: string;
  oauthResource?: string;
  scopes?: string[];
  preregisteredOAuth?: {
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint?: string;
    responseType?: "code" | "token";
    resourceUrl?: string;
    oauthResource?: string | null;
    callbackUrl?: string;
    callbackId?: string;
    callbackMode?: "local" | "external";
    scopeSeparator?: string;
    usesPkce?: boolean;
    authorizationRedirectParam?: string;
    authorizationParams?: Record<string, string>;
    tokenRedirectParam?: string;
    tokenAuth?: "body" | "basic";
    tokenExchange?: {
      type: "backend";
      provider: string;
    };
  };
  description?: string;
  placeholder?: string;
  timeoutMs?: number;
}): Promise<ConnectorCredentialResult> => {
  const result = await sendRequest(
    socketPath,
    "connector.requestCredential",
    {
      tokenKey,
      displayName,
      authType,
      resourceUrl,
      oauthClientId,
      oauthResource,
      scopes,
      preregisteredOAuth,
      description,
      placeholder,
    },
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === true) return { ok: true };
  return {
    ok: false,
    reason:
      typeof record.reason === "string" && record.reason
        ? record.reason
        : "unknown",
  };
};

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

export const requestConnectorTokenStoreFromBridge = async ({
  socketPath,
  request,
  timeoutMs = 15_000,
}: {
  socketPath: string;
  request: ConnectorTokenStoreRequest;
  timeoutMs?: number;
}): Promise<ConnectorTokenStoreResult> => {
  const result = await sendRequest(
    socketPath,
    "connector.tokenStore",
    request,
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === true) {
    return {
      ok: true,
      ...(request.operation === "load"
        ? {
            payload:
              record.payload && typeof record.payload === "object"
                ? (record.payload as ConnectorTokenPayload)
                : null,
          }
        : {}),
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
