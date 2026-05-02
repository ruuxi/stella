import type { QueuedOrchestratorTurn } from "./types.js";

const normalizeQueueError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export const executeOrQueueUserOrchestratorTurn = async <T>(args: {
  hasActiveRun: boolean;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  execute: () => Promise<T>;
}): Promise<T> => {
  if (!args.hasActiveRun) {
    return await args.execute();
  }

  return await new Promise<T>((resolve, reject) => {
    args.queueOrchestratorTurn({
      priority: "user",
      execute: async () => {
        try {
          resolve(await args.execute());
        } catch (error) {
          reject(normalizeQueueError(error));
        }
      },
    });
  });
};

export const executeOrQueueSystemOrchestratorTurn = async (args: {
  hasActiveRun: boolean;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  execute: (turn: QueuedOrchestratorTurn) => Promise<void>;
}): Promise<void> => {
  const queuedTurn: QueuedOrchestratorTurn = {
    priority: "system",
    execute: async () => {
      await args.execute(queuedTurn);
    },
  };

  if (args.hasActiveRun) {
    args.queueOrchestratorTurn(queuedTurn);
    return;
  }

  await queuedTurn.execute();
};
