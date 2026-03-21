import type { WindowManager } from "../windows/window-manager.js";
import type {
  RuntimeActiveRun,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
} from "../../packages/stella-runtime-protocol/src/index.js";

type Awaitable<T> = T | Promise<T>;

export type PiRunnerAuthHandle = {
  setAuthToken: (value: string | null) => void;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
};

export type WindowManagerTarget = {
  getWindowManager: () => WindowManager | null;
};

export type StellaHomePathTarget = {
  getStellaHomePath: () => string | null;
};

export type StellaHostRunnerTarget = {
  getRunner: () => {
    runAutomationTurn: (
      payload: RuntimeAutomationTurnRequest,
    ) => Promise<RuntimeAutomationTurnResult>;
    getActiveOrchestratorRun: () => Awaitable<RuntimeActiveRun | null>;
  } | null;
};

export type PiRunnerTarget = {
  getRunner: () => PiRunnerAuthHandle | null;
};
