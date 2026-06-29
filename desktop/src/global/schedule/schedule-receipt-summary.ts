/**
 * Helpers for the inline Schedule receipt chip / dialog summary line.
 * Keeps structured schedule side-channel JSON out of user-facing copy.
 */

const isScheduleDetailsJsonPreview = (value: string): boolean => {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return trimmed.includes('"schedule"') && trimmed.includes('"affected"');
};

export const pickScheduleToolSummary = (payload: {
  resultPreview?: unknown;
  result?: unknown;
}): string | undefined => {
  const candidates: unknown[] = [payload.resultPreview, payload.result];
  const nestedResult =
    payload.result && typeof payload.result === "object"
      ? (payload.result as { result?: unknown }).result
      : undefined;
  if (nestedResult !== undefined) {
    candidates.unshift(nestedResult);
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const text = candidate.trim();
    if (!text || isScheduleDetailsJsonPreview(text)) continue;
    return text;
  }
  return undefined;
};
