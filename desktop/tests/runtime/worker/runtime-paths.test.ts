import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWindowsNamedPipePath,
  resolveRuntimePaths,
  runtimeIpcListenUrl,
  runtimeIpcPathUsesFilesystem,
} from "../../../../runtime/worker/runtime-paths.js";

describe("resolveRuntimePaths", () => {
  it("uses filesystem socket paths on POSIX platforms", () => {
    const paths = resolveRuntimePaths("/Users/test/stella", {
      platform: "darwin",
      homeDir: "/Users/test",
    });

    expect(paths.socketPath).toBe(path.join(paths.rootDir, "runtime.sock"));
    expect(paths.cliBridgeSocketPath).toBe(
      path.join(paths.rootDir, "cli-bridge.sock"),
    );
    expect(runtimeIpcPathUsesFilesystem(paths.socketPath)).toBe(true);
    expect(runtimeIpcListenUrl(paths.socketPath)).toBe(
      `unix://${paths.socketPath}`,
    );
  });

  it("uses named pipes on Windows", () => {
    const paths = resolveRuntimePaths("C:\\Users\\test\\Stella", {
      platform: "win32",
      homeDir: "C:\\Users\\test",
    });

    expect(paths.socketPath).toMatch(
      /^\\\\\.\\pipe\\stella-runtime-[a-f0-9]{16}$/,
    );
    expect(paths.cliBridgeSocketPath).toMatch(
      /^\\\\\.\\pipe\\stella-cli-bridge-[a-f0-9]{16}$/,
    );
    expect(isWindowsNamedPipePath(paths.socketPath)).toBe(true);
    expect(runtimeIpcPathUsesFilesystem(paths.socketPath)).toBe(false);
    expect(runtimeIpcListenUrl(paths.socketPath)).toBe(
      `pipe://${paths.socketPath}`,
    );
  });
});
