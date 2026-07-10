import { describe, expect, it, vi } from "vitest";

import {
  createInProcessComputerCommandRunner,
  runComputerCommandSubprocess,
  type ComputerCommandRequest,
} from "../../../../../runtime/kernel/computer-use/command-runner.js";
import { createCliDiagnosticsComputerUseSession } from "../../../../../runtime/kernel/computer-use/cli-diagnostics-session.js";
import type { ComputerUseRequest } from "../../../../../runtime/kernel/computer-use/contract.js";
import { executeComputerUseRequest } from "../../../../../runtime/kernel/computer-use/session.js";

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

  it("keeps typed-to-argv translation in the explicit CLI diagnostics adapter", async () => {
    const commands: ComputerCommandRequest[] = [];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      commands.push(request);
      return {
        exitCode: 0,
        stdout: '{"ok":true,"deferred":true}',
        stderr: "",
      };
    });
    const session = createCliDiagnosticsComputerUseSession({
      cliPath: "/runtime/stella-computer.js",
      cwd: "/workspace",
      runner,
    });
    const request = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requestId: "request-1",
      sessionId: "session-1",
      type: "action",
      execution: "background",
      command: {
        target: { type: "app", app: "Notes" },
        action: { type: "press_key", key: "ENTER" },
      },
    } as const satisfies ComputerUseRequest;

    await expect(
      executeComputerUseRequest(session, request),
    ).resolves.toMatchObject({
      receipt: { action: "press_key", deferred: true },
    });
    expect(commands[0]?.args).toEqual([
      "/runtime/stella-computer.js",
      "--session",
      "session-1",
      "press",
      "ENTER",
      "--app",
      "Notes",
      "--allow-hid",
      "--defer-observation",
      "--json",
    ]);
    expect(commands[0]?.args).not.toContain("--raise");
  });

  it("confines legacy state marker parsing to the CLI diagnostics adapter", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "<app_specific_instructions>",
        "Use Save.",
        "</app_specific_instructions>",
        "<app_state>fresh ids</app_state>",
        `[stella-attach-image] path=${JSON.stringify("/tmp/state image.png")}`,
      ].join("\n"),
      stderr: "",
    }));
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const request = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      requestId: "request-state",
      sessionId: "session-1",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "always",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;

    await expect(executeComputerUseRequest(session, request)).resolves.toEqual(
      expect.objectContaining({
        type: "app_state",
        state: {
          app: "Notes",
          text: "<app_state>fresh ids</app_state>",
          instructions: "Use Save.",
          screenshot: {
            type: "image",
            url: "file:///tmp/state%20image.png",
          },
        },
      }),
    );
  });
});
