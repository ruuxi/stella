import { describe, expect, it } from "vitest";

import { classifyElectronExit } from "../../../scripts/dev-electron-exit-policy.mjs";

describe("dev Electron exit policy", () => {
  it("lets an explicit relaunch request restart after a clean exit", () => {
    expect(
      classifyElectronExit({
        code: 0,
        signal: null,
        explicitRestartRequested: true,
        watcherRestartRequested: false,
      }),
    ).toBe("restart");
  });

  it("lets a clean user quit outrank a deferred watcher restart", () => {
    expect(
      classifyElectronExit({
        code: 0,
        signal: null,
        explicitRestartRequested: false,
        watcherRestartRequested: true,
      }),
    ).toBe("wait-then-stop");
  });

  it("restarts an unexpectedly exited child when a watcher requested it", () => {
    expect(
      classifyElectronExit({
        code: null,
        signal: "SIGTERM",
        explicitRestartRequested: false,
        watcherRestartRequested: true,
      }),
    ).toBe("restart");
  });

  it("stops after an unexpected exit with no restart intent", () => {
    expect(
      classifyElectronExit({
        code: 1,
        signal: null,
        explicitRestartRequested: false,
        watcherRestartRequested: false,
      }),
    ).toBe("wait-then-stop");
  });
});
