const INTERNAL_TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskCancel",
  "TaskOutput",
]);

const LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE =
  /\[Tool (?:call|result)\]\s*Task(?:Create|Update|Cancel|Output)\b/;

export const containsLeakedInternalToolTranscript = (text: string): boolean =>
  LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.test(text);

export const isInternalTaskToolName = (toolName: string): boolean =>
  INTERNAL_TASK_TOOL_NAMES.has(toolName);

export const stripLeakedInternalToolTranscript = (text: string): string => {
  const match = LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.exec(text);
  if (!match || match.index < 0) {
    return text;
  }
  return text.slice(0, match.index).trimEnd();
};

export const sanitizeAssistantText = (text: string): string =>
  stripLeakedInternalToolTranscript(text).trim();
