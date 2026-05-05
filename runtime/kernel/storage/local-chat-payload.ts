import {
  LEADING_TIME_TAG_RE,
  TRAILING_TIME_TAG_RE,
  formatTimestampTag,
} from "../message-timestamp.js";

const isMessageEventType = (type: string) =>
  type === "user_message" || type === "assistant_message";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const getSourceTimestamp = (channelEnvelope: unknown): number | undefined => {
  const record = asRecord(channelEnvelope);
  const sourceTimestamp = record?.sourceTimestamp;
  return typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp)
    ? sourceTimestamp
    : undefined;
};

const isChannelMessage = (
  payload: Record<string, unknown>,
  channelEnvelope: unknown,
) => {
  if (asRecord(channelEnvelope)) {
    return true;
  }
  const source = payload.source;
  return typeof source === "string" && source.trim().toLowerCase().startsWith("channel:");
};

const normalizeAssistantDisplayText = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.includes("output_text")) {
    return text;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const parts = parsed
        .map((item) =>
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : null,
        )
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .filter((value) => value.length > 0);
      if (parts.length > 0) {
        return parts.join("");
      }
    }
  } catch {
    // Provider compat paths can return Python-repr-style content lists.
  }

  const parts: string[] = [];
  const singleQuotedText = /'text'\s*:\s*'((?:\\.|[^'\\])*)'/g;
  for (const match of trimmed.matchAll(singleQuotedText)) {
    parts.push(
      match[1]
        .replace(/\\'/g, "'")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\"),
    );
  }

  const singleKeyDoubleQuotedText = /'text'\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of trimmed.matchAll(singleKeyDoubleQuotedText)) {
    try {
      parts.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      parts.push(
        match[1]
          .replace(/\\"/g, "\"")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\"),
      );
    }
  }
  return parts.length > 0 ? parts.join("") : text;
};

export const prepareStoredLocalChatPayload = (args: {
  type: string;
  payload: unknown;
  channelEnvelope?: unknown;
  timestamp: number;
  timezone?: string;
}): unknown => {
  const payloadRecord = asRecord(args.payload);
  if (!isMessageEventType(args.type) || !payloadRecord) {
    return args.payload;
  }

  if (args.type === "assistant_message") {
    const rawText = payloadRecord.text;
    if (typeof rawText !== "string") {
      return payloadRecord;
    }
    return {
      ...payloadRecord,
      text: normalizeAssistantDisplayText(rawText),
    };
  }

  const nextPayload = { ...payloadRecord };
  const rawText = nextPayload.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return nextPayload;
  }

  // If the text already has a timestamp tag, keep it as-is
  if (TRAILING_TIME_TAG_RE.test(rawText)) {
    nextPayload.contextText = rawText.trimEnd();
    return nextPayload;
  }

  let normalizedText = rawText;
  if (isChannelMessage(nextPayload, args.channelEnvelope)) {
    normalizedText = normalizedText.replace(LEADING_TIME_TAG_RE, "");
  }
  normalizedText = normalizedText.trimEnd();

  const effectiveTimestamp =
    getSourceTimestamp(args.channelEnvelope) ?? args.timestamp;
  nextPayload.contextText = `${normalizedText}\n\n${formatTimestampTag(
    effectiveTimestamp,
    args.timezone,
  )}`;
  return nextPayload;
};
