/**
 * IPC for the user-facing "Live Memory" feature.
 *
 * Live Memory is the Chronicle screen-capture sidecar: a local Swift daemon
 * that captures the screen and runs OCR, with periodic distillation ticks
 * folding the deltas into markdown summaries.
 *
 * Dream — the background memory consolidator that folds thread_summaries
 * into `state/memories/MEMORY.md` — is a separate concern and is on by
 * default. It does not key off this toggle.
 *
 *   - `enable: true,  pending: true`  → user opted in but isn't signed in
 *     yet. We persist intent (`chronicle.pendingEnable`) but do NOT spawn
 *     the daemon. Once the user signs in after onboarding, the
 *     post-onboarding chrome calls `memory:promotePending` which flips it
 *     to a fully-enabled state.
 *   - `enable: true,  pending: false` → fully enable Chronicle (delegates
 *     to its existing controller for permission prompts + daemon spawn).
 *   - `enable: false`                 → fully disable and stop the daemon.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ChronicleController } from "../services/chronicle-controller.js";
import { ChronicleController as ChronicleControllerCtor } from "../services/chronicle-controller.js";
import { hasMacPermission } from "../utils/macos-permissions.js";

export type MemoryHandlersOptions = {
  getStellaRoot: () => string | null;
  getController: () => ChronicleController | null;
  setController: (controller: ChronicleController | null) => void;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const ensureController = (
  options: MemoryHandlersOptions,
): ChronicleController | null => {
  const existing = options.getController();
  if (existing) return existing;
  const root = options.getStellaRoot();
  if (!root) return null;
  const next = new ChronicleControllerCtor(root);
  options.setController(next);
  return next;
};

export type MemoryStatus = {
  /** Whether Live Memory (Chronicle daemon) is fully enabled. */
  enabled: boolean;
  /** Whether the user opted in but Live Memory is waiting on sign-in. */
  pending: boolean;
  /** Whether the Chronicle daemon is currently running. */
  running: boolean;
  /** Whether macOS Screen Recording permission is granted. */
  permission: boolean;
};

const buildStatus = async (
  controller: ChronicleController,
): Promise<MemoryStatus> => {
  const enabled = await controller.isEnabled();
  const pending = await controller.isPendingEnable();
  const rawStatus = await controller.status();
  const running =
    rawStatus != null &&
    typeof rawStatus === "object" &&
    (rawStatus as Record<string, unknown>).running === true;
  return {
    enabled,
    pending,
    running,
    permission: hasMacPermission("screen", false),
  };
};

export const registerMemoryHandlers = (
  options: MemoryHandlersOptions,
): void => {
  ipcMain.handle("memory:status", async (event) => {
    if (!options.assertPrivilegedSender(event, "memory:status")) {
      throw new Error("Blocked untrusted memory:status request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return {
        available: false,
        status: {
          enabled: false,
          pending: false,
          running: false,
          permission: false,
        } satisfies MemoryStatus,
      };
    }
    return { available: true, status: await buildStatus(controller) };
  });

  ipcMain.handle(
    "memory:setEnabled",
    async (
      event,
      payload: { enabled: boolean; pending?: boolean },
    ): Promise<{
      ok: boolean;
      status: MemoryStatus;
      reason?: string;
    }> => {
      if (!options.assertPrivilegedSender(event, "memory:setEnabled")) {
        throw new Error("Blocked untrusted memory:setEnabled request.");
      }
      const controller = ensureController(options);
      const root = options.getStellaRoot();
      if (!controller || !root) {
        return {
          ok: false,
          reason: "no-stella-root",
          status: {
            enabled: false,
            pending: false,
            running: false,
            permission: false,
          },
        };
      }

      const enabled = Boolean(payload?.enabled);
      const pending = Boolean(payload?.pending);

      if (!enabled) {
        const chronicle = await controller.setEnabled(false);
        return {
          ok: true,
          status: {
            enabled: false,
            pending: false,
            running: false,
            permission: chronicle.permission,
          },
        };
      }

      if (pending) {
        await controller.setPendingEnable(true);
        return { ok: true, status: await buildStatus(controller) };
      }

      const chronicle = await controller.setEnabled(true);
      if (!chronicle.ok) {
        return {
          ok: false,
          reason: chronicle.reason ?? "chronicle-failed",
          status: await buildStatus(controller),
        };
      }
      return { ok: true, status: await buildStatus(controller) };
    },
  );

  // Promote a previously-staged "pending" intent to a fully-enabled state.
  // Called by the post-onboarding chrome once the user signs in.
  ipcMain.handle("memory:promotePending", async (event) => {
    if (!options.assertPrivilegedSender(event, "memory:promotePending")) {
      throw new Error("Blocked untrusted memory:promotePending request.");
    }
    const controller = ensureController(options);
    const root = options.getStellaRoot();
    if (!controller || !root) {
      return {
        ok: false,
        promoted: false,
        reason: "no-stella-root",
      } as const;
    }
    if (!(await controller.isPendingEnable())) {
      return { ok: true, promoted: false } as const;
    }
    const chronicle = await controller.setEnabled(true);
    if (!chronicle.ok) {
      return {
        ok: false,
        promoted: false,
        reason: chronicle.reason ?? "chronicle-failed",
      } as const;
    }
    return { ok: true, promoted: true } as const;
  });
};
