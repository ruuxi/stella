import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";
import type {
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
} from "../../contracts/agent-engine.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import { redactSensitiveText } from "../../contracts/sensitive-data.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import type { ToolResult, ToolUpdateCallback } from "../tools/types.js";
import { executeToolWithInactivityBound } from "./tool-inactivity.js";
import {
  DEFAULT_CODEX_MODEL,
  loadLocalPreferences,
} from "../preferences/local-preferences.js";
import {
  buildExternalCliChildEnv,
  resolveExternalCliPath,
} from "./external-cli-resolution.js";
const MAX_STDERR_CAPTURE = 8_000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while confirmed turn work (native command / Stella tool) is in
// flight. A native command that never leaves inProgress, or a Stella tool
// whose bookkeeping leaked, would otherwise disarm the watchdog forever.
// (Bridged Stella tools are separately bounded at 10 min by
// executeToolWithInactivityBound; this only backstops native commands and
// leaked tracking.)
const DEFAULT_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_AGENT_MESSAGE_COMPLETION_GRACE_MS = 750;
export const CODEX_LIGHT_MODEL = "gpt-5.4-mini";
/** Cheap model reserved for automatic utility work, not explicit agent spawns. */
export const CODEX_UTILITY_MODEL = "gpt-5.6-luna";
const execFileAsync = promisify(execFile);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

type JsonRpcId = number | string;
type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponseMessage = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type JsonRpcRequestMessage = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotificationMessage = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcOutgoingMessage =
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage;

type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: CodexReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: CodexReasoningEffort;
  inputModalities: string[];
  additionalSpeedTiers: string[];
  isDefault: boolean;
};

type CodexModelListResponse = {
  data: CodexModel[];
  nextCursor: string | null;
};

type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

type CodexThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  experimentalRawEvents: boolean;
};

type CodexThreadResumeParams = {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  excludeTurns?: boolean;
};

type CodexThreadResponse = {
  thread: {
    id: string;
  };
};

type CodexTurnStartParams = {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandboxPolicy?: { type: "dangerFullAccess" };
  model?: string | null;
  effort?: CodexReasoningEffort | null;
};

type CodexTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string; additionalDetails?: string | null } | null;
};

type CodexTurnStartResponse = {
  turn: CodexTurn;
};

type CodexPatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

export type CodexThreadItem =
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase?: "commentary" | "final_answer" | null;
    }
  | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      aggregatedOutput?: string | null;
      exitCode?: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{
        path: string;
        kind: CodexPatchChangeKind;
        diff?: string;
      }>;
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      success: boolean | null;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
    }
  | { type: "webSearch"; id: string; query: string }
  | { type: "plan"; id: string; text: string };

type CodexServerNotification =
  | {
      method: "turn/started";
      params: { threadId: string; turn: CodexTurn };
    }
  | {
      method: "turn/completed";
      params: { threadId: string; turn: CodexTurn };
    }
  | {
      method: "error";
      params: {
        threadId?: string;
        turnId?: string;
        error?: { message?: string; additionalDetails?: string | null };
        willRetry?: boolean;
      };
    }
  | {
      method: "item/started" | "item/completed";
      params: { threadId: string; turnId: string; item: CodexThreadItem };
    }
  | {
      method: "item/agentMessage/delta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
    }
  | {
      method: "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
    };

type CodexDynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};

export type CodexAgentRuntimeEngine = AgentRuntimeEngine;

export type CodexAgentTurnResult = {
  text: string;
  sessionId: string;
  fileChanges?: FileChangeRecord[];
};

export type CodexCommandExecutionActivity = {
  id: string;
  command: string;
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  exitCode?: number | null;
};

export const sanitizeCodexCommandForActivity = (command: string): string =>
  redactSensitiveText(command);

export type CodexAppServerModel = CodexModel;

const CODEX_REASONING_EFFORT_ORDER: readonly CodexReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const clampCodexSpawnReasoningEffort = (
  model: Pick<CodexModel, "supportedReasoningEfforts">,
  requested: AgentModelReasoningEffort,
): CodexReasoningEffort | undefined => {
  const supported = new Set(
    model.supportedReasoningEfforts.map(
      ({ reasoningEffort }) => reasoningEffort,
    ),
  );
  if (supported.has(requested)) return requested;
  const requestedIndex = CODEX_REASONING_EFFORT_ORDER.indexOf(requested);
  for (
    let distance = 1;
    distance < CODEX_REASONING_EFFORT_ORDER.length;
    distance += 1
  ) {
    const higher = CODEX_REASONING_EFFORT_ORDER[requestedIndex + distance];
    if (higher && supported.has(higher)) return higher;
    const lower = CODEX_REASONING_EFFORT_ORDER[requestedIndex - distance];
    if (lower && supported.has(lower)) return lower;
  }
  return undefined;
};

export const shouldUseCodexAgentRuntime = (args: {
  agentType?: string;
  agentEngine?: CodexAgentRuntimeEngine;
}): boolean =>
  args.agentEngine === "codex_cli" && args.agentType === AGENT_IDS.GENERAL;

const formatCodexPromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const text = message.text.trim();
  if (!text) return "";
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  if (messageType === "user" && visibility === "visible" && !customType) {
    return text;
  }
  const contextLabel =
    visibility === "hidden"
      ? "Hidden Stella context"
      : messageType === "user"
        ? "User context"
        : "Stella context";
  const suffix = customType ? ` (${customType})` : "";
  return `[${contextLabel} ${index + 1}${suffix}]\n${text}`;
};

export const buildCodexPromptFromMessages = (args: {
  promptMessages: RuntimePromptMessage[];
}): string =>
  args.promptMessages
    .map(formatCodexPromptMessage)
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const absoluteChangePath = (cwd: string | undefined, value: string): string => {
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(cwd ?? process.cwd(), trimmed);
};

const codexChangeKindToFileChangeKind = (
  kind: CodexPatchChangeKind,
  cwd?: string,
): FileChangeRecord["kind"] => {
  if (kind.type === "add" || kind.type === "delete") return { type: kind.type };
  return {
    type: "update",
    ...(kind.move_path
      ? { move_path: absoluteChangePath(cwd, kind.move_path) }
      : {}),
  };
};

export const fileChangesFromCodexItem = (
  item: CodexThreadItem,
  cwd?: string,
): FileChangeRecord[] => {
  if (item.type !== "fileChange" || item.status !== "completed") return [];
  return item.changes.map((change) => ({
    path: absoluteChangePath(cwd, change.path),
    kind: codexChangeKindToFileChangeKind(change.kind, cwd),
  }));
};

type WorktreeEntry = {
  path: string;
  status: string;
  movePath?: string;
};

type WorktreeSnapshot = {
  repoRoot: string;
  entries: Map<string, WorktreeEntry>;
  fingerprints: Map<string, string | null>;
};

const normalizeGitPath = (value: string): string =>
  value.trim().replace(/\\/g, "/");

const statusKeyForEntry = (entry: WorktreeEntry): string =>
  entry.movePath ?? entry.path;

const absoluteRepoPath = (repoRoot: string, repoRelativePath: string): string =>
  path.resolve(repoRoot, repoRelativePath);

const parseStatusLine = (line: string): WorktreeEntry | null => {
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

const parseGitStatus = (stdout: string): Map<string, WorktreeEntry> => {
  const entries = new Map<string, WorktreeEntry>();
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

const snapshotWorktree = async (
  repoRoot: string | undefined,
): Promise<WorktreeSnapshot | null> => {
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
  const entries = parseGitStatus(status.stdout);
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
  snapshot: WorktreeSnapshot,
  entry: WorktreeEntry,
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

const diffWorktreeSnapshots = (
  before: WorktreeSnapshot | null,
  after: WorktreeSnapshot | null,
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
        kind: fs.existsSync(absolutePath)
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

const normalizeCodexRuntimeReasoningEffort = (
  value: unknown,
): CodexReasoningEffort | undefined => {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
};

export const getCodexRuntimePreferences = (
  stellaDataDir?: string,
  stellaModel?: string,
  modelOverride?: string,
): { model: string; reasoningEffort?: CodexReasoningEffort } => {
  const prefs = stellaDataDir ? loadLocalPreferences(stellaDataDir) : null;
  const lightDefault =
    stellaModel?.trim() === "stella/light" ? CODEX_LIGHT_MODEL : undefined;
  const preferredModel = prefs?.codexModel;
  // Provenance, not string-matching: only an explicit pick (marker set at
  // selection time) makes a Stella Light spawn honor the saved model. Legacy
  // prefs.json without the marker read as non-explicit, so a baked default
  // (including gpt-5.5) still downgrades light spawns to CODEX_LIGHT_MODEL.
  const userSelectedModel =
    prefs?.codexModelExplicit === true && preferredModel
      ? preferredModel
      : undefined;
  // A per-spawn pin (spawn_agent `model: codex/<model>`) is an explicit user
  // request for this one run — it outranks the env escape hatch and the saved
  // codexModel preference, neither of which it modifies.
  const model =
    modelOverride?.trim() ||
    process.env.STELLA_CODEX_MODEL?.trim() ||
    userSelectedModel ||
    lightDefault ||
    preferredModel ||
    DEFAULT_CODEX_MODEL;
  const envReasoning = normalizeCodexRuntimeReasoningEffort(
    process.env.STELLA_CODEX_REASONING_EFFORT?.trim(),
  );
  const prefReasoning = prefs?.codexReasoningEffort;
  const reasoningEffort =
    envReasoning ??
    (prefReasoning && prefReasoning !== "default" ? prefReasoning : undefined);
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
};

const mimeExtension = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
};

export const codexImagePathFromFileUrl = (url: string): string | null => {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
};

const materializeCodexAttachments = (
  runId: string,
  attachments?: RuntimeAttachmentRef[],
): { inputs: CodexUserInput[]; cleanupDir?: string } => {
  if (!attachments?.length) return { inputs: [] };
  const inputs: CodexUserInput[] = [];
  let cleanupDir: string | undefined;
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.mimeType?.startsWith("image/")) continue;
    if (attachment.url.startsWith("file://")) {
      const imagePath = codexImagePathFromFileUrl(attachment.url);
      if (imagePath) inputs.push({ type: "localImage", path: imagePath });
      continue;
    }
    if (path.isAbsolute(attachment.url)) {
      inputs.push({ type: "localImage", path: attachment.url });
      continue;
    }
    if (/^https?:\/\//i.test(attachment.url)) {
      inputs.push({ type: "image", url: attachment.url });
      continue;
    }
    const match = attachment.url.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) continue;
    cleanupDir ??= fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `stella-codex-${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}-`,
      ),
    );
    const filePath = path.join(
      cleanupDir,
      `attachment-${index + 1}-${crypto.randomUUID()}${mimeExtension(match[1] ?? attachment.mimeType)}`,
    );
    fs.writeFileSync(filePath, Buffer.from(match[2] ?? "", "base64"));
    inputs.push({ type: "localImage", path: filePath });
  }
  return { inputs, cleanupDir };
};

export const buildCodexUserInput = (args: {
  prompt: string;
  runId: string;
  attachments?: RuntimeAttachmentRef[];
}): { input: CodexUserInput[]; cleanupDir?: string } => {
  const { inputs, cleanupDir } = materializeCodexAttachments(
    args.runId,
    args.attachments,
  );
  return {
    input: [{ type: "text", text: args.prompt, text_elements: [] }, ...inputs],
    ...(cleanupDir ? { cleanupDir } : {}),
  };
};

const truncateStderr = (chunks: Buffer[]): string => {
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length <= MAX_STDERR_CAPTURE) return text;
  return text.slice(text.length - MAX_STDERR_CAPTURE);
};

const killCodexProcess = (child: ChildProcessWithoutNullStreams) => {
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
  }, SIGKILL_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(sigkillTimer));
};

const abortCodexProcess = (child: ChildProcessWithoutNullStreams) => {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGINT");
  } catch {
    // Fall through to the harder kill path.
  }
  setTimeout(() => killCodexProcess(child), SIGTERM_TIMEOUT_MS);
};

const appendUniqueFileChanges = (
  target: FileChangeRecord[],
  changes: FileChangeRecord[],
) => {
  const seen = new Set(
    target.map((change) => `${change.path}\0${JSON.stringify(change.kind)}`),
  );
  for (const change of changes) {
    const key = `${change.path}\0${JSON.stringify(change.kind)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(change);
  }
};

const textFromUnknown = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const buildToolResultText = (toolResult: ToolResult): string =>
  toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);

const extractCodexStellaContextInstructions = (
  systemPrompt?: string,
): string | undefined => {
  const lines = systemPrompt
    ?.split(/\r?\n/u)
    .filter(
      (line) =>
        line.startsWith("Current working directory: ") ||
        line.startsWith("- `~/.stella/outputs/`") ||
        line.startsWith("- `~/.stella/projects/<name>/`"),
    );
  return lines?.length ? lines.join("\n") : undefined;
};

export const extractCodexDeveloperInstructions = (
  systemPrompt?: string,
): string | undefined => {
  const skillsBlock = systemPrompt?.match(/<skills>[\s\S]*?<\/skills>/u)?.[0];
  const sections = [
    extractCodexStellaContextInstructions(systemPrompt),
    skillsBlock?.trim(),
  ].filter((section): section is string => Boolean(section?.trim()));
  return sections.length ? sections.join("\n\n") : undefined;
};

const toolArgsFromCodexValue = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

export const buildCodexThreadStartParams = (args: {
  model: string;
  cwd?: string;
  systemPrompt?: string;
}): CodexThreadStartParams => {
  const developerInstructions = extractCodexDeveloperInstructions(
    args.systemPrompt,
  );
  return {
    model: args.model,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceName: "Stella",
    ...(developerInstructions
      ? {
          developerInstructions,
        }
      : {}),
    ephemeral: false,
    experimentalRawEvents: false,
  };
};

export const buildCodexThreadResumeParams = (args: {
  threadId: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
}): CodexThreadResumeParams => {
  const developerInstructions = extractCodexDeveloperInstructions(
    args.systemPrompt,
  );
  return {
    threadId: args.threadId,
    model: args.model,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(developerInstructions
      ? {
          developerInstructions,
        }
      : {}),
    excludeTurns: true,
  };
};

export const buildCodexTurnStartParams = (args: {
  threadId: string;
  input: CodexUserInput[];
  model: string;
  cwd?: string;
  reasoningEffort?: CodexReasoningEffort;
}): CodexTurnStartParams => ({
  threadId: args.threadId,
  input: args.input,
  ...(args.cwd ? { cwd: args.cwd } : {}),
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
  model: args.model,
  ...(args.reasoningEffort ? { effort: args.reasoningEffort } : {}),
});

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type CodexServerRequestHandler = (
  request: JsonRpcRequestMessage,
) => Promise<unknown | undefined> | unknown | undefined;

const CODEX_RESPONSE_WITH_ACK = Symbol("codex-response-with-ack");
type CodexResponseWithAck = {
  [CODEX_RESPONSE_WITH_ACK]: true;
  result: unknown;
  afterResponseWritten?: () => void | Promise<void>;
};

const responseWithAck = (
  result: unknown,
  afterResponseWritten?: () => void | Promise<void>,
): CodexResponseWithAck => ({
  [CODEX_RESPONSE_WITH_ACK]: true,
  result,
  afterResponseWritten,
});

const isResponseWithAck = (value: unknown): value is CodexResponseWithAck =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as Partial<CodexResponseWithAck>)[CODEX_RESPONSE_WITH_ACK],
  );

const configuredTimeoutMs = (envName: string, fallbackMs: number): number => {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrChunks: Buffer[] = [];
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closedError: Error | null = null;
  private readonly notificationHandlers = new Set<
    (notification: CodexServerNotification) => void
  >();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly closeHandlers = new Set<(error: Error) => void>();

  constructor(cliBridgeSocketPath?: string) {
    const executablePath = resolveExternalCliPath("codex");
    this.child = spawn(executablePath, ["app-server", "--listen", "stdio://"], {
      stdio: "pipe",
      env: buildExternalCliChildEnv(executablePath, process.env, {
        ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
      }),
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
    });
    this.child.once("error", (error) => {
      this.rejectAll(
        new Error(`Codex app-server failed to start: ${error.message}`),
      );
    });
    this.child.once("exit", (code, signal) => {
      if (this.closedError) return;
      const detail =
        signal ?? (code === null ? "without exit code" : `with code ${code}`);
      const stderr = truncateStderr(this.stderrChunks).trim();
      this.rejectAll(
        new Error(
          `Codex app-server exited ${detail}${stderr ? `: ${stderr}` : ""}`,
        ),
      );
    });
  }

  onNotification(handler: (notification: CodexServerNotification) => void) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: CodexServerRequestHandler) {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  onClose(handler: (error: Error) => void) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  isClosed(): boolean {
    return Boolean(this.closedError);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "stella",
        title: "Stella",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timeoutMs = configuredTimeoutMs(
        "STELLA_CODEX_REQUEST_TIMEOUT_MS",
        DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
      );
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex app-server request ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch {
      // The process may already be shutting down.
    }
  }

  close(): void {
    this.rejectAll(new Error("Codex app-server closed."));
    killCodexProcess(this.child);
  }

  abort(): void {
    this.rejectAll(new Error("Codex app-server aborted."));
    abortCodexProcess(this.child);
  }

  private write(message: JsonRpcOutgoingMessage) {
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : textFromUnknown(error);
      throw new Error(`Codex app-server write failed: ${messageText}`);
    }
  }

  private writeAsync(message: JsonRpcOutgoingMessage): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    const line = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, (error) => {
        if (error) {
          reject(new Error(`Codex app-server write failed: ${error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const rpc = message as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: JsonRpcError;
    };
    if (rpc.id !== undefined && typeof rpc.method !== "string") {
      this.handleResponse(rpc as JsonRpcResponseMessage);
      return;
    }
    if (rpc.id !== undefined && typeof rpc.method === "string") {
      void this.handleServerRequest(rpc as JsonRpcRequestMessage);
      return;
    }
    if (typeof rpc.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler(rpc as CodexServerNotification);
      }
    }
  }

  private handleResponse(message: JsonRpcResponseMessage) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ??
            `Codex app-server request ${String(message.id)} failed.`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcRequestMessage) {
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler(message);
        if (result !== undefined) {
          const response = isResponseWithAck(result) ? result.result : result;
          await this.writeAsync({
            jsonrpc: "2.0",
            id: message.id,
            result: response,
          });
          if (isResponseWithAck(result)) {
            await Promise.resolve(result.afterResponseWritten?.()).catch(
              () => undefined,
            );
          }
          return;
        }
      }
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `Unsupported Codex app-server request: ${message.method}`,
        },
      } as JsonRpcResponseMessage);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : textFromUnknown(error);
      await this.writeAsync({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: messageText },
      } as JsonRpcResponseMessage).catch(() => undefined);
    }
  }

  private rejectAll(error: Error) {
    this.closedError = error;
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

const createInitializedCodexClient = async (
  cliBridgeSocketPath?: string,
): Promise<CodexAppServerClient> => {
  const client = new CodexAppServerClient(cliBridgeSocketPath);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
};

let sharedCodexClientPromise: Promise<CodexAppServerClient> | null = null;
let sharedCodexClient: CodexAppServerClient | null = null;
let sharedCodexBridgePath: string | undefined;

const getSharedCodexClient = async (
  cliBridgeSocketPath?: string,
): Promise<CodexAppServerClient> => {
  if (sharedCodexBridgePath !== cliBridgeSocketPath) {
    shutdownCodexAppServerRuntime();
  }
  if (sharedCodexClient && !sharedCodexClient.isClosed()) {
    return sharedCodexClient;
  }
  if (sharedCodexClientPromise) {
    return sharedCodexClientPromise;
  }

  sharedCodexBridgePath = cliBridgeSocketPath;
  const pending = createInitializedCodexClient(cliBridgeSocketPath)
    .then((client) => {
      if (
        sharedCodexClientPromise !== pending ||
        sharedCodexBridgePath !== cliBridgeSocketPath
      ) {
        client.close();
        throw new Error("Codex app-server launch configuration changed.");
      }
      sharedCodexClient = client;
      client.onClose(() => {
        if (sharedCodexClient === client) {
          sharedCodexClient = null;
          sharedCodexClientPromise = null;
          sharedCodexBridgePath = undefined;
        }
      });
      return client;
    })
    .catch((error) => {
      if (sharedCodexClientPromise === pending) {
        sharedCodexClientPromise = null;
      }
      throw error;
    });
  sharedCodexClientPromise = pending;
  return pending;
};

export const shutdownCodexAppServerRuntime = (): void => {
  const client = sharedCodexClient;
  sharedCodexClient = null;
  sharedCodexClientPromise = null;
  sharedCodexBridgePath = undefined;
  client?.close();
};

export const listCodexAppServerModels = async (): Promise<{
  models: CodexAppServerModel[];
}> => {
  const client = await createInitializedCodexClient();
  const models: CodexAppServerModel[] = [];
  try {
    let cursor: string | null = null;
    do {
      const response: CodexModelListResponse =
        await client.request<CodexModelListResponse>("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return { models };
  } finally {
    client.close();
  }
};

const requestCodexModels = async (
  client: CodexAppServerClient,
  includeHidden: boolean,
): Promise<CodexModel[]> => {
  const models: CodexModel[] = [];
  let cursor: string | null = null;
  do {
    const response: CodexModelListResponse =
      await client.request<CodexModelListResponse>("model/list", {
        cursor,
        limit: 100,
        includeHidden,
      });
    models.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return models;
};

const requestCodexModelsWithDeadline = async (
  client: CodexAppServerClient,
  includeHidden: boolean,
): Promise<CodexModel[]> => {
  const timeoutMs = Math.min(
    5_000,
    configuredTimeoutMs(
      "STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS",
      DEFAULT_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS,
    ),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestCodexModels(client, includeHidden),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Codex effort model/list timed out after ${timeoutMs}ms.`,
              ),
            ),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const startOrResumeCodexThread = async (args: {
  client: CodexAppServerClient;
  persistedSessionId?: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
  onStatus?: (status: string) => void;
}): Promise<string> => {
  if (args.persistedSessionId) {
    try {
      const response = await args.client.request<CodexThreadResponse>(
        "thread/resume",
        buildCodexThreadResumeParams({
          threadId: args.persistedSessionId,
          model: args.model,
          cwd: args.cwd,
          systemPrompt: args.systemPrompt,
        }),
      );
      return response.thread.id;
    } catch {
      // Fall through to a fresh Codex thread when the persisted id is stale.
    }
  }

  const response = await args.client.request<CodexThreadResponse>(
    "thread/start",
    buildCodexThreadStartParams({
      model: args.model,
      cwd: args.cwd,
      systemPrompt: args.systemPrompt,
    }),
  );
  return response.thread.id;
};

const isNotificationForTurn = (
  notification: CodexServerNotification,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean => {
  const params =
    notification.params && typeof notification.params === "object"
      ? (notification.params as { threadId?: unknown; turnId?: unknown })
      : null;
  if (!params) return false;
  if (!params.threadId) return false;
  if (threadId && params.threadId !== threadId) return false;
  if (turnId && params.turnId && params.turnId !== turnId) return false;
  return true;
};

const isRequestForTurn = (
  message: JsonRpcRequestMessage,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean => {
  const params =
    message.params && typeof message.params === "object"
      ? (message.params as { threadId?: unknown; turnId?: unknown })
      : null;
  if (!params) return true;
  if (params.threadId && !threadId) {
    return false;
  }
  if (threadId && params.threadId && params.threadId !== threadId) {
    return false;
  }
  if (turnId && params.turnId && params.turnId !== turnId) {
    return false;
  }
  return true;
};

const statusFromCodexItem = (item: CodexThreadItem): string | null => {
  switch (item.type) {
    case "commandExecution":
      return null;
    case "fileChange":
      return item.status === "completed"
        ? `Codex changed ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`
        : `Codex file change ${item.status}`;
    case "dynamicToolCall":
      return null;
    case "mcpToolCall":
      return null;
    case "webSearch":
      return `Searching ${item.query}`;
    default:
      return null;
  }
};

const isFinalCodexAgentMessage = (item: CodexThreadItem): boolean =>
  item.type === "agentMessage" && item.phase !== "commentary";

export const runCodexAgentTurn = async (request: {
  runId: string;
  sessionKey?: string;
  persistedSessionId?: string;
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  stellaDataDir?: string;
  stellaAppDir?: string;
  cliBridgeSocketPath?: string;
  stellaModel?: string;
  /** Per-spawn engine-native model pin (`codex/<model>`); never persisted. */
  modelOverride?: string;
  /** Per-spawn reasoning override; never persisted. */
  reasoningEffort?: AgentModelReasoningEffort;
  /** True when the effort was captured from an already-resolved parent turn. */
  reasoningEffortResolved?: boolean;
  /** Automatic utility pass: fixed cheap model and low effort. */
  utility?: boolean;
  attachments?: RuntimeAttachmentRef[];
  abortSignal?: AbortSignal;
  onStatus?: (status: string) => void;
  onReasoning?: (chunk: string) => void;
  onCommandExecution?: (activity: CodexCommandExecutionActivity) => void;
  /** Commentary/preamble deltas, independent of final-answer streaming. */
  onCommentaryStream?: (chunk: string) => void;
  /**
   * First observation of a Codex-owned tool item. Notification only: Codex
   * remains responsible for execution and result delivery.
   */
  onNativeToolStart?: (args: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => void;
  onStream?: (chunk: string) => void;
  onSessionId?: (sessionId: string) => void;
  streamFinalAnswer?: boolean;
  onToolUpdate?: (args: {
    toolCallId: string;
    toolName: string;
    update: ToolResult;
  }) => void;
  onToolResponseWritten?: (args: {
    toolCallId: string;
    toolName: string;
  }) => void | Promise<void>;
  executeTool?: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  reuseAppServer?: boolean;
}): Promise<CodexAgentTurnResult> => {
  const emitStatus = (status: string) =>
    request.onStatus?.(redactSensitiveText(status));
  const runtimePreferences = getCodexRuntimePreferences(
    request.stellaDataDir,
    request.stellaModel,
    request.utility ? CODEX_UTILITY_MODEL : request.modelOverride,
  );
  const model = runtimePreferences.model;
  let reasoningEffort: CodexReasoningEffort | undefined = request.utility
    ? "low"
    : (request.reasoningEffort ?? runtimePreferences.reasoningEffort);
  const { input, cleanupDir } = buildCodexUserInput({
    runId: request.runId,
    prompt: request.prompt,
    attachments: request.attachments,
  });
  const snapshotBefore = request.cwd
    ? await snapshotWorktree(request.cwd)
    : null;
  const fileChanges: FileChangeRecord[] = [];
  let finalText = "";
  // Tracks whether each streamed agentMessage item is a commentary preamble
  // (keyed by item id). Codex streams a visible commentary preamble before a
  // tool; external-engines flushes that preamble separately as its own bubble
  // (see flushPreambleBeforeTool), so its deltas must not also accumulate into
  // finalText — otherwise the same commentary can surface twice (once as the
  // flushed preamble, once inside the persisted final answer) whenever no
  // final-answer item overwrites finalText.
  const agentMessageIsCommentary = new Map<string, boolean>();
  const observedNativeToolItems = new Set<string>();
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnFailure: string | null = null;
  let completed = false;
  let finalAgentMessageCompleted = false;
  let turnCompletionReported = false;
  let waitingForTurnCompletion = false;
  let hasTurnProgress = false;
  const activeTurnWork = new Set<string>();
  let turnIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let agentMessageCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTurnIdleTimer: (() => void) | undefined;
  let scheduleCompletionGrace: (() => void) | undefined;

  const client = request.reuseAppServer
    ? await getSharedCodexClient(request.cliBridgeSocketPath)
    : await createInitializedCodexClient(request.cliBridgeSocketPath);
  if (
    request.reasoningEffort &&
    !request.reasoningEffortResolved &&
    !request.utility
  ) {
    try {
      const models = await requestCodexModelsWithDeadline(client, true);
      const resolvedModel = models.find(
        (candidate) => candidate.model === model || candidate.id === model,
      );
      reasoningEffort = resolvedModel
        ? clampCodexSpawnReasoningEffort(resolvedModel, request.reasoningEffort)
        : undefined;
      if (!reasoningEffort) {
        console.debug("[stella:spawn-reasoning] effort dropped", {
          requested: request.reasoningEffort,
          model,
          reason: resolvedModel
            ? "resolved Codex model has no reasoning dial"
            : "resolved Codex model was absent from model/list",
        });
      } else if (reasoningEffort !== request.reasoningEffort) {
        console.debug("[stella:spawn-reasoning] effort clamped", {
          requested: request.reasoningEffort,
          effective: reasoningEffort,
          model,
        });
      }
    } catch (error) {
      reasoningEffort = undefined;
      console.debug("[stella:spawn-reasoning] effort dropped", {
        requested: request.reasoningEffort,
        model,
        reason: `Codex model/list unavailable: ${(error as Error).message}`,
      });
    }
  }
  let removeNotificationHandler: (() => void) | undefined;
  let removeRequestHandler: (() => void) | undefined;
  let removeCloseHandler: (() => void) | undefined;

  const turnCompleted = new Promise<void>((resolve, reject) => {
    const resolveCompleted = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    scheduleCompletionGrace = () => {
      if (
        !waitingForTurnCompletion ||
        completed ||
        !turnCompletionReported ||
        !finalAgentMessageCompleted
      ) {
        return;
      }
      if (agentMessageCompletionTimer) {
        clearTimeout(agentMessageCompletionTimer);
      }
      agentMessageCompletionTimer = setTimeout(() => {
        resolveCompleted();
      }, CODEX_AGENT_MESSAGE_COMPLETION_GRACE_MS);
    };
    refreshTurnIdleTimer = () => {
      if (!waitingForTurnCompletion || completed) return;
      if (turnIdleTimer) clearTimeout(turnIdleTimer);
      turnIdleTimer = undefined;
      // App-server notifications are edge-triggered. A native command or a
      // Stella tool may remain silent while it legitimately runs beyond the
      // stream idle window, so while confirmed work is in flight the watchdog
      // is armed with the much longer tool ceiling instead of disarming —
      // work that never reports completion must not hang the turn forever.
      const workInFlight = activeTurnWork.size > 0;
      const timeoutMs = workInFlight
        ? configuredTimeoutMs(
            "STELLA_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS",
            DEFAULT_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS,
          )
        : hasTurnProgress
          ? configuredTimeoutMs(
              "STELLA_CODEX_TURN_IDLE_TIMEOUT_MS",
              DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS,
            )
          : configuredTimeoutMs(
              "STELLA_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS",
              DEFAULT_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS,
            );
      turnIdleTimer = setTimeout(() => {
        if (
          turnCompletionReported &&
          finalAgentMessageCompleted &&
          finalText.trim()
        ) {
          resolveCompleted();
          return;
        }
        reject(
          new Error(
            workInFlight
              ? `Codex app-server reported no turn progress for ${Math.round(timeoutMs / 1000)}s with ${activeTurnWork.size} work item(s) still marked in flight.`
              : `Codex app-server did not report turn progress for ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
        client.abort();
      }, timeoutMs);
      turnIdleTimer.unref?.();
    };
    const markTurnProgress = () => {
      hasTurnProgress = true;
      refreshTurnIdleTimer?.();
    };
    removeNotificationHandler = client.onNotification((notification) => {
      if (!threadId) return;
      if (!isNotificationForTurn(notification, threadId, turnId)) return;
      markTurnProgress();
      switch (notification.method) {
        case "turn/started":
          turnId = notification.params.turn.id;
          return;
        case "turn/completed": {
          turnId = notification.params.turn.id;
          const turn = notification.params.turn;
          if (turn.status === "failed" || turn.status === "interrupted") {
            const message =
              turn.error?.message ||
              (turn.status === "interrupted"
                ? "Codex was interrupted."
                : null) ||
              "Codex run failed.";
            reject(new Error(message));
            return;
          }
          turnCompletionReported = true;
          scheduleCompletionGrace?.();
          return;
        }
        case "error":
          if (notification.params.willRetry) return;
          turnFailure =
            notification.params.error?.message ||
            notification.params.error?.additionalDetails ||
            "Codex run failed.";
          reject(new Error(turnFailure ?? "Codex run failed."));
          return;
        case "item/agentMessage/delta":
          // Only final-answer deltas accumulate into finalText. Commentary
          // preambles are streamed live and flushed as their own bubble, so
          // accumulating them here would duplicate the commentary in the
          // persisted final answer when no final item overwrites finalText.
          if (
            agentMessageIsCommentary.get(notification.params.itemId) === true
          ) {
            request.onCommentaryStream?.(notification.params.delta);
          } else {
            finalText += notification.params.delta;
            if (request.streamFinalAnswer !== false) {
              request.onStream?.(notification.params.delta);
            }
          }
          return;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          if (notification.params.delta) {
            request.onReasoning?.(
              redactSensitiveText(notification.params.delta),
            );
          }
          return;
        }
        case "item/started":
        case "item/completed": {
          const item = notification.params.item;
          const nativeBoundary = (() => {
            switch (item.type) {
              case "commandExecution":
                return {
                  toolName: "exec_command",
                  toolArgs: {
                    command: sanitizeCodexCommandForActivity(item.command),
                    ...(item.cwd
                      ? { cwd: redactSensitiveText(item.cwd) }
                      : {}),
                  },
                };
              case "webSearch":
                return {
                  toolName: "web_search",
                  toolArgs: { query: redactSensitiveText(item.query) },
                };
              case "fileChange":
                return {
                  toolName: "file_change",
                  toolArgs: {
                    paths: item.changes.map((change) => change.path),
                  },
                };
              case "dynamicToolCall":
                return {
                  toolName: item.tool,
                  toolArgs: {
                    ...(item.namespace ? { namespace: item.namespace } : {}),
                  },
                };
              case "mcpToolCall":
                return {
                  toolName: item.tool,
                  toolArgs: { server: item.server },
                };
              default:
                return null;
            }
          })();
          if (nativeBoundary) {
            const observationKey = `${item.type}:${item.id}`;
            if (!observedNativeToolItems.has(observationKey)) {
              observedNativeToolItems.add(observationKey);
              request.onNativeToolStart?.({
                toolCallId: item.id,
                ...nativeBoundary,
              });
            }
          }
          const status = statusFromCodexItem(item);
          if (status) emitStatus(status);
          if (item.type === "commandExecution") {
            const workKey = `command:${item.id}`;
            if (item.status === "inProgress") {
              activeTurnWork.add(workKey);
            } else {
              activeTurnWork.delete(workKey);
            }
            refreshTurnIdleTimer?.();
            request.onCommandExecution?.({
              id: item.id,
              command: sanitizeCodexCommandForActivity(item.command),
              ...(item.cwd ? { cwd: redactSensitiveText(item.cwd) } : {}),
              status: item.status,
              ...(item.exitCode !== undefined
                ? { exitCode: item.exitCode }
                : {}),
            });
          }
          if (item.type === "agentMessage") {
            agentMessageIsCommentary.set(item.id, item.phase === "commentary");
          }
          if (
            item.type === "agentMessage" &&
            item.text &&
            isFinalCodexAgentMessage(item)
          ) {
            finalText = item.text;
            if (notification.method === "item/completed") {
              finalAgentMessageCompleted = true;
              scheduleCompletionGrace?.();
            }
          }
          appendUniqueFileChanges(
            fileChanges,
            fileChangesFromCodexItem(item, request.cwd ?? request.stellaAppDir),
          );
          return;
        }
        default:
          return;
      }
    });

    removeCloseHandler = client.onClose((error) => {
      if (waitingForTurnCompletion && !completed) reject(error);
    });

    removeRequestHandler = client.onRequest(async (message) => {
      if (!isRequestForTurn(message, threadId, turnId)) {
        return undefined;
      }
      markTurnProgress();
      if (message.method === "item/tool/call") {
        const params = message.params as CodexDynamicToolCallParams;
        if (!request.executeTool) {
          return {
            contentItems: [
              {
                type: "inputText",
                text: `Error: Stella tool ${params.tool} is not available.`,
              },
            ],
            success: false,
          };
        }
        const executeTool = request.executeTool;
        const toolName = params.tool;
        const toolArgs = toolArgsFromCodexValue(params.arguments);
        const requestHash = crypto
          .createHash("sha256")
          .update(toolName)
          .update("\0")
          .update(stableJson(toolArgs))
          .digest("hex");
        const durableScope = crypto
          .createHash("sha256")
          .update(`${request.sessionKey ?? "unscoped"}:${request.runId}`)
          .digest("hex")
          .slice(0, 24);
        const toolCallId =
          toolName === "image_gen"
            ? `codex:${durableScope}:${params.callId}:${requestHash.slice(0, 24)}`
            : params.callId;
        const workKey = `tool:${params.callId}`;
        activeTurnWork.add(workKey);
        refreshTurnIdleTimer?.();
        let toolResult: ToolResult;
        try {
          // Same per-tool inactivity bound as the native loop: a Stella tool
          // that never settles gets cancelled with an error result instead of
          // holding the turn open until the run-level ceiling kills it.
          toolResult = await executeToolWithInactivityBound({
            toolName,
            signal: request.abortSignal,
            run: (signal, onActivity) =>
              executeTool(toolCallId, toolName, toolArgs, signal, (update) => {
                onActivity();
                refreshTurnIdleTimer?.();
                request.onToolUpdate?.({
                  toolCallId,
                  toolName,
                  update,
                });
                const statusText = buildToolResultText(update).trim();
                if (statusText) emitStatus(statusText);
              }),
          });
        } finally {
          activeTurnWork.delete(workKey);
          refreshTurnIdleTimer?.();
        }
        appendUniqueFileChanges(fileChanges, toolResult.fileChanges ?? []);
        const response = {
          contentItems: [
            { type: "inputText", text: buildToolResultText(toolResult) },
          ],
          success: !toolResult.error,
        };
        return responseWithAck(
          response,
          toolName === "image_gen"
            ? () =>
                request.onToolResponseWritten?.({
                  toolCallId,
                  toolName,
                })
            : undefined,
        );
      }
      if (message.method === "item/commandExecution/requestApproval") {
        return { decision: "decline" };
      }
      if (message.method === "item/fileChange/requestApproval") {
        return { decision: "decline" };
      }
      if (message.method === "item/tool/requestUserInput") {
        return { answers: {} };
      }
      if (message.method === "applyPatchApproval") {
        return { decision: "denied" };
      }
      if (message.method === "execCommandApproval") {
        return { decision: "denied" };
      }
      return undefined;
    });
  });

  const abortHandler = () => {
    if (threadId && turnId) {
      void client.interrupt(threadId, turnId);
    }
    if (!request.reuseAppServer) {
      client.abort();
    }
  };
  request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

  try {
    if (request.abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    threadId = await startOrResumeCodexThread({
      client,
      persistedSessionId: request.persistedSessionId,
      model,
      cwd: request.cwd,
      systemPrompt: request.systemPrompt,
      onStatus: emitStatus,
    });
    request.onSessionId?.(threadId);
    if (request.abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    const turn = await client.request<CodexTurnStartResponse>(
      "turn/start",
      buildCodexTurnStartParams({
        threadId,
        input,
        model,
        cwd: request.cwd,
        reasoningEffort,
      }),
    );
    turnId = turn.turn.id;
    if (request.abortSignal?.aborted) {
      void client.interrupt(threadId, turnId);
      throw new Error("Aborted");
    }
    if (turn.turn.status === "failed" || turn.turn.status === "interrupted") {
      throw new Error(turn.turn.error?.message ?? "Codex run failed.");
    }

    waitingForTurnCompletion = true;
    scheduleCompletionGrace?.();
    refreshTurnIdleTimer?.();
    await turnCompleted;

    const snapshotAfter =
      request.cwd && snapshotBefore
        ? await snapshotWorktree(request.cwd)
        : null;
    if (snapshotBefore && snapshotAfter) {
      appendUniqueFileChanges(
        fileChanges,
        diffWorktreeSnapshots(snapshotBefore, snapshotAfter),
      );
    }

    if (request.abortSignal?.aborted) {
      throw new Error("Aborted");
    }

    if (turnFailure) {
      throw new Error(turnFailure);
    }
    if (!threadId) {
      throw new Error("Codex app-server did not report a thread id.");
    }
    if (!completed) {
      throw new Error("Codex app-server did not complete the turn.");
    }

    return {
      text: finalText.trim(),
      sessionId: threadId,
      ...(fileChanges.length ? { fileChanges } : {}),
    };
  } finally {
    if (turnIdleTimer) clearTimeout(turnIdleTimer);
    if (agentMessageCompletionTimer) clearTimeout(agentMessageCompletionTimer);
    request.abortSignal?.removeEventListener("abort", abortHandler);
    removeNotificationHandler?.();
    removeRequestHandler?.();
    removeCloseHandler?.();
    if (!request.reuseAppServer) {
      client.close();
    }
    if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
  }
};
