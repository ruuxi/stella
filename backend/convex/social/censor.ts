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

function findStemRanges(
  letters: { normalized: string; sourceIndex: number }[],
  stem: string,
): [number, number][] {
  const ranges: [number, number][] = [];

  for (let start = 0; start < letters.length; start += 1) {
    if (letters[start].normalized !== stem[0]) continue;

    let stemIndex = 1;
    let letterIndex = start + 1;
    let end = start;

    while (letterIndex < letters.length && stemIndex < stem.length) {
      const current = letters[letterIndex].normalized;
      const expected = stem[stemIndex];
      const previousExpected = stem[stemIndex - 1];

      if (current === expected) {
        end = letterIndex;
        stemIndex += 1;
        letterIndex += 1;
        continue;
      }

      if (current === previousExpected) {
        end = letterIndex;
        letterIndex += 1;
        continue;
      }

      break;
    }

    while (
      stemIndex === stem.length &&
      letterIndex < letters.length &&
      letters[letterIndex].normalized === stem[stem.length - 1]
    ) {
      end = letterIndex;
      letterIndex += 1;
    }

    if (stemIndex === stem.length) {
      ranges.push([letters[start].sourceIndex, letters[end].sourceIndex]);
    }
  }

  return ranges;
}

export function findBannedTerm(value: string): string | null {
  const letters = normalizedLetters(value);
  if (letters.length === 0) {
    return null;
  }

  for (const stem of BANNED_STEMS) {
    if (findStemRanges(letters, stem).length > 0) {
      return stem;
    }
  }

  return null;
}

export function maskBannedTerms(value: string): string {
  const letters = normalizedLetters(value);
  if (letters.length === 0) return value;

  const ranges: [number, number][] = [];
  for (const stem of BANNED_STEMS) {
    ranges.push(...findStemRanges(letters, stem));
  }

  if (ranges.length === 0) return value;
  return Array.from(value, (ch, index) =>
    ranges.some(([start, end]) => index >= start && index <= end) &&
    /[^\s]/.test(ch)
      ? "•"
      : ch,
  ).join("");
}
