import { describe, expect, it } from "vitest";

import { executeStellaComputerCommand } from "../../../../../runtime/kernel/computer-use/stella-computer-executor.js";
import { runStellaComputerCli } from "../../../../../runtime/kernel/cli/stella-computer.js";

describe("shared Stella computer executor", () => {
  it("returns help through the in-process result contract", async () => {
    const result = await executeStellaComputerCommand(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stella-computer - control");
    expect(result.stdout).toContain("stella-computer list-windows");
    expect(result.stderr).toBe("");
  });

  it("keeps command validation and session option errors in the shared path", async () => {
    const missingSession = await executeStellaComputerCommand(["--session"]);
    const unknown = await executeStellaComputerCommand(["not-a-command"]);

    expect(missingSession).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "--session requires a value.\n",
    });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown command: not-a-command");
    expect(unknown.stderr).toContain("Usage:");
  });

  it("keeps the CLI as a thin adapter over the same executor output", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runStellaComputerCli(["--help"], {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("stella-computer - control");
    expect(stderr).toBe("");
  });
});
