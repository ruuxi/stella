import { mkdtempSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const fakeWindow = { isDestroyed: () => false, webContents: { send } };
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  shell: { openExternal: vi.fn() },
}));

import { writeCachedServerCatalog } from "../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../runtime/kernel/connectors/native-integrations.js";
import { ensureNativeCredential } from "../../../electron/ipc/native-integration-handlers.js";
import { ConnectorConnectService } from "../../../electron/services/connector-connect-service.js";

const roots: string[] = [];
const entry = (toolkit = "OUTLOOK"): NativeConnectorCatalogEntry => ({
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 12,
  availability: "ready",
  provider: "backend-composio",
  description: "Canonical Outlook description.",
  iconUrl: "https://example.com/canonical.png",
  connectable: true,
  backendConnector: { type: "composio", toolkit },
});

const makeService = (root: string) => {
  const connectorOAuthService = {
    requestExternalOAuthApproval: vi.fn(async () => ({ ok: true as const })),
  };
  return {
    service: new ConnectorConnectService({
      getStellaAppDir: () => root,
      getConvexAuthToken: async () => "site-token",
      getConvexSiteUrl: () => "https://stella.test",
      windowManagerTarget: { getWindowManager: () => null } as never,
      connectorOAuthService: connectorOAuthService as never,
    }),
    connectorOAuthService,
  };
};

const waitForCard = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (send.mock.calls.length > 0)
      return send.mock.calls[0]![1] as {
        requestId: string;
        name: string;
        description: string;
      };
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("card not emitted");
};

afterEach(async () => {
  vi.unstubAllGlobals();
  send.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ConnectorConnectService canonical guards", () => {
  it("rejects requests absent from the backend catalog", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-card-"));
    roots.push(root);
    const { service } = makeService(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 })),
    );
    await expect(
      service.requestConnection({ id: "outlook", name: "Spoofed" }),
    ).resolves.toEqual({ ok: false, reason: "connector_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("uses canonical card metadata and revalidates before OAuth", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-card-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [entry()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 })),
    );
    const { service, connectorOAuthService } = makeService(root);
    const outcome = service.requestConnection({
      id: "OUTLOOK",
      name: "Spoofed",
      description: "Spoofed",
    });
    const card = await waitForCard();
    expect(card).toMatchObject({
      name: "Outlook",
      description: "Canonical Outlook description.",
    });
    await unlink(path.join(root, "connectors/catalog-cache.json"));
    service.respond({ requestId: card.requestId, action: "accept" });
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("no longer available"),
    });
    expect(
      connectorOAuthService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("blocks a toolkit identity change while the card is open", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-card-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [entry()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 })),
    );
    const { service, connectorOAuthService } = makeService(root);
    const outcome = service.requestConnection({
      id: "outlook",
      name: "Outlook",
    });
    const card = await waitForCard();
    await writeCachedServerCatalog(root, [entry("OUTLOOK_V2")]);
    service.respond({ requestId: card.requestId, action: "accept" });
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("connector changed"),
    });
    expect(
      connectorOAuthService.requestExternalOAuthApproval,
    ).not.toHaveBeenCalled();
  });

  it("fails before OAuth when verified connection status is unsupported", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-card-"));
    roots.push(root);
    const requestExternalOAuthApproval = vi.fn(async () => ({
      ok: true as const,
    }));
    await expect(
      ensureNativeCredential(
        {
          getConvexAuthToken: async () => "site-token",
          getConvexSiteUrl: () => "https://stella.test",
          requestExternalOAuthApproval,
          fetchImpl: async () => new Response(null, { status: 404 }),
        },
        root,
        "outlook",
        {
          catalog: {
            entries: [entry()],
            source: "cache",
            sources: { outlook: "cache" },
          },
          entry: entry(),
        },
      ),
    ).rejects.toThrow("connection-status service is unavailable");
    expect(requestExternalOAuthApproval).not.toHaveBeenCalled();
  });
});
