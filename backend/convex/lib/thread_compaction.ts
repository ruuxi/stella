import { stringifyBounded, truncateWithSuffix } from "./text_utils";
export {
  THREAD_COMPACTION_PROMPT,
  THREAD_COMPACTION_UPDATE_PROMPT,
  TURN_PREFIX_SUMMARY_PROMPT,
} from "../prompts/thread_compaction";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ThreadSummaryInputMessage = {
  role: string;
  content: string;
  tokenEstimate?: number;
};

export type ThreadCompactionCut = {
  recentStartIndex: number;
  historyEndIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
};

// ─── Constants ───────────────────────────────────────────────────────────────

export const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
export const ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS = 80_000;
export const SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS = 140_000;
export const MIN_MESSAGES_FOR_COMPACTION = 6;
export const THREAD_COMPACTION_MAX_RETRIES = 2;

// ─── Formatting ──────────────────────────────────────────────────────────────

const MAX_BLOCK_CHARS = 100_000;
const MAX_JSON_CHARS = 20_000;

const ellipsize = truncateWithSuffix;

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const stringifyCompact = (value: unknown): string =>
  stringifyBounded(value, MAX_JSON_CHARS);

const parseTextBlocks = (blocks: unknown[]): string[] => {
  const lines: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if ((type === "text" || type === "output_text") && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) lines.push(`[Assistant] ${ellipsize(text, MAX_BLOCK_CHARS)}`);
      continue;
    }
    if ((type === "thinking" || type === "reasoning") && typeof item.thinking === "string") {
      const thinking = item.thinking.trim();
      if (thinking) lines.push(`[Assistant thinking] ${ellipsize(thinking, MAX_BLOCK_CHARS)}`);
      continue;
    }
    if (type === "tool-call" || type === "toolCall") {
      const name = typeof item.toolName === "string"
        ? item.toolName
        : typeof item.name === "string"
          ? item.name
          : "unknown_tool";
      const args = (item.args ?? item.arguments ?? item.input) as unknown;
      lines.push(`[Assistant tool call] ${name}(${stringifyCompact(args)})`);
    }
  }
  return lines;
};

const parseToolResultBlocks = (blocks: unknown[]): string[] => {
  const lines: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (type !== "tool-result" && type !== "toolResult" && type !== "result") continue;
    const name = typeof item.toolName === "string"
      ? item.toolName
      : typeof item.name === "string"
        ? item.name
        : "unknown_tool";
    const isError = Boolean(item.isError) || typeof item.error === "string";
    const resultValue = item.error ?? item.result ?? item.output ?? "";
    lines.push(`[Tool result${isError ? " error" : ""}] ${name}: ${stringifyCompact(resultValue)}`);
  }
  return lines;
};

const fallbackRoleLine = (role: string, content: string): string =>
  `[${role}] ${ellipsize(content.trim(), MAX_BLOCK_CHARS)}`;

const formatOneMessage = (message: ThreadSummaryInputMessage): string[] => {
  const raw = message.content.trim();
  if (!raw) return [];

  if (message.role === "user") {
    return [fallbackRoleLine("User", raw)];
  }

  const parsed = safeJsonParse(raw);
  const blocks = Array.isArray(parsed) ? parsed : null;

  if (message.role === "assistant") {
    if (blocks) {
      const lines = parseTextBlocks(blocks);
      if (lines.length > 0) return lines;
    }
    return [fallbackRoleLine("Assistant", raw)];
  }

  if (message.role === "tool") {
    if (blocks) {
      const lines = parseToolResultBlocks(blocks);
      if (lines.length > 0) return lines;
    }
    return [fallbackRoleLine("Tool result", raw)];
  }

  return [fallbackRoleLine(message.role, raw)];
};

export const formatThreadMessagesForCompaction = (
  messages: ThreadSummaryInputMessage[],
): string =>
  messages
    .flatMap((message) => formatOneMessage(message))
    .join("\n\n");

// ─── Cut-point logic ─────────────────────────────────────────────────────────

const estimateMessageTokens = (message: ThreadSummaryInputMessage): number => {
  const estimate = message.tokenEstimate;
  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) {
    return Math.floor(estimate);
  }
  return Math.max(1, Math.ceil((message.content ?? "").length / 4));
};

export const findThreadCompactionCutByTokens = (
  messages: ThreadSummaryInputMessage[],
  keepRecentTokens: number,
): ThreadCompactionCut => {
  if (messages.length === 0) {
    return {
      recentStartIndex: 0,
      historyEndIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  const budget = Math.max(1, Math.floor(keepRecentTokens));
  let used = 0;
  let start = messages.length - 1;
  while (start >= 0) {
    const next = estimateMessageTokens(messages[start]!);
    if (used > 0 && used + next > budget) {
      break;
    }
    used += next;
    start -= 1;
  }
  const recentStartIndex = Math.max(0, start + 1);

  const startsAtUser = messages[recentStartIndex]?.role === "user";
  if (startsAtUser) {
    return {
      recentStartIndex,
      historyEndIndex: recentStartIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  let turnStartIndex = -1;
  for (let i = recentStartIndex; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      turnStartIndex = i;
      break;
    }
  }

  if (turnStartIndex === -1) {
    return {
      recentStartIndex,
      historyEndIndex: recentStartIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  return {
    recentStartIndex,
    historyEndIndex: turnStartIndex,
    turnStartIndex,
    isSplitTurn: true,
  };
};
