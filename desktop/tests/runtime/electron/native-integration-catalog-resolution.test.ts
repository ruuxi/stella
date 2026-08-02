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
const entry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 4,
  availability: "ready",
  provider: "backend-composio",
  description: "Outlook integration.",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "OUTLOOK" },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop native integration catalog resolution", () => {
  it("returns no entry when neither live nor cached backend catalog exists", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-catalog-"));
    roots.push(root);
    const resolved = await resolveDesktopNativeConnectorEntry({}, root, "outlook");
    expect(resolved.catalog).toMatchObject({
      entries: [],
      source: "unavailable",
      sources: {},
    });
    expect(resolved.entry).toBeUndefined();
  });

  it("uses the cached backend Composio catalog when live auth is unavailable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stella-catalog-"));
    roots.push(root);
    await writeCachedServerCatalog(root, [entry]);
    const resolved = await resolveDesktopNativeConnectorEntry({}, root, "outlook");
    expect(resolved.catalog.sources.outlook).toBe("cache");
    expect(resolved.entry).toEqual(entry);
  });
});
