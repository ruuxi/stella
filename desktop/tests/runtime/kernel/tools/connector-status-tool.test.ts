import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCachedServerCatalog } from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import {
  getConnectorDecline,
  recordConnectorDecline,
} from "../../../../../runtime/kernel/connectors/connect-preferences.js";
import {
  enableNativeConnector,
  type NativeConnectorCatalogEntry,
} from "../../../../../runtime/kernel/connectors/native-integrations.js";
import {
  createConnectorStatusTool,
  resetConnectorStatusCatalogMemo,
  type ConnectorConnectionRequester,
} from "../../../../../runtime/kernel/tools/defs/connector-status.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connector-status-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  resetConnectorStatusCatalogMemo();
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
  iconUrl: "https://example.com/notion.png",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "NOTION" },
};

const makeTool = (
  root: string,
  requester?: ConnectorConnectionRequester,
  connected = false,
) =>
  createConnectorStatusTool({
    stellaDataDir: root,
    getStellaSiteAuth: () => ({
      baseUrl: "https://stella.test",
      authToken: "token",
    }),
    fetchImpl: async () =>
      new Response(JSON.stringify({ connected }), { status: 200 }),
    ...(requester ? { requestConnectorConnection: requester } : {}),
  });

const resultText = (result: { result?: unknown }) => String(result.result);

describe("connector_status tool", () => {
  it("short-circuits when the connector is already connected", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    await enableNativeConnector(root, "notion", "store", [notionEntry]);
    const requester = vi.fn();
    const tool = makeTool(root, requester as never, true);
    const result = await tool.execute({ connector: "notion" }, context);
    expect(resultText(result)).toContain("is connected");
    expect(requester).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      id: "notion",
      status: "executable",
      providerStatus: "connected",
      accountVerified: true,
    });
  });

  it("shows the card and reports success so the orchestrator proceeds", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const requester = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
    }));
    const tool = makeTool(root, requester);
    const result = await tool.execute(
      { connector: "Notion", reason: "To file your notes" },
      context,
    );
    expect(requester).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "notion",
        name: "Notion",
        reason: "To file your notes",
        iconUrl: "https://example.com/notion.png",
        // Card scoping: the originating chat rides along so the renderer
        // shows the card only in that conversation.
        conversationId: "c1",
      }),
      undefined,
    );
    expect(resultText(result)).toContain("now connected");
    expect(resultText(result)).toContain("Continue the original task");
  });

  it("persists a decline and instructs the Store-later fallback", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const requester = vi.fn(async () => ({
      ok: false as const,
      reason: "declined" as const,
    }));
    const tool = makeTool(root, requester);
    const first = await tool.execute({ connector: "notion" }, context);
    expect(resultText(first)).toContain("declined");
    expect(resultText(first)).toContain("Store");
    expect(resultText(first)).toContain("Do not offer");
    expect(await getConnectorDecline(root, "notion")).not.toBeNull();

    // Second call: no new card, previously-declined guidance instead.
    const second = await tool.execute({ connector: "notion" }, context);
    expect(requester).toHaveBeenCalledTimes(1);
    expect(resultText(second)).toContain("previously declined");
  });

  it("does not re-offer a connector the user declined earlier", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    await recordConnectorDecline(root, "notion");
    const requester = vi.fn();
    const tool = makeTool(root, requester as never);
    const result = await tool.execute({ connector: "notion" }, context);
    expect(requester).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("previously declined");
  });

  it("errors with suggestions for unknown connectors", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const tool = makeTool(root);
    const result = await tool.execute(
      { connector: "zzzqqq blorptron" },
      context,
    );
    expect(result.error).toContain("No Store connector matched");
  });

  it("reports timeout/dismiss outcomes without persisting a decline", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const requester = vi.fn(async () => ({
      ok: false as const,
      reason: "timeout" as const,
    }));
    const tool = makeTool(root, requester);
    const result = await tool.execute({ connector: "notion" }, context);
    expect(resultText(result)).toContain("not answered in time");
    expect(resultText(result)).toContain("for now");
    expect(await getConnectorDecline(root, "notion")).toBeNull();
  });

  it("cancels the pending card when the turn is aborted", async () => {
    const root = makeRoot();
    await writeCachedServerCatalog(root, [notionEntry]);
    const controller = new AbortController();
    // Requester models the worker hop: it resolves `cancelled` when the
    // abort signal fires (after cancelling the desktop card).
    const requester: ConnectorConnectionRequester = (_payload, signal) =>
      new Promise((resolve) => {
        const finish = () => resolve({ ok: false, reason: "cancelled" });
        if (signal?.aborted) {
          finish();
          return;
        }
        signal?.addEventListener("abort", finish, { once: true });
      });
    const tool = makeTool(root, requester);
    const pending = tool.execute({ connector: "notion" }, context, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(resultText(result)).toContain("cancelled");
    // A turn abort is not a user decline.
    expect(await getConnectorDecline(root, "notion")).toBeNull();
  });
});
