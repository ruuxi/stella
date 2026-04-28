import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDefaultStellaDataRoot,
  resolveRuntimeStatePath,
  resolveStellaHome,
  resolveStellaStatePath,
} from "../../../../../runtime/kernel/home/stella-home.js";

describe("Stella state path resolution", () => {
  const previous = {
    STELLA_STATE: process.env.STELLA_STATE,
    STELLA_DATA_ROOT: process.env.STELLA_DATA_ROOT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to ~/.stella when no state path is configured", () => {
    delete process.env.STELLA_STATE;
    delete process.env.STELLA_DATA_ROOT;

    expect(resolveStellaStatePath()).toBe(path.join(os.homedir(), ".stella"));
    expect(resolveDefaultStellaDataRoot()).toBe(path.join(os.homedir(), ".stella"));
  });

  it("uses explicit state paths verbatim, including custom basenames", () => {
    delete process.env.STELLA_STATE;
    delete process.env.STELLA_DATA_ROOT;

    expect(resolveStellaStatePath("/tmp/stella-dev")).toBe("/tmp/stella-dev");
    expect(resolveStellaStatePath(undefined, "/tmp/explicit-state")).toBe("/tmp/explicit-state");
  });

  it("keeps resolveRuntimeStatePath explicit root compatibility", () => {
    delete process.env.STELLA_STATE;
    delete process.env.STELLA_DATA_ROOT;

    expect(resolveRuntimeStatePath(undefined, "/tmp/stella-repo")).toBe("/tmp/stella-repo/state");
  });

  it("exports STELLA_HOME as the app root and STELLA_STATE as ~/.stella", async () => {
    const root = path.join(os.tmpdir(), `stella-root-${Date.now()}`);
    const state = path.join(os.tmpdir(), `stella-state-${Date.now()}`);
    await resolveStellaHome({ getAppPath: () => root } as never, root, state);

    expect(process.env.STELLA_HOME).toBe(root);
    expect(process.env.STELLA_ROOT).toBe(root);
    expect(process.env.STELLA_STATE).toBe(state);
    expect(process.env.STELLA_DATA_ROOT).toBe(state);
  });
});
