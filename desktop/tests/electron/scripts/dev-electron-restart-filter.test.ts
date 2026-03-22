import { describe, expect, it } from "vitest";
import { shouldRestartElectronForBuildPath } from "../../../scripts/dev-electron-restart-filter.mjs";

describe("dev-electron restart filter", () => {
  it("keeps extracted sidecar runtime packages on sidecar-only reloads", () => {
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/agent-core/agent.js"),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-worker/social-sessions/service.js"),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-capabilities/runtime.js"),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/cli/shared.js"),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("resources/bundled-commands/demo.js"),
    ).toBe(false);
  });

  it("keeps worker-owned services on sidecar-only reloads", () => {
    expect(
      shouldRestartElectronForBuildPath(
        "packages/runtime-worker/voice/service.js",
      ),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath(
        "packages/runtime-capabilities/markdown-commands.js",
      ),
    ).toBe(false);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/agent-core/src/types.js"),
    ).toBe(false);
  });

  it("restarts Electron for host-imported extracted package entrypoints", () => {
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/home/stella-home.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/model-routing.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-discovery/collect-all.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/dev-projects/dev-project-service.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/ai/stream.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-kernel/self-mod/src/git.js"),
    ).toBe(true);
  });

  it("still restarts Electron for runtime client, protocol, and host-kernel changes", () => {
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-client/index.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/runtime-protocol/index.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("packages/boundary-contracts/index.js"),
    ).toBe(true);
    expect(
      shouldRestartElectronForBuildPath("electron/self-mod/hmr-morph.js"),
    ).toBe(true);
  });
});
