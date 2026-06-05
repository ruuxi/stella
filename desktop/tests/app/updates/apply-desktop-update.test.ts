import { describe, expect, it } from "vitest";
import { buildInstallUpdatePrompt } from "@/global/updates/apply-desktop-update";

describe("buildInstallUpdatePrompt", () => {
  it("embeds source-pack conflict JSON so the install-update agent can resolve without reading state files", () => {
    const prompt = buildInstallUpdatePrompt({
      repoOwner: "ruuxi",
      repoName: "stella",
      baseCommit: "a".repeat(40),
      targetCommit: "b".repeat(40),
      releaseTag: "desktop-v1.2.3",
      installRoot: "/tmp/Stella",
      fallback: {
        reason: "Stella source-pack merge reported conflicts.",
        headCommit: "c".repeat(40),
        changedFiles: ["src/panel.tsx"],
        sourcePackFile:
          "/Users/example/.stella/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK.json",
        sourcePackConflictFile:
          "/Users/example/.stella/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK_CONFLICTS.json",
        sourcePackConflictJson: JSON.stringify(
          {
            status: "conflicts",
            revisionId: "source:next",
            sourcePackFile:
              "/Users/example/.stella/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK.json",
            appliedPaths: ["src/settings.ts"],
            appliedChanges: [
              {
                path: "src/settings.ts",
                content: { kind: "text", content: "settings v2\n" },
              },
            ],
            noopPaths: [],
            conflicts: [
              {
                path: "src/panel.tsx",
                reason: "text-conflict",
                base: { kind: "text", content: "base\n" },
                local: { kind: "text", content: "mine\n" },
                next: { kind: "text", content: "theirs\n" },
              },
            ],
          },
          null,
          2,
        ),
      },
    });

    expect(prompt).toContain("Source-pack conflict JSON:");
    expect(prompt).toContain('"local": {');
    expect(prompt).toContain("Use the embedded conflict JSON first.");
    expect(prompt).toContain("Full source pack:");
    expect(prompt).toContain("appliedPaths");
    expect(prompt).toContain("appliedChanges");
    expect(prompt).toContain("exact final content");
    expect(prompt).not.toContain("git fetch");
    expect(prompt).not.toContain("Read the conflict JSON first");
  });
});
