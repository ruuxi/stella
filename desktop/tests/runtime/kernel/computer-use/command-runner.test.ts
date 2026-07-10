import { describe, expect, it, vi } from "vitest";

import {
  createInProcessComputerCommandRunner,
  runComputerCommandSubprocess,
} from "../../../../../runtime/kernel/computer-use/command-runner.js";

describe("computer command runner", () => {
  it("terminates commands whose combined output exceeds the configured bound", async () => {
    await expect(
      runComputerCommandSubprocess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(4096))"],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    ).rejects.toThrow("output exceeded the 1024-byte limit");
  });

  it("routes process.execPath-shaped requests directly to the shared executor", async () => {
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "direct\n",
      stderr: "",
    }));
    const runner = createInProcessComputerCommandRunner(executor);

    await expect(
      runner({
        command: process.execPath,
        args: [
          "/runtime/stella-computer.js",
          "--session",
          "session-1",
          "list-apps",
        ],
        cwd: "/workspace",
        env: { STELLA_DATA_DIR: "/data" },
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "direct\n", stderr: "" });

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      ["--session", "session-1", "list-apps"],
      expect.objectContaining({
        cwd: "/workspace",
        env: { STELLA_DATA_DIR: "/data" },
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    );
  });

  it("rejects arbitrary executables instead of treating them as CLI argv", async () => {
    const runner = createInProcessComputerCommandRunner(vi.fn());
    await expect(
      runner({
        command: "/bin/sh",
        args: ["-c", "true"],
        cwd: "/workspace",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("only accepts process.execPath");
  });
});
