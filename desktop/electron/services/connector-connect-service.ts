// Brokers agent-initiated `connector.requestConnection` prompts from the
// runtime CLI bridge (`stella-connect request-connection <id>`) into an
// inline connect card in the chat surfaces. Accepting the card runs the
// exact same enable + OAuth flow as the Store (`ensureNativeCredential`
// + `enableNativeConnector`), with the OAuth dialogs suppressed — the
// card click IS the launch gesture, so the browser opens directly. The
// CLI blocks on the outcome, which is what lets the agent continue the
// user's original task the moment the connection lands.

import { randomUUID } from "crypto";
import { BrowserWindow, shell } from "electron";
import {
  enableNativeConnector,
  getNativeConnectorTools,
  type NativeConnectorCatalogEntry,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import { STELLA_BROWSER_EXTENSION_ID } from "../../../runtime/kernel/tools/stella-browser-bridge-config.js";
import { isStellaExtensionInstalled } from "./stella-browser-bridge-service.js";
import type { WindowManagerTarget } from "../../../runtime/kernel/lifecycle-targets.js";
import {
  ensureNativeCredential,
  loadConfiguredOAuthProviders,
  resolveDesktopNativeConnectorEntry,
  type NativeCredentialFlowOptions,
  type ResolvedNativeCredentialTarget,
} from "../ipc/native-integration-handlers.js";
import type { ConnectorCredentialService } from "./connector-credential-service.js";
import type {
  ConnectorConnectPhase,
  ConnectorConnectRequestPayload,
} from "../types.js";
import { PendingRequestStore } from "./pending-request-store.js";

export type ConnectorConnectOutcome =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };

type PendingConnectMeta = {
  id: string;
  name: string;
  kind: "integration" | "browser-extension";
  state: "pending" | "connecting";
  /** Worker-generated handle for turn-abort cancellation. */
  offerId?: string;
  /** Service-derived semantic identity; callers never supply this value. */
  canonicalFingerprint?: string;
  oauthAbort: AbortController;
  windows: BrowserWindow[];
};

// Slightly under the CLI's 10-minute bridge timeout so the card always
// resolves (and disappears) before the agent-side wait gives up.
const CARD_TIMEOUT_MS = 9.5 * 60 * 1000;

// Browser-extension flavor: how the install wait behaves after the user
// accepts. Detection is the same cheap profile-directory scan the bridge
// service uses at startup; the grace delays give the freshly installed
// extension time to boot and dial the native messaging host before the
// worker re-runs the failed stella-browser command.
const BROWSER_EXTENSION_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${STELLA_BROWSER_EXTENSION_ID}`;
const EXTENSION_POLL_INTERVAL_MS = 2_000;
const EXTENSION_CONNECT_GRACE_MS = 6_000;
const EXTENSION_ALREADY_INSTALLED_GRACE_MS = 8_000;
const EXTENSION_FLOW_TIMEOUT_MS = 4 * 60 * 1000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isCanonicalConnectorConnectable = (
  entry: NativeConnectorCatalogEntry | undefined,
) =>
  Boolean(
    entry &&
    entry.connectable &&
    getNativeConnectorTools(entry).length > 0 &&
    (entry.provider === "backend-composio" ||
      entry.localExecution === "production-ready"),
  );

const connectorIdentityFingerprint = (
  target: ResolvedNativeCredentialTarget,
) => {
  const { entry, catalog } = target;
  return JSON.stringify({
    id: entry.id,
    catalogSource: catalog.sources[entry.id] ?? catalog.source,
    provider: entry.provider,
    backendToolkit: entry.backendConnector?.toolkit ?? null,
    localExecution: entry.localExecution ?? null,
    toolPrefix: entry.toolPrefix ?? null,
    tools: getNativeConnectorTools(entry).map((tool) => tool.name),
    connectable: entry.connectable,
    auth: [...entry.auth],
    catalogToolCount: entry.catalogToolCount,
    oauthConfig: entry.oauthConfig ?? null,
  });
};

export class ConnectorConnectService {
  private readonly pending = new PendingRequestStore<ConnectorConnectOutcome>();
  private readonly meta = new Map<string, PendingConnectMeta>();

  constructor(
    private readonly options: {
      windowManagerTarget: WindowManagerTarget<BrowserWindow>;
      getStellaAppDir: () => string | null;
      connectorCredentialService: ConnectorCredentialService;
      getConvexAuthToken?: () => Promise<string | null>;
      getConvexSiteUrl?: () => string | null;
    },
  ) {}

  async requestConnection(payload: {
    id: string;
    name: string;
    description?: string;
    iconUrl?: string;
    category?: string;
    reason?: string;
    conversationId?: string;
    offerId?: string;
  }): Promise<ConnectorConnectOutcome> {
    const stellaAppDir = this.options.getStellaAppDir();
    if (!stellaAppDir) {
      return { ok: false, reason: "unsupported" };
    }
    const target = await resolveDesktopNativeConnectorEntry(
      {
        getConvexAuthToken: this.options.getConvexAuthToken,
        getConvexSiteUrl: this.options.getConvexSiteUrl,
      },
      stellaAppDir,
      payload.id.trim().toLowerCase(),
    );
    const { entry } = target;
    if (!isCanonicalConnectorConnectable(entry)) {
      return { ok: false, reason: "connector_unavailable" };
    }
    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const fullWindow = windowManager?.getFullWindow() ?? null;
    const targetWindows = fullWindow
      ? [fullWindow]
      : BrowserWindow.getAllWindows();
    if (targetWindows.length === 0) {
      return { ok: false, reason: "unsupported" };
    }

    const requestId = randomUUID();
    this.meta.set(requestId, {
      id: entry!.id,
      name: entry!.name,
      kind: "integration",
      state: "pending",
      ...(payload.offerId ? { offerId: payload.offerId } : {}),
      canonicalFingerprint: connectorIdentityFingerprint({
        catalog: target.catalog,
        entry: entry!,
      }),
      oauthAbort: new AbortController(),
      windows: targetWindows,
    });

    const request: ConnectorConnectRequestPayload = {
      requestId,
      id: entry!.id,
      name: entry!.name,
      description: entry!.description,
      iconUrl: entry!.iconUrl,
      category: entry!.category,
      reason: payload.reason,
      kind: "integration",
      ...(payload.conversationId
        ? { conversationId: payload.conversationId }
        : {}),
    };

    const settled = new Promise<ConnectorConnectOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        const meta = this.meta.get(requestId);
        if (!this.pending.has(requestId)) return;
        // A card the user never answered times out; a flow that is
        // mid-OAuth stays owned by the credential service's own
        // timeout, which settles the connect flow promise below.
        if (meta?.state === "pending") {
          this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
        }
      }, CARD_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject: () => undefined,
        timeout,
      });
    });

    for (const window of targetWindows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("connector-connect:request", request);
    }

    return settled;
  }

  /**
   * Browser-extension flavor of the same card, triggered by the worker
   * when a `stella-browser` command fails on the missing Chrome
   * extension bridge. Accept opens the Chrome Web Store and waits for
   * the extension install to appear on disk; the worker re-runs the
   * failed command once this resolves `{ ok: true }`.
   */
  async requestBrowserExtensionConnect(payload: {
    conversationId?: string;
    agentId?: string;
    command?: string;
    offerId?: string;
  }): Promise<ConnectorConnectOutcome> {
    for (const meta of this.meta.values()) {
      if (meta.kind === "browser-extension") {
        // One extension card at a time; the worker-side gate makes this
        // rare, but a second concurrent agent can still race it.
        return { ok: false, reason: "already_pending" };
      }
    }
    const windowManager = this.options.windowManagerTarget.getWindowManager();
    const fullWindow = windowManager?.getFullWindow() ?? null;
    const targetWindows = fullWindow
      ? [fullWindow]
      : BrowserWindow.getAllWindows();
    if (targetWindows.length === 0) {
      return { ok: false, reason: "unsupported" };
    }

    const requestId = randomUUID();
    this.meta.set(requestId, {
      id: "stella-browser-extension",
      name: "the Stella browser extension",
      kind: "browser-extension",
      state: "pending",
      ...(payload.offerId ? { offerId: payload.offerId } : {}),
      oauthAbort: new AbortController(),
      windows: targetWindows,
    });

    const request: ConnectorConnectRequestPayload = {
      requestId,
      id: "stella-browser-extension",
      name: "Stella browser extension",
      description:
        "Lets Stella work inside your real browser — your logged-in sites, tabs, and pages.",
      reason:
        "Stella needs your browser to continue this task, but the extension isn't connected yet.",
      kind: "browser-extension",
      ...(payload.conversationId
        ? { conversationId: payload.conversationId }
        : {}),
    };

    const settled = new Promise<ConnectorConnectOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        const meta = this.meta.get(requestId);
        if (!this.pending.has(requestId)) return;
        if (meta?.state === "pending") {
          this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
        }
      }, CARD_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject: () => undefined,
        timeout,
      });
    });

    for (const window of targetWindows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("connector-connect:request", request);
    }

    return settled;
  }

  respond(payload: {
    requestId: string;
    action: "accept" | "decline" | "cancel";
  }): {
    ok: boolean;
    error?: string;
  } {
    const meta = this.meta.get(payload.requestId);
    if (!meta || !this.pending.has(payload.requestId)) {
      return { ok: false, error: "Connect request not found." };
    }
    if (payload.action === "decline") {
      meta.oauthAbort.abort(new Error("Connection declined."));
      this.settle(
        payload.requestId,
        { ok: false, reason: "declined" },
        "declined",
      );
      return { ok: true };
    }
    if (payload.action === "cancel") {
      // Cancel either dismisses a pending card or aborts an in-flight
      // OAuth flow (the abort rejects the flow, whose catch settles).
      meta.oauthAbort.abort(new Error("Connection cancelled."));
      if (meta.state === "pending") {
        this.settle(
          payload.requestId,
          { ok: false, reason: "cancelled" },
          "cancelled",
        );
      }
      return { ok: true };
    }
    if (meta.state !== "pending") {
      return { ok: false, error: "Connect flow already started." };
    }
    meta.state = "connecting";
    this.broadcastUpdate(meta.windows, payload.requestId, "connecting");
    if (meta.kind === "browser-extension") {
      void this.runBrowserExtensionFlow(payload.requestId, meta);
    } else {
      void this.runConnectFlow(payload.requestId, meta);
    }
    return { ok: true };
  }

  cancelAll() {
    for (const [requestId, meta] of this.meta) {
      meta.oauthAbort.abort(new Error("Connection cancelled."));
      this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
    }
  }

  /**
   * Turn-abort cancellation from the worker (`host.connectorConnect.cancel`).
   * Settles a pending card as cancelled; an in-flight OAuth/install flow is
   * aborted and settles through its own catch/loop.
   */
  cancelByOfferId(offerId: string): { ok: boolean } {
    for (const [requestId, meta] of this.meta) {
      if (meta.offerId !== offerId) continue;
      meta.oauthAbort.abort(new Error("Connection cancelled."));
      if (meta.state === "pending") {
        this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
      }
      return { ok: true };
    }
    return { ok: false };
  }

  private async runConnectFlow(requestId: string, meta: PendingConnectMeta) {
    const stellaAppDir = this.options.getStellaAppDir();
    if (!stellaAppDir) {
      this.settle(
        requestId,
        { ok: false, reason: "unsupported" },
        "error",
        "Stella root is unavailable.",
      );
      return;
    }
    const credentialService = this.options.connectorCredentialService;
    const flowOptions: NativeCredentialFlowOptions = {
      getConvexAuthToken: this.options.getConvexAuthToken,
      getConvexSiteUrl: this.options.getConvexSiteUrl,
      // Cancels the backend Composio completion wait too, so a
      // dismissed/aborted card doesn't keep polling for minutes.
      abortSignal: meta.oauthAbort.signal,
      // Headless: the card click was the launch gesture, so the browser
      // opens directly instead of routing through the approval modal.
      requestPreregisteredOAuth: (payload) =>
        credentialService.requestPreregisteredOAuth({
          ...payload,
          presentation: "headless",
          oauthAbort: meta.oauthAbort,
        }),
      requestExternalOAuthApproval: (payload) =>
        credentialService.requestExternalOAuthApproval({
          ...payload,
          presentation: "headless",
        }),
      // Device flow needs to show the user a pairing code — keep the
      // modal for that rare shape rather than losing the code.
      requestDeviceOAuth: (payload) =>
        credentialService.requestDeviceOAuth(payload),
    };
    try {
      const target = await resolveDesktopNativeConnectorEntry(
        flowOptions,
        stellaAppDir,
        meta.id,
      );
      const { catalog, entry } = target;
      if (!isCanonicalConnectorConnectable(entry)) {
        throw new Error(
          `${meta.name} is no longer available through an executable Store integration.`,
        );
      }
      const acceptedTarget = { catalog, entry: entry! };
      if (
        !meta.canonicalFingerprint ||
        connectorIdentityFingerprint(acceptedTarget) !==
          meta.canonicalFingerprint
      ) {
        throw new Error(
          `${meta.name} connector changed while the card was open. Retry the connection.`,
        );
      }
      await ensureNativeCredential(
        flowOptions,
        stellaAppDir,
        entry!.id,
        acceptedTarget,
      );
      const configuredOAuthProviders =
        await loadConfiguredOAuthProviders(flowOptions);
      await enableNativeConnector(
        stellaAppDir,
        entry!.id,
        "store",
        {
          configuredBackendProviders: configuredOAuthProviders.backend,
          configuredExternalCallbackProviders:
            configuredOAuthProviders.externalCallback,
        },
        catalog.entries,
      );
      this.settle(requestId, { ok: true, status: "connected" }, "connected");
    } catch (error) {
      if (!this.pending.has(requestId)) return;
      const cancelled = meta.oauthAbort.signal.aborted;
      const message =
        error instanceof Error ? error.message : "Connection failed.";
      this.settle(
        requestId,
        { ok: false, reason: cancelled ? "cancelled" : message },
        cancelled ? "cancelled" : "error",
        cancelled ? undefined : message,
      );
    }
  }

  private async runBrowserExtensionFlow(
    requestId: string,
    meta: PendingConnectMeta,
  ) {
    const signal = meta.oauthAbort.signal;
    const settleCancelled = () =>
      this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
    const alreadyInstalled = isStellaExtensionInstalled();
    void shell
      .openExternal(BROWSER_EXTENSION_WEB_STORE_URL)
      .catch(() => undefined);

    if (alreadyInstalled) {
      // Extension files exist — it's likely disabled or the browser is
      // closed. Give the user a moment with the Web Store page (which
      // shows the enable state), then let the worker's re-run test
      // whether the bridge is actually back.
      await sleep(EXTENSION_ALREADY_INSTALLED_GRACE_MS);
      if (!this.pending.has(requestId)) return;
      if (signal.aborted) {
        settleCancelled();
        return;
      }
      this.settle(
        requestId,
        { ok: true, status: "already_connected" },
        "connected",
      );
      return;
    }

    const deadline = Date.now() + EXTENSION_FLOW_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.pending.has(requestId)) return;
      if (signal.aborted) {
        settleCancelled();
        return;
      }
      if (isStellaExtensionInstalled()) {
        // Freshly installed: give the extension time to boot and dial
        // the native messaging host before the worker re-runs the
        // failed command.
        await sleep(EXTENSION_CONNECT_GRACE_MS);
        if (!this.pending.has(requestId)) return;
        if (signal.aborted) {
          settleCancelled();
          return;
        }
        this.settle(requestId, { ok: true, status: "connected" }, "connected");
        return;
      }
      await sleep(EXTENSION_POLL_INTERVAL_MS);
    }
    if (this.pending.has(requestId)) {
      this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
    }
  }

  private settle(
    requestId: string,
    outcome: ConnectorConnectOutcome,
    phase: ConnectorConnectPhase,
    message?: string,
  ) {
    const meta = this.meta.get(requestId);
    if (!this.pending.resolve(requestId, outcome)) return;
    this.meta.delete(requestId);
    this.broadcastUpdate(
      meta?.windows ?? BrowserWindow.getAllWindows(),
      requestId,
      phase,
      message,
    );
  }

  private broadcastUpdate(
    windows: BrowserWindow[],
    requestId: string,
    phase: ConnectorConnectPhase,
    message?: string,
  ) {
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.send("connector-connect:update", {
        requestId,
        phase,
        ...(message ? { message } : {}),
      });
    }
  }
}
