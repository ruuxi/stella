import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { writeCachedServerCatalog } from "../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../runtime/kernel/connectors/native-integrations.js";
import { resolveDesktopNativeConnectorEntry } from "../../../electron/ipc/native-integration-handlers.js";

const roots: string[] = [];
const backendEntry = (
  id: string,
  name: string,
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 4,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} integration.`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop native integration catalog resolution", () => {
  it("returns incomplete bundled Outlook metadata when no authoritative catalog exists", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      "outlook",
    );
    expect(resolved.catalog.sources.outlook).toBe("bundled");
    expect(resolved.entry).toMatchObject({
      provider: "oauth-catalog",
      localExecution: "incomplete",
    });
  });

  it("keeps cached Outlook backend semantics when live auth is unavailable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [backendEntry("outlook", "Outlook")]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      { getConvexSiteUrl: () => null, getConvexAuthToken: async () => null },
      root,
      "outlook",
    );
    expect(resolved.catalog.sources.outlook).toBe("cache");
    expect(resolved.entry).toMatchObject({
      id: "outlook",
      provider: "backend-composio",
      backendConnector: { toolkit: "OUTLOOK" },
    });
  });

  it("keeps cached backend-only ids available to enable and connect flows", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-desktop-catalog-"));
    roots.push(root);
    const entry = backendEntry("desktop_backend_only", "Desktop Backend Only");
    await writeCachedServerCatalog(root, [entry]);

    const resolved = await resolveDesktopNativeConnectorEntry(
      {},
      root,
      entry.id,
    );
    expect(resolved.catalog.sources[entry.id]).toBe("cache");
    expect(resolved.entry).toMatchObject({
      id: entry.id,
      provider: "backend-composio",
    });
  });
});
