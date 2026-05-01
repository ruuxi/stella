/**
 * IPC for the install-update agent flow.
 *
 * The launcher writes `stella-install.json` to the install directory after
 * setup. We surface two read/write helpers here:
 *
 *   - `updates:getInstallManifest` — return the parsed manifest so the
 *     renderer can compare its `desktopReleaseCommit` against the
 *     reactive `currentDesktopRelease` Convex query.
 *   - `updates:recordAppliedCommit` — overwrite the manifest's
 *     `desktopReleaseCommit` after the install-update agent finishes
 *     applying upstream changes. The local "start" commit
 *     (`desktopInstallBaseCommit`) is left untouched.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  IPC_UPDATES_GET_INSTALL_MANIFEST,
  IPC_UPDATES_RECORD_APPLIED_COMMIT,
} from "../../src/shared/contracts/ipc-channels.js";

const INSTALL_MANIFEST_BASENAME = "stella-install.json";

export type InstallManifestSnapshot = {
  version: string;
  platform: string;
  installPath: string;
  installedAt: string;
  desktopReleaseTag: string | null;
  desktopReleaseCommit: string | null;
  desktopInstallBaseCommit: string | null;
};

export type UpdatesHandlersOptions = {
  getStellaRoot: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const manifestPathFromRoot = (stellaRoot: string): string =>
  path.join(stellaRoot, INSTALL_MANIFEST_BASENAME);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const requireString = (value: unknown, field: string): string => {
  const v = asString(value);
  if (!v) {
    throw new Error(`Install manifest field ${field} is missing or empty.`);
  }
  return v;
};

const parseManifest = (raw: string): InstallManifestSnapshot => {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    version: requireString(parsed.version, "version"),
    platform: requireString(parsed.platform, "platform"),
    installPath: requireString(parsed.installPath, "installPath"),
    installedAt: requireString(parsed.installedAt, "installedAt"),
    desktopReleaseTag: asString(parsed.desktopReleaseTag),
    desktopReleaseCommit: asString(parsed.desktopReleaseCommit),
    desktopInstallBaseCommit: asString(parsed.desktopInstallBaseCommit),
  };
};

export const registerUpdatesHandlers = (options: UpdatesHandlersOptions) => {
  ipcMain.handle(
    IPC_UPDATES_GET_INSTALL_MANIFEST,
    async (event): Promise<InstallManifestSnapshot | null> => {
      if (
        !options.assertPrivilegedSender(event, IPC_UPDATES_GET_INSTALL_MANIFEST)
      ) {
        throw new Error("Blocked untrusted updates:getInstallManifest request.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) return null;
      const manifestPath = manifestPathFromRoot(stellaRoot);
      try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        return parseManifest(raw);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }
    },
  );

  ipcMain.handle(
    IPC_UPDATES_RECORD_APPLIED_COMMIT,
    async (
      event,
      payload: { commit?: string },
    ): Promise<InstallManifestSnapshot | null> => {
      if (
        !options.assertPrivilegedSender(event, IPC_UPDATES_RECORD_APPLIED_COMMIT)
      ) {
        throw new Error(
          "Blocked untrusted updates:recordAppliedCommit request.",
        );
      }
      const commit = asString(payload?.commit);
      if (!commit) {
        throw new Error("commit is required.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella install directory is unavailable.");
      }
      const manifestPath = manifestPathFromRoot(stellaRoot);
      const raw = await fs.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.desktopReleaseCommit = commit;
      const next = `${JSON.stringify(parsed, null, 2)}\n`;
      await fs.writeFile(manifestPath, next, "utf-8");
      return parseManifest(next);
    },
  );
};
