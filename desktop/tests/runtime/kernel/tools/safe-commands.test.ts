import { describe, expect, it } from "vitest";

import { isKnownSafeCommand } from "../../../../../runtime/kernel/tools/safe-commands.js";

describe("isKnownSafeCommand (codex parity)", () => {
  it("accepts the simple read-only allowlist", () => {
    for (const cmd of [
      "ls",
      "ls -la",
      "pwd",
      "cat README.md",
      "grep foo bar.txt",
      "head -n 5 file",
      "wc -l file",
      "echo hi",
      "id",
      "whoami",
    ]) {
      expect(isKnownSafeCommand(cmd)).toBe(true);
    }
  });

  it("accepts safe git subcommands and rejects mutating ones", () => {
    expect(isKnownSafeCommand("git status")).toBe(true);
    expect(isKnownSafeCommand("git log -n 5")).toBe(true);
    expect(isKnownSafeCommand("git diff HEAD~1")).toBe(true);
    expect(isKnownSafeCommand("git branch --show-current")).toBe(true);
    expect(isKnownSafeCommand("git -C . status")).toBe(true);

    expect(isKnownSafeCommand("git push")).toBe(false);
    expect(isKnownSafeCommand("git checkout main")).toBe(false);
    expect(isKnownSafeCommand("git branch -d feature")).toBe(false);
    expect(isKnownSafeCommand("git -c core.pager=cat log")).toBe(false);
    expect(isKnownSafeCommand("git --git-dir=.evil-git diff")).toBe(false);
  });

  it("rejects unsafe find / rg flags but accepts plain invocations", () => {
    expect(isKnownSafeCommand("find . -name file.txt")).toBe(true);
    expect(isKnownSafeCommand("find . -name file.txt -delete")).toBe(false);
    expect(isKnownSafeCommand("find . -exec rm {} ;")).toBe(false);

    expect(isKnownSafeCommand("rg foo")).toBe(true);
    expect(isKnownSafeCommand("rg --search-zip foo")).toBe(false);
    expect(isKnownSafeCommand("rg --pre attacker foo")).toBe(false);
  });

  it("unwraps `bash -lc \"...\"` and re-checks the inner command", () => {
    expect(isKnownSafeCommand('bash -lc "ls"')).toBe(true);
    expect(isKnownSafeCommand('bash -lc "git status"')).toBe(true);
    expect(isKnownSafeCommand('zsh -lc "ls && pwd"')).toBe(true);
    expect(isKnownSafeCommand('bash -lc "ls && rm -rf /"')).toBe(false);
    expect(isKnownSafeCommand('bash -lc "ls > out.txt"')).toBe(false);
    expect(isKnownSafeCommand('bash -lc "(ls)"')).toBe(false);
  });

  it("rejects unknown executables and incomplete inputs", () => {
    expect(isKnownSafeCommand("foo")).toBe(false);
    expect(isKnownSafeCommand("")).toBe(false);
    expect(isKnownSafeCommand("npm install")).toBe(false);
    expect(isKnownSafeCommand("git fetch")).toBe(false);
  });

  it("rejects backgrounded commands and handles newlines as command separators", () => {
    expect(isKnownSafeCommand("ls & rm -rf /")).toBe(false);
    expect(isKnownSafeCommand("ls\npwd")).toBe(true);
    expect(isKnownSafeCommand("ls\nrm -rf /")).toBe(false);
    expect(isKnownSafeCommand("ls\n\npwd")).toBe(false);
  });
});
