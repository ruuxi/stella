import {
  LEADING_TIME_TAG_RE,
  TRAILING_TIME_TAG_RE,
} from "../message-timestamp.js";

const isMessageEventType = (type: string) =>
  type === "user_message" || type === "assistant_message";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

  // If the text already has a timestamp tag, keep it as-is
  if (TRAILING_TIME_TAG_RE.test(rawText)) {
    nextPayload.contextText = rawText.trimEnd();
    return nextPayload;
  }

  if (isChannelMessage(nextPayload, args.channelEnvelope)) {
    nextPayload.text = rawText.replace(LEADING_TIME_TAG_RE, "").trimEnd();
  }
  return nextPayload;
};
