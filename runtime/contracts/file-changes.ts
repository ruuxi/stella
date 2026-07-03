/**
 * Shared contract for normalized per-tool file mutations.
 *
 * Normalized shape for per-tool `fileChange` items
 * (`{ path, kind: { type: 'add' | 'update' | 'delete', move_path? } }`).
 *
 * Tools that explicitly edit the filesystem populate the optional
 * `fileChanges` field on their `ToolResult`. Shell-like tools that detect
 * user-facing output files indirectly populate `producedFiles` instead.
 * The runtime worker hoists both records into the persisted `tool_result`
 * event payload, and the chat surface walks them to build resource cards
 * without having to know which specific tool produced the change.
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
   * resource picking.
   */
  | { type: "update"; move_path?: string };

export type FileChangeRecord = {
  /** Absolute filesystem path the tool touched. */
  path: string;
  kind: FileChangeKind;
};

/**
 * User-facing output detected from a tool/run side effect. This deliberately
 * stays separate from explicit `fileChanges`: a shell command that writes
 * `deck.pptx` did not emit an explicit fileChange item, but Stella should
 * still surface the produced file to the user.
 */
export type ProducedFileRecord = FileChangeRecord;

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

export const isProducedFileRecordArray = (
  value: unknown,
): value is ProducedFileRecord[] =>
  Array.isArray(value) && value.every(isFileChangeRecord);

/**
 * Convenience factory used by file-mutating tool handlers — keeps the
 * call sites readable and lets us evolve the contract in one place.
 */
export const fileChange = (
  path: string,
  kind: FileChangeKind,
): FileChangeRecord => ({ path, kind });

const NOISE_PATH_SEGMENTS = new Set(["node_modules", "__pycache__"]);
const NOISE_EXTS = new Set(["log", "tmp", "lock", "pid"]);

const extensionOfPath = (filePath: string): string | null => {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
};

/**
 * Snapshot-detected `producedFiles` sweep up incidental writes alongside real
 * deliverables: browser profiles (`.brave-profile/Local State`), launch logs
 * (`.stella-launch.log`), caches, `.DS_Store`, scratch dirs. Filter those out
 * of every produced-file surface — BOTH at collection time (shell snapshot
 * diffs, so junk never persists into `tool_result` / rollup payloads) and on
 * render (legacy rows persisted before collection-side filtering existed).
 * Explicit `fileChanges` (deliberate tool edits) are NOT run through this —
 * only indirect snapshot detections.
 *
 * A dot-segment means a hidden/profile/cache dir and is always noise, with
 * one carve-out: `.stella` itself, since `~/.stella/outputs/**` is the
 * declared deliverables home.
 *
 * Lives in the shared contract so the runtime collector and the renderer
 * surfaces apply ONE definition of noise (previously renderer-only in
 * `path-to-viewer.ts`).
 */
export const isNoiseProducedPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (!trimmed) return true;
  for (const segment of trimmed.split(/[\\/]/)) {
    if (!segment) continue;
    if (segment.startsWith(".") && segment !== ".stella") return true;
    if (NOISE_PATH_SEGMENTS.has(segment)) return true;
  }
  const ext = extensionOfPath(trimmed);
  return ext != null && NOISE_EXTS.has(ext);
};

/**
 * Bulk-churn guard for snapshot-detected produced files. A single shell
 * command that deliberately produces user-facing output yields a handful of
 * files; a diff that reports MORE than this many (after noise filtering) is
 * overwhelmingly environment churn — a spawned dev instance seeding its data
 * dir on first launch, `git checkout`/worktree sync rewriting tracked files'
 * mtimes, dependency installs, build pipelines copying trees. Observed in
 * production as 90–2000-record `producedFiles` floods attributing bundled
 * agent/skill manifests to an agent that never touched them. When a batch
 * exceeds the cap the whole batch is dropped: there is no per-path signal
 * that separates "the three files the user asked for" from the churn around
 * them, and the agent's own deliberate writes (Write / Edit / apply_patch /
 * `html`) still arrive via explicit `fileChanges`, which this cap never
 * touches.
 */
export const MAX_PRODUCED_FILES_PER_COMMAND = 12;
