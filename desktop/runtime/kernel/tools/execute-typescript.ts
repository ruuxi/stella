import { promises as fs } from "fs";
import type { Dirent } from "fs";
import path from "path";
import { spawn } from "child_process";
import { Script, createContext } from "node:vm";
import { transform } from "esbuild";
import { parse as parseYaml } from "yaml";
import { isBlockedPath } from "./command-safety.js";
import {
  EXECUTE_TYPESCRIPT_TOOL_NAME,
} from "./execute-typescript-contract.js";
import {
  readTextFile,
  replaceTextInFile,
  resolveFilePath,
  writeTextFile,
} from "./file.js";
import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolResult,
} from "./types.js";
import {
  expandHomePath,
  globToRegExp,
  readFileSafe,
  toPosix,
  truncate,
  walkFiles,
} from "./utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_LIBRARY_DEPTH = 4;
const MAX_LOGS = 200;
const MAX_CALLS = 400;
const MAX_SEARCH_RESULTS = 200;

type ExecutionPhase = "compile" | "execute" | "binding" | "library";

type ExecuteTypescriptLogEntry = {
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
};

type ExecuteTypescriptCallEntry = {
  binding: string;
  method: string;
  durationMs: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
};

type ExecuteTypescriptLibraryEntry = {
  name: string;
  durationMs: number;
  inputPreview?: string;
  resultPreview?: string;
  error?: string;
};

type ExecuteTypescriptDetails = {
  tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
  summary: string;
  success: boolean;
  value?: unknown;
  logs: ExecuteTypescriptLogEntry[];
  calls: ExecuteTypescriptCallEntry[];
  libraries: ExecuteTypescriptLibraryEntry[];
  error?: {
    message: string;
    phase: ExecutionPhase;
  };
};

type ExecuteTypescriptUpdate =
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "execution_started";
      statusText: string;
      summary?: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "binding_call" | "binding_result" | "binding_error";
      statusText: string;
      binding: string;
      method: string;
      durationMs?: number;
      argsPreview?: string;
      resultPreview?: string;
      error?: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "console";
      statusText: string;
      level: ExecuteTypescriptLogEntry["level"];
      message: string;
    }
  | {
      tool: typeof EXECUTE_TYPESCRIPT_TOOL_NAME;
      kind: "library_start" | "library_end";
      statusText: string;
      library: string;
      durationMs?: number;
      resultPreview?: string;
      error?: string;
    };

type ExecuteCapabilityTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
  extras?: ToolHandlerExtras,
) => Promise<ToolResult>;

type ExecuteTypescriptHandlerOptions = {
  stellaHomePath: string;
  frontendRoot?: string;
  executeCapabilityTool: ExecuteCapabilityTool;
};

type ExecutionTimer = {
  deadlineAt: number;
  getRemainingMs: () => number;
  assertAlive: (phase: ExecutionPhase) => void;
};

type ExecutionState = {
  logs: ExecuteTypescriptLogEntry[];
  calls: ExecuteTypescriptCallEntry[];
  libraries: ExecuteTypescriptLibraryEntry[];
};

type ExecutionEnvironment = {
  options: ExecuteTypescriptHandlerOptions;
  context: ToolContext;
  extras?: ToolHandlerExtras;
  timer: ExecutionTimer;
  state: ExecutionState;
  libraryDepth: number;
};

class ExecuteTypescriptError extends Error {
  readonly phase: ExecutionPhase;

  constructor(message: string, phase: ExecutionPhase) {
    super(message);
    this.name = "ExecuteTypescriptError";
    this.phase = phase;
  }
}

const previewUnknown = (value: unknown, max = 240): string => {
  if (typeof value === "string") {
    return truncate(value, max).trim();
  }
  try {
    return truncate(JSON.stringify(value), max).trim();
  } catch {
    return truncate(String(value), max).trim();
  }
};

const safeStructuredClone = <T>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const ensureJsonSerializable = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new ExecuteTypescriptError(
      `Return value must be JSON-serializable: ${(error as Error).message}`,
      "execute",
    );
  }
};

const withPhase = (error: unknown, phase: ExecutionPhase): ExecuteTypescriptError =>
  error instanceof ExecuteTypescriptError
    ? error
    : new ExecuteTypescriptError(
        error instanceof Error ? error.message : String(error),
        phase,
      );

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isWithinRoot = (root: string, targetPath: string): boolean => {
  const relative = path.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const toWorkspaceDisplayPath = (
  frontendRoot: string | undefined,
  targetPath: string,
): string => {
  if (frontendRoot && isWithinRoot(frontendRoot, targetPath)) {
    const relative = toPosix(path.relative(frontendRoot, targetPath));
    return relative || ".";
  }
  return targetPath;
};

const toLifeDisplayPath = (lifeRoot: string, targetPath: string): string => {
  if (!isWithinRoot(lifeRoot, targetPath)) {
    return targetPath;
  }
  const relative = toPosix(path.relative(lifeRoot, targetPath));
  return relative ? `life/${relative}` : "life";
};

const resolvePathWithinRoot = (root: string, rawPath: string): string => {
  const candidate = path.resolve(root, expandHomePath(rawPath));
  if (!isWithinRoot(root, candidate)) {
    throw new ExecuteTypescriptError(
      `Path escapes allowed root: ${rawPath}`,
      "binding",
    );
  }
  return candidate;
};

const createExecutionTimer = (
  timeoutMs: number,
  signal?: AbortSignal,
): ExecutionTimer => {
  const deadlineAt = Date.now() + timeoutMs;

  const assertAlive = (phase: ExecutionPhase) => {
    if (signal?.aborted) {
      throw new ExecuteTypescriptError("Execution aborted", phase);
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ExecuteTypescriptError("Execution timed out", phase);
    }
  };

  return {
    deadlineAt,
    getRemainingMs: () => Math.max(1, deadlineAt - Date.now()),
    assertAlive,
  };
};

const emitUpdate = (
  extras: ToolHandlerExtras | undefined,
  result: string,
  details: ExecuteTypescriptUpdate,
): void => {
  extras?.onUpdate?.({ result, details });
};

const pushLog = (
  state: ExecutionState,
  entry: ExecuteTypescriptLogEntry,
): void => {
  if (state.logs.length >= MAX_LOGS) {
    return;
  }
  state.logs.push(entry);
};

const pushCall = (
  state: ExecutionState,
  entry: ExecuteTypescriptCallEntry,
): void => {
  if (state.calls.length >= MAX_CALLS) {
    return;
  }
  state.calls.push(entry);
};

const resolveLifeReadPath = async (
  lifeRoot: string,
  pathOrSlug: string,
): Promise<string> => {
  const trimmed = pathOrSlug.trim();
  if (!trimmed) {
    throw new ExecuteTypescriptError("life.read requires a path or slug", "binding");
  }

  const directCandidates = [
    resolvePathWithinRoot(lifeRoot, trimmed),
    resolvePathWithinRoot(lifeRoot, `${trimmed}.md`),
  ];

  const heuristicCandidates = [
    path.join(lifeRoot, "knowledge", trimmed),
    path.join(lifeRoot, "knowledge", `${trimmed}.md`),
    path.join(lifeRoot, "knowledge", trimmed, "index.md"),
    path.join(lifeRoot, "libraries", trimmed, "index.md"),
    path.join(lifeRoot, "libraries", trimmed, "program.ts"),
    path.join(lifeRoot, trimmed, "index.md"),
  ];

  for (const candidate of [...directCandidates, ...heuristicCandidates]) {
    if (!isWithinRoot(lifeRoot, candidate)) {
      continue;
    }
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        continue;
      }
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new ExecuteTypescriptError(
    `No life entry found for ${pathOrSlug}`,
    "binding",
  );
};

const parseMarkdownFrontmatter = (
  markdown: string,
): { name?: string; description?: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(markdown);
  if (!match) {
    return {};
  }
  try {
    const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
    return {
      ...(typeof parsed?.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed?.description === "string"
        ? { description: parsed.description }
        : {}),
    };
  } catch {
    return {};
  }
};

const runCapturedProcess = async (args: {
  command: string;
  argv: string[];
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ code: number; stdout: string; stderr: string }> => {
  return await new Promise((resolve, reject) => {
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanupAbort = () => {
      if (args.signal) {
        args.signal.removeEventListener("abort", onAbort);
      }
    };

    const resolveOnce = (value: { code: number; stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbort();
      resolve(value);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbort();
      reject(error);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      rejectOnce(new Error("Process aborted"));
    };

    if (args.signal) {
      if (args.signal.aborted) {
        onAbort();
        return;
      }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("close", (code) => {
      resolveOnce({ code: code ?? 1, stdout, stderr });
    });
  });
};

const runRegexSearch = async (args: {
  pattern: string;
  basePath: string;
  glob?: string;
  type?: string;
  mode: "content" | "files" | "count";
  caseInsensitive?: boolean;
  contextLines?: number;
  maxResults: number;
  signal?: AbortSignal;
  frontendRoot?: string;
}): Promise<
  | { mode: "files"; files: string[] }
  | { mode: "count"; counts: Array<{ path: string; count: number }> }
  | { mode: "content"; text: string }
> => {
  const rgArgs: string[] = [];
  if (args.mode === "files") {
    rgArgs.push("-l");
  } else if (args.mode === "count") {
    rgArgs.push("-c");
  } else {
    rgArgs.push("-n");
    if (typeof args.contextLines === "number" && args.contextLines > 0) {
      rgArgs.push("-C", String(args.contextLines));
    }
  }
  if (args.caseInsensitive) {
    rgArgs.push("-i");
  }
  if (args.glob) {
    rgArgs.push("--glob", args.glob);
  }
  if (args.type) {
    rgArgs.push("--type", args.type);
  }
  rgArgs.push("--max-count", String(args.maxResults), args.pattern, args.basePath);

  try {
    const result = await runCapturedProcess({
      command: "rg",
      argv: rgArgs,
      cwd: args.basePath,
      signal: args.signal,
    });

    if (result.code > 1) {
      throw new Error(result.stderr || `rg exited ${result.code}`);
    }

    const output = result.stdout.trim();
    if (!output) {
      return args.mode === "files"
        ? { mode: "files", files: [] }
        : args.mode === "count"
          ? { mode: "count", counts: [] }
          : { mode: "content", text: "" };
    }

    if (args.mode === "files") {
      return {
        mode: "files",
        files: output
          .split("\n")
          .filter(Boolean)
          .map((entry) => toWorkspaceDisplayPath(args.frontendRoot, entry)),
      };
    }

    if (args.mode === "count") {
      return {
        mode: "count",
        counts: output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [filePath, countText] = line.split(":");
            return {
              path: toWorkspaceDisplayPath(args.frontendRoot, filePath),
              count: Number(countText ?? 0),
            };
          }),
      };
    }

    return { mode: "content", text: truncate(result.stdout) };
  } catch {
    const files = await walkFiles(args.basePath);
    const regex = new RegExp(args.pattern, args.caseInsensitive ? "gi" : "g");
    const globMatcher = args.glob ? globToRegExp(toPosix(args.glob)) : null;

    if (args.mode === "files") {
      const matches: string[] = [];
      for (const filePath of files) {
        if (matches.length >= args.maxResults) break;
        const relative = toPosix(path.relative(args.basePath, filePath));
        if (globMatcher && !globMatcher.test(relative)) {
          continue;
        }
        const read = await readFileSafe(filePath).catch(() => null);
        if (!read?.ok) continue;
        if (regex.test(read.content)) {
          matches.push(toWorkspaceDisplayPath(args.frontendRoot, filePath));
        }
        regex.lastIndex = 0;
      }
      return { mode: "files", files: matches };
    }

    if (args.mode === "count") {
      const counts: Array<{ path: string; count: number }> = [];
      for (const filePath of files) {
        if (counts.length >= args.maxResults) break;
        const relative = toPosix(path.relative(args.basePath, filePath));
        if (globMatcher && !globMatcher.test(relative)) {
          continue;
        }
        const read = await readFileSafe(filePath).catch(() => null);
        if (!read?.ok) continue;
        const lines = read.content.split("\n");
        let count = 0;
        for (const line of lines) {
          if (regex.test(line)) {
            count += 1;
          }
          regex.lastIndex = 0;
        }
        if (count > 0) {
          counts.push({
            path: toWorkspaceDisplayPath(args.frontendRoot, filePath),
            count,
          });
        }
      }
      return { mode: "count", counts };
    }

    const contentLines: string[] = [];
    for (const filePath of files) {
      if (contentLines.length >= args.maxResults) break;
      const relative = toPosix(path.relative(args.basePath, filePath));
      if (globMatcher && !globMatcher.test(relative)) {
        continue;
      }
      const read = await readFileSafe(filePath).catch(() => null);
      if (!read?.ok) continue;
      const lines = read.content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (regex.test(line)) {
          contentLines.push(
            `${toWorkspaceDisplayPath(args.frontendRoot, filePath)}:${index + 1}:${line}`,
          );
          if (contentLines.length >= args.maxResults) {
            break;
          }
        }
        regex.lastIndex = 0;
      }
    }
    return { mode: "content", text: truncate(contentLines.join("\n")) };
  }
};

const runLiteralSearch = async (args: {
  query: string;
  basePath: string;
  maxResults: number;
  signal?: AbortSignal;
  toDisplayPath: (filePath: string) => string;
}): Promise<Array<{ path: string; line: number; text: string }>> => {
  const escaped = escapeRegExp(args.query);
  const rgArgs = [
    "-n",
    "-i",
    "--max-count",
    String(args.maxResults),
    "--fixed-strings",
    args.query,
    args.basePath,
  ];

  try {
    const result = await runCapturedProcess({
      command: "rg",
      argv: rgArgs,
      cwd: args.basePath,
      signal: args.signal,
    });
    if (result.code > 1) {
      throw new Error(result.stderr || `rg exited ${result.code}`);
    }
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, args.maxResults)
      .map((line) => {
        const match = /^(.*?):(\d+):(.*)$/u.exec(line);
        if (!match) {
          return { path: args.toDisplayPath(line), line: 0, text: "" };
        }
        return {
          path: args.toDisplayPath(match[1]),
          line: Number(match[2]),
          text: match[3],
        };
      });
  } catch {
    const regex = new RegExp(escaped, "i");
    const files = await walkFiles(args.basePath);
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const filePath of files) {
      if (results.length >= args.maxResults) break;
      const read = await readFileSafe(filePath).catch(() => null);
      if (!read?.ok) continue;
      const lines = read.content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index])) {
          results.push({
            path: args.toDisplayPath(filePath),
            line: index + 1,
            text: lines[index],
          });
          if (results.length >= args.maxResults) {
            break;
          }
        }
      }
    }
    return results;
  }
};

const createConsoleBinding = (
  env: ExecutionEnvironment,
): Record<ExecuteTypescriptLogEntry["level"], (...args: unknown[]) => void> => {
  const makeLogger =
    (level: ExecuteTypescriptLogEntry["level"]) =>
    (...args: unknown[]) => {
      env.timer.assertAlive("execute");
      const message = args.map((entry) => previewUnknown(entry, 2000)).join(" ");
      pushLog(env.state, {
        level,
        message,
        timestamp: Date.now(),
      });
      emitUpdate(env.extras, `Code mode · console.${level}`, {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        kind: "console",
        statusText: `Code mode · console.${level}`,
        level,
        message,
      });
    };

  return {
    log: makeLogger("log"),
    info: makeLogger("info"),
    warn: makeLogger("warn"),
    error: makeLogger("error"),
  };
};

const createBindingCall = async <T>(
  env: ExecutionEnvironment,
  binding: string,
  method: string,
  argsValue: unknown,
  action: () => Promise<T>,
): Promise<T> => {
  env.timer.assertAlive("binding");
  const argsPreview = previewUnknown(argsValue);
  emitUpdate(env.extras, `Code mode · ${binding}.${method}`, {
    tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
    kind: "binding_call",
    statusText: `Code mode · ${binding}.${method}`,
    binding,
    method,
    argsPreview,
  });

  const startedAt = Date.now();
  try {
    const value = await action();
    env.timer.assertAlive("binding");
    const durationMs = Date.now() - startedAt;
    const resultPreview = previewUnknown(value);
    pushCall(env.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      resultPreview,
    });
    emitUpdate(env.extras, `Code mode · ${binding}.${method} finished`, {
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
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    pushCall(env.state, {
      binding,
      method,
      durationMs,
      argsPreview,
      error: errorMessage,
    });
    emitUpdate(env.extras, `Code mode · ${binding}.${method} failed`, {
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

const createShellExecutor = (env: ExecutionEnvironment) => {
  return async (args: {
    command: string;
    description?: string;
    workingDirectory?: string;
    timeoutMs?: number;
  }): Promise<string> =>
    await createBindingCall(env, "shell", "exec", args, async () => {
      const workingDirectory = args.workingDirectory
        ? resolveFilePath(args.workingDirectory, env.context)
        : env.context.frontendRoot ?? env.options.frontendRoot ?? process.cwd();
      const result = await env.options.executeCapabilityTool(
        "Bash",
        {
          command: args.command,
          ...(args.description ? { description: args.description } : {}),
          working_directory: workingDirectory,
          timeout: Math.min(
            typeof args.timeoutMs === "number"
              ? args.timeoutMs
              : env.timer.getRemainingMs(),
            env.timer.getRemainingMs(),
          ),
        },
        env.context,
        { signal: env.extras?.signal },
      );
      if (result.error) {
        throw new Error(result.error);
      }
      return typeof result.result === "string"
        ? result.result
        : previewUnknown(result.result, 8_000);
    });
};

const executeProgram = async (args: {
  env: ExecutionEnvironment;
  code: string;
  sourceLabel: string;
  input?: unknown;
}): Promise<unknown> => {
  args.env.timer.assertAlive("compile");

  if (
    /\bimport\s+/u.test(args.code) ||
    /\bexport\s+/u.test(args.code) ||
    /\brequire\s*\(/u.test(args.code) ||
    /\bchild_process\b/u.test(args.code) ||
    /\bprocess\./u.test(args.code)
  ) {
    throw new ExecuteTypescriptError(
      "Use Stella bindings instead of import/export/require/process APIs.",
      "compile",
    );
  }

  const wrappedSource = `(async () => {\n${args.code}\n})()`;
  let transpiled: string;
  try {
    const result = await transform(wrappedSource, {
      loader: "ts",
      target: "es2022",
      format: "cjs",
      sourcemap: "inline",
      sourcefile: args.sourceLabel,
    });
    transpiled = result.code;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new ExecuteTypescriptError(message, "compile");
  }

  const workspaceRoot =
    args.env.context.frontendRoot ?? args.env.options.frontendRoot ?? process.cwd();
  const lifeRoot = path.join(args.env.options.stellaHomePath, "life");
  const shell = createShellExecutor(args.env);

  const runLibrary = async (libraryName: string, input?: unknown): Promise<unknown> => {
    const normalizedName = libraryName
      .replace(/^life\/libraries\//u, "")
      .replace(/^libraries\//u, "")
      .trim();
    if (!normalizedName) {
      throw new ExecuteTypescriptError(
        "libraries.run requires a library name",
        "library",
      );
    }
    if (args.env.libraryDepth >= MAX_LIBRARY_DEPTH) {
      throw new ExecuteTypescriptError(
        `Nested library depth exceeded (${MAX_LIBRARY_DEPTH})`,
        "library",
      );
    }

    return await createBindingCall(args.env, "libraries", "run", {
      name: normalizedName,
      input,
    }, async () => {
      const libraryDir = resolvePathWithinRoot(
        path.join(lifeRoot, "libraries"),
        normalizedName,
      );
      const programPath = path.join(libraryDir, "program.ts");
      const read = await readFileSafe(programPath).catch(() => null);
      if (!read?.ok) {
        throw new ExecuteTypescriptError(
          `Library program not found: ${toLifeDisplayPath(lifeRoot, programPath)}`,
          "library",
        );
      }

      emitUpdate(args.env.extras, `Code mode · running library ${normalizedName}`, {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        kind: "library_start",
        statusText: `Code mode · running library ${normalizedName}`,
        library: normalizedName,
      });

      const startedAt = Date.now();
      try {
        const childEnv: ExecutionEnvironment = {
          ...args.env,
          libraryDepth: args.env.libraryDepth + 1,
        };
        const value = await executeProgram({
          env: childEnv,
          code: read.content,
          sourceLabel: `life/libraries/${normalizedName}/program.ts`,
          input,
        });
        const durationMs = Date.now() - startedAt;
        args.env.state.libraries.push({
          name: normalizedName,
          durationMs,
          inputPreview: previewUnknown(input),
          resultPreview: previewUnknown(value),
        });
        emitUpdate(args.env.extras, `Code mode · library ${normalizedName} finished`, {
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
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        args.env.state.libraries.push({
          name: normalizedName,
          durationMs,
          inputPreview: previewUnknown(input),
          error: errorMessage,
        });
        emitUpdate(args.env.extras, `Code mode · library ${normalizedName} failed`, {
          tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
          kind: "library_end",
          statusText: `Code mode · library ${normalizedName} failed`,
          library: normalizedName,
          durationMs,
          error: errorMessage,
        });
        throw withPhase(error, "library");
      }
    });
  };

  const workspace = Object.freeze({
    readText: async (filePath: string): Promise<string> =>
      await createBindingCall(args.env, "workspace", "readText", { path: filePath }, async () => {
        const { content } = await readTextFile(filePath, args.env.context);
        return content;
      }),

    writeText: async (
      filePath: string,
      content: string,
    ): Promise<{ path: string; created: boolean }> =>
      await createBindingCall(
        args.env,
        "workspace",
        "writeText",
        { path: filePath, bytes: content.length },
        async () => {
          const result = await writeTextFile(filePath, content, args.env.context);
          return {
            path: toWorkspaceDisplayPath(workspaceRoot, result.path),
            created: result.created,
          };
        },
      ),

    replaceText: async (input: {
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
    }): Promise<{ path: string; replacements: number }> =>
      await createBindingCall(
        args.env,
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
            args.env.context,
          );
          return {
            path: toWorkspaceDisplayPath(workspaceRoot, result.path),
            replacements: result.replacements,
          };
        },
      ),

    search: async (input: {
      pattern: string;
      path?: string;
      glob?: string;
      type?: string;
      mode?: "content" | "files" | "count";
      caseInsensitive?: boolean;
      contextLines?: number;
      maxResults?: number;
    }): Promise<
      | { mode: "files"; files: string[] }
      | { mode: "count"; counts: Array<{ path: string; count: number }> }
      | { mode: "content"; text: string }
    > =>
      await createBindingCall(
        args.env,
        "workspace",
        "search",
        input,
        async () => {
          const basePath = input.path
            ? resolveFilePath(input.path, args.env.context)
            : workspaceRoot;
          const pathBlock = isBlockedPath(basePath);
          if (pathBlock) {
            throw new ExecuteTypescriptError(pathBlock, "binding");
          }
          return await runRegexSearch({
            pattern: input.pattern,
            basePath,
            glob: input.glob,
            type: input.type,
            mode: input.mode ?? "files",
            caseInsensitive: input.caseInsensitive,
            contextLines: input.contextLines,
            maxResults: Math.min(
              input.maxResults ?? MAX_SEARCH_RESULTS,
              MAX_SEARCH_RESULTS,
            ),
            signal: args.env.extras?.signal,
            frontendRoot: workspaceRoot,
          });
        },
      ),

    glob: async (
      pattern: string,
      input?: { path?: string },
    ): Promise<string[]> =>
      await createBindingCall(
        args.env,
        "workspace",
        "glob",
        { pattern, path: input?.path },
        async () => {
          const basePath = input?.path
            ? resolveFilePath(input.path, args.env.context)
            : workspaceRoot;
          const pathBlock = isBlockedPath(basePath);
          if (pathBlock) {
            throw new ExecuteTypescriptError(pathBlock, "binding");
          }
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

    gitStatus: async (
      input?: { path?: string; short?: boolean },
    ): Promise<string> =>
      await createBindingCall(
        args.env,
        "workspace",
        "gitStatus",
        input ?? {},
        async () => {
          const cwd = workspaceRoot;
          const pathArg = input?.path
            ? ` -- ${shellQuote(
                toWorkspaceDisplayPath(
                  workspaceRoot,
                  resolveFilePath(input.path, args.env.context),
                ),
              )}`
            : "";
          return await shell({
            command: `git status ${input?.short === false ? "" : "--short"}${pathArg}`.trim(),
            description: "Check git status",
            workingDirectory: cwd,
            timeoutMs: Math.min(15_000, args.env.timer.getRemainingMs()),
          });
        },
      ),

    gitDiff: async (
      input?: { path?: string; staged?: boolean; base?: string },
    ): Promise<string> =>
      await createBindingCall(
        args.env,
        "workspace",
        "gitDiff",
        input ?? {},
        async () => {
          const pathArg = input?.path
            ? ` -- ${shellQuote(
                toWorkspaceDisplayPath(
                  workspaceRoot,
                  resolveFilePath(input.path, args.env.context),
                ),
              )}`
            : "";
          const baseArg = input?.base ? ` ${input.base}` : "";
          const stagedArg = input?.staged ? " --staged" : "";
          return await shell({
            command: `git diff${stagedArg}${baseArg}${pathArg}`.trim(),
            description: "Check git diff",
            workingDirectory: workspaceRoot,
            timeoutMs: Math.min(15_000, args.env.timer.getRemainingMs()),
          });
        },
      ),
  });

  const life = Object.freeze({
    read: async (pathOrSlug: string): Promise<string> =>
      await createBindingCall(args.env, "life", "read", { pathOrSlug }, async () => {
        const resolved = await resolveLifeReadPath(lifeRoot, pathOrSlug);
        const read = await readFileSafe(resolved);
        if (!read.ok) {
          throw new ExecuteTypescriptError(read.error, "binding");
        }
        return read.content;
      }),

    list: async (
      area?: "knowledge" | "notes" | "raw" | "outputs" | "libraries",
    ): Promise<string[]> =>
      await createBindingCall(args.env, "life", "list", { area }, async () => {
        const target = area ? resolvePathWithinRoot(lifeRoot, area) : lifeRoot;
        const entries = await fs.readdir(target, { withFileTypes: true });
        return entries
          .map((entry) => toLifeDisplayPath(lifeRoot, path.join(target, entry.name)))
          .sort();
      }),

    search: async (
      query: string,
      input?: {
        area?: "knowledge" | "notes" | "raw" | "outputs" | "libraries";
        maxResults?: number;
      },
    ): Promise<Array<{ path: string; line: number; text: string }>> =>
      await createBindingCall(
        args.env,
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
            maxResults: Math.min(
              input?.maxResults ?? 20,
              MAX_SEARCH_RESULTS,
            ),
            signal: args.env.extras?.signal,
            toDisplayPath: (filePath) => toLifeDisplayPath(lifeRoot, filePath),
          });
        },
      ),
  });

  const browser = Object.freeze({
    open: async (url: string): Promise<string> =>
      await createBindingCall(args.env, "browser", "open", { url }, async () => {
        return await shell({
          command: `stella-browser open ${shellQuote(url)}`,
          description: "Open browser URL",
          timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
        });
      }),

    snapshot: async (input?: {
      interactive?: boolean;
      compact?: boolean;
      depth?: number;
      selector?: string;
    }): Promise<string> =>
      await createBindingCall(
        args.env,
        "browser",
        "snapshot",
        input ?? {},
        async () => {
          const parts = ["stella-browser", "snapshot"];
          if (input?.interactive !== false) {
            parts.push("-i");
          }
          if (input?.compact) {
            parts.push("-c");
          }
          if (typeof input?.depth === "number") {
            parts.push("-d", String(input.depth));
          }
          if (input?.selector) {
            parts.push("-s", shellQuote(input.selector));
          }
          return await shell({
            command: parts.join(" "),
            description: "Snapshot browser page",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
        },
      ),

    click: async (target: string): Promise<string> =>
      await createBindingCall(args.env, "browser", "click", { target }, async () => {
        return await shell({
          command: `stella-browser click ${shellQuote(target)}`,
          description: "Click browser target",
          timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
        });
      }),

    fill: async (target: string, value: string): Promise<string> =>
      await createBindingCall(
        args.env,
        "browser",
        "fill",
        { target, value: previewUnknown(value, 120) },
        async () => {
          return await shell({
            command: `stella-browser fill ${shellQuote(target)} ${shellQuote(value)}`,
            description: "Fill browser field",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
        },
      ),

    getText: async (target: string): Promise<string> =>
      await createBindingCall(args.env, "browser", "getText", { target }, async () => {
        return await shell({
          command: `stella-browser get text ${shellQuote(target)}`,
          description: "Get browser text",
          timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
        });
      }),

    wait: async (
      input:
        | {
            ms?: number;
            text?: string;
            url?: string;
            load?: "load" | "domcontentloaded" | "networkidle";
            fn?: string;
            timeoutMs?: number;
          }
        | number,
    ): Promise<string> =>
      await createBindingCall(args.env, "browser", "wait", input, async () => {
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
        return await shell({
          command: parts.join(" "),
          description: "Wait in browser",
          timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
        });
      }),
  });

  const office = Object.freeze({
    view: async (
      file: string,
      mode: "outline" | "stats" | "issues" | "text" | "annotated",
      input?: {
        type?: "format" | "content" | "structure";
        limit?: number;
        start?: number;
        end?: number;
        maxLines?: number;
      },
    ): Promise<string> =>
      await createBindingCall(
        args.env,
        "office",
        "view",
        { file, mode, ...input },
        async () => {
          const parts = [
            "stella-office",
            "view",
            shellQuote(file),
            mode,
          ];
          if (input?.type) parts.push("--type", input.type);
          if (typeof input?.limit === "number") {
            parts.push("--limit", String(input.limit));
          }
          if (typeof input?.start === "number") {
            parts.push("--start", String(input.start));
          }
          if (typeof input?.end === "number") {
            parts.push("--end", String(input.end));
          }
          if (typeof input?.maxLines === "number") {
            parts.push("--max-lines", String(input.maxLines));
          }
          return await shell({
            command: parts.join(" "),
            description: "View office file",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
        },
      ),

    get: async (
      file: string,
      filePath: string,
      input?: { depth?: number; json?: boolean },
    ): Promise<unknown> =>
      await createBindingCall(
        args.env,
        "office",
        "get",
        { file, path: filePath, ...input },
        async () => {
          const parts = [
            "stella-office",
            "get",
            shellQuote(file),
            shellQuote(filePath),
          ];
          if (typeof input?.depth === "number") {
            parts.push("--depth", String(input.depth));
          }
          if (input?.json !== false) {
            parts.push("--json");
          }
          const output = await shell({
            command: parts.join(" "),
            description: "Get office node",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
          return input?.json === false ? output : JSON.parse(output);
        },
      ),

    query: async (
      file: string,
      selector: string,
      input?: { json?: boolean },
    ): Promise<unknown> =>
      await createBindingCall(
        args.env,
        "office",
        "query",
        { file, selector, ...input },
        async () => {
          const parts = [
            "stella-office",
            "query",
            shellQuote(file),
            shellQuote(selector),
          ];
          if (input?.json !== false) {
            parts.push("--json");
          }
          const output = await shell({
            command: parts.join(" "),
            description: "Query office file",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
          return input?.json === false ? output : JSON.parse(output);
        },
      ),

    set: async (
      file: string,
      filePath: string,
      props: Record<string, string | number | boolean | null>,
    ): Promise<string> =>
      await createBindingCall(
        args.env,
        "office",
        "set",
        { file, path: filePath, props },
        async () => {
          const parts = [
            "stella-office",
            "set",
            shellQuote(file),
            shellQuote(filePath),
          ];
          for (const [key, value] of Object.entries(props)) {
            parts.push("--prop", shellQuote(`${key}=${value === null ? "null" : String(value)}`));
          }
          return await shell({
            command: parts.join(" "),
            description: "Set office node",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
        },
      ),

    validate: async (
      file: string,
      input?: { json?: boolean },
    ): Promise<unknown> =>
      await createBindingCall(
        args.env,
        "office",
        "validate",
        { file, ...input },
        async () => {
          const parts = [
            "stella-office",
            "validate",
            shellQuote(file),
          ];
          if (input?.json !== false) {
            parts.push("--json");
          }
          const output = await shell({
            command: parts.join(" "),
            description: "Validate office file",
            timeoutMs: Math.min(20_000, args.env.timer.getRemainingMs()),
          });
          return input?.json === false ? output : JSON.parse(output);
        },
      ),
  });

  const libraries = Object.freeze({
    list: async (): Promise<
      Array<{ name: string; path: string; hasProgram: boolean; description?: string }>
    > =>
      await createBindingCall(args.env, "libraries", "list", {}, async () => {
        const librariesRoot = path.join(lifeRoot, "libraries");
        let entries: Dirent[];
        try {
          entries = await fs.readdir(librariesRoot, { withFileTypes: true });
        } catch {
          return [];
        }

        const results: Array<{
          name: string;
          path: string;
          hasProgram: boolean;
          description?: string;
        }> = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const libraryDir = path.join(librariesRoot, entry.name);
          const indexPath = path.join(libraryDir, "index.md");
          const programPath = path.join(libraryDir, "program.ts");
          const [indexExists, programExists] = await Promise.all([
            fs.stat(indexPath).then(() => true).catch(() => false),
            fs.stat(programPath).then(() => true).catch(() => false),
          ]);
          let description: string | undefined;
          if (indexExists) {
            const read = await readFileSafe(indexPath).catch(() => null);
            if (read?.ok) {
              const frontmatter = parseMarkdownFrontmatter(read.content);
              description = frontmatter.description;
            }
          }
          results.push({
            name: entry.name,
            path: toLifeDisplayPath(lifeRoot, libraryDir),
            hasProgram: programExists,
            ...(description ? { description } : {}),
          });
        }

        return results.sort((a, b) => a.name.localeCompare(b.name));
      }),

    read: async (
      name: string,
    ): Promise<{
      name: string;
      path: string;
      description?: string;
      docs?: string;
      program?: string;
    }> =>
      await createBindingCall(args.env, "libraries", "read", { name }, async () => {
        const normalizedName = name
          .replace(/^life\/libraries\//u, "")
          .replace(/^libraries\//u, "")
          .trim();
        const libraryDir = resolvePathWithinRoot(
          path.join(lifeRoot, "libraries"),
          normalizedName,
        );
        const indexPath = path.join(libraryDir, "index.md");
        const programPath = path.join(libraryDir, "program.ts");
        const [docsRead, programRead] = await Promise.all([
          readFileSafe(indexPath).catch(() => null),
          readFileSafe(programPath).catch(() => null),
        ]);

        const description = docsRead?.ok
          ? parseMarkdownFrontmatter(docsRead.content).description
          : undefined;

        return {
          name: normalizedName,
          path: toLifeDisplayPath(lifeRoot, libraryDir),
          ...(description ? { description } : {}),
          ...(docsRead?.ok ? { docs: docsRead.content } : {}),
          ...(programRead?.ok ? { program: programRead.content } : {}),
        };
      }),

    run: async (name: string, input?: unknown): Promise<unknown> =>
      await runLibrary(name, input),
  });

  emitUpdate(args.env.extras, "Code mode · running program", {
    tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
    kind: "execution_started",
    statusText: "Code mode · running program",
  });

  const consoleBinding = Object.freeze(createConsoleBinding(args.env));
  const sandbox = {
    workspace,
    life,
    browser,
    office,
    shell: Object.freeze({
      exec: shell,
    }),
    libraries,
    console: consoleBinding,
    input: args.input,
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    structuredClone: safeStructuredClone,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    fetch: undefined,
    Function: undefined,
    eval: undefined,
  } as Record<string, unknown>;
  sandbox.globalThis = sandbox;

  try {
    const context = createContext(sandbox, {
      name: EXECUTE_TYPESCRIPT_TOOL_NAME,
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new Script(transpiled, {
      filename: args.sourceLabel,
    });
    const execution = script.runInContext(context, {
      timeout: Math.max(1, Math.min(args.env.timer.getRemainingMs(), MAX_TIMEOUT_MS)),
    }) as Promise<unknown>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      const remaining = args.env.timer.getRemainingMs();
      const timeoutId = setTimeout(() => {
        reject(new ExecuteTypescriptError("Execution timed out", "execute"));
      }, remaining);
      args.env.extras?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeoutId);
          reject(new ExecuteTypescriptError("Execution aborted", "execute"));
        },
        { once: true },
      );
    });

    return await Promise.race([execution, timeoutPromise]);
  } catch (error) {
    throw withPhase(error, "execute");
  }
};

export const createExecuteTypescriptToolHandlers = (
  options: ExecuteTypescriptHandlerOptions,
): Record<string, ToolHandler> => ({
  [EXECUTE_TYPESCRIPT_TOOL_NAME]: async (
    rawArgs,
    context,
    extras,
  ): Promise<ToolResult> => {
    const summary = String(rawArgs.summary ?? "").trim();
    const code = String(rawArgs.code ?? "");
    const requestedTimeout = Number(rawArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(
      1_000,
      Math.min(
        Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
    );

    if (!summary) {
      return { error: "summary is required." };
    }
    if (!code.trim()) {
      return { error: "code is required." };
    }

    const timer = createExecutionTimer(timeoutMs, extras?.signal);
    const state: ExecutionState = {
      logs: [],
      calls: [],
      libraries: [],
    };

    emitUpdate(extras, "Code mode · compiling program", {
      tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
      kind: "execution_started",
      statusText: "Code mode · compiling program",
      summary,
    });

    try {
      const value = await executeProgram({
        env: {
          options,
          context,
          extras,
          timer,
          state,
          libraryDepth: 0,
        },
        code,
        sourceLabel: EXECUTE_TYPESCRIPT_TOOL_NAME,
      });
      const serializedValue = ensureJsonSerializable(value);
      const details: ExecuteTypescriptDetails = {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        summary,
        success: true,
        ...(serializedValue !== undefined ? { value: serializedValue } : {}),
        logs: state.logs,
        calls: state.calls,
        libraries: state.libraries,
      };
      return {
        result: serializedValue === undefined ? "Program completed." : serializedValue,
        details,
      };
    } catch (error) {
      const typedError = withPhase(error, "execute");
      const details: ExecuteTypescriptDetails = {
        tool: EXECUTE_TYPESCRIPT_TOOL_NAME,
        summary,
        success: false,
        logs: state.logs,
        calls: state.calls,
        libraries: state.libraries,
        error: {
          message: typedError.message,
          phase: typedError.phase,
        },
      };
      return {
        error: `${EXECUTE_TYPESCRIPT_TOOL_NAME} failed during ${typedError.phase}: ${typedError.message}`,
        details,
      };
    }
  },
});
