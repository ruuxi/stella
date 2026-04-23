/**
 * Shared contract for normalized per-tool file mutations.
 *
 * Mirrors the shape Codex's runtime emits on its `fileChange` items
 * (`{ path, kind: { type: 'add' | 'update' | 'delete', move_path? } }`).
 *
 * Tools that touch the filesystem populate the optional `fileChanges`
 * field on their `ToolResult`. The runtime worker hoists those records
 * into the persisted `tool_result` event payload, and the chat surface
 * walks the records to build a per-turn `editedFilePaths` list — without
 * having to know which specific tool produced the change.
 *
 * This decouples the artifact-derivation logic on the client from the
 * tool catalog: any new tool that mutates a file just emits structured
 * `fileChanges` and the resource pill / sidebar tab pick it up
 * automatically.
 */

export type FileChangeKind =
  | { type: "add" }
  | { type: "delete" }
  /**
   * `move_path` is set when the update also renames / moves the file. The
   * client treats `move_path` as the canonical post-change location for
   * resource picking, exactly like Codex's `vde` heuristic does.
   */
  | { type: "update"; move_path?: string };

export type FileChangeRecord = {
  /** Absolute filesystem path the tool touched. */
  path: string;
  kind: FileChangeKind;
};

const isFileChangeKind = (value: unknown): value is FileChangeKind => {
  if (!value || typeof value !== "object") return false;
  const kind = value as { type?: unknown; move_path?: unknown };
  if (kind.type === "add" || kind.type === "delete") return true;
  if (kind.type !== "update") return false;
  if (kind.move_path === undefined) return true;
  return typeof kind.move_path === "string" && kind.move_path.trim().length > 0;
};

export const isFileChangeRecord = (value: unknown): value is FileChangeRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as { path?: unknown; kind?: unknown };
  return (
    typeof record.path === "string" &&
    record.path.trim().length > 0 &&
    isFileChangeKind(record.kind)
  );
};

export const isFileChangeRecordArray = (
  value: unknown,
): value is FileChangeRecord[] =>
  Array.isArray(value) && value.every(isFileChangeRecord);

/**
 * Convenience factory used by file-mutating tool handlers — keeps the
 * call sites readable and lets us evolve the contract in one place.
 */
export const fileChange = (
  path: string,
  kind: FileChangeKind,
): FileChangeRecord => ({ path, kind });
