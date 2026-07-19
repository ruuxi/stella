import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LIFE_MEMORY_MAP_DISPLAY_PATH,
  readMemoryMapDoc,
  readStartupDocBodyFromDisk,
  readUserProfileDoc,
  RETIRED_STARTUP_DOC_DISPLAY_PATHS,
  stripInjectedHtmlComments,
} from "../../../../../runtime/kernel/memory/resident-docs.js";
import { USER_PROFILE_INJECTED_MAX_CHARS } from "../../../../../runtime/kernel/memory/user-profile-store.js";

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

  it("injects only the map's non-comment content (charter and anchors are free)", () => {
    writeMemoryFile(
      "memory_map.md",
      "<!-- DREAM:MAP_CHARTER\nrouting guidance for the writer only\n-->\n# Memory map\n\n<!-- DREAM:MAP_START -->\n- muse benchmark -> MEMORY.md 2026-06-27\n<!-- DREAM:MAP_END -->",
    );
    expect(readMemoryMapDoc(stellaDataDir)).toBe(
      "# Memory map\n\n- muse benchmark -> MEMORY.md 2026-06-27",
    );
    expect(
      readStartupDocBodyFromDisk(stellaDataDir, LIFE_MEMORY_MAP_DISPLAY_PATH),
    ).toContain("muse benchmark");
  });

  it("treats a comment-only map template as absent", () => {
    writeMemoryFile(
      "memory_map.md",
      "<!-- Populate with routing entries; one line each. -->",
    );
    expect(readMemoryMapDoc(stellaDataDir)).toBeUndefined();
  });

  it("caps an oversized map read after stripping (write-jail backstop)", () => {
    writeMemoryFile(
      "memory_map.md",
      `<!-- guidance -->\n${"- entry pointing somewhere useful\n".repeat(400)}`,
    );
    const memoryMap = readMemoryMapDoc(stellaDataDir);
    expect(memoryMap).toBeDefined();
    expect(memoryMap!.length).toBeLessThanOrEqual(6_000);
    expect(memoryMap).toContain("[resident memory truncated]");
  });

  it("returns no fresh body for retired doc paths", () => {
    writeMemoryFile("memory_summary.md", "# Memory summary\n\n- focus");
    writeMemoryFile("memory_index.md", "# Memory index\n\n- entry");
    for (const retiredPath of RETIRED_STARTUP_DOC_DISPLAY_PATHS) {
      expect(
        readStartupDocBodyFromDisk(stellaDataDir, retiredPath),
      ).toBeUndefined();
    }
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

  it("caps a runaway profile read (write-side rejection is the real cap)", () => {
    writeMemoryFile(
      "profile.md",
      `# User Profile\n\n${"- a hand-edited fact no Remember call could have written\n".repeat(400)}`,
    );
    const profile = readUserProfileDoc(stellaDataDir);
    expect(profile).toBeDefined();
    expect(profile!.length).toBeLessThanOrEqual(
      USER_PROFILE_INJECTED_MAX_CHARS,
    );
    expect(profile).toContain("[resident memory truncated]");
  });
});
