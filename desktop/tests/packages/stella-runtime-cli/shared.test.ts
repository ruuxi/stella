import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSocketPath,
  getTokenPath,
} from "../../../packages/runtime-kernel/cli/shared.js";

const ENV_KEYS = [
  "STELLA_UI_STATE_DIR",
  "STELLA_UI_SOCKET_PATH",
  "STELLA_UI_TOKEN_PATH",
  "STELLA_HOME",
  "STELLA_ROOT",
] as const;

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.chdir(ORIGINAL_CWD);
});

describe("runtime-kernel cli shared path resolution", () => {
  it("prefers Stella home-derived state paths over the current working directory", () => {
    process.chdir(path.resolve(ORIGINAL_CWD, ".."));
    process.env.STELLA_HOME = path.join(ORIGINAL_CWD, ".test-stella-home");

    expect(getTokenPath()).toBe(
      path.resolve(process.env.STELLA_HOME, "state", "stella-ui.token"),
    );
  });

  it("falls back to STELLA_ROOT when STELLA_HOME is not available", () => {
    process.env.STELLA_ROOT = path.join(ORIGINAL_CWD, ".test-stella-root");

    expect(getTokenPath()).toBe(
      path.resolve(process.env.STELLA_ROOT, ".stella", "state", "stella-ui.token"),
    );
  });

  it("keeps explicit CLI overrides as the highest-priority path source", () => {
    process.env.STELLA_HOME = path.join(ORIGINAL_CWD, ".test-stella-home");
    process.env.STELLA_UI_STATE_DIR = path.join(ORIGINAL_CWD, ".test-runtime-state");
    process.env.STELLA_UI_TOKEN_PATH = path.join(ORIGINAL_CWD, ".test-runtime-token");
    process.env.STELLA_UI_SOCKET_PATH = path.join(ORIGINAL_CWD, ".test-runtime-socket");

    expect(getTokenPath()).toBe(process.env.STELLA_UI_TOKEN_PATH);
    expect(getSocketPath()).toBe(process.env.STELLA_UI_SOCKET_PATH);
  });
});
