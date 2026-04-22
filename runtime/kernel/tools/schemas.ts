/**
 * Shared shell-safety patterns + device tool name constants.
 *
 * Stella's tool surface lives entirely in `runtime/kernel/tools/defs/` —
 * one self-contained `ToolDefinition` per tool, owning its own name,
 * description, JSON schema, and handler. The host imports them through
 * `defs/index.ts::buildBuiltinTools`.
 *
 * What remains in this file:
 *   - `DEVICE_TOOL_NAMES`: tools the agent runtime treats as device-local.
 *   - `DANGEROUS_COMMAND_PATTERNS` + `getDangerousCommandReason`: the safety
 *     filter consumed by `exec_command` and other shell paths.
 */

export const DEVICE_TOOL_NAMES = [
  "AskUserQuestion",
  "RequestCredential",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const DANGEROUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i,
    reason: "rm -rf /",
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(?:\s|$|;|\|)/i,
    reason: "rm -rf /",
  },
  {
    pattern:
      /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i,
    reason: "rm -rf ~",
  },
  {
    pattern:
      /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+~\s*(?:\/\s*)?(?:\s|$|;|\|)/i,
    reason: "rm -rf ~",
  },
  { pattern: /\bformat\s+[a-zA-Z]:\s*/i, reason: "format drive" },
  { pattern: /\bdd\s+if=/i, reason: "dd if= (raw disk write)" },
  { pattern: /\bmkfs\b/i, reason: "mkfs (format filesystem)" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, reason: "fork bomb" },
  { pattern: /\bshutdown\b/i, reason: "shutdown" },
  { pattern: /\breboot\b/i, reason: "reboot" },
];

export function getDangerousCommandReason(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}
