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

const MAX_DISPLAY_FILE_BYTES = 50 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([".pdf"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
};

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
