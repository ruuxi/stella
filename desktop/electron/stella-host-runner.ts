import {
  RuntimeClientAdapter,
} from "./runtime-client-adapter.js";
import type {
  RuntimeHostHandlers,
  StellaRuntimeClientOptions,
} from "../packages/stella-runtime-client/src/index.js";

export type StellaHostRunner = RuntimeClientAdapter;

export type StellaHostRunnerOptions = StellaRuntimeClientOptions;

export const createStellaHostRunner = (
  options: StellaRuntimeClientOptions,
): StellaHostRunner => new RuntimeClientAdapter(options);

export type { RuntimeHostHandlers };
