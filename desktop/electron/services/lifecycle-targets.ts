import type { StellaHostRunner } from "../stella-host-runner.js";
import type { WindowManager } from "../windows/window-manager.js";

export type PiRunnerAuthTarget = Pick<
  StellaHostRunner,
  "setAuthToken" | "setConvexUrl"
>;

export type WindowManagerTarget = {
  getWindowManager: () => WindowManager | null;
};

export type StellaHomePathTarget = {
  getStellaHomePath: () => string | null;
};

export type StellaHostRunnerTarget = {
  getRunner: () => StellaHostRunner | null;
};

export type PiRunnerTarget = {
  getRunner: () => PiRunnerAuthTarget | null;
};
