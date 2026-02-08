/**
 * Shell tools: Bash, SkillBash, KillShell handlers.
 */
import { spawn } from "child_process";
import { truncate, writeSecretFile } from "./tools-utils.js";
export const createShellState = (resolveSecretValue) => ({
    shells: new Map(),
    skillCache: [],
    resolveSecretValue,
});
export const startShell = (state, command, cwd, envOverrides) => {
    const id = crypto.randomUUID();
    // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
    const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const args = ["-lc", command];
    const child = spawn(shell, args, {
        cwd,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const record = {
        id,
        command,
        cwd,
        output: "",
        running: true,
        exitCode: null,
        startedAt: Date.now(),
        completedAt: null,
        kill: () => {
            child.kill();
        },
    };
    const append = (data) => {
        record.output = truncate(`${record.output}${data.toString()}`);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
        record.running = false;
        record.exitCode = code ?? null;
        record.completedAt = Date.now();
    });
    state.shells.set(id, record);
    return record;
};
export const runShell = async (command, cwd, timeoutMs, envOverrides) => {
    // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
    const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const args = ["-lc", command];
    return new Promise((resolve) => {
        const child = spawn(shell, args, {
            cwd,
            env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let finished = false;
        const timer = setTimeout(() => {
            if (finished)
                return;
            finished = true;
            child.kill();
            resolve(`Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`);
        }, timeoutMs);
        const append = (data) => {
            output = truncate(`${output}${data.toString()}`);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("close", (code) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            // Clean Windows console noise (chcp output) that confuses LLMs
            const cleanedOutput = output
                .replace(/^Active code page: \d+\s*/gm, "")
                .replace(/^\s+/, ""); // Trim leading whitespace after removal
            if (code === 0) {
                resolve(cleanedOutput || "Command completed successfully (no output).");
            }
            else {
                resolve(`Command exited with code ${code}.\n\n${truncate(cleanedOutput)}`);
            }
        });
        child.on("error", (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve(`Failed to execute command: ${error.message}`);
        });
    });
};
export const handleBash = async (state, args, context) => {
    void context; // Unused but kept for interface consistency
    const command = String(args.command ?? "");
    const timeout = Math.min(Number(args.timeout ?? 120000), 600000);
    const cwd = String(args.working_directory ?? process.cwd());
    const runInBackground = Boolean(args.run_in_background ?? false);
    if (runInBackground) {
        const record = startShell(state, command, cwd);
        return {
            result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(record.output || "(no output yet)")}`,
        };
    }
    const output = await runShell(command, cwd, timeout);
    return { result: truncate(output) };
};
export const handleSkillBash = async (state, args, context) => {
    const skillId = String(args.skill_id ?? "").trim();
    if (!skillId) {
        return { error: "skill_id is required." };
    }
    const skill = state.skillCache.find((s) => s.id === skillId);
    if (!skill || !skill.secretMounts) {
        return handleBash(state, args);
    }
    const command = String(args.command ?? "");
    const timeout = Math.min(Number(args.timeout ?? 120000), 600000);
    const cwd = String(args.working_directory ?? process.cwd());
    const runInBackground = Boolean(args.run_in_background ?? false);
    const envOverrides = {};
    const providerCache = new Map();
    if (skill.secretMounts.env) {
        for (const [envName, spec] of Object.entries(skill.secretMounts.env)) {
            if (!envName.trim())
                continue;
            const value = await state.resolveSecretValue(spec, providerCache, context, "SkillBash");
            if (!value) {
                return {
                    error: `Missing secret for ${spec.provider}.`,
                };
            }
            envOverrides[envName] = value;
        }
    }
    if (skill.secretMounts.files) {
        for (const [filePath, spec] of Object.entries(skill.secretMounts.files)) {
            if (!filePath.trim())
                continue;
            const value = await state.resolveSecretValue(spec, providerCache, context, "SkillBash");
            if (!value) {
                return {
                    error: `Missing secret for ${spec.provider}.`,
                };
            }
            await writeSecretFile(filePath, value, cwd);
        }
    }
    if (runInBackground) {
        const record = startShell(state, command, cwd, envOverrides);
        return {
            result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(record.output || "(no output yet)")}`,
        };
    }
    const output = await runShell(command, cwd, timeout, envOverrides);
    return { result: truncate(output) };
};
export const handleKillShell = async (state, args) => {
    const shellId = String(args.shell_id ?? "");
    const record = state.shells.get(shellId);
    if (!record) {
        return { error: `Shell not found: ${shellId}` };
    }
    if (!record.running) {
        return {
            result: `Shell ${shellId} already completed.\nExit: ${record.exitCode ?? "?"}`,
        };
    }
    record.kill();
    return {
        result: `Killed shell ${shellId}.\n\nOutput:\n${truncate(record.output)}`,
    };
};
