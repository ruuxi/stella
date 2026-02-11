export type EmojiLabelEntry = {
  code: string;
  emoji: string;
  confidence?: number;
  provider?: string;
  animated?: boolean;
  url?: string;
};

export type EmojiResolveMatch = {
  code: string;
  emoji: string;
  candidates: number;
};

const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u;

const extractSingleEmoji = (value: string): string | null => {
  const match = String(value ?? "").match(EMOJI_RE);
  return match?.[0] ?? null;
};

const confidenceValue = (entry: EmojiLabelEntry) =>
  Number.isFinite(entry.confidence) ? Number(entry.confidence) : 0;

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
};

const sortedCandidates = (emoji: string, entries: EmojiLabelEntry[]) =>
  entries
    .filter((entry) => extractSingleEmoji(entry.emoji ?? "") === emoji)
    .sort(
      (a, b) =>
        confidenceValue(b) - confidenceValue(a) || a.code.localeCompare(b.code),
    );

export const resolveEmojiToEmote = (
  emojiOrText: string,
  entries: EmojiLabelEntry[],
  opts?: { seed?: string | number },
): EmojiResolveMatch | null => {
  const emoji = extractSingleEmoji(emojiOrText);
  if (!emoji) return null;

  const candidates = sortedCandidates(emoji, entries);
  if (candidates.length === 0) return null;

  const seed =
    opts?.seed === undefined || opts?.seed === null
      ? ""
      : String(opts.seed);
  const index =
    seed.length > 0 ? stableHash(`${emoji}:${seed}`) % candidates.length : 0;
  const pick = candidates[index];

  return {
    code: pick.code,
    emoji,
    candidates: candidates.length,
  };
};

export const extractEmojiToken = extractSingleEmoji;
