import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// We need to test device.ts which has module-level state (cachedDeviceId).
// Use dynamic import after resetting mocks to get fresh module state.

describe("device service", () => {
  const originalElectronAPI = ((window as unknown as Record<string, unknown>)).electronAPI;

  beforeEach(() => {
    localStorage.clear();
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalElectronAPI !== undefined) {
      ((window as unknown as Record<string, unknown>)).electronAPI = originalElectronAPI;
    } else {
      delete ((window as unknown as Record<string, unknown>)).electronAPI;
    }
  });

  describe("getOrCreateDeviceId", () => {
    it("returns cached id from electron API when available", async () => {
      const mockGetDeviceId = vi.fn().mockResolvedValue("electron-device-123");
      ((window as unknown as Record<string, unknown>)).electronAPI = {
        getDeviceId: mockGetDeviceId,
      };

      const { getOrCreateDeviceId } = await import("./device");
      const id = await getOrCreateDeviceId();
      expect(id).toBe("electron-device-123");
      expect(mockGetDeviceId).toHaveBeenCalled();
    });

    it("falls back to localStorage when electron API fails", async () => {
      const mockGetDeviceId = vi.fn().mockRejectedValue(new Error("fail"));
      ((window as unknown as Record<string, unknown>)).electronAPI = {
        getDeviceId: mockGetDeviceId,
      };
      localStorage.setItem("Stella.deviceId", "local-device-456");

      const { getOrCreateDeviceId } = await import("./device");
      const id = await getOrCreateDeviceId();
      expect(id).toBe("local-device-456");
    });

    it("falls back to localStorage when electron API returns falsy", async () => {
      const mockGetDeviceId = vi.fn().mockResolvedValue(null);
      ((window as unknown as Record<string, unknown>)).electronAPI = {
        getDeviceId: mockGetDeviceId,
      };
      localStorage.setItem("Stella.deviceId", "stored-id");

      const { getOrCreateDeviceId } = await import("./device");
      const id = await getOrCreateDeviceId();
      expect(id).toBe("stored-id");
    });

    it("generates a new device id when no API and no localStorage", async () => {
      const { getOrCreateDeviceId } = await import("./device");
      const id = await getOrCreateDeviceId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      // Should be persisted in localStorage
      expect(localStorage.getItem("Stella.deviceId")).toBe(id);
    });

    it("returns cached value on second call", async () => {
      const { getOrCreateDeviceId } = await import("./device");
      const first = await getOrCreateDeviceId();
      const second = await getOrCreateDeviceId();
      expect(first).toBe(second);
    });
  });

  describe("getCachedDeviceId", () => {
    it("returns null when nothing is cached or stored", async () => {
      const { getCachedDeviceId } = await import("./device");
      expect(getCachedDeviceId()).toBeNull();
    });

    it("returns localStorage value when not cached in memory", async () => {
      localStorage.setItem("Stella.deviceId", "from-storage");
      const { getCachedDeviceId } = await import("./device");
      expect(getCachedDeviceId()).toBe("from-storage");
    });
  });

  describe("configureLocalHost", () => {
    it("does nothing when electron API is absent", async () => {
      const { configureLocalHost } = await import("./device");
      // Should not throw
      await configureLocalHost();
    });

    it("does nothing when configureHost is not on the API", async () => {
      ((window as unknown as Record<string, unknown>)).electronAPI = {};
      const { configureLocalHost } = await import("./device");
      await configureLocalHost();
    });
  });
});
