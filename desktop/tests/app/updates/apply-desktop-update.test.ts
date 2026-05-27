import { describe, expect, it } from "vitest";
import {
  buildInstallUpdatePrompt,
  recordOfficialDesktopUpdateSourceHistory,
} from "@/global/updates/apply-desktop-update";

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
        sourcePackFile: "state/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK.json",
        sourcePackConflictFile:
          "state/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK_CONFLICTS.json",
        sourcePackConflictJson: JSON.stringify(
          {
            status: "conflicts",
            revisionId: "source:next",
            sourcePackFile:
              "state/raw/desktop-updates/desktop-v1.2.3/SOURCE_PACK.json",
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

describe("recordOfficialDesktopUpdateSourceHistory", () => {
  it("records official release history with a provided source-history ref", async () => {
    const calls: unknown[] = [];

    await recordOfficialDesktopUpdateSourceHistory({
      updatesApi: {
        recordSourceHistory: async (payload) => {
          calls.push(payload);
          return { ok: true, revisionId: "sha256:history" };
        },
      },
      targetCommit: "b".repeat(40),
      releaseTag: "desktop-v1.2.3",
      sourceHistoryRef: {
        kind: "url",
        url: "https://pub.example/desktop/releases/desktop-v1.2.3/source-history.json",
        sha256: `sha256:${"a".repeat(64)}`,
        sizeBytes: 123,
      },
    });

    expect(calls).toEqual([
      {
        targetCommit: "b".repeat(40),
        releaseTag: "desktop-v1.2.3",
        sourceHistoryRef: {
          kind: "url",
          url: "https://pub.example/desktop/releases/desktop-v1.2.3/source-history.json",
          sha256: `sha256:${"a".repeat(64)}`,
          sizeBytes: 123,
        },
      },
    ]);
  });

  it("does not fail the update flow when history recording fails", async () => {
    await expect(
      recordOfficialDesktopUpdateSourceHistory({
        updatesApi: {
          recordSourceHistory: async () => {
            throw new Error("offline");
          },
        },
        targetCommit: "b".repeat(40),
        releaseTag: "desktop-v1.2.3",
      }),
    ).resolves.toBeUndefined();
  });
});
