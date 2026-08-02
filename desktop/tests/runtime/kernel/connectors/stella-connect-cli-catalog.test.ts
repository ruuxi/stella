import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeCachedServerCatalog } from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../../runtime/kernel/connectors/native-integrations.js";
import { startCliBridgeServer } from "../../../../../runtime/worker/cli-bridge-server.js";

const roots: string[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const cliPath = path.join(repoRoot, "runtime/kernel/cli/stella-connect.ts");
const entry: NativeConnectorCatalogEntry = {
  id: "outlook",
  name: "Outlook",
  category: "email",
  auth: ["OAUTH2"],
  catalogToolCount: 12,
  availability: "ready",
  provider: "backend-composio",
  description: "Outlook test integration.",
  connectable: true,
  backendConnector: { type: "composio", toolkit: "OUTLOOK" },
};

const makeRoot = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-cli-catalog-"));
  roots.push(root);
  await mkdir(path.join(root, "connectors"), { recursive: true });
  return root;
};

const enable = async (root: string) => {
  await writeFile(
    path.join(root, "connectors/native-integrations.json"),
    JSON.stringify({
      version: 1,
      integrations: { outlook: { enabled: true, updatedAt: Date.now() } },
    }),
  );
};

const runCli = <T>(root: string, ...args: string[]): T =>
  JSON.parse(
    execFileSync("bun", [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STELLA_DATA_DIR: root,
        STELLA_CLI_BRIDGE_SOCK: "",
      },
      encoding: "utf8",
    }),
  ) as T;

const runCliAsync = async (
  root: string,
  socketPath: string,
  ...args: string[]
) =>
  new Promise<{ exitCode: number | null; stdout: Record<string, unknown> }>(
    (resolve, reject) => {
      const child = spawn("bun", [cliPath, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          STELLA_DATA_DIR: root,
          STELLA_CLI_BRIDGE_SOCK: socketPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (exitCode) =>
        resolve({ exitCode, stdout: JSON.parse(stdout) }),
      );
    },
  );

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("stella-connect Composio-only CLI", () => {
  it("reads cached backend entries and fetches actions through the bridge", async () => {
    const root = await makeRoot();
    await writeCachedServerCatalog(root, [entry]);
    await enable(root);
    const socketPath = path.join(root, "private", "bridge.sock");
    const server = await startCliBridgeServer({
      socketPath,
      handlers: {
        listBackendConnectorActions: async ({ connectorId, query }) => ({
          ok: true,
          id: connectorId,
          actionCount: 12,
          actions: [
            {
              name: "OUTLOOK_QUERY_EMAILS",
              description: query ? `Matched ${query}` : "Query email",
              inputSchema: { type: "object", additionalProperties: true },
            },
          ],
          nextCursor: null,
        }),
      },
    });
    servers.push(server);
    await expect(
      runCliAsync(root, socketPath, "tools", "outlook", "email search"),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: {
        ok: true,
        id: "outlook",
        actions: [
          expect.objectContaining({
            name: "OUTLOOK_QUERY_EMAILS",
            description: "Matched email search",
          }),
        ],
      },
    });
    await expect(
      runCliAsync(root, socketPath, "tools-diagnostics", "outlook"),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: {
        catalogSource: "cache",
        provider: "backend-composio",
        providerStatus: "unverified",
        accountVerified: false,
        executable: false,
        actionPage: { ok: true, id: "outlook" },
      },
    });
  });

  it("does not discover legacy command-state entries", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "connectors/commands.json"),
      JSON.stringify({
        commands: [{ id: "linear-mcp", displayName: "Linear" }],
      }),
    );
    expect(runCli<Record<string, unknown>>(root, "discover", "linear")).toEqual(
      {
        query: "linear",
        matches: [],
      },
    );
  });

  it("routes explicit connection requests only through the inline card bridge", async () => {
    const root = await makeRoot();
    await writeCachedServerCatalog(root, [entry]);
    const socketPath = path.join(root, "private", "bridge.sock");
    const server = await startCliBridgeServer({
      socketPath,
      handlers: {
        requestConnectorConnection: async ({ id }) => ({
          ok: true,
          status: id === "outlook" ? "connected" : "already_connected",
        }),
      },
    });
    servers.push(server);
    await expect(
      runCliAsync(root, socketPath, "request-connection", "outlook"),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: { ok: true, status: "connected", id: "outlook" },
    });
  });

  it("removes import and refresh commands from help", async () => {
    const root = await makeRoot();
    const help = execFileSync("bun", [cliPath, "help"], {
      cwd: repoRoot,
      env: { ...process.env, STELLA_DATA_DIR: root },
      encoding: "utf8",
    });
    expect(help).not.toContain("import-mcp");
    expect(help).not.toContain("refresh-skill");
    expect(help).not.toContain("enable-native");
    expect(help).toContain("inline chat card");
  });
});
