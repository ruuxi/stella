import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  IPC_DISPLAY_READ_FILE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
} from "../../src/shared/contracts/ipc-channels.js";
import {
  listDeferredDeletes,
  purgeAllDeferredDeletes,
  purgeDeferredDelete,
} from "../../../runtime/kernel/tools/deferred-delete.js";

type DisplayHandlersOptions = {
  getStellaRoot: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const MAX_DISPLAY_FILE_BYTES = 200 * 1024 * 1024;

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

export const registerDisplayHandlers = (options: DisplayHandlersOptions) => {
  const requireStellaRoot = () => {
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) {
      throw new Error("Stella root is unavailable.");
    }
    return stellaRoot;
  };

  ipcMain.handle(
    IPC_DISPLAY_READ_FILE,
    async (event, payload?: { filePath?: unknown }) => {
      if (!options.assertPrivilegedSender(event, IPC_DISPLAY_READ_FILE)) {
        throw new Error(`Blocked untrusted ${IPC_DISPLAY_READ_FILE} request.`);
      }

      const requestedPath =
        typeof payload?.filePath === "string" ? payload.filePath.trim() : "";
      if (!requestedPath) {
        throw new Error("display:readFile requires a filePath.");
      }

      const resolved = path.resolve(requestedPath);
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
      // outside `state/`). Treat ENOENT as a soft "missing" result so the
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

  ipcMain.handle(IPC_DISPLAY_TRASH_LIST, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_DISPLAY_TRASH_LIST)) {
      throw new Error(`Blocked untrusted ${IPC_DISPLAY_TRASH_LIST} request.`);
    }
    return await listDeferredDeletes({ stellaHome: requireStellaRoot() });
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

      const stellaHome = requireStellaRoot();
      if (payload?.all === true) {
        return await purgeAllDeferredDeletes({ stellaHome });
      }
      const id = typeof payload?.id === "string" ? payload.id : "";
      return await purgeDeferredDelete(id, { stellaHome });
    },
  );
};
