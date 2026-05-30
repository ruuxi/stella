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

export type ConnectorCredentialResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string };

export type StellaSiteAuthResult =
  | { ok: true; baseUrl: string; authToken: string }
  | { ok: false; reason: string };

export type DesktopPermissionRequestResult =
  | { ok: true; granted: boolean; alreadyGranted: boolean }
  | { ok: false; reason: string };

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

export const requestStellaSiteAuthFromBridge = async ({
  socketPath,
  timeoutMs = 5_000,
}: {
  socketPath: string;
  timeoutMs?: number;
}): Promise<StellaSiteAuthResult> => {
  const result = await sendRequest(
    socketPath,
    "stella.getSiteAuth",
    {},
    timeoutMs,
  );
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "invalid_response" };
  }
  const record = result as Record<string, unknown>;
  if (
    record.ok === true &&
    typeof record.baseUrl === "string" &&
    typeof record.authToken === "string"
  ) {
    return {
      ok: true,
      baseUrl: record.baseUrl,
      authToken: record.authToken,
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
