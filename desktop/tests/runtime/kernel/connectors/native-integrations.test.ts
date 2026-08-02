import { mkdtempSync } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildNativeConnectorCatalog,
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorTools,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
} from "../../../../../runtime/kernel/connectors/native-integrations.js";

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-integrations-"));
  roots.push(root);
  return root;
};

const entry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 2,
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

describe("Composio Store integrations", () => {
  it("has no bundled catalog or provider fallback", () => {
    expect(buildNativeConnectorCatalog()).toEqual([]);
    expect(buildNativeConnectorCatalog([entry])).toEqual([entry]);
  });

  it("exposes only the backend action runner", () => {
    expect(getNativeConnectorTools(entry)).toEqual([
      expect.objectContaining({ name: "OUTLOOK_RUN_ACTION" }),
    ]);
  });

  it("enables from the authoritative catalog and writes no static action copy", async () => {
    const root = createRoot();
    await expect(
      enableNativeConnector(root, entry.id, "store", [entry]),
    ).resolves.toMatchObject({
      id: entry.id,
      enabled: true,
      toolCount: 1,
      actionCount: 2,
    });
    await expect(listNativeConnectors(root, [entry])).resolves.toEqual([
      expect.objectContaining({ id: entry.id, enabled: true }),
    ]);
    const skill = await readFile(
      path.join(root, "skills", entry.id, "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("schemas are fetched through Stella's secure worker bridge");
    await expect(
      access(path.join(root, "skills", entry.id, "ACTIONS.md")),
    ).rejects.toThrow();
    await expect(
      disableNativeConnector(root, entry.id, [entry]),
    ).resolves.toMatchObject({ id: entry.id, enabled: false });
  });

  it("rejects ids missing from the backend catalog", async () => {
    const root = createRoot();
    await expect(
      enableNativeConnector(root, "gmail", "store", [entry]),
    ).rejects.toThrow("Unknown Store integration");
  });
});
