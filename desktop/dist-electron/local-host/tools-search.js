/**
 * Search tools: Glob, Grep handlers.
 */
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { expandHomePath, toPosix, globToRegExp, walkFiles, readFileSafe, truncate, } from "./tools-utils.js";
import { isBlockedPath } from "./command_safety.js";
export const handleGlob = async (args) => {
    const pattern = String(args.pattern ?? "");
    const basePath = expandHomePath(String(args.path ?? process.cwd()));
    // Safety check: block system directories
    const pathBlock = isBlockedPath(basePath);
    if (pathBlock)
        return { error: pathBlock };
    try {
        const stat = await fs.stat(basePath);
        if (!stat.isDirectory()) {
            return { error: `Path is not a directory: ${basePath}` };
        }
    }
    catch {
        return { error: `Directory not found: ${basePath}` };
    }
    const regex = globToRegExp(toPosix(pattern));
    const files = await walkFiles(basePath);
    const matches = files.filter((file) => {
        const rel = toPosix(path.relative(basePath, file));
        return regex.test(rel);
    });
    if (matches.length === 0) {
        return { result: `No files found matching "${pattern}" in ${basePath}` };
    }
    const withTimes = await Promise.all(matches.map(async (file) => {
        try {
            const stat = await fs.stat(file);
            return { file, mtime: stat.mtime.getTime() };
        }
        catch {
            return { file, mtime: 0 };
        }
    }));
    withTimes.sort((a, b) => b.mtime - a.mtime);
    return {
        result: `Found ${withTimes.length} files:\n\n${withTimes
            .map((entry) => entry.file)
            .join("\n")}`,
    };
};
const runRipgrep = async (args, cwd) => {
    return new Promise((resolve) => {
        const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        child.on("error", (error) => {
            resolve({ ok: false, output: "", error: error.message });
        });
        child.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true, output: stdout });
            }
            else if (code === 1) {
                resolve({ ok: true, output: "" });
            }
            else {
                resolve({ ok: false, output: stdout, error: stderr || `rg exited ${code}` });
            }
        });
    });
};
export const handleGrep = async (args) => {
    const pattern = String(args.pattern ?? "");
    const basePath = expandHomePath(String(args.path ?? process.cwd()));
    const glob = args.glob ? String(args.glob) : undefined;
    const type = args.type ? String(args.type) : undefined;
    const outputMode = String(args.output_mode ?? "files_with_matches");
    const caseInsensitive = Boolean(args.case_insensitive ?? false);
    const contextLines = args.context_lines ? Number(args.context_lines) : undefined;
    const maxResults = args.max_results ? Number(args.max_results) : 100;
    // Safety check: block system directories
    const pathBlock = isBlockedPath(basePath);
    if (pathBlock)
        return { error: pathBlock };
    try {
        await fs.access(basePath);
    }
    catch {
        return { error: `Path not found: ${basePath}` };
    }
    const rgArgs = [];
    if (outputMode === "files_with_matches")
        rgArgs.push("-l");
    if (outputMode === "count")
        rgArgs.push("-c");
    if (outputMode === "content") {
        rgArgs.push("-n");
        if (contextLines)
            rgArgs.push("-C", String(contextLines));
    }
    if (caseInsensitive)
        rgArgs.push("-i");
    if (glob)
        rgArgs.push("--glob", glob);
    if (type)
        rgArgs.push("--type", type);
    rgArgs.push("--max-count", String(maxResults));
    rgArgs.push(pattern, basePath);
    const rgResult = await runRipgrep(rgArgs, basePath);
    if (rgResult.ok) {
        const lines = rgResult.output.trim();
        if (!lines) {
            return { result: `No matches found for pattern: ${pattern}` };
        }
        return {
            result: `Found matches:\n\n${truncate(rgResult.output)}`,
        };
    }
    // Fallback: simple scan.
    const files = await walkFiles(basePath);
    const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
    const results = [];
    for (const file of files) {
        const rel = toPosix(path.relative(basePath, file));
        if (glob) {
            const globRegex = globToRegExp(toPosix(glob));
            if (!globRegex.test(rel))
                continue;
        }
        try {
            const read = await readFileSafe(file);
            if (!read.ok)
                continue;
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
                }
                else if (outputMode === "count") {
                    results.push(`${file}:${matchCount}`);
                }
            }
        }
        catch {
            // Skip unreadable files.
        }
        if (results.length >= maxResults)
            break;
    }
    if (results.length === 0) {
        return { result: `No matches found for pattern: ${pattern}` };
    }
    return {
        result: `Found ${results.length} result(s):\n\n${truncate(results.join("\n"))}`,
    };
};
