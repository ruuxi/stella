import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  IPC_DISPLAY_LIST_CANVAS_HTML,
  IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS,
  IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED,
  IPC_DISPLAY_READ_FILE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
} from "../../src/shared/contracts/ipc-channels.js";
import {
  listOpenPanelReports,
  markOpenPanelReportOpened,
  type OpenPanelReportCadence,
} from "../../../runtime/kernel/agent-runtime/open-panel-cadence-reports.js";
import {
  listDeferredDeletes,
  purgeAllDeferredDeletes,
  purgeDeferredDelete,
} from "../../../runtime/kernel/tools/deferred-delete.js";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
} from "../../../runtime/contracts/file-changes.js";
import type { LocalChatEventRecord } from "../../../runtime/kernel/storage/shared.js";

type DisplayHandlersOptions = {
  getStellaRoot: () => string | null;
  getStellaHome: () => string | null;
  localChatHistoryService?: LocalChatHistoryService;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const MAX_DISPLAY_FILE_BYTES = 200 * 1024 * 1024;
const MOBILE_BRIDGE_SENDER_URL = "stella-mobile-bridge://mobile";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".c": "text/plain",
  ".cc": "text/plain",
  ".cpp": "text/plain",
  ".cs": "text/plain",
  ".css": "text/css",
  ".go": "text/plain",
  ".h": "text/plain",
  ".hpp": "text/plain",
  ".html": "text/html",
  ".java": "text/plain",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".kt": "text/plain",
  ".mjs": "text/javascript",
  ".php": "text/plain",
  ".py": "text/x-python",
  ".rb": "text/plain",
  ".rs": "text/plain",
  ".scss": "text/x-scss",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svelte": "text/plain",
  ".swift": "text/plain",
  ".toml": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".vue": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  // 3D / generic
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain",
  ".stl": "application/sla",
  ".bin": "application/octet-stream",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

const resolvedPathForChange = (record: FileChangeRecord): string | null => {
  if (record.kind.type === "delete") return null;
  const filePath =
    record.kind.type === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  if (!filePath || !path.isAbsolute(filePath)) return null;
  return path.resolve(filePath);
};

export const isDisplayReadPathInLocalChatFiles = (
  events: ReadonlyArray<LocalChatEventRecord>,
  requestedPath: string,
): boolean => {
  const resolvedRequestedPath = path.resolve(requestedPath);
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;

    if (
      typeof payload.filePath === "string" &&
      path.isAbsolute(payload.filePath) &&
      path.resolve(payload.filePath) === resolvedRequestedPath
    ) {
      return true;
    }

    const fileChanges = isFileChangeRecordArray(payload.fileChanges)
      ? payload.fileChanges
      : [];
    const producedFiles = isProducedFileRecordArray(payload.producedFiles)
      ? payload.producedFiles
      : [];
    for (const record of [...fileChanges, ...producedFiles]) {
      if (resolvedPathForChange(record) === resolvedRequestedPath) {
        return true;
      }
    }
  }
  return false;
};

const isMobileBridgeSender = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  event.senderFrame?.url === MOBILE_BRIDGE_SENDER_URL ||
  event.sender.getURL() === MOBILE_BRIDGE_SENDER_URL;

export const registerDisplayHandlers = (options: DisplayHandlersOptions) => {
  const requireStellaRoot = () => {
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) {
      throw new Error("Stella root is unavailable.");
    }
    return stellaRoot;
  };
  const requireStellaHome = () => {
    const stellaHome = options.getStellaHome();
    if (!stellaHome) {
      throw new Error("Stella home is unavailable.");
    }
    return stellaHome;
  };

  ipcMain.handle(
    IPC_DISPLAY_READ_FILE,
    async (
      event,
      payload?: { filePath?: unknown; conversationId?: unknown },
    ) => {
      if (!options.assertPrivilegedSender(event, IPC_DISPLAY_READ_FILE)) {
        throw new Error(`Blocked untrusted ${IPC_DISPLAY_READ_FILE} request.`);
      }

      const requestedPath =
        typeof payload?.filePath === "string" ? payload.filePath.trim() : "";
      if (!requestedPath) {
        throw new Error("display:readFile requires a filePath.");
      }

      const resolved = path.resolve(requestedPath);
      if (isMobileBridgeSender(event)) {
        const conversationId =
          typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId) {
          throw new Error(
            "display:readFile from mobile requires a conversationId.",
          );
        }
        if (!options.localChatHistoryService) {
          throw new Error("Local chat file history is unavailable.");
        }
        const { files } = options.localChatHistoryService.listFiles({
          conversationId,
          limit: 500,
        });
        if (!isDisplayReadPathInLocalChatFiles(files, resolved)) {
          throw new Error(
            "display:readFile from mobile is limited to recent files Stella displayed for the active conversation.",
          );
        }
      }
      const extension = path.extname(resolved).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error(
          `display:readFile only supports: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
        );
      }
      const mimeType =
        MIME_BY_EXTENSION[extension] ?? "application/octet-stream";

      // Paths can outlive the file they point at — e.g. an `image_gen` /
      // tool-result registered a path in `generatedMediaItems`, and the
      // underlying file was later moved or deleted (especially for paths
      // outside `~/.stella/`). Treat ENOENT as a soft "missing" result so the
      // renderer can render a placeholder instead of surfacing the raw
      // IPC error to the console / UI.
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(resolved);
      } catch (caught) {
        if (
          caught &&
          typeof caught === "object" &&
          (caught as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return { missing: true as const, mimeType, path: resolved };
        }
        throw caught;
      }
      if (!stats.isFile()) {
        throw new Error(`display:readFile target is not a file: ${resolved}`);
      }
      if (stats.size > MAX_DISPLAY_FILE_BYTES) {
        throw new Error(
          `File too large to display (${stats.size} bytes, limit ${MAX_DISPLAY_FILE_BYTES}).`,
        );
      }

      const buffer = await fs.readFile(resolved);
      // Return the raw bytes; Electron's structured-clone IPC transport
      // ships `Uint8Array` directly without the +33% base64 overhead and
      // without forcing the renderer to spin a JS loop to decode it.
      const bytes = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      return {
        bytes,
        sizeBytes: stats.size,
        mimeType,
        missing: false as const,
      };
    },
  );

  ipcMain.handle(IPC_DISPLAY_LIST_CANVAS_HTML, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_DISPLAY_LIST_CANVAS_HTML)) {
      throw new Error(
        `Blocked untrusted ${IPC_DISPLAY_LIST_CANVAS_HTML} request.`,
      );
    }

    const htmlDir = path.join(requireStellaHome(), "outputs", "html");
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(htmlDir, { withFileTypes: true });
    } catch (caught) {
      if (
        caught &&
        typeof caught === "object" &&
        (caught as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw caught;
    }

    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
        .map(async (entry) => {
          const filePath = path.join(htmlDir, entry.name);
          const stats = await fs.stat(filePath);
          const slug = entry.name.slice(0, -".html".length);
          return {
            filePath,
            slug,
            title: slug
              .replace(/[-_]+/g, " ")
              .replace(/\b\w/g, (char: string) => char.toUpperCase()),
            createdAt: stats.mtimeMs,
          };
        }),
    );

    return items.sort((a, b) => a.createdAt - b.createdAt);
  });

  ipcMain.handle(IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS, async (event) => {
    if (
      !options.assertPrivilegedSender(
        event,
        IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS,
      )
    ) {
      throw new Error(
        `Blocked untrusted ${IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS} request.`,
      );
    }
    return await listOpenPanelReports(requireStellaHome());
  });

  ipcMain.handle(
    IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED,
    async (event, payload?: { cadence?: unknown }) => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED,
        )
      ) {
        throw new Error(
          `Blocked untrusted ${IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED} request.`,
        );
      }
      const cadence = payload?.cadence;
      if (cadence !== "4h" && cadence !== "daily" && cadence !== "weekly") {
        throw new Error("Unknown Open panel report cadence.");
      }
      return await markOpenPanelReportOpened(
        requireStellaHome(),
        cadence as OpenPanelReportCadence,
      );
    },
  );

  ipcMain.handle(IPC_DISPLAY_TRASH_LIST, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_DISPLAY_TRASH_LIST)) {
      throw new Error(`Blocked untrusted ${IPC_DISPLAY_TRASH_LIST} request.`);
    }
    return await listDeferredDeletes({ stellaHome: requireStellaHome() });
  });

  ipcMain.handle(
    IPC_DISPLAY_TRASH_FORCE_DELETE,
    async (event, payload?: { id?: unknown; all?: unknown }) => {
      if (
        !options.assertPrivilegedSender(event, IPC_DISPLAY_TRASH_FORCE_DELETE)
      ) {
        throw new Error(
          `Blocked untrusted ${IPC_DISPLAY_TRASH_FORCE_DELETE} request.`,
        );
      }

      const stellaHome = requireStellaHome();
      if (payload?.all === true) {
        return await purgeAllDeferredDeletes({ stellaHome });
      }
      const id = typeof payload?.id === "string" ? payload.id : "";
      return await purgeDeferredDelete(id, { stellaHome });
    },
  );
};
