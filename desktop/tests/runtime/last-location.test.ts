import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renderer-side persistence is the source of truth for "where was the user
 * when they last closed the app". Backed by the shared UI state store
 * (`~/.stella/ui-state.json`) via the `uiState` client. This test pins the
 * contract:
 *
 *  - We accept only well-formed paths (must start with `/`).
 *  - We refuse pathological values (oversize) so a corrupted store can't
 *    DoS the restore effect or stuff junk into navigate().
 *  - Round-trip is lossless for valid input.
 *  - Windowless / misbehaving-localStorage environments don't throw.
 */

const STORAGE_KEY = "stella:lastLocation";

type FakeWindow = {
  __stellaUiState?: Record<string, string>;
  localStorage?: Storage;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  location: { href: string };
};

const installWindow = (overrides: Partial<FakeWindow> = {}) => {
  (globalThis as unknown as { window?: FakeWindow }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: "https://stella.test/" },
    ...overrides,
  };
};

const uninstallWindow = () => {
  delete (globalThis as unknown as { window?: unknown }).window;
};

// The uiState client caches its in-memory map at module scope, so each test
// re-imports a fresh module graph against the current fake window.
const importFreshModules = async () => {
  vi.resetModules();
  const { uiState } = await import("../../src/platform/ui-state");
  const lastLocation = await import("../../src/shared/lib/last-location");
  return { uiState, ...lastLocation };
};

describe("last-location persistence", () => {
  beforeEach(() => {
    installWindow({ __stellaUiState: {} });
  });

  afterEach(() => {
    uninstallWindow();
  });

  it("round-trips a valid path-only location", async () => {
    const { uiState, readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModules();
    writePersistedLastLocation("/settings");
    expect(uiState.getItem(STORAGE_KEY)).toBe("/settings");
    expect(readPersistedLastLocation()).toBe("/settings");
  });

  it("round-trips a location with a search string", async () => {
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModules();
    writePersistedLastLocation("/chat?c=conv_abc123");
    expect(readPersistedLastLocation()).toBe("/chat?c=conv_abc123");
  });

  it("rejects values that don't start with /", async () => {
    installWindow({
      __stellaUiState: { [STORAGE_KEY]: "javascript:alert(1)" },
    });
    const { readPersistedLastLocation } = await importFreshModules();
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("rejects pathologically large values", async () => {
    const huge = "/chat?c=" + "x".repeat(5000);
    const { uiState, readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModules();
    writePersistedLastLocation(huge);
    expect(uiState.getItem(STORAGE_KEY)).toBeNull();
    uiState.setItem(STORAGE_KEY, huge);
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("returns null when nothing has been persisted", async () => {
    const { readPersistedLastLocation } = await importFreshModules();
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("never throws when legacy localStorage misbehaves at import", async () => {
    const throwing = new Proxy({} as Storage, {
      get() {
        throw new Error("nope");
      },
    });
    installWindow({ __stellaUiState: {}, localStorage: throwing });
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModules();
    expect(readPersistedLastLocation()).toBeNull();
    expect(() => writePersistedLastLocation("/chat")).not.toThrow();
  });

  it("works in-memory when no window exists", async () => {
    uninstallWindow();
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModules();
    expect(readPersistedLastLocation()).toBeNull();
    expect(() => writePersistedLastLocation("/chat")).not.toThrow();
    expect(readPersistedLastLocation()).toBe("/chat");
  });
});
