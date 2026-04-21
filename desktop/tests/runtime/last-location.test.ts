import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Renderer-side persistence is the source of truth for "where was the user
 * when they last closed the app". This test pins the contract:
 *
 *  - We accept only well-formed paths (must start with `/`).
 *  - We refuse pathological values (oversize) so a corrupted store can't
 *    DoS the restore effect or stuff junk into navigate().
 *  - Round-trip is lossless for valid input.
 *  - Storage failures (no `localStorage`, quota errors) don't throw.
 */

const STORAGE_KEY = "stella:lastLocation";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

class ThrowingStorage implements Storage {
  readonly length = 0;
  clear() {
    throw new Error("nope");
  }
  getItem(): string | null {
    throw new Error("nope");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
  removeItem(): void {
    throw new Error("nope");
  }
  key(): string | null {
    throw new Error("nope");
  }
}

const installWindow = (storage: Storage | undefined) => {
  // Node lacks a window; fake just enough for the module to find/avoid it.
  (globalThis as unknown as { window?: { localStorage?: Storage } }).window =
    storage === undefined ? ({} as { localStorage?: Storage }) : { localStorage: storage };
};

const uninstallWindow = () => {
  delete (globalThis as unknown as { window?: unknown }).window;
};

const importFreshModule = async () => {
  // Bypass cache so each test sees a clean module instance.
  const mod = await import(`../../src/shared/lib/last-location?ts=${Date.now()}`);
  return mod as typeof import("../../src/shared/lib/last-location");
};

describe("last-location persistence", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    installWindow(storage);
  });

  afterEach(() => {
    uninstallWindow();
  });

  it("round-trips a valid path-only location", async () => {
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModule();
    writePersistedLastLocation("/settings");
    expect(storage.getItem(STORAGE_KEY)).toBe("/settings");
    expect(readPersistedLastLocation()).toBe("/settings");
  });

  it("round-trips a location with a search string", async () => {
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModule();
    writePersistedLastLocation("/chat?c=conv_abc123");
    expect(readPersistedLastLocation()).toBe("/chat?c=conv_abc123");
  });

  it("rejects values that don't start with /", async () => {
    const { readPersistedLastLocation } = await importFreshModule();
    storage.setItem(STORAGE_KEY, "javascript:alert(1)");
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("rejects pathologically large values", async () => {
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModule();
    const huge = "/chat?c=" + "x".repeat(5000);
    writePersistedLastLocation(huge);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    storage.setItem(STORAGE_KEY, huge);
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("returns null when nothing has been persisted", async () => {
    const { readPersistedLastLocation } = await importFreshModule();
    expect(readPersistedLastLocation()).toBeNull();
  });

  it("never throws when localStorage itself misbehaves", async () => {
    installWindow(new ThrowingStorage());
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModule();
    expect(readPersistedLastLocation()).toBeNull();
    expect(() => writePersistedLastLocation("/chat")).not.toThrow();
  });

  it("returns null when localStorage is unavailable (no window)", async () => {
    uninstallWindow();
    const { readPersistedLastLocation, writePersistedLastLocation } =
      await importFreshModule();
    expect(readPersistedLastLocation()).toBeNull();
    expect(() => writePersistedLastLocation("/chat")).not.toThrow();
  });
});
