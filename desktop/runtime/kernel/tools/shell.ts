/**
 * Shell tools: Bash, KillShell handlers.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveGitDir, setupEnvironment } from "dugite";
import type { ToolContext, ToolResult, ShellRecord } from "./types.js";
import { truncate } from "./utils.js";
import { isDangerousCommand } from "./command-safety.js";
import { getStellaBrowserBridgeEnv } from "./stella-browser-bridge-config.js";
import type { OfficePreviewRef } from "../../../src/shared/contracts/office-preview.js";

export type ShellState = {
  shells: Map<string, ShellRecord>;
  secretStateRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaUiCliPath?: string;
};

const OFFICE_PREVIEW_REF_MARKER = "__STELLA_OFFICE_PREVIEW_REF__";

export const extractOfficePreviewRef = (
  output: string,
): { cleanedOutput: string; officePreviewRef?: OfficePreviewRef } => {
  let officePreviewRef: OfficePreviewRef | undefined;
  const keptLines: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(OFFICE_PREVIEW_REF_MARKER)) {
      keptLines.push(line);
      continue;
    }

    const rawPayload = line.slice(OFFICE_PREVIEW_REF_MARKER.length).trim();
    if (!rawPayload) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawPayload) as OfficePreviewRef;
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.sourcePath === "string"
      ) {
        officePreviewRef = parsed;
      }
    } catch {
      keptLines.push(line);
    }
  }

  const cleanedOutput = keptLines.join("\n").trim();
  return {
    cleanedOutput:
      cleanedOutput || (officePreviewRef ? "Started inline office preview." : ""),
    ...(officePreviewRef ? { officePreviewRef } : {}),
  };
};

export const createShellState = (
  secretStateRoot: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaUiCliPath?: string;
  },
): ShellState => ({
  shells: new Map(),
  secretStateRoot,
  stellaBrowserBinPath: options?.stellaBrowserBinPath,
  stellaOfficeBinPath: options?.stellaOfficeBinPath,
  stellaUiCliPath: options?.stellaUiCliPath,
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
    stellaOfficeBinPath?: string;
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
  const stellaOfficeBin =
    options?.stellaOfficeBinPath && existsSync(options.stellaOfficeBinPath)
      ? options.stellaOfficeBinPath
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
  "$STELLA_NODE_BIN" "$STELLA_DEFERRED_DELETE_HELPER" "$@"
}
__stella_git_exec() {
  if [ -n "$STELLA_GIT_BIN" ]; then
    "$STELLA_GIT_BIN" "$@"
  else
    command git "$@"
  fi
}
__stella_git_stage_feature_dependencies() {
  local repo_root
  repo_root="$(__stella_git_exec rev-parse --show-toplevel 2>/dev/null || true)"
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
    __stella_git_exec add -- "\${existing_files[@]}" >/dev/null 2>&1 || true
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
  __stella_git_exec "$@"
}
rm() { __stella_dd delete "$PWD" rm "$@"; }
rmdir() { __stella_dd delete "$PWD" rmdir "$@"; }
unlink() { __stella_dd delete "$PWD" unlink "$@"; }
del() { rm "$@"; }
erase() { rm "$@"; }
rd() { rmdir "$@"; }
powershell() { __stella_dd powershell "$PWD" "$(type -P powershell || true)" "$@"; }
pwsh() { __stella_dd powershell "$PWD" "$(type -P pwsh || true)" "$@"; }
${stellaBrowserBin ? `stella-browser() { "$STELLA_NODE_BIN" "$STELLA_BROWSER_BIN" "$@"; }` : ""}
${stellaOfficeBin ? `stella-office() { "$STELLA_NODE_BIN" "$STELLA_OFFICE_BIN" "$@"; }` : ""}
${stellaUiCli ? `stella-ui() { "$STELLA_NODE_BIN" "$STELLA_UI_CLI" "$@"; }` : ""}
${pythonFuncs}
export -f __stella_dd __stella_git_exec __stella_git_stage_feature_dependencies git rm rmdir unlink del erase rd powershell pwsh${stellaBrowserBin ? " stella-browser" : ""}${stellaOfficeBin ? " stella-office" : ""}${stellaUiCli ? " stella-ui" : ""}${pythonExports} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${rewriteDeleteBypassPatterns(command)}`;
};

const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaUiCliPath?: string;
  },
) => {
  const mergedEnv = {
    ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
    STELLA_NODE_BIN: process.execPath,
    STELLA_DEFERRED_DELETE_HELPER: deferredDeleteHelperPath,
    ...(options?.secretStateRoot ? { STELLA_UI_STATE_DIR: options.secretStateRoot } : {}),
    ...(options?.stellaBrowserBinPath ? { STELLA_BROWSER_BIN: options.stellaBrowserBinPath } : {}),
    ...(options?.stellaOfficeBinPath ? { STELLA_OFFICE_BIN: options.stellaOfficeBinPath } : {}),
    ...(options?.stellaUiCliPath ? { STELLA_UI_CLI: options.stellaUiCliPath } : {}),
  };

  return setupEnvironment(mergedEnv).env;
};

const getWin32GitSubfolder = () => {
  if (process.arch === "x64") {
    return "mingw64";
  }
  if (process.arch === "arm64") {
    return "clangarm64";
  }
  return "mingw32";
};

const WINDOWS_GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

const resolveWindowsBash = (): string | null => {
  try {
    const resolvedGitDir = resolveGitDir(process.env.LOCAL_GIT_DIRECTORY?.trim());
    const dugiteCandidates = [
      path.join(resolvedGitDir, getWin32GitSubfolder(), "bin", "bash.exe"),
      path.join(resolvedGitDir, getWin32GitSubfolder(), "usr", "bin", "bash.exe"),
      path.join(resolvedGitDir, "bin", "bash.exe"),
      path.join(resolvedGitDir, "usr", "bin", "bash.exe"),
    ];
    for (const candidate of dugiteCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall back to configured/system Git Bash locations.
  }

  const configured = process.env.STELLA_GIT_BASH?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  for (const candidate of WINDOWS_GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "bash.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const resolveShellLaunch = (
  command: string,
):
  | { shell: string; args: string[] }
  | { error: string } => {
  if (process.platform !== "win32") {
    return { shell: "bash", args: ["-lc", command] };
  }

  const bashPath = resolveWindowsBash();
  if (!bashPath) {
    return {
      error:
        "Git Bash was not found on this Windows machine. Install Git for Windows or add bash.exe to PATH.",
    };
  }

  return { shell: bashPath, args: ["-lc", command] };
};

export const normalizeComputerAgentShellCommand = (command: string) =>
  command
    .replace(
      /(?:^|&&\s*|\|\|\s*|;\s*)STELLA_BROWSER_SESSION=[^\s]+(?=\s+stella-browser\b)/g,
      (match) => match.replace(/STELLA_BROWSER_SESSION=[^\s]+\s*/, ""),
    )
    .replace(/\bstella-browser\s+--session(?:=|\s+)\S+\s*/g, "stella-browser ")
    .replace(/\s{2,}/g, " ")
    .trim();

const shouldUseStellaBrowserBridge = (command: string): boolean =>
  /\bstella-browser\b/.test(command) || /\bSTELLA_BROWSER_SESSION=/.test(command);

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
) => {
  const id = crypto.randomUUID();
  const protectedCommand = buildProtectedCommand(command, state);
  const launch = resolveShellLaunch(protectedCommand);

  if ("error" in launch) {
    const record: ShellRecord = {
      id,
      command,
      cwd,
      output: launch.error,
      running: false,
      exitCode: 127,
      startedAt: Date.now(),
      completedAt: Date.now(),
      kill: () => {},
    };
    state.shells.set(id, record);
    return record;
  }

  const child = spawn(launch.shell, launch.args, {
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
  const launch = resolveShellLaunch(protectedCommand);

  if ("error" in launch) {
    return launch.error;
  }

  return new Promise<string>((resolve) => {
    const child = spawn(launch.shell, launch.args, {
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

  if (shouldUseStellaBrowserBridge(command)) {
    // Browser automation uses one shared Stella browser bridge.
    // Runs should not fork ad-hoc sessions that bypass the app-owned bridge lifecycle.
    command = normalizeComputerAgentShellCommand(command);
    Object.assign(envOverrides, getStellaBrowserBridgeEnv());
  }

  if (runInBackground) {
    const record = startShell(state, command, cwd, envOverrides);
    const extracted = extractOfficePreviewRef(record.output || "");
    return {
      result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
        extracted.cleanedOutput || "(no output yet)",
      )}`,
      ...(extracted.officePreviewRef
        ? {
            details: {
              text: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
                extracted.cleanedOutput || "(no output yet)",
              )}`,
              officePreviewRef: extracted.officePreviewRef,
            },
          }
        : {}),
    };
  }

  const output = await runShell(state, command, cwd, timeout, envOverrides);
  const extracted = extractOfficePreviewRef(output);
  return {
    result: truncate(extracted.cleanedOutput),
    ...(extracted.officePreviewRef
      ? {
          details: {
            text: truncate(extracted.cleanedOutput),
            officePreviewRef: extracted.officePreviewRef,
          },
        }
      : {}),
  };
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
