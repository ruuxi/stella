import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeCachedServerCatalog } from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../../runtime/kernel/connectors/native-integrations.js";
import { startCliBridgeServer } from "../../../../../runtime/worker/cli-bridge-server.js";

const roots: string[] = [];
const bridges: Array<{ stop: () => Promise<void> }> = [];
const httpServers: Server[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const cliPath = path.join(repoRoot, "runtime/kernel/cli/stella-connect.ts");

const outlookEntry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 282,
  availability: "ready",
  provider: "backend-composio",
  description: "Outlook Store integration.",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "OUTLOOK" },
};

const makeRoot = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-auth-handoff-"));
  roots.push(root);
  await mkdir(path.join(root, "connectors"), { recursive: true });
  await writeCachedServerCatalog(root, [outlookEntry]);
  await writeFile(
    path.join(root, "connectors/native-integrations.json"),
    JSON.stringify({
      version: 1,
      integrations: { outlook: { enabled: true, updatedAt: Date.now() } },
    }),
  );
  return root;
};

const listen = async (handler: Parameters<typeof createServer>[0]) => {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
};

const runCli = async (root: string, socketPath: string) =>
  await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        cliPath,
        "call",
        "outlook",
        "OUTLOOK_QUERY_EMAILS",
        "--json",
        '{"folder":"inbox","limit":1}',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          STELLA_DATA_DIR: root,
          STELLA_CLI_BRIDGE_SOCK: socketPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(
    httpServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("stella-connect managed integration auth handoff", () => {
  it("refreshes a missing child-process session through the desktop bridge", async () => {
    const root = await makeRoot();
    const seenAuthorization: string[] = [];
    const baseUrl = await listen((request, response) => {
      if (request.url === "/api/native-integrations/run") {
        seenAuthorization.push(String(request.headers.authorization));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, messages: [] }));
        return;
      }
      response.writeHead(503).end();
    });
    const socketPath = path.join(root, "bridge.sock");
    const refreshes: boolean[] = [];
    const bridge = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        getStellaSiteAuth: async ({ refresh }) => {
          refreshes.push(refresh);
          return refresh
            ? { ok: true, baseUrl, authToken: "fresh-child-token" }
            : { ok: false, reason: "not_signed_in" };
        },
      },
    });
    bridges.push(bridge);

    const result = await runCli(root, socketPath);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, messages: [] });
    expect(refreshes).toContain(true);
    expect(seenAuthorization).toEqual(["Bearer fresh-child-token"]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "fresh-child-token",
    );
  });

  it("refreshes an expired token after 401 and retries exactly once", async () => {
    const root = await makeRoot();
    const seenAuthorization: string[] = [];
    const baseUrl = await listen((request, response) => {
      if (request.url !== "/api/native-integrations/run") {
        response.writeHead(503).end();
        return;
      }
      const authorization = String(request.headers.authorization);
      seenAuthorization.push(authorization);
      if (authorization === "Bearer expired-token") {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const socketPath = path.join(root, "bridge.sock");
    const bridge = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        getStellaSiteAuth: async ({ refresh }) =>
          refresh
            ? { ok: true, baseUrl, authToken: "refreshed-token" }
            : { ok: true, baseUrl, authToken: "expired-token" },
      },
    });
    bridges.push(bridge);

    const result = await runCli(root, socketPath);
    expect(result.exitCode).toBe(0);
    expect(seenAuthorization).toEqual([
      "Bearer expired-token",
      "Bearer refreshed-token",
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /expired-token|refreshed-token/,
    );
  });

  it("fails honestly when refresh is revoked without exposing either token", async () => {
    const root = await makeRoot();
    const baseUrl = await listen((_request, response) => {
      response.writeHead(401).end();
    });
    const socketPath = path.join(root, "bridge.sock");
    const bridge = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        getStellaSiteAuth: async ({ refresh }) =>
          refresh
            ? { ok: false, reason: "revoked" }
            : { ok: true, baseUrl, authToken: "revoked-secret-token" },
      },
    });
    bridges.push(bridge);

    const result = await runCli(root, socketPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Stella sign-in expired");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "revoked-secret-token",
    );
  });

  it("preserves the exact signed-out failure when the broker is unavailable", async () => {
    const root = await makeRoot();
    const result = await runCli(root, path.join(root, "missing.sock"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Sign in to Stella before using this integration.",
    );
  });
});
