import type { DisplayPayload } from "../../src/shared/contracts/display-payload.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "../../../runtime/contracts/file-changes.js";
import { isUiHiddenChatMessagePayload } from "../../../runtime/chat-event-visibility.js";
import {
  isMapRouteArtifact,
  type MapRouteArtifact,
} from "../../../runtime/contracts/map-artifact.js";

/**
 * Inline "background work" card for the mobile chat — the companion to the
 * desktop's inline agent card. Derived from the turn's `agent-started`
 * lifecycle events; `done` once every covered thread has an `agent-completed`
 * at/after its spawn (or has been silent past the stale cutoff). This is a
 * mobile-bridge-only payload, intentionally NOT part of the shared
 * `DisplayPayload` contract (which doubles as the desktop workspace-panel tab
 * contract — this card isn't an openable tab).
 */
export type MobileAgentWorkPayload = {
  kind: "agent-work";
  state: "running" | "done";
  /** Spawn-order membership, used to reconcile aggregate identity as siblings
   * are discovered. Older mobile clients safely ignore this additive field. */
  agentIds: string[];
  /** Number of background threads this card covers. */
  total: number;
  completed: number;
  /** Title line (a single task's description, or "Working on N tasks"). */
  title: string;
  /** Status line ("Working in background" / "N of M done" / "Finished"). */
  subtitle: string;
  createdAt: number;
  /**
   * Per-agent produced-file sections — the mobile analogue of the desktop
   * `AgentCompletionCard`. Each covered agent's `agent-completed` rollup
   * files (deduped by path, noise-filtered, deliverables first) ride the
   * card so mobile folds them into the lifecycle card with per-agent
   * attribution instead of loose file rows. A section only exists once its
   * agent actually completed, so files reveal at completion by construction.
   *
   * Always present (possibly empty) on bridges that consolidate: its
   * presence tells mobile that any loose file artifacts remaining on the
   * row are orchestrator-direct and safe to render standalone. Older mobile
   * clients ignore the extra field.
   */
  agents?: MobileAgentWorkFileSection[];
};

/** One agent's completion files on the mobile agent-work card. */
export type MobileAgentWorkFileSection = {
  agentId: string;
  /** Section header — the agent's task description (or group label). */
  title: string;
  /** Display payloads for the files this agent's completion(s) revealed. */
  files: DisplayPayload[];
};

/**
 * What the mobile sync transport can carry inline under a message. Besides
 * the shared display payloads this includes the bridge-only agent-work card
 * and the `map-route` artifact (rendered on mobile as an inline map card via
 * the hosted stella.sh embed).
 */
export type MobileSyncArtifact =
  | DisplayPayload
  | MobileAgentWorkPayload
  | MapRouteArtifact;
export type MobileSyncArtifactEntry =
  | MobileSyncArtifact
  | { id: string; payload: MobileSyncArtifact };

/**
 * One settled tool call, projected for the mobile inline tool-activity trace.
 * The desktop renders the same run via `deriveToolActivity`; mobile reruns the
 * (pure) phrasing on these steps. Only the handful of arg keys the per-call
 * title needs are carried — never raw tool args (which can hold file contents).
 */
export type MobileToolStep = {
  id: string;
  toolName: string;
  status: "completed" | "error";
  /** Pruned string args used only to build the per-call title (path, query…). */
  args?: Record<string, string>;
};

/**
 * One background task (spawned agent) for the mobile activity pill + tray.
 * Folded from the same `agent-*` lifecycle events the inline agent card reads;
 * carried on the message that spawned it and collected conversation-wide on
 * mobile. The desktop equivalent is the footer/tray `TaskItem`.
 */
export type MobileTask = {
  id: string;
  title: string;
  status: "running" | "completed" | "error" | "canceled";
  /** Live narration while running ("Reading file…"). */
  statusText?: string;
  createdAt: number;
  completedAt?: number;
  /** Recent bounded, current-attempt agent-authored messages. */
  assistantMessages: string[];
  /** Legacy mobile wire alias. Always present so an empty array clears any
   * stale generated summaries cached by an older client. */
  reasoningSummaries: string[];
};

export type LocalChatSyncMessageWithArtifacts = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  requestId?: string;
  deviceId?: string;
  artifacts?: MobileSyncArtifactEntry[];
  /** Settled tool calls for this turn, oldest first (assistant rows only). */
  toolSteps?: MobileToolStep[];
  /** Background tasks spawned by this turn (collected into the activity tray). */
  tasks?: MobileTask[];
};

export type LocalChatMobileSyncCursor = {
  timestamp: number;
  id: string;
};

export type LocalChatMobileSyncResult = {
  messages: LocalChatSyncMessageWithArtifacts[];
  cursor: string | null;
};

type MobileArtifactOptions = {
  includeDeveloperArtifacts?: boolean;
};

const ARTIFACT_LIMIT_PER_MESSAGE = 8;
const SYNC_CURSOR_VERSION = "v1";

type ArtifactEventRecord = {
  _id?: string;
  timestamp: number;
  type: string;
  payload?: Record<string, unknown>;
};

type ArtifactMessageRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  toolEvents: readonly ArtifactEventRecord[];
};

type ArtifactSourceRecord = {
  _id: string;
  timestamp: number;
  toolEvents?: readonly ArtifactEventRecord[];
};

export const encodeMobileSyncCursor = (
  cursor: LocalChatMobileSyncCursor,
): string => {
  const timestamp = Math.floor(cursor.timestamp);
  if (!Number.isFinite(timestamp) || !cursor.id.trim()) return "";
  return `${SYNC_CURSOR_VERSION}:${timestamp}:${encodeURIComponent(cursor.id)}`;
};

export const decodeMobileSyncCursor = (
  cursor: string | null | undefined,
): LocalChatMobileSyncCursor | null => {
  const raw = typeof cursor === "string" ? cursor.trim() : "";
  if (!raw) return null;
  const prefix = `${SYNC_CURSOR_VERSION}:`;
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const timestamp = Number.parseInt(rest.slice(0, separator), 10);
  if (!Number.isFinite(timestamp)) return null;
  try {
    const id = decodeURIComponent(rest.slice(separator + 1)).trim();
    return id ? { timestamp, id } : null;
  } catch {
    return null;
  }
};

const considerNewestSource = (
  current: LocalChatMobileSyncCursor | null,
  candidate: LocalChatMobileSyncCursor,
): LocalChatMobileSyncCursor =>
  !current ||
  candidate.timestamp > current.timestamp ||
  (candidate.timestamp === current.timestamp && candidate.id > current.id)
    ? candidate
    : current;

const cursorForNewestSourceRecord = (
  records: readonly ArtifactSourceRecord[],
): string | null => {
  let newest: LocalChatMobileSyncCursor | null = null;
  for (const record of records) {
    newest = considerNewestSource(newest, {
      timestamp: record.timestamp,
      id: record._id,
    });
    for (const event of record.toolEvents ?? []) {
      if (!event._id) continue;
      newest = considerNewestSource(newest, {
        timestamp: event.timestamp,
        id: event._id,
      });
    }
  }
  return newest ? encodeMobileSyncCursor(newest) : null;
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "gif",
  "bmp",
  "svg",
  "ico",
  "tif",
  "tiff",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const MODEL3D_EXTS = new Set(["glb", "gltf", "obj", "stl"]);
const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const PDF_EXTS = new Set(["pdf"]);
const OFFICE_DOC_EXTS = new Set(["doc", "docx"]);
const OFFICE_SHEET_EXTS = new Set(["xlsx", "xlsm"]);
const OFFICE_SLIDES_EXTS = new Set(["ppt", "pptx"]);
const DELIMITED_TABLE_EXTS = new Set(["csv", "tsv"]);
const DEVELOPER_EXTS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

// Any `.html` under the declared outputs tree crosses as a canvas artifact
// (canvases in `outputs/html/`, but also reports written straight into
// `outputs/`) — mirrors the renderer's `HTML_OUTPUT_PATH_RE` widening in
// `derive-turn-resource.ts`.
const HTML_OUTPUT_PATH_RE =
  /(?:^|\/)(?:\.stella|state)\/outputs\/(?:.+\/)?([^/]+)\.html$/;

/** Declared deliverables home. Mirrors `path-to-viewer.ts`
 *  `DECLARED_OUTPUTS_RE` (duplicated: that renderer module resolves imports
 *  through the `@/` alias, which the electron main build doesn't). */
const DECLARED_OUTPUTS_RE = /(?:^|[\\/])(?:\.stella|state)[\\/]outputs[\\/]/;

const isDeclaredOutputPath = (filePath: string): boolean =>
  DECLARED_OUTPUTS_RE.test(filePath);

const NOISE_PATH_SEGMENTS = new Set(["node_modules", "__pycache__"]);
const NOISE_EXTS = new Set(["log", "tmp", "lock", "pid"]);

/**
 * Snapshot-detected `producedFiles` sweep up incidental writes (browser
 * profiles, launch logs, caches, scratch dirs) alongside real deliverables;
 * keep them off every mobile artifact surface. Explicit `fileChanges`
 * (deliberate tool edits) are NOT run through this — only indirect snapshot
 * detections. Mirrors `path-to-viewer.ts` `isNoiseProducedPath`.
 */
const isNoiseProducedPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (!trimmed) return true;
  for (const segment of trimmed.split(/[\\/]/)) {
    if (!segment) continue;
    if (segment.startsWith(".") && segment !== ".stella") return true;
    if (NOISE_PATH_SEGMENTS.has(segment)) return true;
  }
  const ext = extensionOf(trimmed);
  return ext != null && NOISE_EXTS.has(ext);
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const textFromPayload = (payload?: Record<string, unknown>): string => {
  const text = payload?.contextText ?? payload?.text;
  return typeof text === "string" ? text.trim() : "";
};

const extensionOf = (filePath: string): string | null => {
  const cleaned = filePath.trim().split(/[?#]/)[0] ?? filePath.trim();
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const tail = slash === -1 ? cleaned : cleaned.slice(slash + 1);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot === tail.length - 1) return null;
  return tail.slice(dot + 1).toLowerCase();
};

const basenameOf = (filePath: string): string => {
  const cleaned = filePath.trim().split(/[?#]/)[0] ?? filePath.trim();
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
};

const titleFromHtmlSlug = (slug: string): string => {
  const title = slug
    .trim()
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
  return title || "Canvas";
};

const resolveFileChange = (
  record: FileChangeRecord,
  timestamp: number,
): { filePath: string; timestamp: number } | null => {
  if (record.kind.type === "delete") return null;
  const filePath =
    record.kind.type === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  const trimmed = asNonEmptyString(filePath);
  return trimmed ? { filePath: trimmed, timestamp } : null;
};

/**
 * A `tool_result` stamped with a non-orchestrator `agentType` is a delegated
 * agent's mid-run write forwarded into the conversation stream — it
 * contributes nothing loose (its files arrive consolidated on the run's
 * `agent-completed` rollup instead). Missing `agentType` (legacy persisted
 * events, always orchestrator-direct) keeps rendering inline. Mirrors the
 * renderer gate in `derive-turn-resource.ts` (`de4bd52c1`).
 */
const isDelegatedToolResult = (event: ArtifactEventRecord): boolean => {
  if (event.type !== "tool_result") return false;
  const agentType = asNonEmptyString(event.payload?.agentType);
  return agentType != null && agentType !== "orchestrator";
};

const artifactKey = (payload: DisplayPayload): string => {
  switch (payload.kind) {
    case "canvas-html":
      return `canvas:${payload.filePath}`;
    case "url":
      return `url:${payload.tabId}:${payload.url}`;
    case "office":
      return `office:${payload.previewRef.sourcePath}`;
    case "markdown":
    case "source-diff":
    case "file-artifact":
    case "pdf":
      return `${payload.kind}:${payload.filePath}`;
    case "trash":
      return `trash:${payload.createdAt ?? ""}`;
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return `image:${payload.asset.filePaths.join("|")}`;
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return `${payload.asset.kind}:${payload.asset.filePath}`;
        case "text":
          return `text:${payload.createdAt}:${payload.asset.text}`;
      }
  }
};

const pushArtifact = (
  artifacts: MobileSyncArtifact[],
  seen: Set<string>,
  payload: DisplayPayload | null,
) => {
  if (!payload) return;
  const key = artifactKey(payload);
  if (seen.has(key)) return;
  seen.add(key);
  artifacts.push(payload);
};

const payloadFromFilePath = (
  filePath: string,
  createdAt: number,
  options?: MobileArtifactOptions,
): DisplayPayload | null => {
  const htmlMatch = HTML_OUTPUT_PATH_RE.exec(filePath);
  if (htmlMatch) {
    const slug = htmlMatch[1]!;
    return {
      kind: "canvas-html",
      filePath,
      title: titleFromHtmlSlug(slug),
      slug,
      createdAt,
    };
  }

  const ext = extensionOf(filePath);
  if (!ext) return null;
  if (MARKDOWN_EXTS.has(ext)) {
    return {
      kind: "markdown",
      filePath,
      title: basenameOf(filePath),
      createdAt,
    };
  }
  if (PDF_EXTS.has(ext)) {
    return { kind: "pdf", filePath, title: basenameOf(filePath) };
  }
  if (IMAGE_EXTS.has(ext)) {
    return {
      kind: "media",
      asset: { kind: "image", filePaths: [filePath] },
      createdAt,
    };
  }
  if (VIDEO_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "video", filePath }, createdAt };
  }
  if (AUDIO_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "audio", filePath }, createdAt };
  }
  if (MODEL3D_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "model3d", filePath }, createdAt };
  }
  if (OFFICE_DOC_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-document",
      title: basenameOf(filePath),
      createdAt,
    };
  }
  if (OFFICE_SHEET_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-spreadsheet",
      title: basenameOf(filePath),
      createdAt,
    };
  }
  if (OFFICE_SLIDES_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-slides",
      title: basenameOf(filePath),
      createdAt,
    };
  }
  if (DELIMITED_TABLE_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "delimited-table",
      title: basenameOf(filePath),
      createdAt,
    };
  }
  if (DEVELOPER_EXTS.has(ext) && options?.includeDeveloperArtifacts === true) {
    return {
      kind: "source-diff",
      filePath,
      title: basenameOf(filePath),
      createdAt,
    };
  }
  return null;
};

const imageGenPayload = (event: ArtifactEventRecord): DisplayPayload | null => {
  if (event.type !== "tool_result") return null;
  const payload = event.payload;
  if (!payload || payload.toolName !== "image_gen" || payload.error)
    return null;
  const candidate =
    payload.details && typeof payload.details === "object"
      ? payload.details
      : payload.result;
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const filePaths = Array.isArray(record.filePaths)
    ? record.filePaths.filter(
        (filePath): filePath is string =>
          typeof filePath === "string" && filePath.trim().length > 0,
      )
    : [];
  if (filePaths.length === 0) return null;
  return {
    kind: "media",
    asset: { kind: "image", filePaths },
    createdAt: event.timestamp,
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    ...(typeof record.capability === "string"
      ? { capability: record.capability }
      : {}),
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(typeof record.aspectRatio === "string"
      ? { aspectRatio: record.aspectRatio }
      : {}),
    presentation: "inline-image",
  };
};

/** A no-signal thread spawned longer ago than this is presumed settled
 *  rather than pinned as forever-working. Mirrors the desktop card. */
const AGENT_WORK_STALE_MS = 5 * 60_000;

const GENERIC_TASK_DESCRIPTION = /^(task|agent|work|help|do this|follow up)$/i;

const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const isGenericDescription = (value: string | undefined): boolean =>
  !value || GENERIC_TASK_DESCRIPTION.test(value.trim());

const terminalTaskStatus = (
  type: string,
): "completed" | "error" | "canceled" | null => {
  if (type === "agent-completed") return "completed";
  if (type === "agent-failed") return "error";
  if (type === "agent-canceled") return "canceled";
  return null;
};

const isMobileTaskLifecycleEvent = (type: string): boolean =>
  type === "agent-started" ||
  type === "agent-progress" ||
  terminalTaskStatus(type) !== null;

/** Latest terminal timestamp per agent id across the synced set. */
const buildSettledAtMsById = (
  messages: readonly ArtifactMessageRecord[],
): Map<string, number> => {
  const settledAt = new Map<string, number>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      if (!terminalTaskStatus(event.type)) continue;
      const agentId = trimmedString(event.payload?.agentId);
      if (!agentId) continue;
      if (event.timestamp > (settledAt.get(agentId) ?? 0)) {
        settledAt.set(agentId, event.timestamp);
      }
    }
  }
  return settledAt;
};

/** Cap on files per agent section — deliverables rank first, so truncation
 *  drops incidental writes, not the asked-for files. */
const AGENT_SECTION_FILE_LIMIT = 8;

/**
 * Fold every `agent-completed` event across the synced context into a
 * per-agent display-payload list for the agent-work card's file sections.
 * Files are deduped by path (first sighting wins, preserving the rollup's
 * order), snapshot-detected `producedFiles` are noise-filtered, and declared
 * deliverables (`~/.stella/outputs/**`) lead so the section cap truncates
 * scratch instead of the files the user asked for — mirroring the desktop
 * `agent-completion.ts` derivation.
 */
const buildAgentFilesById = (
  messages: readonly ArtifactMessageRecord[],
  options?: MobileArtifactOptions,
): Map<string, DisplayPayload[]> => {
  type Candidate = { filePath: string; payload: DisplayPayload };
  const byAgent = new Map<string, Map<string, Candidate>>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      if (event.type !== "agent-completed") continue;
      const payload = event.payload;
      const agentId = trimmedString(payload?.agentId);
      if (!payload || !agentId) continue;
      const fileChanges = isFileChangeRecordArray(payload.fileChanges)
        ? payload.fileChanges
        : [];
      const producedFiles = isProducedFileRecordArray(payload.producedFiles)
        ? payload.producedFiles
        : [];
      const candidates = byAgent.get(agentId) ?? new Map<string, Candidate>();
      byAgent.set(agentId, candidates);
      const consider = (record: FileChangeRecord, noiseFiltered: boolean) => {
        const resolved = resolveFileChange(record, event.timestamp);
        if (!resolved) return;
        if (noiseFiltered && isNoiseProducedPath(resolved.filePath)) return;
        if (candidates.has(resolved.filePath)) return;
        const display = payloadFromFilePath(
          resolved.filePath,
          resolved.timestamp,
          options,
        );
        if (!display) return;
        candidates.set(resolved.filePath, {
          filePath: resolved.filePath,
          payload: display,
        });
      };
      for (const record of fileChanges) consider(record, false);
      for (const record of producedFiles) consider(record, true);
    }
  }

  const files = new Map<string, DisplayPayload[]>();
  for (const [agentId, candidates] of byAgent) {
    const entries = [...candidates.values()];
    const ranked = [
      ...entries.filter((entry) => isDeclaredOutputPath(entry.filePath)),
      ...entries.filter((entry) => !isDeclaredOutputPath(entry.filePath)),
    ];
    if (ranked.length > 0) {
      files.set(
        agentId,
        ranked
          .slice(0, AGENT_SECTION_FILE_LIMIT)
          .map((entry) => entry.payload),
      );
    }
  }
  return files;
};

/**
 * Stable identity for a turn's agent-work card. Agent ids are discovered over
 * time, so keying by the whole set (`agent-work:a,b`) replaced the already
 * visible `agent-work:a` card when a sibling started. The first spawned agent
 * is the insertion identity for the aggregate; later starts and terminal
 * events only update that card's payload.
 */
const agentWorkArtifactId = (agentIds: readonly string[]): string => {
  const first = agentIds.map((id) => id.trim()).find(Boolean);
  return first ? `agent-work:${first}` : "agent-work";
};

/**
 * Background-work card for a turn, from its `agent-started` events. Completion
 * is scoped per run (an `agent-completed` at/after the thread's spawn on this
 * turn) so a thread reused via `send_input` doesn't inherit a prior run's
 * completion. Returns null for turns that started no background work.
 */
const deriveAgentWorkPayload = (
  message: Pick<ArtifactMessageRecord, "toolEvents">,
  settledAtMsById: ReadonlyMap<string, number>,
  nowMs: number,
  filesByAgentId: ReadonlyMap<string, DisplayPayload[]> = new Map(),
): { id: string; payload: MobileAgentWorkPayload } | null => {
  const threadIds: string[] = [];
  const descriptions: Record<string, string> = {};
  const spawnedAtMs: Record<string, number> = {};
  let createdAt = 0;

  for (const event of message.toolEvents) {
    if (event.type !== "agent-started") continue;
    const payload = event.payload;
    if (!payload) continue;
    const agentId = trimmedString(payload.agentId);
    if (!agentId) continue;
    if (!threadIds.includes(agentId)) threadIds.push(agentId);
    const description = trimmedString(payload.description);
    if (description && !descriptions[agentId])
      descriptions[agentId] = description;
    if (event.timestamp > (spawnedAtMs[agentId] ?? 0)) {
      spawnedAtMs[agentId] = event.timestamp;
    }
    // Card ordering is anchored when the aggregate first becomes visible.
    // Later sibling starts must not rewrite its insertion timestamp.
    if (createdAt === 0 || event.timestamp < createdAt) {
      createdAt = event.timestamp;
    }
  }
  if (threadIds.length === 0) return null;

  let completed = 0;
  for (const id of threadIds) {
    const spawnedAt = spawnedAtMs[id] ?? 0;
    const completedAt = settledAtMsById.get(id);
    const isDone =
      (completedAt !== undefined && completedAt >= spawnedAt) ||
      nowMs - spawnedAt > AGENT_WORK_STALE_MS;
    if (isDone) completed += 1;
  }
  const total = threadIds.length;
  const state: "running" | "done" = completed >= total ? "done" : "running";

  const firstDescription = threadIds
    .map((id) => descriptions[id])
    .find((value) => !isGenericDescription(value));

  let title: string;
  let subtitle: string;
  if (total > 1) {
    title =
      state === "running"
        ? `Working on ${total} tasks`
        : firstDescription || "Background work";
    subtitle =
      state === "running" ? `${completed} of ${total} done` : "Finished";
  } else {
    title = firstDescription || "Background work";
    subtitle = state === "running" ? "Working in background" : "Finished";
  }

  // Per-agent completion-file sections, in spawn order. A section exists
  // only once its agent's `agent-completed` rollup landed, so the pill
  // reveal is completion-scoped by construction. Always attached (possibly
  // empty): the field's presence tells mobile this bridge consolidates and
  // any loose file artifacts left on the row are orchestrator-direct.
  const agents: MobileAgentWorkFileSection[] = [];
  for (const id of threadIds) {
    const files = filesByAgentId.get(id);
    if (!files || files.length === 0) continue;
    agents.push({
      agentId: id,
      title: descriptions[id] || "Task",
      files,
    });
  }

  return {
    id: agentWorkArtifactId(threadIds),
    payload: {
      kind: "agent-work",
      state,
      agentIds: [...threadIds],
      total,
      completed,
      title,
      subtitle,
      createdAt,
      agents,
    },
  };
};

type TaskBuild = {
  id: string;
  title: string;
  status: "running" | "completed" | "error" | "canceled";
  statusText?: string;
  createdAt: number;
  spawnedAt: number;
  completedAt?: number;
};

/** Fold every turn's `agent-*` lifecycle events into one task per agent id. */
const buildMobileTasksById = (
  messages: readonly ArtifactMessageRecord[],
  nowMs: number,
  assistantMessagesByAgentId?: ReadonlyMap<string, readonly string[]>,
  statusTextByAgentId?: ReadonlyMap<string, string>,
): Map<string, MobileTask> => {
  const builds = new Map<string, TaskBuild>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      const payload = event.payload;
      if (!payload) continue;
      const agentId = trimmedString(payload.agentId);
      if (!agentId) continue;
      const existing = builds.get(agentId);
      if (event.type === "agent-started") {
        const title =
          trimmedString(payload.description) ||
          "Background work";
        const statusText = trimmedString(payload.statusText);
        if (!existing) {
          builds.set(agentId, {
            id: agentId,
            title,
            status: "running",
            ...(statusText ? { statusText } : {}),
            createdAt: event.timestamp,
            spawnedAt: event.timestamp,
          });
        } else {
          if (
            existing.title === "Background work" &&
            title !== "Background work"
          ) {
            existing.title = title;
          }
          existing.status = "running";
          existing.completedAt = undefined;
          if (statusText) existing.statusText = statusText;
          existing.createdAt = Math.min(existing.createdAt, event.timestamp);
          existing.spawnedAt = Math.max(existing.spawnedAt, event.timestamp);
        }
        continue;
      }
      if (event.type === "agent-progress") {
        const statusText = trimmedString(payload.statusText);
        if (existing && existing.status === "running" && statusText) {
          existing.statusText = statusText;
        }
        continue;
      }
      const terminal = terminalTaskStatus(event.type);
      if (!terminal) continue;
      if (!existing) {
        builds.set(agentId, {
          id: agentId,
          title:
            trimmedString(payload.description) ||
            "Background work",
          status: terminal,
          createdAt: event.timestamp,
          spawnedAt: event.timestamp,
          completedAt: event.timestamp,
        });
      } else if (event.timestamp >= existing.spawnedAt) {
        existing.status = terminal;
        existing.completedAt = event.timestamp;
      }
    }
  }

  const tasks = new Map<string, MobileTask>();
  for (const build of builds.values()) {
    // A long-silent running thread aged out of the loaded window — settle it so
    // the tray doesn't shimmer "running" forever (mirrors the agent card).
    const status =
      build.status === "running" &&
      nowMs - build.spawnedAt > AGENT_WORK_STALE_MS
        ? "completed"
        : build.status;
    const assistantMessages = assistantMessagesByAgentId?.get(build.id);
    const authoredMessages = assistantMessages ? [...assistantMessages] : [];
    // Live decoration beats the folded spawn text: `agent-progress` ticks are
    // no longer persisted, so mid-run statusText only exists in the renderer's
    // decoration snapshot mirrored via `publishTaskDecoration`.
    const statusText =
      status === "running"
        ? statusTextByAgentId?.get(build.id) || build.statusText
        : undefined;
    tasks.set(build.id, {
      id: build.id,
      title: build.title,
      status,
      ...(statusText ? { statusText } : {}),
      createdAt: build.createdAt,
      ...(build.completedAt !== undefined
        ? { completedAt: build.completedAt }
        : {}),
      assistantMessages: authoredMessages,
      // Keep the established mobile wire field for compatibility, but its
      // contents are now the agent's own assistant messages, never generated
      // progress summaries. Empty is meaningful: clear stale cached values.
      reasoningSummaries: [...authoredMessages],
    });
  }
  return tasks;
};

/** Task ids touched by this message's lifecycle events, resolved globally. */
const deriveMobileTasksForMessage = (
  message: Pick<ArtifactMessageRecord, "toolEvents">,
  tasksById: ReadonlyMap<string, MobileTask>,
): MobileTask[] => {
  const out: MobileTask[] = [];
  const seen = new Set<string>();
  for (const event of message.toolEvents) {
    if (!isMobileTaskLifecycleEvent(event.type)) continue;
    const agentId = trimmedString(event.payload?.agentId);
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    const task = tasksById.get(agentId);
    if (task) out.push(task);
  }
  return out;
};

const taskIdsTouchedByMessages = (
  messages: readonly ArtifactMessageRecord[],
): Set<string> => {
  const touched = new Set<string>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      if (!isMobileTaskLifecycleEvent(event.type)) continue;
      const agentId = trimmedString(event.payload?.agentId);
      if (agentId) touched.add(agentId);
    }
  }
  return touched;
};

const messageStartsTouchedTask = (
  message: ArtifactMessageRecord,
  touchedTaskIds: ReadonlySet<string>,
): boolean => {
  for (const event of message.toolEvents) {
    if (event.type !== "agent-started") continue;
    const agentId = trimmedString(event.payload?.agentId);
    if (agentId && touchedTaskIds.has(agentId)) return true;
  }
  return false;
};

const withTaskAnchorMessages = (
  messages: readonly ArtifactMessageRecord[],
  taskContextMessages: readonly ArtifactMessageRecord[],
): ArtifactMessageRecord[] => {
  if (taskContextMessages === messages || messages.length === 0) {
    return [...messages];
  }
  const touchedTaskIds = taskIdsTouchedByMessages(messages);
  if (touchedTaskIds.size === 0) return [...messages];

  const seenMessageIds = new Set(messages.map((message) => message._id));
  const anchors = taskContextMessages.filter(
    (message) =>
      !seenMessageIds.has(message._id) &&
      messageStartsTouchedTask(message, touchedTaskIds),
  );
  if (anchors.length === 0) return [...messages];
  return [...anchors, ...messages].sort(
    (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
  );
};

// Arg keys the mobile per-call title reads (see the mobile `tool-activity`
// port). Everything else is dropped so raw tool args never cross the bridge.
const TITLE_ARG_KEYS = [
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "cmd",
  "command",
  "prompt",
  "title",
  "name",
] as const;

const pickTitleArgs = (args: unknown): Record<string, string> | undefined => {
  if (!args || typeof args !== "object") return undefined;
  const source = args as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of TITLE_ARG_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value.length > 200 ? value.slice(0, 200) : value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Pair a turn's `tool_request` / `tool_result` events by request id and project
 * the settled ones (a result arrived) for the mobile tool-activity trace. The
 * in-flight call is intentionally omitted — it's owned by the live working
 * indicator, exactly as on desktop.
 */
export const deriveMobileToolSteps = (
  message: Pick<ArtifactMessageRecord, "toolEvents">,
): MobileToolStep[] => {
  type Build = {
    id: string;
    toolName: string;
    status: "running" | "completed" | "error";
    args?: Record<string, string>;
  };
  const order: string[] = [];
  const byId = new Map<string, Build>();
  for (const event of message.toolEvents) {
    const payload = event.payload ?? {};
    const requestId =
      (typeof payload.requestId === "string" && payload.requestId) || event._id;
    if (!requestId) continue;
    if (event.type === "tool_request") {
      const toolName =
        typeof payload.toolName === "string" ? payload.toolName : "";
      if (!toolName) continue;
      if (!byId.has(requestId)) order.push(requestId);
      byId.set(requestId, {
        id: requestId,
        toolName,
        status: "running",
        args: pickTitleArgs(payload.args),
      });
    } else if (event.type === "tool_result") {
      const existing = byId.get(requestId);
      if (!existing) continue;
      existing.status = payload.error ? "error" : "completed";
    }
  }
  const steps: MobileToolStep[] = [];
  for (const id of order) {
    const build = byId.get(id);
    if (!build || build.status === "running") continue;
    steps.push({
      id: build.id,
      toolName: build.toolName,
      status: build.status,
      ...(build.args ? { args: build.args } : {}),
    });
  }
  return steps;
};

/**
 * Lift a successful `map` tool_result's `map-route` artifact (see
 * `runtime/kernel/tools/defs/map.ts`) for the mobile inline map card.
 */
const mapArtifactPayload = (
  event: ArtifactEventRecord,
): MapRouteArtifact | null => {
  if (event.type !== "tool_result") return null;
  const payload = event.payload;
  if (!payload || payload.toolName !== "map" || payload.error) return null;
  return isMapRouteArtifact(payload.map) ? payload.map : null;
};

export const deriveMobileArtifactsForMessage = (
  message: Pick<ArtifactMessageRecord, "toolEvents">,
  options?: MobileArtifactOptions,
): MobileSyncArtifact[] => {
  const artifacts: MobileSyncArtifact[] = [];
  const seen = new Set<string>();

  for (const event of message.toolEvents) {
    const payload = event.payload;
    if (!payload) continue;

    // Consolidation: delegated agents' mid-run tool_results and the
    // `agent-completed` rollups contribute nothing loose — their files ride
    // the agent-work card's per-agent sections (see `buildAgentFilesById`),
    // revealed together at completion like the desktop completion card.
    if (event.type === "agent-completed" || isDelegatedToolResult(event)) {
      continue;
    }

    pushArtifact(artifacts, seen, imageGenPayload(event));

    const mapArtifact = mapArtifactPayload(event);
    if (mapArtifact) {
      const key = `map:${mapArtifact.markers.map((m) => m.id).join("|")}:${
        mapArtifact.route?.polyline ?? ""
      }`;
      if (!seen.has(key)) {
        seen.add(key);
        artifacts.push(mapArtifact);
      }
    }

    if (
      event.type === "tool_result" &&
      payload.toolName === "html" &&
      !payload.error &&
      typeof payload.filePath === "string"
    ) {
      pushArtifact(
        artifacts,
        seen,
        payloadFromFilePath(payload.filePath, event.timestamp, options),
      );
    }

    const officePreviewRef = payload.officePreviewRef;
    if (
      officePreviewRef &&
      typeof officePreviewRef === "object" &&
      typeof (officePreviewRef as { sessionId?: unknown }).sessionId ===
        "string" &&
      typeof (officePreviewRef as { title?: unknown }).title === "string" &&
      typeof (officePreviewRef as { sourcePath?: unknown }).sourcePath ===
        "string"
    ) {
      pushArtifact(artifacts, seen, {
        kind: "office",
        previewRef: officePreviewRef as Extract<
          DisplayPayload,
          { kind: "office" }
        >["previewRef"],
      });
    }

    const fileChanges = isFileChangeRecordArray(payload.fileChanges)
      ? payload.fileChanges
      : [];
    const producedFiles = isProducedFileRecordArray(payload.producedFiles)
      ? payload.producedFiles
      : [];
    for (const record of fileChanges) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      pushArtifact(
        artifacts,
        seen,
        payloadFromFilePath(resolved.filePath, resolved.timestamp, options),
      );
    }
    for (const record of producedFiles) {
      const resolved = resolveFileChange(record, event.timestamp);
      // Snapshot-detected writes get the noise filter (deliberate
      // `fileChanges` above do not) — mirrors the desktop produced-file
      // surfaces.
      if (!resolved || isNoiseProducedPath(resolved.filePath)) continue;
      pushArtifact(
        artifacts,
        seen,
        payloadFromFilePath(resolved.filePath, resolved.timestamp, options),
      );
    }
  }

  return artifacts.slice(0, ARTIFACT_LIMIT_PER_MESSAGE);
};

export const buildMobileSyncMessages = (
  messages: readonly ArtifactMessageRecord[],
  maxMessages: number,
  options?: MobileArtifactOptions,
  assistantMessagesByAgentId?: ReadonlyMap<string, readonly string[]>,
  taskContextMessages: readonly ArtifactMessageRecord[] = messages,
  statusTextByAgentId?: ReadonlyMap<string, string>,
): LocalChatSyncMessageWithArtifacts[] => {
  const rows: LocalChatSyncMessageWithArtifacts[] = [];
  // Terminal state is scoped per run (see deriveAgentWorkPayload); precompute
  // the latest terminal timestamp per thread across the whole context once.
  const settledAtMsById = buildSettledAtMsById(taskContextMessages);
  const nowMs = Date.now();
  const tasksById = buildMobileTasksById(
    taskContextMessages,
    nowMs,
    assistantMessagesByAgentId,
    statusTextByAgentId,
  );
  // Completion files resolve across the whole context so a fire-and-forget
  // agent completing on a later row still files onto its spawning row's card.
  const filesByAgentId = buildAgentFilesById(taskContextMessages, options);
  for (const message of messages) {
    if (isUiHiddenChatMessagePayload(message.payload ?? null)) continue;
    const role = message.type === "user_message" ? "user" : "assistant";
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromPayload(message.payload);
    const fileArtifacts = deriveMobileArtifactsForMessage(message, options);
    const agentWork = deriveAgentWorkPayload(
      message,
      settledAtMsById,
      nowMs,
      filesByAgentId,
    );
    // Background tasks spawned by this turn (collected into the activity tray).
    const tasks = deriveMobileTasksForMessage(message, tasksById);
    // Settled tool calls for the inline tool-activity trace (assistant turns).
    const toolSteps =
      role === "assistant" ? deriveMobileToolSteps(message) : [];
    // Inline the agent card on the assistant turn that spawned it. For a
    // fire-and-forget turn (no assistant message — the start event lands on
    // the user_message), it's emitted as its own assistant bubble below.
    const artifacts: MobileSyncArtifactEntry[] =
      role === "assistant" && agentWork
        ? [...fileArtifacts, agentWork]
        : fileArtifacts;

    if (text || role === "assistant") {
      if (text || artifacts.length > 0 || toolSteps.length > 0) {
        rows.push({
          localMessageId: message._id,
          role,
          text,
          timestamp: message.timestamp,
          ...(message.requestId ? { requestId: message.requestId } : {}),
          ...(role === "user" && message.deviceId
            ? { deviceId: message.deviceId }
            : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(toolSteps.length > 0 ? { toolSteps } : {}),
          // Carried for the activity tray (collected conversation-wide); never
          // forces a row to render on its own — it rides one that already does.
          ...(tasks.length > 0 ? { tasks } : {}),
        });
      }
    } else if (artifacts.length > 0) {
      rows.push({
        localMessageId: `${message._id}:artifacts`,
        role: "assistant",
        text: "",
        timestamp: message.timestamp,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        artifacts,
      });
    }

    if (role === "user" && agentWork) {
      rows.push({
        localMessageId: `${message._id}:agent`,
        role: "assistant",
        text: "",
        timestamp: message.timestamp,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        artifacts: [agentWork],
        // Fire-and-forget turn: the user row may not render, so carry its tasks
        // on the agent bubble (collected by id, so any overlap dedupes).
        ...(tasks.length > 0 ? { tasks } : {}),
      });
    }
  }
  return rows.slice(Math.max(0, rows.length - maxMessages));
};

export const buildMobileSyncMessagesPage = (
  messages: readonly ArtifactMessageRecord[],
  maxMessages: number,
  cursorSource: readonly ArtifactSourceRecord[] = messages,
  options?: MobileArtifactOptions,
  assistantMessagesByAgentId?: ReadonlyMap<string, readonly string[]>,
  taskContextMessages: readonly ArtifactMessageRecord[] = messages,
  statusTextByAgentId?: ReadonlyMap<string, string>,
): LocalChatMobileSyncResult => {
  const messagesWithTaskAnchors = withTaskAnchorMessages(
    messages,
    taskContextMessages,
  );
  const extraAnchorBudget = Math.max(
    0,
    messagesWithTaskAnchors.length - messages.length,
  );
  return {
    messages: buildMobileSyncMessages(
      messagesWithTaskAnchors,
      maxMessages + extraAnchorBudget,
      options,
      assistantMessagesByAgentId,
      taskContextMessages,
      statusTextByAgentId,
    ),
    cursor: cursorForNewestSourceRecord(cursorSource),
  };
};
