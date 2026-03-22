import { execFile } from "node:child_process";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  collectBrowserData,
  coreMemoryExists,
  detectPreferredBrowserProfile,
  formatBrowserDataForSynthesis,
  listBrowserProfiles,
  writeCoreMemory,
  type BrowserData,
  type BrowserType,
} from "../../packages/runtime-discovery/browser-data.js";
import { collectAllSignals } from "../../packages/runtime-discovery/collect-all.js";
import { normalizeSafeExternalUrl } from "../../packages/runtime-kernel/tools/network-guards.js";
import type { AllUserSignalsResult } from "../../packages/runtime-discovery/types.js";
import type { DiscoveryCategory } from "../../src/shared/contracts/discovery.js";

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
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const STELLA_BROWSER_TIMEOUT_MS = 30_000;

/** Must match app-agent shell overrides in `core/runtime/tools/shell.ts`. */
const DEFAULT_STELLA_BROWSER_EXT_PORT = "9224";

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
      STELLA_BROWSER_PROVIDER: "extension",
      STELLA_BROWSER_AUTO_CONNECT: "false",
      STELLA_BROWSER_SESSION: process.env.STELLA_BROWSER_SESSION ?? "default",
      STELLA_BROWSER_EXT_PORT:
        process.env.STELLA_BROWSER_EXT_PORT ?? DEFAULT_STELLA_BROWSER_EXT_PORT,
      STELLA_BROWSER_EXT_TOKEN: process.env.STELLA_BROWSER_EXT_TOKEN ?? "",
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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        return {
          data: null,
          formatted: null,
          error: "Stella home not initialized",
        };
      }
      try {
        const data = await collectBrowserData(stellaHomePath, collectOptions);
        const formatted = formatBrowserDataForSynthesis(data);
        return { data, formatted };
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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        return {
          data: null,
          formatted: null,
          error: "Stella home not initialized",
        };
      }
      const categories = ipcOptions?.categories as
        | DiscoveryCategory[]
        | undefined;
      return collectAllSignals(
        stellaHomePath,
        categories,
        ipcOptions?.selectedBrowser,
        ipcOptions?.selectedProfile,
      );
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
};
