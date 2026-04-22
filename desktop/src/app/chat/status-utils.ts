/**
 * Compute a user-friendly status message based on tool name or activity type.
 * Ported from Aura's computeStatusFromPart function.
 */
const TOOL_STATUS_BY_NAME: Record<string, string> = {
  todowrite: "Planning next steps",
  todoread: "Planning next steps",
  read: "Gathering context",
  list: "Searching the codebase",
  grep: "Searching the codebase",
  glob: "Searching the codebase",
  executetypescript: "Running code mode",
  webfetch: "Searching the web",
  web: "Searching the web",
  edit: "Making edits",
  write: "Making edits",
  bash: "Running commands",
  askquestion: "Preparing Questions",
};

export function computeStatus({
  toolName,
  isReasoning,
  isResponding,
}: {
  toolName?: string;
  isReasoning?: boolean;
  isResponding?: boolean;
} = {}): string {
  if (toolName) {
    const normalizedToolName = toolName.toLowerCase();
    return TOOL_STATUS_BY_NAME[normalizedToolName] ?? `Using ${toolName}`;
  }

  if (isReasoning) return "Thinking";
  if (isResponding) return "Responding";

  return "Considering next steps";
}
