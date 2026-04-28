/**
 * IPC for the user-facing "Live Memory" feature.
 *
 * Live Memory is a single product concept exposed to users (via onboarding
 * and Settings) that combines two backend concepts:
 *
 *   1. Chronicle daemon — captures the screen and runs OCR locally.
 *   2. Dream protocol   — periodically consolidates captures + thread
 *                         summaries into long-lived memories.
 *
 * Both are gated by `~/.stella/config.json`. Onboarding only ever shows ONE
 * toggle, so this handler keeps the two concerns in lockstep:
 *
 *   - `enable: true,  pending: true`  → user opted in but isn't signed in
 *     yet. We persist intent (`chronicle.pendingEnable`, `dream.enabled`
 *     stays false) but do NOT spawn the daemon. Once the user signs in
 *     after onboarding, the post-onboarding chrome calls
 *     `memory:promotePending` which flips both to fully enabled.
 *   - `enable: true,  pending: false` → fully enable both Chronicle and
 *     Dream (delegates Chronicle to its existing controller for
 *     permission prompts + daemon spawn).
 *   - `enable: false`                 → fully disable both and stop the
 *     daemon.
 *
 * The renderer never has to learn the difference between Chronicle and
 * Dream. It just calls `memory.setEnabled(true | false, { pending })`.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStellaStatePath } from "../../../runtime/kernel/home/stella-home.js";
import type { ChronicleController } from "../services/chronicle-controller.js";
import { ChronicleController as ChronicleControllerCtor } from "../services/chronicle-controller.js";
import { hasMacPermission } from "../utils/macos-permissions.js";

export type MemoryHandlersOptions = {
  getStellaRoot: () => string | null;
  getStellaStatePath: () => string | null;
  getController: () => ChronicleController | null;
  setController: (controller: ChronicleController | null) => void;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type DreamConfigPatch = { enabled: boolean };

type StellaConfig = {
  dream?: DreamConfigPatch;
  [key: string]: unknown;
};

const writeDreamPatch = async (
  stellaStatePath: string,
  patch: DreamConfigPatch,
): Promise<void> => {
  const configPath = path.join(resolveStellaStatePath(stellaStatePath), "config.json");
  let current: StellaConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    current = JSON.parse(raw) as StellaConfig;
  } catch {
    current = {};
  }
  const next: StellaConfig = {
    ...current,
    dream: { ...(current.dream ?? {}), ...patch },
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
};

const ensureController = (
  options: MemoryHandlersOptions,
): ChronicleController | null => {
  const existing = options.getController();
  if (existing) return existing;
  const root = options.getStellaStatePath();
  if (!root) return null;
  const next = new ChronicleControllerCtor(root);
  options.setController(next);
  return next;
};

export type MemoryStatus = {
  /** Whether Live Memory is fully enabled (Chronicle daemon + Dream). */
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
      const root = options.getStellaStatePath();
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

      // Disable path: turn off both Chronicle and Dream.
      if (!enabled) {
        const chronicle = await controller.setEnabled(false);
        await writeDreamPatch(root, { enabled: false });
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

      // Enable + pending: stage intent, never spawn the daemon. We also
      // hold off enabling Dream — without auth there's no model route, so
      // a manual `triggerDreamNow` call would still fail. The post-
      // onboarding chrome promotes this to a full enable once sign-in
      // succeeds.
      if (pending) {
        await controller.setPendingEnable(true);
        await writeDreamPatch(root, { enabled: false });
        return { ok: true, status: await buildStatus(controller) };
      }

      // Enable + not pending: fully enable. Chronicle handles its own
      // permission prompt and rolls back on denial; we mirror its result
      // onto Dream so the two never disagree.
      const chronicle = await controller.setEnabled(true);
      if (!chronicle.ok) {
        await writeDreamPatch(root, { enabled: false });
        return {
          ok: false,
          reason: chronicle.reason ?? "chronicle-failed",
          status: await buildStatus(controller),
        };
      }
      await writeDreamPatch(root, { enabled: true });
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
    const root = options.getStellaStatePath();
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
      // Failure leaves pending cleared (setEnabled clears it on failure
      // too); user can re-toggle from Settings if they fix the issue.
      return {
        ok: false,
        promoted: false,
        reason: chronicle.reason ?? "chronicle-failed",
      } as const;
    }
    await writeDreamPatch(root, { enabled: true });
    return { ok: true, promoted: true } as const;
  });
};
