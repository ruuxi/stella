import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCachedServerCatalog } from "../../../../runtime/kernel/connectors/catalog-cache.js";
import { recordConnectorDecline } from "../../../../runtime/kernel/connectors/connect-preferences.js";
import { resetConnectorKeywordIndexCache } from "../../../../runtime/kernel/connectors/keyword-index.js";
import {
  enableNativeConnector,
  type NativeConnectorCatalogEntry,
} from "../../../../runtime/kernel/connectors/native-integrations.js";
import type { BeforeUserMessagePayload } from "../../../../runtime/kernel/extensions/types.js";
import { createConnectorAvailabilityReminderHook } from "../../../../runtime/extensions/stella-runtime/hooks/connector-availability-reminder.hook.js";
import { recordReminderShown } from "../../../../runtime/kernel/runner/reminder-window-gate.js";
import { formatThreadCheckpointMessage } from "../../../../runtime/kernel/thread-runtime.js";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "stella-connector-reminder-"),
  );
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  resetConnectorKeywordIndexCache();
});

const notionEntry: NativeConnectorCatalogEntry = {
  id: "notion",
  name: "Notion",
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 25,
  availability: "ready",
  provider: "backend-composio",
  description: "Create and edit Notion pages and databases.",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "NOTION" },
};

const storeWith = (
  messages: Array<{ content: string; timestamp: number }> = [],
) => ({
  loadThreadMessages: () => messages,
});

const basePayload = (userPrompt: string): BeforeUserMessagePayload => ({
  agentType: "orchestrator",
  userPrompt,
  conversationId: "conv-1",
  threadKey: "conv-1",
  isUserTurn: true,
  uiVisibility: "visible",
});

const makeHook = (
  root: string,
  windowMessages: Array<{ content: string; timestamp: number }> = [],
  connected = false,
) =>
  createConnectorAvailabilityReminderHook({
    stellaDataDir: root,
    store: storeWith(windowMessages),
    getStellaSiteAuth: () => ({
      baseUrl: "https://stella.test",
      authToken: "token",
    }),
    fetchImpl: async () =>
      new Response(JSON.stringify({ connected }), { status: 200 }),
  });

describe("connector-availability reminder hook", () => {
  it("injects the not-connected offer variant on a keyword match", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const hook = makeHook(root);
    const result = await hook.handler(
      basePayload("save this article to notion please"),
    );
    const message = result?.prependMessages?.[0];
    expect(message).toBeDefined();
    expect(message?.uiVisibility).toBe("hidden");
    expect(message?.text).toContain("not connected");
    expect(message?.text).toContain("connector_status");
    expect(message?.text).toContain("tool_search");
  });

  it("injects the connected variant when the integration is usable", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    await enableNativeConnector(root, "notion", "store", [notionEntry]);
    const hook = makeHook(root, [], true);
    const result = await hook.handler(
      basePayload("add a row to my notion database"),
    );
    const message = result?.prependMessages?.[0];
    expect(message?.text).toContain("is connected via stella-connect");
    expect(message?.text).not.toContain("connector_status");
  });

  it("does not repeat while the reminder sits in the active window", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const hook = makeHook(root);
    const first = await hook.handler(basePayload("file this in notion"));
    expect(first?.prependMessages?.length).toBe(1);
    // Same active window (no compaction since): second mention stays quiet.
    const second = await hook.handler(basePayload("also notion this one"));
    expect(second).toBeUndefined();
  });

  it("becomes eligible again after a compaction checkpoint resets the window", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    // Shown earlier…
    await recordReminderShown({
      stellaDataDir: root,
      threadKey: "conv-1",
      key: "connector-offer:notion",
      timestamp: Date.now() - 60_000,
    });
    // …then the window was compacted (checkpoint newer than the reminder).
    const checkpoint = {
      content: formatThreadCheckpointMessage({
        summary: "Compacted: user filed several notes to Notion earlier.",
      }),
      timestamp: Date.now() - 1_000,
    };
    const hook = makeHook(root, [checkpoint]);
    const result = await hook.handler(basePayload("put the notes into notion"));
    expect(result?.prependMessages?.[0]?.text).toContain("connector_status");
  });

  it("suppresses the offer variant after a decline, even across window resets", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    await recordConnectorDecline(root, "notion");
    // Fresh window (post-compaction equivalent): still no offer.
    const hook = makeHook(root);
    const result = await hook.handler(basePayload("sync this into notion"));
    expect(result).toBeUndefined();
  });

  it("still shows the connected variant for a previously-declined connector", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    // Connected first, then a (stale) decline on record: the connected
    // variant is just useful info and stays eligible.
    await enableNativeConnector(root, "notion", "store", [notionEntry]);
    await recordConnectorDecline(root, "notion");
    const hook = makeHook(root, [], true);
    const result = await hook.handler(basePayload("update my notion tracker"));
    expect(result?.prependMessages?.[0]?.text).toContain(
      "is connected via stella-connect",
    );
  });

  it("ignores subagent prompt builds and empty prompts", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const hook = makeHook(root);
    expect(
      await hook.handler({ ...basePayload("notion"), agentType: "general" }),
    ).toBeUndefined();
    expect(await hook.handler(basePayload("   "))).toBeUndefined();
  });
});
