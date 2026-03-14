import path from "path";
import { createStellaHostRunner as createRuntimeStellaHostRunner, type StellaHostRunnerOptions } from "./core/runtime/runner.js";
import { getDevServerUrl } from "./dev-url.js";
import { detectSelfModAppliedSince, getGitHead } from "./self-mod/git.js";
import { createSelfModHmrController } from "./self-mod/hmr.js";
import type { StoreModService } from "./self-mod/store-mod-service.js";

type ElectronStellaHostRunnerOptions = Omit<
  StellaHostRunnerOptions,
  "selfModHmrController" | "selfModMonitor" | "stellaBrowserBinPath" | "stellaUiCliPath" | "selfModLifecycle"
>;

type RuntimeStellaHostRunner = ReturnType<typeof createRuntimeStellaHostRunner>;

export type StellaHostRunner = Omit<RuntimeStellaHostRunner, "webSearch"> & {
  webSearch: (
    query: string,
    options?: {
      category?: string;
      displayResults?: boolean;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
};

export const createStellaHostRunner = (
  options: ElectronStellaHostRunnerOptions & {
    storeModService: StoreModService;
  },
): StellaHostRunner =>
  createRuntimeStellaHostRunner({
    ...options,
    selfModHmrController: createSelfModHmrController({
      getDevServerUrl,
      enabled: process.env.NODE_ENV === "development",
    }),
    selfModMonitor: {
      getBaselineHead: getGitHead,
      detectAppliedSince: detectSelfModAppliedSince,
    },
    selfModLifecycle: {
      beginRun: async ({ runId, taskDescription, featureId, packageId, releaseNumber, mode, displayName, description }) => {
        await options.storeModService.beginSelfModRun({
          runId,
          taskDescription,
          featureId,
          packageId,
          releaseNumber,
          applyMode: mode,
          displayName,
          description,
        });
      },
      finalizeRun: async ({ runId, succeeded }) => {
        await options.storeModService.finalizeSelfModRun({
          runId,
          succeeded,
        });
      },
      cancelRun: (runId) => {
        options.storeModService.cancelSelfModRun(runId);
      },
    },
    stellaBrowserBinPath: options.frontendRoot
      ? path.join(options.frontendRoot, "stella-browser", "bin", "stella-browser.js")
      : undefined,
    stellaUiCliPath: options.frontendRoot
      ? path.join(options.frontendRoot, "electron", "system", "stella-ui-cli.mjs")
      : undefined,
  }) as StellaHostRunner;
