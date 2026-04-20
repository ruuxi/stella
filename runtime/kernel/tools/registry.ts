/**
 * Top-level handler registry for the device tool surface.
 *
 * Codex-style code mode: only `Exec`, `Wait`, `AskUserQuestion`, and
 * `RequestCredential` are model-facing. Internal subagents (`Explore`)
 * additionally call `Read` / `Grep` directly through `executeTool`, so we
 * keep narrow handlers for those.
 *
 * Everything else (file edits, shell, browser, office, web,
 * display, scheduling, tasks, memory) lives inside the `ExecToolRegistry`
 * and is reachable via `tools.<name>(...)` from inside an `Exec` program.
 */

import type { ToolHandler } from "./types.js";
import { handleRead } from "./file.js";
import { handleGrep } from "./search.js";
import {
  handleAskUser,
  handleRequestCredential,
  type UserToolsConfig,
} from "./user.js";
import type { ToolDefinition } from "../extensions/types.js";

export const mergeToolHandlers = (
  ...groups: Array<Record<string, ToolHandler>>
): Record<string, ToolHandler> => Object.assign({}, ...groups);

export const createUserToolHandlers = (
  userConfig: UserToolsConfig,
): Record<string, ToolHandler> => ({
  AskUserQuestion: (args, _context) => handleAskUser(args),
  RequestCredential: (args, _context) =>
    handleRequestCredential(userConfig, args),
});

/**
 * Internal-only handlers used by the Explore subagent. These are not part of
 * the model-facing tool catalog; they're reachable via `executeTool` only.
 */
export const createInternalExploreHandlers = (): Record<string, ToolHandler> => ({
  Read: (args, context) => handleRead(args, context),
  Grep: (args, context) => handleGrep(args, context),
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
