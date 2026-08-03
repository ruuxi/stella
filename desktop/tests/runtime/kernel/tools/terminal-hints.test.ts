import { describe, expect, it } from "vitest";

import { getTerminalRecoveryHint } from "../../../../../runtime/kernel/tools/terminal-hints.js";

describe("terminal recovery hints", () => {
  it("returns the first actionable hint for known failure classes", () => {
    expect(
      getTerminalRecoveryHint({
        command: "git merge feature",
        exitCode: 1,
        output: "CONFLICT (content): Merge conflict in src/app.ts",
      }),
    ).toContain("git status");

    expect(
      getTerminalRecoveryHint({
        command: "python3 script.py",
        exitCode: 1,
        output: "ModuleNotFoundError: No module named 'requests'",
      }),
    ).toContain("`requests`");

    expect(
      getTerminalRecoveryHint({
        command: "tool publish",
        exitCode: 1,
        output: "HTTP 429: too many requests",
      }),
    ).toContain("rate-limiting");

    expect(
      getTerminalRecoveryHint({
        command: "./build.sh",
        exitCode: 126,
        output: "",
      }),
    ).toContain("could not execute");
  });

  it("does not guess for successful or unknown failures", () => {
    expect(
      getTerminalRecoveryHint({
        command: "printf ok",
        exitCode: 0,
        output: "ok",
      }),
    ).toBeNull();
    expect(
      getTerminalRecoveryHint({
        command: "grep needle file.txt",
        exitCode: 1,
        output: "",
      }),
    ).toBeNull();
  });
});
