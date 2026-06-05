import type { SettingsTab } from "@/global/settings/settings-tabs";

/**
 * Translate function shape (matches `useT()` / `i18n.t`). The search
 * catalog is i18n-driven: entries reference catalog keys and are
 * resolved against the active locale at query time so results — and the
 * scroll-to-card matching — work in every supported language.
 */
export type SettingsSearchTranslate = (key: string) => string;

/**
 * Definition of a searchable Settings entry. One entry per
 * `.settings-card` (or logical row) so users find a card by its heading,
 * description, or any row label / sublabel inside it.
 *
 * This catalog drives the global "Search settings" results view: every
 * tab can be searched at once because the catalog covers them all, even
 * the tabs that haven't been lazy-loaded yet.
 *
 * Two layers of synonym handling:
 *   - Per-entry `keywords` — the strongest signal. Use this for
 *     setting-specific aliases ("byok", "anthropic oauth", "rtl").
 *     Keywords stay English; localized search still matches via the
 *     translated title/description.
 *   - Global `SEARCH_SYNONYMS` map below — for words that should match
 *     across many settings ("mute" → sound/audio/volume/notification).
 *
 * `titleKey` MUST resolve to the same string rendered in the matching
 * `<h3 className="settings-card-title">…</h3>` (or `cardTitleKey` for
 * row-level entries) — that resolved title is what we use to scroll the
 * user to the section after jumping to its tab, so reusing the card's
 * own catalog key keeps it correct in every locale automatically.
 */
export interface SettingsSearchEntryDef {
  tab: SettingsTab;
  /** Catalog key for the title shown in results (card heading OR row label). */
  titleKey: string;
  /** Catalog key for the description shown under the title. */
  descriptionKey: string;
  /**
   * Optional catalog key for the card heading to scroll to after the
   * user picks this entry. Defaults to `titleKey`. Use this for
   * row-level entries whose title is a control inside a larger card.
   */
  cardTitleKey?: string;
  /** Extra free-form (English) text users might type. */
  keywords: string[];
}

/** A catalog entry resolved against the active locale. */
export interface ResolvedSettingsSearchEntry {
  tab: SettingsTab;
  title: string;
  description: string;
  cardTitle?: string;
  keywords: string[];
}

export const SETTINGS_SEARCH_ENTRY_DEFS: SettingsSearchEntryDef[] = [
  // ---------- General ----------
  {
    tab: "general",
    titleKey: "settings.language.title",
    descriptionKey: "settings.language.description",
    keywords: [
      "locale",
      "translation",
      "english",
      "spanish",
      "french",
      "chinese",
      "japanese",
      "korean",
      "german",
      "italian",
      "arabic",
      "hebrew",
      "rtl",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.developerPreviews.title",
    descriptionKey: "settings.developerPreviews.description",
    keywords: ["developer", "code", "diff", "file previews", "preview"],
  },
  {
    tab: "general",
    titleKey: "settings.nativeFontSmoothing.title",
    descriptionKey: "settings.nativeFontSmoothing.description",
    keywords: [
      "font",
      "fonts",
      "antialias",
      "anti-aliasing",
      "anti aliasing",
      "smoothing",
      "grayscale",
      "subpixel",
      "rendering",
      "text",
      "macos",
      "mac",
      "appearance",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.motion.title",
    descriptionKey: "settings.motion.reduceMotion.description",
    keywords: [
      "reduce motion",
      "reduced motion",
      "animation",
      "animations",
      "motion",
      "accessibility",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.voice.personality.label",
    descriptionKey: "settings.search.descriptions.voice",
    keywords: ["personality", "tone", "professional", "stella voice", "voice"],
  },
  {
    tab: "general",
    titleKey: "settings.notifications.title",
    descriptionKey: "settings.notifications.description",
    keywords: [
      "alerts",
      "sound notifications",
      "agent done",
      "mute",
      "silence",
      "quiet",
      "ping",
      "chime",
      "bell",
      "do not disturb",
      "notifications",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.power.title",
    descriptionKey: "settings.power.description",
    keywords: [
      "prevent sleep",
      "keep awake",
      "battery",
      "screensaver",
      "energy",
      "idle",
      "power",
      "caffeinate",
      "no sleep",
      "stay on",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.lockedComputerUse.title",
    descriptionKey: "settings.lockedComputerUse.description",
    keywords: [
      "computer use",
      "lock screen",
      "locked use",
      "unlock",
      "authorization",
      "remote",
      "desktop automation",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.browserExtension.title",
    descriptionKey: "settings.browserExtension.description",
    keywords: [
      "chrome",
      "extension",
      "arc",
      "brave",
      "edge",
      "chromium",
      "plugin",
      "addon",
      "add-on",
      "browser extension",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.migration.title",
    descriptionKey: "settings.migration.description",
    keywords: [
      "migration",
      "migrate",
      "import",
      "hermes",
      "openclaw",
      "skills",
      "session history",
      "model config",
      "assistant",
    ],
  },
  {
    tab: "general",
    titleKey: "settings.permissions.title",
    descriptionKey: "settings.search.descriptions.permissions",
    keywords: [
      "accessibility",
      "screen capture",
      "screen recording",
      "microphone permission",
      "macos permissions",
      "system settings",
      "tcc",
      "privacy",
      "security",
      "allow",
      "camera",
    ],
  },

  // ---------- Shortcuts ----------
  {
    tab: "shortcuts",
    titleKey: "settings.shortcuts.title",
    descriptionKey: "settings.search.descriptions.shortcuts",
    keywords: [
      "keybindings",
      "hotkeys",
      "keyboard shortcuts",
      "dictation",
      "voice",
      "radial dial",
      "mini window",
      "option key",
      "double tap",
      "bindings",
    ],
  },

  // ---------- Memory ----------
  {
    tab: "memory",
    titleKey: "settings.memory.title",
    descriptionKey: "settings.search.descriptions.memory",
    keywords: [
      "screen memory",
      "chronicle",
      "dream",
      "remember",
      "long term memory",
      "wipe memory",
      "erase memory",
      "memory folder",
      "history",
      "forget",
    ],
  },

  // ---------- Backup ----------
  {
    tab: "backup",
    titleKey: "settings.backup.title",
    descriptionKey: "settings.search.descriptions.backup",
    keywords: [
      "restore",
      "snapshot",
      "automatic backup",
      "back up now",
      "saved backups",
      "encrypted backup",
      "remote backup",
      "recovery",
      "export",
      "import",
      "sync",
    ],
  },

  // ---------- Account & Legal ----------
  {
    tab: "account",
    titleKey: "settings.account.title",
    descriptionKey: "settings.search.descriptions.account",
    keywords: [
      "sign out",
      "log out",
      "logout",
      "signout",
      "delete data",
      "delete account",
      "erase data",
      "wipe",
      "profile",
      "user",
      "subscription",
    ],
  },
  {
    tab: "account",
    titleKey: "settings.account.legal.title",
    descriptionKey: "settings.search.descriptions.legal",
    keywords: ["terms of service", "tos", "privacy policy", "license"],
  },

  // ---------- Audio ----------
  {
    tab: "audio",
    titleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.microphone",
    keywords: [
      "mic",
      "input device",
      "hey stella",
      "wake word",
      "super fast dictation",
      "dictation sounds",
      "enhance transcription",
      "on-device transcription",
      "parakeet",
      "inworld",
      "voice",
      "dictate",
      "speech to text",
      "stt",
      "mute",
      "silence",
    ],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.speaker.title",
    descriptionKey: "settings.search.descriptions.speaker",
    keywords: [
      "output device",
      "headphones",
      "audio output",
      "playback",
      "volume",
      "mute",
      "silence",
      "speakers",
      "sound output",
    ],
  },

  // ---------- Row-level entries -----------------------------------------
  //
  // Surface popular toggles as their own results so search lands on the
  // setting the user named, not just the card it lives in. Each carries
  // `cardTitleKey` so we still scroll to the right card on jump.

  {
    tab: "audio",
    titleKey: "settings.audio.wakeWord.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.wakeWord",
    keywords: ["hey stella", "wake", "always listening", "voice trigger"],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.localDictation.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.search.descriptions.onDeviceTranscription",
    keywords: ["parakeet", "local", "offline", "private", "stt"],
  },
  {
    tab: "audio",
    titleKey: "settings.audio.dictationSounds.label",
    cardTitleKey: "settings.audio.microphone.title",
    descriptionKey: "settings.audio.dictationSounds.description",
    keywords: ["chime", "ping", "feedback", "mute dictation"],
  },
  {
    tab: "account",
    titleKey: "settings.account.signOut.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.signOut.description",
    keywords: ["log out", "logout", "signout"],
  },
  {
    tab: "account",
    titleKey: "settings.account.deleteAccount.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.deleteAccount.description",
    keywords: ["close account", "remove account", "cancel account"],
  },
  {
    tab: "account",
    titleKey: "settings.account.deleteData.label",
    cardTitleKey: "settings.account.title",
    descriptionKey: "settings.account.deleteData.description",
    keywords: ["wipe", "clear", "erase", "reset"],
  },
  {
    tab: "backup",
    titleKey: "settings.backup.backupNow.label",
    cardTitleKey: "settings.backup.title",
    descriptionKey: "settings.backup.backupNow.description",
    keywords: ["manual backup", "snapshot", "save"],
  },
];

// ---------------------------------------------------------------------------
// Global synonym map
// ---------------------------------------------------------------------------

/**
 * Bidirectional synonym map. Each key expands to other words the search
 * should also accept for that token (and vice-versa). Use this for
 * cross-cutting words ("mute" → sound/audio/volume) rather than
 * setting-specific aliases — those belong in the entry's `keywords`.
 *
 * Rules of thumb when adding:
 *   - Keep terms lowercase and single-word where possible.
 *   - Bias toward true synonyms, not "related concepts" — false
 *     positives erode trust faster than misses do.
 *   - Keep total expansions small per word (≤ ~6) so an over-eager
 *     synonym doesn't blow scoring out of proportion.
 */
const SEARCH_SYNONYMS_RAW: Record<string, string[]> = {
  // ---- Sound / notifications ----
  mute: ["sound", "audio", "volume", "silence", "quiet", "notification"],
  silence: ["mute", "quiet", "sound", "notification"],
  quiet: ["mute", "silence", "sound"],
  sound: ["audio", "notification", "volume"],
  audio: ["sound", "volume", "speaker", "microphone"],
  volume: ["sound", "audio", "loudness"],
  notification: ["alert", "sound", "ping"],
  alert: ["notification", "ping"],

  // ---- Mic / voice / dictation ----
  mic: ["microphone", "audio", "voice"],
  microphone: ["mic", "audio", "voice"],
  voice: ["microphone", "dictation", "speech"],
  dictation: ["voice", "transcription", "speech to text"],
  speech: ["voice", "dictation"],
  transcribe: ["dictation", "transcription"],

  // ---- Speakers / output ----
  speaker: ["audio", "output", "headphones", "sound"],
  speakers: ["speaker", "audio", "output", "headphones"],
  headphones: ["speaker", "audio", "output"],

  // ---- Appearance / display ----
  dark: ["theme", "appearance", "color"],
  light: ["theme", "appearance", "color"],
  theme: ["appearance", "color"],
  appearance: ["theme", "color", "display"],
  font: ["text", "typography"],

  // ---- Account / auth ----
  login: ["sign in", "account"],
  logout: ["sign out", "account"],
  signin: ["sign in", "account"],
  signout: ["sign out", "account"],
  password: ["account", "security", "credentials"],
  user: ["account", "profile"],
  profile: ["account", "user"],

  // ---- Privacy / safety ----
  privacy: ["permissions", "security", "private"],
  security: ["privacy", "permissions", "safety"],
  safety: ["privacy", "security"],
  allow: ["permissions", "grant", "enable"],

  // ---- Memory / data ----
  history: ["memory", "log"],
  delete: ["erase", "remove", "wipe"],
  remove: ["delete", "erase", "wipe"],
  erase: ["delete", "wipe", "remove"],
  forget: ["erase", "delete", "memory"],

  // ---- Backups / sync ----
  save: ["backup", "snapshot"],
  recovery: ["backup", "restore"],
  restore: ["backup", "recovery"],
  sync: ["backup", "remote"],

  // ---- Models / AI ----
  ai: ["model", "llm"],
  llm: ["model", "ai"],
  gpt: ["openai", "model"],
  claude: ["anthropic", "model"],
  chatbot: ["model", "ai"],

  // ---- Power ----
  sleep: ["power", "idle"],
  battery: ["power"],
  awake: ["power", "sleep"],
  energy: ["power", "battery"],

  // ---- Browser ----
  plugin: ["extension", "addon"],
  addon: ["extension", "plugin"],
  browser: ["chrome", "extension"],

  // ---- Shortcuts ----
  hotkey: ["shortcut", "keybinding"],
  hotkeys: ["shortcut", "keybinding"],
  keybind: ["shortcut", "keybinding"],
  keyboard: ["shortcut", "keybinding"],

  // ---- Misc / accessibility ----
  camera: ["screen", "capture", "permissions"],
  caption: ["transcription"],
  captions: ["transcription"],
};

/**
 * Build a normalized + symmetric synonym graph at module load. Symmetry
 * means if you defined `mute → sound`, `sound` also expands to `mute`
 * without you having to write both directions by hand.
 */
const SEARCH_SYNONYMS: Map<string, ReadonlySet<string>> = (() => {
  const graph = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a)!.add(b);
  };
  for (const [key, values] of Object.entries(SEARCH_SYNONYMS_RAW)) {
    const a = normalizeSearchText(key);
    if (!a) continue;
    for (const value of values) {
      const b = normalizeSearchText(value);
      add(a, b);
      add(b, a);
    }
  }
  // Freeze each entry as a ReadonlySet for safer downstream usage.
  const frozen = new Map<string, ReadonlySet<string>>();
  for (const [key, set] of graph) {
    frozen.set(key, set);
  }
  return frozen;
})();

// ---------------------------------------------------------------------------
// Tokenization + matching
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip diacritics, collapse whitespace. Cheap enough to run
 * inline on every keystroke for the small settings catalog (~20 entries).
 */
export function normalizeSearchText(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split the user's query into tokens. AND-semantics: every token must
 * appear (or have a synonym that appears) for a result to match.
 */
export function tokenizeQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

/**
 * A token group is the user's typed token plus its global synonyms.
 * Matching a token = at least one member of its group appears in the
 * target text. Empty / very short tokens (1 char) skip synonym
 * expansion to avoid noisy matches.
 */
export type TokenGroup = readonly string[];

export function expandTokens(tokens: string[]): TokenGroup[] {
  return tokens.map((token) => {
    if (token.length <= 1) return [token];
    const synonyms = SEARCH_SYNONYMS.get(token);
    if (!synonyms || synonyms.size === 0) return [token];
    // De-dupe in case the synonym list happens to contain the token
    // itself after normalization.
    const seen = new Set<string>([token]);
    const group: string[] = [token];
    for (const synonym of synonyms) {
      if (seen.has(synonym)) continue;
      seen.add(synonym);
      group.push(synonym);
    }
    return group;
  });
}

/**
 * Word-start substring match: returns true iff `term` appears in `text`
 * at the start of a word (start of string or right after a non-word
 * character). This is what Spotlight / System Settings / VS Code's
 * settings search do — typing "wake" matches "wake word" but not
 * "awake", and "back" matches "Backups" but not "feedback".
 *
 * Hot path. Implemented without regex for cheapness; the catalog is
 * tiny but we still get called once per (token × candidate text) on
 * every keystroke.
 */
export function includesAsWordStart(text: string, term: string): boolean {
  if (!term) return false;
  const termLen = term.length;
  const textLen = text.length;
  if (termLen > textLen) return false;

  let from = 0;
  while (from <= textLen - termLen) {
    const idx = text.indexOf(term, from);
    if (idx === -1) return false;
    if (idx === 0) return true;
    const prev = text.charCodeAt(idx - 1);
    // Word characters: lowercase ASCII letters (a-z), digits (0-9).
    // `text` is already lower-cased and diacritic-stripped, so this is
    // sufficient. Any other character (space, hyphen, slash, etc.)
    // counts as a word boundary.
    const isAlphanum =
      (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
    if (!isAlphanum) return true;
    from = idx + 1;
  }
  return false;
}

/** True iff every token group has at least one member appearing in `text`. */
export function matchesAllTokenGroups(
  text: string,
  groups: TokenGroup[],
): boolean {
  if (groups.length === 0) return true;
  for (const group of groups) {
    let groupHit = false;
    for (const term of group) {
      if (includesAsWordStart(text, term)) {
        groupHit = true;
        break;
      }
    }
    if (!groupHit) return false;
  }
  return true;
}

interface NormalizedEntry {
  entry: ResolvedSettingsSearchEntry;
  titleText: string;
  descriptionText: string;
  /** Title + description + keywords + tab key. */
  searchText: string;
}

/** Resolve every catalog def against the active locale's translator. */
function resolveEntries(
  t: SettingsSearchTranslate,
): ResolvedSettingsSearchEntry[] {
  return SETTINGS_SEARCH_ENTRY_DEFS.map((def) => {
    const cardTitle = def.cardTitleKey ? t(def.cardTitleKey) : undefined;
    return {
      tab: def.tab,
      title: t(def.titleKey),
      description: t(def.descriptionKey),
      ...(cardTitle ? { cardTitle } : {}),
      keywords: def.keywords,
    };
  });
}

// Resolve + normalize the catalog per translator. The active locale's
// `t` is stable between renders, so we memoize on its identity and only
// rebuild when the language actually changes.
let normalizedCacheKey: SettingsSearchTranslate | null = null;
let normalizedCache: NormalizedEntry[] = [];

function getNormalizedEntries(
  t: SettingsSearchTranslate,
): NormalizedEntry[] {
  if (normalizedCacheKey === t) return normalizedCache;
  normalizedCache = resolveEntries(t).map((entry) => ({
    entry,
    titleText: normalizeSearchText(entry.title),
    descriptionText: normalizeSearchText(entry.description),
    searchText: normalizeSearchText(
      [entry.title, entry.description, ...entry.keywords, entry.tab].join(" "),
    ),
  }));
  normalizedCacheKey = t;
  return normalizedCache;
}

/**
 * Score an entry against expanded token groups. Higher is better.
 *
 *   - Whole-query exact title match  → 1000
 *   - Title starts with whole query  → 500
 *   - All groups hit title           → 250 + earlier-position bonus
 *   - All groups hit description     → 100
 *   - All groups hit anywhere        → 50
 *
 * Synonym-driven hits get a small penalty so literal matches always
 * outrank synonym matches at the same tier — users typing "voice" want
 * the Voice card above any synonym-driven hit on "audio".
 *
 * Returns -1 when the entry doesn't match.
 */
function scoreEntry(normalized: NormalizedEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const groups = expandTokens(tokens);
  const { titleText, descriptionText, searchText } = normalized;
  const fullQuery = tokens.join(" ");

  // Literal-only checks first (cheap path, best score).
  if (titleText === fullQuery) return 1000;
  if (titleText.startsWith(fullQuery)) return 500;

  const onlyLiteral = (text: string) => {
    for (const token of tokens) {
      if (!includesAsWordStart(text, token)) return false;
    }
    return true;
  };

  if (onlyLiteral(titleText)) {
    const firstTokenIndex = titleText.indexOf(tokens[0] ?? "");
    return 250 + Math.max(0, 50 - firstTokenIndex);
  }
  if (matchesAllTokenGroups(titleText, groups)) {
    // Title matched only via synonyms — solid hit, but rank below
    // literal title matches.
    return 200;
  }

  if (onlyLiteral(descriptionText)) return 100;
  if (matchesAllTokenGroups(descriptionText, groups)) return 80;

  if (onlyLiteral(searchText)) return 50;
  if (matchesAllTokenGroups(searchText, groups)) return 40;

  return -1;
}

export interface ScoredSettingsSearchEntry extends ResolvedSettingsSearchEntry {
  score: number;
}

/**
 * Returns matched catalog entries, best-scoring first. Stable secondary
 * sort by catalog order so equal-score results don't shuffle as the
 * user types. Entries are resolved against `t` so both the displayed
 * copy and the scroll-to-card title match the active locale.
 */
export function searchSettings(
  query: string,
  t: SettingsSearchTranslate,
): ScoredSettingsSearchEntry[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const indexed: Array<{ scored: ScoredSettingsSearchEntry; order: number }> =
    [];
  getNormalizedEntries(t).forEach((normalized, order) => {
    const score = scoreEntry(normalized, tokens);
    if (score < 0) return;
    indexed.push({
      scored: { ...normalized.entry, score },
      order,
    });
  });

  indexed.sort((a, b) => {
    if (b.scored.score !== a.scored.score) {
      return b.scored.score - a.scored.score;
    }
    return a.order - b.order;
  });

  return indexed.map((item) => item.scored);
}

/**
 * Returns the flattened, de-duplicated set of all terms that would
 * count as a match for the given query — the user's literal tokens
 * plus their expansions. Used by the results UI to highlight the
 * actual word that made each result match (e.g. typing "mute"
 * highlights "sound" and "notification" in the description).
 */
export function expandedMatchTerms(query: string): string[] {
  const groups = expandTokens(tokenizeQuery(query));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const term of group) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}
