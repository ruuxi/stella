import { describe, expect, it } from "vitest";

import {
  buildNativeConnectorCatalog,
  getNativeConnectorCatalogEntry,
  type NativeConnectorCatalogEntry,
} from "../../../../../runtime/kernel/connectors/native-integrations.js";

const entry: NativeConnectorCatalogEntry = {
  id: "notion",
  name: "Notion",
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: "Notion integration",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "NOTION" },
};

describe("buildNativeConnectorCatalog", () => {
  it("uses the backend catalog as the complete authority", () => {
    expect(buildNativeConnectorCatalog()).toEqual([]);
    const catalog = buildNativeConnectorCatalog([entry]);
    expect(catalog).toEqual([entry]);
    expect(getNativeConnectorCatalogEntry("notion", catalog)).toBe(entry);
    expect(getNativeConnectorCatalogEntry("gmail", catalog)).toBeUndefined();
  });
});
