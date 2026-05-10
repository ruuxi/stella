import {
  RuntimeHostAdapter,
} from "./runtime-host-adapter.js";
import type {
  RuntimeHostHandlers,
  StellaRuntimeHostOptions,
} from "../../runtime/host/index.js";

export type StellaHostRunner = RuntimeHostAdapter;

export type StellaHostRunnerOptions = StellaRuntimeHostOptions;

export const createStellaHostRunner = (
  options: StellaRuntimeHostOptions,
): StellaHostRunner => new RuntimeHostAdapter(options);

export type { RuntimeHostHandlers };
