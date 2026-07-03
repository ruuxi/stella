import { describe, expect, it } from "vitest";

import { buildMergedConnectorCatalog } from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import {
  buildNativeConnectorCatalog,
  getNativeConnectorCatalogEntry,
  type NativeConnectorCatalogEntry,
} from "../../../../../runtime/kernel/connectors/native-integrations.js";

const composioEntry = (
  id: string,
  name: string,
  overrides: Partial<NativeConnectorCatalogEntry> = {},
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "integrations",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} integration`,
  connectable: true,
  backendConnector: { type: "composio", toolkit: id.toUpperCase() },
  ...overrides,
});

describe("buildNativeConnectorCatalog server-catalog overlay", () => {
  it("keeps bundled entries when the server catalog only carries backend integrations", () => {
    // Regression: a server catalog with only a Composio entry must not
    // evict Gmail — discovery could offer it while the Store/connect
    // paths (which pass the server catalog through) failed to resolve it.
    const catalog = buildNativeConnectorCatalog([
      composioEntry("notion", "Notion"),
    ]);
    const gmail = getNativeConnectorCatalogEntry("gmail", catalog);
    expect(gmail).toBeDefined();
    expect(gmail?.provider).toBe("google-workspace");
    expect(gmail?.connectable).toBe(true);
    expect(getNativeConnectorCatalogEntry("notion", catalog)).toBeDefined();
  });

  it("lets server entries override bundled entries by id", () => {
    const override = composioEntry("gmail", "Gmail (backend)");
    const catalog = buildNativeConnectorCatalog([override]);
    const gmail = getNativeConnectorCatalogEntry("gmail", catalog);
    expect(gmail?.provider).toBe("backend-composio");
    expect(gmail?.name).toBe("Gmail (backend)");
    // No duplicate ids after the overlay.
    expect(catalog.filter((entry) => entry.id === "gmail")).toHaveLength(1);
  });

  it("buildMergedConnectorCatalog matches the overlay semantics", () => {
    const server = [composioEntry("asana", "Asana")];
    const merged = buildMergedConnectorCatalog(server);
    const overlaid = buildNativeConnectorCatalog(server);
    expect(merged.map((entry) => entry.id).sort()).toEqual(
      overlaid.map((entry) => entry.id).sort(),
    );
    expect(getNativeConnectorCatalogEntry("gmail", merged)).toBeDefined();
  });
});
