import { spawn } from "child_process";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
const runCommand = async (command, args, cwd, timeoutMs) => {
    return await new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let finished = false;
        const timer = setTimeout(() => {
            if (finished)
                return;
            finished = true;
            child.kill();
            resolve({
                ok: false,
                exitCode: null,
                stdout,
                stderr: `Command timed out after ${timeoutMs}ms.`,
            });
        }, timeoutMs);
        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        child.on("error", (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                ok: false,
                exitCode: null,
                stdout,
                stderr: error.message,
            });
        });
        child.on("close", (code) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                ok: code === 0,
                exitCode: code ?? null,
                stdout,
                stderr,
            });
        });
    });
};
const GIT_TIMEOUT_MS = 20000;
export const checkGitAvailable = async (cwd) => {
    const result = await runCommand("git", ["--version"], cwd, GIT_TIMEOUT_MS);
    return result.ok;
};
export const resolveGitRoot = async (cwd) => {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd, GIT_TIMEOUT_MS);
    if (!result.ok) {
        return null;
    }
    const root = result.stdout.trim();
    return root || null;
};
export const getGitHead = async (cwd) => {
    const result = await runCommand("git", ["rev-parse", "HEAD"], cwd, GIT_TIMEOUT_MS);
    if (!result.ok) {
        return null;
    }
    const head = result.stdout.trim();
    return head || null;
};
const sanitizePaths = (paths) => paths
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 300);
export const getGitDiff = async (cwd, paths = []) => {
    const cleanPaths = sanitizePaths(paths);
    const args = cleanPaths.length > 0 ? ["diff", "--no-color", "--", ...cleanPaths] : ["diff", "--no-color"];
    const result = await runCommand("git", args, cwd, 60000);
    if (!result.ok && result.exitCode === 1) {
        // git diff exits 1 for differences in some versions; treat as ok.
        return result.stdout;
    }
    return result.stdout;
};
export const getGitNumStat = async (cwd, paths = []) => {
    const cleanPaths = sanitizePaths(paths);
    const args = cleanPaths.length > 0
        ? ["diff", "--numstat", "--", ...cleanPaths]
        : ["diff", "--numstat"];
    const result = await runCommand("git", args, cwd, 60000);
    const output = result.stdout.trim();
    const stats = new Map();
    if (!output) {
        return stats;
    }
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const parts = line.split(/\t+/);
        if (parts.length < 3)
            continue;
        const added = Number(parts[0]);
        const removed = Number(parts[1]);
        const filePath = parts[2].trim();
        if (!filePath)
            continue;
        stats.set(filePath, {
            added: Number.isFinite(added) ? added : 0,
            removed: Number.isFinite(removed) ? removed : 0,
        });
    }
    return stats;
};
export const getGitChangedPaths = async (cwd, paths = []) => {
    const cleanPaths = sanitizePaths(paths);
    const args = cleanPaths.length > 0
        ? ["status", "--porcelain", "--", ...cleanPaths]
        : ["status", "--porcelain"];
    const result = await runCommand("git", args, cwd, 60000);
    const changed = [];
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
        if (!line)
            continue;
        const filePath = line.slice(3).trim();
        if (filePath)
            changed.push(filePath);
    }
    return Array.from(new Set(changed));
};
export const applyReversePatch = async (cwd, patchContent) => {
    if (!patchContent.trim()) {
        return { ok: true, output: "No patch content provided." };
    }
    const tempFile = path.join(os.tmpdir(), `stella-patch-${crypto.randomUUID()}.diff`);
    try {
        await fs.writeFile(tempFile, patchContent, "utf-8");
        const result = await runCommand("git", ["apply", "-R", "--whitespace=nowarn", tempFile], cwd, 60000);
        return {
            ok: result.ok,
            output: result.ok ? result.stdout || "Patch reversed." : result.stderr || result.stdout,
        };
    }
    finally {
        try {
            await fs.rm(tempFile, { force: true });
        }
        catch {
            // Ignore cleanup errors.
        }
    }
};
