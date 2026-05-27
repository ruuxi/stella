import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeEngine } from "../../contracts/agent-engine.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import type {
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import {
  DEFAULT_CODEX_MODEL,
  loadLocalPreferences,
} from "../preferences/local-preferences.js";
import {
  diffCursorWorktreeSnapshots,
  snapshotCursorWorktree,
} from "./cursor-agent-runtime.js";

const MAX_STDERR_CAPTURE = 8_000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 15 * 1000;
const CODEX_AGENT_MESSAGE_COMPLETION_GRACE_MS = 750;
const CODEX_STELLA_DEVELOPER_INSTRUCTIONS =
  "Stella prompt messages may include hidden runtime context. Use hidden messages as context only; do not quote or reveal them unless the user explicitly asks about the relevant fact.";
export const CODEX_LIGHT_MODEL = "gpt-5.4-mini";

type JsonRpcId = number | string;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

type CodexDynamicToolSpec = {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

type CodexThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
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
  sandboxPolicy?: { type: "readOnly"; networkAccess: boolean };
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
  | { type: "agentMessage"; id: string; text: string }
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

export type CodexAppServerModel = CodexModel;

export const shouldUseCodexAgentRuntime = (args: {
  agentType?: string;
  agentEngine?: CodexAgentRuntimeEngine;
}): boolean => args.agentEngine === "codex_cli";

const formatCodexPromptMessage = (
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

const codexExecutablePath = (): string =>
  process.env.STELLA_CODEX_CLI_PATH?.trim() ||
  process.env.CODEX_CLI_PATH?.trim() ||
  "codex";

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
  stellaHome?: string,
  stellaModel?: string,
): { model: string; reasoningEffort?: CodexReasoningEffort } => {
  const prefs = stellaHome ? loadLocalPreferences(stellaHome) : null;
  const lightDefault =
    stellaModel?.trim() === "stella/light" ? CODEX_LIGHT_MODEL : undefined;
  const preferredModel = prefs?.codexModel;
  const userSelectedModel =
    preferredModel && preferredModel !== DEFAULT_CODEX_MODEL
      ? preferredModel
      : undefined;
  const model =
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

const toolArgsFromCodexValue = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const toJsonValue = (value: unknown): JsonValue => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toJsonValue(entry);
    }
    return out;
  }
  return null;
};

export const buildCodexDynamicToolSpecs = (
  tools?: ToolMetadata[],
): CodexDynamicToolSpec[] => {
  if (!tools?.length) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonValue(tool.parameters),
  }));
};

export const buildCodexThreadStartParams = (args: {
  model: string;
  cwd?: string;
  tools?: ToolMetadata[];
  systemPrompt?: string;
}): CodexThreadStartParams => {
  const dynamicTools = buildCodexDynamicToolSpecs(args.tools);
  const baseInstructions = args.systemPrompt?.trim();
  return {
    model: args.model,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "Stella",
    ...(baseInstructions
      ? {
          baseInstructions,
          developerInstructions: CODEX_STELLA_DEVELOPER_INSTRUCTIONS,
        }
      : {}),
    ephemeral: false,
    ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    experimentalRawEvents: false,
  };
};

export const buildCodexThreadResumeParams = (args: {
  threadId: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
}): CodexThreadResumeParams => {
  const baseInstructions = args.systemPrompt?.trim();
  return {
    threadId: args.threadId,
    model: args.model,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    approvalPolicy: "never",
    sandbox: "read-only",
    ...(baseInstructions
      ? {
          baseInstructions,
          developerInstructions: CODEX_STELLA_DEVELOPER_INSTRUCTIONS,
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
  sandboxPolicy: { type: "readOnly", networkAccess: true },
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

  constructor() {
    this.child = spawn(
      codexExecutablePath(),
      ["app-server", "--listen", "stdio://"],
      { stdio: "pipe" },
    );
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
          this.write({ jsonrpc: "2.0", id: message.id, result });
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
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: messageText },
      } as JsonRpcResponseMessage);
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

const createInitializedCodexClient =
  async (): Promise<CodexAppServerClient> => {
    const client = new CodexAppServerClient();
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

const getSharedCodexClient = async (): Promise<CodexAppServerClient> => {
  if (sharedCodexClient && !sharedCodexClient.isClosed()) {
    return sharedCodexClient;
  }
  if (sharedCodexClientPromise) {
    return sharedCodexClientPromise;
  }

  sharedCodexClientPromise = createInitializedCodexClient()
    .then((client) => {
      sharedCodexClient = client;
      client.onClose(() => {
        if (sharedCodexClient === client) {
          sharedCodexClient = null;
          sharedCodexClientPromise = null;
        }
      });
      return client;
    })
    .catch((error) => {
      sharedCodexClientPromise = null;
      throw error;
    });

  return sharedCodexClientPromise;
};

export const shutdownCodexAppServerRuntime = (): void => {
  const client = sharedCodexClient;
  sharedCodexClient = null;
  sharedCodexClientPromise = null;
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

const startOrResumeCodexThread = async (args: {
  client: CodexAppServerClient;
  persistedSessionId?: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
  tools?: ToolMetadata[];
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
      tools: args.tools,
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
  if (threadId && params.threadId !== threadId) return false;
  if (turnId && params.turnId !== turnId) return false;
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
      return `Codex command ${item.status}: ${item.command}`;
    case "fileChange":
      return item.status === "completed"
        ? `Codex changed ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`
        : `Codex file change ${item.status}`;
    case "dynamicToolCall":
      return `${item.tool} ${item.status}`;
    case "mcpToolCall":
      return `${item.server}.${item.tool} ${item.status}`;
    case "webSearch":
      return `Searching ${item.query}`;
    default:
      return null;
  }
};

export const runCodexAgentTurn = async (request: {
  runId: string;
  sessionKey?: string;
  persistedSessionId?: string;
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  stellaHome?: string;
  stellaRoot?: string;
  stellaModel?: string;
  attachments?: RuntimeAttachmentRef[];
  tools?: ToolMetadata[];
  abortSignal?: AbortSignal;
  onStatus?: (status: string) => void;
  onStream?: (chunk: string) => void;
  onToolUpdate?: (args: {
    toolCallId: string;
    toolName: string;
    update: ToolResult;
  }) => void;
  executeTool?: (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  reuseAppServer?: boolean;
}): Promise<CodexAgentTurnResult> => {
  const { model, reasoningEffort } = getCodexRuntimePreferences(
    request.stellaHome,
    request.stellaModel,
  );
  const { input, cleanupDir } = buildCodexUserInput({
    runId: request.runId,
    prompt: request.prompt,
    attachments: request.attachments,
  });
  const snapshotBefore = request.cwd
    ? await snapshotCursorWorktree(request.cwd)
    : null;
  const fileChanges: FileChangeRecord[] = [];
  let finalText = "";
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnFailure: string | null = null;
  let completed = false;
  let finalAgentMessageCompleted = false;
  let waitingForTurnCompletion = false;
  let turnIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let agentMessageCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTurnIdleTimer: (() => void) | undefined;

  const client = request.reuseAppServer
    ? await getSharedCodexClient()
    : await createInitializedCodexClient();
  let removeNotificationHandler: (() => void) | undefined;
  let removeRequestHandler: (() => void) | undefined;
  let removeCloseHandler: (() => void) | undefined;

  const turnCompleted = new Promise<void>((resolve, reject) => {
    const resolveCompleted = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    const scheduleAgentMessageCompletion = () => {
      if (
        !waitingForTurnCompletion ||
        completed ||
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
      agentMessageCompletionTimer.unref?.();
    };
    refreshTurnIdleTimer = () => {
      if (!waitingForTurnCompletion || completed) return;
      if (turnIdleTimer) clearTimeout(turnIdleTimer);
      const timeoutMs = configuredTimeoutMs(
        "STELLA_CODEX_TURN_IDLE_TIMEOUT_MS",
        DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS,
      );
      turnIdleTimer = setTimeout(() => {
        if (finalAgentMessageCompleted && finalText.trim()) {
          resolveCompleted();
          return;
        }
        reject(
          new Error(
            `Codex app-server did not report turn progress for ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
        client.abort();
      }, timeoutMs);
      turnIdleTimer.unref?.();
    };
    removeNotificationHandler = client.onNotification((notification) => {
      if (!threadId) return;
      if (!isNotificationForTurn(notification, threadId, turnId)) return;
      refreshTurnIdleTimer?.();
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
          resolveCompleted();
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
          finalText += notification.params.delta;
          request.onStream?.(notification.params.delta);
          return;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const status = notification.params.delta.trim();
          if (status) request.onStatus?.(status);
          return;
        }
        case "item/started":
        case "item/completed": {
          const item = notification.params.item;
          const status = statusFromCodexItem(item);
          if (status) request.onStatus?.(status);
          if (item.type === "agentMessage" && item.text) {
            finalText = item.text;
            if (notification.method === "item/completed") {
              finalAgentMessageCompleted = true;
              scheduleAgentMessageCompletion();
            }
          }
          appendUniqueFileChanges(
            fileChanges,
            fileChangesFromCodexItem(item, request.cwd ?? request.stellaRoot),
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
      refreshTurnIdleTimer?.();
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
        const toolName = params.tool;
        const toolArgs = toolArgsFromCodexValue(params.arguments);
        const toolResult = await request.executeTool(
          params.callId,
          toolName,
          toolArgs,
          request.abortSignal,
          (update) => {
            refreshTurnIdleTimer?.();
            request.onToolUpdate?.({
              toolCallId: params.callId,
              toolName,
              update,
            });
            const statusText = buildToolResultText(update).trim();
            if (statusText) request.onStatus?.(statusText);
          },
        );
        refreshTurnIdleTimer?.();
        appendUniqueFileChanges(fileChanges, toolResult.fileChanges ?? []);
        return {
          contentItems: [
            { type: "inputText", text: buildToolResultText(toolResult) },
          ],
          success: !toolResult.error,
        };
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
      tools: request.executeTool ? request.tools : undefined,
      onStatus: request.onStatus,
    });

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
    if (turn.turn.status === "failed" || turn.turn.status === "interrupted") {
      throw new Error(turn.turn.error?.message ?? "Codex run failed.");
    }

    waitingForTurnCompletion = true;
    refreshTurnIdleTimer?.();
    await turnCompleted;

    const snapshotAfter =
      request.cwd && snapshotBefore
        ? await snapshotCursorWorktree(request.cwd)
        : null;
    if (snapshotBefore && snapshotAfter) {
      appendUniqueFileChanges(
        fileChanges,
        diffCursorWorktreeSnapshots(snapshotBefore, snapshotAfter),
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
