import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShellState,
  handleBash,
  runShell,
} from "../../../../../runtime/kernel/tools/shell.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();
const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  tempDirs.cleanup();
});

const createTempDir = () => {
  return tempDirs.create("stella-computer-shell-");
};

const forcePlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
};

describe("stella-computer shell bootstrap", () => {
  it("injects the stella-computer command into Bash", async () => {
    const tempDir = createTempDir();
    const fakeComputerCliPath = path.join(tempDir, "fake-stella-computer.js");
    writeFileSync(
      fakeComputerCliPath,
      `console.log(JSON.stringify({
  cli: process.env.STELLA_COMPUTER_CLI ?? null,
  args: process.argv.slice(2),
}));`,
      "utf-8",
    );

    const state = createShellState(tempDir, {
      stellaComputerCliPath: fakeComputerCliPath,
    });
    const output = await runShell(
      state,
      "stella-computer snapshot --json",
      tempDir,
      10_000,
    );

    expect(output).not.toContain("Command exited with code");
    expect(JSON.parse(output)).toEqual({
      cli: fakeComputerCliPath,
      args: ["snapshot", "--json"],
    });
  });

  it("assigns a task-scoped stella-computer session for Bash runs", async () => {
    const tempDir = createTempDir();
    const fakeComputerCliPath = path.join(tempDir, "fake-stella-computer.js");
    writeFileSync(
      fakeComputerCliPath,
      `console.log(JSON.stringify({
  cli: process.env.STELLA_COMPUTER_CLI ?? null,
  session: process.env.STELLA_COMPUTER_SESSION ?? null,
  args: process.argv.slice(2),
}));`,
      "utf-8",
    );

    const state = createShellState(tempDir, {
      stellaComputerCliPath: fakeComputerCliPath,
    });
    const context: ToolContext = {
      conversationId: "conversation-test",
      deviceId: "device-test",
      requestId: "request-test",
      runId: "run-test",
      agentId: "task-test",
      agentType: "general",
      stellaRoot: tempDir,
      storageMode: "local",
    };
    const result = await handleBash(
      state,
      {
        command: "stella-computer snapshot --json",
        working_directory: tempDir,
        timeout: 10_000,
      },
      context,
    );

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.result))).toEqual({
      cli: fakeComputerCliPath,
      session: "general-task-task-test",
      args: ["snapshot", "--json"],
    });
  });

  it("creates a Windows cmd shim for stella-computer", () => {
    forcePlatform("win32");
    const tempDir = createTempDir();
    const fakeComputerCliPath = path.join(tempDir, "fake-stella-computer.js");

    const state = createShellState(tempDir, {
      stellaComputerCliPath: fakeComputerCliPath,
    });

    expect(state.windowsCliShimDir).toBeTruthy();
    const shim = readFileSync(
      path.join(String(state.windowsCliShimDir), "stella-computer.cmd"),
      "utf-8",
    );
    expect(shim).toContain('"%STELLA_NODE_BIN%" "%STELLA_COMPUTER_CLI%" %*');
  });
});
