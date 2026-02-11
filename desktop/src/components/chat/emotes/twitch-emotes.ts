import { useEffect, useState } from "react";

export type TwitchEmoteProvider = "7tv" | "bttv" | "ffz" | "twitch";

export type TwitchEmoteRecord = {
  code: string;
  url: string;
  provider: TwitchEmoteProvider;
  animated: boolean;
  priority: number;
};

type TwitchEmoteLookup = ReadonlyMap<string, string>;

type TemotesEmoteProvider = 0 | 1 | 2 | 3;
type TemotesEmoteUrl = {
  size?: string;
  url?: string;
};
type TemotesEmote = {
  provider?: TemotesEmoteProvider;
  code?: string;
  urls?: TemotesEmoteUrl[];
};

type SevenTvHostFile = {
  name?: string;
};

type SevenTvHost = {
  url?: string;
  files?: SevenTvHostFile[];
};

type SevenTvEmoteData = {
  animated?: boolean;
  host?: SevenTvHost;
};

type SevenTvEmote = {
  name?: string;
  data?: SevenTvEmoteData;
};

type SevenTvSetResponse = {
  emotes?: SevenTvEmote[];
};

type SevenTvUserResponse = {
  emote_set?: SevenTvSetResponse;
};

type BetterTtvEmote = {
  id?: string;
  code?: string;
  animated?: boolean;
};

type BetterTtvUserResponse = {
  channelEmotes?: BetterTtvEmote[];
  sharedEmotes?: BetterTtvEmote[];
};

type CachedTwitchEmotes = {
  expiresAt: number;
  emotes: TwitchEmoteRecord[];
};

type LocalEmoteManifest = {
  version?: number;
  generatedAt?: string;
  channels?: string[];
  emotes?: TwitchEmoteRecord[];
};

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

const CACHE_KEY = "stella:twitch-emotes:v2";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const LOCAL_MANIFEST_FILE = "manifest.json";
const LOCAL_EMOJI_INDEX_FILE = "emoji-index.json";
const LOCAL_EMOJI_LABELS_FILE = "emoji-labels.json";
const SEVEN_TV_GLOBAL_URL = "https://7tv.io/v3/emote-sets/global";
const SEVEN_TV_USER_URL = "https://7tv.io/v3/users/twitch";
const BTTV_GLOBAL_URL = "https://api.betterttv.net/3/cached/emotes/global";
const BTTV_USER_URL = "https://api.betterttv.net/3/cached/users/twitch";
const TEMOTES_BASE_URL =
  (import.meta.env.VITE_TWITCH_EMOTE_API_URL ?? "https://emotes.adamcy.pl/v1").trim();
const TEMOTES_SERVICES =
  (import.meta.env.VITE_TWITCH_EMOTE_SERVICES ?? "7tv.bttv.ffz").trim();
const DEFAULT_FALLBACK_CHANNELS = [
  "xqc",
  "forsen",
  "sodapoppin",
  "lirik",
  "nymn",
  "pokelawls",
];
const MAX_CHANNELS = 8;

const PREFERRED_7TV_FILES = [
  "4x.webp",
  "3x.webp",
  "2x.webp",
  "1x.webp",
  "4x.avif",
  "3x.avif",
  "2x.avif",
  "1x.avif",
  "4x.gif",
  "3x.gif",
  "2x.gif",
  "1x.gif",
];
const PREFERRED_TEMOTES_SIZES = ["4x", "3x", "2x", "1x"];

let inMemoryCache: { expiresAt: number; map: Map<string, TwitchEmoteRecord> } | null =
  null;
let inFlightRequest: Promise<Map<string, TwitchEmoteRecord>> | null = null;
let inMemoryEmojiLookup: { expiresAt: number; map: Map<string, string> } | null = null;
let inFlightEmojiLookup: Promise<Map<string, string>> | null = null;
let localManifestLoadAttempted = false;
let localManifestRecords: Map<string, TwitchEmoteRecord> | null = null;

const getStorage = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isValidCode = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && !/\s/.test(trimmed);
};

const normalizeCode = (value: string) => value.trim();
const isNumeric = (value: string) => /^[0-9]+$/.test(value);

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

const toAbsoluteUrl = (value: string) => {
  if (value.startsWith("https://") || value.startsWith("http://")) {
    return value;
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  return `https://${value}`;
};

const EMOJI_RE =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u;
const VARIATION_SELECTOR_16 = /\uFE0F/g;

const normalizeEmojiKey = (value: string) => value.replace(VARIATION_SELECTOR_16, "");

const extractSingleEmoji = (value: string) => {
  const match = value.match(EMOJI_RE);
  return match?.[0] ?? "";
};

const normalizeChannels = (inputs: string[]) => {
  const deduped = new Map<string, string>();
  for (const raw of inputs) {
    const normalized = raw.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }
  return Array.from(deduped.values()).slice(0, MAX_CHANNELS);
};

const parseCachedValue = (raw: string | null): CachedTwitchEmotes | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedTwitchEmotes;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.emotes)) return null;
    if (typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
};

const saveCache = (records: Map<string, TwitchEmoteRecord>) => {
  const storage = getStorage();
  if (!storage) return;

  const payload: CachedTwitchEmotes = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    emotes: Array.from(records.values()),
  };
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore cache write failures.
  }
};

const loadCache = (): { map: Map<string, TwitchEmoteRecord>; isFresh: boolean } | null => {
  const storage = getStorage();
  if (!storage) return null;

  const parsed = parseCachedValue(storage.getItem(CACHE_KEY));
  if (!parsed) return null;

  const map = new Map<string, TwitchEmoteRecord>();
  for (const emote of parsed.emotes) {
    if (
      !emote ||
      typeof emote.code !== "string" ||
      typeof emote.url !== "string" ||
      !isValidCode(emote.code)
    ) {
      continue;
    }
    map.set(emote.code, emote);
  }

  return {
    map,
    isFresh: parsed.expiresAt > Date.now(),
  };
};

const parseManifest = (raw: unknown): Map<string, TwitchEmoteRecord> | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const manifest = raw as LocalEmoteManifest;
  if (!Array.isArray(manifest.emotes)) {
    return null;
  }

  const map = new Map<string, TwitchEmoteRecord>();
  for (const emote of manifest.emotes) {
    if (
      !emote ||
      typeof emote.code !== "string" ||
      typeof emote.url !== "string" ||
      !isValidCode(emote.code)
    ) {
      continue;
    }
    map.set(emote.code, { ...emote, url: resolvePublicAssetUrl(emote.url) });
  }

  return map;
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

const loadLocalManifestRecords = async () => {
  if (localManifestLoadAttempted) {
    return localManifestRecords;
  }
  localManifestLoadAttempted = true;

  try {
    const response = await fetch(getLocalEmotesJsonUrl(LOCAL_MANIFEST_FILE), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      localManifestRecords = null;
      return null;
    }
    const parsed = parseManifest(await response.json());
    localManifestRecords = parsed;
    return parsed;
  } catch {
    localManifestRecords = null;
    return null;
  }
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

const upsertEmote = (
  target: Map<string, TwitchEmoteRecord>,
  candidate: TwitchEmoteRecord,
) => {
  const existing = target.get(candidate.code);
  if (!existing || candidate.priority >= existing.priority) {
    target.set(candidate.code, candidate);
  }
};

const getConfiguredTwitchIds = () => {
  const shared = String(import.meta.env.VITE_TWITCH_EMOTE_TWITCH_ID ?? "").trim();
  const channelsRaw = String(import.meta.env.VITE_TWITCH_EMOTE_CHANNELS ?? "").trim();
  const envChannels = channelsRaw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    sevenTv: String(import.meta.env.VITE_TWITCH_EMOTE_7TV_TWITCH_ID ?? shared).trim(),
    bttv: String(import.meta.env.VITE_TWITCH_EMOTE_BTTV_TWITCH_ID ?? shared).trim(),
    channels: normalizeChannels(
      envChannels.length > 0
        ? envChannels
        : [shared, ...DEFAULT_FALLBACK_CHANNELS].filter(Boolean),
    ),
  };
};

const providerFromTemotes = (
  value: TemotesEmoteProvider | undefined,
): TwitchEmoteProvider => {
  switch (value) {
    case 0:
      return "twitch";
    case 1:
      return "7tv";
    case 2:
      return "bttv";
    case 3:
      return "ffz";
    default:
      return "7tv";
  }
};

const pickTemotesUrl = (urls: TemotesEmoteUrl[] | undefined) => {
  if (!urls || urls.length === 0) return "";

  const bySize = new Map<string, string>();
  for (const entry of urls) {
    if (
      typeof entry.size === "string" &&
      typeof entry.url === "string" &&
      entry.url.trim().length > 0
    ) {
      bySize.set(entry.size, toAbsoluteUrl(entry.url));
    }
  }

  for (const preferred of PREFERRED_TEMOTES_SIZES) {
    const hit = bySize.get(preferred);
    if (hit) return hit;
  }
  return bySize.values().next().value ?? "";
};

const pickSevenTvFile = (files: SevenTvHostFile[] = []) => {
  const fileNames = new Set(
    files
      .map((file) => file.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  for (const preferred of PREFERRED_7TV_FILES) {
    if (fileNames.has(preferred)) {
      return preferred;
    }
  }
  return files.find((file) => typeof file.name === "string")?.name ?? null;
};

const mapSevenTvEmotes = (emotes: SevenTvEmote[] | undefined, priority: number) => {
  const mapped: TwitchEmoteRecord[] = [];

  for (const emote of emotes ?? []) {
    const code = typeof emote.name === "string" ? normalizeCode(emote.name) : "";
    if (!isValidCode(code)) continue;

    const host = emote.data?.host;
    const hostUrl =
      typeof host?.url === "string" && host.url.trim().length > 0
        ? toAbsoluteUrl(host.url)
        : "";
    if (!hostUrl) continue;

    const fileName = pickSevenTvFile(host?.files);
    if (!fileName) continue;

    mapped.push({
      code,
      provider: "7tv",
      animated: Boolean(emote.data?.animated),
      priority,
      url: `${hostUrl}/${fileName}`,
    });
  }

  return mapped;
};

const mapBetterTtvEmotes = (emotes: BetterTtvEmote[] | undefined, priority: number) => {
  const mapped: TwitchEmoteRecord[] = [];

  for (const emote of emotes ?? []) {
    const id = typeof emote.id === "string" ? emote.id.trim() : "";
    const code = typeof emote.code === "string" ? normalizeCode(emote.code) : "";
    if (!id || !isValidCode(code)) continue;

    const extension = emote.animated ? "gif" : "webp";
    mapped.push({
      code,
      provider: "bttv",
      animated: Boolean(emote.animated),
      priority,
      url: `https://cdn.betterttv.net/emote/${id}/3x.${extension}`,
    });
  }

  return mapped;
};

const mapTemotesEmotes = (emotes: TemotesEmote[] | undefined, priority: number) => {
  const mapped: TwitchEmoteRecord[] = [];

  for (const emote of emotes ?? []) {
    const code = typeof emote.code === "string" ? normalizeCode(emote.code) : "";
    if (!isValidCode(code)) continue;

    const url = pickTemotesUrl(emote.urls);
    if (!url) continue;

    mapped.push({
      code,
      url,
      priority,
      provider: providerFromTemotes(emote.provider),
      animated: /\.gif($|\?)/i.test(url),
    });
  }

  return mapped;
};

const fetchJson = async <T,>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

const fetchSevenTvRecords = async (twitchId: string) => {
  const [globalData, userData] = await Promise.all([
    fetchJson<SevenTvSetResponse>(SEVEN_TV_GLOBAL_URL),
    twitchId
      ? fetchJson<SevenTvUserResponse>(
          `${SEVEN_TV_USER_URL}/${encodeURIComponent(twitchId)}`,
        )
      : Promise.resolve(null),
  ]);

  return [
    ...mapSevenTvEmotes(globalData?.emotes, 20),
    ...mapSevenTvEmotes(userData?.emote_set?.emotes, 40),
  ];
};

const fetchBetterTtvRecords = async (twitchId: string) => {
  const [globalData, userData] = await Promise.all([
    fetchJson<BetterTtvEmote[]>(BTTV_GLOBAL_URL),
    twitchId
      ? fetchJson<BetterTtvUserResponse>(
          `${BTTV_USER_URL}/${encodeURIComponent(twitchId)}`,
        )
      : Promise.resolve(null),
  ]);

  return [
    ...mapBetterTtvEmotes(globalData ?? undefined, 10),
    ...mapBetterTtvEmotes(userData?.channelEmotes, 30),
    ...mapBetterTtvEmotes(userData?.sharedEmotes, 30),
  ];
};

const fetchTemotesRecords = async (channels: string[]) => {
  const [globalData, ...channelData] = await Promise.all([
    fetchJson<TemotesEmote[]>(
      `${TEMOTES_BASE_URL}/global/emotes/${encodeURIComponent(TEMOTES_SERVICES)}`,
    ),
    ...channels.map((channel) =>
      fetchJson<TemotesEmote[]>(
        `${TEMOTES_BASE_URL}/channel/${encodeURIComponent(
          channel,
        )}/emotes/${encodeURIComponent(TEMOTES_SERVICES)}`,
      ),
    ),
  ]);

  const mapped: TwitchEmoteRecord[] = [];
  mapped.push(...mapTemotesEmotes(globalData ?? undefined, 18));
  for (const channelEmotes of channelData) {
    mapped.push(...mapTemotesEmotes(channelEmotes ?? undefined, 45));
  }
  return mapped;
};

const fetchFreshEmotes = async () => {
  const ids = getConfiguredTwitchIds();
  const numericChannels = ids.channels.filter(isNumeric);
  const defaultNumericFallback = DEFAULT_FALLBACK_CHANNELS.find(isNumeric) ?? "";
  const [temotes, sevenTv, bttv] = await Promise.all([
    fetchTemotesRecords(ids.channels),
    fetchSevenTvRecords(
      ids.sevenTv || numericChannels[0] || defaultNumericFallback,
    ),
    fetchBetterTtvRecords(
      ids.bttv || numericChannels[0] || defaultNumericFallback,
    ),
  ]);

  const merged = new Map<string, TwitchEmoteRecord>();
  for (const emote of [...temotes, ...bttv, ...sevenTv]) {
    upsertEmote(merged, emote);
  }

  return merged;
};

const loadEmoteRecords = async () => {
  if (inMemoryCache && inMemoryCache.expiresAt > Date.now()) {
    return inMemoryCache.map;
  }

  const localRecords = await loadLocalManifestRecords();
  if (localRecords && localRecords.size > 0) {
    inMemoryCache = {
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
      map: localRecords,
    };
    return localRecords;
  }

  const cached = loadCache();
  if (cached?.isFresh) {
    inMemoryCache = { expiresAt: Date.now() + CACHE_TTL_MS, map: cached.map };
    return cached.map;
  }

  if (!inFlightRequest) {
    inFlightRequest = fetchFreshEmotes()
      .then((fresh) => {
        if (fresh.size > 0) {
          inMemoryCache = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            map: fresh,
          };
          saveCache(fresh);
          return fresh;
        }
        if (cached?.map?.size) {
          return cached.map;
        }
        return fresh;
      })
      .finally(() => {
        inFlightRequest = null;
      });
  }

  return inFlightRequest;
};

const createLookup = (records: Map<string, TwitchEmoteRecord>): TwitchEmoteLookup => {
  return new Map(
    Array.from(records.values()).map((record) => [record.code, record.url]),
  );
};

export const loadEmojiEmoteLookup = async (): Promise<ReadonlyMap<string, string>> => {
  if (inMemoryEmojiLookup && inMemoryEmojiLookup.expiresAt > Date.now()) {
    return inMemoryEmojiLookup.map;
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

export const loadTwitchEmoteLookup = async (): Promise<TwitchEmoteLookup> => {
  const records = await loadEmoteRecords();
  return createLookup(records);
};

export const useTwitchEmoteLookup = (
  enabled: boolean,
): TwitchEmoteLookup | null => {
  const [lookup, setLookup] = useState<TwitchEmoteLookup | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    void loadTwitchEmoteLookup()
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

  return enabled ? lookup : null;
};

export const useEmojiEmoteLookup = (
  enabled: boolean,
): ReadonlyMap<string, string> | null => {
  const [lookup, setLookup] = useState<ReadonlyMap<string, string> | null>(null);

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

  return enabled ? lookup : null;
};
