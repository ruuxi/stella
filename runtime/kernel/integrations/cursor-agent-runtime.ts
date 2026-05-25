import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setupEnvironment } from "dugite";
import type { SDKImage, SDKMessage } from "@cursor/sdk";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { AgentRuntimeEngine } from "../../contracts/agent-engine.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";
import {
  DEFAULT_CURSOR_MODEL,
  loadLocalPreferences,
} from "../preferences/local-preferences.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";

const execFileAsync = promisify(execFile);

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
}): boolean =>
  args.agentType === AGENT_IDS.GENERAL && args.agentEngine === "cursor_sdk";

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
  ]);
  if (!status.ok) return null;
  const entries = parseCursorGitStatus(status.stdout);
  const fingerprints = new Map<string, string | null>();
  for (const [key, entry] of entries) {
    fingerprints.set(key, await fingerprintFile(root, statusKeyForEntry(entry)));
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
        kind: existsSync(absolutePath) ? { type: "update" } : { type: "delete" },
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

const readCursorApiKey = (stellaHome?: string): string =>
  process.env.CURSOR_API_KEY?.trim() ||
  process.env.STELLA_CURSOR_API_KEY?.trim() ||
  (() => {
    if (!stellaHome?.trim()) return "";
    try {
      // Modifying this could break the app. Avoid exposing tokens; confirm with the user before changing credential handling.
      return readFileSync(
        path.join(stellaHome, "credentials", "cursor-api-key"),
        "utf8",
      ).trim();
    } catch {
      return "";
    }
  })();

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

  const beforeSnapshot = await snapshotCursorWorktree(request.stellaRoot);
  const { Agent } = await import("@cursor/sdk");
  const model = {
    id:
      process.env.STELLA_CURSOR_MODEL?.trim() ||
      (request.stellaHome
        ? loadLocalPreferences(request.stellaHome).cursorModel
        : DEFAULT_CURSOR_MODEL),
  };
  const local = {
    ...(request.cwd ? { cwd: request.cwd } : {}),
  };
  const agent = request.persistedSessionId
    ? await Agent.resume(request.persistedSessionId, {
        apiKey,
        model,
        local,
        mcpServers: {},
        agents: {},
      })
    : await Agent.create({
        apiKey,
        name: "Stella General",
        model,
        local,
        mcpServers: {},
        agents: {},
        idempotencyKey: request.sessionKey,
      });

  try {
    const images = (request.attachments ?? [])
      .map(cursorImageFromAttachment)
      .filter((image): image is SDKImage => image !== null);
    const run = await agent.send(
      images.length > 0 ? { text: request.prompt, images } : request.prompt,
      { idempotencyKey: request.runId },
    );
    const cancelOnAbort = () => {
      void run.cancel().catch(() => undefined);
    };
    if (request.abortSignal?.aborted) {
      cancelOnAbort();
      throw new Error("Aborted");
    }
    request.abortSignal?.addEventListener("abort", cancelOnAbort, {
      once: true,
    });

    let collected = "";
    try {
      for await (const message of run.stream()) {
        if (request.abortSignal?.aborted) {
          throw new Error("Aborted");
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "text") continue;
            collected += block.text;
            request.onStream?.(block.text);
          }
          continue;
        }
        const statusText = statusTextFromMessage(message);
        if (statusText) {
          request.onStatus?.(statusText);
        }
      }
    } finally {
      request.abortSignal?.removeEventListener("abort", cancelOnAbort);
    }

    const result = await run.wait();
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
  } finally {
    await agent[Symbol.asyncDispose]().catch(() => {
      try {
        agent.close();
      } catch {
        // Best effort.
      }
    });
  }
};
