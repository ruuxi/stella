/**
 * `apply_patch` — Codex-style text-based diff applier.
 *
 * Format (parser/applier ported from
 * `../projects/codex/codex-rs/apply-patch/apply_patch_tool_instructions.md`):
 *
 *   *** Begin Patch
 *   *** Add File: <abs path>
 *   +<line>
 *   *** Update File: <abs path>
 *   *** Move to: <abs path>
 *   @@ optional context header
 *    context line
 *   -removed line
 *   +added line
 *   *** Delete File: <abs path>
 *   *** End Patch
 *
 * Stella uses absolute paths everywhere. There is no workspace restriction.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { isBlockedPath } from "../../command-safety.js";
import { expandHomePath } from "../../utils.js";
import type { ExecToolDefinition } from "../registry.js";

const APPLY_PATCH_SCHEMA = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description:
        "Patch envelope starting with `*** Begin Patch` and ending with `*** End Patch`. See the Exec description for the grammar.",
    },
  },
  required: ["patch"],
} as const;

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
};

type HunkLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

const ensureAbsolute = (raw: string): string => {
  const expanded = expandHomePath(raw.trim());
  if (!expanded) throw new Error("apply_patch requires absolute file paths.");
  if (!path.isAbsolute(expanded)) {
    throw new Error(`apply_patch requires absolute paths. Got: ${raw}`);
  }
  return expanded;
};

const parsePatch = (input: string): FileOp[] => {
  const text = input.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let i = 0;
  if (!lines[i]?.startsWith("*** Begin Patch")) {
    throw new Error("apply_patch input must start with `*** Begin Patch`.");
  }
  i++;

  const ops: FileOp[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith("*** End Patch")) {
      i++;
      return ops;
    }
    if (line.startsWith("*** Add File: ")) {
      const filePath = ensureAbsolute(line.slice("*** Add File: ".length));
      i++;
      const collected: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.startsWith("*** ")) break;
        if (!next.startsWith("+")) {
          throw new Error(
            `apply_patch: lines under '*** Add File: ${filePath}' must start with '+'. Saw: ${next}`,
          );
        }
        collected.push(next.slice(1));
        i++;
      }
      ops.push({ kind: "add", path: filePath, lines: collected });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const filePath = ensureAbsolute(line.slice("*** Delete File: ".length));
      ops.push({ kind: "delete", path: filePath });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = ensureAbsolute(line.slice("*** Update File: ".length));
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith("*** Move to: ")) {
        moveTo = ensureAbsolute(lines[i]!.slice("*** Move to: ".length));
        i++;
      }
      const hunks: Hunk[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.startsWith("*** ") && !next.startsWith("*** End of File")) {
          break;
        }
        if (next.startsWith("@@")) {
          const header = next.slice(2).trim() || undefined;
          i++;
          const hunk: Hunk = {
            ...(header ? { header } : {}),
            lines: [],
          };
          while (i < lines.length) {
            const candidate = lines[i] ?? "";
            if (
              candidate.startsWith("*** ") &&
              !candidate.startsWith("*** End of File")
            ) {
              break;
            }
            if (candidate.startsWith("@@")) break;
            if (candidate.startsWith("*** End of File")) {
              i++;
              break;
            }
            i++;
            if (candidate === "") {
              hunk.lines.push({ kind: "context", text: "" });
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
          }
          hunks.push(hunk);
          continue;
        }
        // tolerate stray blank lines between operations
        if (next.trim() === "") {
          i++;
          continue;
        }
        throw new Error(
          `apply_patch: expected '@@' or '*** ...' header inside Update File '${filePath}'. Saw: '${next}'`,
        );
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

const findHunkAnchor = (
  fileLines: string[],
  hunk: Hunk,
  startFrom: number,
): number => {
  const anchorLines: string[] = [];
  for (const entry of hunk.lines) {
    if (entry.kind === "add") continue;
    anchorLines.push(entry.text);
  }
  if (anchorLines.length === 0) return startFrom;

  for (let i = startFrom; i <= fileLines.length - anchorLines.length; i++) {
    let match = true;
    for (let j = 0; j < anchorLines.length; j++) {
      if (fileLines[i + j] !== anchorLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
};

const applyHunkAt = (
  fileLines: string[],
  hunk: Hunk,
  anchorIndex: number,
): { newLines: string[]; consumed: number } => {
  let cursor = anchorIndex;
  const newLines = fileLines.slice(0, cursor);
  let consumed = 0;
  for (const entry of hunk.lines) {
    switch (entry.kind) {
      case "context":
        newLines.push(fileLines[cursor] ?? "");
        cursor++;
        consumed++;
        break;
      case "remove":
        cursor++;
        consumed++;
        break;
      case "add":
        newLines.push(entry.text);
        break;
      default:
        break;
    }
  }
  for (let i = cursor; i < fileLines.length; i++) {
    newLines.push(fileLines[i]!);
  }
  return { newLines, consumed };
};

const applyUpdate = async (op: Extract<FileOp, { kind: "update" }>) => {
  const block = isBlockedPath(op.path);
  if (block) throw new Error(block);
  let original: string;
  try {
    original = await fs.readFile(op.path, "utf-8");
  } catch {
    throw new Error(`apply_patch: file not found for Update: ${op.path}`);
  }
  let fileLines = original.split("\n");
  const trailingNewline = original.endsWith("\n");
  if (trailingNewline) {
    fileLines = fileLines.slice(0, -1);
  }
  let cursor = 0;
  for (const hunk of op.hunks) {
    const anchor = findHunkAnchor(fileLines, hunk, cursor);
    if (anchor === -1) {
      throw new Error(
        `apply_patch: could not locate hunk in '${op.path}'${
          hunk.header ? ` (near '${hunk.header}')` : ""
        }.`,
      );
    }
    const { newLines, consumed } = applyHunkAt(fileLines, hunk, anchor);
    fileLines = newLines;
    cursor = anchor + consumed;
  }
  let newContent = fileLines.join("\n");
  if (trailingNewline) newContent += "\n";
  const targetPath = op.moveTo ?? op.path;
  if (op.moveTo) {
    const moveBlock = isBlockedPath(op.moveTo);
    if (moveBlock) throw new Error(moveBlock);
    await fs.mkdir(path.dirname(op.moveTo), { recursive: true });
    await fs.writeFile(op.moveTo, newContent, "utf-8");
    if (op.moveTo !== op.path) {
      await fs.unlink(op.path).catch(() => undefined);
    }
  } else {
    await fs.writeFile(op.path, newContent, "utf-8");
  }
  return { kind: "update" as const, path: op.path, movedTo: op.moveTo, written: targetPath };
};

const applyAdd = async (op: Extract<FileOp, { kind: "add" }>) => {
  const block = isBlockedPath(op.path);
  if (block) throw new Error(block);
  await fs.mkdir(path.dirname(op.path), { recursive: true });
  const content = op.lines.join("\n") + (op.lines.length > 0 ? "\n" : "");
  await fs.writeFile(op.path, content, { encoding: "utf-8", flag: "wx" });
  return { kind: "add" as const, path: op.path };
};

const applyDelete = async (op: Extract<FileOp, { kind: "delete" }>) => {
  const block = isBlockedPath(op.path);
  if (block) throw new Error(block);
  await fs.unlink(op.path);
  return { kind: "delete" as const, path: op.path };
};

export const createApplyPatchBuiltin = (): ExecToolDefinition => ({
  name: "apply_patch",
  description:
    "Apply a Codex-style text-based patch envelope to one or more files. Supports `*** Add File:`, `*** Update File:` (with optional `*** Move to:`), and `*** Delete File:`. All paths must be absolute.",
  inputSchema: APPLY_PATCH_SCHEMA,
  handler: async (rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const patch = String(args.patch ?? "").trim();
    if (!patch) throw new Error("apply_patch requires a patch envelope.");
    const ops = parsePatch(patch);
    const results: Array<{ kind: string; path: string; movedTo?: string }> = [];
    for (const op of ops) {
      switch (op.kind) {
        case "add":
          results.push(await applyAdd(op));
          break;
        case "update":
          results.push(await applyUpdate(op));
          break;
        case "delete":
          results.push(await applyDelete(op));
          break;
        default:
          break;
      }
    }
    return { results };
  },
});
