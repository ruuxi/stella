/**
 * Search tools: Grep handler.
 */

import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import type { ToolContext, ToolResult } from "./types.js";
import { resolveRipgrepPath } from "./ripgrep.js";
import {
  expandHomePath,
  toPosix,
  globToRegExp,
  walkFiles,
  readFileSafe,
  truncate,
} from "./utils.js";
import { isBlockedPath } from "./command-safety.js";

const runRipgrep = async (
  args: string[],
  cwd: string,
  context?: ToolContext,
  timeoutMs?: number,
) => {
  return new Promise<{
    ok: boolean;
    matched: boolean;
    output: string;
    error?: string;
  }>(async (resolve) => {
    const ripgrepPath = await resolveRipgrepPath(context).catch((error) =>
      error instanceof Error ? null : null,
    );
    if (!ripgrepPath) {
      resolve({
        ok: false,
        matched: false,
        output: "",
        error: "ripgrep is unavailable",
      });
      return;
    }
    const child = spawn(ripgrepPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      ok: boolean;
      matched: boolean;
      output: string;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish({
            ok: false,
            matched: false,
            output: stdout,
            error: `ripgrep probe timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs)
      : null;

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        matched: false,
        output: "",
        error: error.message,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, matched: true, output: stdout });
      } else if (code === 1) {
        finish({ ok: true, matched: false, output: "" });
      } else {
        finish({
          ok: false,
          matched: false,
          output: stdout,
          error: stderr || `rg exited ${code}`,
        });
      }
    });
  });
};

const regexMetaPattern = /[.*+?^${}()|[\]\\]/;

const buildProbeArgs = (args: {
  pattern: string;
  basePath: string;
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  literal?: boolean;
  hidden?: boolean;
}): string[] => {
  const probe = ["--quiet", "--max-count", "1"];
  if (args.caseInsensitive) probe.push("-i");
  if (args.literal) probe.push("-F");
  if (args.hidden) probe.push("--hidden", "--no-ignore");
  if (args.glob) probe.push("--glob", args.glob);
  if (args.type) probe.push("--type", args.type);
  probe.push(args.pattern, args.basePath);
  return probe;
};

const buildZeroMatchHint = async (args: {
  pattern: string;
  basePath: string;
  cwd: string;
  glob?: string;
  type?: string;
  caseInsensitive: boolean;
  context?: ToolContext;
}): Promise<string | null> => {
  const hints: string[] = [];
  const runProbe = async (
    overrides: Pick<
      Parameters<typeof buildProbeArgs>[0],
      "caseInsensitive" | "literal" | "hidden"
    >,
  ) =>
    await runRipgrep(
      buildProbeArgs({
        pattern: args.pattern,
        basePath: args.basePath,
        ...(args.glob ? { glob: args.glob } : {}),
        ...(args.type ? { type: args.type } : {}),
        ...overrides,
      }),
      args.cwd,
      args.context,
      5_000,
    );

  if (!args.caseInsensitive) {
    const result = await runProbe({ caseInsensitive: true });
    if (result.ok && result.matched) {
      hints.push(
        "A case-insensitive search does match; retry with case_insensitive=true or correct the casing.",
      );
    }
  }

  if (regexMetaPattern.test(args.pattern)) {
    const result = await runProbe({
      caseInsensitive: args.caseInsensitive,
      literal: true,
    });
    if (result.ok && result.matched) {
      hints.push(
        "The literal text does match; escape regular-expression metacharacters in the pattern.",
      );
    }
  }

  const hiddenResult = await runProbe({
    caseInsensitive: args.caseInsensitive,
    hidden: true,
  });
  if (hiddenResult.ok && hiddenResult.matched) {
    hints.push(
      "The pattern exists only in hidden or ignored files; search the relevant hidden path explicitly.",
    );
  }

  return hints.length > 0 ? hints.join(" ") : null;
};

const editDistance = (left: string, right: string): number => {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
};

const findSimilarPaths = async (missingPath: string): Promise<string[]> => {
  const parent = path.dirname(missingPath);
  const target = path.basename(missingPath).toLowerCase();
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return [];
  }
  return entries
    .map((entry) => {
      const normalized = entry.toLowerCase();
      const distance =
        normalized === target
          ? 0
          : normalized.startsWith(target) || target.startsWith(normalized)
            ? 1
            : editDistance(normalized, target);
      return { entry, distance };
    })
    .filter(
      ({ distance }) => distance <= Math.max(2, Math.ceil(target.length / 3)),
    )
    .sort(
      (left, right) =>
        left.distance - right.distance || left.entry.localeCompare(right.entry),
    )
    .slice(0, 5)
    .map(({ entry }) => path.join(parent, entry));
};

const isPathInsideRoot = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export const handleGrep = async (
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const pattern = String(args.pattern ?? "");
  const scopedRoot = context?.toolWorkspaceRoot?.trim()
    ? path.resolve(context.toolWorkspaceRoot)
    : null;
  const rawPath = expandHomePath(
    String(args.path ?? scopedRoot ?? context?.stellaAppDir ?? process.cwd()),
  );
  const basePath =
    scopedRoot && !path.isAbsolute(rawPath)
      ? path.resolve(scopedRoot, rawPath)
      : path.resolve(rawPath);
  const glob = args.glob ? String(args.glob) : undefined;
  const type = args.type ? String(args.type) : undefined;
  const outputMode = String(args.output_mode ?? "files_with_matches");
  const caseInsensitive = Boolean(args.case_insensitive ?? false);
  const contextLines = args.context_lines
    ? Number(args.context_lines)
    : undefined;
  const maxResults = args.max_results ? Number(args.max_results) : 100;

  // Safety check: block system directories
  const pathBlock = isBlockedPath(basePath);
  if (pathBlock) return { error: pathBlock };
  if (scopedRoot && !isPathInsideRoot(basePath, scopedRoot)) {
    return { error: "Path is outside the shared session workspace." };
  }

  try {
    await fs.access(basePath);
  } catch {
    const similar = await findSimilarPaths(basePath);
    return {
      error:
        `Path not found: ${basePath}` +
        (similar.length > 0
          ? `\nSimilar paths:\n${similar.map((entry) => `- ${entry}`).join("\n")}`
          : "\nCheck the path or search its nearest existing parent directory."),
    };
  }

  const baseStat = await fs.stat(basePath);
  const searchCwd = baseStat.isDirectory() ? basePath : path.dirname(basePath);

  const rgArgs: string[] = [];
  if (outputMode === "files_with_matches") rgArgs.push("-l");
  if (outputMode === "count") rgArgs.push("-c");
  if (outputMode === "content") {
    rgArgs.push("-n");
    if (contextLines) rgArgs.push("-C", String(contextLines));
  }
  if (caseInsensitive) rgArgs.push("-i");
  if (glob) rgArgs.push("--glob", glob);
  if (type) rgArgs.push("--type", type);
  rgArgs.push("--max-count", String(maxResults));
  rgArgs.push(pattern, basePath);

  const rgResult = await runRipgrep(rgArgs, searchCwd, context);
  if (rgResult.ok) {
    const lines = rgResult.output.trim();
    if (!lines) {
      const hint = await buildZeroMatchHint({
        pattern,
        basePath,
        cwd: searchCwd,
        ...(glob ? { glob } : {}),
        ...(type ? { type } : {}),
        caseInsensitive,
        ...(context ? { context } : {}),
      });
      return {
        result:
          `No matches found for pattern: ${pattern}` +
          (hint ? `\n\nRecovery hint: ${hint}` : ""),
      };
    }
    return {
      result: `Found matches:\n\n${truncate(rgResult.output)}`,
    };
  }

  // Fallback: simple scan.
  const files = baseStat.isFile() ? [basePath] : await walkFiles(basePath);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
  } catch (error) {
    return {
      error: `Invalid regular expression '${pattern}': ${(error as Error).message}. Escape metacharacters to search for literal text.`,
    };
  }
  const results: string[] = [];

  for (const file of files) {
    const rel = toPosix(path.relative(basePath, file));
    if (glob) {
      const globRegex = globToRegExp(toPosix(glob));
      if (!globRegex.test(rel)) continue;
    }
    try {
      const read = await readFileSafe(file);
      if (!read.ok) continue;
      const lines = read.content.split("\n");
      let matchCount = 0;
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matchCount += 1;
          if (outputMode === "content") {
            results.push(`${file}:${index + 1}:${line}`);
          }
        }
        regex.lastIndex = 0;
      });
      if (matchCount > 0) {
        if (outputMode === "files_with_matches") {
          results.push(file);
        } else if (outputMode === "count") {
          results.push(`${file}:${matchCount}`);
        }
      }
    } catch {
      // Skip unreadable files.
    }
    if (results.length >= maxResults) break;
  }

  if (results.length === 0) {
    return { result: `No matches found for pattern: ${pattern}` };
  }

  return {
    result: `Found ${results.length} result(s):\n\n${truncate(results.join("\n"))}`,
  };
};
