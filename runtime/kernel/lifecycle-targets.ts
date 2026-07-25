import type {
  RuntimeActiveRun,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
} from "../protocol/index.js";

type Awaitable<T> = T | Promise<T>;

export type PiRunnerAuthHandle = {
  setAuthToken: (value: string | null) => void;
  setHasConnectedAccount: (value: boolean) => void;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
};

export type WindowManagerLike<TWindow = unknown> = {
  getFullWindow: () => TWindow | null;
};

export type WindowManagerTarget<TWindow = unknown> = {
  getWindowManager: () => WindowManagerLike<TWindow> | null;
};

export type StellaAppDirTarget = {
  getStellaAppDir: () => string | null;
};

export type StellaHostRunnerTarget = {
  getRunner: () => {
    runAutomationTurn: (
      payload: RuntimeAutomationTurnRequest,
    ) => Promise<RuntimeAutomationTurnResult>;
    getActiveOrchestratorRun: () => Awaitable<RuntimeActiveRun | null>;
    /**
     * Resume an existing agent thread with its own history. The scheduler
     * uses this for wakes armed by a subagent: `runAutomationTurn` would
     * start a fresh turn that has no idea what the agent was waiting for.
     */
    sendAgentInput: (payload: {
      conversationId: string;
      threadId: string;
      message: string;
      metadata?: Record<string, unknown>;
    }) => Promise<{ delivered: boolean }>;
  } | null;
};

export type PiRunnerTarget = {
  getRunner: () => PiRunnerAuthHandle | null;
};
