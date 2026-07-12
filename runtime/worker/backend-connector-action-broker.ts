import crypto from "node:crypto";

import {
  resolveNativeConnectorCatalog,
  type ResolvedNativeCatalog,
} from "../kernel/connectors/catalog-cache.js";
import {
  getNativeConnectorCatalogEntry,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
} from "../kernel/connectors/native-integrations.js";
import type { BackendConnectorActionResult } from "../kernel/connectors/cli-broker-client.js";

type SiteAuth = { baseUrl: string; authToken: string };

export type BackendConnectorActionBrokerOptions = {
  stellaDataDir: string;
  getSiteAuth: () => SiteAuth | null;
  refreshSiteAuth: () => Promise<SiteAuth | null>;
  fetchImpl?: typeof fetch;
  resolveCatalog?: (auth: SiteAuth) => Promise<ResolvedNativeCatalog>;
  isEnabled?: (id: string) => Promise<boolean>;
};

const MAX_INPUT_DEPTH = 20;
const SAFE_ACTION = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

const isPlainJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > MAX_INPUT_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isPlainJsonValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) =>
      key !== "__proto__" &&
      key !== "constructor" &&
      key !== "prototype" &&
      isPlainJsonValue(item, depth + 1),
  );
};

const jwtExpiresSoon = (token: string, now = Date.now()): boolean => {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return (
      typeof payload.exp === "number" && payload.exp * 1000 <= now + 30_000
    );
  } catch {
    return false;
  }
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED]",
    )
    .replace(
      /\b(?:auth|access|refresh)[_-]?token\s*[:=]\s*[^\s,;]+/giu,
      "token=[REDACTED]",
    )
    .slice(0, 1_000);
};

const SENSITIVE_RESULT_KEY =
  /^(?:authorization|cookie|set-cookie|authToken|accessToken|refreshToken|idToken|auth_token|access_token|refresh_token|id_token)$/iu;

const sanitizeResult = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_INPUT_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeText(value, "");
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResult(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_RESULT_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeResult(item, depth + 1),
    ]),
  );
};

const requestIdFromResponse = (response: Response, fallback: string) => {
  const candidate =
    response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : fallback;
};

export const createBackendConnectorActionBroker =
  (options: BackendConnectorActionBrokerOptions) =>
  async (params: {
    connectorId: string;
    action: string;
    input: Record<string, unknown>;
    requestId?: string;
  }): Promise<BackendConnectorActionResult> => {
    const connectorId = params.connectorId.trim().toLowerCase();
    const action = params.action.trim();
    const requestId =
      params.requestId && SAFE_REQUEST_ID.test(params.requestId)
        ? params.requestId
        : crypto.randomUUID();
    if (
      !connectorId ||
      !SAFE_ACTION.test(action) ||
      !isPlainJsonValue(params.input)
    ) {
      return {
        ok: false,
        reason: "action_not_allowed",
        message: "The connector action request is not valid.",
        requestId,
      };
    }

    let auth = options.getSiteAuth();
    if (!auth || jwtExpiresSoon(auth.authToken)) {
      auth = await options.refreshSiteAuth();
    }
    if (!auth?.baseUrl.trim() || !auth.authToken.trim()) {
      return {
        ok: false,
        reason: "not_signed_in",
        message: "Sign in to Stella before using this integration.",
        requestId,
      };
    }

    const catalog = options.resolveCatalog
      ? await options.resolveCatalog(auth)
      : await resolveNativeConnectorCatalog({
          stellaDataDir: options.stellaDataDir,
          getStellaSiteAuth: () => auth,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
    const entry = getNativeConnectorCatalogEntry(connectorId, catalog.entries);
    const enabled = options.isEnabled
      ? await options.isEnabled(connectorId)
      : await isNativeConnectorEnabled(options.stellaDataDir, connectorId);
    const toolkit = entry?.backendConnector?.toolkit.trim().toUpperCase();
    if (
      !entry ||
      entry.provider !== "backend-composio" ||
      entry.connectable !== true ||
      getNativeConnectorTools(entry).length === 0 ||
      !enabled ||
      !toolkit
    ) {
      return {
        ok: false,
        reason: "connector_unavailable",
        message: "This connector is not available for backend execution.",
        requestId,
      };
    }
    if (!action.startsWith(`${toolkit}_`)) {
      return {
        ok: false,
        reason: "action_not_allowed",
        message: "That action does not belong to the resolved connector.",
        requestId,
      };
    }

    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(
        `${auth.baseUrl.replace(/\/+$/u, "")}/api/native-integrations/run`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${auth.authToken}`,
            "x-stella-request-id": requestId,
          },
          body: JSON.stringify({
            id: connectorId,
            action,
            input: params.input,
          }),
        },
      );
    } catch {
      return {
        ok: false,
        reason: "backend_error",
        message: "The connector service could not be reached.",
        requestId,
      };
    }

    const responseRequestId = requestIdFromResponse(response, requestId);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const backendMessage =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : null;
      return {
        ok: false,
        reason: response.status === 401 ? "auth_expired" : "backend_error",
        status: response.status,
        message: sanitizeText(
          backendMessage,
          response.status === 401
            ? "Stella sign-in expired. Sign in again before using this integration."
            : `Integration action failed (${response.status}).`,
        ),
        requestId: responseRequestId,
      };
    }
    return { ok: true, result: sanitizeResult(payload) };
  };

export const __test = {
  isPlainJsonValue,
  jwtExpiresSoon,
  sanitizeText,
  sanitizeResult,
};
