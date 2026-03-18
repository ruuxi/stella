import { asPlainObjectRecord } from "./object_utils";

export type ContextEventLike = {
  type: string;
  payload?: unknown;
  requestId?: string;
};

const MIN_EVENT_TOKENS = 8;

const estimateTextTokens = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.length / 4);
};

const estimateJsonTokens = (value: unknown): number => {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return Math.ceil(String(value).length / 4);
  }
};

const clampEventTokens = (tokens: number): number =>
  Math.max(MIN_EVENT_TOKENS, Math.floor(tokens));

export const estimateContextEventTokens = (event: ContextEventLike): number => {
  const payload = asPlainObjectRecord(event.payload);

  if (event.type === "microcompact_boundary") {
    const compactedCount = Array.isArray(payload.compactedToolIds)
      ? payload.compactedToolIds.length
      : 0;
    const clearedCount = Array.isArray(payload.clearedAttachmentUUIDs)
      ? payload.clearedAttachmentUUIDs.length
      : 0;
    return clampEventTokens(20 + compactedCount * 2 + clearedCount * 2);
  }

  if (event.type === "user_message" || event.type === "assistant_message") {
    const textTokens = estimateTextTokens(payload.text);
    const usageTokens = payload.usage ? estimateJsonTokens(payload.usage) : 0;
    return clampEventTokens(textTokens + usageTokens + 8);
  }

  if (
    event.type === "task_started" ||
    event.type === "task_completed" ||
    event.type === "task_failed"
  ) {
    const descriptionTokens = estimateTextTokens(payload.description);
    const resultTokens = "result" in payload ? estimateJsonTokens(payload.result) : 0;
    const errorTokens = estimateTextTokens(payload.error);
    return clampEventTokens(descriptionTokens + resultTokens + errorTokens + 14);
  }

  return clampEventTokens(estimateJsonTokens(payload) + 6);
};

export type SelectByTokenBudgetArgs<T> = {
  itemsNewestFirst: T[];
  maxTokens: number;
  maxItems?: number;
  estimateTokens: (item: T) => number;
};

/**
 * Select a recent tail by token budget from newest-first items.
 * Always returns at least one item when input is non-empty.
 */
export const selectRecentByTokenBudget = <T>({
  itemsNewestFirst,
  maxTokens,
  maxItems,
  estimateTokens,
}: SelectByTokenBudgetArgs<T>): T[] => {
  const safeMaxTokens = Math.max(1, Math.floor(maxTokens));
  const safeMaxItems = maxItems === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.floor(maxItems));
  const selected: T[] = [];
  let usedTokens = 0;

  for (const item of itemsNewestFirst) {
    if (selected.length >= safeMaxItems) break;
    const itemTokens = Math.max(1, Math.floor(estimateTokens(item)));
    if (selected.length > 0 && usedTokens + itemTokens > safeMaxTokens) {
      break;
    }
    selected.push(item);
    usedTokens += itemTokens;
  }

  return selected;
};
