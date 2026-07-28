import { describe, expect, it } from "vitest";
import { buildInstallUpdatePrompt } from "@/global/updates/apply-desktop-update";

describe("buildInstallUpdatePrompt", () => {
  it("hands a Git conflict to the install-update agent with the exact published target", () => {
    const prompt = buildInstallUpdatePrompt({
      repoOwner: "ruuxi",
      repoName: "stella",
      baseCommit: "a".repeat(40),
      targetCommit: "b".repeat(40),
      releaseTag: "desktop-v1.2.3",
      installRoot: "/tmp/Stella",
      fallback: {
        reason: "Git reported conflicts while merging the published commit.",
        headCommit: "c".repeat(40),
        changedFiles: ["src/panel.tsx"],
      },
    });

    expect(prompt).toContain(
      "Fast update path could not apply automatically: Git reported conflicts",
    );
    expect(prompt).toContain(
      `Base commit (currently installed): ${"a".repeat(40)}`,
    );
    expect(prompt).toContain(
      `Target commit (latest published): ${"b".repeat(40)}`,
    );
    expect(prompt).toContain("fetch origin/master");
    expect(prompt).toContain("verify it matches the target commit");
    expect(prompt).toContain("resolve conflicts only if Git reports them");
    expect(prompt).not.toContain("source pack");
  });
});
