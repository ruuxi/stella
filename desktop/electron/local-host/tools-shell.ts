/**
 * Shell tools: Bash, SkillBash, KillShell handlers.
 */

import { spawn } from "child_process";
import type { ToolContext, ToolResult, ShellRecord, SecretMountSpec, PluginSyncPayload } from "./tools-types.js";
import { removeSecretFile, truncate, writeSecretFile } from "./tools-utils.js";

export type ShellState = {
  shells: Map<string, ShellRecord>;
  skillCache: PluginSyncPayload["skills"];
  resolveSecretValue: (
    spec: SecretMountSpec,
    cache: Map<string, string>,
    context?: ToolContext,
    toolName?: string,
  ) => Promise<string | null>;
};

export const createShellState = (
  resolveSecretValue: ShellState["resolveSecretValue"],
): ShellState => ({
  shells: new Map(),
  skillCache: [],
  resolveSecretValue,
});

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
) => {
  const id = crypto.randomUUID();
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", command];

  const child = spawn(shell, args, {
    cwd,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const record: ShellRecord = {
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

  const append = (data: Buffer) => {
    record.output = truncate(`${record.output}${data.toString()}`);
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", (code) => {
    record.running = false;
    record.exitCode = code ?? null;
    record.completedAt = Date.now();
    if (onClose) {
      onClose();
    }
  });

  state.shells.set(id, record);
  return record;
};

export const runShell = async (
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
) => {
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", command];

  return new Promise<string>((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      resolve(`Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`);
    }, timeoutMs);

    const append = (data: Buffer) => {
      output = truncate(`${output}${data.toString()}`);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Clean Windows console noise (chcp output) that confuses LLMs
      const cleanedOutput = output
        .replace(/^Active code page: \d+\s*/gm, "")
        .replace(/^\s+/, ""); // Trim leading whitespace after removal
      if (code === 0) {
        resolve(cleanedOutput || "Command completed successfully (no output).");
      } else {
        resolve(`Command exited with code ${code}.\n\n${truncate(cleanedOutput)}`);
      }
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(`Failed to execute command: ${error.message}`);
    });
  });
};

export const handleBash = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  void context; // Unused but kept for interface consistency

  const command = String(args.command ?? "");
  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  const cwd = String(args.working_directory ?? process.cwd());
  const runInBackground = Boolean(args.run_in_background ?? false);

  if (runInBackground) {
    const record = startShell(state, command, cwd);
    return {
      result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
        record.output || "(no output yet)",
      )}`,
    };
  }

  const output = await runShell(command, cwd, timeout);
  return { result: truncate(output) };
};

export const handleSkillBash = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const skillId = String(args.skill_id ?? "").trim();
  if (!skillId) {
    return { error: "skill_id is required." };
  }

  const skill = state.skillCache.find((s) => s.id === skillId);
  if (!skill || !skill.secretMounts) {
    return handleBash(state, args);
  }

  const command = String(args.command ?? "");
  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  const cwd = String(args.working_directory ?? process.cwd());
  const runInBackground = Boolean(args.run_in_background ?? false);

  const envOverrides: Record<string, string> = {};
  const providerCache = new Map<string, string>();
  const mountedSecretFiles: string[] = [];
  const cleanupMountedSecretFiles = async () => {
    for (const mountedPath of mountedSecretFiles) {
      await removeSecretFile(mountedPath);
    }
  };

  if (skill.secretMounts.env) {
    for (const [envName, spec] of Object.entries(skill.secretMounts.env)) {
      if (!envName.trim()) continue;
      const value = await state.resolveSecretValue(
        spec,
        providerCache,
        context,
        "SkillBash",
      );
      if (!value) {
        await cleanupMountedSecretFiles();
        return {
          error: `Missing secret for ${spec.provider}.`,
        };
      }
      envOverrides[envName] = value;
    }
  }

  if (skill.secretMounts.files) {
    for (const [filePath, spec] of Object.entries(skill.secretMounts.files)) {
      if (!filePath.trim()) continue;
      const value = await state.resolveSecretValue(
        spec,
        providerCache,
        context,
        "SkillBash",
      );
      if (!value) {
        await cleanupMountedSecretFiles();
        return {
          error: `Missing secret for ${spec.provider}.`,
        };
      }
      const mountedPath = await writeSecretFile(filePath, value, cwd);
      mountedSecretFiles.push(mountedPath);
    }
  }

  if (runInBackground) {
    try {
      const record = startShell(state, command, cwd, envOverrides, () => {
        for (const mountedPath of mountedSecretFiles) {
          void removeSecretFile(mountedPath);
        }
      });
      return {
        result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
          record.output || "(no output yet)",
        )}`,
      };
    } catch {
      await cleanupMountedSecretFiles();
      throw new Error("Failed to start background shell");
    }
  }

  try {
    const output = await runShell(command, cwd, timeout, envOverrides);
    return { result: truncate(output) };
  } finally {
    await cleanupMountedSecretFiles();
  }
};

export const handleKillShell = async (
  state: ShellState,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
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
