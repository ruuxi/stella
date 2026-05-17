import http from "node:http";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  connectConnectorOAuth,
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
  saveConnectorAccessToken,
} from "../../../../../runtime/kernel/connectors/oauth.js";

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const roots: string[] = [];
const originalDevStorage = process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;

beforeEach(() => {
  process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = "1";
});

afterEach(async () => {
  if (originalDevStorage === undefined) {
    delete process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;
  } else {
    process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = originalDevStorage;
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
  it("stores manually supplied connector tokens through protected storage", async () => {
    const root = createRoot();

    await saveConnectorAccessToken(root, "demo", "plain-secret-token");

    const raw = await readFile(
      path.join(root, "state", "connectors", ".credentials.json"),
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
});
