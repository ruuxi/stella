import { describe, expect, it } from "vitest";

import {
  getSelfModHmrFlushMode,
  shouldRunSelfModHmrTransition,
} from "../../runtime/kernel/self-mod/flush-mode.js";

describe("self-mod HMR flush mode", () => {
  it("does not request a transition when only non-module files were queued", () => {
    expect(
      getSelfModHmrFlushMode({
        queuedModuleCount: 0,
        requiresFullReload: false,
      }),
    ).toBe("none");
    expect(
      shouldRunSelfModHmrTransition({
        queuedModules: 0,
        requiresFullReload: false,
      }),
    ).toBe(false);
  });

  it("requests a transition when renderer modules were queued", () => {
    expect(
      shouldRunSelfModHmrTransition({
        queuedModules: 1,
        requiresFullReload: false,
      }),
    ).toBe(true);
  });

  it("requests a transition when a full reload is required", () => {
    expect(
      shouldRunSelfModHmrTransition({
        queuedModules: 0,
        requiresFullReload: true,
      }),
    ).toBe(true);
  });
});
