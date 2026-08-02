import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearConnectorDecline,
  getConnectorDecline,
  listConnectorDeclines,
  recordConnectorDecline,
} from "../../../../../runtime/kernel/connectors/connect-preferences.js";
import {
  discoverConnectors,
  scoreConnectorMatch,
} from "../../../../../runtime/kernel/connectors/discovery.js";
import { enableNativeConnector } from "../../../../../runtime/kernel/connectors/native-integrations.js";

const catalog = [
  {
    id: "gmail",
    name: "Gmail",
    category: "email",
    auth: ["OAUTH2"],
    catalogToolCount: 12,
    availability: "ready" as const,
    provider: "backend-composio" as const,
    description: "Read and send Gmail.",
    connectable: true as const,
    backendConnector: { type: "composio" as const, toolkit: "GMAIL" },
  },
  {
    id: "googledrive",
    name: "Google Drive",
    category: "storage",
    auth: ["OAUTH2"],
    catalogToolCount: 8,
    availability: "ready" as const,
    provider: "backend-composio" as const,
    description: "Search Google Drive files.",
    connectable: true as const,
    backendConnector: { type: "composio" as const, toolkit: "GOOGLEDRIVE" },
  },
];

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connect-discovery-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("connect-preferences", () => {
  it("records, reads, and clears declines", async () => {
    const root = makeRoot();
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
    expect((await recordConnectorDecline(root, "gmail")).count).toBe(1);
    expect((await recordConnectorDecline(root, "gmail")).count).toBe(2);
    expect(Object.keys(await listConnectorDeclines(root))).toEqual(["gmail"]);
    await clearConnectorDecline(root, "gmail");
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
  });

  it("survives a corrupt preferences file", async () => {
    const root = makeRoot();
    await mkdir(path.join(root, "connectors"), { recursive: true });
    await writeFile(
      path.join(root, "connectors", "connect-preferences.json"),
      "not-json",
      "utf-8",
    );
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
  });

  it("is cleared when the integration is enabled", async () => {
    const root = makeRoot();
    await recordConnectorDecline(root, "gmail");
    await enableNativeConnector(root, "gmail", "store", catalog);
    expect(await getConnectorDecline(root, "gmail")).toBeNull();
  });
});

describe("scoreConnectorMatch", () => {
  it("ranks exact id/name hits above substring hits", () => {
    const exact = scoreConnectorMatch(["gmail"], {
      id: "gmail",
      name: "Gmail",
    });
    const substring = scoreConnectorMatch(["gmail"], {
      id: "mailchimp",
      name: "Mailchimp",
      description: "Not gmail.",
    });
    expect(exact).toBeGreaterThan(substring);
  });
});

describe("discoverConnectors", () => {
  it("only discovers entries from the authoritative Composio catalog", async () => {
    const root = makeRoot();
    await recordConnectorDecline(root, "googledrive");
    const gmail = await discoverConnectors(root, "gmail", {
      enabledNativeIds: new Set(["gmail"]),
      catalogOverride: catalog,
    });
    expect(gmail[0]).toMatchObject({
      id: "gmail",
      kind: "native",
      enabled: true,
      declined: false,
      provider: "backend-composio",
    });
    const drive = await discoverConnectors(root, "google drive files", {
      enabledNativeIds: new Set(),
      catalogOverride: catalog,
    });
    expect(drive.find((entry) => entry.id === "googledrive")).toMatchObject({
      enabled: false,
      declined: true,
    });
  });

  it("has no bundled fallback", async () => {
    const root = makeRoot();
    expect(
      await discoverConnectors(root, "gmail", {
        enabledNativeIds: new Set(),
      }),
    ).toEqual([]);
  });
});
