import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startCliBridgeServer } from "../../../../runtime/worker/cli-bridge-server.js";
import { createSecureCliBridgeEndpoint } from "../../../../runtime/worker/runtime-paths.js";

const roots: string[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];
const handlers = {
  requestConnectorCredential: async () => ({
    ok: false as const,
    reason: "unused",
  }),
};

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-cli-security-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("CLI bridge transport security", () => {
  it("uses a distinct unpredictable per-session endpoint", () => {
    const root = makeRoot();
    const paths = { rootDir: root, rootHash: "0123456789abcdef" };
    const first = createSecureCliBridgeEndpoint(paths);
    const second = createSecureCliBridgeEndpoint(paths);
    expect(first).not.toBe(second);
    expect(path.basename(path.dirname(first))).toMatch(/^cli-[a-f0-9]{32}$/u);
  });

  it("advertises only after establishing 0700 directory and 0600 socket permissions", async () => {
    const root = makeRoot();
    const socketPath = path.join(root, "private", "bridge.sock");
    const server = await startCliBridgeServer({ socketPath, handlers });
    servers.push(server);
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await expect(fs.stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when socket chmod fails", async () => {
    const root = makeRoot();
    const socketPath = path.join(root, "private", "bridge.sock");
    const realChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === socketPath) throw new Error("chmod denied");
      return await realChmod(target, mode);
    });
    await expect(
      startCliBridgeServer({ socketPath, handlers }),
    ).rejects.toThrow("chmod denied");
  });

  it("rejects a symlinked socket directory without chmodding its target", async () => {
    const root = makeRoot();
    const target = path.join(root, "target");
    const directory = path.join(root, "private");
    await fs.mkdir(target, { mode: 0o755 });
    await fs.symlink(target, directory);
    await expect(
      startCliBridgeServer({
        socketPath: path.join(directory, "bridge.sock"),
        handlers,
      }),
    ).rejects.toThrow("socket directory is not private");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  });

  it.each(["file", "symlink"] as const)(
    "refuses to unlink a stale %s at the advertised path",
    async (kind) => {
      const root = makeRoot();
      const directory = path.join(root, "private");
      const socketPath = path.join(directory, "bridge.sock");
      await fs.mkdir(directory, { mode: 0o700 });
      if (kind === "file") await fs.writeFile(socketPath, "not a socket");
      else await fs.symlink(path.join(root, "target"), socketPath);
      await expect(
        startCliBridgeServer({ socketPath, handlers }),
      ).rejects.toThrow("unsafe stale socket");
      expect((await fs.lstat(socketPath)).isSocket()).toBe(false);
    },
  );

  it("refuses a stale socket path reported as owned by another uid", async () => {
    if (typeof process.getuid !== "function") return;
    const root = makeRoot();
    const directory = path.join(root, "private");
    const socketPath = path.join(directory, "bridge.sock");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(socketPath, "placeholder");
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      const stat = await realLstat(target, options as never);
      if (String(target) !== socketPath) return stat;
      return {
        ...stat,
        uid: process.getuid() + 1,
        isSymbolicLink: () => false,
        isSocket: () => true,
      } as typeof stat;
    });
    await expect(
      startCliBridgeServer({ socketPath, handlers }),
    ).rejects.toThrow("unsafe stale socket");
    expect(await fs.readFile(socketPath, "utf8")).toBe("placeholder");
  });

  it("fails closed on Windows where Node cannot establish a current-user pipe ACL", async () => {
    const pipe = createSecureCliBridgeEndpoint(
      { rootDir: "unused", rootHash: "0123456789abcdef" },
      { platform: "win32", nonce: "0123456789abcdef0123456789abcdef" },
    );
    await expect(
      startCliBridgeServer({ socketPath: pipe, handlers }),
    ).rejects.toThrow("secure current-user named-pipe ACLs are unavailable");
  });
});
