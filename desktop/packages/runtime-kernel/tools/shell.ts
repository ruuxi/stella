/**
 * Shell tools: Bash, SkillBash, KillShell handlers.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ToolContext, ToolResult, ShellRecord, SecretMountSpec, SkillRecord } from "./types.js";
import type { SecretFileMountHandle } from "./utils.js";
import { removeSecretFile, truncate, writeSecretFile } from "./utils.js";
import { isDangerousCommand } from "./command-safety.js";
import { getStellaBrowserBridgeEnv } from "./stella-browser-bridge-config.js";

export type ShellState = {
  shells: Map<string, ShellRecord>;
  skillCache: SkillRecord[];
  secretStateRoot: string;
  stellaBrowserBinPath?: string;
  stellaUiCliPath?: string;
  resolveSecretValue: (
    spec: SecretMountSpec,
    cache: Map<string, string>,
    context?: ToolContext,
    toolName?: string,
  ) => Promise<string | null>;
};

export const createShellState = (
  resolveSecretValue: ShellState["resolveSecretValue"],
  secretStateRoot: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaUiCliPath?: string;
  },
): ShellState => ({
  shells: new Map(),
  skillCache: [],
  secretStateRoot,
  stellaBrowserBinPath: options?.stellaBrowserBinPath,
  stellaUiCliPath: options?.stellaUiCliPath,
  resolveSecretValue,
});

const deferredDeleteHelperPath = (() => {
  try {
    const jsPath = fileURLToPath(new URL("./deferred-delete-cli.js", import.meta.url));
    if (existsSync(jsPath)) {
      return jsPath;
    }
    const tsPath = fileURLToPath(new URL("./deferred-delete-cli.ts", import.meta.url));
    if (existsSync(tsPath)) {
      return tsPath;
    }
  } catch {
    // import.meta.url may not be a file:// URL in non-Node environments (e.g. Vite renderer)
  }
  return "";
})();

const rewriteDeleteBypassPatterns = (command: string) =>
  command
    .replace(/\bcommand\s+(rm|rmdir|unlink)\b/g, "$1")
    .replace(/\b(?:\/usr\/bin|\/bin)\/(rm|rmdir|unlink)\b/g, "$1")
    .replace(/(^|[\s;&|()])\\(rm|rmdir|unlink)\b/g, "$1$2");

const buildProtectedCommand = (
  command: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaUiCliPath?: string;
  },
) => {
  if (!deferredDeleteHelperPath) {
    return command;
  }
  const stellaBrowserBin =
    options?.stellaBrowserBinPath && existsSync(options.stellaBrowserBinPath)
      ? options.stellaBrowserBinPath
      : "";
  const stellaUiCli =
    options?.stellaUiCliPath && existsSync(options.stellaUiCliPath)
      ? options.stellaUiCliPath
      : "";

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
__stella_git_stage_feature_dependencies() {
  local repo_root
  repo_root="$(command git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$repo_root" ]; then
    return 0
  fi
  local dep_files=(
    "$repo_root/package.json"
    "$repo_root/bun.lock"
    "$repo_root/bun.lockb"
    "$repo_root/package-lock.json"
    "$repo_root/pnpm-lock.yaml"
    "$repo_root/yarn.lock"
    "$repo_root/npm-shrinkwrap.json"
  )
  local existing_files=()
  for dep_file in "\${dep_files[@]}"; do
    if [ -f "$dep_file" ]; then
      existing_files+=("$dep_file")
    fi
  done
  if [ "\${#existing_files[@]}" -gt 0 ]; then
    command git add -- "\${existing_files[@]}" >/dev/null 2>&1 || true
  fi
}
git() {
  if [ "$1" = "commit" ]; then
    local has_feature_tag=0
    for arg in "$@"; do
      case "$arg" in
        *"[feature:"*)
          has_feature_tag=1
          ;;
      esac
    done
    if [ "$has_feature_tag" -eq 1 ]; then
      __stella_git_stage_feature_dependencies
    fi
  fi
  command git "$@"
}
rm() { __stella_dd delete "$PWD" rm "$@"; }
rmdir() { __stella_dd delete "$PWD" rmdir "$@"; }
unlink() { __stella_dd delete "$PWD" unlink "$@"; }
del() { rm "$@"; }
erase() { rm "$@"; }
rd() { rmdir "$@"; }
powershell() { __stella_dd powershell "$PWD" "$(type -P powershell || true)" "$@"; }
pwsh() { __stella_dd powershell "$PWD" "$(type -P pwsh || true)" "$@"; }
${stellaBrowserBin ? `stella-browser() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_BROWSER_BIN" "$@"; }` : ""}
${stellaUiCli ? `stella-ui() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_UI_CLI" "$@"; }` : ""}
${pythonFuncs}
export -f __stella_dd __stella_git_stage_feature_dependencies git rm rmdir unlink del erase rd powershell pwsh${stellaBrowserBin ? " stella-browser" : ""}${stellaUiCli ? " stella-ui" : ""}${pythonExports} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${rewriteDeleteBypassPatterns(command)}`;
};

const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaUiCliPath?: string;
  },
) => ({
  ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
  STELLA_NODE_BIN: process.execPath,
  STELLA_DEFERRED_DELETE_HELPER: deferredDeleteHelperPath,
  ...(options?.secretStateRoot ? { STELLA_UI_STATE_DIR: options.secretStateRoot } : {}),
  ...(options?.stellaBrowserBinPath ? { STELLA_BROWSER_BIN: options.stellaBrowserBinPath } : {}),
  ...(options?.stellaUiCliPath ? { STELLA_UI_CLI: options.stellaUiCliPath } : {}),
});

export const normalizeAppAgentShellCommand = (command: string) =>
  command
    .replace(
      /(?:^|&&\s*|\|\|\s*|;\s*)STELLA_BROWSER_SESSION=[^\s]+(?=\s+stella-browser\b)/g,
      (match) => match.replace(/STELLA_BROWSER_SESSION=[^\s]+\s*/, ""),
    )
    .replace(/\bstella-browser\s+--session(?:=|\s+)\S+\s*/g, "stella-browser ")
    .replace(/\s{2,}/g, " ")
    .trim();

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
) => {
  const id = crypto.randomUUID();
  const protectedCommand = buildProtectedCommand(command, state);
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", protectedCommand];

  const child = spawn(shell, args, {
    cwd,
    env: buildShellEnv(envOverrides, state),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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
  state: ShellState,
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
) => {
  const protectedCommand = buildProtectedCommand(command, state);
  // Use Git Bash on Windows for better AI agent compatibility (bash commands work consistently)
  const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const args = ["-lc", protectedCommand];

  return new Promise<string>((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: buildShellEnv(envOverrides, state),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
  let command = String(args.command ?? "");

  // Safety check: reject dangerous commands
  const dangerReason = isDangerousCommand(command);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }

  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  const cwd = String(args.working_directory ?? context?.frontendRoot ?? process.cwd());
  const runInBackground = Boolean(args.run_in_background ?? false);
  const envOverrides: Record<string, string> = {};

  if (context?.agentType === "app") {
    // App-agent browser automation uses one shared Stella browser bridge.
    // Each agent run gets its own browser tab, but the model must not fork
    // ad-hoc sessions that bypass the app-owned bridge lifecycle.
    command = normalizeAppAgentShellCommand(command);
    Object.assign(envOverrides, getStellaBrowserBridgeEnv());
  }

  if (runInBackground) {
    const record = startShell(state, command, cwd, envOverrides);
    return {
      result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
        record.output || "(no output yet)",
      )}`,
    };
  }

  const output = await runShell(state, command, cwd, timeout, envOverrides);
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

  if (Array.isArray(context?.skillIds) && !context.skillIds.includes(skillId)) {
    const available = context.skillIds.length > 0 ? context.skillIds.join(", ") : "none";
    return { error: `Skill '${skillId}' is not enabled. Available skills: ${available}.` };
  }

  // Safety check: reject dangerous commands
  const commandStr = String(args.command ?? "");
  const dangerReason = isDangerousCommand(commandStr);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }

  const skill = state.skillCache.find((s) => s.id === skillId);
  if (!skill || !skill.secretMounts) {
    // Even without secretMounts, default cwd to skill directory for script path resolution
    if (skill?.filePath && !args.working_directory) {
      args = { ...args, working_directory: path.dirname(skill.filePath) };
    } else if (context?.frontendRoot && !args.working_directory) {
      args = { ...args, working_directory: context.frontendRoot };
    }
    return handleBash(state, args);
  }

  const command = String(args.command ?? "");
  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  // Default cwd to skill directory so relative script paths (e.g. scripts/...) resolve correctly
  const skillDir = skill.filePath ? path.dirname(skill.filePath) : undefined;
  const cwd = String(
    args.working_directory ?? skillDir ?? context?.frontendRoot ?? process.cwd(),
  );
  const runInBackground = Boolean(args.run_in_background ?? false);

  const envOverrides: Record<string, string> = {};
  const providerCache = new Map<string, string>();
  const mountedSecretFiles: SecretFileMountHandle[] = [];
  const cleanupMountedSecretFiles = async () => {
    for (const mountedFile of mountedSecretFiles) {
      await removeSecretFile(mountedFile);
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
      const mountedFile = await writeSecretFile(
        filePath,
        value,
        cwd,
        state.secretStateRoot,
      );
      mountedSecretFiles.push(mountedFile);
    }
  }

  if (runInBackground) {
    try {
      const record = startShell(state, command, cwd, envOverrides, () => {
        for (const mountedFile of mountedSecretFiles) {
          void removeSecretFile(mountedFile);
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
    const output = await runShell(state, command, cwd, timeout, envOverrides);
    return { result: truncate(output) };
  } finally {
    await cleanupMountedSecretFiles();
  }
};

export const handleShellStatus = async (
  state: ShellState,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");

  // If no shell_id provided, list all active shells
  if (!shellId) {
    const shells = [...state.shells.entries()].map(([id, r]) => ({
      id,
      command: r.command.slice(0, 100),
      running: r.running,
      exitCode: r.exitCode,
      elapsed: r.running ? `${Math.round((Date.now() - r.startedAt) / 1000)}s` : undefined,
    }));
    if (shells.length === 0) return { result: "No active shells." };
    return { result: JSON.stringify(shells, null, 2) };
  }

  const record = state.shells.get(shellId);
  if (!record) return { error: `Shell not found: ${shellId}` };

  const tail_lines = Number(args.tail_lines ?? 50);
  const output = record.output || "(no output yet)";
  // Get last N lines
  const lines = output.split("\n");
  const tail = truncate(lines.slice(-tail_lines).join("\n"));

  const status = record.running ? "running" : "completed";
  const elapsed = Math.round(((record.completedAt ?? Date.now()) - record.startedAt) / 1000);

  let result = `Shell ${shellId}: ${status}`;
  if (!record.running) result += ` (exit code: ${record.exitCode ?? "?"})`;
  result += ` | elapsed: ${elapsed}s`;
  result += `\nCommand: ${record.command.slice(0, 200)}`;
  result += `\n\n--- Output (last ${Math.min(tail_lines, lines.length)} lines) ---\n${tail}`;

  return { result };
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
