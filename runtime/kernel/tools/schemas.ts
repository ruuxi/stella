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

export const DEVICE_TOOL_NAMES = ["RequestCredential"] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const DANGEROUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  // Catastrophic filesystem / host controls.
  {
    pattern: /\brm\s+(-[^\s]*\s+)*(\/|\/\*|\/ \*)(\s|$)/i,
    reason: "recursive delete of root filesystem",
  },
  {
    pattern:
      /\brm\s+(-[^\s]*\s+)*(\/home|\/home\/\*|\/root|\/root\/\*|\/etc|\/etc\/\*|\/usr|\/usr\/\*|\/var|\/var\/\*|\/bin|\/bin\/\*|\/sbin|\/sbin\/\*|\/boot|\/boot\/\*|\/lib|\/lib\/\*)(\s|$)/i,
    reason: "recursive delete of system directory",
  },
  {
    pattern: /\brm\s+(-[^\s]*\s+)*(~|\$HOME)(\/?|\/\*)?(\s|$)/i,
    reason: "recursive delete of home directory",
  },
  { pattern: /\bformat\s+[a-zA-Z]:\s*/i, reason: "format drive" },
  { pattern: /\bmkfs\b/i, reason: "mkfs (format filesystem)" },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/i,
    reason: "dd to raw block device",
  },
  {
    pattern: />\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i,
    reason: "redirect to raw block device",
  },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, reason: "fork bomb" },
  { pattern: /\bkill\s+(-[^\s]+\s+)*-1\b/i, reason: "kill all processes" },
  {
    pattern:
      /(?:^|[;&|\n`]|\$\()\s*(?:sudo\s+(?:-[^\s]+\s+)*)?(?:env\s+(?:\w+=\S*\s+)*)?(?:(?:exec|nohup|setsid|time)\s+)*(shutdown|reboot|halt|poweroff)\b/i,
    reason: "system shutdown/reboot",
  },
  {
    pattern:
      /(?:^|[;&|\n`]|\$\()\s*(?:sudo\s+(?:-[^\s]+\s+)*)?(?:env\s+(?:\w+=\S*\s+)*)?(?:(?:exec|nohup|setsid|time)\s+)*systemctl\s+(poweroff|reboot|halt|kexec)\b/i,
    reason: "systemctl poweroff/reboot",
  },

  // High-confidence destructive or exfil-prone commands. Stella has no
  // default manual approval flow, so these deny instead of prompting.
  {
    pattern: /\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/i,
    reason: "world/other-writable permissions",
  },
  {
    pattern: /\bchown\s+(-[^\s]*)?R\s+root/i,
    reason: "recursive chown to root",
  },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, reason: "SQL DROP" },
  {
    pattern: /\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/i,
    reason: "SQL DELETE without WHERE",
  },
  { pattern: /\bTRUNCATE\s+(TABLE)?\s*\w/i, reason: "SQL TRUNCATE" },
  {
    pattern: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
    reason: "pipe remote content to shell",
  },
  {
    pattern: /\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b/i,
    reason: "execute remote script via process substitution",
  },
  {
    pattern: /\bsudo\b[^;|&\n]*?\s+(?:-S\b|--stdin\b|-A\b|--askpass\b|-s\b)/i,
    reason: "sudo with stdin/askpass/shell flag",
  },
  {
    pattern:
      /\btee\b.*["']?(?:\/etc\/|\/private\/etc\/|~\/\.ssh\/|\$HOME\/\.ssh\/|~\/\.stella\/\.env|\$HOME\/\.stella\/\.env|\.env\b)/i,
    reason: "overwrite sensitive credential or system file via tee",
  },
  {
    pattern:
      />>?\s*["']?(?:\/etc\/|\/private\/etc\/|~\/\.ssh\/|\$HOME\/\.ssh\/|~\/\.stella\/\.env|\$HOME\/\.stella\/\.env|\.env\b)/i,
    reason: "overwrite sensitive credential or system file via redirection",
  },
  { pattern: /\bxargs\s+.*\brm\b/i, reason: "xargs with rm" },
  {
    pattern: /\bfind\b.*-exec(?:dir)?\s+(\/\S*\/)?rm\b/i,
    reason: "find -exec/-execdir rm",
  },
  { pattern: /\bfind\b.*-delete\b/i, reason: "find -delete" },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "git reset --hard (destroys uncommitted changes)",
  },
  {
    pattern: /\bgit\s+push\b.*(?:--force|-f)\b/i,
    reason: "git force push (rewrites remote history)",
  },
  {
    pattern: /\bgit\s+clean\s+-[^\s]*f/i,
    reason: "git clean with force (deletes untracked files)",
  },
  {
    pattern: /\b(pkill|killall)\b.*\b(stella|electron)\b/i,
    reason: "kill Stella/runtime process",
  },
  {
    pattern: /\bkill\b.*(?:\$\(\s*pgrep\b|`\s*pgrep\b)/i,
    reason: "kill process via pgrep expansion",
  },
];

export function getDangerousCommandReason(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}
