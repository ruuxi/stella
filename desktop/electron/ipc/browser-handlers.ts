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
} from "../system/browser-data.js";
import { collectAllSignals } from "../system/collect-all.js";
import type { AllUserSignalsResult } from "../system/types.js";
import type { DiscoveryCategory } from "../../src/shared/contracts/discovery.js";

type BrowserHandlersOptions = {
  getStellaHomePath: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
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
    const { loadIdentityMap } = await import("../system/identity-map.js");
    return loadIdentityMap(stellaHomePath);
  });

  ipcMain.handle("identity:depseudonymize", async (event, text: string) => {
    if (!options.assertPrivilegedSender(event, "identity:depseudonymize")) {
      throw new Error("Blocked untrusted request.");
    }
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath || !text) return text;
    const { loadIdentityMap, depseudonymize } = await import(
      "../system/identity-map.js"
    );
    const map = await loadIdentityMap(stellaHomePath);
    if (map.mappings.length === 0) return text;
    return depseudonymize(text, map);
  });
};
