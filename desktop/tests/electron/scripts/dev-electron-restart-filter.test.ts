import { describe, expect, it } from "vitest";
import { shouldRestartElectronForBuildPath } from "../../../scripts/dev-electron-restart-filter.mjs";

describe("dev-electron restart filter", () => {
  it("restarts Electron for shared core runtime modules", () => {
    expect(
      shouldRestartElectronForBuildPath("electron/core/runtime/model-routing.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("electron/core/runtime/storage/llm-credentials.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("electron/core/runtime/tools/network-guards.js"),
    ).toBe(true);
  });

  it("keeps worker-owned services on sidecar-only reloads", () => {
    expect(
      shouldRestartElectronForBuildPath(
        "electron/services/local-scheduler-service.js",
      ),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath(
        "packages/stella-runtime-worker/src/social-sessions/service.js",
      ),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("electron/system/device.js"),
    ).toBe(false);
  });

  it("still restarts Electron for runtime client and protocol changes", () => {
    expect(
      shouldRestartElectronForBuildPath(
        "packages/stella-runtime-client/src/index.js",
      ),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath(
        "packages/stella-runtime-protocol/src/index.js",
      ),
    ).toBe(true);
  });
});
