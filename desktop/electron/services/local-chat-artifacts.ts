import type { DisplayPayload } from "../../src/shared/contracts/display-payload.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "../../../runtime/contracts/file-changes.js";
import { isUiHiddenChatMessagePayload } from "../../../runtime/chat-event-visibility.js";

export type LocalChatSyncMessageWithArtifacts = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  requestId?: string;
  deviceId?: string;
  artifacts?: DisplayPayload[];
};

export type LocalChatMobileSyncCursor = {
  timestamp: number;
  id: string;
};

export type LocalChatMobileSyncResult = {
  messages: LocalChatSyncMessageWithArtifacts[];
  cursor: string | null;
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

const HTML_OUTPUT_PATH_RE =
  /(?:^|\/)(?:\.stella|state)\/outputs\/html\/([^/]+)\.html$/;

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
  artifacts: DisplayPayload[],
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
  if (DEVELOPER_EXTS.has(ext)) {
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

export const deriveMobileArtifactsForMessage = (
  message: Pick<ArtifactMessageRecord, "toolEvents">,
): DisplayPayload[] => {
  const artifacts: DisplayPayload[] = [];
  const seen = new Set<string>();

  for (const event of message.toolEvents) {
    const payload = event.payload;
    if (!payload) continue;

    pushArtifact(artifacts, seen, imageGenPayload(event));

    if (
      event.type === "tool_result" &&
      payload.toolName === "html" &&
      !payload.error &&
      typeof payload.filePath === "string"
    ) {
      pushArtifact(
        artifacts,
        seen,
        payloadFromFilePath(payload.filePath, event.timestamp),
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
    for (const record of [...fileChanges, ...producedFiles]) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      pushArtifact(
        artifacts,
        seen,
        payloadFromFilePath(resolved.filePath, resolved.timestamp),
      );
    }
  }

  return artifacts.slice(0, ARTIFACT_LIMIT_PER_MESSAGE);
};

export const buildMobileSyncMessages = (
  messages: readonly ArtifactMessageRecord[],
  maxMessages: number,
): LocalChatSyncMessageWithArtifacts[] => {
  const rows: LocalChatSyncMessageWithArtifacts[] = [];
  for (const message of messages) {
    if (isUiHiddenChatMessagePayload(message.payload ?? null)) continue;
    const role = message.type === "user_message" ? "user" : "assistant";
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromPayload(message.payload);
    const artifacts = deriveMobileArtifactsForMessage(message);

    if (text || role === "assistant") {
      if (text || artifacts.length > 0) {
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
        });
      }
      continue;
    }

    if (artifacts.length > 0) {
      rows.push({
        localMessageId: `${message._id}:artifacts`,
        role: "assistant",
        text: "",
        timestamp: message.timestamp,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        artifacts,
      });
    }
  }
  return rows.slice(Math.max(0, rows.length - maxMessages));
};

export const buildMobileSyncMessagesPage = (
  messages: readonly ArtifactMessageRecord[],
  maxMessages: number,
  cursorSource: readonly ArtifactSourceRecord[] = messages,
): LocalChatMobileSyncResult => ({
  messages: buildMobileSyncMessages(messages, maxMessages),
  cursor: cursorForNewestSourceRecord(cursorSource),
});
