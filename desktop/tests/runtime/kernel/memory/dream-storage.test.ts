import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  blankInjectedHtmlComments,
  ensureDreamMemoryLayout,
  MEMORY_MAP_MAX_CHARS,
  memoryIndexPath,
  memoryMapPath,
  memorySummaryPath,
  readMemoryMap,
  stripInjectedHtmlComments,
} from "../../../../../runtime/kernel/memory/dream-storage.js";

let stellaDataDir: string;

const memoriesDir = (): string => path.join(stellaDataDir, "memories");

describe("ensureDreamMemoryLayout / memory_map migration", () => {
  beforeEach(async () => {
    stellaDataDir = path.join(
      os.tmpdir(),
      `stella-dream-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(stellaDataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(stellaDataDir, { recursive: true, force: true });
  });

  it("seeds MEMORY.md and a template memory_map.md on a fresh install, without retired files", async () => {
    await ensureDreamMemoryLayout(stellaDataDir);
    const map = await readFile(memoryMapPath(stellaDataDir), "utf-8");
    expect(map).toContain("# Memory map");
    expect(map).toContain("<!-- DREAM:MAP_START -->");
    expect(map).toContain("## Derived constraints");
    expect(map).not.toContain("Migrated focus notes");
    // The retired docs are never seeded for new users.
    await expect(
      readFile(memorySummaryPath(stellaDataDir), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(memoryIndexPath(stellaDataDir), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(memoriesDir(), "MEMORY.md"), "utf-8"),
    ).resolves.toContain("# MEMORY");
  });

  it("folds existing index entries and summary bullets into the first seed and marks the old files retired", async () => {
    await mkdir(memoriesDir(), { recursive: true });
    const summaryOriginal =
      "# Memory summary\n\n<!-- DREAM:SUMMARY_START -->\n- Shipping the certified memory redesign.\n- Recall latency root-caused to model runtime.\n<!-- DREAM:SUMMARY_END -->\n<!-- DREAM:RETIRED_SUMMARY\n- ancient archived bullet\n-->\n";
    const indexOriginal =
      "# Memory routing index\n\n<!-- DREAM:INDEX_START -->\n- muse benchmark -> MEMORY.md 2026-06-27 | aliases: minecraft, self-mod\n<!-- DREAM:INDEX_END -->\n";
    await writeFile(memorySummaryPath(stellaDataDir), summaryOriginal, "utf-8");
    await writeFile(memoryIndexPath(stellaDataDir), indexOriginal, "utf-8");

    await ensureDreamMemoryLayout(stellaDataDir);

    const map = await readFile(memoryMapPath(stellaDataDir), "utf-8");
    // Index entries become routing entries; summary bullets land in the
    // clearly-marked one-time staging section.
    expect(map).toContain(
      "- muse benchmark -> MEMORY.md 2026-06-27 | aliases: minecraft, self-mod",
    );
    expect(map).toContain("Migrated focus notes (from memory_summary.md)");
    expect(map).toContain("Shipping the certified memory redesign.");
    // The retired-archive comment is never folded forward.
    expect(map).not.toContain("ancient archived bullet");
    // Seeded injectable view respects the hard cap.
    expect(stripInjectedHtmlComments(map).length).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );

    // Old files preserved byte-for-byte below a retirement banner.
    const summaryAfter = await readFile(
      memorySummaryPath(stellaDataDir),
      "utf-8",
    );
    expect(summaryAfter.startsWith("<!-- RETIRED")).toBe(true);
    expect(summaryAfter).toContain(summaryOriginal);
    const indexAfter = await readFile(memoryIndexPath(stellaDataDir), "utf-8");
    expect(indexAfter.startsWith("<!-- RETIRED")).toBe(true);
    expect(indexAfter).toContain(indexOriginal);
  });

  it("bounds an oversized summary fold and points at the preserved original", async () => {
    await mkdir(memoriesDir(), { recursive: true });
    const bullets = Array.from(
      { length: 400 },
      (_, index) => `- focus bullet ${index} with plenty of detail attached`,
    ).join("\n");
    await writeFile(
      memorySummaryPath(stellaDataDir),
      `# Memory summary\n\n<!-- DREAM:SUMMARY_START -->\n${bullets}\n<!-- DREAM:SUMMARY_END -->\n`,
      "utf-8",
    );

    await ensureDreamMemoryLayout(stellaDataDir);

    const map = await readFile(memoryMapPath(stellaDataDir), "utf-8");
    expect(stripInjectedHtmlComments(map).length).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );
    expect(map).toContain("migration cut — full text preserved in");
    // Cut at a line boundary, never mid-bullet.
    expect(map).toContain("- focus bullet 0 with plenty of detail attached");
  });

  it("keeps the seeded injected view under the hard cap even when both folds and their cut markers land (measured clamp, not a flat allowance)", async () => {
    await mkdir(memoriesDir(), { recursive: true });
    // Pathological worst case for the old flat +80 allowance: an index that
    // saturates its budget (forcing the routes cut marker), plus a summary
    // that saturates the remainder (forcing the second marker and the
    // migrated-section heading — all chars the flat allowance undercounted).
    const indexEntries = Array.from(
      { length: 300 },
      (_, i) => `- workstream ${i} -> MEMORY.md 2026-06-${(i % 28) + 1} | aliases: alias${i}, keyword${i}`,
    ).join("\n");
    const summaryBullets = Array.from(
      { length: 300 },
      (_, i) => `- focus bullet ${i} carrying enough detail to matter`,
    ).join("\n");
    await writeFile(
      memoryIndexPath(stellaDataDir),
      `# Memory index\n\n<!-- DREAM:INDEX_START -->\n${indexEntries}\n<!-- DREAM:INDEX_END -->\n`,
      "utf-8",
    );
    await writeFile(
      memorySummaryPath(stellaDataDir),
      `# Memory summary\n\n<!-- DREAM:SUMMARY_START -->\n${summaryBullets}\n<!-- DREAM:SUMMARY_END -->\n`,
      "utf-8",
    );

    await ensureDreamMemoryLayout(stellaDataDir);

    const map = await readFile(memoryMapPath(stellaDataDir), "utf-8");
    expect(stripInjectedHtmlComments(map).length).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );
    // Both folds made it in (bounded), with every anchor pair intact.
    expect(map).toContain("- workstream 0 ->");
    expect(map).toContain("<!-- DREAM:MAP_START -->");
    expect(map).toContain("<!-- DREAM:MAP_END -->");
    expect(map).toContain("<!-- DREAM:DERIVED_START -->");
    expect(map).toContain("<!-- DREAM:DERIVED_END -->");
  });

  it("is idempotent: a second run never rewrites an existing map or re-banners retired files", async () => {
    await mkdir(memoriesDir(), { recursive: true });
    await writeFile(
      memorySummaryPath(stellaDataDir),
      "# Memory summary\n\n- focus\n",
      "utf-8",
    );
    await ensureDreamMemoryLayout(stellaDataDir);
    const mapAfterFirst = await readFile(memoryMapPath(stellaDataDir), "utf-8");
    const summaryAfterFirst = await readFile(
      memorySummaryPath(stellaDataDir),
      "utf-8",
    );

    await ensureDreamMemoryLayout(stellaDataDir);
    await expect(readFile(memoryMapPath(stellaDataDir), "utf-8")).resolves.toBe(
      mapAfterFirst,
    );
    await expect(
      readFile(memorySummaryPath(stellaDataDir), "utf-8"),
    ).resolves.toBe(summaryAfterFirst);
    expect(summaryAfterFirst.match(/<!-- RETIRED/g)).toHaveLength(1);
  });

  it("readMemoryMap returns the raw file for Dream-side consumers", async () => {
    await ensureDreamMemoryLayout(stellaDataDir);
    const raw = await readMemoryMap(stellaDataDir);
    expect(raw).toContain("<!-- DREAM:MAP_START -->");
  });
});

describe("blankInjectedHtmlComments", () => {
  it("blanks comment text while preserving every line position", () => {
    const raw = [
      "<!-- DREAM:MAP_CHARTER",
      "guidance the model must not match",
      "-->",
      "# Memory map",
      "- real entry",
    ].join("\n");
    const blanked = blankInjectedHtmlComments(raw);
    const lines = blanked.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("# Memory map");
    expect(lines[4]).toBe("- real entry");
    expect(blanked).not.toContain("guidance the model");
  });

  it("blanks an unterminated comment through end-of-doc", () => {
    const blanked = blankInjectedHtmlComments(
      "live line\n<!-- never closed\nstill inside the comment",
    );
    expect(blanked.split("\n")).toEqual(["live line", "", ""]);
  });
});
