import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { getStellaBrowserBridgeEnv } from "../../runtime/kernel/tools/stella-browser-bridge-config.js";
import {
  normalizeUrlForPrivilegedRendererFetch,
  PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
} from "./renderer-safe-url.js";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
} from "../../src/shared/contracts/ipc-channels.js";

type BrowserFetchInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

type StellaBrowserResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type BrowserCookie = {
  name: string;
  value: string;
};

type BrowserHandlersOptions = {
  getStellaRoot: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const runStellaBrowserJson = (
  stellaRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<StellaBrowserResponse> =>
  new Promise((resolve, reject) => {
    const binPath = path.join(
      stellaRoot,
      "stella-browser",
      "bin",
      "stella-browser.js",
    );

    execFile(
      process.execPath,
      [binPath, ...args],
      {
        cwd: stellaRoot,
        timeout: PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
        windowsHide: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      },
      (error, stdout, stderr) => {
        const output = stdout.trim();
        if (!output) {
          reject(error ?? new Error(stderr.trim() || "stella-browser failed."));
          return;
        }

        try {
          resolve(JSON.parse(output) as StellaBrowserResponse);
        } catch {
          reject(
            new Error(stderr.trim() || "Failed to parse stella-browser output."),
          );
        }
      },
    );
  });

const getBrowserCookieHeader = async (
  stellaRoot: string,
  targetUrl: string,
): Promise<string | null> => {
  try {
    // Extension bridge (Chrome MV3), not CDP --auto-connect â€” see stella-browser `provider: extension`.
    const extensionEnv: Record<string, string> = {
      STELLA_BROWSER_AUTO_CONNECT: "false",
      ...getStellaBrowserBridgeEnv(),
    };
    const response = await runStellaBrowserJson(
      stellaRoot,
      ["--json", "cookies", "get", "--url", targetUrl],
      extensionEnv,
    );

    if (!response.success) {
      return null;
    }

    const data = response.data as { cookies?: BrowserCookie[] } | undefined;
    const cookies = data?.cookies ?? [];
    if (cookies.length === 0) {
      return null;
    }

    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return null;
  }
};

const fetchWithBrowserSession = async (
  stellaRoot: string,
  payload: { url: string; responseType: "json" | "text"; init?: BrowserFetchInit },
) => {
  const url = await normalizeUrlForPrivilegedRendererFetch(payload.url);
  const cookieHeader = await getBrowserCookieHeader(stellaRoot, url);
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

const getStellaRootOrThrow = (options: BrowserHandlersOptions) => {
  const stellaRoot = options.getStellaRoot();
  if (!stellaRoot?.trim()) {
    throw new Error("Stella root not available; restart the app.");
  }
  return stellaRoot;
};

export const registerBrowserHandlers = (options: BrowserHandlersOptions) => {
  ipcMain.handle(
    IPC_BROWSER_FETCH_JSON,
    async (event, payload: { url: string; init?: BrowserFetchInit }) => {
      if (!options.assertPrivilegedSender(event, IPC_BROWSER_FETCH_JSON)) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaRoot = getStellaRootOrThrow(options);
      return fetchWithBrowserSession(stellaRoot, {
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
      const stellaRoot = getStellaRootOrThrow(options);
      return fetchWithBrowserSession(stellaRoot, {
        url: payload.url,
        responseType: "text",
        init: payload.init,
      });
    },
  );

  // ── Media file operations ──

  ipcMain.handle(
    "media:saveOutput",
    async (
      event,
      payload: { url: string; fileName: string },
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      if (!options.assertPrivilegedSender(event, "media:saveOutput")) {
        return { ok: false, error: "Blocked untrusted request." };
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        return { ok: false, error: "Stella root not initialized" };
      }
      try {
        const dir = path.join(stellaRoot, "state", "media", "outputs");
        await fs.mkdir(dir, { recursive: true });
        const destPath = path.join(dir, payload.fileName);
        const safeUrl = await normalizeUrlForPrivilegedRendererFetch(payload.url);
        const res = await fetch(safeUrl, {
          headers: { "User-Agent": "StellaDesktop/1.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { ok: false, error: `Download failed (${res.status})` };
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(destPath, buffer);
        return { ok: true, path: destPath };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    "media:getStellaMediaDir",
    async (event): Promise<string | null> => {
      if (!options.assertPrivilegedSender(event, "media:getStellaMediaDir")) {
        return null;
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) return null;
      return path.join(stellaRoot, "state", "media");
    },
  );
};
