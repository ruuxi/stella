import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { transform } from "esbuild";
import { parse as parseYaml } from "yaml";

const EXECUTE_TYPESCRIPT_TOOL_NAME = "ExecuteTypescript";
const MAX_LIBRARY_DEPTH = 4;
const MAX_LOGS = 200;
const MAX_CALLS = 400;
const MAX_SEARCH_RESULTS = 200;

class ExecuteTypescriptError extends Error {
  constructor(message, phase) {
    super(message);
    this.name = "ExecuteTypescriptError";
    this.phase = phase;
  }
}

const truncate = (value, max = 240) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const previewUnknown = (value, max = 240) => {
  if (typeof value === "string") {
    return truncate(value, max).trim();
  }
  try {
    return truncate(JSON.stringify(value), max).trim();
  } catch {
    return truncate(String(value), max).trim();
  }
};

const ensureJsonSerializable = (value) => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new ExecuteTypescriptError(
      `Return value must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      "execute",
    );
  }
};

const withPhase = (error, phase) =>
  error instanceof ExecuteTypescriptError
    ? error
    : new ExecuteTypescriptError(
        error instanceof Error ? error.message : String(error),
        phase,
      );

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toPosix = (value) => value.split(path.sep).join("/");

const expandHomePath = (value) => {
  if (typeof value !== "string" || !value.startsWith("~")) {
    return value;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    return value;
  }
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const isWithinRoot = (root, targetPath) => {
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const toWorkspaceDisplayPath = (workspaceRoot, targetPath) => {
  if (workspaceRoot && isWithinRoot(workspaceRoot, targetPath)) {
    const relative = toPosix(path.relative(workspaceRoot, targetPath));
    return relative || ".";
  }
  return targetPath;
};

const toLifeDisplayPath = (lifeRoot, targetPath) => {
  if (!isWithinRoot(lifeRoot, targetPath)) {
    return targetPath;
  }
  const relative = toPosix(path.relative(lifeRoot, targetPath));
  return relative ? `life/${relative}` : "life";
};

const resolveWorkspacePath = (workspaceRoot, rawPath) => {
  const candidate = expandHomePath(String(rawPath));
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceRoot, candidate);
};

const resolvePathWithinRoot = (root, rawPath) => {
  const candidate = path.resolve(root, expandHomePath(String(rawPath)));
  if (!isWithinRoot(root, candidate)) {
    throw new ExecuteTypescriptError(`Path escapes allowed root: ${rawPath}`, "binding");
  }
  return candidate;
};

const parseMarkdownFrontmatter = (content) => {
  if (!content.startsWith("---")) {
    return {};
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) {
    return {};
  }
  try {
    return parseYaml(match[1]) ?? {};
  } catch {
    return {};
  }
};

const createExecutionTimer = (deadlineAt) => ({
  deadlineAt,
  getRemainingMs: () => Math.max(1, deadlineAt - Date.now()),
  assertAlive: (phase) => {
    if (deadlineAt - Date.now() <= 0) {
      throw new ExecuteTypescriptError("Execution timed out", phase);
    }
  },
});

const pushLog = (state, entry) => {
  if (state.logs.length < MAX_LOGS) {
    state.logs.push(entry);
  }
};

const pushCall = (state, entry) => {
  if (state.calls.length < MAX_CALLS) {
    state.calls.push(entry);
  }
};

const sendMessage = (message) => {
  if (typeof process.send === "function") {
    process.send(message);
  }
};

const emitUpdate = (result, details) => {
  sendMessage({ type: "update", result, details });
};

const WINDOWS_GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

const normalizeComputerAgentShellCommand = (command) =>
  command
    .replace(
      /(?:^|&&\s*|\|\|\s*|;\s*)STELLA_BROWSER_SESSION=[^\s]+(?=\s+stella-browser\b)/g,
      (match) => match.replace(/STELLA_BROWSER_SESSION=[^\s]+\s*/, ""),
    )
    .replace(/\bstella-browser\s+--session(?:=|\s+)\S+\s*/g, "stella-browser ")
    .replace(/\s{2,}/g, " ")
    .trim();

const shouldUseStellaBrowserBridge = (command) =>
  /\bstella-browser\b/.test(command) || /\bSTELLA_BROWSER_SESSION=/.test(command);

const resolveWindowsBash = () => {
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

const resolveShellLaunch = (command) => {
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

const buildCommandPreamble = (payload) => {
  const lines = [];

  if (payload.stellaBrowserBinPath) {
    lines.push(
      `stella-browser() { "$STELLA_NODE_BIN" ${shellQuote(payload.stellaBrowserBinPath)} "$@"; }`,
    );
  }

  if (payload.stellaOfficeBinPath) {
    lines.push(
      `stella-office() { "$STELLA_NODE_BIN" ${shellQuote(payload.stellaOfficeBinPath)} "$@"; }`,
    );
  }

  if (payload.stellaUiCliPath) {
    lines.push(`stella-ui() { "$STELLA_NODE_BIN" ${shellQuote(payload.stellaUiCliPath)} "$@"; }`);
  }

  return lines.join("\n");
};

const buildShellCommand = (command, payload) => {
  const preamble = buildCommandPreamble(payload);
  if (!preamble) {
    return command;
  }
  return `${preamble}\n${command}`;
};

const buildShellEnv = (payload, usesBrowserBridge) => {
  const env = {
    ...process.env,
    STELLA_NODE_BIN: process.execPath,
  };

  if (payload.stellaBrowserBinPath) {
    env.STELLA_BROWSER_BIN = payload.stellaBrowserBinPath;
  }
  if (payload.stellaOfficeBinPath) {
    env.STELLA_OFFICE_BIN = payload.stellaOfficeBinPath;
  }
  if (payload.stellaUiCliPath) {
    env.STELLA_UI_CLI = payload.stellaUiCliPath;
  }
  if (usesBrowserBridge && payload.stellaBrowserBridgeEnv) {
    Object.assign(env, payload.stellaBrowserBridgeEnv);
    if (payload.browserOwnerId) {
      env.STELLA_BROWSER_OWNER_ID = String(payload.browserOwnerId);
    }
  }

  return env;
};

const killShellProcess = (child, signal = "SIGTERM") => {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") {
      taskkillArgs.push("/f");
    }

    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });

    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // Ignore cleanup errors on fallback kill.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore cleanup errors when the child already exited.
    }
  }
};

const terminateShellProcess = (child) => {
  if (child.exitCode !== null) {
    return;
  }

  killShellProcess(child, "SIGTERM");

  const forceKillTimer = setTimeout(() => {
    if (child.exitCode !== null) {
      return;
    }
    killShellProcess(child, "SIGKILL");
  }, 1_000);
  forceKillTimer.unref?.();
};

const runCommand = async ({ command, cwd, timeoutMs, payload }) =>
  await new Promise((resolve, reject) => {
    const usesBrowserBridge = shouldUseStellaBrowserBridge(command);
    const normalizedCommand = usesBrowserBridge
      ? normalizeComputerAgentShellCommand(command)
      : command;
    const launch = resolveShellLaunch(buildShellCommand(normalizedCommand, payload));

    if ("error" in launch) {
      reject(new ExecuteTypescriptError(launch.error, "binding"));
      return;
    }

    const child = spawn(launch.shell, launch.args, {
      cwd,
      env: buildShellEnv(payload, usesBrowserBridge),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (callback) => {
      if (finished) {
        return;
      }
      finished = true;
      callback();
    };

    const timerId = setTimeout(() => {
      terminateShellProcess(child);
      finish(() =>
        reject(new ExecuteTypescriptError(`Command timed out: ${command}`, "binding")),
      );
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timerId);
      finish(() => reject(withPhase(error, "binding")));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timerId);
      finish(() => {
        const output = `${stdout}${stderr}`.trim();
        if (code === 0) {
          resolve(output || "Command completed successfully (no output).");
          return;
        }
        reject(
          new ExecuteTypescriptError(
            output ||
              `Command failed with exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${normalizedCommand}`,
            "binding",
          ),
        );
      });
    });
  });

const createBindingCall = async (runtime, binding, method, argsValue, fn) => {
  runtime.timer.assertAlive("binding");
  const startedAt = Date.now();
  const argsPreview = previewUnknown(argsValue);
  emitUpdate(`Code mode · ${binding}.${method} starting`, {
    tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
    kind: "binding_call",
    statusText: `Code mode · ${binding}.${method} starting`,
    binding,
    method,
    argsPreview,
  });
  try {
    const value = await fn();
    const durationMs = Date.now() - startedAt;
    const resultPreview = previewUnknown(value);
    pushCall(runtime.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      resultPreview,
    });
    emitUpdate(`Code mode · ${binding}.${method} finished`, {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "binding_result",
      statusText: `Code mode · ${binding}.${method} finished`,
      binding,
      method,
      durationMs,
      argsPreview,
      resultPreview,
    });
    return value;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : String(error);
    pushCall(runtime.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      error: errorMessage,
    });
    emitUpdate(`Code mode · ${binding}.${method} failed`, {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "binding_error",
      statusText: `Code mode · ${binding}.${method} failed`,
      binding,
      method,
      durationMs,
      argsPreview,
      error: errorMessage,
    });
    throw withPhase(error, binding === "libraries" ? "library" : "binding");
  }
};

const createConsoleBinding = (runtime) => {
  const write = (level, args) => {
    const message = args.map((entry) => previewUnknown(entry, 2_000)).join(" ");
    const entry = {
      level,
      message,
      timestamp: Date.now(),
    };
    pushLog(runtime.state, entry);
    emitUpdate(message, {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "console",
      statusText: `Code mode · console.${level}`,
      level,
      message,
    });
  };

  return {
    log: (...args) => write("log", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
};

const globToRegExp = (pattern) => {
  const normalized = toPosix(pattern);
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    regex += escapeRegExp(char);
  }
  regex += "$";
  return new RegExp(regex);
};

const walkFiles = async (basePath) => {
  const entries = await fs.readdir(basePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(basePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
};

const readTextFile = async (filePath, workspaceRoot) => {
  const resolved = resolveWorkspacePath(workspaceRoot, filePath);
  return {
    path: resolved,
    content: await fs.readFile(resolved, "utf8"),
  };
};

const writeTextFile = async (filePath, content, workspaceRoot) => {
  const resolved = resolveWorkspacePath(workspaceRoot, filePath);
  let created = false;
  try {
    await fs.stat(resolved);
  } catch {
    created = true;
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  return { path: resolved, created };
};

const replaceTextInFile = async (input, workspaceRoot) => {
  const resolved = resolveWorkspacePath(workspaceRoot, input.filePath);
  const content = await fs.readFile(resolved, "utf8");
  if (input.oldString.length === 0) {
    throw new ExecuteTypescriptError("oldString must not be empty", "binding");
  }
  const occurrences = content.split(input.oldString).length - 1;
  if (!input.replaceAll && occurrences > 1) {
    throw new ExecuteTypescriptError(
      "replaceText oldString matched multiple times. Pass replaceAll to replace every occurrence.",
      "binding",
    );
  }
  if (occurrences === 0) {
    throw new ExecuteTypescriptError(
      `replaceText oldString not found in ${input.filePath}`,
      "binding",
    );
  }
  const nextContent = input.replaceAll
    ? content.split(input.oldString).join(input.newString)
    : content.replace(input.oldString, input.newString);
  await fs.writeFile(resolved, nextContent, "utf8");
  return {
    path: resolved,
    replacements: input.replaceAll ? occurrences : 1,
  };
};

const runRegexSearch = async ({
  pattern,
  basePath,
  glob,
  type,
  mode,
  caseInsensitive,
  contextLines,
  maxResults,
  cwd,
  toDisplayPath,
}) => {
  const args = ["--color=never"];
  if (caseInsensitive) {
    args.push("-i");
  }
  if (glob) {
    args.push("--glob", glob);
  }
  if (type) {
    args.push("--type", type);
  }
  if (mode === "files") {
    args.push("-l");
  } else if (mode === "count") {
    args.push("-c");
  } else {
    args.push("-n");
    if (typeof contextLines === "number" && contextLines > 0) {
      args.push("-C", String(contextLines));
    }
  }
  args.push(pattern, basePath);
  const output = await new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(withPhase(error, "binding")));
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(
        new ExecuteTypescriptError(
          stderr.trim() || `rg failed with exit code ${code ?? "unknown"}`,
          "binding",
        ),
      );
    });
  });

  if (mode === "files") {
    const files = String(output)
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(0, maxResults)
      .map((entry) => toDisplayPath(path.resolve(cwd, entry)));
    return { mode: "files", files };
  }

  if (mode === "count") {
    const counts = String(output)
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(0, maxResults)
      .map((line) => {
        const index = line.lastIndexOf(":");
        const filePath = index >= 0 ? line.slice(0, index) : line;
        const countText = index >= 0 ? line.slice(index + 1) : "0";
        return {
          path: toDisplayPath(path.resolve(cwd, filePath)),
          count: Number.parseInt(countText, 10) || 0,
        };
      });
    return { mode: "count", counts };
  }

  return {
    mode: "content",
    text: String(output)
      .split(/\r?\n/u)
      .slice(0, maxResults * Math.max(1, (contextLines ?? 0) * 2 + 1))
      .join("\n"),
  };
};

const runLiteralSearch = async ({
  query,
  basePath,
  maxResults,
  cwd,
  toDisplayPath,
}) => {
  const args = ["--color=never", "-F", "-n", query, basePath];
  const output = await new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(withPhase(error, "binding")));
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(
        new ExecuteTypescriptError(
          stderr.trim() || `rg failed with exit code ${code ?? "unknown"}`,
          "binding",
        ),
      );
    });
  });

  return String(output)
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(0, maxResults)
    .map((line) => {
      const first = line.indexOf(":");
      const second = line.indexOf(":", first + 1);
      if (first < 0 || second < 0) {
        return {
          path: toDisplayPath(path.resolve(cwd, line)),
          line: 1,
          text: "",
        };
      }
      return {
        path: toDisplayPath(path.resolve(cwd, line.slice(0, first))),
        line: Number.parseInt(line.slice(first + 1, second), 10) || 1,
        text: line.slice(second + 1),
      };
    });
};

const createRuntime = (payload) => {
  const workspaceRoot = payload.stellaRoot || process.cwd();
  const lifeRoot = path.join(payload.stellaRoot, "life");
  const state = {
    logs: [],
    calls: [],
    libraries: [],
  };
  const timer = createExecutionTimer(Date.now() + payload.timeoutMs);
  const runtime = {
    payload,
    workspaceRoot,
    lifeRoot,
    state,
    timer,
  };

  const shellExec = async (command, options) =>
    await createBindingCall(
      runtime,
      "shell",
      "exec",
      {
        command:
          typeof command === "string" ? command : previewUnknown(command, 1_000),
        options: options ?? null,
      },
      async () => {
        if (typeof command !== "string") {
          if (command !== null && typeof command === "object" && "command" in command) {
            throw new ExecuteTypescriptError(
              "shell.exec now expects shell.exec(command, options?) with the command as the first argument.",
              "binding",
            );
          }
          throw new ExecuteTypescriptError(
            "shell.exec expects shell.exec(command, options?) with command as a string.",
            "binding",
          );
        }
        if (command.trim().length === 0) {
          throw new ExecuteTypescriptError(
            "shell.exec requires a non-empty command string.",
            "binding",
          );
        }
        if (
          options !== undefined &&
          (options === null || typeof options !== "object" || Array.isArray(options))
        ) {
          throw new ExecuteTypescriptError(
            "shell.exec options must be an object when provided.",
            "binding",
          );
        }
        if (options && "timeout" in options) {
          throw new ExecuteTypescriptError(
            "shell.exec uses timeoutMs in its second argument, not timeout.",
            "binding",
          );
        }
        runtime.timer.assertAlive("binding");
        return await runCommand({
          command,
          cwd: options?.workingDirectory
            ? resolveWorkspacePath(workspaceRoot, options.workingDirectory)
            : workspaceRoot,
          timeoutMs: Math.min(
            typeof options?.timeoutMs === "number"
              ? options.timeoutMs
              : runtime.timer.getRemainingMs(),
            runtime.timer.getRemainingMs(),
          ),
          payload: runtime.payload,
        });
      },
    );

  const consoleBinding = Object.freeze(createConsoleBinding(runtime));

  const runLibrary = async (libraryName, input, libraryDepth) => {
    const normalizedName = String(libraryName)
      .replace(/^life\/capabilities\//u, "")
      .replace(/^life\/libraries\//u, "")
      .replace(/^capabilities\//u, "")
      .replace(/^libraries\//u, "")
      .trim();
    if (!normalizedName) {
      throw new ExecuteTypescriptError("libraries.run requires a library name", "library");
    }
    if (libraryDepth >= MAX_LIBRARY_DEPTH) {
      throw new ExecuteTypescriptError(
        `Nested library depth exceeded (${MAX_LIBRARY_DEPTH})`,
        "library",
      );
    }
    return await createBindingCall(
      runtime,
      "libraries",
      "run",
      { name: normalizedName, input },
      async () => {
        const libraryDir = resolvePathWithinRoot(
          path.join(lifeRoot, "capabilities"),
          normalizedName,
        );
        const programPath = path.join(libraryDir, "program.ts");
        const code = await fs.readFile(programPath, "utf8").catch(() => null);
        if (code === null) {
          throw new ExecuteTypescriptError(
            `Capability program not found: ${toLifeDisplayPath(lifeRoot, programPath)}`,
            "library",
          );
        }
        emitUpdate(`Code mode · running capability ${normalizedName}`, {
          tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
          kind: "library_start",
          statusText: `Code mode · running capability ${normalizedName}`,
          library: normalizedName,
        });
        const startedAt = Date.now();
        try {
          const value = await executeProgram({
            runtime,
            code,
            sourceLabel: `life/capabilities/${normalizedName}/program.ts`,
            input,
            libraryDepth: libraryDepth + 1,
          });
          const durationMs = Date.now() - startedAt;
          runtime.state.libraries.push({
            name: normalizedName,
            durationMs,
            inputPreview: previewUnknown(input),
            resultPreview: previewUnknown(value),
          });
          emitUpdate(`Code mode · library ${normalizedName} finished`, {
            tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
            kind: "library_end",
            statusText: `Code mode · library ${normalizedName} finished`,
            library: normalizedName,
            durationMs,
            resultPreview: previewUnknown(value),
          });
          return value;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const errorMessage = error instanceof Error ? error.message : String(error);
          runtime.state.libraries.push({
            name: normalizedName,
            durationMs,
            inputPreview: previewUnknown(input),
            error: errorMessage,
          });
          emitUpdate(`Code mode · library ${normalizedName} failed`, {
            tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
            kind: "library_end",
            statusText: `Code mode · library ${normalizedName} failed`,
            library: normalizedName,
            durationMs,
            error: errorMessage,
          });
          throw withPhase(error, "library");
        }
      },
    );
  };

  const workspace = Object.freeze({
    readText: async (filePath) =>
      await createBindingCall(runtime, "workspace", "readText", { path: filePath }, async () => {
        const read = await readTextFile(filePath, workspaceRoot);
        return read.content;
      }),

    writeText: async (filePath, content) =>
      await createBindingCall(
        runtime,
        "workspace",
        "writeText",
        { path: filePath, bytes: String(content).length },
        async () => {
          const result = await writeTextFile(filePath, String(content), workspaceRoot);
          return {
            path: toWorkspaceDisplayPath(workspaceRoot, result.path),
            created: result.created,
          };
        },
      ),

    replaceText: async (input) =>
      await createBindingCall(
        runtime,
        "workspace",
        "replaceText",
        {
          path: input.path,
          oldText: previewUnknown(input.oldText, 120),
          newText: previewUnknown(input.newText, 120),
          replaceAll: input.replaceAll,
        },
        async () => {
          const result = await replaceTextInFile(
            {
              filePath: input.path,
              oldString: input.oldText,
              newString: input.newText,
              replaceAll: input.replaceAll,
            },
            workspaceRoot,
          );
          return {
            path: toWorkspaceDisplayPath(workspaceRoot, result.path),
            replacements: result.replacements,
          };
        },
      ),

    search: async (input) =>
      await createBindingCall(runtime, "workspace", "search", input, async () => {
        const basePath = input.path
          ? resolveWorkspacePath(workspaceRoot, input.path)
          : workspaceRoot;
        return await runRegexSearch({
          pattern: input.pattern,
          basePath,
          glob: input.glob,
          type: input.type,
          mode: input.mode ?? "files",
          caseInsensitive: input.caseInsensitive,
          contextLines: input.contextLines,
          maxResults: Math.min(input.maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
          cwd: workspaceRoot,
          toDisplayPath: (filePath) => toWorkspaceDisplayPath(workspaceRoot, filePath),
        });
      }),

    glob: async (pattern, input) =>
      await createBindingCall(
        runtime,
        "workspace",
        "glob",
        { pattern, path: input?.path },
        async () => {
          const basePath = input?.path
            ? resolveWorkspacePath(workspaceRoot, input.path)
            : workspaceRoot;
          const matcher = globToRegExp(toPosix(pattern));
          const files = await walkFiles(basePath);
          return files
            .map((filePath) => ({
              filePath,
              relative: toPosix(path.relative(basePath, filePath)),
            }))
            .filter((entry) => matcher.test(entry.relative))
            .map((entry) => toWorkspaceDisplayPath(workspaceRoot, entry.filePath));
        },
      ),

    gitStatus: async (input) =>
      await createBindingCall(runtime, "workspace", "gitStatus", input ?? {}, async () => {
        const pathArg = input?.path
          ? ` -- ${shellQuote(
              toWorkspaceDisplayPath(
                workspaceRoot,
                resolveWorkspacePath(workspaceRoot, input.path),
              ),
            )}`
          : "";
        return await shellExec(
          `git status ${input?.short === false ? "" : "--short"}${pathArg}`.trim(),
          {
            description: "Check git status",
            workingDirectory: workspaceRoot,
            timeoutMs: Math.min(15_000, runtime.timer.getRemainingMs()),
          },
        );
      }),

    gitDiff: async (input) =>
      await createBindingCall(runtime, "workspace", "gitDiff", input ?? {}, async () => {
        const pathArg = input?.path
          ? ` -- ${shellQuote(
              toWorkspaceDisplayPath(
                workspaceRoot,
                resolveWorkspacePath(workspaceRoot, input.path),
              ),
            )}`
          : "";
        const baseArg = input?.base ? ` ${input.base}` : "";
        const stagedArg = input?.staged ? " --staged" : "";
        return await shellExec(`git diff${stagedArg}${baseArg}${pathArg}`.trim(), {
          description: "Check git diff",
          workingDirectory: workspaceRoot,
          timeoutMs: Math.min(15_000, runtime.timer.getRemainingMs()),
        });
      }),
  });

  const life = Object.freeze({
    read: async (pathOrSlug) =>
      await createBindingCall(runtime, "life", "read", { pathOrSlug }, async () => {
        const normalized = String(pathOrSlug).replace(/^life\//u, "");
        const directPath = resolvePathWithinRoot(lifeRoot, normalized);
        try {
          return await fs.readFile(directPath, "utf8");
        } catch {
          const slug = normalized.replace(/^knowledge\//u, "").replace(/\.md$/u, "");
          const candidate = resolvePathWithinRoot(
            path.join(lifeRoot, "knowledge"),
            `${slug}.md`,
          );
          return await fs.readFile(candidate, "utf8");
        }
      }),

    list: async (area) =>
      await createBindingCall(runtime, "life", "list", { area }, async () => {
        const target = area ? resolvePathWithinRoot(lifeRoot, area) : lifeRoot;
        const entries = await fs.readdir(target, { withFileTypes: true });
        return entries
          .map((entry) => toLifeDisplayPath(lifeRoot, path.join(target, entry.name)))
          .sort();
      }),

    search: async (query, input) =>
      await createBindingCall(
        runtime,
        "life",
        "search",
        { query, area: input?.area, maxResults: input?.maxResults },
        async () => {
          const target = input?.area
            ? resolvePathWithinRoot(lifeRoot, input.area)
            : lifeRoot;
          return await runLiteralSearch({
            query,
            basePath: target,
            maxResults: Math.min(input?.maxResults ?? 20, MAX_SEARCH_RESULTS),
            cwd: lifeRoot,
            toDisplayPath: (filePath) => toLifeDisplayPath(lifeRoot, filePath),
          });
        },
      ),
  });

  const browser = Object.freeze({
    open: async (url) =>
      await createBindingCall(runtime, "browser", "open", { url }, async () => {
        return await shellExec(`stella-browser open ${shellQuote(url)}`, {
          description: "Open browser URL",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),

    snapshot: async (input = {}) =>
      await createBindingCall(runtime, "browser", "snapshot", input, async () => {
        const parts = ["stella-browser", "snapshot"];
        if (input.interactive !== false) {
          parts.push("-i");
        }
        if (input.compact) {
          parts.push("-c");
        }
        if (typeof input.depth === "number") {
          parts.push("-d", String(input.depth));
        }
        if (input.selector) {
          parts.push("-s", shellQuote(input.selector));
        }
        return await shellExec(parts.join(" "), {
          description: "Snapshot browser page",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),

    click: async (target) =>
      await createBindingCall(runtime, "browser", "click", { target }, async () => {
        return await shellExec(`stella-browser click ${shellQuote(target)}`, {
          description: "Click browser target",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),

    fill: async (target, value) =>
      await createBindingCall(
        runtime,
        "browser",
        "fill",
        { target, value: previewUnknown(value, 120) },
        async () => {
          return await shellExec(
            `stella-browser fill ${shellQuote(target)} ${shellQuote(String(value))}`,
            {
              description: "Fill browser field",
              timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
            },
          );
        },
      ),

    getText: async (target) =>
      await createBindingCall(runtime, "browser", "getText", { target }, async () => {
        return await shellExec(`stella-browser get text ${shellQuote(target)}`, {
          description: "Get browser text",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),

    wait: async (input) =>
      await createBindingCall(runtime, "browser", "wait", input, async () => {
        const parts = ["stella-browser", "wait"];
        if (typeof input === "number") {
          parts.push(String(input));
        } else {
          if (typeof input.ms === "number") {
            parts.push(String(input.ms));
          }
          if (input.text) {
            parts.push("--text", shellQuote(input.text));
          }
          if (input.url) {
            parts.push("--url", shellQuote(input.url));
          }
          if (input.load) {
            parts.push("--load", input.load);
          }
          if (input.fn) {
            parts.push("--fn", shellQuote(input.fn));
          }
          if (typeof input.timeoutMs === "number") {
            parts.push("--timeout", String(input.timeoutMs));
          }
        }
        return await shellExec(parts.join(" "), {
          description: "Wait in browser",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),
  });

  const office = Object.freeze({
    view: async (file, mode, input) =>
      await createBindingCall(runtime, "office", "view", { file, mode, ...input }, async () => {
        const parts = ["stella-office", "view", shellQuote(file), mode];
        if (input?.type) parts.push("--type", input.type);
        if (typeof input?.limit === "number") parts.push("--limit", String(input.limit));
        if (typeof input?.start === "number") parts.push("--start", String(input.start));
        if (typeof input?.end === "number") parts.push("--end", String(input.end));
        if (typeof input?.maxLines === "number") {
          parts.push("--max-lines", String(input.maxLines));
        }
        return await shellExec(parts.join(" "), {
          description: "View office file",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
      }),

    get: async (file, filePath, input) =>
      await createBindingCall(
        runtime,
        "office",
        "get",
        { file, path: filePath, ...input },
        async () => {
          const parts = ["stella-office", "get", shellQuote(file), shellQuote(filePath)];
          if (typeof input?.depth === "number") parts.push("--depth", String(input.depth));
          if (input?.json !== false) parts.push("--json");
          const output = await shellExec(parts.join(" "), {
            description: "Get office node",
            timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
          });
          return input?.json === false ? output : JSON.parse(output);
        },
      ),

    query: async (file, selector, input) =>
      await createBindingCall(
        runtime,
        "office",
        "query",
        { file, selector, ...input },
        async () => {
          const parts = ["stella-office", "query", shellQuote(file), shellQuote(selector)];
          if (input?.json !== false) parts.push("--json");
          const output = await shellExec(parts.join(" "), {
            description: "Query office file",
            timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
          });
          return input?.json === false ? output : JSON.parse(output);
        },
      ),

    set: async (file, filePath, props) =>
      await createBindingCall(
        runtime,
        "office",
        "set",
        { file, path: filePath, props },
        async () => {
          const parts = ["stella-office", "set", shellQuote(file), shellQuote(filePath)];
          for (const [key, value] of Object.entries(props)) {
            parts.push(
              "--prop",
              shellQuote(`${key}=${value === null ? "null" : String(value)}`),
            );
          }
          return await shellExec(parts.join(" "), {
            description: "Set office node",
            timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
          });
        },
      ),

    validate: async (file, input) =>
      await createBindingCall(runtime, "office", "validate", { file, ...input }, async () => {
        const parts = ["stella-office", "validate", shellQuote(file)];
        if (input?.json !== false) parts.push("--json");
        const output = await shellExec(parts.join(" "), {
          description: "Validate office file",
          timeoutMs: Math.min(20_000, runtime.timer.getRemainingMs()),
        });
        return input?.json === false ? output : JSON.parse(output);
      }),
  });

  const libraries = Object.freeze({
    list: async () =>
      await createBindingCall(runtime, "libraries", "list", {}, async () => {
        const librariesRoot = path.join(lifeRoot, "capabilities");
        let entries;
        try {
          entries = await fs.readdir(librariesRoot, { withFileTypes: true });
        } catch {
          return [];
        }
        const results = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const libraryDir = path.join(librariesRoot, entry.name);
          const indexPath = path.join(libraryDir, "index.md");
          const programPath = path.join(libraryDir, "program.ts");
          const [docs, hasProgram] = await Promise.all([
            fs.readFile(indexPath, "utf8").catch(() => null),
            fs.stat(programPath).then(() => true).catch(() => false),
          ]);
          const description = docs
            ? parseMarkdownFrontmatter(docs).description
            : undefined;
          results.push({
            name: entry.name,
            path: toLifeDisplayPath(lifeRoot, libraryDir),
            hasProgram,
            ...(description ? { description } : {}),
          });
        }
        return results.sort((a, b) => a.name.localeCompare(b.name));
      }),

    read: async (name) =>
      await createBindingCall(runtime, "libraries", "read", { name }, async () => {
        const normalizedName = String(name)
          .replace(/^life\/capabilities\//u, "")
          .replace(/^life\/libraries\//u, "")
          .replace(/^capabilities\//u, "")
          .replace(/^libraries\//u, "")
          .trim();
        const libraryDir = resolvePathWithinRoot(
          path.join(lifeRoot, "capabilities"),
          normalizedName,
        );
        const indexPath = path.join(libraryDir, "index.md");
        const programPath = path.join(libraryDir, "program.ts");
        const [docs, program] = await Promise.all([
          fs.readFile(indexPath, "utf8").catch(() => null),
          fs.readFile(programPath, "utf8").catch(() => null),
        ]);
        const description = docs
          ? parseMarkdownFrontmatter(docs).description
          : undefined;
        return {
          name: normalizedName,
          path: toLifeDisplayPath(lifeRoot, libraryDir),
          ...(description ? { description } : {}),
          ...(docs ? { docs } : {}),
          ...(program ? { program } : {}),
        };
      }),

    run: async (name, input) => await runLibrary(name, input, 0),
  });

  runtime.bindings = {
    workspace,
    life,
    browser,
    office,
    shell: Object.freeze({ exec: shellExec }),
    libraries,
    console: consoleBinding,
  };

  return runtime;
};

const executeProgram = async ({ runtime, code, sourceLabel, input, libraryDepth }) => {
  runtime.timer.assertAlive("compile");

  if (/\bimport\s+/u.test(code) || /\bexport\s+/u.test(code)) {
    throw new ExecuteTypescriptError(
      "Static import/export are not supported in Code Mode program bodies. Use require() or await import() instead.",
      "compile",
    );
  }

  const wrappedSource = `
module.exports = async function(__stella_bindings) {
  const { workspace, life, browser, office, shell, libraries, console, input } = __stella_bindings;
${code}
};
`;

  let transpiled;
  try {
    const result = await transform(wrappedSource, {
      loader: "ts",
      target: "es2022",
      format: "cjs",
      sourcemap: "inline",
      sourcefile: sourceLabel,
    });
    transpiled = result.code;
  } catch (error) {
    throw new ExecuteTypescriptError(
      error instanceof Error ? error.message : String(error),
      "compile",
    );
  }

  emitUpdate("Code mode · running program", {
    tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
    kind: "execution_started",
    statusText: "Code mode · running program",
  });

  try {
    const moduleObject = { exports: {} };
    const runnerFilename = path.join(
      runtime.workspaceRoot,
      `.__stella_execute_typescript_${libraryDepth}.cjs`,
    );
    const requireFn = createRequire(runnerFilename);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const evaluator = new AsyncFunction(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      transpiled,
    );
    await evaluator(
      requireFn,
      moduleObject,
      moduleObject.exports,
      runnerFilename,
      path.dirname(runnerFilename),
    );
    if (typeof moduleObject.exports !== "function") {
      throw new ExecuteTypescriptError(
        "Transpiled program did not export a runnable function.",
        "execute",
      );
    }
    return await moduleObject.exports({
      ...runtime.bindings,
      input,
    });
  } catch (error) {
    throw withPhase(error, "execute");
  }
};

const handlePayload = async (payload) => {
  const timeoutMs = Math.max(
    1_000,
    Math.min(
      Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 30_000,
      120_000,
    ),
  );
  const runtime = createRuntime({ ...payload, timeoutMs });
  try {
    const value = await executeProgram({
      runtime,
      code: String(payload.code ?? ""),
      sourceLabel: String(payload.sourceLabel ?? EXECUTE_TYPESCRIPT_TOOL_NAME),
      input: payload.input,
      libraryDepth: 0,
    });
    sendMessage({
      type: "result",
      value: ensureJsonSerializable(value),
      state: runtime.state,
    });
  } catch (error) {
    const typedError = withPhase(error, "execute");
    sendMessage({
      type: "error",
      message: typedError.message,
      phase: typedError.phase,
      state: runtime.state,
    });
  }
};

process.once("message", (payload) => {
  handlePayload(payload).finally(() => {
    setTimeout(() => process.exit(0), 0);
  });
});

