import { mkdtempSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send },
};

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  shell: { openExternal: vi.fn() },
}));

import { writeCachedServerCatalog } from "../../../../runtime/kernel/connectors/catalog-cache.js";
import { getNativeConnectorReadiness } from "../../../../runtime/kernel/connectors/connection-status.js";
import {
  buildNativeConnectorCatalog,
  enableNativeConnector,
  type NativeConnectorCatalogEntry,
} from "../../../../runtime/kernel/connectors/native-integrations.js";
import { setConnectorTokenStoreBroker } from "../../../../runtime/kernel/connectors/oauth.js";
import { ConnectorConnectService } from "../../../electron/services/connector-connect-service.js";

const roots: string[] = [];
const backendEntry = (
  id: string,
  name: string,
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 12,
  availability: "ready",
  provider: "backend-composio",
  description: `Canonical ${name} description.`,
  iconUrl: "https://example.com/canonical.png",
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
});

const makeService = (root: string, withSiteAuth = false) => {
  const credentialService = {
    requestPreregisteredOAuth: vi.fn(),
    requestExternalOAuthApproval: vi.fn(),
    requestDeviceOAuth: vi.fn(),
  };
  const service = new ConnectorConnectService({
    getStellaAppDir: () => root,
    getConvexAuthToken: async () => (withSiteAuth ? "site-token" : null),
    getConvexSiteUrl: () => (withSiteAuth ? "https://stella.test" : null),
    windowManagerTarget: { getWindowManager: () => null } as never,
    connectorCredentialService: credentialService as never,
  });
  return { service, credentialService };
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
};

afterEach(async () => {
  setConnectorTokenStoreBroker(null);
  vi.unstubAllGlobals();
  send.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ConnectorConnectService canonical guards", () => {
  it("rejects direct bundled-only Outlook requests before emitting a card", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    const { service, credentialService } = makeService(root);

    await expect(
      service.requestConnection({
        id: "outlook",
        name: "Caller supplied Outlook",
        description: "Untrusted description",
      }),
    ).resolves.toEqual({ ok: false, reason: "connector_unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(credentialService.requestPreregisteredOAuth).not.toHaveBeenCalled();
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("uses canonical card metadata and revalidates before credential side effects", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("outlook", "Outlook")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/api/native-oauth/providers")) {
          return new Response(
            JSON.stringify({ providers: [{ id: "google-workspace" }] }),
            { status: 200 },
          );
        }
        return new Response("offline", { status: 503 });
      }),
    );
    const { service, credentialService } = makeService(root, true);

    const outcome = service.requestConnection({
      id: "OUTLOOK",
      name: "Spoofed name",
      description: "Spoofed description",
      iconUrl: "https://example.com/spoofed.png",
      category: "spoofed",
    });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as {
      requestId: string;
      id: string;
      name: string;
      description: string;
      iconUrl: string;
      category: string;
    };
    expect(card).toMatchObject({
      id: "outlook",
      name: "Outlook",
      description: "Canonical Outlook description.",
      iconUrl: "https://example.com/canonical.png",
      category: "productivity",
    });

    await unlink(path.join(root, "connectors/catalog-cache.json"));
    expect(
      service.respond({ requestId: card.requestId, action: "accept" }),
    ).toEqual({
      ok: true,
    });
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("no longer available"),
    });
    expect(credentialService.requestPreregisteredOAuth).not.toHaveBeenCalled();
    expect(
      credentialService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
    expect(credentialService.requestDeviceOAuth).not.toHaveBeenCalled();
  });

  it("reconnects enabled Gmail with a missing token and restores executable readiness", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-service-"));
    roots.push(root);
    await enableNativeConnector(root, "gmail", "store");
    let token: { accessToken: string } | null = null;
    setConnectorTokenStoreBroker({
      load: async () => token,
      save: async () => undefined,
      delete: async () => undefined,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/api/native-oauth/providers")) {
          return new Response(
            JSON.stringify({ providers: [{ id: "google-workspace" }] }),
            { status: 200 },
          );
        }
        return new Response("offline", { status: 503 });
      }),
    );
    const { service, credentialService } = makeService(root, true);
    credentialService.requestPreregisteredOAuth.mockImplementation(async () => {
      token = { accessToken: "restored-token" };
      return { ok: true };
    });

    const outcome = service.requestConnection({ id: "gmail", name: "spoofed" });
    await waitFor(() => send.mock.calls.length === 1);
    const card = send.mock.calls[0]![1] as { requestId: string; name: string };
    expect(card.name).toBe("Gmail");
    service.respond({ requestId: card.requestId, action: "accept" });
    await expect(outcome).resolves.toEqual({ ok: true, status: "connected" });
    expect(credentialService.requestPreregisteredOAuth).toHaveBeenCalledOnce();

    const gmail = buildNativeConnectorCatalog().find(
      (entry) => entry.id === "gmail",
    )!;
    await expect(
      getNativeConnectorReadiness(root, gmail),
    ).resolves.toMatchObject({
      enabled: true,
      accountVerified: true,
      executable: true,
    });
  });
});
