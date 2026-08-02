import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import {
  resolveNativeConnectorCatalog,
  type ResolvedNativeCatalog,
} from "../../../runtime/kernel/connectors/catalog-cache.js";
import {
  probeBackendIntegrationConnection,
  waitForBackendIntegrationConnection,
} from "../../../runtime/kernel/connectors/backend-integration-status.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

export type NativeIntegrationHandlersOptions = {
  getStellaAppDir: () => string | null;
  requestExternalOAuthApproval?: (payload: {
    displayName: string;
    resourceUrl: string;
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  getConvexAuthToken?: () => Promise<string | null>;
  getConvexSiteUrl?: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export type NativeCredentialFlowOptions = Pick<
  NativeIntegrationHandlersOptions,
  "requestExternalOAuthApproval" | "getConvexAuthToken" | "getConvexSiteUrl"
> & {
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

const readId = (payload: unknown) => {
  const id =
    payload && typeof payload === "object"
      ? (payload as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Missing integration id.");
  }
  return id.trim().toLowerCase();
};

const requireRoot = (options: NativeIntegrationHandlersOptions) => {
  const stellaAppDir = options.getStellaAppDir();
  if (!stellaAppDir) throw new Error("Stella root is unavailable.");
  return stellaAppDir;
};

const resolveBackendAuth = async (options: NativeCredentialFlowOptions) => {
  const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
  if (!siteUrl) throw new Error("Stella backend is unavailable.");
  const authToken = (await options.getConvexAuthToken?.())?.trim() ?? "";
  if (!authToken) throw new Error("Sign in to Stella to use integrations.");
  return { siteUrl, authToken };
};

const createBackendIntegrationConnectLink = async (
  auth: { siteUrl: string; authToken: string },
  id: string,
  fetchImpl: typeof fetch = fetch,
) => {
  const response = await fetchImpl(
    `${auth.siteUrl}/api/native-integrations/connect-link`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${auth.authToken}`,
      },
      body: JSON.stringify({ id }),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    url?: unknown;
    error?: unknown;
    message?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : "Could not start this connection.";
    throw new Error(message);
  }
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!url) throw new Error("Stella backend did not return a connect link.");
  return url;
};

export const resolveDesktopNativeConnectorCatalog = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
): Promise<ResolvedNativeCatalog> =>
  resolveNativeConnectorCatalog({
    stellaDataDir: stellaAppDir,
    getStellaSiteAuth: async () => {
      const baseUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
      const authToken = (await options.getConvexAuthToken?.())?.trim() ?? "";
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
  });

export const resolveDesktopNativeConnectorEntry = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
  id: string,
) => {
  const catalog = await resolveDesktopNativeConnectorCatalog(
    options,
    stellaAppDir,
  );
  return {
    catalog,
    entry: getNativeConnectorCatalogEntry(id, catalog.entries),
  };
};

export type ResolvedNativeCredentialTarget = {
  catalog: ResolvedNativeCatalog;
  entry: NativeConnectorCatalogEntry;
};

export const ensureNativeCredential = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
  id: string,
  acceptedTarget?: ResolvedNativeCredentialTarget,
) => {
  const target =
    acceptedTarget ??
    (await resolveDesktopNativeConnectorEntry(options, stellaAppDir, id));
  if (target.entry?.id !== id) {
    throw new Error(
      target.entry
        ? "Accepted connector snapshot does not match the request."
        : `Unknown Store integration: ${id}`,
    );
  }
  const entry = target.entry;
  const auth = await resolveBackendAuth(options);
  const current = await probeBackendIntegrationConnection({
    siteUrl: auth.siteUrl,
    authToken: auth.authToken,
    id,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (current === "connected") return;
  if (current === "unsupported") {
    throw new Error(
      `Could not connect ${entry.name} because Stella's connection-status service is unavailable.`,
    );
  }
  if (!options.requestExternalOAuthApproval) {
    throw new Error(`${entry.name} connection is unavailable.`);
  }

  const url = await createBackendIntegrationConnectLink(
    auth,
    id,
    options.fetchImpl,
  );
  const approved = await options.requestExternalOAuthApproval({
    displayName: entry.name,
    resourceUrl: url,
    description: `Stella needs to open ${entry.name} in your browser so you can sign in and approve access.`,
  });
  if (!approved.ok) {
    throw new Error(`Could not connect ${entry.name}: ${approved.reason}`);
  }
  const wait = await waitForBackendIntegrationConnection({
    siteUrl: auth.siteUrl,
    authToken: auth.authToken,
    id,
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (wait === "connected") return;
  if (wait === "cancelled") {
    throw new Error(`Could not connect ${entry.name}: cancelled`);
  }
  if (wait === "auth_unavailable") {
    throw new Error(
      `Could not confirm the ${entry.name} connection because Stella's sign-in expired. Sign in and try again.`,
    );
  }
  if (wait === "unsupported") {
    throw new Error(
      `Could not confirm the ${entry.name} connection because Stella's connection-status service is unavailable.`,
    );
  }
  throw new Error(
    `${entry.name} authorization was not completed in the browser. Finish signing in on the ${entry.name} page that opened, then try connecting again.`,
  );
};

export const registerNativeIntegrationHandlers = (
  options: NativeIntegrationHandlersOptions,
) => {
  ipcMain.handle("nativeIntegrations:list", async (event) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:list");
    const stellaAppDir = requireRoot(options);
    const catalog = await resolveDesktopNativeConnectorCatalog(
      options,
      stellaAppDir,
    );
    return await listNativeConnectors(stellaAppDir, catalog.entries);
  });

  ipcMain.handle(
    "nativeIntegrations:enable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:enable");
      const stellaAppDir = requireRoot(options);
      const id = readId(payload);
      const target = await resolveDesktopNativeConnectorEntry(
        options,
        stellaAppDir,
        id,
      );
      if (!target.entry) throw new Error(`Unknown Store integration: ${id}`);
      await ensureNativeCredential(options, stellaAppDir, id, {
        catalog: target.catalog,
        entry: target.entry,
      });
      return await enableNativeConnector(
        stellaAppDir,
        id,
        "store",
        target.catalog.entries,
      );
    },
  );

  ipcMain.handle(
    "nativeIntegrations:disable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:disable");
      const stellaAppDir = requireRoot(options);
      const id = readId(payload);
      const catalog = await resolveDesktopNativeConnectorCatalog(
        options,
        stellaAppDir,
      );
      return await disableNativeConnector(stellaAppDir, id, catalog.entries);
    },
  );
};
