import type { StellaHostRunner } from "../stella-host-runner.js";
import { createRuntimeUnavailableError } from "../../packages/runtime-protocol/rpc-peer.js";

export const waitForConnectedRunner = async (
  getStellaHostRunner: () => StellaHostRunner | null,
  {
    timeoutMs = 10_000,
    unavailableMessage = "Runtime not available.",
    onRunnerChanged,
  }: {
    timeoutMs?: number;
    unavailableMessage?: string;
    onRunnerChanged?: (
      listener: (runner: StellaHostRunner | null) => void,
    ) => () => void;
  } = {},
) => {
  return await new Promise<StellaHostRunner>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let unsubscribeRunner: (() => void) | null = null;
    let unsubscribeAvailability: (() => void) | null = null;
    let lastError: Error | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      unsubscribeAvailability?.();
      unsubscribeAvailability = null;
      unsubscribeRunner?.();
      unsubscribeRunner = null;
    };

    const tryResolve = (runner: StellaHostRunner | null) => {
      if (!runner) {
        return false;
      }
      const snapshot = runner.getAvailabilitySnapshot();
      if (!snapshot.connected) {
        if (snapshot.reason) {
          lastError = createRuntimeUnavailableError(snapshot.reason);
        }
        return false;
      }
      cleanup();
      resolve(runner);
      return true;
    };

    const attachRunner = (runner: StellaHostRunner | null) => {
      unsubscribeAvailability?.();
      unsubscribeAvailability = null;

      if (tryResolve(runner) || !runner) {
        return;
      }

      unsubscribeAvailability = runner.onAvailabilityChange((snapshot) => {
        if (snapshot.reason) {
          lastError = createRuntimeUnavailableError(snapshot.reason);
        }
        if (runner !== getStellaHostRunner()) {
          return;
        }
        if (!snapshot.connected) {
          return;
        }
        cleanup();
        resolve(runner);
      });
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(lastError ?? createRuntimeUnavailableError(unavailableMessage));
    }, timeoutMs);

    unsubscribeRunner = onRunnerChanged?.((runner) => {
      attachRunner(runner);
    }) ?? null;
    attachRunner(getStellaHostRunner());
  });
};
