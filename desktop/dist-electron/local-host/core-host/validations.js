import { spawn } from "child_process";
const MAX_OUTPUT = 80000;
const truncate = (value) => value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n\n... (truncated)` : value;
const runShellCommand = async (command, cwd, timeoutMs) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "bash";
    const args = process.platform === "win32" ? ["/c", command] : ["-lc", command];
    return await new Promise((resolve) => {
        const child = spawn(shell, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let finished = false;
        const timer = setTimeout(() => {
            if (finished)
                return;
            finished = true;
            child.kill();
            resolve({
                status: "timed_out",
                exitCode: null,
                output: truncate(`Command timed out after ${timeoutMs}ms.\n\n${output}`),
            });
        }, timeoutMs);
        const append = (data) => {
            output = truncate(`${output}${data.toString()}`);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                status: "failed",
                exitCode: null,
                output: truncate(`Failed to execute command: ${error.message}\n\n${output}`),
            });
        });
        child.on("close", (code) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                status: code === 0 ? "passed" : "failed",
                exitCode: code ?? null,
                output: code === 0
                    ? output || "Command completed successfully (no output)."
                    : truncate(`Command exited with code ${code}.\n\n${output}`),
            });
        });
    });
};
const DEFAULT_TIMEOUT_MS = 240000;
const SMOKE_TIMEOUT_MS = 180000;
export const defaultValidationSpecs = (cwd) => [
    {
        name: "lint",
        command: "npm run lint",
        cwd,
        timeoutMs: 240000,
        required: true,
    },
    {
        name: "build",
        command: "npm run build",
        cwd,
        timeoutMs: 300000,
        required: true,
    },
];
export const smokeValidationSpecs = (cwd) => [
    {
        name: "smoke_build",
        command: "npm run build",
        cwd,
        timeoutMs: SMOKE_TIMEOUT_MS,
        required: true,
    },
];
export const runValidations = async (specs) => {
    const results = [];
    for (const spec of specs) {
        const startedAt = Date.now();
        const timeoutMs = Math.max(30000, Math.floor(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        const result = await runShellCommand(spec.command, spec.cwd, timeoutMs);
        const completedAt = Date.now();
        results.push({
            name: spec.name,
            command: spec.command,
            cwd: spec.cwd,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            exitCode: result.exitCode,
            status: result.status,
            output: result.output,
            required: spec.required ?? true,
        });
    }
    return results;
};
export const summarizeValidationResults = (results) => {
    const requiredFailures = results.filter((result) => result.required && result.status !== "passed");
    return {
        ok: requiredFailures.length === 0,
        requiredFailures,
        results,
    };
};
