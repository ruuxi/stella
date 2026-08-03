import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleGrep } from "../../../../../runtime/kernel/tools/search.js";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

afterEach(() => tempDirs.cleanup());

const contextFor = (root: string) => ({
  conversationId: "search-recovery",
  deviceId: "search-device",
  requestId: crypto.randomUUID(),
  stellaAppDir: repoRoot,
  stellaDataDir: root,
});

describe("Grep recovery guidance", () => {
  it("points zero-result searches toward casing and literal escaping", async () => {
    const root = await tempDirs.create("stella-search-recovery-");
    await writeFile(
      path.join(root, "content.txt"),
      "MixedCaseNeedle\nliteral[a-z]\n",
      "utf-8",
    );

    const casing = await handleGrep(
      { pattern: "mixedcaseneedle", path: root, output_mode: "content" },
      contextFor(root),
    );
    expect(casing.result).toContain("No matches found");
    expect(casing.result).toContain("case-insensitive search does match");

    const literal = await handleGrep(
      { pattern: "literal[a-z]", path: root, output_mode: "content" },
      contextFor(root),
    );
    expect(literal.result).toContain("No matches found");
    expect(literal.result).toContain("literal text does match");
  });

  it("points zero-result searches toward hidden or ignored files", async () => {
    const root = await tempDirs.create("stella-search-hidden-");
    const hiddenDir = path.join(root, ".hidden");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(
      path.join(hiddenDir, "secret.txt"),
      "hidden-only-needle\n",
      "utf-8",
    );

    const result = await handleGrep(
      { pattern: "hidden-only-needle", path: root },
      contextFor(root),
    );
    expect(result.result).toContain("No matches found");
    expect(result.result).toContain("hidden or ignored files");
  });

  it("suggests similar paths for a missing search root", async () => {
    const root = await tempDirs.create("stella-search-path-");
    const actual = path.join(root, "components");
    await mkdir(actual, { recursive: true });

    const result = await handleGrep(
      { pattern: "anything", path: path.join(root, "componnets") },
      contextFor(root),
    );
    expect(result.error).toContain("Similar paths");
    expect(result.error).toContain(actual);
  });
});
