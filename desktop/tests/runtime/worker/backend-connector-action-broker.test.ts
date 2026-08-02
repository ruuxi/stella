import { describe, expect, it, vi } from "vitest";

import type { ResolvedNativeCatalog } from "../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../runtime/kernel/connectors/native-integrations.js";
import { createBackendConnectorActionBroker } from "../../../../runtime/worker/backend-connector-action-broker.js";

const composioEntry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 10,
  availability: "ready",
  provider: "backend-composio",
  description: "Outlook",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "OUTLOOK" },
  actions: [
    {
      name: "OUTLOOK_SEND_EMAIL",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "body"],
        additionalProperties: true,
      },
    },
    {
      name: "OUTLOOK_QUERY_EMAILS",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      name: "OUTLOOK_DELETE_EMAIL",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
  ],
};

const catalog = (entry = composioEntry): ResolvedNativeCatalog => ({
  entries: [entry],
  source: "cache",
  sources: { [entry.id]: "cache" },
});

const canonicalActionResponse = (name: string) => {
  const action = composioEntry.actions?.find(
    (candidate) => candidate.name === name,
  );
  if (!action) return new Response(null, { status: 404 });
  return new Response(JSON.stringify({ actions: [action] }), { status: 200 });
};

const makeBroker = (options: {
  fetchImpl?: typeof fetch;
  authToken?: string;
  refreshSiteAuth?: () => Promise<{
    baseUrl: string;
    authToken: string;
  } | null>;
  entry?: NativeConnectorCatalogEntry;
}) =>
  createBackendConnectorActionBroker({
    stellaDataDir: "/unused",
    getSiteAuth: () => ({
      baseUrl: "https://site.invalid",
      authToken: options.authToken ?? "current-token",
    }),
    refreshSiteAuth:
      options.refreshSiteAuth ??
      (async () => ({
        baseUrl: "https://site.invalid",
        authToken: "fresh-token",
      })),
    resolveCatalog: async () => catalog(options.entry),
    isEnabled: async () => true,
    fetchImpl: options.fetchImpl,
  });

describe("backend connector action broker", () => {
  it.each([401, 403])(
    "dispatches a mutating action only once after backend %s",
    async (status) => {
      const fetchImpl = vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("/actions")) {
          return canonicalActionResponse("OUTLOOK_SEND_EMAIL");
        }
        return new Response(JSON.stringify({ error: "auth rejected" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      });
      const refreshSiteAuth = vi.fn(async () => ({
        baseUrl: "https://site.invalid",
        authToken: "must-not-be-used-after-dispatch",
      }));
      const result = await makeBroker({
        fetchImpl: fetchImpl as typeof fetch,
        refreshSiteAuth,
      })({
        connectorId: "outlook",
        action: "OUTLOOK_SEND_EMAIL",
        input: { to: "example@example.com", body: "hello" },
      });
      expect(result).toMatchObject({ ok: false, status });
      expect(
        fetchImpl.mock.calls.filter(([input]) =>
          String(input).includes("/run"),
        ),
      ).toHaveLength(1);
      expect(refreshSiteAuth).not.toHaveBeenCalled();
    },
  );

  it("refreshes a known-expired JWT before the only dispatch", async () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 }),
    ).toString("base64url");
    const fetchImpl = vi.fn(async (input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer fresh-token",
      );
      if (String(input).includes("/actions")) {
        return canonicalActionResponse("OUTLOOK_QUERY_EMAILS");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const refreshSiteAuth = vi.fn(async () => ({
      baseUrl: "https://site.invalid",
      authToken: "fresh-token",
    }));
    const result = await makeBroker({
      authToken: `x.${payload}.y`,
      refreshSiteAuth,
      fetchImpl: fetchImpl as typeof fetch,
    })({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: {},
    });
    expect(result.ok).toBe(true);
    expect(refreshSiteAuth).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails before dispatch when refresh cannot restore an expired session", async () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString(
      "base64url",
    );
    const fetchImpl = vi.fn();
    const result = await makeBroker({
      authToken: `x.${payload}.y`,
      refreshSiteAuth: async () => null,
      fetchImpl: fetchImpl as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_DELETE_EMAIL", input: {} });
    expect(result).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects noncanonical connectors and cross-toolkit or arbitrary actions", async () => {
    const fetchImpl = vi.fn();
    const broker = makeBroker({ fetchImpl: fetchImpl as typeof fetch });
    await expect(
      broker({ connectorId: "outlook", action: "GMAIL_SEND_EMAIL", input: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "action_not_allowed" });
    await expect(
      broker({ connectorId: "unknown", action: "UNKNOWN_RUN", input: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "connector_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts tokens from backend errors", async () => {
    const secret = "eyJheader.eyJpayload.signature";
    const result = await makeBroker({
      fetchImpl: vi.fn(async (input) =>
        String(input).includes("/actions")
          ? canonicalActionResponse("OUTLOOK_QUERY_EMAILS")
          : new Response(JSON.stringify({ error: `Bearer ${secret}` }), {
              status: 502,
            }),
      ) as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_QUERY_EMAILS", input: {} });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      reason: "backend_error",
    });
  });

  it("redacts auth-shaped fields from successful action results", async () => {
    const result = await makeBroker({
      fetchImpl: vi.fn(async (input) =>
        String(input).includes("/actions")
          ? canonicalActionResponse("OUTLOOK_QUERY_EMAILS")
          : new Response(
              JSON.stringify({
                messages: [],
                access_token: "backend-secret",
                nested: { authorization: "Bearer backend-secret" },
              }),
              { status: 200 },
            ),
      ) as typeof fetch,
    })({ connectorId: "outlook", action: "OUTLOOK_QUERY_EMAILS", input: {} });
    expect(result).toMatchObject({
      ok: true,
      result: {
        messages: [],
        access_token: "[REDACTED]",
        nested: { authorization: "[REDACTED]" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("backend-secret");
  });
});
