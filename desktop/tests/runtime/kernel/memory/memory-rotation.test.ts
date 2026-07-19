import { promises as fsp } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendSupersededMemoryText,
  archiveFileNameForBlockDate,
  listMemoryArchiveFiles,
  MEMORY_ROTATION_MIN_ACTIVE_BLOCKS,
  MEMORY_ROTATION_TARGET_BYTES,
  MEMORY_ROTATION_THRESHOLD_BYTES,
  memoryArchiveRoot,
  memorySupersededArchivePath,
  rotateMemoryFileIfNeeded,
} from "../../../../../runtime/kernel/memory/memory-rotation.js";
import { memoryFilePath, memoryMapPath } from "../../../../../runtime/kernel/memory/dream-storage.js";

let stellaDataDir: string;

beforeEach(async () => {
  stellaDataDir = path.join(
    os.tmpdir(),
    `stella-memory-rotation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path.join(stellaDataDir, "memories"), { recursive: true });
});

afterEach(async () => {
  await rm(stellaDataDir, { recursive: true, force: true });
});

const block = (isoDate: string, title: string, bodyChars: number): string =>
  [
    `## ${isoDate} 12:00 — ${title}`,
    `Threads: t-${title}:r1`,
    `Why this matters: ${title} matters.`,
    `Outcome: ${"x".repeat(Math.max(0, bodyChars))}`,
    `Recall hooks: ${title}`,
  ].join("\n");

const buildMemoryFile = (args: {
  activeBlocks: string[];
  archiveBlocks?: string[];
  withAnchors?: boolean;
}): string => {
  if (args.withAnchors === false) {
    return `# MEMORY\n\n${args.activeBlocks.join("\n\n")}\n`;
  }
  return [
    "# MEMORY",
    "",
    "> ledger guidance",
    "",
    "<!-- DREAM:ACTIVE_BLOCKS_START -->",
    args.activeBlocks.join("\n\n"),
    "<!-- DREAM:ACTIVE_BLOCKS_END -->",
    "",
    "## Archive",
    "",
    "<!-- DREAM:ARCHIVE_START -->",
    (args.archiveBlocks ?? []).join("\n\n"),
    "<!-- DREAM:ARCHIVE_END -->",
    "",
  ].join("\n");
};

const writeMemoryFile = async (content: string): Promise<void> => {
  await writeFile(memoryFilePath(stellaDataDir), content, "utf-8");
};

describe("archiveFileNameForBlockDate", () => {
  it("derives quarter-named files from block dates", () => {
    expect(archiveFileNameForBlockDate("2026-01-15")).toBe("MEMORY-2026-Q1.md");
    expect(archiveFileNameForBlockDate("2026-04-01")).toBe("MEMORY-2026-Q2.md");
    expect(archiveFileNameForBlockDate("2026-07-18")).toBe("MEMORY-2026-Q3.md");
    expect(archiveFileNameForBlockDate("2026-12-31")).toBe("MEMORY-2026-Q4.md");
  });
});

describe("rotateMemoryFileIfNeeded", () => {
  it("is a no-op below the size threshold", async () => {
    const content = buildMemoryFile({
      activeBlocks: [block("2026-07-01", "small", 100)],
    });
    await writeMemoryFile(content);
    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.toBeNull();
    await expect(readFile(memoryFilePath(stellaDataDir), "utf-8")).resolves.toBe(
      content,
    );
    await expect(listMemoryArchiveFiles(stellaDataDir)).resolves.toEqual([]);
  });

  it("rotates the oldest blocks into period-named archives, copy-first and lossless", async () => {
    // Newest-at-top ledger: 16 dated blocks of ~25KB spanning Q2 and Q3.
    const newest = Array.from({ length: 8 }, (_, i) =>
      block(`2026-07-${String(10 + i).padStart(2, "0")}`, `new-${i}`, 25_000),
    ).reverse();
    const oldest = Array.from({ length: 8 }, (_, i) =>
      block(`2026-05-${String(10 + i).padStart(2, "0")}`, `old-${i}`, 25_000),
    ).reverse();
    const activeBlocks = [...newest, ...oldest];
    await writeMemoryFile(buildMemoryFile({ activeBlocks }));

    const result = await rotateMemoryFileIfNeeded(stellaDataDir);
    expect(result).not.toBeNull();
    expect(result!.bytesBefore).toBeGreaterThan(MEMORY_ROTATION_THRESHOLD_BYTES);
    expect(result!.bytesAfter).toBeLessThanOrEqual(
      MEMORY_ROTATION_TARGET_BYTES + 30_000,
    );
    expect(result!.rotatedBlocks).toBeGreaterThan(0);

    const remaining = await readFile(memoryFilePath(stellaDataDir), "utf-8");
    // Anchors intact, newest blocks retained.
    expect(remaining).toContain("<!-- DREAM:ACTIVE_BLOCKS_START -->");
    expect(remaining).toContain("<!-- DREAM:ACTIVE_BLOCKS_END -->");
    for (let i = 0; i < 8; i += 1) {
      expect(remaining).toContain(`new-${i} matters`);
    }

    // Every rotated block landed verbatim in the archive for its own period,
    // and nothing exists in neither place.
    const archives = await listMemoryArchiveFiles(stellaDataDir);
    expect(archives.length).toBeGreaterThan(0);
    for (const name of archives) {
      expect(name).toMatch(/^MEMORY-\d{4}-Q[1-4]\.md$/);
    }
    const archived = (
      await Promise.all(
        archives.map((name) =>
          readFile(path.join(memoryArchiveRoot(stellaDataDir), name), "utf-8"),
        ),
      )
    ).join("\n");
    for (const original of activeBlocks) {
      const inActive = remaining.includes(original);
      const inArchive = archived.includes(original);
      expect(inActive || inArchive).toBe(true);
    }
    // Oldest blocks went out, into the Q2 file.
    expect(archived).toContain("old-0 matters");
    expect(archives).toContain("MEMORY-2026-Q2.md");
  });

  it("keeps the newest MIN_ACTIVE blocks even when still above target, and never touches undated blocks", async () => {
    const dated = Array.from({ length: MEMORY_ROTATION_MIN_ACTIVE_BLOCKS }, (_, i) =>
      block(`2026-07-0${i + 1}`, `keep-${i}`, 90_000),
    ).reverse();
    const undated = "## Undated operational note\nNo date heading here.";
    await writeMemoryFile(
      buildMemoryFile({ activeBlocks: [...dated, undated] }),
    );

    // Well above the threshold, but every dated block is protected by the
    // minimum and the undated block is never a candidate: no rotation.
    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.toBeNull();
    const remaining = await readFile(memoryFilePath(stellaDataDir), "utf-8");
    for (let i = 0; i < MEMORY_ROTATION_MIN_ACTIVE_BLOCKS; i += 1) {
      expect(remaining).toContain(`keep-${i} matters`);
    }
    expect(remaining).toContain("Undated operational note");
  });

  it("drains the in-file Archive section first", async () => {
    const active = Array.from({ length: 6 }, (_, i) =>
      block(`2026-07-0${i + 1}`, `active-${i}`, 30_000),
    ).reverse();
    const staged = [
      block("2026-04-02", "staged-stale-a", 60_000),
      block("2026-04-03", "staged-stale-b", 60_000),
    ];
    await writeMemoryFile(
      buildMemoryFile({ activeBlocks: active, archiveBlocks: staged }),
    );

    const result = await rotateMemoryFileIfNeeded(stellaDataDir);
    expect(result).not.toBeNull();
    const remaining = await readFile(memoryFilePath(stellaDataDir), "utf-8");
    expect(remaining).not.toContain("staged-stale-a matters");
    expect(remaining).not.toContain("staged-stale-b matters");
    const q2 = await readFile(
      path.join(memoryArchiveRoot(stellaDataDir), "MEMORY-2026-Q2.md"),
      "utf-8",
    );
    expect(q2).toContain("staged-stale-a matters");
    expect(q2).toContain("staged-stale-b matters");
  });

  it("refuses to rewrite a file whose ACTIVE anchors are missing", async () => {
    const content = buildMemoryFile({
      activeBlocks: [block("2026-05-01", "big", 400_000)],
      withAnchors: false,
    });
    await writeMemoryFile(content);
    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.toBeNull();
    await expect(readFile(memoryFilePath(stellaDataDir), "utf-8")).resolves.toBe(
      content,
    );
  });

  it("does not duplicate a block already present in its archive (crash re-run)", async () => {
    const old = block("2026-05-01", "crash-survivor", 200_000);
    const fresh = Array.from({ length: 6 }, (_, i) =>
      block(`2026-07-0${i + 1}`, `fresh-${i}`, 30_000),
    ).reverse();
    await writeMemoryFile(buildMemoryFile({ activeBlocks: [...fresh, old] }));
    // Simulate the crash-window state: the block was already appended to its
    // archive, but the active rewrite never happened.
    const archiveDir = memoryArchiveRoot(stellaDataDir);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, "MEMORY-2026-Q2.md"),
      `# MEMORY archive — 2026-Q2\n\n${old}\n`,
      "utf-8",
    );

    const result = await rotateMemoryFileIfNeeded(stellaDataDir);
    expect(result).not.toBeNull();
    const archived = await readFile(
      path.join(archiveDir, "MEMORY-2026-Q2.md"),
      "utf-8",
    );
    const occurrences = archived.split("crash-survivor matters").length - 1;
    expect(occurrences).toBe(1);
    const remaining = await readFile(memoryFilePath(stellaDataDir), "utf-8");
    expect(remaining).not.toContain("crash-survivor matters");
  });

  it("a rename failure at the active rewrite leaves MEMORY.md byte-intact, no temp litter, and a clean re-run recovers", async () => {
    const blocks = Array.from({ length: 16 }, (_, i) =>
      block(`2026-06-${String(i + 1).padStart(2, "0")}`, `crash-${i}`, 25_000),
    ).reverse();
    const before = buildMemoryFile({ activeBlocks: blocks });
    await writeMemoryFile(before);

    const realRename = fsp.rename;
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      // Fail only the active-file replacement; archive appends succeed —
      // exactly the copy-first crash window.
      if (String(to).endsWith(`${path.sep}MEMORY.md`)) {
        throw new Error("injected rename failure");
      }
      return realRename(from as never, to as never);
    });
    try {
      await expect(rotateMemoryFileIfNeeded(stellaDataDir)).rejects.toThrow(
        "injected rename failure",
      );
    } finally {
      spy.mockRestore();
    }

    // Old bytes whole (not truncated mid-rewrite), archives already hold
    // the copies, and the failed temp file was cleaned up.
    await expect(readFile(memoryFilePath(stellaDataDir), "utf-8")).resolves.toBe(
      before,
    );
    const archives = await listMemoryArchiveFiles(stellaDataDir);
    expect(archives.length).toBeGreaterThan(0);
    const memoriesEntries = await readdir(path.join(stellaDataDir, "memories"));
    expect(memoriesEntries.filter((name) => name.includes(".tmp-"))).toEqual([]);

    // Crash recovery: the re-run rotates without duplicating archived blocks.
    const result = await rotateMemoryFileIfNeeded(stellaDataDir);
    expect(result).not.toBeNull();
    const archived = (
      await Promise.all(
        (await listMemoryArchiveFiles(stellaDataDir)).map((name) =>
          readFile(path.join(memoryArchiveRoot(stellaDataDir), name), "utf-8"),
        ),
      )
    ).join("\n");
    expect(archived.split("crash-0 matters").length - 1).toBe(1);
  });

  it("refuses when an anchor literal is duplicated inside block content", async () => {
    const rogue = [
      "## 2026-06-01 12:00 — rogue",
      "Outcome: quotes the anchor literal <!-- DREAM:ACTIVE_BLOCKS_END --> verbatim.",
      `Padding: ${"x".repeat(320_000)}`,
    ].join("\n");
    const content = buildMemoryFile({
      activeBlocks: [block("2026-07-01", "fine", 1_000), rogue],
    });
    await writeMemoryFile(content);
    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.toBeNull();
    await expect(readFile(memoryFilePath(stellaDataDir), "utf-8")).resolves.toBe(
      content,
    );
  });

  it("preserves blank-line runs inside kept blocks (junction-only whitespace normalization)", async () => {
    const keptWithGaps = [
      "## 2026-07-18 12:00 — gapped",
      "Outcome: keep this",
      "",
      "",
      "",
      "Tail after a triple blank-line run",
    ].join("\n");
    const fresh = Array.from({ length: 5 }, (_, i) =>
      block(`2026-07-1${i}`, `fresh-${i}`, 1_000),
    ).reverse();
    const old = Array.from({ length: 8 }, (_, i) =>
      block(`2026-05-0${i + 1}`, `old-${i}`, 45_000),
    ).reverse();
    await writeMemoryFile(
      buildMemoryFile({ activeBlocks: [keptWithGaps, ...fresh, ...old] }),
    );

    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.not.toBeNull();
    const remaining = await readFile(memoryFilePath(stellaDataDir), "utf-8");
    expect(remaining).toContain(
      "Outcome: keep this\n\n\n\nTail after a triple blank-line run",
    );
  });

  it("never touches injected surfaces (memory_map.md bytes are stable across rotation)", async () => {
    const mapContent = "<!-- DREAM:MAP_CHARTER x -->\n# Memory map\n- route\n";
    await writeFile(memoryMapPath(stellaDataDir), mapContent, "utf-8");
    const blocks = Array.from({ length: 16 }, (_, i) =>
      block(`2026-06-${String(i + 1).padStart(2, "0")}`, `b-${i}`, 25_000),
    ).reverse();
    await writeMemoryFile(buildMemoryFile({ activeBlocks: blocks }));

    await expect(rotateMemoryFileIfNeeded(stellaDataDir)).resolves.not.toBeNull();
    await expect(readFile(memoryMapPath(stellaDataDir), "utf-8")).resolves.toBe(
      mapContent,
    );
  });
});

describe("appendSupersededMemoryText", () => {
  it("journals removed text under a dated heading, creating the file with its header", async () => {
    await appendSupersededMemoryText(
      stellaDataDir,
      "## 2026-07-10 — old block\nOutcome: replaced wording",
    );
    const journal = await readFile(
      memorySupersededArchivePath(stellaDataDir),
      "utf-8",
    );
    expect(journal).toContain("# MEMORY superseded-text journal");
    expect(journal).toMatch(/## superseded \d{4}-\d{2}-\d{2}T/);
    expect(journal).toContain("Outcome: replaced wording");
  });

  it("appends subsequent entries without clobbering earlier ones", async () => {
    await appendSupersededMemoryText(stellaDataDir, "first removed span");
    await appendSupersededMemoryText(stellaDataDir, "second removed span");
    const journal = await readFile(
      memorySupersededArchivePath(stellaDataDir),
      "utf-8",
    );
    expect(journal).toContain("first removed span");
    expect(journal).toContain("second removed span");
  });

  it("ignores whitespace-only removals", async () => {
    await appendSupersededMemoryText(stellaDataDir, "   \n  ");
    await expect(
      readFile(memorySupersededArchivePath(stellaDataDir), "utf-8"),
    ).rejects.toThrow();
  });
});
