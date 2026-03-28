const LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE =
  /\[Tool (?:call|result)\]\s*Task(?:Create|Update|Cancel|Output)\b/;

export const containsLeakedInternalToolTranscript = (text: string): boolean =>
  LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.test(text);

export const stripLeakedInternalToolTranscript = (text: string): string => {
  const match = LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.exec(text);
  if (!match || match.index < 0) {
    return text;
  }
  return text.slice(0, match.index).trimEnd();
};
