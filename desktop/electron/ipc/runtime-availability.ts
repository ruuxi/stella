import type { StellaHostRunner } from "../stella-host-runner.js";
import { createRuntimeUnavailableError } from "../../packages/stella-runtime-protocol/src/rpc-peer.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const waitForConnectedRunner = async (
  getStellaHostRunner: () => StellaHostRunner | null,
  {
    timeoutMs = 10_000,
    unavailableMessage = "Runtime not available.",
    pollMs = 50,
    connectAttemptMs = 250,
  }: {
    timeoutMs?: number;
    unavailableMessage?: string;
    pollMs?: number;
    connectAttemptMs?: number;
  } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const runner = getStellaHostRunner();
    if (runner) {
      try {
        const remainingMs = deadline - Date.now();
        await runner.waitUntilConnected(
          Math.max(100, Math.min(connectAttemptMs, remainingMs)),
        );
        return runner;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error ?? unavailableMessage));
      }
    }
    await wait(pollMs);
  }

  throw lastError ?? createRuntimeUnavailableError(unavailableMessage);
};
