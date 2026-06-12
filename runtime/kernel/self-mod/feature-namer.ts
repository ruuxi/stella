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
