const LEADING_TIME_TAG_RE =
  /^\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]\s*/i;
const TRAILING_TIME_TAG_RE =
  /\s*\n\n\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]$/i;

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

const formatMessageTimestampTag = (timestamp: number, timezone?: string): string => {
  const tz = timezone ?? "UTC";
  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  return `[${timeStr}, ${dateStr}]`;
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
    return payloadRecord;
  }

  const nextPayload = { ...payloadRecord };
  const rawText = nextPayload.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return nextPayload;
  }

  let normalizedText = rawText.replace(TRAILING_TIME_TAG_RE, "");
  if (isChannelMessage(nextPayload, args.channelEnvelope)) {
    normalizedText = normalizedText.replace(LEADING_TIME_TAG_RE, "");
  }
  normalizedText = normalizedText.trimEnd();

  const effectiveTimestamp =
    getSourceTimestamp(args.channelEnvelope) ?? args.timestamp;
  nextPayload.contextText = `${normalizedText}\n\n${formatMessageTimestampTag(
    effectiveTimestamp,
    args.timezone,
  )}`;
  return nextPayload;
};
