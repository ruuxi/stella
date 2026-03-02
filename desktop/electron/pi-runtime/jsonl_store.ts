import fs from "fs";
import path from "path";

export type JsonlThreadMessage = {
  timestamp: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolCallId?: string;
};

type JsonlRunEvent = {
  timestamp: number;
  runId: string;
  conversationId: string;
  agentType: string;
  seq?: number;
  type: "run_start" | "stream" | "tool_start" | "tool_end" | "error" | "run_end";
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
};

type JsonlMemory = {
  timestamp: number;
  conversationId: string;
  content: string;
  tags?: string[];
};

const MAX_RECALL_RESULTS = 8;

const fileSafeId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const ensureParentDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const readJsonlLines = <T>(filePath: string): T[] => {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];

  const result: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed entries and continue scanning.
    }
  }
  return result;
};

const appendJsonl = (filePath: string, value: unknown): void => {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
};

export class JsonlRuntimeStore {
  private readonly root: string;
  private readonly threadsDir: string;
  private readonly runsDir: string;
  private readonly memoryFile: string;

  constructor(stellaHome: string) {
    this.root = path.join(stellaHome, "state", "pi-runtime");
    this.threadsDir = path.join(this.root, "threads");
    this.runsDir = path.join(this.root, "runs");
    this.memoryFile = path.join(this.root, "memory.jsonl");

    fs.mkdirSync(this.threadsDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  appendThreadMessage(message: JsonlThreadMessage): void {
    const filePath = path.join(this.threadsDir, `${fileSafeId(message.conversationId)}.jsonl`);
    appendJsonl(filePath, message);
  }

  loadThreadMessages(conversationId: string, limit = 50): Array<{ role: string; content: string; toolCallId?: string }> {
    const filePath = path.join(this.threadsDir, `${fileSafeId(conversationId)}.jsonl`);
    const rows = readJsonlLines<JsonlThreadMessage>(filePath);
    if (rows.length === 0) return [];

    const sliced = rows.slice(-Math.max(1, limit));
    return sliced.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    }));
  }

  recordRunEvent(event: JsonlRunEvent): void {
    const filePath = path.join(this.runsDir, `${fileSafeId(event.runId)}.jsonl`);
    appendJsonl(filePath, event);
  }

  saveMemory(args: { conversationId: string; content: string; tags?: string[] }): void {
    const content = args.content.trim();
    if (!content) return;
    const entry: JsonlMemory = {
      timestamp: Date.now(),
      conversationId: args.conversationId,
      content,
      ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
    };
    appendJsonl(this.memoryFile, entry);
  }

  recallMemories(args: { query: string; limit?: number }): JsonlMemory[] {
    const query = args.query.trim().toLowerCase();
    if (!query) return [];

    const rows = readJsonlLines<JsonlMemory>(this.memoryFile);
    if (rows.length === 0) return [];

    const scored = rows
      .map((row) => {
        const haystack = `${row.content} ${(row.tags ?? []).join(" ")}`.toLowerCase();
        const score = haystack.includes(query) ? 2 : query.split(/\s+/).reduce((acc, token) => {
          return token && haystack.includes(token) ? acc + 1 : acc;
        }, 0);
        return { row, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.row.timestamp - a.row.timestamp;
      });

    const limit = Math.max(1, Math.min(MAX_RECALL_RESULTS, args.limit ?? MAX_RECALL_RESULTS));
    return scored.slice(0, limit).map((entry) => entry.row);
  }
}
