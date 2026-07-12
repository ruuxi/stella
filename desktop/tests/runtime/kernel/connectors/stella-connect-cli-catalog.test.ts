import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveNativeConnectorCatalog,
  writeCachedServerCatalog,
} from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../../runtime/kernel/connectors/native-integrations.js";
import {
  createConnectorStatusTool,
  resetConnectorStatusCatalogMemo,
} from "../../../../../runtime/kernel/tools/defs/connector-status.js";

const roots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const cliPath = path.join(repoRoot, "runtime/kernel/cli/stella-connect.ts");

const backendEntry = (
  id: string,
  name: string,
  toolkit = id.toUpperCase(),
): NativeConnectorCatalogEntry => ({
  id,
  name,
  category: "productivity",
  auth: ["OAUTH2"],
  catalogToolCount: 12,
  availability: "ready",
  provider: "backend-composio",
  description: `${name} test integration.`,
  connectable: true,
  backendConnector: { type: "composio", toolkit },
});

const makeRoot = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-cli-catalog-"));
  roots.push(root);
  await mkdir(path.join(root, "connectors"), { recursive: true });
  return root;
};

const enable = async (root: string, ids: string[]) => {
  await writeFile(
    path.join(root, "connectors/native-integrations.json"),
    JSON.stringify({
      version: 1,
      integrations: Object.fromEntries(
        ids.map((id) => [id, { enabled: true, updatedAt: Date.now() }]),
      ),
    }),
  );
};

const runCli = <T = Record<string, unknown>>(root: string, ...args: string[]) =>
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

afterEach(async () => {
  resetConnectorStatusCatalogMemo();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("stella-connect shared native catalog resolution", () => {
  it("preserves cached provider semantics for Outlook, Gmail, and a non-email connector", async () => {
    const root = await makeRoot();
    const entries = [
      backendEntry("outlook", "Outlook", "OUTLOOK"),
      backendEntry("gmail", "Gmail", "GMAIL"),
      backendEntry("notion", "Notion", "NOTION"),
    ];
    await writeCachedServerCatalog(root, entries);
    await enable(
      root,
      entries.map((entry) => entry.id),
    );

    for (const [id, tool] of [
      ["outlook", "OUTLOOK_RUN_ACTION"],
      ["gmail", "GMAIL_RUN_ACTION"],
      ["notion", "NOTION_RUN_ACTION"],
    ]) {
      const result = runCli<Array<Record<string, unknown>>>(root, "tools", id);
      expect(result).toEqual([expect.objectContaining({ name: tool })]);
      const diagnostics = runCli(root, "tools-diagnostics", id);
      expect(diagnostics).toMatchObject({
        catalogSource: "cache",
        provider: "backend-composio",
        toolCount: 1,
        executable: true,
      });
      expect(diagnostics.tools).toEqual([
        expect.objectContaining({ name: tool }),
      ]);
    }
    expect(runCli(root, "request-connection", "outlook")).toMatchObject({
      ok: true,
      status: "already_connected",
      id: "outlook",
    });
  });

  it("keeps backend-only cached ids discoverable and imported MCP discovery intact", async () => {
    const root = await makeRoot();
    const backendOnly = backendEntry(
      "acme_backend_only",
      "Acme Backend Only",
      "ACME",
    );
    await writeCachedServerCatalog(root, [backendOnly]);
    await enable(root, [backendOnly.id]);
    await writeFile(
      path.join(root, "connectors/commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "linear-mcp",
            displayName: "Linear MCP",
            description: "Issue tracking via imported MCP.",
            transport: "streamable_http",
            url: "https://example.invalid/mcp",
            auth: { type: "none" },
          },
        ],
      }),
    );

    expect(
      (
        runCli(root, "discover", "acme backend").matches as Array<
          Record<string, unknown>
        >
      ).find((entry) => entry.id === "acme_backend_only"),
    ).toEqual(
      expect.objectContaining({
        id: "acme_backend_only",
        catalogSource: "cache",
        provider: "backend-composio",
        toolCount: 1,
        executable: true,
      }),
    );
    expect(
      (
        runCli(root, "discover", "linear issues").matches as Array<
          Record<string, unknown>
        >
      ).find((entry) => entry.id === "linear-mcp"),
    ).toEqual(expect.objectContaining({ id: "linear-mcp", kind: "mcp" }));
  });

  it("uses the same cached source and provider in connector_status and the CLI", async () => {
    const root = await makeRoot();
    const outlook = backendEntry("outlook", "Outlook", "OUTLOOK");
    await writeCachedServerCatalog(root, [outlook]);
    await enable(root, [outlook.id]);

    const resolved = await resolveNativeConnectorCatalog({
      stellaDataDir: root,
    });
    expect(resolved.source).toBe("cache");
    expect(
      resolved.entries.find((entry) => entry.id === "outlook")?.provider,
    ).toBe("backend-composio");

    const status = await createConnectorStatusTool({
      stellaDataDir: root,
    }).execute(
      { connector: "outlook" },
      { conversationId: "c1", deviceId: "d1", requestId: "r1" },
    );
    const cli = runCli(root, "tools-diagnostics", "outlook");
    expect(status.details).toMatchObject({
      catalogSource: cli.catalogSource,
      provider: cli.provider,
      toolCount: cli.toolCount,
      executable: cli.executable,
      accountVerified: false,
      providerStatus: "backend_managed_unverified",
    });
  });

  it("does not report an enabled zero-tool connector as ready", async () => {
    const root = await makeRoot();
    await enable(root, ["outlook"]);
    const result = await createConnectorStatusTool({
      stellaDataDir: root,
    }).execute(
      { connector: "outlook" },
      { conversationId: "c1", deviceId: "d1", requestId: "r1" },
    );
    expect(result.details).toMatchObject({
      catalogSource: "bundled",
      provider: "oauth-catalog",
      toolCount: 0,
      executable: false,
      status: "not_executable",
    });
    expect(String(result.result)).not.toContain("Proceed");
    expect(String(result.result)).toContain("not ready");
  });

  it("keeps native and imported MCP tools output as top-level arrays", async () => {
    const root = await makeRoot();
    const outlook = backendEntry("outlook", "Outlook", "OUTLOOK");
    await writeCachedServerCatalog(root, [outlook]);
    await enable(root, [outlook.id]);
    expect(runCli(root, "tools", "outlook")).toEqual([
      expect.objectContaining({ name: "OUTLOOK_RUN_ACTION" }),
    ]);

    const serverPath = path.join(root, "mcp-server.cjs");
    await writeFile(
      serverPath,
      `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "fixture.read", description: "Read fixture", inputSchema: { type: "object" } }] }
      : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
    );
    await writeFile(
      path.join(root, "connectors/commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "fixture-mcp",
            displayName: "Fixture MCP",
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
            auth: { type: "none" },
          },
        ],
      }),
    );
    expect(runCli(root, "tools", "fixture-mcp")).toEqual([
      expect.objectContaining({ name: "fixture.read" }),
    ]);
  });
});
