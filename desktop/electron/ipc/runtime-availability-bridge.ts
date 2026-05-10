import { webContents } from "electron";
import { IPC_RUNTIME_AVAILABILITY } from "../../src/shared/contracts/ipc-channels.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { RuntimeAvailabilitySnapshot } from "../runtime-client-adapter.js";

type Options = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
};

/**
 * Forwards `RuntimeClientAdapter.onAvailabilityChange` to every renderer
 * via the `runtime:availability` IPC channel. The renderer's
 * `useResumeAgentRun` hook subscribes so it can re-run the chat-resume
 * flow whenever the host adapter reattaches to a detached worker (e.g.
 * after Electron itself restarted while the worker kept streaming).
 *
 * Idempotent across runner-changed events: if the lifecycle swaps the
 * runner instance (rare), we tear down the old subscription before
 * attaching the new one so we don't leak listeners.
 */
export const registerRuntimeAvailabilityBridge = ({
  getStellaHostRunner,
  onStellaHostRunnerChanged,
}: Options) => {
  let unsubscribeFromRunner: (() => void) | null = null;
  let lastSnapshotKey: string | null = null;

  const broadcast = (snapshot: RuntimeAvailabilitySnapshot) => {
    const snapshotKey = JSON.stringify(snapshot);
    if (lastSnapshotKey === snapshotKey) {
      return;
    }
    lastSnapshotKey = snapshotKey;
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      try {
        wc.send(IPC_RUNTIME_AVAILABILITY, snapshot);
      } catch {
        // Ignore renderer-side delivery failures (window closing, etc.)
      }
    }
  };

  const attach = (runner: StellaHostRunner | null) => {
    unsubscribeFromRunner?.();
    unsubscribeFromRunner = null;
    if (!runner) return;
    broadcast(runner.getAvailabilitySnapshot());
    unsubscribeFromRunner = runner.onAvailabilityChange((snapshot) => {
      broadcast(snapshot);
    });
  };

  attach(getStellaHostRunner());
  const unsubscribeFromLifecycle = onStellaHostRunnerChanged((runner) => {
    attach(runner);
  });

  return () => {
    unsubscribeFromRunner?.();
    unsubscribeFromRunner = null;
    unsubscribeFromLifecycle();
  };
};
