import path from "node:path";

import type { ToolResult } from "../tools/types.js";

export const MANAGER_OWNED_SELF_MOD_ERROR_CODE =
  "MANAGER_OWNED_SELF_MOD_UNSUPPORTED" as const;

export const MANAGER_OWNED_SELF_MOD_ERROR_MESSAGE =
  "Stella self-modifying work is not supported for manager-owned children. Spawn this work directly from the orchestrator, not under a manager.";

/**
 * Structural policy error raised before an unmediated engine or self-mod
 * lifecycle can acquire Stella mutation ownership for a managed child.
 */
export class ManagerOwnedSelfModError extends Error {
  readonly code = MANAGER_OWNED_SELF_MOD_ERROR_CODE;

  constructor() {
    super(MANAGER_OWNED_SELF_MOD_ERROR_MESSAGE);
    this.name = "ManagerOwnedSelfModError";
  }
}

export const managerOwnedSelfModToolError = (): ToolResult => ({
  error: MANAGER_OWNED_SELF_MOD_ERROR_MESSAGE,
  details: { code: MANAGER_OWNED_SELF_MOD_ERROR_CODE },
});

export const isPathInsideStella = (
  candidatePath: string,
  stellaAppDir: string | undefined,
): boolean => {
  const root = stellaAppDir?.trim();
  if (!root) return false;
  const relative = path.relative(
    path.resolve(root),
    path.resolve(candidatePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
