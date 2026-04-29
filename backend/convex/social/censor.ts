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
  const letters: string[] = [];
  const input = value.replace(ZERO_WIDTH, "").toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    const normalized = normalizeChar(input[i]);
    if (/^[a-z]$/.test(normalized)) {
      letters.push(normalized);
    }
  }
  return letters.join("");
}

export function findBannedTerm(value: string): string | null {
  const normalized = normalizedLetters(value);
  if (!normalized) {
    return null;
  }

  for (const stem of BANNED_STEMS) {
    if (normalized.includes(stem)) {
      return stem;
    }
  }

  return null;
}
