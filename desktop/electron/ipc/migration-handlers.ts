import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  detectThirdPartyMigrationSources,
  previewThirdPartyMigration,
  runThirdPartyMigration,
  type ThirdPartyMigrationSelection,
  type ThirdPartyMigrationSource,
} from "../../../runtime/kernel/migration/third-party-importers.js";
import {
  IPC_MIGRATION_DETECT_SOURCES,
  IPC_MIGRATION_PREVIEW,
  IPC_MIGRATION_RUN,
} from "../../src/shared/contracts/ipc-channels.js";

type MigrationHandlersOptions = {
  getStellaDataDir: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type MigrationPayload = {
  source?: unknown;
  sourceRoot?: unknown;
};

type RunMigrationPayload = MigrationPayload & {
  selection?: unknown;
};

const assertSource = (source: unknown): ThirdPartyMigrationSource => {
  if (source === "hermes" || source === "openclaw") {
    return source;
  }
  throw new Error("Unsupported import source.");
};

const normalizeSourceRoot = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeSelection = (
  value: unknown,
): ThirdPartyMigrationSelection | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ThirdPartyMigrationSelection;
};

export const registerMigrationHandlers = (
  options: MigrationHandlersOptions,
): void => {
  ipcMain.handle(IPC_MIGRATION_DETECT_SOURCES, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_MIGRATION_DETECT_SOURCES)) {
      throw new Error("Blocked untrusted migration detection request.");
    }
    return await detectThirdPartyMigrationSources();
  });

  ipcMain.handle(
    IPC_MIGRATION_PREVIEW,
    async (event, payload: MigrationPayload) => {
      if (!options.assertPrivilegedSender(event, IPC_MIGRATION_PREVIEW)) {
        throw new Error("Blocked untrusted migration preview request.");
      }
      return await previewThirdPartyMigration({
        source: assertSource(payload?.source),
        sourceRoot: normalizeSourceRoot(payload?.sourceRoot),
      });
    },
  );

  ipcMain.handle(
    IPC_MIGRATION_RUN,
    async (event, payload: RunMigrationPayload) => {
      if (!options.assertPrivilegedSender(event, IPC_MIGRATION_RUN)) {
        throw new Error("Blocked untrusted migration request.");
      }
      const stellaDataDir = options.getStellaDataDir();
      if (!stellaDataDir) {
        throw new Error("Stella home is not ready yet.");
      }
      return await runThirdPartyMigration({
        source: assertSource(payload?.source),
        sourceRoot: normalizeSourceRoot(payload?.sourceRoot),
        stellaDataDir,
        selection: normalizeSelection(payload?.selection),
      });
    },
  );
};
