import type { HookEmitter } from "../../extensions/hook-emitter.js";
import type { SelfModMonitor } from "../types.js";
import { createPersonalityHook } from "./orchestrator/personality.hook.js";
import { createSelfModHooks } from "./orchestrator/self-mod.hook.js";

export type BundledHooksOptions = {
  stellaHome: string;
  /** Repo root used by self-mod hooks; distinct from mutable user-data root. */
  stellaRoot: string;
  selfModMonitor?: SelfModMonitor | null;
};

export const registerBundledHooks = (
  emitter: HookEmitter,
  opts: BundledHooksOptions,
): void => {
  emitter.register({
    ...createPersonalityHook({ stellaHome: opts.stellaHome }),
    source: "bundled",
  });
  for (const hook of createSelfModHooks({
    stellaRoot: opts.stellaRoot,
    selfModMonitor: opts.selfModMonitor,
  })) {
    emitter.register({ ...hook, source: "bundled" });
  }
};
