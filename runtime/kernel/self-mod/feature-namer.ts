import type { SelfModFeatureSnapshotItem } from "../../contracts/index.js";

const SUBJECT_MAX_FILES_IN_PROMPT = 30;
const SUBJECT_DIFF_MAX_LINES = 240;
const SUBJECT_FALLBACK_MAX_WORDS = 12;

const truncateToWordCount = (raw: string, maxWords: number): string => {
  const cleaned = raw
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/\r?\n.*$/s, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return cleaned;
  const words = cleaned.split(" ");
  if (words.length <= maxWords) return cleaned;
  return `${words.slice(0, maxWords).join(" ")}…`;
};

/**
 * Sanitize an LLM-authored commit subject. Returns the trimmed subject
 * (≤ 12 words), or an empty string if the model returned nothing usable.
 */
export const sanitizeAuthoredCommitSubject = (raw: string): string =>
  truncateToWordCount(raw, SUBJECT_FALLBACK_MAX_WORDS);

/**
 * Prompt the cheap commit-subject namer. The agent that just did the
 * work writes a 1-line user-friendly subject — no feature grouping,
 * no JSON, no parent-package logic. The runtime adds machine trailers
 * (Stella-Conversation) separately.
 */
export const buildCommitSubjectPrompt = (input: {
  taskDescription: string;
  files: string[];
  diffPreview: string;
  conversationId?: string;
}): string => {
  const filesShown = input.files.slice(0, SUBJECT_MAX_FILES_IN_PROMPT);
  const filesOmitted = Math.max(0, input.files.length - filesShown.length);
  const filesBlock =
    filesShown.length > 0
      ? `Files changed:\n${filesShown.map((file) => `- ${file}`).join("\n")}${
          filesOmitted > 0 ? `\n(...and ${filesOmitted} more files)` : ""
        }`
      : "Files changed: (none reported)";
  const diffLines = input.diffPreview ? input.diffPreview.split("\n") : [];
  const trimmedDiff =
    diffLines.length > SUBJECT_DIFF_MAX_LINES
      ? `${diffLines.slice(0, SUBJECT_DIFF_MAX_LINES).join("\n")}\n... [diff truncated]`
      : input.diffPreview;
  const diffBlock = trimmedDiff
    ? `Diff (truncated):\n\`\`\`diff\n${trimmedDiff}\n\`\`\``
    : "Diff: (not available)";

  const sections: string[] = [
    "Write a short user-friendly subject for this Stella self-modification commit.",
    "",
    "Output format: a single line of plain text, ≤ 12 words, friendly to a non-developer.",
    "No JSON, no quotes, no markdown, no \"feat:\"/\"fix:\" prefixes, no trailing period.",
    "",
    `Original task: ${input.taskDescription.trim() || "(no task description)"}`,
  ];
  if (input.conversationId) {
    sections.push(`Conversation: ${input.conversationId}`);
  }
  sections.push("", filesBlock, "", diffBlock);
  return sections.join("\n");
};

const SNAPSHOT_DIFF_PREVIEW_LINES = 40;
const SNAPSHOT_MAX_NAME_WORDS = 7;
const SNAPSHOT_MIN_NAME_WORDS = 3;

const sanitizeSnapshotName = (raw: string): string => {
  const cleaned = raw
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/[\r\n].*$/s, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(" ");
  if (words.length > SNAPSHOT_MAX_NAME_WORDS) {
    return words.slice(0, SNAPSHOT_MAX_NAME_WORDS).join(" ");
  }
  if (words.length < SNAPSHOT_MIN_NAME_WORDS) {
    // Below the floor we still accept the name — short is fine, just
    // don't force-pad with filler.
    return cleaned;
  }
  return cleaned;
};

const tryExtractJsonArray = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
};

/**
 * Parse the rolling-window namer's reply into snapshot items. Returns
 * `null` when nothing parseable came back so the caller can leave the
 * existing snapshot in place rather than wiping it with garbage.
 */
export const parseFeatureSnapshotItems = (
  raw: string,
  knownCommitHashes: string[],
): SelfModFeatureSnapshotItem[] | null => {
  const blob = tryExtractJsonArray(raw);
  if (!blob) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const knownSet = new Set(knownCommitHashes);
  const items: SelfModFeatureSnapshotItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const name =
      typeof candidate.name === "string"
        ? sanitizeSnapshotName(candidate.name)
        : "";
    if (!name) continue;
    const commitHashes = Array.isArray(candidate.commitHashes)
      ? candidate.commitHashes
          .filter((hash): hash is string => typeof hash === "string")
          .map((hash) => hash.trim())
          .filter((hash) => hash.length > 0 && knownSet.has(hash))
      : [];
    items.push({ name, commitHashes });
  }
  return items;
};

/**
 * Prompt the rolling-window namer. The model sees the most recent
 * Stella self-mod commits (newest first) and returns a list of
 * normie-friendly named groups. The list replaces the side-panel
 * features wholesale on every successful self-mod commit.
 */
export const buildFeatureSnapshotPrompt = (input: {
  commits: Array<{
    commitHash: string;
    shortHash: string;
    subject: string;
    body: string;
    timestampMs: number;
    files: string[];
  }>;
}): string => {
  const lines = input.commits.map((commit) => {
    const date = new Date(commit.timestampMs).toISOString().slice(0, 10);
    const fileSummary =
      commit.files.length === 0
        ? "no files"
        : commit.files.length === 1
          ? `1 file: ${commit.files[0]}`
          : `${commit.files.length} files: ${commit.files.slice(0, 5).join(", ")}${
              commit.files.length > 5 ? ", …" : ""
            }`;
    const bodyPreview = commit.body
      ? commit.body
          .split("\n")
          .filter((line) => !line.startsWith("Stella-"))
          .slice(0, SNAPSHOT_DIFF_PREVIEW_LINES)
          .join(" ")
          .slice(0, 240)
      : "";
    return [
      `- ${commit.commitHash} (${date}) ${commit.subject}`,
      `    ${fileSummary}`,
      bodyPreview ? `    ${bodyPreview}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    "You are naming the user's recent changes to the Stella app for a side-panel \"features\" list. The user is non-technical: each entry must read like a plain-English name a friend would understand.",
    "",
    "Below are the most recent commits (newest first). Group commits that build the same user-visible thing under one entry; otherwise give each commit its own entry.",
    "",
    "Return ONLY a JSON array. Each item: { \"name\": <3-7 word phrase>, \"commitHashes\": [<full hashes from the list>] }.",
    "- Names: friendly nouns/short phrases, no \"feat:\"/\"fix:\" prefixes, no developer jargon.",
    "- Use only commit hashes from the list below. Do not invent hashes.",
    "- Order: newest activity first.",
    "- No prose, no markdown fence labels — just the JSON array.",
    "",
    "Recent commits:",
    ...lines,
  ].join("\n");
};
