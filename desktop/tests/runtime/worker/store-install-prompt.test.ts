import { describe, expect, it } from "vitest";
import {
  buildStoreInstallPrompt,
  buildStoreInstallReviewPrompt,
  parseStoreInstallReviewDecision,
} from "../../../../runtime/worker/store-install-prompt.js";

describe("buildStoreInstallPrompt", () => {
  it("frames source packs and reference diffs as agent inputs", () => {
    const prompt = buildStoreInstallPrompt({
      displayName: "Quiet Mode",
      packageId: "quiet-mode",
      installRootPath:
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1",
      specPath:
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1/SPEC.md",
      sourcePackPath:
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1/SOURCE_PACK.json",
      referencePaths: [
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1/commit-01.diff",
      ],
      blueprintMarkdown: "# Quiet Mode\n\n> Quiet down status noise.\n",
    });

    expect(prompt).toContain("Source pack:");
    expect(prompt).toContain("SOURCE_PACK.json");
    expect(prompt).toContain("do not apply it mechanically");
    expect(prompt).not.toContain("Artifact refs");
    expect(prompt).not.toContain("Artifact install report:");
    expect(prompt).toContain("original-release-to-new-release delta");
    expect(prompt.indexOf("Source pack:")).toBeLessThan(
      prompt.indexOf("Reference diffs to read:"),
    );
    expect(prompt).toContain(
      "Never run the source pack or reference diff files through `git apply`",
    );
  });

  it("builds a no-tool review prompt from source material", () => {
    const prompt = buildStoreInstallReviewPrompt({
      displayName: "Quiet Mode",
      packageId: "quiet-mode",
      releaseSummary: "# Quiet Mode\n\n> Quiet down status noise.\n",
      sourcePack: null,
      commits: [
        {
          hash: "abc123",
          subject: "Quiet status text",
          diff: "diff --git a/file.ts b/file.ts\n+quiet();\n",
        },
      ],
    });

    expect(prompt).toContain("no-tool safety reviewer");
    expect(prompt).toContain("source pack and diffs are authoritative");
    expect(prompt).toContain('"decision":"allow"|"block"');
    expect(prompt).toContain("diff --git");
  });

  it("parses review decisions and fails closed on malformed output", () => {
    expect(
      parseStoreInstallReviewDecision(
        '```json\n{"decision":"allow","reason":"matches source"}\n```',
      ),
    ).toEqual({ allow: true, reason: "matches source" });
    expect(parseStoreInstallReviewDecision("not json").allow).toBe(false);
  });
});
