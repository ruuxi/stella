/**
 * Residual handler factories.
 *
 * Stella's tool surface is defined by self-contained `ToolDefinition`s under
 * `runtime/kernel/tools/defs/` — one tool per file, each owning its own
 * name + description + parameters + handler. The host imports them through
 * `defs/index.ts::buildBuiltinTools` and routes calls directly.
 *
 * What's left here:
 *   - `mergeToolHandlers`: small utility used by the host
 *   - `createShellToolHandlers`: legacy companions to `exec_command` /
 *     `write_stdin` (Bash / ShellStatus / KillShell). Reachable only via
 *     direct `executeTool` calls from non-model code paths; not exposed in
 *     the model-facing catalog.
 *   - `registerExtensionToolHandlers`: helper that lets the host map
 *     runtime-injected ToolDefinitions onto the same handler map.
 */

import {
  handleBash,
  handleKillShell,
  handleShellStatus,
  type ShellState,
} from "./shell.js";
import type { ToolHandler } from "./types.js";
import type { ToolDefinition } from "../extensions/types.js";

export const mergeToolHandlers = (
  ...groups: Array<Record<string, ToolHandler>>
): Record<string, ToolHandler> => Object.assign({}, ...groups);

// Bash / ShellStatus / KillShell remain here; exec_command and write_stdin
// live in defs/exec-command.ts and defs/write-stdin.ts now.
export const createShellToolHandlers = (
  shellState: ShellState,
): Record<string, ToolHandler> => ({
  Bash: (args, context, extras) =>
    handleBash(shellState, args, context, extras?.signal),
  ShellStatus: (args) => handleShellStatus(shellState, args),
  KillShell: (args) => handleKillShell(shellState, args),
});

export const registerExtensionToolHandlers = (
  handlers: Record<string, ToolHandler>,
  extensionTools?: ToolDefinition[],
): void => {
  if (!extensionTools) return;
  for (const tool of extensionTools) {
    handlers[tool.name] = (args, context) => tool.execute(args, context);
  }
};
