import path from "path";
import { createStellaHostRunner as createRuntimeStellaHostRunner, type StellaHostRunnerOptions } from "../packages/stella-runtime/src/runner.js";
import { getDevServerUrl } from "./dev-url.js";
import { createSelfModHmrController } from "./self-mod/hmr.js";

type ElectronStellaHostRunnerOptions = Omit<
  StellaHostRunnerOptions,
  "selfModHmrController" | "stellaBrowserBinPath" | "stellaUiCliPath"
>;

export type StellaHostRunner = ReturnType<typeof createRuntimeStellaHostRunner>;

export const createStellaHostRunner = (
  options: ElectronStellaHostRunnerOptions,
): StellaHostRunner =>
  createRuntimeStellaHostRunner({
    ...options,
    selfModHmrController: createSelfModHmrController({
      getDevServerUrl,
      enabled: process.env.NODE_ENV === "development",
    }),
    stellaBrowserBinPath: options.frontendRoot
      ? path.join(options.frontendRoot, "stella-browser", "bin", "stella-browser.js")
      : undefined,
    stellaUiCliPath: options.frontendRoot
      ? path.join(options.frontendRoot, "electron", "system", "stella-ui-cli.mjs")
      : undefined,
  });
