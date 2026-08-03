import { afterEach, describe, expect, it } from "vitest";
import { setupGitEnvironment } from "../../../runtime/git-environment.js";

const originalGitBin = process.env.STELLA_GIT_BIN;

afterEach(() => {
  if (originalGitBin === undefined) {
    delete process.env.STELLA_GIT_BIN;
  } else {
    process.env.STELLA_GIT_BIN = originalGitBin;
  }
});

describe("setupGitEnvironment", () => {
  it("uses the launcher-selected Git binary and preserves managed variables", () => {
    const result = setupGitEnvironment({
      STELLA_GIT_BIN: "/private/stella/git",
      GIT_EXEC_PATH: "/private/stella/git-core",
    });

    expect(result.gitLocation).toBe("/private/stella/git");
    expect(result.env.GIT_EXEC_PATH).toBe("/private/stella/git-core");
  });

  it("falls back to Git on PATH for development runs", () => {
    delete process.env.STELLA_GIT_BIN;
    const result = setupGitEnvironment();

    expect(result.gitLocation).toBe("git");
  });
});
