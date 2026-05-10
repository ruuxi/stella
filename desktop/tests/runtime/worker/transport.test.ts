import path from "node:path";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseWorkerArgs,
  parseWorkerListenUrl,
  startWorkerTransport,
} from "../../../../runtime/worker/transport.js";
import { WorkerPeerBroker } from "../../../../runtime/worker/peer-broker.js";

describe("parseWorkerListenUrl", () => {
  it("defaults to stdio when no URL is provided", () => {
    const result = parseWorkerListenUrl("");
    expect(result.ok).toBe(true);
    expect(result.ok && result.transport.kind).toBe("stdio");
  });

  it("parses stdio:// explicitly", () => {
    const result = parseWorkerListenUrl("stdio://");
    expect(result.ok).toBe(true);
    expect(result.ok && result.transport.kind).toBe("stdio");
  });

  it("parses unix:// with absolute path", () => {
    const result = parseWorkerListenUrl("unix:///tmp/runtime.sock");
    expect(result.ok).toBe(true);
    if (result.ok && result.transport.kind === "unix") {
      expect(result.transport.socketPath).toBe("/tmp/runtime.sock");
    } else {
      throw new Error("expected unix transport");
    }
  });

  it("resolves relative unix:// paths against cwd", () => {
    const result = parseWorkerListenUrl("unix://relative/runtime.sock");
    expect(result.ok).toBe(true);
    if (result.ok && result.transport.kind === "unix") {
      expect(path.isAbsolute(result.transport.socketPath)).toBe(true);
      expect(result.transport.socketPath.endsWith("relative/runtime.sock")).toBe(
        true,
      );
    }
  });

  it("rejects unix:// with no path", () => {
    const result = parseWorkerListenUrl("unix://");
    expect(result.ok).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    const result = parseWorkerListenUrl("ws://127.0.0.1:8080");
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/Unsupported/);
  });
});

describe("parseWorkerArgs", () => {
  it("returns the default listen URL when no flag is present", () => {
    expect(parseWorkerArgs([])).toEqual({ listenUrl: "stdio://" });
  });

  it("parses --listen URL form", () => {
    expect(parseWorkerArgs(["--listen", "unix:///tmp/foo.sock"])).toEqual({
      listenUrl: "unix:///tmp/foo.sock",
    });
  });

  it("parses --listen=URL form", () => {
    expect(parseWorkerArgs(["--listen=unix:///tmp/bar.sock"])).toEqual({
      listenUrl: "unix:///tmp/bar.sock",
    });
  });

  it("ignores unrelated args", () => {
    expect(
      parseWorkerArgs(["--debug", "--listen", "stdio://", "--other"]),
    ).toEqual({ listenUrl: "stdio://" });
  });
});

describe("startWorkerTransport", () => {
  it("does not unlink a live unix socket", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "stella-transport-"));
    const socketPath = path.join(tempDir, "runtime.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    try {
      await expect(
        startWorkerTransport({
          transport: { kind: "unix", socketPath },
          broker: new WorkerPeerBroker(),
        }),
      ).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
