export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const DEFAULT_HEARTBEAT_PROMPT =
  "Read the heartbeat checklist if provided. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

type StripHeartbeatResult = {
  shouldSkip: boolean;
  text: string;
  didStrip: boolean;
};

export function resolveHeartbeatPrompt(params: {
  prompt?: string | null;
  checklist?: string | null;
}) {
  const base = typeof params.prompt === "string" ? params.prompt.trim() : "";
  const resolved = base || DEFAULT_HEARTBEAT_PROMPT;
  const checklist = typeof params.checklist === "string" ? params.checklist.trim() : "";
  if (!checklist) {
    return resolved;
  }
  return `${resolved}\n\nHeartbeat checklist:\n${checklist}`;
}

export function isHeartbeatContentEffectivelyEmpty(
  content: string | undefined | null,
): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }
  if (!text.includes(HEARTBEAT_TOKEN)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (next.endsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(0, Math.max(0, next.length - HEARTBEAT_TOKEN.length)).trimEnd();
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { maxAckChars?: number } = {},
): StripHeartbeatResult {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  const stripMarkup = (text: string) =>
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken =
    trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (rest.length <= maxAckChars) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}
