import { describe, expect, it } from "vitest";
import { buildStoreInstallPrompt } from "../../../../runtime/worker/store-install-prompt.js";

describe("buildStoreInstallPrompt", () => {
  it("frames source packs and reference diffs as agent inputs", () => {
    const prompt = buildStoreInstallPrompt({
      displayName: "Quiet Mode",
      packageId: "quiet-mode",
      installRootRelativePath: "state/raw/store-installs/quiet-mode-r1",
      specRelativePath: "state/raw/store-installs/quiet-mode-r1/SPEC.md",
      sourcePackRelativePath:
        "state/raw/store-installs/quiet-mode-r1/SOURCE_PACK.json",
      referencePaths: ["state/raw/store-installs/quiet-mode-r1/commit-01.diff"],
      blueprintMarkdown: "# Quiet Mode\n\n> Quiet down status noise.\n",
    });

    expect(prompt).toContain("Source pack:");
    expect(prompt).toContain("SOURCE_PACK.json");
    expect(prompt).toContain("do not apply it mechanically");
    expect(prompt).not.toContain("Artifact refs");
    expect(prompt).not.toContain("Artifact install report:");
    expect(prompt).toContain(
      "original-release-to-new-release delta",
    );
    expect(prompt.indexOf("Source pack:")).toBeLessThan(
      prompt.indexOf("Reference diffs to read:"),
    );
    expect(prompt).toContain(
      "Never run the source pack or reference diff files through `git apply`",
    );
  });
});
