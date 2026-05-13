import type { SettingsTab } from "@/global/settings/settings-tabs";

/**
 * A single searchable entry in the Settings page. One entry per
 * `.settings-card` (or logical section) so users find a card by its
 * heading, description, or any row label / sublabel inside it.
 *
 * This catalog drives the global "Search settings" results view: every
 * tab can be searched at once because the catalog covers them all, even
 * the tabs that haven't been lazy-loaded yet.
 *
 * Two layers of synonym handling:
 *   - Per-entry `keywords` — the strongest signal. Use this for
 *     setting-specific aliases ("byok", "anthropic oauth", "rtl").
 *   - Global `SEARCH_SYNONYMS` map below — for words that should match
 *     across many settings ("mute" → sound/audio/volume/notification).
 *
 * Keep titles in sync with `<h3 className="settings-card-title">…</h3>`
 * across the tab components — the title is what we use to scroll the
 * user to the section after jumping to its tab.
 */
export interface SettingsSearchEntry {
  tab: SettingsTab;
  /** Display title shown in results. May be a card heading OR a row label. */
  title: string;
  /** Short description shown in the results list under the title. */
  description: string;
  /**
   * Optional card heading to scroll to after the user picks this entry.
   * Defaults to `title`. Use this for row-level entries whose `title`
   * is a control inside a larger card — e.g. "Wake word" has
   * `cardTitle: "Microphone"` so picking it scrolls to the Microphone
   * card on the Audio tab.
   */
  cardTitle?: string;
  /** Extra free-form text users might type. Title + description are auto-included. */
  keywords: string[];
}

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  // ---------- Basic ----------
  {
    tab: "basic",
    title: "Language",
    description: "Choose the language Stella uses across the app.",
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
    tab: "basic",
    title: "Chat previews",
    description: "Show developer file changes in chat and the side panel.",
    keywords: ["developer", "code", "diff", "file previews", "preview"],
  },
  {
    tab: "basic",
    title: "Voice",
    description: "Pick Stella's speaking style and personality voice.",
    keywords: ["personality", "tone", "stella voice", "accent"],
  },
  {
    tab: "basic",
    title: "Notifications",
    description: "Play a sound when Stella finishes an agent run.",
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
    ],
  },
  {
    tab: "basic",
    title: "Power",
    description: "Keep this computer awake while Stella is running.",
    keywords: [
      "prevent sleep",
      "keep awake",
      "battery",
      "screensaver",
      "energy",
      "idle",
    ],
  },
  {
    tab: "basic",
    title: "Browser extension",
    description: "Add the Stella extension to Chrome and other browsers.",
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
    ],
  },
  {
    tab: "basic",
    title: "Permissions",
    description:
      "Grant accessibility, screen capture, and microphone access on macOS.",
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
    title: "Shortcuts",
    description:
      "Change how Stella opens, listens, and starts the radial dial or voice.",
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
    title: "Memory",
    description:
      "Manage screen memory, update or erase what Stella has remembered.",
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
    title: "Backups",
    description:
      "Automatic encrypted backups, restore points, and on-demand snapshots.",
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
    title: "Account",
    description:
      "Sign out, delete your data, or permanently delete your account.",
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
    title: "Legal",
    description: "Terms of Service and Privacy Policy.",
    keywords: ["terms of service", "tos", "privacy policy", "license"],
  },

  // ---------- Models ----------
  {
    tab: "models",
    title: "Models",
    description:
      "Pick a model for any agent and choose where image generation and voice run.",
    keywords: [
      "model picker",
      "orchestrator",
      "general agent",
      "image generation",
      "voice model",
      "byok",
      "api key",
      "provider",
      "reasoning",
      "openai",
      "anthropic",
      "openrouter",
      "fireworks",
      "kimi",
      "deepseek",
      "gemini",
      "stella best",
      "stella smart",
      "stella standard",
      "llm",
      "ai",
      "gpt",
      "claude",
      "chatbot",
    ],
  },
  {
    tab: "models",
    title: "Connected providers",
    description:
      "Disconnect API keys or sign-ins for providers connected on this device.",
    keywords: [
      "api keys",
      "oauth",
      "disconnect provider",
      "sign in provider",
      "anthropic oauth",
      "token",
      "credentials",
    ],
  },

  // ---------- Audio ----------
  {
    tab: "audio",
    title: "Microphone",
    description:
      "Pick your input device, enable wake word, dictation sounds, and on-device transcription.",
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
    title: "Speaker",
    description: "Pick the speaker or headphones Stella's voice plays through.",
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
  // `cardTitle` so we still scroll to the right card on jump.

  {
    tab: "audio",
    title: "Wake word",
    cardTitle: "Microphone",
    description:
      "Listen for \u201CHey Stella\u201D and start a voice conversation.",
    keywords: ["hey stella", "wake", "always listening", "voice trigger"],
  },
  {
    tab: "audio",
    title: "On-device transcription",
    cardTitle: "Microphone",
    description:
      "Use the local Parakeet model instead of cloud transcription.",
    keywords: ["parakeet", "local", "offline", "private", "stt"],
  },
  {
    tab: "audio",
    title: "Dictation sounds",
    cardTitle: "Microphone",
    description: "Play a sound when dictation starts and stops.",
    keywords: ["chime", "ping", "feedback", "mute dictation"],
  },
  {
    tab: "basic",
    title: "Prevent sleep",
    cardTitle: "Power",
    description: "Stop your computer from sleeping while Stella is open.",
    keywords: ["caffeinate", "keep awake", "no sleep", "stay on"],
  },
  {
    tab: "basic",
    title: "Stella for Chrome",
    cardTitle: "Browser extension",
    description: "Add the Stella browser extension to Chrome.",
    keywords: ["chrome extension", "install extension"],
  },
  {
    tab: "basic",
    title: "Sound notifications",
    cardTitle: "Notifications",
    description: "Play a sound when Stella finishes an agent run.",
    keywords: ["mute", "silence", "ping", "alert sound"],
  },
  {
    tab: "account",
    title: "Sign out",
    cardTitle: "Account",
    description: "Sign out of Stella on this device.",
    keywords: ["log out", "logout", "signout"],
  },
  {
    tab: "account",
    title: "Delete account",
    cardTitle: "Account",
    description: "Permanently delete your account and everything in it.",
    keywords: ["close account", "remove account", "cancel account"],
  },
  {
    tab: "account",
    title: "Delete data",
    cardTitle: "Account",
    description:
      "Erase every conversation, memory, and saved Stella setting.",
    keywords: ["wipe", "clear", "erase", "reset"],
  },
  {
    tab: "backup",
    title: "Back up now",
    cardTitle: "Backups",
    description: "Save an encrypted backup right now.",
    keywords: ["manual backup", "snapshot", "save"],
  },
  {
    tab: "models",
    title: "API keys",
    cardTitle: "Connected providers",
    description: "Bring your own API key for any LLM provider.",
    keywords: ["byok", "secret", "token", "key"],
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
  entry: SettingsSearchEntry;
  titleText: string;
  descriptionText: string;
  /** Title + description + keywords + tab key. */
  searchText: string;
}

// Pre-normalize once at module load — per-keystroke work becomes pure
// `String.prototype.includes` calls.
const NORMALIZED_ENTRIES: NormalizedEntry[] = SETTINGS_SEARCH_ENTRIES.map(
  (entry) => ({
    entry,
    titleText: normalizeSearchText(entry.title),
    descriptionText: normalizeSearchText(entry.description),
    searchText: normalizeSearchText(
      [entry.title, entry.description, ...entry.keywords, entry.tab].join(" "),
    ),
  }),
);

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

export interface ScoredSettingsSearchEntry extends SettingsSearchEntry {
  score: number;
}

/**
 * Returns matched catalog entries, best-scoring first. Stable secondary
 * sort by catalog order so equal-score results don't shuffle as the
 * user types.
 */
export function searchSettings(query: string): ScoredSettingsSearchEntry[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const indexed: Array<{ scored: ScoredSettingsSearchEntry; order: number }> =
    [];
  NORMALIZED_ENTRIES.forEach((normalized, order) => {
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
