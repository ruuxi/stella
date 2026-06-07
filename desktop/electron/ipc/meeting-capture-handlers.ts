import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { MeetingCaptureController } from "../services/meeting-capture-controller.js";
import { MeetingCaptureController as MeetingCaptureControllerCtor } from "../services/meeting-capture-controller.js";

export type MeetingCaptureHandlersOptions = {
  getStellaDataDir: () => string | null;
  getController: () => MeetingCaptureController | null;
  setController: (controller: MeetingCaptureController | null) => void;
  assertPrivilegedSender: (event: IpcMainInvokeEvent, channel: string) => boolean;
};

const ensureController = (
  options: MeetingCaptureHandlersOptions,
): MeetingCaptureController | null => {
  const existing = options.getController();
  if (existing) return existing;
  const home = options.getStellaDataDir();
  if (!home) return null;
  const next = new MeetingCaptureControllerCtor(home);
  options.setController(next);
  return next;
};

export const registerMeetingCaptureHandlers = (
  options: MeetingCaptureHandlersOptions,
): void => {
  ipcMain.handle("meetings:status", async (event) => {
    if (!options.assertPrivilegedSender(event, "meetings:status")) {
      throw new Error("Blocked untrusted meetings:status request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return { available: false } as const;
    }
    return await controller.status();
  });

  ipcMain.handle(
    "meetings:start",
    async (event, payload?: { sessionId?: string; segmentSeconds?: number }) => {
      if (!options.assertPrivilegedSender(event, "meetings:start")) {
        throw new Error("Blocked untrusted meetings:start request.");
      }
      const controller = ensureController(options);
      if (!controller) {
        return { ok: false, reason: "no-stella-home" } as const;
      }
      return await controller.start({
        sessionId: payload?.sessionId,
        segmentSeconds: payload?.segmentSeconds,
      });
    },
  );

  ipcMain.handle("meetings:pause", async (event) => {
    if (!options.assertPrivilegedSender(event, "meetings:pause")) {
      throw new Error("Blocked untrusted meetings:pause request.");
    }
    const controller = ensureController(options);
    if (!controller) return { ok: false } as const;
    return { ok: await controller.pause() } as const;
  });

  ipcMain.handle("meetings:resume", async (event) => {
    if (!options.assertPrivilegedSender(event, "meetings:resume")) {
      throw new Error("Blocked untrusted meetings:resume request.");
    }
    const controller = ensureController(options);
    if (!controller) return { ok: false } as const;
    return { ok: await controller.resume() } as const;
  });

  ipcMain.handle("meetings:stop", async (event) => {
    if (!options.assertPrivilegedSender(event, "meetings:stop")) {
      throw new Error("Blocked untrusted meetings:stop request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return { ok: false, reason: "no-stella-home" } as const;
    }
    return await controller.stop();
  });

  ipcMain.handle("meetings:openFolder", async (event, payload?: { sessionId?: string }) => {
    if (!options.assertPrivilegedSender(event, "meetings:openFolder")) {
      throw new Error("Blocked untrusted meetings:openFolder request.");
    }
    const home = options.getStellaDataDir();
    if (!home) return { ok: false } as const;
    const dir = payload?.sessionId
      ? path.join(home, "meetings", payload.sessionId)
      : path.join(home, "meetings");
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // best-effort
    }
    shell.openPath(dir);
    return { ok: true } as const;
  });
};
