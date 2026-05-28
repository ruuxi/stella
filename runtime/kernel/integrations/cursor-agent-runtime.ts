import crypto from "node:crypto";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";
import type { AgentOptions, SDKImage, SDKMessage } from "@cursor/sdk";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import {
  type AgentRuntimeEngine,
  fromCursorModelOverrideId,
  isCursorModelOverride,
} from "../../contracts/agent-engine.js";
import { getModelOverride } from "../preferences/local-preferences.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import {
  DEFAULT_CURSOR_MODEL,
  loadLocalPreferences,
} from "../preferences/local-preferences.js";
import { getLocalLlmCredential } from "../storage/llm-credentials.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CURSOR_STARTUP_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CURSOR_NODE_RUNNER_SIGTERM_TIMEOUT_MS = 1_500;
const CURSOR_NODE_RUNNER_SIGKILL_TIMEOUT_MS = 4_000;
const CURSOR_CREDENTIAL_PROVIDER = "cursor";
const CURSOR_NODE_RUNNER_FILENAME = "cursor-agent-node-runner.js";

export type CursorAgentRuntimeEngine = AgentRuntimeEngine;

export type CursorWorktreeEntry = {
  path: string;
  status: string;
  movePath?: string;
};

export type CursorWorktreeSnapshot = {
  repoRoot: string;
  entries: Map<string, CursorWorktreeEntry>;
  fingerprints: Map<string, string | null>;
};

export type CursorAgentTurnResult = {
  text: string;
  sessionId: string;
  fileChanges?: FileChangeRecord[];
};

export const shouldUseCursorAgentRuntime = (args: {
  agentType?: string;
  agentEngine?: CursorAgentRuntimeEngine;
  model?: string;
}): boolean => {
  if (args.agentType !== AGENT_IDS.GENERAL) return false;
  if (args.agentEngine === "cursor_sdk") return true;
  return isCursorModelOverride(args.model);
};

const normalizeGitPath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

const statusKeyForEntry = (entry: CursorWorktreeEntry): string =>
  entry.movePath ?? entry.path;

const absoluteRepoPath = (repoRoot: string, repoRelativePath: string): string =>
  path.resolve(repoRoot, repoRelativePath);

const parseStatusLine = (line: string): CursorWorktreeEntry | null => {
  if (!line || line.length < 4) return null;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  const renameMarker = rawPath.lastIndexOf(" -> ");
  if (renameMarker >= 0) {
    return {
      status,
      path: normalizeGitPath(rawPath.slice(0, renameMarker)),
      movePath: normalizeGitPath(rawPath.slice(renameMarker + 4)),
    };
  }
  return {
    status,
    path: normalizeGitPath(rawPath),
  };
};

export const parseCursorGitStatus = (
  stdout: string,
): Map<string, CursorWorktreeEntry> => {
  const entries = new Map<string, CursorWorktreeEntry>();
  for (const line of stdout.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const entry = parseStatusLine(line);
    if (!entry) continue;
    entries.set(statusKeyForEntry(entry), entry);
  }
  return entries;
};

const runGit = async (
  repoRoot: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> => {
  const { env, gitLocation } = setupEnvironment(process.env);
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch {
    return { ok: false, stdout: "" };
  }
};

const fingerprintFile = async (
  repoRoot: string,
  repoRelativePath: string,
): Promise<string | null> => {
  try {
    const data = await readFile(absoluteRepoPath(repoRoot, repoRelativePath));
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
};

export const snapshotCursorWorktree = async (
  repoRoot: string | undefined,
): Promise<CursorWorktreeSnapshot | null> => {
  const root = repoRoot?.trim();
  if (!root) return null;
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return null;
  }
  const status = await runGit(root, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!status.ok) return null;
  const entries = parseCursorGitStatus(status.stdout);
  const fingerprints = new Map<string, string | null>();
  for (const [key, entry] of entries) {
    fingerprints.set(
      key,
      await fingerprintFile(root, statusKeyForEntry(entry)),
    );
  }
  return { repoRoot: root, entries, fingerprints };
};

const entryToChange = (
  snapshot: CursorWorktreeSnapshot,
  entry: CursorWorktreeEntry,
): FileChangeRecord => {
  const status = entry.status;
  const changePath = absoluteRepoPath(snapshot.repoRoot, entry.path);
  const movePath = entry.movePath
    ? absoluteRepoPath(snapshot.repoRoot, entry.movePath)
    : undefined;
  if (status === "??" || status.includes("A")) {
    return { path: movePath ?? changePath, kind: { type: "add" } };
  }
  if (status.includes("D") && !status.includes("A")) {
    return { path: changePath, kind: { type: "delete" } };
  }
  return {
    path: changePath,
    kind: {
      type: "update",
      ...(movePath ? { move_path: movePath } : {}),
    },
  };
};

export const diffCursorWorktreeSnapshots = (
  before: CursorWorktreeSnapshot | null,
  after: CursorWorktreeSnapshot | null,
): FileChangeRecord[] => {
  if (!before || !after || before.repoRoot !== after.repoRoot) {
    return [];
  }
  const changes: FileChangeRecord[] = [];
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const key of keys) {
    const beforeEntry = before.entries.get(key);
    const afterEntry = after.entries.get(key);
    const beforeFingerprint = before.fingerprints.get(key);
    const afterFingerprint = after.fingerprints.get(key);
    if (!beforeEntry && afterEntry) {
      changes.push(entryToChange(after, afterEntry));
      continue;
    }
    if (beforeEntry && !afterEntry) {
      if (beforeFingerprint === afterFingerprint) continue;
      const absolutePath = absoluteRepoPath(
        before.repoRoot,
        statusKeyForEntry(beforeEntry),
      );
      changes.push({
        path: absolutePath,
        kind: existsSync(absolutePath)
          ? { type: "update" }
          : { type: "delete" },
      });
      continue;
    }
    if (!beforeEntry || !afterEntry) continue;
    if (
      beforeEntry.status !== afterEntry.status ||
      beforeEntry.path !== afterEntry.path ||
      beforeEntry.movePath !== afterEntry.movePath ||
      beforeFingerprint !== afterFingerprint
    ) {
      changes.push(entryToChange(after, afterEntry));
    }
  }
  return changes;
};

const readCursorApiKey = (stellaHome?: string): string => {
  const envKey =
    process.env.CURSOR_API_KEY?.trim() ||
    process.env.STELLA_CURSOR_API_KEY?.trim();
  if (envKey) return envKey;
  if (!stellaHome?.trim()) return "";
  return getLocalLlmCredential(stellaHome, CURSOR_CREDENTIAL_PROVIDER) ?? "";
};

const cursorImageFromAttachment = (
  attachment: RuntimeAttachmentRef,
): SDKImage | null => {
  if (!attachment.mimeType?.startsWith("image/")) return null;
  if (attachment.url.startsWith("data:")) {
    const match = attachment.url.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return {
      data: match[2] ?? "",
      mimeType: match[1] ?? attachment.mimeType,
    };
  }
  return { url: attachment.url };
};

const formatCursorPromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  const attrs = [
    `index="${index + 1}"`,
    `type="${messageType}"`,
    `visibility="${visibility}"`,
    ...(customType
      ? [`customType="${customType.replaceAll('"', "&quot;")}"`]
      : []),
  ].join(" ");
  return `<message ${attrs}>\n${message.text.trim()}\n</message>`;
};

export const buildCursorPromptFromMessages = (args: {
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
}): string =>
  [
    "Stella is delegating this spawned agent turn to Cursor.",
    "Follow the Stella system instructions and complete the user's delegated goal. Hidden messages are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.",
    `<stella_system_prompt>\n${args.systemPrompt.trim()}\n</stella_system_prompt>`,
    ...args.promptMessages.map(formatCursorPromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const statusTextFromMessage = (message: SDKMessage): string | null => {
  if (message.type === "thinking" && message.text.trim()) {
    return message.text.trim();
  }
  if (message.type === "status") {
    return (message.message ?? message.status).trim();
  }
  if (message.type === "task" && message.text?.trim()) {
    return message.text.trim();
  }
  if (message.type === "tool_call") {
    return `${message.name} ${message.status}`.trim();
  }
  return null;
};

const cursorErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message.trim();
  }
  return String(error);
};

const configuredTimeoutMs = (envName: string, fallbackMs: number): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

export const isCursorSdkStreamError = (error: unknown): boolean => {
  const message = cursorErrorMessage(error);
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  if (
    message.includes("NGHTTP2_FRAME_SIZE_ERROR") ||
    message.includes("ERR_HTTP2_STREAM_ERROR") ||
    code === "ERR_HTTP2_STREAM_ERROR" ||
    message.includes("Stream closed with error code")
  ) {
    return true;
  }
  if (error instanceof Error && error.stack?.includes("@cursor/sdk")) {
    return message.includes("stream") || message.includes("Stream");
  }
  return false;
};

const normalizeCursorAgentError = (error: unknown): Error => {
  if (error instanceof Error && error.message === "Aborted") {
    return error;
  }
  if (isCursorSdkStreamError(error)) {
    return new Error(`Cursor stream failed: ${cursorErrorMessage(error)}`);
  }
  return error instanceof Error ? error : new Error(cursorErrorMessage(error));
};

let cursorSdkProcessGuardInstalled = false;
let activeCursorSdkRuns = 0;
let cursorSdkStreamErrorGraceUntil = 0;

const shouldSuppressCursorSdkProcessError = (error: unknown): boolean =>
  isCursorSdkStreamError(error) &&
  (activeCursorSdkRuns > 0 || Date.now() < cursorSdkStreamErrorGraceUntil);

const forwardFatalProcessError = (reason: unknown) => {
  setImmediate(() => {
    throw reason instanceof Error
      ? reason
      : new Error(cursorErrorMessage(reason));
  });
};

const installCursorSdkProcessErrorGuard = () => {
  if (cursorSdkProcessGuardInstalled) return;
  cursorSdkProcessGuardInstalled = true;

  process.prependListener("unhandledRejection", (reason) => {
    if (shouldSuppressCursorSdkProcessError(reason)) {
      process.stderr.write(
        `[stella:cursor-sdk] suppressed background stream rejection: ${cursorErrorMessage(reason)}\n`,
      );
      return;
    }
    forwardFatalProcessError(reason);
  });

  process.prependListener("uncaughtException", (error) => {
    if (shouldSuppressCursorSdkProcessError(error)) {
      process.stderr.write(
        `[stella:cursor-sdk] suppressed background stream exception: ${cursorErrorMessage(error)}\n`,
      );
      return;
    }
    forwardFatalProcessError(error);
  });
};

export const withCursorSdkStreamErrorGuard = async <T>(
  callback: () => Promise<T>,
): Promise<T> => {
  installCursorSdkProcessErrorGuard();
  activeCursorSdkRuns += 1;
  try {
    return await callback();
  } finally {
    activeCursorSdkRuns = Math.max(0, activeCursorSdkRuns - 1);
    cursorSdkStreamErrorGraceUntil = Date.now() + 5_000;
  }
};

export const buildCursorAgentOptions = (args: {
  apiKey: string;
  model: AgentOptions["model"];
  cwd?: string;
  name?: string;
  idempotencyKey?: string;
}): AgentOptions => ({
  apiKey: args.apiKey,
  ...(args.name ? { name: args.name } : {}),
  model: args.model,
  local: {
    ...(args.cwd ? { cwd: args.cwd } : {}),
    settingSources: [],
    sandboxOptions: { enabled: false },
  },
  ...(args.cwd ? { platform: { workspaceRef: args.cwd } } : {}),
  ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
});

type CursorNodeRunnerRequest = {
  agentOptions: AgentOptions;
  prompt: string | { text: string; images: SDKImage[] };
  runId: string;
  sessionKey: string;
  persistedSessionId?: string;
};

type CursorNodeRunnerEvent =
  | { type: "status"; text: string }
  | { type: "stream"; text: string }
  | { type: "result"; text: string; sessionId: string }
  | { type: "error"; message: string; stack?: string };

export const shouldRunCursorSdkInNodeRunner = (): boolean =>
  process.env.STELLA_CURSOR_SDK_IN_PROCESS !== "1" &&
  Boolean((process.versions as { bun?: string }).bun);

export const resolveCursorNodeRunnerPath = (
  currentModulePath = fileURLToPath(import.meta.url),
): string => {
  const currentModuleDir = path.dirname(currentModulePath);
  const candidates = [
    path.join(currentModuleDir, CURSOR_NODE_RUNNER_FILENAME),
    // Release builds bundle this module into runtime/worker/entry.js while
    // leaving the Node runner emitted under runtime/kernel/integrations.
    path.resolve(
      currentModuleDir,
      "../kernel/integrations",
      CURSOR_NODE_RUNNER_FILENAME,
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

export const buildCursorNodeRunnerSpawnSpec = (
  runnerPath = resolveCursorNodeRunnerPath(),
): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} => {
  const explicitNode = process.env.STELLA_CURSOR_SDK_NODE_BINARY?.trim();
  if (explicitNode) {
    return {
      command: explicitNode,
      args: [runnerPath],
      env: {},
    };
  }

  const hostExecutable = process.env.STELLA_HOST_EXECUTABLE_PATH?.trim();
  const hostExecutableName = hostExecutable
    ? path.basename(hostExecutable).toLowerCase()
    : "";
  const hostLooksLikeElectron =
    hostExecutableName === "electron" ||
    hostExecutable?.toLowerCase().includes("/electron.app/");
  if (hostExecutable && hostLooksLikeElectron) {
    return {
      command: hostExecutable,
      args: [runnerPath],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  if (process.env.STELLA_CURSOR_SDK_DISABLE_PATH_NODE !== "1") {
    return {
      command: "node",
      args: [runnerPath],
      env: {},
    };
  }

  if (hostExecutable) {
    return {
      command: hostExecutable,
      args: [runnerPath],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  return {
    command: "node",
    args: [runnerPath],
    env: {},
  };
};

const parseCursorNodeRunnerLine = (
  line: string,
): CursorNodeRunnerEvent | null => {
  try {
    const parsed = JSON.parse(line) as Partial<CursorNodeRunnerEvent>;
    if (
      parsed.type === "status" &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return parsed as CursorNodeRunnerEvent;
    }
    if (
      parsed.type === "stream" &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return parsed as CursorNodeRunnerEvent;
    }
    if (
      parsed.type === "result" &&
      typeof (parsed as { text?: unknown }).text === "string" &&
      typeof (parsed as { sessionId?: unknown }).sessionId === "string"
    ) {
      return parsed as CursorNodeRunnerEvent;
    }
    if (
      parsed.type === "error" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return parsed as CursorNodeRunnerEvent;
    }
  } catch {
    return null;
  }
  return null;
};

const cursorNodeRunnerCwd = (agentOptions: AgentOptions): string => {
  const cwd = agentOptions.local?.cwd;
  if (Array.isArray(cwd)) {
    return cwd[0] ?? process.cwd();
  }
  return cwd ?? process.cwd();
};

export const terminateCursorNodeRunnerProcess = (
  child: ChildProcessWithoutNullStreams,
) => {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Process may have already exited.
  }
  const sigkillTimer = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may have already exited.
      }
    }
  }, CURSOR_NODE_RUNNER_SIGKILL_TIMEOUT_MS);
  sigkillTimer.unref?.();
  child.once("exit", () => clearTimeout(sigkillTimer));
};

export const abortCursorNodeRunnerProcess = (
  child: ChildProcessWithoutNullStreams,
) => {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGINT");
  } catch {
    // Fall through to the harder kill path.
  }
  const sigtermTimer = setTimeout(
    () => terminateCursorNodeRunnerProcess(child),
    CURSOR_NODE_RUNNER_SIGTERM_TIMEOUT_MS,
  );
  sigtermTimer.unref?.();
  child.once("exit", () => clearTimeout(sigtermTimer));
};

const runCursorAgentTurnInNodeRunner = async (args: {
  request: CursorNodeRunnerRequest;
  abortSignal?: AbortSignal;
  onCancelReady?: (cancel: () => void) => void;
  onStatus?: (text: string) => void;
  onStream?: (chunk: string) => void;
}): Promise<CursorAgentTurnResult> => {
  const spec = buildCursorNodeRunnerSpawnSpec();
  const child = spawn(spec.command, spec.args, {
    cwd: cursorNodeRunnerCwd(args.request.agentOptions),
    env: {
      ...process.env,
      ...spec.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  args.onCancelReady?.(() => abortCursorNodeRunnerProcess(child));

  return await new Promise<CursorAgentTurnResult>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      args.abortSignal?.removeEventListener("abort", onAbort);
      args.onCancelReady?.(() => undefined);
      return true;
    };

    const resolveWith = (result: CursorAgentTurnResult) => {
      if (finish()) resolve(result);
    };

    const rejectWith = (error: Error) => {
      terminateCursorNodeRunnerProcess(child);
      if (finish()) reject(error);
    };

    const onAbort = () => {
      abortCursorNodeRunnerProcess(child);
      if (finish()) reject(new Error("Aborted"));
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const event = parseCursorNodeRunnerLine(trimmed);
      if (!event) return;
      if (event.type === "status") {
        args.onStatus?.(event.text);
        return;
      }
      if (event.type === "stream") {
        args.onStream?.(event.text);
        return;
      }
      if (event.type === "error") {
        const error = new Error(event.message);
        if (event.stack) error.stack = event.stack;
        rejectWith(error);
        return;
      }
      resolveWith({
        text: event.text,
        sessionId: event.sessionId,
      });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 16_000) {
        stderrBuffer = stderrBuffer.slice(-16_000);
      }
    });

    child.once("error", (error) => {
      rejectWith(error instanceof Error ? error : new Error(String(error)));
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer);
      }
      if (settled) return;
      rejectWith(
        new Error(
          `Cursor Node runner exited before returning a result (code=${code ?? "null"}, signal=${signal ?? "null"}).${stderrBuffer.trim() ? ` ${stderrBuffer.trim()}` : ""}`,
        ),
      );
    });

    if (args.abortSignal?.aborted) {
      onAbort();
      return;
    }
    args.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.end(`${JSON.stringify(args.request)}\n`);
  });
};

export const runCursorAgentTurn = async (request: {
  runId: string;
  sessionKey: string;
  persistedSessionId?: string;
  prompt: string;
  cwd?: string;
  stellaHome?: string;
  stellaRoot?: string;
  attachments?: RuntimeAttachmentRef[];
  abortSignal?: AbortSignal;
  onStatus?: (text: string) => void;
  onStream?: (chunk: string) => void;
}): Promise<CursorAgentTurnResult> => {
  request.onStatus?.("Starting Cursor");
  const apiKey = readCursorApiKey(request.stellaHome);
  if (!apiKey) {
    throw new Error(
      "Cursor API key is not configured. Set CURSOR_API_KEY or STELLA_CURSOR_API_KEY.",
    );
  }

  return await withCursorSdkStreamErrorGuard(async () => {
    const beforeSnapshot = await snapshotCursorWorktree(request.stellaRoot);
    const startupTimeoutMs = configuredTimeoutMs(
      "STELLA_CURSOR_STARTUP_TIMEOUT_MS",
      DEFAULT_CURSOR_STARTUP_TIMEOUT_MS,
    );
    const idleTimeoutMs = configuredTimeoutMs(
      "STELLA_CURSOR_IDLE_TIMEOUT_MS",
      DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleSettled = false;
    let hasCursorActivity = false;
    let cancelCurrentRun: (() => void) | undefined;
    let rejectIdle: (error: Error) => void = () => {};
    const idleFailure = new Promise<never>((_, reject) => {
      rejectIdle = reject;
    });
    const refreshCursorIdleTimer = () => {
      if (idleSettled) return;
      if (idleTimer) clearTimeout(idleTimer);
      const timeoutMs = hasCursorActivity ? idleTimeoutMs : startupTimeoutMs;
      idleTimer = setTimeout(() => {
        idleSettled = true;
        cancelCurrentRun?.();
        rejectIdle(
          new Error(
            `Cursor did not produce activity for ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);
      idleTimer.unref?.();
    };
    const markCursorActivity = () => {
      hasCursorActivity = true;
      refreshCursorIdleTimer();
    };
    const waitForCursorActivity = async <T>(
      promise: Promise<T>,
    ): Promise<T> => {
      refreshCursorIdleTimer();
      promise.catch(() => undefined);
      return await Promise.race([promise, idleFailure]);
    };

    const envModel = process.env.STELLA_CURSOR_MODEL?.trim();
    const generalOverride = request.stellaHome
      ? getModelOverride(request.stellaHome, AGENT_IDS.GENERAL)
      : undefined;
    const model = {
      id:
        envModel ||
        (isCursorModelOverride(generalOverride)
          ? fromCursorModelOverrideId(generalOverride)
          : request.stellaHome
            ? loadLocalPreferences(request.stellaHome).cursorModel
            : DEFAULT_CURSOR_MODEL),
    };
    const agentOptions = buildCursorAgentOptions({
      apiKey,
      model,
      cwd: request.cwd,
    });
    if (shouldRunCursorSdkInNodeRunner()) {
      const images = (request.attachments ?? [])
        .map(cursorImageFromAttachment)
        .filter((image): image is SDKImage => image !== null);
      const result = await waitForCursorActivity(
        runCursorAgentTurnInNodeRunner({
          request: {
            agentOptions,
            prompt:
              images.length > 0
                ? { text: request.prompt, images }
                : request.prompt,
            runId: request.runId,
            sessionKey: request.sessionKey,
            ...(request.persistedSessionId
              ? { persistedSessionId: request.persistedSessionId }
              : {}),
          },
          abortSignal: request.abortSignal,
          onCancelReady: (cancel) => {
            cancelCurrentRun = cancel;
          },
          onStatus: (status) => {
            markCursorActivity();
            request.onStatus?.(status);
          },
          onStream: (chunk) => {
            markCursorActivity();
            request.onStream?.(chunk);
          },
        }),
      );
      const afterSnapshot = await snapshotCursorWorktree(request.stellaRoot);
      const fileChanges = diffCursorWorktreeSnapshots(
        beforeSnapshot,
        afterSnapshot,
      );
      return {
        ...result,
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
      };
    }
    const { Agent } = await import("@cursor/sdk");
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;

    try {
      agent = request.persistedSessionId
        ? await waitForCursorActivity(
            Agent.resume(request.persistedSessionId, agentOptions),
          )
        : await waitForCursorActivity(
            Agent.create({
              ...agentOptions,
              name: "Stella General",
              idempotencyKey: request.sessionKey,
            }),
          );

      const images = (request.attachments ?? [])
        .map(cursorImageFromAttachment)
        .filter((image): image is SDKImage => image !== null);
      const run = await waitForCursorActivity(
        agent.send(
          images.length > 0 ? { text: request.prompt, images } : request.prompt,
          {
            idempotencyKey: request.runId,
            local: { force: true },
          },
        ),
      );
      const cancelOnAbort = () => {
        void run.cancel().catch(() => undefined);
      };
      cancelCurrentRun = cancelOnAbort;
      if (request.abortSignal?.aborted) {
        cancelOnAbort();
        throw new Error("Aborted");
      }
      request.abortSignal?.addEventListener("abort", cancelOnAbort, {
        once: true,
      });

      let collected = "";
      try {
        const streamIterator = run.stream()[Symbol.asyncIterator]();
        while (true) {
          const next = await waitForCursorActivity(streamIterator.next());
          if (next.done) break;
          const message = next.value;
          if (request.abortSignal?.aborted) {
            throw new Error("Aborted");
          }
          if (message.type === "assistant") {
            markCursorActivity();
            for (const block of message.message.content) {
              if (block.type !== "text") continue;
              collected += block.text;
              request.onStream?.(block.text);
            }
            continue;
          }
          const statusText = statusTextFromMessage(message);
          if (statusText) {
            markCursorActivity();
            request.onStatus?.(statusText);
          }
        }
      } finally {
        request.abortSignal?.removeEventListener("abort", cancelOnAbort);
      }

      const result = await waitForCursorActivity(run.wait());
      if (result.status === "cancelled") {
        throw new Error("Aborted");
      }
      if (result.status === "error") {
        throw new Error(result.result || "Cursor run failed.");
      }
      const afterSnapshot = await snapshotCursorWorktree(request.stellaRoot);
      const fileChanges = diffCursorWorktreeSnapshots(
        beforeSnapshot,
        afterSnapshot,
      );
      return {
        text: (result.result ?? collected).trim(),
        sessionId: agent.agentId,
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
      };
    } catch (error) {
      throw normalizeCursorAgentError(error);
    } finally {
      idleSettled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cancelCurrentRun = undefined;
      await agent?.[Symbol.asyncDispose]().catch(() => {
        try {
          agent?.close();
        } catch {
          // Best effort.
        }
      });
    }
  });
};
