const STORAGE_KEY = "stella-social-censor-enabled";

const ZERO_WIDTH = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  ӏ: "l",
  ο: "o",
  ρ: "p",
  α: "a",
  ε: "e",
  ι: "i",
  ν: "v",
};

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
  "(": "c",
  "|": "i",
};

const BANNED_STEMS = [
  "nigger",
  "nigga",
  "chink",
  "spic",
  "kike",
  "gook",
  "wetback",
  "beaner",
  "darkie",
  "darky",
  "jiggaboo",
  "raghead",
  "towelhead",
  "sandnigger",
  "jewboy",
  "gypsy",
  "faggot",
  "fagot",
  "tranny",
  "dyke",
  "shemale",
  "ladyboy",
  "retard",
  "midget",
  "spastic",
  "cunt",
  "whore",
  "slut",
  "bitch",
  "twat",
  "fuck",
  "motherfuck",
  "shit",
  "bullshit",
  "bastard",
  "asshole",
  "ahole",
  "dickhead",
  "douchebag",
  "wanker",
  "jizz",
  "pussy",
  "blowjob",
  "handjob",
  "cumshot",
  "fellatio",
  "cunnilingus",
  "bukkake",
  "gangbang",
  "deepthroat",
  "milf",
  "dildo",
  "buttplug",
  "clitoris",
  "rapist",
  "molest",
  "pedo",
  "pedophile",
  "cp",
] as const;

function normalizeChar(ch: string): string {
  const normalized = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return CONFUSABLES[normalized] ?? LEET[normalized] ?? normalized;
}

function normalizedLetters(value: string) {
  const letters: { normalized: string; sourceIndex: number }[] = [];
  const input = value.replace(ZERO_WIDTH, "").toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    const normalized = normalizeChar(input[i]);
    if (/^[a-z]$/.test(normalized)) {
      letters.push({ normalized, sourceIndex: i });
    }
  }
  return letters;
}

export function getSocialCensorEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setSocialCensorEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
    window.dispatchEvent(
      new CustomEvent("stella-social-censor-change", { detail: enabled }),
    );
  } catch {
    // Best-effort local preference.
  }
}

export function maskBannedTerms(value: string): string {
  const letters = normalizedLetters(value);
  if (letters.length === 0) return value;

  const normalized = letters.map((entry) => entry.normalized).join("");
  const ranges: [number, number][] = [];
  for (const stem of BANNED_STEMS) {
    let start = normalized.indexOf(stem);
    while (start !== -1) {
      const end = start + stem.length - 1;
      ranges.push([letters[start].sourceIndex, letters[end].sourceIndex]);
      start = normalized.indexOf(stem, start + 1);
    }
  }

  if (ranges.length === 0) return value;
  return Array.from(value, (ch, index) =>
    ranges.some(([start, end]) => index >= start && index <= end) &&
    /[^\s]/.test(ch)
      ? "•"
      : ch,
  ).join("");
}
