import http from "node:http";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginConnectorDeviceOAuth,
  completeConnectorDeviceOAuth,
  connectConnectorOAuth,
  connectPreregisteredConnectorOAuth,
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
  loadConnectorTokenPayload,
  saveConnectorAccessToken,
  setConnectorTokenStoreBroker,
} from "../../../../../runtime/kernel/connectors/oauth.js";

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const roots: string[] = [];
const originalDevStorage = process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;
const originalStellaProxyToken = process.env.STELLA_LLM_PROXY_TOKEN;

beforeEach(() => {
  process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = "1";
});

afterEach(async () => {
  setConnectorTokenStoreBroker(null);
  if (originalDevStorage === undefined) {
    delete process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;
  } else {
    process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = originalDevStorage;
  }
  if (originalStellaProxyToken === undefined) {
    delete process.env.STELLA_LLM_PROXY_TOKEN;
  } else {
    process.env.STELLA_LLM_PROXY_TOKEN = originalStellaProxyToken;
  }
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connector-oauth-"));
  roots.push(root);
  return root;
};

const parseFormBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
};

const startServer = async (
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    baseUrl: string,
  ) => void,
): Promise<TestServer> => {
  let baseUrl = "";
  const server = http.createServer((req, res) => handler(req, res, baseUrl));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

describe("connector OAuth credentials", () => {
  it("routes token persistence through an in-memory broker when configured", async () => {
    const root = createRoot();
    const payloads = new Map<string, { accessToken: string }>();
    const operations: string[] = [];
    setConnectorTokenStoreBroker({
      load: async (tokenKey) => {
        operations.push(`load:${tokenKey}`);
        return payloads.get(tokenKey) ?? null;
      },
      save: async (tokenKey, payload) => {
        operations.push(`save:${tokenKey}`);
        payloads.set(tokenKey, payload);
      },
      delete: async (tokenKeys) => {
        operations.push(`delete:${tokenKeys.join(",")}`);
        tokenKeys.forEach((tokenKey) => payloads.delete(tokenKey));
      },
    });

    await saveConnectorAccessToken(root, "outlook", "access-from-host");
    await expect(loadConnectorAccessToken(root, "outlook")).resolves.toBe(
      "access-from-host",
    );
    await deleteConnectorAccessTokens(root, ["outlook"]);
    await expect(loadConnectorAccessToken(root, "outlook")).resolves.toBeNull();
    await expect(
      readFile(path.join(root, "connectors", ".credentials.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(operations).toEqual([
      "save:outlook",
      "load:outlook",
      "delete:outlook",
      "load:outlook",
    ]);
  });

  it("stores manually supplied connector tokens through protected storage", async () => {
    const root = createRoot();

    await saveConnectorAccessToken(root, "demo", "plain-secret-token");

    const raw = await readFile(
      path.join(root, "connectors", ".credentials.json"),
      "utf-8",
    );
    expect(raw).not.toContain("plain-secret-token");
    await expect(loadConnectorAccessToken(root, "demo")).resolves.toBe(
      "plain-secret-token",
    );
  });

  it("deletes protected connector tokens by token key", async () => {
    const root = createRoot();

    await saveConnectorAccessToken(root, "demo", "plain-secret-token");
    await deleteConnectorAccessTokens(root, ["demo"]);

    await expect(loadConnectorAccessToken(root, "demo")).resolves.toBeNull();
  });

  it("refreshes expired OAuth connector tokens and persists the refreshed token", async () => {
    const root = createRoot();
    let sawRefresh = false;
    const server = await startServer(async (req, res, baseUrl) => {
      if (req.method === "POST" && req.url === "/mcp") {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-protected-resource/mcp"
      ) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            authorization_servers: [baseUrl],
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-authorization-server"
      ) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/register") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            client_id: "client-1",
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        const body = await parseFormBody(req);
        if (body.get("grant_type") === "refresh_token") {
          sawRefresh = true;
          expect(body.get("refresh_token")).toBe("refresh-1");
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: "access-2",
              refresh_token: "refresh-2",
              expires_in: 3600,
            }),
          );
          return;
        }
        expect(body.get("grant_type")).toBe("authorization_code");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: -1,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectConnectorOAuth(root, {
        tokenKey: "demo",
        resourceUrl: `${server.baseUrl}/mcp`,
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("code", "code-1");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      await expect(loadConnectorAccessToken(root, "demo")).resolves.toBe(
        "access-2",
      );
      expect(sawRefresh).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("retries without discovered scopes when the OAuth provider rejects them", async () => {
    const root = createRoot();
    const openedScopes: Array<string | null> = [];
    const server = await startServer(async (req, res, baseUrl) => {
      if (req.method === "POST" && req.url === "/mcp") {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-protected-resource/mcp"
      ) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            authorization_servers: [baseUrl],
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-authorization-server"
      ) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            scopes_supported: ["bad-scope"],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/register") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            client_id: "client-1",
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "access-final",
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectConnectorOAuth(root, {
        tokenKey: "demo",
        resourceUrl: `${server.baseUrl}/mcp`,
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          openedScopes.push(authorizationUrl.searchParams.get("scope"));
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          if (openedScopes.length === 1) {
            redirectUri.searchParams.set("error", "invalid_scope");
            redirectUri.searchParams.set("error_description", "scope rejected");
          } else {
            redirectUri.searchParams.set("code", "code-2");
          }
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      expect(openedScopes).toEqual(["bad-scope", null]);
      await expect(loadConnectorAccessToken(root, "demo")).resolves.toBe(
        "access-final",
      );
    } finally {
      await server.close();
    }
  });

  it("stores tokens from OAuth device flow polling", async () => {
    const root = createRoot();
    let pollCount = 0;
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/device") {
        const body = await parseFormBody(req);
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("scope")).toBe("repo read:user");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            device_code: "device-1",
            user_code: "ABCD-1234",
            verification_uri: "https://example.test/device",
            expires_in: 60,
            interval: 0,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/token") {
        pollCount += 1;
        const body = await parseFormBody(req);
        expect(body.get("grant_type")).toBe(
          "urn:ietf:params:oauth:grant-type:device_code",
        );
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("device_code")).toBe("device-1");
        if (pollCount === 1) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              error: "authorization_pending",
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "device-access",
            refresh_token: "device-refresh",
            expires_in: 3600,
            scope: "repo read:user",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const authorization = await beginConnectorDeviceOAuth({
        clientId: "client-1",
        deviceAuthorizationEndpoint: `${server.baseUrl}/device`,
        scopes: ["repo", "read:user"],
      });
      expect(authorization.user_code).toBe("ABCD-1234");

      await completeConnectorDeviceOAuth(root, {
        tokenKey: "device-demo",
        clientId: "client-1",
        tokenEndpoint: `${server.baseUrl}/token`,
        authorization,
        scopes: ["repo", "read:user"],
      });

      expect(pollCount).toBe(2);
      await expect(loadConnectorAccessToken(root, "device-demo")).resolves.toBe(
        "device-access",
      );
    } finally {
      await server.close();
    }
  });

  it("supports preregistered PKCE providers with custom scope separators", async () => {
    const root = createRoot();
    const openedScopes: string[] = [];
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/token") {
        const body = await parseFormBody(req);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("code_verifier")).toBeTruthy();
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "pkce-access",
            refresh_token: "pkce-refresh",
            expires_in: 3600,
            scope: "read write",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "pkce-demo",
        clientId: "client-1",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/token`,
        scopes: ["read", "write"],
        scopeSeparator: ",",
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          openedScopes.push(authorizationUrl.searchParams.get("scope") ?? "");
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("code", "code-1");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      expect(openedScopes).toEqual(["read,write"]);
      await expect(loadConnectorAccessToken(root, "pkce-demo")).resolves.toBe(
        "pkce-access",
      );
    } finally {
      await server.close();
    }
  });

  it("supports installed-app OAuth providers without PKCE using HTTP Basic token auth", async () => {
    const root = createRoot();
    const openedAuthorizationUrls: URL[] = [];
    const expectedBasic = `Basic ${Buffer.from("reddit-client:").toString("base64")}`;
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/token") {
        expect(req.headers.authorization).toBe(expectedBasic);
        const body = await parseFormBody(req);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBeNull();
        expect(body.get("code_verifier")).toBeNull();
        expect(body.get("code")).toBe("reddit-code");
        expect(body.get("redirect_uri")).toContain("/callback/reddit");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "reddit-access",
            refresh_token: "reddit-refresh",
            expires_in: 3600,
            scope: "identity read submit edit",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "reddit-demo",
        clientId: "reddit-client",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/token`,
        scopes: ["identity", "read", "submit", "edit"],
        callbackId: "reddit",
        usesPkce: false,
        authorizationParams: { duration: "permanent" },
        tokenAuth: "basic",
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          openedAuthorizationUrls.push(authorizationUrl);
          expect(authorizationUrl.searchParams.get("duration")).toBe(
            "permanent",
          );
          expect(
            authorizationUrl.searchParams.get("code_challenge"),
          ).toBeNull();
          expect(
            authorizationUrl.searchParams.get("code_challenge_method"),
          ).toBeNull();
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("code", "reddit-code");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      expect(openedAuthorizationUrls).toHaveLength(1);
      await expect(loadConnectorAccessToken(root, "reddit-demo")).resolves.toBe(
        "reddit-access",
      );
    } finally {
      await server.close();
    }
  });

  it("supports preregistered implicit OAuth providers without token exchange", async () => {
    const root = createRoot();
    let tokenEndpointCalls = 0;
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/token") {
        tokenEndpointCalls += 1;
        res.writeHead(500).end();
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "implicit-demo",
        clientId: "implicit-client",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        responseType: "token",
        scopes: ["read", "write"],
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          expect(authorizationUrl.searchParams.get("response_type")).toBe(
            "token",
          );
          expect(
            authorizationUrl.searchParams.get("code_challenge"),
          ).toBeNull();
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("access_token", "implicit-access");
          redirectUri.searchParams.set("expires_in", "3600");
          redirectUri.searchParams.set("scope", "read write");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      expect(tokenEndpointCalls).toBe(0);
      await expect(
        loadConnectorAccessToken(root, "implicit-demo"),
      ).resolves.toBe("implicit-access");
    } finally {
      await server.close();
    }
  });

  it("supports backend-proxied preregistered OAuth token exchange", async () => {
    const root = createRoot();
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/backend-token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        expect(body.provider).toBe("todoist");
        expect(body.client_id).toBe("client-1");
        if (body.grant_type === "refresh_token") {
          expect(req.headers.authorization).toBe("Bearer runtime-token");
          expect(body.refresh_token).toBe("backend-refresh");
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: "backend-refreshed-access",
              refresh_token: "backend-refresh-2",
              expires_in: 3600,
              scope: "task:add data:read",
            }),
          );
          return;
        }
        expect(req.headers.authorization).toBe("Bearer convex-token");
        expect(body.code).toBe("code-1");
        expect(body.redirect_uri).toContain("/callback/todoist");
        expect(body.code_verifier).toBeTruthy();
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "backend-access",
            refresh_token: "backend-refresh",
            expires_in: -1,
            scope: "task:add data:read",
            instance_url: `${server.baseUrl}/tenant-api`,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "backend-demo",
        clientId: "client-1",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/provider-token`,
        scopes: ["task:add", "data:read"],
        callbackId: "todoist",
        tokenExchange: {
          type: "backend",
          endpoint: `${server.baseUrl}/backend-token`,
          provider: "todoist",
          authToken: "convex-token",
        },
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("code", "code-1");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      process.env.STELLA_LLM_PROXY_TOKEN = "runtime-token";
      await expect(
        loadConnectorAccessToken(root, "backend-demo"),
      ).resolves.toBe("backend-refreshed-access");
      await expect(
        loadConnectorTokenPayload(root, "backend-demo"),
      ).resolves.toMatchObject({
        refreshToken: "backend-refresh-2",
        resourceUrl: `${server.baseUrl}/tenant-api`,
      });
      const raw = await readFile(
        path.join(root, "connectors", ".credentials.json"),
        "utf-8",
      );
      expect(raw).not.toContain("backend-access");
      expect(raw).not.toContain("backend-refreshed-access");
      expect(raw).not.toContain("provider-token");
    } finally {
      await server.close();
    }
  });

  it("supports preregistered OAuth through an external HTTPS callback bridge", async () => {
    const root = createRoot();
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/backend-token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        expect(body.provider).toBe("notion");
        expect(body.client_id).toBe("notion-client");
        expect(body.code).toBe("notion-code");
        expect(body.redirect_uri).toBe(
          "https://stella.sh/oauth/notion/callback",
        );
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "notion-access",
            refresh_token: "notion-refresh",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "notion-demo",
        clientId: "notion-client",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/provider-token`,
        callbackId: "notion",
        callbackUrl: "https://stella.sh/oauth/notion/callback",
        tokenExchange: {
          type: "backend",
          endpoint: `${server.baseUrl}/backend-token`,
          provider: "notion",
          authToken: "convex-token",
        },
        callbackWaiter: async ({ state, redirectUri }) => ({
          waitForCode: Promise.resolve(
            state && redirectUri === "https://stella.sh/oauth/notion/callback"
              ? "notion-code"
              : "",
          ),
        }),
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
            "https://stella.sh/oauth/notion/callback",
          );
          expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
        },
      });

      await expect(loadConnectorAccessToken(root, "notion-demo")).resolves.toBe(
        "notion-access",
      );
    } finally {
      await server.close();
    }
  });

  it("supports Figma-style backend exchange with comma-separated scopes", async () => {
    const root = createRoot();
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/backend-token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        expect(req.headers.authorization).toBe("Bearer convex-token");
        expect(body.provider).toBe("figma");
        expect(body.client_id).toBe("figma-client");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "figma-access",
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "figma-demo",
        clientId: "figma-client",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/provider-token`,
        scopes: ["current_user:read", "file_content:read"],
        scopeSeparator: ",",
        callbackId: "figma",
        tokenExchange: {
          type: "backend",
          endpoint: `${server.baseUrl}/backend-token`,
          provider: "figma",
          authToken: "convex-token",
        },
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          expect(authorizationUrl.searchParams.get("scope")).toBe(
            "current_user:read,file_content:read",
          );
          const redirectUri = new URL(
            authorizationUrl.searchParams.get("redirect_uri")!,
          );
          redirectUri.searchParams.set("code", "figma-code");
          redirectUri.searchParams.set(
            "state",
            authorizationUrl.searchParams.get("state")!,
          );
          await fetch(redirectUri);
        },
      });

      await expect(loadConnectorAccessToken(root, "figma-demo")).resolves.toBe(
        "figma-access",
      );
    } finally {
      await server.close();
    }
  });

  it("supports Miro-style hosted callback backend exchange with space-separated scopes", async () => {
    const root = createRoot();
    const server = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/backend-token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as Record<string, unknown>;
        expect(body.provider).toBe("miro");
        expect(body.client_id).toBe("miro-client");
        expect(body.redirect_uri).toBe("https://stella.sh/oauth/miro/callback");
        expect(body.code_verifier).toBeTruthy();
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: "miro-access",
            refresh_token: "miro-refresh",
            expires_in: 3600,
            scope: "boards:read boards:write identity:read team:read",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await connectPreregisteredConnectorOAuth(root, {
        tokenKey: "miro-demo",
        clientId: "miro-client",
        authorizationEndpoint: `${server.baseUrl}/authorize`,
        tokenEndpoint: `${server.baseUrl}/provider-token`,
        scopes: ["boards:read", "boards:write", "identity:read", "team:read"],
        callbackId: "miro",
        callbackUrl: "https://stella.sh/oauth/miro/callback",
        tokenExchange: {
          type: "backend",
          endpoint: `${server.baseUrl}/backend-token`,
          provider: "miro",
          authToken: "convex-token",
        },
        callbackWaiter: async () => ({
          waitForCode: Promise.resolve("miro-code"),
        }),
        openUrl: async (url) => {
          const authorizationUrl = new URL(url);
          expect(authorizationUrl.searchParams.get("scope")).toBe(
            "boards:read boards:write identity:read team:read",
          );
          expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
            "https://stella.sh/oauth/miro/callback",
          );
        },
      });

      await expect(loadConnectorAccessToken(root, "miro-demo")).resolves.toBe(
        "miro-access",
      );
    } finally {
      await server.close();
    }
  });
});
