/**
 * Shell tools: Bash, SkillBash, KillShell handlers.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ToolContext, ToolResult, ShellRecord, SecretMountSpec, SkillRecord } from "./tools-types.js";
import { removeSecretFile, truncate, writeSecretFile } from "./tools-utils.js";

export type ShellState = {
  shells: Map<string, ShellRecord>;
  skillCache: SkillRecord[];
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

const deferredDeleteHelperPath = (() => {
  const jsPath = fileURLToPath(new URL("./deferred_delete_cli.js", import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }
  const tsPath = fileURLToPath(new URL("./deferred_delete_cli.ts", import.meta.url));
  if (existsSync(tsPath)) {
    return tsPath;
  }
  return "";
})();

const rewriteDeleteBypassPatterns = (command: string) =>
  command
    .replace(/\bcommand\s+(rm|rmdir|unlink)\b/g, "$1")
    .replace(/\b(?:\/usr\/bin|\/bin)\/(rm|rmdir|unlink)\b/g, "$1")
    .replace(/(^|[\s;&|()])\\(rm|rmdir|unlink)\b/g, "$1$2");

const buildProtectedCommand = (command: string) => {
  if (!deferredDeleteHelperPath) {
    return command;
  }

  // Dynamically detect python-like invocations (python, python3, python3.11, py, etc.)
  const pythonPattern = /\b(python\d*(?:\.\d+)?|py)\b/g;
  const pythonNames = new Set<string>();
  let m;
  while ((m = pythonPattern.exec(command)) !== null) {
    pythonNames.add(m[1]);
  }

  const pythonFuncs = [...pythonNames]
    .map(name => `${name}() { __stella_dd python "$PWD" "$(type -P ${name} || true)" "$@"; }`)
    .join('\n');
  const pythonExports = pythonNames.size > 0
    ? ` ${[...pythonNames].join(' ')}`
    : '';

  const preamble = `
__stella_dd() {
  ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_DEFERRED_DELETE_HELPER" "$@"
}
rm() { __stella_dd delete "$PWD" rm "$@"; }
rmdir() { __stella_dd delete "$PWD" rmdir "$@"; }
unlink() { __stella_dd delete "$PWD" unlink "$@"; }
del() { rm "$@"; }
erase() { rm "$@"; }
rd() { rmdir "$@"; }
powershell() { __stella_dd powershell "$PWD" "$(type -P powershell || true)" "$@"; }
pwsh() { __stella_dd powershell "$PWD" "$(type -P pwsh || true)" "$@"; }
${pythonFuncs}
export -f __stella_dd rm rmdir unlink del erase rd powershell pwsh${pythonExports} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${rewriteDeleteBypassPatterns(command)}`;
};

const buildShellEnv = (envOverrides?: Record<string, string>) => ({
  ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
  STELLA_NODE_BIN: process.execPath,
  STELLA_DEFERRED_DELETE_HELPER: deferredDeleteHelperPath,
});

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
) => {
  const id = crypto.randomUUID();
  const protectedCommand = buildProtectedCommand(command);
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", protectedCommand];

  const child = spawn(shell, args, {
    cwd,
    env: buildShellEnv(envOverrides),
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
  const protectedCommand = buildProtectedCommand(command);
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", protectedCommand];

  return new Promise<string>((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: buildShellEnv(envOverrides),
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

const launchDetached = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: error.message });
      });
      child.on("spawn", () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message });
    }
  });
};

export const handleOpenApp = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const app = String(args.app ?? "").trim();
  if (!app) {
    return { error: "app is required." };
  }

  const appArgs = Array.isArray(args.args)
    ? args.args.map((value) => String(value))
    : [];
  const cwd = String(args.working_directory ?? process.cwd());

  if (process.platform === "win32") {
    const launched = await launchDetached("cmd.exe", ["/c", "start", "", app, ...appArgs], cwd);
    if (!launched.ok) {
      return { error: `Failed to launch app \"${app}\": ${launched.error}` };
    }
    return { result: `Launched app: ${app}` };
  }

  if (process.platform === "darwin") {
    const launchArgs = ["-a", app, ...(appArgs.length > 0 ? ["--args", ...appArgs] : [])];
    const launched = await launchDetached("open", launchArgs, cwd);
    if (!launched.ok) {
      return { error: `Failed to launch app \"${app}\": ${launched.error}` };
    }
    return { result: `Launched app: ${app}` };
  }

  const launched = await launchDetached(app, appArgs, cwd);
  if (launched.ok) {
    return { result: `Launched app: ${app}` };
  }

  if (appArgs.length === 0) {
    const fallback = await launchDetached("xdg-open", [app], cwd);
    if (fallback.ok) {
      return { result: `Opened with xdg-open: ${app}` };
    }
  }

  return { error: `Failed to launch app \"${app}\": ${launched.error}` };
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
    // Even without secretMounts, default cwd to skill directory for script path resolution
    if (skill?.filePath && !args.working_directory) {
      args = { ...args, working_directory: path.dirname(skill.filePath) };
    }
    return handleBash(state, args);
  }

  const command = String(args.command ?? "");
  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  // Default cwd to skill directory so relative script paths (e.g. scripts/...) resolve correctly
  const skillDir = skill.filePath ? path.dirname(skill.filePath) : undefined;
  const cwd = String(args.working_directory ?? skillDir ?? process.cwd());
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
