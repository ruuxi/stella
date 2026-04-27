import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC_DISPLAY_READ_FILE } from "../../src/shared/contracts/ipc-channels.js";

type DisplayHandlersOptions = {
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

      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        throw new Error(`display:readFile target is not a file: ${resolved}`);
      }
      if (stats.size > MAX_DISPLAY_FILE_BYTES) {
        throw new Error(
          `File too large to display (${stats.size} bytes, limit ${MAX_DISPLAY_FILE_BYTES}).`,
        );
      }

      const buffer = await fs.readFile(resolved);
      return {
        contentsBase64: buffer.toString("base64"),
        sizeBytes: stats.size,
        mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
      };
    },
  );
};
