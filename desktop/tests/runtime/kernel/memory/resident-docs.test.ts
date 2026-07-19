import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LIFE_MEMORY_INDEX_DISPLAY_PATH,
  readMemoryIndexDoc,
  readMemorySummaryDoc,
  readStartupDocBodyFromDisk,
  readUserProfileDoc,
  stripInjectedHtmlComments,
} from "../../../../../runtime/kernel/memory/resident-docs.js";

let stellaDataDir: string;

const writeMemoryFile = (name: string, content: string): void => {
  const memoriesDir = path.join(stellaDataDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, name), content);
};

describe("stripInjectedHtmlComments", () => {
  it("removes comment blocks and collapses the gap they leave", () => {
    const stripped = stripInjectedHtmlComments(
      "# Active\n\n- live entry\n\n<!-- DREAM:RETIRED_SUMMARY\n- retired bullet one\n- retired bullet two\n-->\n\n- another live entry",
    );
    expect(stripped).toBe("# Active\n\n- live entry\n\n- another live entry");
  });

  it("drops an unterminated comment through end-of-doc", () => {
    expect(
      stripInjectedHtmlComments("live\n<!-- retired archive that never closes"),
    ).toBe("live");
  });

  it("returns empty for a comment-only doc", () => {
    expect(stripInjectedHtmlComments("<!-- template guidance only -->")).toBe(
      "",
    );
  });
});

describe("resident memory doc reads", () => {
  beforeEach(() => {
    stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-resident-docs-"),
    );
  });

  afterEach(() => {
    fs.rmSync(stellaDataDir, { recursive: true, force: true });
  });

  it("never injects the retired-summary graveyard, even ahead of the cap", () => {
    // A 27.6KB-class retired comment ahead of the live content previously
    // consumed the injection budget and cut the doc mid-bullet.
    writeMemoryFile(
      "memory_summary.md",
      `<!-- DREAM:RETIRED_SUMMARY\n${"- retired bullet with old figures\n".repeat(800)}-->\n# Memory summary\n\n- live focus entry`,
    );
    const summary = readMemorySummaryDoc(stellaDataDir);
    expect(summary).toBe("# Memory summary\n\n- live focus entry");
  });

  it("keeps summary and index as separate docs", () => {
    writeMemoryFile("memory_summary.md", "# Memory summary\n\n- focus");
    writeMemoryFile(
      "memory_index.md",
      "# Memory index\n\n- muse benchmark -> MEMORY.md 2026-06-27",
    );
    expect(readMemorySummaryDoc(stellaDataDir)).not.toContain("Memory index");
    expect(readMemoryIndexDoc(stellaDataDir)).toBe(
      "# Memory index\n\n- muse benchmark -> MEMORY.md 2026-06-27",
    );
    expect(
      readStartupDocBodyFromDisk(stellaDataDir, LIFE_MEMORY_INDEX_DISPLAY_PATH),
    ).toContain("muse benchmark");
  });

  it("treats a comment-only index template as absent", () => {
    writeMemoryFile(
      "memory_index.md",
      "<!-- Populate with routing entries; one line each. -->",
    );
    expect(readMemoryIndexDoc(stellaDataDir)).toBeUndefined();
  });

  it("caps an oversized index after stripping", () => {
    writeMemoryFile(
      "memory_index.md",
      `<!-- guidance -->\n${"- entry pointing somewhere useful\n".repeat(400)}`,
    );
    const index = readMemoryIndexDoc(stellaDataDir);
    expect(index).toBeDefined();
    expect(index!.length).toBeLessThanOrEqual(6_000);
    expect(index).toContain("[resident memory truncated]");
  });

  it("strips comments from the profile doc", () => {
    writeMemoryFile(
      "profile.md",
      "# User Profile\n\n- goes by Bob\n<!-- superseded: went by Robert -->",
    );
    expect(readUserProfileDoc(stellaDataDir)).toBe(
      "# User Profile\n\n- goes by Bob",
    );
  });
});
