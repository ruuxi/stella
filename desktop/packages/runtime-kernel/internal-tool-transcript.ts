const INTERNAL_TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskCancel",
  "TaskOutput",
]);

const LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE =
  /\[Tool (?:call|result)\]\s*Task(?:Create|Update|Cancel|Output)\b/;
const ASSISTANT_PREFIX_RE = /^\[Assistant\]\s*/i;
const INTERNAL_TRANSCRIPT_LINE_RE =
  /^\[(?:Assistant thinking|Assistant tool calls|Tool call|Tool result)\]/i;
const INTERNAL_TOOL_DETAIL_LINE_RE = /^(?:args|content|error):\s*/i;
const UI_ONLY_ASSISTANT_STATUS_RE =
  /^\[(?:TOOL CALL:\s*[^\]]+|WEB SEARCH|ORCHESTRATOR RESULT)\]/i;

export const containsLeakedInternalToolTranscript = (text: string): boolean =>
  LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.test(text) ||
  INTERNAL_TRANSCRIPT_LINE_RE.test(text) ||
  UI_ONLY_ASSISTANT_STATUS_RE.test(text.trim());

export const isInternalTaskToolName = (toolName: string): boolean =>
  INTERNAL_TASK_TOOL_NAMES.has(toolName);

export const stripLeakedInternalToolTranscript = (text: string): string => {
  const match = LEAKED_INTERNAL_TOOL_TRANSCRIPT_RE.exec(text);
  const source = match && match.index >= 0 ? text.slice(0, match.index) : text;
  const lines = source.split(/\r?\n/);
  const cleaned: string[] = [];
  let skippingToolDetails = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      skippingToolDetails = false;
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== "") {
        cleaned.push("");
      }
      continue;
    }

    if (INTERNAL_TRANSCRIPT_LINE_RE.test(trimmed)) {
      skippingToolDetails = /^\[(?:Tool call|Tool result)\]/i.test(trimmed);
      continue;
    }
    if (skippingToolDetails && INTERNAL_TOOL_DETAIL_LINE_RE.test(trimmed)) {
      continue;
    }

    skippingToolDetails = false;
    cleaned.push(line.replace(ASSISTANT_PREFIX_RE, ""));
  }

  while (cleaned[0] === "") {
    cleaned.shift();
  }
  while (cleaned[cleaned.length - 1] === "") {
    cleaned.pop();
  }

  return cleaned.join("\n").trim();
};

export const sanitizeAssistantText = (text: string): string =>
  stripLeakedInternalToolTranscript(text).trim();

export const isUiOnlyAssistantStatus = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (UI_ONLY_ASSISTANT_STATUS_RE.test(trimmed)) {
    return true;
  }
  return INTERNAL_TRANSCRIPT_LINE_RE.test(trimmed) && sanitizeAssistantText(trimmed).length === 0;
};
