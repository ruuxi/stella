import crypto from "crypto";

function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, Object.keys(args).sort());
}

export function hashToolArgs(args: Record<string, unknown>): string {
  const canonical = canonicalizeArgs(args);
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function generateDeterministicToolCallId(
  runId: string,
  turnIndex: number,
  toolName: string,
  args: Record<string, unknown>,
  ordinal: number,
): string {
  const argsHash = hashToolArgs(args);
  return `${runId}:${turnIndex}:${toolName}:${argsHash}:${ordinal}`;
}

export function extractToolNameFromCallId(toolCallId: string): string {
  const parts = toolCallId.split(":");
  if (parts.length < 4) {
    return "Tool";
  }
  return parts[parts.length - 3] ?? "Tool";
}
