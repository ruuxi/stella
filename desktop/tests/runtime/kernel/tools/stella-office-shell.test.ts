import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  createShellState,
  runShell,
} from "../../../../runtime/kernel/tools/shell.js";

const officeWrapperPath = path.resolve(
  process.cwd(),
  "stella-office",
  "bin",
  "stella-office.js",
);

describe("stella-office shell bootstrap", () => {
  it("injects the stella-office command into Bash", async () => {
    const state = createShellState(async () => null, os.tmpdir(), {
      stellaOfficeBinPath: officeWrapperPath,
    });
    const command = "stella-office --version";

    const output = await runShell(state, command, process.cwd(), 10_000);

    expect(output).not.toContain("Command exited with code");
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });
});
