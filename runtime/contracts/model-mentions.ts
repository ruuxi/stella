export type DelegatedModelMention = {
  /** The token as it appears in the user's message, without the leading @. */
  mention: string;
  /** The exact value the orchestrator should pass to spawn_agent.model. */
  spawnModel: string;
};

export type DelegatedModelMentionRange = DelegatedModelMention & {
  /** UTF-16 string offset of the leading @. */
  start: number;
  /** Exclusive UTF-16 string offset immediately after the mention. */
  end: number;
};

const MODEL_MENTION_PATTERN =
  /(^|[\s([{])@([A-Za-z0-9][A-Za-z0-9-]*)(?=$|[\s)\]},.!?;])/g;

/**
 * Composer-friendly aliases deliberately stay user-facing in the transcript,
 * then normalize to spawn_agent's engine vocabulary in hidden prompt context.
 */
export function normalizeDelegatedModelMention(mention: string): string | null {
  const trimmed = mention.trim();
  if (!trimmed || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(trimmed)) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "stella") return "stella";
  if (lower === "xai" || lower === "grok") return "xai/grok-4.5";
  if (lower === "chatgpt") return "codex";
  if (lower === "codex" || lower === "codex-cli") return "codex";
  if (lower === "claude" || lower === "claude-code") return "claude-code";
  return null;
}

/**
 * Returns the first valid routing mention in a message. Ordinary @mentions
 * and email addresses are ignored unless they use a supported engine alias.
 */
export function findDelegatedModelMention(
  text: string,
): DelegatedModelMention | null {
  const first = findDelegatedModelMentions(text)[0];
  return first
    ? {
        mention: first.mention,
        spawnModel: first.spawnModel,
      }
    : null;
}

/**
 * Finds every valid inline routing mention, including its source range for
 * transcript rendering. Punctuation around a mention is intentionally kept
 * outside the highlighted range.
 */
export function findDelegatedModelMentions(
  text: string,
): DelegatedModelMentionRange[] {
  MODEL_MENTION_PATTERN.lastIndex = 0;
  const mentions: DelegatedModelMentionRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = MODEL_MENTION_PATTERN.exec(text)) !== null) {
    const mention = match[2].replace(/[.,!?;]+$/, "");
    const spawnModel = normalizeDelegatedModelMention(mention);
    if (!spawnModel) continue;
    const start = match.index + match[1].length;
    mentions.push({
      mention,
      spawnModel,
      start,
      end: start + mention.length + 1,
    });
  }
  return mentions;
}
