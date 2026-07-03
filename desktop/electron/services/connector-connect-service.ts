// Brokers agent-initiated `connector.requestConnection` prompts from the
// runtime CLI bridge (`stella-connect request-connection <id>`) into an
// inline connect card in the chat surfaces. Accepting the card runs the
// exact same enable + OAuth flow as the Store (`ensureNativeCredential`
// + `enableNativeConnector`), with the OAuth dialogs suppressed — the
// card click IS the launch gesture, so the browser opens directly. The
// CLI blocks on the outcome, which is what lets the agent continue the
// user's original task the moment the connection lands.

import { randomUUID } from "crypto";
import { BrowserWindow } from "electron";
import {
  buildNativeConnectorCatalog,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
} from "../../../runtime/kernel/connectors/native-integrations.js";
import type { WindowManagerTarget } from "../../../runtime/kernel/lifecycle-targets.js";
import {
  ensureNativeCredential,
  loadConfiguredOAuthProviders,
  loadServerNativeConnectorCatalog,
  type NativeCredentialFlowOptions,
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
  state: "pending" | "connecting";
  oauthAbort: AbortController;
  windows: BrowserWindow[];
};

// Slightly under the CLI's 10-minute bridge timeout so the card always
// resolves (and disappears) before the agent-side wait gives up.
const CARD_TIMEOUT_MS = 9.5 * 60 * 1000;

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
  }): Promise<ConnectorConnectOutcome> {
    const stellaAppDir = this.options.getStellaAppDir();
    if (!stellaAppDir) {
      return { ok: false, reason: "unsupported" };
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
      id: payload.id,
      name: payload.name,
      state: "pending",
      oauthAbort: new AbortController(),
      windows: targetWindows,
    });

    const request: ConnectorConnectRequestPayload = {
      requestId,
      id: payload.id,
      name: payload.name,
      description: payload.description,
      iconUrl: payload.iconUrl,
      category: payload.category,
      reason: payload.reason,
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

  respond(payload: { requestId: string; action: "accept" | "decline" | "cancel" }): {
    ok: boolean;
    error?: string;
  } {
    const meta = this.meta.get(payload.requestId);
    if (!meta || !this.pending.has(payload.requestId)) {
      return { ok: false, error: "Connect request not found." };
    }
    if (payload.action === "decline") {
      meta.oauthAbort.abort(new Error("Connection declined."));
      this.settle(payload.requestId, { ok: false, reason: "declined" }, "declined");
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
    void this.runConnectFlow(payload.requestId, meta);
    return { ok: true };
  }

  cancelAll() {
    for (const [requestId, meta] of this.meta) {
      meta.oauthAbort.abort(new Error("Connection cancelled."));
      this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
    }
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
      await ensureNativeCredential(flowOptions, stellaAppDir, meta.id);
      const configuredOAuthProviders =
        await loadConfiguredOAuthProviders(flowOptions);
      const serverCatalog = await loadServerNativeConnectorCatalog(flowOptions);
      const entry = getNativeConnectorCatalogEntry(
        meta.id,
        buildNativeConnectorCatalog(serverCatalog ?? undefined),
      );
      if (!entry) {
        throw new Error(`Unknown integration: ${meta.id}`);
      }
      await enableNativeConnector(
        stellaAppDir,
        meta.id,
        "store",
        {
          configuredBackendProviders: configuredOAuthProviders.backend,
          configuredExternalCallbackProviders:
            configuredOAuthProviders.externalCallback,
        },
        serverCatalog ?? undefined,
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
