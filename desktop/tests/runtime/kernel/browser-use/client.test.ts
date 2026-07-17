import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_SESSION_CLIENT_METHODS,
  BrowserSession,
  BrowserSessionCommandError,
  BrowserSessionDisposedError,
  getBrowserDaemonPort,
  MAX_BROWSER_CHAIN_STEPS,
} from "../../../../../runtime/kernel/browser-use/client.js";

type RequestRecord = Record<string, unknown>;
type ResponseRecord = Record<string, unknown> | undefined;
type RequestHandler = (
  request: RequestRecord,
  context: { connection: number; socket: Socket },
) => ResponseRecord | Promise<ResponseRecord>;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createTestDaemon = (handler: RequestHandler) => {
  const tempRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const socketDir = mkdtempSync(path.join(tempRoot, "sb-"));
  const sessionId = `t-${randomUUID().slice(0, 8)}`;
  const socketPath = path.join(socketDir, `${sessionId}.sock`);
  const sockets = new Set<Socket>();
  const requests: RequestRecord[] = [];
  let connections = 0;
  let listening = false;

  const server: Server = createServer((socket) => {
    connections += 1;
    const connection = connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let work = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as RequestRecord;
        requests.push(request);
        work = work.then(async () => {
          const response = await handler(request, { connection, socket });
          if (response !== undefined && !socket.destroyed) {
            socket.write(`${JSON.stringify(response)}\n`);
          }
        });
      }
    });
  });

  const start = async () => {
    if (listening) return;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        process.platform === "win32"
          ? { host: "127.0.0.1", port: getBrowserDaemonPort(sessionId) }
          : { path: socketPath },
        () => {
          server.removeListener("error", reject);
          listening = true;
          resolve();
        },
      );
    });
  };

  const disconnect = () => {
    for (const socket of sockets) socket.destroy();
  };

  const stop = async () => {
    disconnect();
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      listening = false;
    }
  };

  const close = async () => {
    await stop();
    rmSync(socketDir, { recursive: true, force: true });
  };

  return {
    start,
    disconnect,
    stop,
    close,
    requests,
    sessionId,
    socketDir,
    get connections() {
      return connections;
    },
  };
};

const createClient = (
  daemon: ReturnType<typeof createTestDaemon>,
  overrides: Partial<ConstructorParameters<typeof BrowserSession>[0]> = {},
) =>
  new BrowserSession({
    binaryPath: "/tmp/stella-browser.js",
    sessionId: "node-repl-session-1",
    cwd: process.cwd(),
    env: { STELLA_BROWSER_SOCKET_DIR: daemon.socketDir },
    getBridgeEnv: () => ({
      STELLA_BROWSER_PROVIDER: "extension",
      STELLA_BROWSER_SESSION: daemon.sessionId,
      STELLA_BROWSER_EXT_PORT: "39040",
      STELLA_BROWSER_EXT_TOKEN: "test-token",
    }),
    runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    ...overrides,
  });

describe("BrowserSession direct daemon client", () => {
  it("reuses one socket, serializes calls, and requires exact response IDs", async () => {
    const releaseFirst = deferred();
    const sawFirst = deferred();
    const daemon = createTestDaemon(async (request) => {
      if (request.action === "url") {
        sawFirst.resolve();
        await releaseFirst.promise;
      }
      return {
        id: request.id,
        success: true,
        data: { action: request.action },
      };
    });
    await daemon.start();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const client = createClient(daemon, { runner });

    try {
      const first = client.command<{ action: string }>("url");
      const second = client.command<{ action: string }>("title");
      await sawFirst.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(daemon.requests).toHaveLength(1);

      releaseFirst.resolve();
      const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

      expect(daemon.connections).toBe(1);
      expect(runner).not.toHaveBeenCalled();
      expect(daemon.requests.map((request) => request.action)).toEqual([
        "url",
        "title",
      ]);
      expect(daemon.requests[0]?.ownerId).toBe("node-repl-session-1");
      expect(daemon.requests[0]?.ownerLeaseId).toEqual(expect.any(String));
      expect(daemon.requests[0]?.ownerLeaseIssuedAt).toEqual(expect.any(Number));
      expect(daemon.requests[1]?.ownerLeaseId).toBe(
        daemon.requests[0]?.ownerLeaseId,
      );
      expect(daemon.requests[0]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(daemon.requests[1]?.id).not.toBe(daemon.requests[0]?.id);
      expect(firstReceipt.result.id).toBe(daemon.requests[0]?.id);
      expect(secondReceipt.result.id).toBe(daemon.requests[1]?.id);
      expect(firstReceipt.result.data).toEqual({ action: "url" });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("retries a lost response with the same ID so daemon replay executes once", async () => {
    const executed = new Map<unknown, ResponseRecord>();
    let executions = 0;
    const daemon = createTestDaemon((request, { connection, socket }) => {
      let response = executed.get(request.id);
      if (!response) {
        executions += 1;
        response = {
          id: request.id,
          success: true,
          data: { recovered: true },
        };
        executed.set(request.id, response);
      }
      if (connection === 1) {
        socket.destroy();
        return undefined;
      }
      return response;
    });
    await daemon.start();
    const client = createClient(daemon);

    try {
      const receipt = await client.command<{ recovered: boolean }>("url");
      expect(receipt.attempts).toBe(2);
      expect(daemon.connections).toBe(2);
      expect(daemon.requests).toHaveLength(2);
      expect(daemon.requests[1]?.id).toBe(daemon.requests[0]?.id);
      expect(receipt.result.data?.recovered).toBe(true);
      expect(executions).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("rejects missing or mismatched response IDs after one retry", async () => {
    const daemon = createTestDaemon((_request, { connection }) =>
      connection === 1
        ? { success: true, data: {} }
        : { id: "wrong-id", success: true, data: {} },
    );
    await daemon.start();
    const client = createClient(daemon);

    try {
      await expect(client.command("url")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("response ID did not match"),
      });
      expect(daemon.requests).toHaveLength(2);
      expect(daemon.requests[1]?.id).toBe(daemon.requests[0]?.id);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("aborts an in-flight request, closes that socket, and reconnects later", async () => {
    const sawWait = deferred();
    const daemon = createTestDaemon((request) => {
      if (request.action === "wait") {
        sawWait.resolve();
        return undefined;
      }
      return { id: request.id, success: true, data: { recovered: true } };
    });
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 2_000 });
    const controller = new AbortController();
    const reason = new Error("stop browser command");

    try {
      const pending = client.command("wait", {}, { signal: controller.signal });
      await sawWait.promise;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);

      await expect(client.command("url")).resolves.toMatchObject({
        result: { success: true },
      });
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("enforces response-frame and command time limits", async () => {
    const daemon = createTestDaemon((request, { socket }) => {
      if (request.action === "content") {
        socket.write(`{"success":true,"data":"${"x".repeat(2_048)}`);
      }
      return undefined;
    });
    await daemon.start();
    const limitedClient = createClient(daemon, {
      commandTimeoutMs: 1_000,
      maxOutputBytes: 512,
    });

    try {
      await expect(limitedClient.command("content")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("512-byte limit"),
      });
    } finally {
      await limitedClient.dispose();
      await daemon.close();
    }

    const timeoutDaemon = createTestDaemon(() => undefined);
    await timeoutDaemon.start();
    const timeoutClient = createClient(timeoutDaemon, { commandTimeoutMs: 40 });
    try {
      await expect(timeoutClient.command("url")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("timed out after 40ms"),
      });
    } finally {
      await timeoutClient.dispose();
      await timeoutDaemon.close();
    }
  });

  it("encodes chain as one raw protocol request and validates it before I/O", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {
        results: [],
        completed: 2,
        total: 2,
        totalDurationMs: 3,
        receivedAction: request.action,
      },
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      const receipt = await client.chain(
        [
          { action: "navigate", params: { url: "https://example.com" } },
          { action: "click", params: { selector: "@e1" } },
        ],
        {
          abortOnError: false,
          delay: { minMs: 10, maxMs: 20 },
          waitForSelector: true,
          waitTimeoutMs: 500,
          returnSnapshot: true,
        },
      );

      expect(receipt.action).toBe("chain");
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]).toMatchObject({
        action: "chain",
        ownerId: "node-repl-session-1",
        abortOnError: false,
        delay: { min: 10, max: 20 },
        waitForSelector: true,
        waitTimeout: 500,
        returnSnapshot: true,
        steps: [
          { action: "navigate", url: "https://example.com" },
          { action: "click", selector: "@e1" },
        ],
      });

      await expect(
        client.chain(
          Array.from({ length: MAX_BROWSER_CHAIN_STEPS + 1 }, () => ({
            action: "url" as const,
          })),
        ),
      ).rejects.toThrow("at most 100");
      await expect(
        client.chain([{ action: "chain" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.chain([{ action: "finalize_tabs" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.chain([{ action: "close_owner" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.command("url", { ownerId: "other" } as never),
      ).rejects.toThrow("managed by BrowserSession");
      await expect(client.command("close" as never)).rejects.toThrow(
        "not an allowed browser protocol action",
      );
      expect(daemon.requests).toHaveLength(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("extends chain deadlines from validated step, wait, and delay budgets", async () => {
    const daemon = createTestDaemon(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return {
        id: request.id,
        success: true,
        data: {
          results: [],
          completed: 1,
          total: 1,
          totalDurationMs: 75,
        },
      };
    });
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 30 });

    try {
      await expect(
        client.chain([{ action: "click", params: { selector: "#save" } }], {
          waitTimeoutMs: 100,
          delay: { minMs: 20, maxMs: 40 },
        }),
      ).resolves.toMatchObject({ result: { success: true }, attempts: 1 });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("allows owner lifecycle actions only through the top-level command surface", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      await client.command("finalize_tabs", { keep: [] });
      await client.command("close_owner");

      expect(BROWSER_SESSION_CLIENT_METHODS).toEqual([
        "command",
        "chain",
        "dispose",
      ]);
      expect(daemon.requests.map((request) => request.action)).toEqual([
        "finalize_tabs",
        "close_owner",
      ]);
      expect(
        daemon.requests.every(
          (request) => request.ownerId === "node-repl-session-1",
        ),
      ).toBe(true);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("bootstraps the service once when the shared endpoint is unavailable", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [] },
    }));
    const runner = vi.fn(async () => {
      await daemon.start();
      return { exitCode: 0, stdout: '{"success":true}\n', stderr: "" };
    });
    const client = createClient(daemon, { runner });

    try {
      await expect(client.command("tab_list")).resolves.toMatchObject({
        result: { success: true },
      });
      await expect(client.command("tab_list")).resolves.toMatchObject({
        result: { success: true },
      });

      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            "/tmp/stella-browser.js",
            "service",
            "ensure",
            "--session",
            daemon.sessionId,
            "--json",
          ],
          env: expect.objectContaining({
            STELLA_BROWSER_PROVIDER: "extension",
            STELLA_BROWSER_SESSION: daemon.sessionId,
            STELLA_BROWSER_OWNER_ID: "node-repl-session-1",
            ELECTRON_RUN_AS_NODE: "1",
          }),
        }),
      );
      expect(daemon.connections).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("restores startup fallback eligibility after each successful connection", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [] },
    }));
    const runner = vi.fn(async () => {
      await daemon.start();
      return { exitCode: 0, stdout: '{"success":true}\n', stderr: "" };
    });
    const client = createClient(daemon, { runner });

    try {
      await client.command("tab_list");
      await daemon.stop();
      await new Promise((resolve) => setImmediate(resolve));
      await client.command("tab_list");

      expect(runner).toHaveBeenCalledTimes(2);
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("disposal closes only the client socket and rejects later work", async () => {
    const socketClosed = deferred();
    const daemon = createTestDaemon((request, { socket }) => {
      socket.once("close", () => socketClosed.resolve());
      return { id: request.id, success: true, data: {} };
    });
    await daemon.start();
    const client = createClient(daemon);

    try {
      await client.command("url");
      await client.dispose();
      await socketClosed.promise;

      expect(daemon.requests.map((request) => request.action)).toEqual(["url"]);
      expect(client.isDisposed).toBe(true);
      await expect(client.command("title")).rejects.toBeInstanceOf(
        BrowserSessionDisposedError,
      );
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("stamps commands with the configured kernel lease and never cleans tabs on dispose", async () => {
    const socketClosed = deferred();
    const daemon = createTestDaemon((request, { socket }) => {
      socket.once("close", () => socketClosed.resolve());
      return { id: request.id, success: true, data: {} };
    });
    await daemon.start();
    const client = createClient(daemon, {
      ownerLeaseId: "kernel-lease-2",
      ownerLeaseIssuedAt: 2_000,
    });

    try {
      await client.command("url");
      await client.dispose();
      await socketClosed.promise;

      expect(daemon.requests).toEqual([
        expect.objectContaining({
          action: "url",
          ownerId: "node-repl-session-1",
          ownerLeaseId: "kernel-lease-2",
          ownerLeaseIssuedAt: 2_000,
        }),
      ]);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("preserves structured daemon failures on command errors", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: false,
      error: "No active tab for this owner",
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      const error = await client
        .command("url")
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BrowserSessionCommandError);
      expect(error).toMatchObject({
        code: "command_failed",
        message: "No active tab for this owner",
        receipt: {
          result: {
            success: false,
            error: "No active tab for this owner",
          },
        },
      });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });
});
