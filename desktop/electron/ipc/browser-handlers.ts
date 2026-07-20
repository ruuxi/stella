import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clipboard,
  ipcMain,
  nativeImage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { getStellaBrowserBridgeEnv } from "../../../runtime/kernel/tools/stella-browser-bridge-config.js";
import { BrowserSession } from "../../../runtime/kernel/browser-use/client.js";
import { resolveStellaBrowserRoot } from "../utils/stella-browser-paths.js";
import {
  normalizeUrlForPrivilegedRendererFetch,
  PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
} from "./renderer-safe-url.js";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_MEDIA_COPY_IMAGE,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
} from "../../src/shared/contracts/ipc-channels.js";
import { materializeMediaArtifact } from "../../../runtime/kernel/tools/media-artifact-store.js";
import { validateDecodedImageFile } from "../../../runtime/kernel/tools/image-decode-validation.js";

type BrowserFetchInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type BrowserCookie = {
  name: string;
  value: string;
};

type BrowserHandlersOptions = {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  // Idempotently ensures the browser-bridge daemon is running. Called on the
  // first browser-session fetch so that users whose extension wasn't detected
  // by the eager startup scan (installed mid-session, or in a custom Chromium
  // user-data-dir) still get the bridge — and thus the native-messaging host
  // registration — without needing to restart Stella.
  ensureBrowserBridgeStarted?: () => void;
};

const getBrowserCookieHeader = async (
  targetUrl: string,
): Promise<string | null> => {
  const stellaBrowserRoot = resolveStellaBrowserRoot();
  const extensionEnv: Record<string, string> = {
    ...getStellaBrowserBridgeEnv(),
  };
  const session = new BrowserSession({
    sessionId: randomUUID(),
    cwd: stellaBrowserRoot,
    binaryPath: path.join(stellaBrowserRoot, "bin", "stella-browser.js"),
    env: extensionEnv,
    commandTimeoutMs: PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
  });
  try {
    const response = await session.command<{ cookies?: BrowserCookie[] }>(
      "cookies_get",
      { url: targetUrl },
    );
    const cookies = response.result.data?.cookies ?? [];
    if (cookies.length === 0) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } finally {
    await session.dispose();
  }
};

const fetchWithBrowserSession = async (payload: {
  url: string;
  responseType: "json" | "text";
  init?: BrowserFetchInit;
}) => {
  const url = await normalizeUrlForPrivilegedRendererFetch(payload.url);
  const cookieHeader = await getBrowserCookieHeader(url);
  const method = payload.init?.method ?? "GET";
  const headers = new Headers(payload.init?.headers);

  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "StellaDesktop/1.0");
  }
  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: payload.init?.body,
    redirect: "follow",
    signal: AbortSignal.timeout(PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  if (payload.responseType === "json") {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Response was not valid JSON (status ${response.status}, ${text.length} bytes).`,
      );
    }
  }

  return response.text();
};

const assertStellaInitialized = (options: BrowserHandlersOptions) => {
  // The browser bridge is gated on the app being far enough along that a
  // stellaAppDir has been resolved; the value itself isn't needed here because
  // the browser service lives inside the desktop tree.
  const stellaAppDir = options.getStellaAppDir();
  if (!stellaAppDir?.trim()) {
    throw new Error("Stella root not available; restart the app.");
  }
};

const resolveMediaOutputPath = (dir: string, fileName: string) => {
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\0") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    path.isAbsolute(fileName)
  ) {
    throw new Error("Invalid media output filename.");
  }

  const resolvedDir = path.resolve(dir);
  const destPath = path.resolve(resolvedDir, fileName);
  if (!destPath.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new Error("Invalid media output filename.");
  }
  return destPath;
};

export const registerBrowserHandlers = (options: BrowserHandlersOptions) => {
  ipcMain.handle(
    IPC_BROWSER_FETCH_JSON,
    async (event, payload: { url: string; init?: BrowserFetchInit }) => {
      if (!options.assertPrivilegedSender(event, IPC_BROWSER_FETCH_JSON)) {
        throw new Error("Blocked untrusted request.");
      }
      assertStellaInitialized(options);
      options.ensureBrowserBridgeStarted?.();
      return fetchWithBrowserSession({
        url: payload.url,
        responseType: "json",
        init: payload.init,
      });
    },
  );

  ipcMain.handle(
    IPC_BROWSER_FETCH_TEXT,
    async (event, payload: { url: string; init?: BrowserFetchInit }) => {
      if (!options.assertPrivilegedSender(event, IPC_BROWSER_FETCH_TEXT)) {
        throw new Error("Blocked untrusted request.");
      }
      assertStellaInitialized(options);
      options.ensureBrowserBridgeStarted?.();
      return fetchWithBrowserSession({
        url: payload.url,
        responseType: "text",
        init: payload.init,
      });
    },
  );

  // ── Media file operations ──

  ipcMain.handle(
    IPC_MEDIA_SAVE_OUTPUT,
    async (
      event,
      payload: { url: string; fileName: string },
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      if (!options.assertPrivilegedSender(event, IPC_MEDIA_SAVE_OUTPUT)) {
        return { ok: false, error: "Blocked untrusted request." };
      }
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        return { ok: false, error: "Stella root not initialized" };
      }
      try {
        const dir = path.join(stellaDataDir, "media", "outputs");
        await fs.mkdir(dir, { recursive: true });
        const destPath = resolveMediaOutputPath(dir, payload.fileName);
        const validateExisting = /\.(?:png|jpe?g|gif|webp)$/i.test(destPath)
          ? validateDecodedImageFile
          : undefined;
        // The terminal image_gen path materializes the same deterministic
        // jobId-based filename before the renderer sees completion. Reuse the
        // durable file so the sidebar/inline materializers do not download or
        // create a second artifact for the same media job.
        const dataUriMatch = payload.url.match(/^data:([^;,]+);base64,(.+)$/is);
        if (dataUriMatch) {
          const saved = await materializeMediaArtifact({
            filePath: destPath,
            ...(validateExisting ? { validateExisting } : {}),
            producer: async () => Buffer.from(dataUriMatch[2], "base64"),
          });
          return { ok: true, path: saved.path };
        }
        const safeUrl = await normalizeUrlForPrivilegedRendererFetch(
          payload.url,
        );
        const saved = await materializeMediaArtifact({
          filePath: destPath,
          ...(validateExisting ? { validateExisting } : {}),
          producerTimeoutMs: PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
          producer: async (signal) => {
            const res = await fetch(safeUrl, {
              headers: { "User-Agent": "StellaDesktop/1.0" },
              redirect: "follow",
              signal,
            });
            if (!res.ok) {
              throw new Error(`Download failed (${res.status})`);
            }
            return Buffer.from(await res.arrayBuffer());
          },
        });
        return { ok: true, path: saved.path };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_MEDIA_GET_DIR, async (event): Promise<string | null> => {
    if (!options.assertPrivilegedSender(event, IPC_MEDIA_GET_DIR)) {
      return null;
    }
    const stellaDataDir = options.getStellaDataDir();
    if (!stellaDataDir) return null;
    return path.join(stellaDataDir, "media");
  });

  ipcMain.handle(
    IPC_MEDIA_COPY_IMAGE,
    async (
      event,
      payload: { pngBase64: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!options.assertPrivilegedSender(event, IPC_MEDIA_COPY_IMAGE)) {
        return { ok: false, error: "Blocked untrusted request." };
      }
      try {
        const image = nativeImage.createFromBuffer(
          Buffer.from(payload.pngBase64, "base64"),
        );
        if (image.isEmpty()) {
          return { ok: false, error: "Could not read image." };
        }
        clipboard.writeImage(image);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );
};
