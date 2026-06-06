import { stat } from "node:fs/promises";

/**
 * Cheap change-detection signature for a single file: `<mtimeMs>:<size>`.
 *
 * Used to gate per-turn re-reads of user-editable files (agent prompts, skill
 * docs) so the runtime picks up edits live without re-reading + re-parsing
 * unchanged files every turn. `mtimeMs` alone can collide on sub-millisecond
 * rewrites, so `size` is folded in as a cheap tiebreaker.
 *
 * Returns `null` when the file is missing or unreadable.
 */
export const statSignature = async (path: string): Promise<string | null> => {
  try {
    const s = await stat(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
};
