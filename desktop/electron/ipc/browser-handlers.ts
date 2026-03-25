import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  coreMemoryExists,
  detectPreferredBrowserProfile,
  listBrowserProfiles,
  writeCoreMemory,
  type BrowserData,
  type BrowserType,
} from "../../packages/runtime-discovery/browser-data.js";
import { normalizeSafeExternalUrl } from "../../packages/runtime-kernel/tools/network-guards.js";
import { getStellaBrowserBridgeEnv } from "../../packages/runtime-kernel/tools/stella-browser-bridge-config.js";
import type { AllUserSignalsResult } from "../../packages/runtime-discovery/types.js";

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
  getStellaHomePath: () => string | null;
  getFrontendRoot: () => string | null;
  getStellaHostRunner: () => import("../runtime-client-adapter.js").RuntimeClientAdapter | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const STELLA_BROWSER_TIMEOUT_MS = 30_000;

const runStellaBrowserJson = (
  frontendRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<StellaBrowserResponse> =>
  new Promise((resolve, reject) => {
    const binPath = path.join(
      frontendRoot,
      "stella-browser",
      "bin",
      "stella-browser.js",
    );

    execFile(
      process.execPath,
      [binPath, ...args],
      {
        cwd: frontendRoot,
        timeout: STELLA_BROWSER_TIMEOUT_MS,
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
  frontendRoot: string,
  targetUrl: string,
): Promise<string | null> => {
  try {
    // Extension bridge (Chrome MV3), not CDP --auto-connect â€” see stella-browser `provider: extension`.
    const extensionEnv: Record<string, string> = {
      STELLA_BROWSER_AUTO_CONNECT: "false",
      ...getStellaBrowserBridgeEnv(),
    };
    const response = await runStellaBrowserJson(
      frontendRoot,
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
  frontendRoot: string,
  payload: { url: string; responseType: "json" | "text"; init?: BrowserFetchInit },
) => {
  const url = await normalizeSafeExternalUrl(payload.url, {
    skipResolvedAddressCheck: process.env.NODE_ENV === "development",
  });
  const cookieHeader = await getBrowserCookieHeader(frontendRoot, url);
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
    signal: AbortSignal.timeout(STELLA_BROWSER_TIMEOUT_MS),
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

export const registerBrowserHandlers = (options: BrowserHandlersOptions) => {
  ipcMain.handle("browserData:exists", async () => {
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) return false;
    return coreMemoryExists(stellaHomePath);
  });

  ipcMain.handle(
    "browserData:collect",
    async (
      event,
      collectOptions?: { selectedBrowser?: BrowserType; selectedProfile?: string },
    ): Promise<{
      data: BrowserData | null;
      formatted: string | null;
      error?: string;
    }> => {
      if (!options.assertPrivilegedSender(event, "browserData:collect")) {
        throw new Error("Blocked untrusted request.");
      }
      const runner = options.getStellaHostRunner();
      if (!runner) {
        return { data: null, formatted: null, error: "Runtime not available" };
      }
      try {
        const result = await runner.collectBrowserData(collectOptions);
        return {
          data: result.data as BrowserData | null,
          formatted: result.formatted,
        };
      } catch (error) {
        return {
          data: null,
          formatted: null,
          error: (error as Error).message,
        };
      }
    },
  );

  ipcMain.handle(
    "browserData:writeCoreMemory",
    async (event, content: string) => {
      if (
        !options.assertPrivilegedSender(event, "browserData:writeCoreMemory")
      ) {
        throw new Error("Blocked untrusted request.");
      }
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        return { ok: false, error: "Stella home not initialized" };
      }
      try {
        await writeCoreMemory(stellaHomePath, content);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    "browserData:writeHomeCanvas",
    async (event, content: string) => {
      if (
        !options.assertPrivilegedSender(event, "browserData:writeHomeCanvas")
      ) {
        throw new Error("Blocked untrusted request.");
      }
      const frontendRoot = options.getFrontendRoot();
      if (!frontendRoot) {
        return { ok: false, error: "Frontend root not initialized" };
      }
      try {
        const filePath = path.join(frontendRoot, "src", "app", "home", "HomeCanvas.tsx");
        await fs.writeFile(filePath, content, "utf-8");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle("browserData:detectPreferredBrowser", async () => {
    return detectPreferredBrowserProfile();
  });

  ipcMain.handle(
    "browser:fetchJson",
    async (event, payload: { url: string; init?: BrowserFetchInit }) => {
      if (!options.assertPrivilegedSender(event, "browser:fetchJson")) {
        throw new Error("Blocked untrusted request.");
      }
      const frontendRoot = options.getFrontendRoot();
      if (!frontendRoot?.trim()) {
        throw new Error("Frontend root not available; restart the app.");
      }
      return fetchWithBrowserSession(frontendRoot, {
        url: payload.url,
        responseType: "json",
        init: payload.init,
      });
    },
  );

  ipcMain.handle(
    "browser:fetchText",
    async (event, payload: { url: string; init?: BrowserFetchInit }) => {
      if (!options.assertPrivilegedSender(event, "browser:fetchText")) {
        throw new Error("Blocked untrusted request.");
      }
      const frontendRoot = options.getFrontendRoot();
      if (!frontendRoot?.trim()) {
        throw new Error("Frontend root not available; restart the app.");
      }
      return fetchWithBrowserSession(frontendRoot, {
        url: payload.url,
        responseType: "text",
        init: payload.init,
      });
    },
  );

  ipcMain.handle(
    "browserData:listProfiles",
    async (_event, browserType: string) => {
      return listBrowserProfiles(browserType as BrowserType);
    },
  );

  ipcMain.handle(
    "signals:collectAll",
    async (
      event,
      ipcOptions?: {
        categories?: string[];
        selectedBrowser?: string;
        selectedProfile?: string;
      },
    ): Promise<AllUserSignalsResult> => {
      if (!options.assertPrivilegedSender(event, "signals:collectAll")) {
        throw new Error("Blocked untrusted request.");
      }
      const runner = options.getStellaHostRunner();
      if (!runner) {
        return { data: null, formatted: null, error: "Runtime not available" };
      }
      try {
        return await runner.collectAllSignals(ipcOptions) as AllUserSignalsResult;
      } catch (error) {
        return {
          data: null,
          formatted: null,
          error: (error as Error).message,
        };
      }
    },
  );

  ipcMain.handle("identity:getMap", async (event) => {
    if (!options.assertPrivilegedSender(event, "identity:getMap")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) return { version: 1, mappings: [] };
    const { loadIdentityMap } = await import(
      "../../packages/runtime-kernel/home/identity-map.js"
    );
    return loadIdentityMap(stellaHomePath);
  });

  ipcMain.handle("identity:depseudonymize", async (event, text: string) => {
    if (!options.assertPrivilegedSender(event, "identity:depseudonymize")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath || !text) return text;
    const { loadIdentityMap, depseudonymize } = await import(
      "../../packages/runtime-kernel/home/identity-map.js"
    );
    const map = await loadIdentityMap(stellaHomePath);
    if (map.mappings.length === 0) return text;
    return depseudonymize(text, map);
  });

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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        return { ok: false, error: "Stella home not initialized" };
      }
      try {
        const dir = path.join(stellaHomePath, "media", "outputs");
        await fs.mkdir(dir, { recursive: true });
        const destPath = path.join(dir, payload.fileName);
        const res = await fetch(payload.url);
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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) return null;
      return path.join(stellaHomePath, "media");
    },
  );
};
