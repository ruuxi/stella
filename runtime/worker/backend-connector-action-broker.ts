import crypto from "node:crypto";
import AjvModule from "ajv";

import {
  resolveNativeConnectorCatalog,
  type ResolvedNativeCatalog,
} from "../kernel/connectors/catalog-cache.js";
import {
  getNativeConnectorCatalogEntry,
  getNativeConnectorTools,
  isNativeConnectorEnabled,
} from "../kernel/connectors/native-integrations.js";
import type {
  BackendConnectorActionResult,
  BackendConnectorActionsResult,
} from "../kernel/connectors/cli-broker-client.js";
import {
  redactSensitiveText,
  sanitizeSensitiveData,
} from "../contracts/sensitive-data.js";

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
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 30_000;
const SAFE_ACTION = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
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

const jwtStatus = (
  token: string,
  now = Date.now(),
): "opaque" | "valid" | "expired" | "malformed" => {
  const parts = token.split(".");
  if (parts.length !== 3) return "opaque";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return "malformed";
    }
    return payload.exp * 1000 <= now + 30_000 ? "expired" : "valid";
  } catch {
    return "malformed";
  }
};

const Ajv =
  (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

const validateActionInput = (
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): string | null => {
  if (!schema || !isPlainJsonValue(schema))
    return "Action schema is unavailable.";
  try {
    const validate = ajv.compile(schema);
    if (validate(input)) return null;
    return `Action input failed schema validation: ${(validate.errors ?? [])
      .slice(0, 8)
      .map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      )
      .join("; ")}`;
  } catch {
    return "Action schema is invalid.";
  }
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("response_too_large");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(bytes));
};

const requestIdFromResponse = (response: Response, fallback: string) => {
  const candidate =
    response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : fallback;
};

const readCanonicalAction = (
  payload: unknown,
  expectedName: string,
): { name: string; inputSchema: Record<string, unknown> } | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const actions = (payload as { actions?: unknown }).actions;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const action = actions[0];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return null;
  }
  const record = action as Record<string, unknown>;
  if (record.name !== expectedName || !isPlainJsonValue(record.inputSchema)) {
    return null;
  }
  const inputSchema = record.inputSchema;
  return inputSchema &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema)
    ? {
        name: expectedName,
        inputSchema: inputSchema as Record<string, unknown>,
      }
    : null;
};

const readCanonicalActionPage = (
  payload: unknown,
  expectedId: string,
): Extract<BackendConnectorActionsResult, { ok: true }> | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    record.id !== expectedId ||
    typeof record.actionCount !== "number" ||
    !Number.isSafeInteger(record.actionCount) ||
    record.actionCount < 0 ||
    !Array.isArray(record.actions)
  ) {
    return null;
  }
  const actions = record.actions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const action = value as Record<string, unknown>;
    if (
      typeof action.name !== "string" ||
      !SAFE_ACTION.test(action.name) ||
      !action.inputSchema ||
      typeof action.inputSchema !== "object" ||
      Array.isArray(action.inputSchema) ||
      !isPlainJsonValue(action.inputSchema)
    ) {
      return [];
    }
    return [
      {
        name: action.name,
        ...(typeof action.title === "string" ? { title: action.title } : {}),
        ...(typeof action.description === "string"
          ? { description: action.description }
          : {}),
        inputSchema: action.inputSchema as Record<string, unknown>,
      },
    ];
  });
  if (actions.length !== record.actions.length) return null;
  return {
    ok: true,
    id: expectedId,
    actionCount: record.actionCount,
    actions,
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : null,
  };
};

export const createBackendConnectorActionsBroker =
  (options: BackendConnectorActionBrokerOptions) =>
  async (params: {
    connectorId: string;
    query?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<BackendConnectorActionsResult> => {
    const connectorId = params.connectorId.trim().toLowerCase();
    const query = params.query?.trim();
    const cursor = params.cursor?.trim();
    const limit = params.limit ?? 25;
    if (
      !SAFE_CONNECTOR_ID.test(connectorId) ||
      (query !== undefined && (query.length === 0 || query.length > 200)) ||
      (cursor !== undefined &&
        (cursor.length === 0 || cursor.length > 2_048)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 25
    ) {
      return {
        ok: false,
        reason: "connector_unavailable",
        message: "The connector action-list request is not valid.",
      };
    }

    let auth = options.getSiteAuth();
    const initialStatus = auth ? jwtStatus(auth.authToken) : "expired";
    if (!auth || initialStatus === "expired" || initialStatus === "malformed") {
      auth = await options.refreshSiteAuth();
    }
    if (!auth?.baseUrl.trim() || !auth.authToken.trim()) {
      return {
        ok: false,
        reason: "not_signed_in",
        message: "Sign in to Stella before using this integration.",
      };
    }
    const refreshedStatus = jwtStatus(auth.authToken);
    if (refreshedStatus === "expired" || refreshedStatus === "malformed") {
      return {
        ok: false,
        reason: "auth_expired",
        message: "Stella sign-in refresh did not return a usable session.",
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
    if (!entry || !enabled) {
      return {
        ok: false,
        reason: "connector_unavailable",
        message: "This connector is not enabled for backend execution.",
      };
    }

    const url = new URL(
      `${auth.baseUrl.replace(/\/+$/u, "")}/api/native-integrations/actions`,
    );
    url.searchParams.set("id", connectorId);
    url.searchParams.set("limit", String(limit));
    if (query) url.searchParams.set("query", query);
    if (cursor) url.searchParams.set("cursor", cursor);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("timeout"),
      ACTION_TIMEOUT_MS,
    );
    const abort = () => controller.abort(params.signal?.reason ?? "cancelled");
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${auth.authToken}`,
        },
        signal: controller.signal,
      });
      if (response.status === 401) {
        return {
          ok: false,
          reason: "auth_expired",
          status: 401,
          message:
            "Stella sign-in expired. Sign in again before using this integration.",
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason:
            response.status === 404 ? "connector_unavailable" : "backend_error",
          status: response.status,
          message: `The connector action catalog failed (${response.status}).`,
        };
      }
      const page = readCanonicalActionPage(
        await readBoundedJson(response),
        connectorId,
      );
      return (
        page ?? {
          ok: false,
          reason: "backend_error",
          message: "The backend returned an invalid connector action page.",
        }
      );
    } catch (error) {
      return {
        ok: false,
        reason: "backend_error",
        message: controller.signal.aborted
          ? "The connector action-list request was cancelled or timed out."
          : redactSensitiveText(
              error instanceof Error
                ? error.message
                : "The connector action catalog could not be reached.",
            ),
      };
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
    }
  };

export const createBackendConnectorActionBroker =
  (options: BackendConnectorActionBrokerOptions) =>
  async (params: {
    connectorId: string;
    action: string;
    input: Record<string, unknown>;
    requestId?: string;
    signal?: AbortSignal;
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
    const initialStatus = auth ? jwtStatus(auth.authToken) : "expired";
    if (!auth || initialStatus === "expired" || initialStatus === "malformed") {
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
    const refreshedStatus = jwtStatus(auth.authToken);
    if (refreshedStatus === "expired" || refreshedStatus === "malformed") {
      return {
        ok: false,
        reason: "auth_expired",
        message: "Stella sign-in refresh did not return a usable session.",
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
    if (
      !entry ||
      entry.provider !== "backend-composio" ||
      entry.connectable !== true ||
      getNativeConnectorTools(entry).length === 0 ||
      !enabled
    ) {
      return {
        ok: false,
        reason: "connector_unavailable",
        message: "This connector is not available for backend execution.",
        requestId,
      };
    }
    if (!action.startsWith(`${entry.backendConnector.toolkit}_`)) {
      return {
        ok: false,
        reason: "action_not_allowed",
        message: "That action does not belong to the resolved connector.",
        requestId,
      };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const actionLookupUrl = new URL(
      `${auth.baseUrl.replace(/\/+$/u, "")}/api/native-integrations/actions`,
    );
    actionLookupUrl.searchParams.set("id", connectorId);
    actionLookupUrl.searchParams.set("action", action);
    let actionResponse: Response;
    const lookupController = new AbortController();
    const lookupTimeout = setTimeout(
      () => lookupController.abort("timeout"),
      ACTION_TIMEOUT_MS,
    );
    const abortLookup = () =>
      lookupController.abort(params.signal?.reason ?? "cancelled");
    params.signal?.addEventListener("abort", abortLookup, { once: true });
    try {
      actionResponse = await fetchImpl(actionLookupUrl, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${auth.authToken}`,
          "x-stella-request-id": requestId,
        },
        signal: lookupController.signal,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "backend_error",
        message: lookupController.signal.aborted
          ? "The connector action catalog request was cancelled or timed out."
          : redactSensitiveText(
              error instanceof Error
                ? error.message
                : "The connector action catalog could not be reached.",
            ),
        requestId,
      };
    } finally {
      clearTimeout(lookupTimeout);
      params.signal?.removeEventListener("abort", abortLookup);
    }
    if (!actionResponse) {
      return {
        ok: false,
        reason: "backend_error",
        message: "The connector action catalog returned no response.",
        requestId,
      };
    }
    if (actionResponse.status === 401) {
      return {
        ok: false,
        reason: "auth_expired",
        status: 401,
        message:
          "Stella sign-in expired. Sign in again before using this integration.",
        requestId: requestIdFromResponse(actionResponse, requestId),
      };
    }
    if (!actionResponse.ok) {
      return {
        ok: false,
        reason:
          actionResponse.status === 404
            ? "action_not_allowed"
            : "backend_error",
        status: actionResponse.status,
        message:
          actionResponse.status === 404
            ? "That action does not belong to the resolved connector."
            : `The connector action catalog failed (${actionResponse.status}).`,
        requestId: requestIdFromResponse(actionResponse, requestId),
      };
    }
    let canonicalAction: ReturnType<typeof readCanonicalAction>;
    try {
      canonicalAction = readCanonicalAction(
        await readBoundedJson(actionResponse),
        action,
      );
    } catch {
      canonicalAction = null;
    }
    if (!canonicalAction) {
      return {
        ok: false,
        reason: "action_not_allowed",
        message: "The backend did not return a valid canonical action schema.",
        requestId,
      };
    }
    const schemaError = validateActionInput(
      canonicalAction.inputSchema,
      params.input,
    );
    if (schemaError) {
      return {
        ok: false,
        reason: "action_not_allowed",
        message: redactSensitiveText(schemaError),
        requestId,
      };
    }

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("timeout"),
      ACTION_TIMEOUT_MS,
    );
    const abort = () => controller.abort(params.signal?.reason ?? "cancelled");
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      response = await fetchImpl(
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
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
      return {
        ok: false,
        reason: "backend_error",
        message: controller.signal.aborted
          ? "The connector action was cancelled or timed out."
          : redactSensitiveText(
              error instanceof Error
                ? error.message
                : "The connector service could not be reached.",
            ),
        requestId,
      };
    }

    const responseRequestId = requestIdFromResponse(response, requestId);
    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      return {
        ok: false,
        reason: "backend_error",
        status: response.status,
        message:
          (error as Error).message === "response_too_large"
            ? "Connector response exceeded the safe size limit."
            : "Connector response was not valid JSON.",
        requestId: responseRequestId,
      };
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
    }
    if (!response.ok) {
      const backendMessage =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : null;
      return {
        ok: false,
        reason: response.status === 401 ? "auth_expired" : "backend_error",
        status: response.status,
        message: redactSensitiveText(
          typeof backendMessage === "string" && backendMessage.trim()
            ? backendMessage.slice(0, 1_000)
            : response.status === 401
              ? "Stella sign-in expired. Sign in again before using this integration."
              : `Integration action failed (${response.status}).`,
        ),
        requestId: responseRequestId,
      };
    }
    return { ok: true, result: sanitizeSensitiveData(payload) };
  };

export const __test = {
  isPlainJsonValue,
  jwtStatus,
  validateActionInput,
  readBoundedJson,
  readCanonicalAction,
  readCanonicalActionPage,
};
