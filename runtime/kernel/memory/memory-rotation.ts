/**
 * MEMORY.md lifecycle — size-triggered rotation and superseded-text
 * preservation (design review §6.2d / migration step "MEMORY.md
 * supersede/rotation lifecycle").
 *
 * Two mechanisms, both write-only against `~/.stella/memories/archive/`:
 *
 *  1. Rotation: when the active MEMORY.md exceeds
 *     {@link MEMORY_ROTATION_THRESHOLD_BYTES}, the oldest blocks move into
 *     period-named archive files (`archive/MEMORY-2026-Q2.md`, named for each
 *     block's own date). Size is the trigger — the constraint being managed
 *     is Dream's editable working set and Recall's eager-seed head, not
 *     calendar time — and period-derived names keep archives date-greppable.
 *     Rotation is additive and copy-first: a block is appended to its archive
 *     file (and the append verified) before it is ever removed from
 *     MEMORY.md, and both the appends and the active rewrite are atomic
 *     temp+rename replacements — a crash at any point leaves whole files,
 *     so it can only duplicate, never lose or truncate.
 *     Archives join Recall's memory sources, so rotation never hides content
 *     from retrieval; it only bounds the active file.
 *
 *  2. Superseded-text preservation: the Dream StrReplace jail calls
 *     {@link appendSupersededMemoryText} BEFORE any MEMORY.md edit that
 *     removes text from the file (the supersede-don't-append rule tells
 *     Dream to rewrite a workstream's block in place; the journal is what
 *     makes that non-destructive mechanically, independent of prompt
 *     compliance). If the journal write fails, the jail rejects the edit —
 *     no destructive write ever lands without its preserved copy.
 *
 * Neither mechanism touches an injected surface: MEMORY.md is never resident
 * (Recall-only), and rotation never writes memory_map.md, profile.md, or any
 * pinned startup doc — the live prompt prefix is byte-stable through both.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  withFileWriteLock,
  writeFileAtomicWithVerify,
} from "../tools/file-write-lock.js";
import { memoriesRoot, memoryFilePath } from "./dream-storage.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("memory.memory-rotation");

export const MEMORY_ARCHIVE_DIR_NAME = "archive";

/**
 * Rotation trigger (~300KB — design review §6.2d: "size is the honest
 * trigger"), measured in UTF-8 bytes of the on-disk active file.
 */
export const MEMORY_ROTATION_THRESHOLD_BYTES = 300_000;

/**
 * Rotation low-water target. Rotating only to just-under-threshold would
 * re-trigger on nearly every Dream pass; rotating down to ~80% amortizes one
 * rotation across many passes while keeping the newest ~240KB active.
 */
export const MEMORY_ROTATION_TARGET_BYTES = 240_000;

/**
 * Never rotate the active section below this many dated blocks, regardless
 * of size — the newest blocks are the working set Dream supersedes in place
 * and the checkpoint references by title; an active file that rotated to
 * empty would defeat both.
 */
export const MEMORY_ROTATION_MIN_ACTIVE_BLOCKS = 5;

/** Journal of text removed from MEMORY.md by Dream edits (supersede rule). */
export const MEMORY_SUPERSEDED_ARCHIVE_FILE = "MEMORY-superseded.md";

export const memoryArchiveRoot = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_ARCHIVE_DIR_NAME);

export const memorySupersededArchivePath = (stellaDataDir: string): string =>
  path.join(memoryArchiveRoot(stellaDataDir), MEMORY_SUPERSEDED_ARCHIVE_FILE);

/** Period-named archive file for a block date: `MEMORY-2026-Q2.md`. */
export const archiveFileNameForBlockDate = (isoDate: string): string => {
  const [year, month] = isoDate.split("-");
  const quarter = Math.floor((Number(month) - 1) / 3) + 1;
  return `MEMORY-${year}-Q${quarter}.md`;
};

/** Archive markdown files, sorted by name; [] when the dir does not exist. */
export const listMemoryArchiveFiles = async (
  stellaDataDir: string,
): Promise<string[]> => {
  try {
    const names = await fs.readdir(memoryArchiveRoot(stellaDataDir));
    return names.filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
};

const ACTIVE_START = "<!-- DREAM:ACTIVE_BLOCKS_START -->";
const ACTIVE_END = "<!-- DREAM:ACTIVE_BLOCKS_END -->";
const ARCHIVE_START = "<!-- DREAM:ARCHIVE_START -->";
const ARCHIVE_END = "<!-- DREAM:ARCHIVE_END -->";

const BLOCK_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/u;

const archiveFileHeader = (fileName: string): string =>
  [
    `# MEMORY archive — ${fileName.replace(/^MEMORY-|\.md$/gu, "")}`,
    "",
    "> Blocks rotated out of the active MEMORY.md by size-triggered rotation.",
    "> Recall greps this file like the active ledger; it is read-only for",
    "> Dream — nothing here is ever edited or deleted.",
    "",
  ].join("\n");

const supersededFileHeader = (): string =>
  [
    "# MEMORY superseded-text journal",
    "",
    "> Text removed from MEMORY.md by Dream edits (the supersede-don't-append",
    "> rule rewrites a workstream's block in place; the replaced wording is",
    "> preserved here automatically before the edit lands). Recall greps this",
    "> file; it is read-only for Dream.",
    "",
  ].join("\n");

/**
 * Lock/write keys must be the REAL path so they serialize with the Dream
 * StrReplace jail, which realpaths its targets — on a symlinked data dir
 * the unresolved and resolved strings would otherwise take different
 * per-path locks. Missing files (a not-yet-created archive) resolve their
 * parent directory instead, which exists by the time this is called.
 */
const resolveLockPath = async (target: string): Promise<string> => {
  try {
    return await fs.realpath(target);
  } catch {
    try {
      return path.join(
        await fs.realpath(path.dirname(target)),
        path.basename(target),
      );
    } catch {
      return path.resolve(target);
    }
  }
};

/**
 * Append text to an archive file under its write lock, creating it with a
 * header when missing. Skips the append when the text is already present
 * (the crash-between-append-and-rewrite dedupe for rotation; containment
 * rather than exact-entry matching — a block that is a substring of an
 * existing entry is treated as already preserved, which can only ever skip
 * a redundant copy, never lose one). The rewrite is atomic (temp+rename+
 * verify), so a crash mid-append can never damage earlier entries.
 * Throws on failure — callers decide whether that blocks a destructive step.
 */
const appendToArchiveFile = async (
  filePath: string,
  header: string,
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const resolved = await resolveLockPath(filePath);
  await withFileWriteLock(resolved, async () => {
    let existing: string | null = null;
    try {
      existing = await fs.readFile(resolved, "utf-8");
    } catch {
      existing = null;
    }
    if (existing !== null && existing.includes(text.trim())) {
      return;
    }
    const base = existing ?? header;
    await writeFileAtomicWithVerify(
      resolved,
      `${base.replace(/\n*$/u, "")}\n\n${text.trim()}\n`,
    );
  });
};

/**
 * Preserve text a Dream MEMORY.md edit is about to remove. MUST complete
 * before the removing write is applied; a thrown error here is the jail's
 * signal to reject the edit ("no destructive operation without a preserved,
 * reachable copy").
 */
export const appendSupersededMemoryText = async (
  stellaDataDir: string,
  removedText: string,
): Promise<void> => {
  const trimmed = removedText.trim();
  if (!trimmed) return;
  const entry = `## superseded ${new Date().toISOString()}\n${trimmed}`;
  await appendToArchiveFile(
    memorySupersededArchivePath(stellaDataDir),
    supersededFileHeader(),
    entry,
  );
};

type MemoryBlock = {
  /** Exact text span as it appears in the file (trimmed of outer newlines). */
  text: string;
  /** ISO date from the `## YYYY-MM-DD …` heading; undefined = not rotatable. */
  isoDate?: string;
  section: "active" | "archive";
};

type ParsedMemoryFile = {
  raw: string;
  activeBody: string;
  archiveBody: string;
  blocks: MemoryBlock[];
};

const sliceBetween = (
  raw: string,
  startAnchor: string,
  endAnchor: string,
): { body: string } | null => {
  const start = raw.indexOf(startAnchor);
  const end = raw.indexOf(endAnchor);
  if (start === -1 || end === -1 || end < start) return null;
  return { body: raw.slice(start + startAnchor.length, end) };
};

const parseBlocks = (
  body: string,
  section: MemoryBlock["section"],
): MemoryBlock[] => {
  const blocks: MemoryBlock[] = [];
  const lines = body.split("\n");
  let current: string[] | null = null;
  const flush = (): void => {
    if (!current) return;
    const text = current.join("\n").trim();
    if (text) {
      const match = BLOCK_DATE_RE.exec(text);
      blocks.push({
        text,
        ...(match?.[1] ? { isoDate: match[1] } : {}),
        section,
      });
    }
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      current = [line];
      continue;
    }
    if (current) current.push(line);
    // Content before the first heading (anchors aside, there should be none)
    // is left in place untouched — it is simply never a rotation candidate.
  }
  flush();
  return blocks;
};

const countOccurrences = (raw: string, needle: string): number =>
  raw.split(needle).length - 1;

/**
 * Parse the anchored sections of MEMORY.md. Returns null — rotation refuses
 * to rewrite a file it cannot confidently parse (warn-logged; nothing is
 * modified) — when:
 *  - either ACTIVE anchor is missing or the pair is out of order;
 *  - any anchor literal appears more than once (e.g. quoted inside a
 *    block), which would make the index-based section rewrite ambiguous;
 *  - the ARCHIVE pair is half-present, out of order, or overlaps the
 *    active section.
 */
const parseMemoryFile = (raw: string): ParsedMemoryFile | null => {
  for (const anchor of [ACTIVE_START, ACTIVE_END, ARCHIVE_START, ARCHIVE_END]) {
    if (countOccurrences(raw, anchor) > 1) return null;
  }
  const active = sliceBetween(raw, ACTIVE_START, ACTIVE_END);
  if (!active) return null;
  const activeEndIndex = raw.indexOf(ACTIVE_END);
  const archiveStartIndex = raw.indexOf(ARCHIVE_START);
  const archiveEndIndex = raw.indexOf(ARCHIVE_END);
  let archiveBody = "";
  if (archiveStartIndex !== -1 || archiveEndIndex !== -1) {
    if (
      archiveStartIndex === -1 ||
      archiveEndIndex === -1 ||
      archiveEndIndex < archiveStartIndex ||
      archiveStartIndex < activeEndIndex
    ) {
      return null;
    }
    archiveBody = raw.slice(
      archiveStartIndex + ARCHIVE_START.length,
      archiveEndIndex,
    );
  }
  return {
    raw,
    activeBody: active.body,
    archiveBody,
    blocks: [
      ...parseBlocks(archiveBody, "archive"),
      ...parseBlocks(active.body, "active"),
    ],
  };
};

export type MemoryRotationResult = {
  rotatedBlocks: number;
  archiveFiles: string[];
  bytesBefore: number;
  bytesAfter: number;
};

/**
 * Rotate the oldest MEMORY.md blocks into period-named archive files when
 * the active file exceeds the threshold. No-op (null) below the threshold,
 * when the file cannot be parsed, or when nothing is rotatable.
 *
 * Candidate order — oldest signal first:
 *  1. blocks already in the in-file "## Archive" section (Dream staged them
 *     as stale; the section can drain completely), in file order;
 *  2. active-section blocks bottom-up (the ledger is newest-at-top, so the
 *     bottom is the oldest), always keeping the newest
 *     {@link MEMORY_ROTATION_MIN_ACTIVE_BLOCKS} dated blocks.
 * Only blocks with a parseable `## YYYY-MM-DD` heading rotate — an undated
 * block has no period file and stays put (structure is never guessed at).
 *
 * Write order is the data-safety invariant: every selected block is appended
 * to its archive file first (atomic temp+rename with read-back verification;
 * already-present blocks skipped), and only after ALL appends succeed is
 * MEMORY.md rewritten — itself atomically, so a crash mid-rewrite presents
 * either the old file or the new one, never a truncated hybrid that would
 * damage KEPT blocks. Any failure aborts before the rewrite.
 */
export const rotateMemoryFileIfNeeded = async (
  stellaDataDir: string,
): Promise<MemoryRotationResult | null> => {
  const activePath = await resolveLockPath(memoryFilePath(stellaDataDir));
  return await withFileWriteLock(activePath, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(activePath, "utf-8");
    } catch {
      return null;
    }
    const bytesBefore = Buffer.byteLength(raw, "utf-8");
    if (bytesBefore <= MEMORY_ROTATION_THRESHOLD_BYTES) return null;

    const parsed = parseMemoryFile(raw);
    if (!parsed) {
      logger.warn("memory-rotation.unparseable", {
        detail:
          "MEMORY.md exceeds the rotation threshold but its DREAM section anchors are missing, duplicated, out of order, or overlapping; refusing to rewrite it",
        bytes: bytesBefore,
      });
      return null;
    }

    const archiveCandidates = parsed.blocks.filter(
      (block) => block.section === "archive" && block.isoDate,
    );
    const datedActive = parsed.blocks.filter(
      (block) => block.section === "active" && block.isoDate,
    );
    const rotatableActive = datedActive
      .slice(MEMORY_ROTATION_MIN_ACTIVE_BLOCKS)
      .reverse();
    const candidates = [...archiveCandidates, ...rotatableActive];

    const selected: MemoryBlock[] = [];
    let projectedBytes = bytesBefore;
    for (const block of candidates) {
      if (projectedBytes <= MEMORY_ROTATION_TARGET_BYTES) break;
      selected.push(block);
      projectedBytes -= Buffer.byteLength(block.text, "utf-8");
    }
    if (selected.length === 0) return null;

    // Copy-first: land every block in its period archive before the rewrite.
    const byArchiveFile = new Map<string, MemoryBlock[]>();
    for (const block of selected) {
      const fileName = archiveFileNameForBlockDate(block.isoDate!);
      const group = byArchiveFile.get(fileName) ?? [];
      group.push(block);
      byArchiveFile.set(fileName, group);
    }
    for (const [fileName, group] of byArchiveFile) {
      // Chronological within the archive file (oldest first) for greppable
      // reading order regardless of which section a block came from.
      const ordered = [...group].sort((a, b) =>
        a.isoDate!.localeCompare(b.isoDate!),
      );
      const target = path.join(memoryArchiveRoot(stellaDataDir), fileName);
      for (const block of ordered) {
        await appendToArchiveFile(
          target,
          archiveFileHeader(fileName),
          block.text,
        );
      }
    }

    // All copies verified on disk — now (and only now) drop the blocks from
    // the active file. Removal is by exact text span within the anchored
    // section bodies, spliced by index (never String.replace replacements,
    // whose `$`-sequence semantics could corrupt content containing `$&`),
    // so nothing outside the parsed blocks can be touched. Whitespace is
    // normalized only at each splice junction (the newlines that surrounded
    // the removed span collapse to one blank line) — a global newline
    // collapse would mutate runs of blank lines INSIDE kept blocks.
    const removeBlocks = (body: string, section: MemoryBlock["section"]): string => {
      let updated = body;
      for (const block of selected) {
        if (block.section !== section) continue;
        const at = updated.indexOf(block.text);
        if (at === -1) continue;
        const before = updated.slice(0, at).replace(/\n+$/u, "");
        const after = updated
          .slice(at + block.text.length)
          .replace(/^\n+/u, "");
        updated = !before
          ? after
            ? `\n${after}`
            : "\n"
          : after
            ? `${before}\n\n${after}`
            : `${before}\n`;
      }
      return updated;
    };
    const replaceSection = (
      source: string,
      startAnchor: string,
      endAnchor: string,
      newBody: string,
    ): string => {
      const start = source.indexOf(startAnchor);
      const end = source.indexOf(endAnchor);
      if (start === -1 || end === -1 || end < start) return source;
      return (
        source.slice(0, start + startAnchor.length) + newBody + source.slice(end)
      );
    };
    let rewritten = replaceSection(
      parsed.raw,
      ACTIVE_START,
      ACTIVE_END,
      removeBlocks(parsed.activeBody, "active"),
    );
    rewritten = replaceSection(
      rewritten,
      ARCHIVE_START,
      ARCHIVE_END,
      removeBlocks(parsed.archiveBody, "archive"),
    );
    await writeFileAtomicWithVerify(activePath, rewritten);

    const result: MemoryRotationResult = {
      rotatedBlocks: selected.length,
      archiveFiles: [...byArchiveFile.keys()].sort(),
      bytesBefore,
      bytesAfter: Buffer.byteLength(rewritten, "utf-8"),
    };
    logger.info("memory-rotation.rotated", result);
    return result;
  });
};
