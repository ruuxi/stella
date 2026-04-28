import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChronicleController } from "../services/chronicle-controller.js";
import { ChronicleController as ChronicleControllerCtor } from "../services/chronicle-controller.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../runtime/kernel/storage/database-init.js";
import { resolveStellaStatePath } from "../../../runtime/kernel/home/stella-home.js";
import type { SqliteDatabase } from "../../../runtime/kernel/storage/shared.js";

export type ChronicleHandlersOptions = {
  getStellaRoot: () => string | null;
  getController: () => ChronicleController | null;
  setController: (controller: ChronicleController | null) => void;
  assertPrivilegedSender: (event: IpcMainInvokeEvent, channel: string) => boolean;
  /** Called from `chronicle:dreamNow` to fire a manual Dream run. */
  triggerDreamNow: () => Promise<{
    ok: boolean;
    reason?: string;
    pendingThreadSummaries: number;
    pendingExtensions: number;
    detail?: string;
  }>;
};

const ensureController = (
  options: ChronicleHandlersOptions,
): ChronicleController | null => {
  const existing = options.getController();
  if (existing) return existing;
  const root = options.getStellaRoot();
  if (!root) return null;
  const next = new ChronicleControllerCtor(root);
  options.setController(next);
  return next;
};

const clearDreamThreadSummaries = (stellaRoot: string): void => {
  const db = new DatabaseSync(getDesktopDatabasePath(stellaRoot), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  try {
    initializeDesktopDatabase(db);
    db.exec("DELETE FROM thread_summaries;");
  } finally {
    db.close();
  }
};

export const registerChronicleHandlers = (
  options: ChronicleHandlersOptions,
): void => {
  ipcMain.handle("chronicle:status", async (event) => {
    if (!options.assertPrivilegedSender(event, "chronicle:status")) {
      throw new Error("Blocked untrusted chronicle:status request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return { available: false };
    }
    const raw = await controller.status();
    const enabled = await controller.isEnabled();
    if (!raw || typeof raw !== "object") {
      return { available: true, status: { enabled, running: false } };
    }
    const record = raw as Record<string, unknown>;
    const numberOrUndefined = (key: string): number | undefined =>
      typeof record[key] === "number" ? (record[key] as number) : undefined;
    const numberOrNull = (key: string): number | null => {
      if (typeof record[key] === "number") {
        return record[key] as number;
      }
      if (
        typeof record[key] === "string" &&
        (record[key] as string).trim().length > 0
      ) {
        const parsed = Date.parse(record[key] as string);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };
    const status = {
      enabled,
      running: Boolean(record.running ?? true),
      paused:
        typeof record.paused === "boolean" ? (record.paused as boolean) : undefined,
      fps: numberOrUndefined("fps"),
      captures: numberOrUndefined("captures"),
      lastCaptureAt: numberOrNull("lastCaptureAt"),
    };
    return { available: true, status };
  });

  ipcMain.handle(
    "chronicle:setEnabled",
    async (event, payload: { enabled: boolean }) => {
      if (!options.assertPrivilegedSender(event, "chronicle:setEnabled")) {
        throw new Error("Blocked untrusted chronicle:setEnabled request.");
      }
      const controller = ensureController(options);
      if (!controller) {
        return { ok: false, reason: "no-stella-root" } as const;
      }
      return await controller.setEnabled(Boolean(payload?.enabled));
    },
  );

  ipcMain.handle("chronicle:openMemoriesFolder", async (event) => {
    if (
      !options.assertPrivilegedSender(event, "chronicle:openMemoriesFolder")
    ) {
      throw new Error("Blocked untrusted chronicle:openMemoriesFolder request.");
    }
    const root = options.getStellaRoot();
    if (!root) return { ok: false } as const;
    const dir = path.join(resolveStellaStatePath(root), "memories");
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // best-effort
    }
    shell.openPath(dir);
    return { ok: true } as const;
  });

  ipcMain.handle("chronicle:dreamNow", async (event) => {
    if (!options.assertPrivilegedSender(event, "chronicle:dreamNow")) {
      throw new Error("Blocked untrusted chronicle:dreamNow request.");
    }
    return await options.triggerDreamNow();
  });

  ipcMain.handle("chronicle:wipeMemories", async (event) => {
    if (!options.assertPrivilegedSender(event, "chronicle:wipeMemories")) {
      throw new Error("Blocked untrusted chronicle:wipeMemories request.");
    }
    const root = options.getStellaRoot();
    if (!root) return { ok: false } as const;
    const controller = ensureController(options);
    let restartChronicle = false;
    if (controller) {
      const rawStatus = await controller.status();
      restartChronicle =
        rawStatus != null &&
        typeof rawStatus === "object" &&
        (rawStatus as Record<string, unknown>).running === true;
      await controller.stop();
    }
    const stateRoot = resolveStellaStatePath(root);
    const memoriesDir = path.join(stateRoot, "memories");
    const extensionsDir = path.join(stateRoot, "memories_extensions");
    const chronicleDir = path.join(stateRoot, "chronicle");
    const dreamLockDir = path.join(stateRoot, "locks", "dream");
    for (const target of [memoriesDir, extensionsDir, chronicleDir, dreamLockDir]) {
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    clearDreamThreadSummaries(root);
    if (restartChronicle && controller) {
      const result = await controller.start();
      if (!result.started) {
        return {
          ok: false,
          reason: `Failed to restart Chronicle after wipe: ${result.reason ?? "unknown"}`,
        } as const;
      }
    }
    return { ok: true } as const;
  });
};
