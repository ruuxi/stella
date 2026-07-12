import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeCachedServerCatalog } from "../../../../../runtime/kernel/connectors/catalog-cache.js";
import type { NativeConnectorCatalogEntry } from "../../../../../runtime/kernel/connectors/native-integrations.js";
import { startCliBridgeServer } from "../../../../../runtime/worker/cli-bridge-server.js";

const roots: string[] = [];
const bridges: Array<{ stop: () => Promise<void> }> = [];
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

const rawRequest = async (
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
) =>
  await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ id: 1, method, params })}\n`),
    );
    socket.on("data", (chunk) => (output += chunk));
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
  });

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("stella-connect managed integration action broker", () => {
  it("hands an isolated child action to the broker without handing it auth", async () => {
    const root = await makeRoot();
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, messages: [] },
    }));
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        runBackendConnectorAction,
      },
    });
    bridges.push(bridge);

    const result = await runCli(root, bridge.socketPath);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, messages: [] });
    expect(runBackendConnectorAction).toHaveBeenCalledOnce();
    expect(runBackendConnectorAction.mock.calls[0]?.[0]).toMatchObject({
      connectorId: "outlook",
      action: "OUTLOOK_QUERY_EMAILS",
      input: { folder: "inbox", limit: 1 },
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      /authorization|bearer|token/iu,
    );
  });

  it("lets the trusted broker resolve live Composio when the child cache is cold", async () => {
    const root = await makeRoot();
    await unlink(path.join(root, "connectors/catalog-cache.json"));
    const runBackendConnectorAction = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, messages: [] },
    }));
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        runBackendConnectorAction,
      },
    });
    bridges.push(bridge);
    const result = await runCli(root, bridge.socketPath);
    expect(result.exitCode).toBe(0);
    expect(runBackendConnectorAction).toHaveBeenCalledOnce();
  });

  it("does not expose the removed raw site-auth method", async () => {
    const root = await makeRoot();
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
      },
    });
    bridges.push(bridge);
    const response = await rawRequest(bridge.socketPath, "stella.getSiteAuth");
    expect(response).toContain("unknown method");
    expect(response).not.toMatch(/authToken|Bearer/iu);
  });

  it("rejects arbitrary URL, method, and header proxy fields", async () => {
    const root = await makeRoot();
    const runBackendConnectorAction = vi.fn();
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        runBackendConnectorAction,
      },
    });
    bridges.push(bridge);
    const response = await rawRequest(
      bridge.socketPath,
      "connector.runBackendAction",
      {
        connectorId: "outlook",
        action: "OUTLOOK_QUERY_EMAILS",
        input: {},
        url: "https://attacker.invalid",
        method: "DELETE",
        headers: { authorization: "attacker" },
      },
    );
    expect(response).toContain("arbitrary transport fields are not allowed");
    expect(runBackendConnectorAction).not.toHaveBeenCalled();
  });

  it("preserves the signed-out failure without exposing broker details", async () => {
    const root = await makeRoot();
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        runBackendConnectorAction: async () => ({
          ok: false,
          reason: "not_signed_in",
          message: "Sign in to Stella before using this integration.",
        }),
      },
    });
    bridges.push(bridge);
    const result = await runCli(root, bridge.socketPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Sign in to Stella before using this integration.",
    );
  });

  it("preserves sanitized backend status and request id for diagnosis", async () => {
    const root = await makeRoot();
    const bridge = await startCliBridgeServer({
      socketPath: path.join(root, "bridge.sock"),
      handlers: {
        requestConnectorCredential: async () => ({
          ok: false,
          reason: "unused",
        }),
        runBackendConnectorAction: async () => ({
          ok: false,
          reason: "backend_error",
          status: 502,
          requestId: "req-safe-123",
          message: "Connector provider failed.",
        }),
      },
    });
    bridges.push(bridge);
    const result = await runCli(root, bridge.socketPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Connector provider failed. (status 502, request req-safe-123)",
    );
  });

  it("fails honestly when the broker is unavailable", async () => {
    const root = await makeRoot();
    const result = await runCli(root, path.join(root, "missing.sock"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      "The Stella connector broker is unavailable.",
    );
  });
});
