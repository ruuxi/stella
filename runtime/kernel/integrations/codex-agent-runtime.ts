import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { AgentRuntimeEngine } from "../../contracts/agent-engine.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
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

export type CodexAgentRuntimeEngine = AgentRuntimeEngine;

export type CodexAgentTurnResult = {
  text: string;
  sessionId: string;
  fileChanges?: FileChangeRecord[];
};

type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage?: unknown }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexItem }
  | { type: "error"; message?: string };

type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output?: string;
      exit_code?: number;
      status: "in_progress" | "completed" | "failed";
    }
  | {
      id: string;
      type: "file_change";
      changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
      status: "completed" | "failed";
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      status: "in_progress" | "completed" | "failed";
    }
  | { id: string; type: "web_search"; query: string }
  | { id: string; type: "todo_list"; items: Array<{ text: string; completed: boolean }> }
  | { id: string; type: "error"; message: string };

export const shouldUseCodexAgentRuntime = (args: {
  agentType?: string;
  agentEngine?: CodexAgentRuntimeEngine;
}): boolean =>
  args.agentType === AGENT_IDS.GENERAL && args.agentEngine === "codex_cli";

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
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
}): string =>
  [
    "Stella is delegating this spawned agent turn to Codex.",
    "Follow the Stella system instructions and complete the user's delegated goal. Hidden messages are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.",
    `<stella_system_prompt>\n${args.systemPrompt.trim()}\n</stella_system_prompt>`,
    ...args.promptMessages.map(formatCodexPromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

const absoluteChangePath = (cwd: string | undefined, value: string): string => {
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(cwd ?? process.cwd(), trimmed);
};

export const fileChangesFromCodexItem = (
  item: CodexItem,
  cwd?: string,
): FileChangeRecord[] => {
  if (item.type !== "file_change" || item.status !== "completed") return [];
  return item.changes.map((change) => ({
    path: absoluteChangePath(cwd, change.path),
    kind: { type: change.kind },
  }));
};

const codexExecutablePath = (): string =>
  process.env.STELLA_CODEX_CLI_PATH?.trim() ||
  process.env.CODEX_CLI_PATH?.trim() ||
  "codex";

const getCodexModel = (stellaHome?: string): string =>
  process.env.STELLA_CODEX_MODEL?.trim() ||
  (stellaHome ? loadLocalPreferences(stellaHome).codexModel : DEFAULT_CODEX_MODEL);

export const buildCodexExecArgs = (args: {
  model: string;
  cwd?: string;
  persistedSessionId?: string;
  imagePaths?: string[];
}): string[] => {
  const commandArgs = [
    "exec",
    "--experimental-json",
    "--model",
    args.model,
    "--sandbox",
    "danger-full-access",
    "--config",
    'approval_policy="never"',
  ];
  if (args.cwd) {
    commandArgs.push("--cd", args.cwd);
  }
  if (args.persistedSessionId) {
    commandArgs.push("resume", args.persistedSessionId);
  }
  for (const imagePath of args.imagePaths ?? []) {
    commandArgs.push("--image", imagePath);
  }
  return commandArgs;
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

const materializeCodexAttachments = (
  runId: string,
  attachments?: RuntimeAttachmentRef[],
): { imagePaths: string[]; cleanupDir?: string } => {
  if (!attachments?.length) return { imagePaths: [] };
  const imagePaths: string[] = [];
  let cleanupDir: string | undefined;
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.mimeType?.startsWith("image/")) continue;
    if (attachment.url.startsWith("file://")) {
      try {
        imagePaths.push(new URL(attachment.url).pathname);
      } catch {
        // Ignore invalid file URLs.
      }
      continue;
    }
    if (path.isAbsolute(attachment.url)) {
      imagePaths.push(attachment.url);
      continue;
    }
    const match = attachment.url.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) continue;
    cleanupDir ??= fs.mkdtempSync(
      path.join(os.tmpdir(), `stella-codex-${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}-`),
    );
    const filePath = path.join(
      cleanupDir,
      `attachment-${index + 1}-${crypto.randomUUID()}${mimeExtension(match[1] ?? attachment.mimeType)}`,
    );
    fs.writeFileSync(filePath, Buffer.from(match[2] ?? "", "base64"));
    imagePaths.push(filePath);
  }
  return { imagePaths, cleanupDir };
};

const truncateStderr = (chunks: Buffer[]): string => {
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length <= MAX_STDERR_CAPTURE) return text;
  return text.slice(text.length - MAX_STDERR_CAPTURE);
};

const killCodexProcess = (child: ReturnType<typeof spawn>) => {
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

const abortCodexProcess = (child: ReturnType<typeof spawn>) => {
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
    target.map(
      (change) =>
        `${change.kind.type}:${change.path}:${change.kind.type === "update" ? change.kind.move_path ?? "" : ""}`,
    ),
  );
  for (const change of changes) {
    const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? change.kind.move_path ?? "" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(change);
  }
};

export const runCodexAgentTurn = async (request: {
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
}): Promise<CodexAgentTurnResult> => {
  request.onStatus?.("Starting Codex");
  const beforeSnapshot = await snapshotCursorWorktree(request.stellaRoot);
  const model = getCodexModel(request.stellaHome);
  const { imagePaths, cleanupDir } = materializeCodexAttachments(
    request.runId,
    request.attachments,
  );
  const child = spawn(
    codexExecutablePath(),
    buildCodexExecArgs({
      model,
      cwd: request.cwd,
      persistedSessionId: request.persistedSessionId,
      imagePaths,
    }),
    {
      cwd: request.cwd,
      env: {
        ...process.env,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE:
          process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "stella",
      },
      windowsHide: true,
    },
  );

  const stderrChunks: Buffer[] = [];
  let threadId: string | undefined = request.persistedSessionId;
  let finalText = "";
  let streamText = "";
  let turnFailure: string | null = null;
  let aborted = false;
  const messageTextById = new Map<string, string>();
  const fileChanges: FileChangeRecord[] = [];

  const abort = () => {
    aborted = true;
    request.onStatus?.("Stopping Codex");
    abortCodexProcess(child);
  };
  if (request.abortSignal?.aborted) {
    abort();
  } else {
    request.abortSignal?.addEventListener("abort", abort, { once: true });
  }

  try {
    if (!child.stdin) throw new Error("Codex process has no stdin.");
    child.stdin.write(request.prompt);
    child.stdin.end();

    if (!child.stdout) throw new Error("Codex process has no stdout.");
    child.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.once("error", (error) => {
      turnFailure = error instanceof Error ? error.message : String(error);
    });

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as CodexThreadEvent;
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          continue;
        }
        if (event.type === "turn.failed") {
          turnFailure = event.error?.message ?? "Codex run failed.";
          continue;
        }
        if (event.type === "error") {
          turnFailure = event.message ?? "Codex run failed.";
          continue;
        }
        if (
          event.type !== "item.started" &&
          event.type !== "item.updated" &&
          event.type !== "item.completed"
        ) {
          continue;
        }
        const item = event.item;
        if (item.type === "agent_message") {
          const previous = messageTextById.get(item.id) ?? "";
          const next = item.text ?? "";
          const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
          if (delta) {
            streamText += delta;
            request.onStream?.(delta);
          }
          messageTextById.set(item.id, next);
          if (event.type === "item.completed") {
            finalText = next;
          }
          continue;
        }
        if (item.type === "reasoning" && item.text.trim()) {
          request.onStatus?.(item.text.trim());
          continue;
        }
        if (item.type === "command_execution") {
          request.onStatus?.(`${item.command} ${item.status}`.trim());
          continue;
        }
        if (item.type === "file_change") {
          appendUniqueFileChanges(
            fileChanges,
            fileChangesFromCodexItem(item, request.cwd ?? request.stellaRoot),
          );
          continue;
        }
        if (item.type === "mcp_tool_call") {
          request.onStatus?.(`${item.server}.${item.tool} ${item.status}`.trim());
          continue;
        }
        if (item.type === "web_search") {
          request.onStatus?.(`Searching ${item.query}`.trim());
          continue;
        }
        if (item.type === "error") {
          request.onStatus?.(item.message);
        }
      }
    } finally {
      lines.close();
    }

    const exit = await exitPromise;
    if (aborted) {
      throw new Error("Aborted");
    }
    if (turnFailure) {
      throw new Error(turnFailure);
    }
    if (exit.code !== 0 || exit.signal) {
      const detail = exit.signal
        ? `signal ${exit.signal}`
        : `code ${exit.code ?? 1}`;
      throw new Error(`Codex Exec exited with ${detail}: ${truncateStderr(stderrChunks)}`);
    }
    const afterSnapshot = await snapshotCursorWorktree(request.stellaRoot);
    appendUniqueFileChanges(
      fileChanges,
      diffCursorWorktreeSnapshots(beforeSnapshot, afterSnapshot),
    );
    const sessionId = threadId?.trim();
    if (!sessionId) {
      throw new Error("Codex did not report a thread id.");
    }
    return {
      text: (finalText || streamText).trim(),
      sessionId,
      ...(fileChanges.length > 0 ? { fileChanges } : {}),
    };
  } finally {
    request.abortSignal?.removeEventListener("abort", abort);
    killCodexProcess(child);
    if (cleanupDir) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }
};
