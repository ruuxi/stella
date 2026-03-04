/**
 * Compute a user-friendly status message based on tool name or activity type.
 * Ported from Aura's computeStatusFromPart function.
 */
export function computeStatus(options?: {
  toolName?: string;
  isReasoning?: boolean;
  isResponding?: boolean;
}): string {
  if (!options) return "Considering next steps";

  const { toolName, isReasoning, isResponding } = options;

  if (toolName) {
    switch (toolName.toLowerCase()) {
      case "todowrite":
      case "todoread":
        return "Planning next steps";
      case "read":
        return "Gathering context";
      case "list":
      case "grep":
      case "glob":
        return "Searching the codebase";
      case "webfetch":
        return "Searching the web";
      case "edit":
      case "write":
        return "Making edits";
      case "bash":
        return "Running commands";
      default:
        return `Using ${toolName}`;
    }
  }

  if (isReasoning) return "Thinking";
  if (isResponding) return "Responding";

  return "Considering next steps";
}
