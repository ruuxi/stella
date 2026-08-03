import { promises as fs } from "node:fs";
import path from "node:path";

import { isBlockedPath } from "./command-safety.js";
import type { ToolContext, ToolResult } from "./types.js";
import { expandHomePath } from "./utils.js";
import {
  withFileWriteLock,
  withFileWriteLocks,
  writeFileWithNulGuard,
} from "./file-write-lock.js";
import {
  type FileChangeRecord,
  fileChange,
} from "../../contracts/file-changes.js";

type FileOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      hunks: Hunk[];
    };

type Hunk = {
  header?: string;
  lines: HunkLine[];
  isEndOfFile?: boolean;
};

type HunkLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

/**
 * Paths in the envelope are home-expanded (~, $HOME, %USERPROFILE%) but must
 * be absolute — the file tools no longer resolve paths against any working
 * directory. Raw paths are kept during parse so self-mod path inference can
 * still read them; the absolute-path requirement is enforced in resolveOp.
 * Empty paths are rejected.
 */
const normalizeRawPath = (raw: string): string => {
  const expanded = expandHomePath(raw.trim());
  if (!expanded) throw new Error("apply_patch requires a file path.");
  return expanded;
};

const requireAbsolutePatchPath = (raw: string): string => {
  // Paths in the envelope are already home-expanded during parse.
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `File tool paths must be absolute. Received relative path '${raw}'. ` +
        `Pass a full absolute path (e.g. /Users/you/projects/foo/bar.ts); ` +
        `the file tools do not resolve relative to the shell's working directory.`,
    );
  }
  return path.resolve(raw);
};

// ----------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------

/**
 * Some models wrap their `apply_patch` argument in a shell heredoc
 * (`<<EOF\n*** Begin Patch\n...\nEOF`). Stella strips that wrapper before
 * parsing.
 */
const stripHeredocWrapper = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length < 4) return text;
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  const isOpen =
    first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
  if (isOpen && last.endsWith("EOF")) {
    return lines.slice(1, lines.length - 1).join("\n");
  }
  return text;
};

const parsePatch = (input: string): FileOp[] => {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  const text = stripHeredocWrapper(normalized);
  const lines = text.split("\n");
  let i = 0;
  if ((lines[i] ?? "").trim() !== "*** Begin Patch") {
    throw new Error("apply_patch input must start with `*** Begin Patch`.");
  }
  i++;

  const ops: FileOp[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "*** End Patch") {
      i++;
      return ops;
    }
    if (line.startsWith("*** Add File: ")) {
      const filePath = normalizeRawPath(line.slice("*** Add File: ".length));
      i++;
      const collected: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.startsWith("*** ")) break;
        if (!next.startsWith("+")) {
          throw new Error(
            `apply_patch: lines under '*** Add File: ${filePath}' must start with '+'. Saw: '${next}'`,
          );
        }
        collected.push(next.slice(1));
        i++;
      }
      ops.push({ kind: "add", path: filePath, lines: collected });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const filePath = normalizeRawPath(line.slice("*** Delete File: ".length));
      ops.push({ kind: "delete", path: filePath });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = normalizeRawPath(line.slice("*** Update File: ".length));
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith("*** Move to: ")) {
        moveTo = normalizeRawPath(lines[i]!.slice("*** Move to: ".length));
        i++;
      }
      const hunks: Hunk[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.startsWith("*** ") && next !== "*** End of File") break;
        if (next.trim() === "") {
          // Skip blank separators between chunks. Blank lines INSIDE a chunk
          // are consumed by the chunk-collection loop below as context lines.
          i++;
          continue;
        }

        const hunk: Hunk = { lines: [] };
        if (next.startsWith("@@")) {
          const header = next.slice(2).trim();
          if (header) hunk.header = header;
          i++;
        } else if (hunks.length > 0) {
          // Subsequent chunks must start with @@; only the first chunk may
          // omit the header.
          throw new Error(
            `apply_patch: expected '@@' header inside Update File '${filePath}'. Saw: '${next}'`,
          );
        }
        // First chunk may omit @@; fall through and start collecting diff lines.

        while (i < lines.length) {
          const candidate = lines[i] ?? "";
          if (candidate === "*** End of File") {
            hunk.isEndOfFile = true;
            i++;
            break;
          }
          if (candidate.startsWith("*** ")) break;
          if (candidate.startsWith("@@")) break;
          if (candidate === "") {
            hunk.lines.push({ kind: "context", text: "" });
            i++;
            continue;
          }
          const head = candidate[0];
          const body = candidate.slice(1);
          if (head === "+") hunk.lines.push({ kind: "add", text: body });
          else if (head === "-")
            hunk.lines.push({ kind: "remove", text: body });
          else if (head === " ")
            hunk.lines.push({ kind: "context", text: body });
          else {
            throw new Error(
              `apply_patch: hunk lines must start with '+', '-', or ' '. Saw: '${candidate}'`,
            );
          }
          i++;
        }

        if (hunk.lines.length === 0 && !hunk.isEndOfFile) {
          throw new Error(
            `apply_patch: empty hunk inside Update File '${filePath}'.`,
          );
        }
        hunks.push(hunk);
      }
      if (hunks.length === 0) {
        throw new Error(`apply_patch: Update File '${filePath}' has no hunks.`);
      }
      ops.push({
        kind: "update",
        path: filePath,
        ...(moveTo ? { moveTo } : {}),
        hunks,
      });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    throw new Error(`apply_patch: unexpected line outside of an op: '${line}'`);
  }
  throw new Error("apply_patch: missing `*** End Patch` terminator.");
};

// ----------------------------------------------------------------------------
// Tolerant context matching
// ----------------------------------------------------------------------------

/**
 * Common typographic look-alikes folded to ASCII so patches authored against
 * straight ASCII can still match source containing dashes, curly quotes, NBSP,
 * etc. This keeps patch matching stable across typographic look-alikes.
 */
const fuzzyChar = (ch: string): string => {
  switch (ch) {
    case "\u2010":
    case "\u2011":
    case "\u2012":
    case "\u2013":
    case "\u2014":
    case "\u2015":
    case "\u2212":
      return "-";
    case "\u2018":
    case "\u2019":
    case "\u201A":
    case "\u201B":
      return "'";
    case "\u201C":
    case "\u201D":
    case "\u201E":
    case "\u201F":
      return '"';
    case "\u00A0":
    case "\u2002":
    case "\u2003":
    case "\u2004":
    case "\u2005":
    case "\u2006":
    case "\u2007":
    case "\u2008":
    case "\u2009":
    case "\u200A":
    case "\u202F":
    case "\u205F":
    case "\u3000":
      return " ";
    default:
      return ch;
  }
};

const fuzzyNormalize = (text: string): string => {
  let out = "";
  for (const ch of text.trim()) out += fuzzyChar(ch);
  return out;
};

const matchExact = (
  lines: string[],
  pattern: string[],
  at: number,
): boolean => {
  for (let j = 0; j < pattern.length; j++) {
    if (lines[at + j] !== pattern[j]) return false;
  }
  return true;
};

const matchTrimEnd = (
  lines: string[],
  pattern: string[],
  at: number,
): boolean => {
  for (let j = 0; j < pattern.length; j++) {
    if ((lines[at + j] ?? "").trimEnd() !== (pattern[j] ?? "").trimEnd()) {
      return false;
    }
  }
  return true;
};

const matchTrim = (lines: string[], pattern: string[], at: number): boolean => {
  for (let j = 0; j < pattern.length; j++) {
    if ((lines[at + j] ?? "").trim() !== (pattern[j] ?? "").trim()) {
      return false;
    }
  }
  return true;
};

const matchFuzzy = (
  lines: string[],
  pattern: string[],
  at: number,
): boolean => {
  for (let j = 0; j < pattern.length; j++) {
    if (
      fuzzyNormalize(lines[at + j] ?? "") !== fuzzyNormalize(pattern[j] ?? "")
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Locate `pattern` inside `lines` starting at or after `start`. Tries four
 * progressively more lenient strategies (exact → rstrip → trim → unicode).
 * When `eof` is true the search is biased to the end of `lines`.
 *
 * Returns the matching start index, or -1 when no strategy locates it.
 */
const seekSequence = (
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number => {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return -1;

  const searchStart = eof ? lines.length - pattern.length : start;
  const upper = lines.length - pattern.length;

  for (let i = searchStart; i <= upper; i++) {
    if (matchExact(lines, pattern, i)) return i;
  }
  for (let i = searchStart; i <= upper; i++) {
    if (matchTrimEnd(lines, pattern, i)) return i;
  }
  for (let i = searchStart; i <= upper; i++) {
    if (matchTrim(lines, pattern, i)) return i;
  }
  for (let i = searchStart; i <= upper; i++) {
    if (matchFuzzy(lines, pattern, i)) return i;
  }
  return -1;
};

const findExactSequenceLocations = (
  lines: string[],
  pattern: string[],
): number[] => {
  if (pattern.length === 0 || pattern.length > lines.length) return [];
  const locations: number[] = [];
  const upper = lines.length - pattern.length;
  for (let index = 0; index <= upper; index += 1) {
    if (matchExact(lines, pattern, index)) locations.push(index);
  }
  return locations;
};

const isAlreadyAppliedHunk = (
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
): boolean => {
  const newText = newLines.join("\n");
  if (newText.length < 8 || newLines.length === 0) return false;
  return (
    findExactSequenceLocations(fileLines, newLines).length > 0 &&
    findExactSequenceLocations(fileLines, oldLines).length === 0
  );
};

const visualizeLeadingWhitespace = (line: string): string => {
  const leading = line.match(/^[\t ]*/)?.[0] ?? "";
  const visible = leading.replaceAll("\t", "→").replaceAll(" ", "·");
  return `${visible}${line.slice(leading.length)}`;
};

const formatLineSnippet = (line: string): string => {
  const compact = line.trim().replace(/\s+/g, " ");
  return compact.length > 100 ? `${compact.slice(0, 100)}…` : compact;
};

const buildPatchMissHint = (
  fileLines: string[],
  expectedLines: string[],
): string => {
  const anchors = expectedLines
    .map((line) => ({ line, normalized: fuzzyNormalize(line) }))
    .filter((entry) => entry.normalized.length >= 4)
    .sort((left, right) => right.normalized.length - left.normalized.length);
  const fallbackAnchor = anchors[0];
  if (!fallbackAnchor) {
    return "Re-read the file and retry with a non-empty, unique context anchor.";
  }

  let anchor = fallbackAnchor;
  let locations: number[] = [];
  for (const candidate of anchors) {
    const candidateLocations: number[] = [];
    for (let index = 0; index < fileLines.length; index += 1) {
      if (fuzzyNormalize(fileLines[index] ?? "") === candidate.normalized) {
        candidateLocations.push(index);
      }
    }
    if (candidateLocations.length > 0) {
      anchor = candidate;
      locations = candidateLocations;
      break;
    }
  }

  const parts: string[] = [];
  if (locations.length > 0) {
    const shown = locations
      .slice(0, 5)
      .map(
        (index) =>
          `L${index + 1}: ${formatLineSnippet(fileLines[index] ?? "")}`,
      );
    parts.push(
      `Matching anchor location${locations.length === 1 ? "" : "s"}:\n${shown.join("\n")}` +
        (locations.length > shown.length
          ? `\n… and ${locations.length - shown.length} more.`
          : ""),
    );
  }

  const whitespaceLocation = locations.find(
    (index) =>
      (fileLines[index] ?? "").trim() === anchor.line.trim() &&
      fileLines[index] !== anchor.line,
  );
  if (whitespaceLocation !== undefined) {
    parts.push(
      [
        "Leading whitespace differs:",
        `file has: ${visualizeLeadingWhitespace(fileLines[whitespaceLocation] ?? "")}`,
        `you sent: ${visualizeLeadingWhitespace(anchor.line)}`,
      ].join("\n"),
    );
  }

  parts.push(
    locations.length > 0
      ? "Re-read around those lines and retry with the exact surrounding context."
      : "No matching anchor line was found. Re-read the file and retry with current context.",
  );
  return parts.join("\n\n");
};

// ----------------------------------------------------------------------------
// File operations
// ----------------------------------------------------------------------------

const oldLinesOf = (hunk: Hunk): string[] =>
  hunk.lines.filter((entry) => entry.kind !== "add").map((entry) => entry.text);

const newLinesOf = (hunk: Hunk): string[] =>
  hunk.lines
    .filter((entry) => entry.kind !== "remove")
    .map((entry) => entry.text);

type Replacement = { startIdx: number; oldLen: number; newLines: string[] };

type ReplacementPlan = {
  replacements: Replacement[];
  alreadyAppliedHunks: number;
};

const computeReplacements = (
  fileLines: string[],
  hunks: Hunk[],
  filePath: string,
): ReplacementPlan => {
  const replacements: Replacement[] = [];
  let alreadyAppliedHunks = 0;
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.header) {
      // Per-chunk pre-seek: locate the @@ header line and advance the cursor
      // past it. Lets repeated context (e.g. several `}` blocks) be
      // disambiguated by the model with @@ class Foo / @@ def bar.
      const headerIdx = seekSequence(fileLines, [hunk.header], cursor, false);
      if (headerIdx === -1) {
        throw new Error(
          `apply_patch: failed to find context '${hunk.header}' in ${filePath}.\n\n${buildPatchMissHint(fileLines, [hunk.header])}`,
        );
      }
      cursor = headerIdx + 1;
    }

    const oldLines = oldLinesOf(hunk);
    const newLines = newLinesOf(hunk);

    if (oldLines.length === 0) {
      // Pure addition with no anchor: append at end of file (we already
      // stripped the trailing empty line, so fileLines.length is the right
      // insertion point).
      const insertionIdx = fileLines.length;
      replacements.push({ startIdx: insertionIdx, oldLen: 0, newLines });
      cursor = insertionIdx;
      continue;
    }

    let pattern = oldLines;
    let replacementLines = newLines;
    let found = seekSequence(
      fileLines,
      pattern,
      cursor,
      hunk.isEndOfFile === true,
    );

    // Retry: if the pattern's last line is the empty sentinel that
    // represents the file's terminating newline, drop it (and the matching
    // empty in the replacement) and search again.
    if (found === -1 && pattern[pattern.length - 1] === "") {
      const trimmedPattern = pattern.slice(0, -1);
      const trimmedReplacement =
        replacementLines[replacementLines.length - 1] === ""
          ? replacementLines.slice(0, -1)
          : replacementLines;
      const retry = seekSequence(
        fileLines,
        trimmedPattern,
        cursor,
        hunk.isEndOfFile === true,
      );
      if (retry !== -1) {
        pattern = trimmedPattern;
        replacementLines = trimmedReplacement;
        found = retry;
      }
    }

    if (found === -1) {
      if (isAlreadyAppliedHunk(fileLines, pattern, replacementLines)) {
        alreadyAppliedHunks += 1;
        continue;
      }
      throw new Error(
        `apply_patch: failed to find expected lines in ${filePath}:\n${oldLines.join("\n")}\n\n${buildPatchMissHint(fileLines, oldLines)}`,
      );
    }
    replacements.push({
      startIdx: found,
      oldLen: pattern.length,
      newLines: replacementLines,
    });
    cursor = found + pattern.length;
  }

  return { replacements, alreadyAppliedHunks };
};

const applyReplacements = (
  fileLines: string[],
  replacements: Replacement[],
): string[] => {
  // Apply in reverse order so earlier replacements don't shift later positions.
  const sorted = [...replacements].sort((a, b) => a.startIdx - b.startIdx);
  for (let r = sorted.length - 1; r >= 0; r--) {
    const { startIdx, oldLen, newLines } = sorted[r]!;
    fileLines.splice(startIdx, oldLen, ...newLines);
  }
  return fileLines;
};

const applyUpdate = async (
  op: Extract<FileOp, { kind: "update" }>,
  context?: ToolContext,
) => {
  const block = isBlockedPath(op.path, context);
  if (block) throw new Error(block);

  const lockPaths = op.moveTo ? [op.path, op.moveTo] : [op.path];
  // Read → apply hunks → write happens under the per-path lock so a
  // concurrent Edit/Write/apply_patch of the same file can't interleave.
  return withFileWriteLocks(lockPaths, async () => {
    let original: string;
    try {
      original = await fs.readFile(op.path, "utf-8");
    } catch {
      throw new Error(`apply_patch: file not found for Update: ${op.path}`);
    }

    const trailingNewline = original.endsWith("\n");
    let fileLines = original.split("\n");
    if (trailingNewline) {
      fileLines = fileLines.slice(0, -1);
    }

    const plan = computeReplacements(fileLines, op.hunks, op.path);
    if (plan.replacements.length === 0 && plan.alreadyAppliedHunks > 0) {
      return {
        kind: "noop" as const,
        path: op.path,
        note: `Patch already applied to ${op.path}; no write was needed.`,
      };
    }
    fileLines = applyReplacements(fileLines, plan.replacements);

    let newContent = fileLines.join("\n");
    if (trailingNewline) newContent += "\n";

    const targetPath = op.moveTo ?? op.path;
    if (op.moveTo) {
      const moveBlock = isBlockedPath(op.moveTo, context);
      if (moveBlock) throw new Error(moveBlock);
      await fs.mkdir(path.dirname(op.moveTo), { recursive: true });
      await writeFileWithNulGuard(op.moveTo, newContent);
      if (op.moveTo !== op.path) {
        try {
          await fs.unlink(op.path);
        } catch {
          throw new Error(
            `apply_patch: failed to remove original '${op.path}' after move to '${op.moveTo}'.`,
          );
        }
      }
    } else {
      await writeFileWithNulGuard(op.path, newContent);
    }

    return {
      kind: "update" as const,
      path: op.path,
      ...(op.moveTo ? { movedTo: op.moveTo } : {}),
      written: targetPath,
    };
  });
};

const applyAdd = async (
  op: Extract<FileOp, { kind: "add" }>,
  context?: ToolContext,
) => {
  const block = isBlockedPath(op.path, context);
  if (block) throw new Error(block);
  return withFileWriteLock(op.path, async () => {
    await fs.mkdir(path.dirname(op.path), { recursive: true });
    const content = op.lines.join("\n") + (op.lines.length > 0 ? "\n" : "");
    await writeFileWithNulGuard(op.path, content, { flag: "wx" });
    return { kind: "add" as const, path: op.path };
  });
};

const applyDelete = async (
  op: Extract<FileOp, { kind: "delete" }>,
  context?: ToolContext,
) => {
  const block = isBlockedPath(op.path, context);
  if (block) throw new Error(block);
  return withFileWriteLock(op.path, async () => {
    await fs.unlink(op.path);
    return { kind: "delete" as const, path: op.path };
  });
};

export const extractApplyPatchTargetPaths = (patch: string): string[] =>
  parsePatch(patch).flatMap((op) => {
    if (op.kind === "add" || op.kind === "delete") {
      return [op.path];
    }
    return op.moveTo ? [op.path, op.moveTo] : [op.path];
  });

const isPathInsideRoot = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const ensurePatchOpsWithinRoot = (
  ops: FileOp[],
  root: string,
): ToolResult | null => {
  const normalizedRoot = path.resolve(root);
  for (const op of ops) {
    if (!isPathInsideRoot(path.resolve(op.path), normalizedRoot)) {
      return {
        error: `apply_patch path is outside the shared session workspace: ${op.path}`,
      };
    }
    if (
      "moveTo" in op &&
      op.moveTo &&
      !isPathInsideRoot(path.resolve(op.moveTo), normalizedRoot)
    ) {
      return {
        error: `apply_patch move target is outside the shared session workspace: ${op.moveTo}`,
      };
    }
  }
  return null;
};

const resolveOp = <T extends FileOp>(op: T): T => {
  if (op.kind === "update") {
    return {
      ...op,
      path: requireAbsolutePatchPath(op.path),
      ...(op.moveTo ? { moveTo: requireAbsolutePatchPath(op.moveTo) } : {}),
    } as T;
  }
  return { ...op, path: requireAbsolutePatchPath(op.path) } as T;
};

export const handleApplyPatch = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  // Stella's JSON tool uses `input`; Convex/device paths may send `patch`.
  const patch = String(args.input ?? args.patch ?? "").trim();
  if (!patch) {
    return { error: "apply_patch requires a patch envelope." };
  }

  try {
    const ops = parsePatch(patch).map((op) => resolveOp(op));
    if (context?.toolWorkspaceRoot && context.toolWorkspaceRoot.trim()) {
      const scopeError = ensurePatchOpsWithinRoot(
        ops,
        context.toolWorkspaceRoot,
      );
      if (scopeError) return scopeError;
    }
    const results: Array<{
      kind: string;
      path: string;
      movedTo?: string;
      note?: string;
    }> = [];
    for (const op of ops) {
      switch (op.kind) {
        case "add":
          results.push(await applyAdd(op, context));
          break;
        case "update":
          results.push(await applyUpdate(op, context));
          break;
        case "delete":
          results.push(await applyDelete(op, context));
          break;
        default:
          break;
      }
    }
    const fileChanges = results
      .map(applyPatchResultToFileChange)
      .filter((entry): entry is FileChangeRecord => entry != null);
    return {
      result: { results },
      details: { results },
      ...(fileChanges.length > 0 ? { fileChanges } : {}),
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

const applyPatchResultToFileChange = (entry: {
  kind: string;
  path: string;
  movedTo?: string;
}): FileChangeRecord | null => {
  switch (entry.kind) {
    case "add":
      return fileChange(entry.path, { type: "add" });
    case "delete":
      return fileChange(entry.path, { type: "delete" });
    case "update":
      return fileChange(entry.path, {
        type: "update",
        ...(entry.movedTo ? { move_path: entry.movedTo } : {}),
      });
    default:
      return null;
  }
};
