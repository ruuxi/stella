import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { BrowserData, BrowserType } from "../../../runtime/discovery/browser-data.js";
import type { AllUserSignalsResult } from "../../../runtime/discovery/types.js";
import type { DiscoveryKnowledgeSeedPayload } from "../../../runtime/contracts/discovery.js";
import {
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
} from "../../src/shared/contracts/ipc-channels.js";

type DiscoveryHandlersOptions = {
  getStellaHostRunner: () => import("../runtime-host-adapter.js").RuntimeHostAdapter | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const collectWithRunnerEnvelope = async <T extends { data: unknown; formatted: string | null }>(
  options: DiscoveryHandlersOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  action: (
    runner: NonNullable<ReturnType<DiscoveryHandlersOptions["getStellaHostRunner"]>>,
  ) => Promise<T>,
): Promise<{ data: T["data"] | null; formatted: string | null; error?: string }> => {
  if (!options.assertPrivilegedSender(event, channel)) {
    throw new Error("Blocked untrusted request.");
  }
  const runner = options.getStellaHostRunner();
  if (!runner) {
    return { data: null, formatted: null, error: "Runtime not available" };
  }
  try {
    return await action(runner);
  } catch (error) {
    return {
      data: null,
      formatted: null,
      error: (error as Error).message,
    };
  }
};

export const registerDiscoveryHandlers = (options: DiscoveryHandlersOptions) => {
  ipcMain.handle(IPC_DISCOVERY_CORE_MEMORY_EXISTS, async () => {
    const runner = options.getStellaHostRunner();
    if (!runner) return false;
    try {
      return await runner.coreMemoryExists();
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_DISCOVERY_KNOWLEDGE_EXISTS, async () => {
    const runner = options.getStellaHostRunner();
    if (!runner) return false;
    try {
      return await runner.discoveryKnowledgeExists();
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    IPC_DISCOVERY_COLLECT_BROWSER_DATA,
    async (
      event,
      collectOptions?: { selectedBrowser?: BrowserType; selectedProfile?: string },
    ): Promise<{
      data: BrowserData | null;
      formatted: string | null;
      error?: string;
    }> =>
      await collectWithRunnerEnvelope(
        options,
        event,
        IPC_DISCOVERY_COLLECT_BROWSER_DATA,
        async (runner) => {
          const result = await runner.collectBrowserData(collectOptions);
          return {
            data: result.data as BrowserData | null,
            formatted: result.formatted,
          };
        },
      ),
  );

  ipcMain.handle(
    IPC_DISCOVERY_WRITE_CORE_MEMORY,
    async (
      event,
      payload: string | { content: string; includeLocation?: boolean },
    ) => {
      if (!options.assertPrivilegedSender(event, IPC_DISCOVERY_WRITE_CORE_MEMORY)) {
        throw new Error("Blocked untrusted request.");
      }
      const runner = options.getStellaHostRunner();
      if (!runner) {
        return { ok: false, error: "Runtime not available" };
      }
      const content = typeof payload === "string" ? payload : payload.content;
      const includeLocation =
        typeof payload === "string" ? false : payload.includeLocation === true;
      try {
        await runner.writeCoreMemory(content, { includeLocation });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(
    IPC_DISCOVERY_WRITE_KNOWLEDGE,
    async (event, payload: DiscoveryKnowledgeSeedPayload) => {
      if (!options.assertPrivilegedSender(event, IPC_DISCOVERY_WRITE_KNOWLEDGE)) {
        throw new Error("Blocked untrusted request.");
      }
      const runner = options.getStellaHostRunner();
      if (!runner) {
        return { ok: false, error: "Runtime not available" };
      }
      try {
        await runner.writeDiscoveryKnowledge(payload);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_DISCOVERY_DETECT_PREFERRED_BROWSER, async () => {
    const runner = options.getStellaHostRunner();
    if (!runner) return null;
    try {
      return await runner.detectPreferredBrowserProfile();
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    IPC_DISCOVERY_LIST_BROWSER_PROFILES,
    async (_event, browserType: string) => {
      const runner = options.getStellaHostRunner();
      if (!runner) return [];
      try {
        return await runner.listBrowserProfiles(browserType);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
    async (
      event,
      ipcOptions?: {
        categories?: string[];
        selectedBrowser?: string;
        selectedProfile?: string;
      },
    ): Promise<AllUserSignalsResult> =>
      await collectWithRunnerEnvelope(
        options,
        event,
        IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
        async (runner) => await runner.collectAllSignals(ipcOptions) as AllUserSignalsResult,
      ),
  );
};
