import { useEffect, useState } from "react";

type EmojiLabeledEntry = {
  code?: string;
  emoji?: string;
  url?: string;
  confidence?: number;
};

type LocalEmojiPayload = {
  version?: number;
  generatedAt?: string;
  entries?: EmojiLabeledEntry[];
  labels?: EmojiLabeledEntry[];
};

const LOCAL_EMOJI_INDEX_FILE = "emoji-index.json";
const LOCAL_EMOJI_LABELS_FILE = "emoji-labels.json";

let inMemoryEmojiLookup: { expiresAt: number; map: Map<string, string> } | null = null;
let inFlightEmojiLookup: Promise<Map<string, string>> | null = null;

const getFreshEmojiLookupCache = (): ReadonlyMap<string, string> | null => {
  if (!inMemoryEmojiLookup || inMemoryEmojiLookup.expiresAt <= Date.now()) {
    return null;
  }
  return inMemoryEmojiLookup.map;
};

const resolvePublicAssetUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:")
  ) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  if (typeof window !== "undefined" && window.location?.href) {
    try {
      if (trimmed.startsWith("/")) {
        return new URL(`.${trimmed}`, window.location.href).toString();
      }
      return new URL(trimmed, window.location.href).toString();
    } catch {
      // Fall through to non-window fallback.
    }
  }

  return trimmed;
};

const getLocalEmotesJsonUrl = (fileName: string) =>
  resolvePublicAssetUrl(`/emotes/${fileName}`);

const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u;
const VARIATION_SELECTOR_16 = /\uFE0F/g;

const normalizeEmojiKey = (value: string) => value.replace(VARIATION_SELECTOR_16, "");

const extractSingleEmoji = (value: string) => {
  const match = value.match(EMOJI_RE);
  return match?.[0] ?? "";
};

const parseEmojiLookup = (raw: unknown): Map<string, string> | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const payload = raw as LocalEmojiPayload;
  const sourceEntries = Array.isArray(payload.entries)
    ? payload.entries
    : Array.isArray(payload.labels)
      ? payload.labels
      : null;
  if (!sourceEntries) {
    return null;
  }

  const ranked = new Map<string, { url: string; confidence: number; code: string }>();
  const upsert = (emojiKey: string, url: string, confidence: number, code: string) => {
    const existing = ranked.get(emojiKey);
    if (
      !existing ||
      confidence > existing.confidence ||
      (confidence === existing.confidence && code.localeCompare(existing.code) < 0)
    ) {
      ranked.set(emojiKey, { url, confidence, code });
    }
  };

  for (const entry of sourceEntries) {
    if (!entry || typeof entry.emoji !== "string" || typeof entry.url !== "string") {
      continue;
    }
    const emoji = extractSingleEmoji(entry.emoji.trim());
    const url = resolvePublicAssetUrl(entry.url);
    if (!emoji || !url) {
      continue;
    }
    const confidence =
      Number.isFinite(entry.confidence) && Number(entry.confidence) >= 0
        ? Number(entry.confidence)
        : 0;
    const code = typeof entry.code === "string" ? entry.code : "";

    upsert(emoji, url, confidence, code);
    const normalized = normalizeEmojiKey(emoji);
    if (normalized && normalized !== emoji) {
      upsert(normalized, url, confidence, code);
    }
  }

  return new Map(Array.from(ranked.entries()).map(([emoji, meta]) => [emoji, meta.url]));
};

const fetchEmojiLookupFromUrl = async (url: string) => {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    return parseEmojiLookup(await response.json());
  } catch {
    return null;
  }
};

const loadLocalEmojiLookup = async () => {
  const indexed = await fetchEmojiLookupFromUrl(
    getLocalEmotesJsonUrl(LOCAL_EMOJI_INDEX_FILE),
  );
  if (indexed && indexed.size > 0) {
    return indexed;
  }

  const labeled = await fetchEmojiLookupFromUrl(
    getLocalEmotesJsonUrl(LOCAL_EMOJI_LABELS_FILE),
  );
  if (labeled && labeled.size > 0) {
    return labeled;
  }

  return null;
};

const loadEmojiEmoteLookup = (): Promise<ReadonlyMap<string, string>> => {
  if (inMemoryEmojiLookup && inMemoryEmojiLookup.expiresAt > Date.now()) {
    return Promise.resolve(inMemoryEmojiLookup.map);
  }

  if (!inFlightEmojiLookup) {
    inFlightEmojiLookup = loadLocalEmojiLookup()
      .then((lookup) => {
        const map = lookup ?? new Map<string, string>();
        inMemoryEmojiLookup = {
          expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
          map,
        };
        return map;
      })
      .finally(() => {
        inFlightEmojiLookup = null;
      });
  }

  return inFlightEmojiLookup;
};

export const useEmojiEmoteLookup = (
  enabled: boolean,
): ReadonlyMap<string, string> | null => {
  const cachedLookup = enabled ? getFreshEmojiLookupCache() : null;
  const [lookup, setLookup] = useState<ReadonlyMap<string, string> | null>(() => cachedLookup);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    void loadEmojiEmoteLookup()
      .then((next) => {
        if (!cancelled) {
          setLookup(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLookup(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled ? lookup ?? cachedLookup : null;
};
