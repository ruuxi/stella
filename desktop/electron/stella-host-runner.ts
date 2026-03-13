import path from "path";
import { createStellaHostRunner as createRuntimeStellaHostRunner, type StellaHostRunnerOptions } from "./core/runtime/runner.js";
import { getDevServerUrl } from "./dev-url.js";
import { detectSelfModAppliedSince, getGitHead } from "./self-mod/git.js";
import { createSelfModHmrController } from "./self-mod/hmr.js";

type ElectronStellaHostRunnerOptions = Omit<
  StellaHostRunnerOptions,
  "selfModHmrController" | "selfModMonitor" | "stellaBrowserBinPath" | "stellaUiCliPath"
>;

type RuntimeStellaHostRunner = ReturnType<typeof createRuntimeStellaHostRunner>;

export type StellaHostRunner = Omit<RuntimeStellaHostRunner, "webSearch"> & {
  webSearch: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
};

export const createStellaHostRunner = (
  options: ElectronStellaHostRunnerOptions,
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
    stellaBrowserBinPath: options.frontendRoot
      ? path.join(options.frontendRoot, "stella-browser", "bin", "stella-browser.js")
      : undefined,
    stellaUiCliPath: options.frontendRoot
      ? path.join(options.frontendRoot, "electron", "system", "stella-ui-cli.mjs")
      : undefined,
  }) as StellaHostRunner;
