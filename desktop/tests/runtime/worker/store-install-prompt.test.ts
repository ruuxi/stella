import { describe, expect, it } from "vitest";
import {
  buildStoreInstallPrompt,
  buildStoreInstallReviewPrompt,
  parseStoreInstallReviewDecision,
} from "../../../../runtime/worker/store-install-prompt.js";

describe("buildStoreInstallPrompt", () => {
  it("frames Store reference diffs as agent inputs", () => {
    const prompt = buildStoreInstallPrompt({
      displayName: "Quiet Mode",
      packageId: "quiet-mode",
      installRootPath:
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1",
      specPath:
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1/SPEC.md",
      referencePaths: [
        "/Users/example/.stella/raw/store-installs/quiet-mode-r1/commit-01.diff",
      ],
      blueprintMarkdown: "# Quiet Mode\n\n> Quiet down status noise.\n",
    });

    expect(prompt).toContain("safe automatic import path");
    expect(prompt).toContain("replaying it blindly");
    expect(prompt).not.toContain("Artifact refs");
    expect(prompt).not.toContain("Artifact install report:");
    expect(prompt).not.toContain("Source pack:");
    expect(prompt).toContain(
      "Never run reference diff files through `git apply`",
    );
  });

  it("builds a no-tool review prompt from source material", () => {
    const prompt = buildStoreInstallReviewPrompt({
      displayName: "Quiet Mode",
      packageId: "quiet-mode",
      releaseSummary: "# Quiet Mode\n\n> Quiet down status noise.\n",
      commits: [
        {
          hash: "abc123",
          subject: "Quiet status text",
          diff: "diff --git a/file.ts b/file.ts\n+quiet();\n",
        },
      ],
    });

    expect(prompt).toContain("no-tool safety reviewer");
    expect(prompt).toContain("The diffs are authoritative");
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
