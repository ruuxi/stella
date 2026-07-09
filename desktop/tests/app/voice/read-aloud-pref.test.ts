import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("read-aloud preference store", () => {
  it("applies changes broadcast from another renderer", async () => {
    let onChanged: ((enabled: boolean) => void) | undefined;
    vi.stubGlobal("window", {
      electronAPI: {
        system: {
          getReadAloudEnabled: vi.fn().mockResolvedValue(true),
          onReadAloudEnabledChanged: vi.fn(
            (callback: (enabled: boolean) => void) => {
              onChanged = callback;
              return () => undefined;
            },
          ),
        },
      },
    });

    const { readAloudPrefStore } = await import(
      "@/features/voice/services/read-aloud/read-aloud-pref"
    );
    const listener = vi.fn();
    const unsubscribe = readAloudPrefStore.subscribe(listener);
    await vi.waitFor(() => {
      expect(readAloudPrefStore.getSnapshot()).toBe(true);
    });

    onChanged?.(false);

    expect(readAloudPrefStore.getSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("does not let a stale initial read overwrite a broadcast", async () => {
    let resolveInitial: ((enabled: boolean) => void) | undefined;
    let onChanged: ((enabled: boolean) => void) | undefined;
    vi.stubGlobal("window", {
      electronAPI: {
        system: {
          getReadAloudEnabled: vi.fn(
            () =>
              new Promise<boolean>((resolve) => {
                resolveInitial = resolve;
              }),
          ),
          onReadAloudEnabledChanged: vi.fn(
            (callback: (enabled: boolean) => void) => {
              onChanged = callback;
              return () => undefined;
            },
          ),
        },
      },
    });

    const { readAloudPrefStore } = await import(
      "@/features/voice/services/read-aloud/read-aloud-pref"
    );
    const unsubscribe = readAloudPrefStore.subscribe(() => undefined);

    onChanged?.(false);
    resolveInitial?.(true);
    await Promise.resolve();

    expect(readAloudPrefStore.getSnapshot()).toBe(false);
    unsubscribe();
  });
});
