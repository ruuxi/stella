import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const PROGRAM = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../runtime/home-seed/skills/derive-site-api/scripts/program.ts",
);

const workDir = mkdtempSync(path.join(tmpdir(), "derive-site-api-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

type Entry = Record<string, unknown>;

let fixtureCount = 0;
const runAnalyzer = (entries: Entry[], extraArgs: string[] = []) => {
  const harPath = path.join(workDir, `har-${fixtureCount++}.json`);
  writeFileSync(harPath, JSON.stringify({ log: { version: "1.2", entries } }), "utf8");
  const result = spawnSync("bun", [PROGRAM, harPath, ...extraArgs], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`analyzer exited ${result.status}: ${result.stderr}`);
  }
  return { stdout: result.stdout, harPath };
};

const jsonCall = (options: {
  method?: string;
  url: string;
  requestHeaders?: Record<string, string>;
  postData?: unknown;
  status?: number;
  response?: unknown;
  resourceType?: string;
  mimeType?: string;
}): Entry => ({
  _resourceType: options.resourceType ?? "XHR",
  request: {
    method: options.method ?? "GET",
    url: options.url,
    headers: Object.entries(options.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
    ...(options.postData !== undefined
      ? { postData: { mimeType: "application/json", text: JSON.stringify(options.postData) } }
      : {}),
  },
  response: {
    status: options.status ?? 200,
    content: {
      mimeType: options.mimeType ?? "application/json",
      size: 100,
      ...(options.response !== undefined ? { text: JSON.stringify(options.response) } : {}),
    },
  },
});

describe("derive-site-api HAR analyzer", () => {
  it("collapses varying path identifiers into one endpoint", () => {
    const { stdout } = runAnalyzer([
      jsonCall({ url: "https://shop.test/api/v2/orders/order_9912/items", response: { ok: 1 } }),
      jsonCall({ url: "https://shop.test/api/v2/orders/order_7741/items", response: { ok: 1 } }),
      jsonCall({ url: "https://shop.test/api/v2/orders/order_3310/items", response: { ok: 1 } }),
    ]);

    expect(stdout).toContain("/api/v2/orders/{id}/items");
    expect(stdout).toContain("3 API calls → 1 distinct endpoints");
    // The API version must survive: it contains a digit but never varies.
    expect(stdout).not.toContain("/api/{id}/");
  });

  it("keeps genuinely different sub-resources apart", () => {
    const { stdout } = runAnalyzer([
      jsonCall({ url: "https://shop.test/api/stores/44/menu", response: { ok: 1 } }),
      jsonCall({ url: "https://shop.test/api/stores/55/reviews", response: { ok: 1 } }),
    ]);

    expect(stdout).toContain("/api/stores/{id}/menu");
    expect(stdout).toContain("/api/stores/{id}/reviews");
    expect(stdout).toContain("2 distinct endpoints");
  });

  it("drops analytics traffic and non-API resources", () => {
    const { stdout } = runAnalyzer([
      jsonCall({ url: "https://shop.test/api/cart", response: { items: [] } }),
      jsonCall({ method: "POST", url: "https://api.segment.io/v1/track", response: { ok: true } }),
      jsonCall({ method: "POST", url: "https://shop.test/api/telemetry/beacon", response: {} }),
      jsonCall({
        url: "https://shop.test/static/bundle.js",
        resourceType: "Script",
        mimeType: "application/javascript",
      }),
    ]);

    expect(stdout).toContain("1 API calls");
    expect(stdout).toContain("/api/cart");
    expect(stdout).not.toContain("segment.io");
    expect(stdout).not.toContain("beacon");
  });

  it("redacts credentials and personal fields but keeps structure", () => {
    const { stdout } = runAnalyzer([
      jsonCall({
        method: "POST",
        url: "https://shop.test/api/checkout",
        requestHeaders: { cookie: "sid=supersecretvalue", authorization: "Bearer topsecret" },
        postData: { email: "someone@example.com", quantity: 3, itemId: "sku_12" },
        response: { orderId: "ord_1", totalCents: 4200 },
      }),
    ]);

    expect(stdout).not.toContain("supersecretvalue");
    expect(stdout).not.toContain("topsecret");
    expect(stdout).not.toContain("someone@example.com");
    expect(stdout).toContain("<credential>");
    expect(stdout).toContain("<redacted");
    // Non-sensitive structure is still concrete enough to build a call from.
    expect(stdout).toContain("quantity");
    expect(stdout).toContain("number (3)");
    expect(stdout).toContain("totalCents");
  });

  it("redacts credential-ish query params whatever the separator", () => {
    const { stdout } = runAnalyzer([
      jsonCall({
        url: "https://search.test/1/indexes/Items/query?x-algolia-api-key=deadbeefkey&x-algolia-application-id=APPID",
        response: { hits: [] },
      }),
      jsonCall({
        url: "https://search.test/1/indexes/Items/query?access_key=zzztopsecret&page=2",
        response: { hits: [] },
      }),
    ]);

    expect(stdout).not.toContain("deadbeefkey");
    expect(stdout).not.toContain("zzztopsecret");
    // Non-credential params stay readable so the call can still be rebuilt.
    expect(stdout).toContain("APPID");
    expect(stdout).toContain("page");
  });

  it("shows a concrete example URL alongside the templated path", () => {
    const { stdout } = runAnalyzer([
      jsonCall({ url: "https://shop.test/api/orders/1001/items", response: { ok: 1 } }),
      jsonCall({ url: "https://shop.test/api/orders/1002/items", response: { ok: 1 } }),
    ]);

    expect(stdout).toContain("/api/orders/{id}/items");
    expect(stdout).toContain("Example: `https://shop.test/api/orders/1001/items`");
  });

  it("groups GraphQL by operation and surfaces the query document", () => {
    const query = "query GetCart($id: ID!) { cart(id: $id) { total } }";
    const { stdout } = runAnalyzer([
      jsonCall({
        method: "POST",
        url: "https://shop.test/graphql",
        postData: { operationName: "GetCart", variables: { id: "c1" }, query },
        response: { data: { cart: { total: 10 } } },
      }),
      jsonCall({
        method: "POST",
        url: "https://shop.test/graphql",
        postData: { operationName: "AddItem", variables: { sku: "s1" }, query: "mutation AddItem { addItem { id } }" },
        response: { data: { addItem: { id: "i1" } } },
      }),
    ]);

    expect(stdout).toContain("GraphQL operation: `GetCart`");
    expect(stdout).toContain("GraphQL operation: `AddItem`");
    expect(stdout).toContain("cart(id: $id)");
    expect(stdout).toContain("2 distinct endpoints");
  });

  it("reports cookie-only auth as needing no credential handling", () => {
    const { stdout } = runAnalyzer([
      jsonCall({
        url: "https://shop.test/api/me",
        requestHeaders: { cookie: "sid=abc" },
        response: { id: 1 },
      }),
    ]);

    expect(stdout).toContain("Cookie-only");
  });

  it("warns when a recording captured no response bodies", () => {
    const { stdout } = runAnalyzer([jsonCall({ url: "https://shop.test/api/me" })]);

    expect(stdout).toContain("No response bodies were captured");
  });

  it("preserves nesting deep enough to read list item fields", () => {
    const { stdout } = runAnalyzer([
      jsonCall({
        url: "https://shop.test/api/feed",
        response: { data: { feed: { stores: [{ id: "s1", name: "Noodles", rating: 4.7 }] } } },
      }),
    ]);

    expect(stdout).toContain("rating");
    expect(stdout).toContain("number (4.7)");
  });

  it("surfaces socket traffic as API surface, collapsed by message shape", () => {
    const socket: Entry = {
      _resourceType: "WebSocket",
      _webSocketMessages: [
        { type: "send", data: JSON.stringify({ op: "subscribe", channel: "prices" }) },
        { type: "receive", data: JSON.stringify({ event: "tick", symbol: "AAPL", price: 1 }) },
        { type: "receive", data: JSON.stringify({ event: "tick", symbol: "MSFT", price: 2 }) },
        { type: "receive", data: JSON.stringify({ event: "tick", symbol: "GOOG", price: 3 }) },
      ],
      request: { method: "GET", url: "wss://feed.test/socket", headers: [] },
      response: { status: 101, content: { mimeType: "" } },
    };

    const { stdout } = runAnalyzer([socket]);

    expect(stdout).toContain("wss://feed.test/socket");
    expect(stdout).toContain("Socket messages (4 frames, 2 distinct shapes)");
    // Three ticks differ only in values, so they collapse to one shape.
    expect(stdout).toContain("receive ×3");
    expect(stdout).toContain("send ×1");
    expect(stdout).toContain("symbol");
  });

  it("surfaces event-stream messages", () => {
    const { stdout } = runAnalyzer([
      {
        _resourceType: "EventSource",
        _eventSourceMessages: [
          { type: "receive", eventName: "update", data: JSON.stringify({ score: 3 }) },
        ],
        request: { method: "GET", url: "https://live.test/stream", headers: [] },
        response: { status: 200, content: { mimeType: "text/event-stream" } },
      },
    ]);

    expect(stdout).toContain("Event stream messages");
    expect(stdout).toContain("score");
  });

  it("emits a machine-readable surface on request", () => {
    const jsonPath = path.join(workDir, "surface.json");
    runAnalyzer(
      [
        jsonCall({
          method: "POST",
          url: "https://shop.test/api/cart/items",
          requestHeaders: { "x-csrf-token": "t" },
          postData: { sku: "a" },
          response: { ok: true },
        }),
      ],
      ["--json", jsonPath],
    );

    const surface = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(surface.auth.credentialHeaders).toContain("x-csrf-token");
    expect(surface.auth.cookieOnly).toBe(false);
    expect(surface.endpoints).toHaveLength(1);
    expect(surface.endpoints[0]).toMatchObject({ method: "POST", path: "/api/cart/items" });
  });

  it("ranks failing endpoints below working ones", () => {
    const { stdout } = runAnalyzer([
      jsonCall({ url: "https://shop.test/api/broken", status: 401, response: { error: "nope" } }),
      jsonCall({ url: "https://shop.test/api/working", response: { ok: true } }),
    ]);

    expect(stdout.indexOf("/api/working")).toBeLessThan(stdout.indexOf("/api/broken"));
  });
});
