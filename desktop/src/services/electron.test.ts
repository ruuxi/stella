import { describe, expect, it, afterEach } from "vitest";
import { getElectronApi } from "./electron";

describe("getElectronApi", () => {
  const originalElectronAPI = ((window as unknown as Record<string, unknown>)).electronAPI;

  afterEach(() => {
    if (originalElectronAPI !== undefined) {
      ((window as unknown as Record<string, unknown>)).electronAPI = originalElectronAPI;
    } else {
      delete ((window as unknown as Record<string, unknown>)).electronAPI;
    }
  });

  it("returns electronAPI when present on window", () => {
    const fakeApi = { getDeviceId: () => Promise.resolve("test-id") };
    ((window as unknown as Record<string, unknown>)).electronAPI = fakeApi;
    expect(getElectronApi()).toBe(fakeApi);
  });

  it("returns undefined when electronAPI is not on window", () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    expect(getElectronApi()).toBeUndefined();
  });
});
