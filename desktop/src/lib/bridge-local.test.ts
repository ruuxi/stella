import { beforeEach, describe, expect, it, vi } from "vitest";
import { deployAndStartLocalBridge } from "./bridge-local";

describe("deployAndStartLocalBridge", () => {
  beforeEach(() => {
    delete window.electronAPI;
    vi.clearAllMocks();
  });

  it("returns false when electron API is unavailable", async () => {
    const getBridgeBundle = vi.fn();

    const result = await deployAndStartLocalBridge(
      "whatsapp",
      getBridgeBundle as never,
    );

    expect(result).toBe(false);
    expect(getBridgeBundle).not.toHaveBeenCalled();
  });

  it("deploys and starts using env from bundle", async () => {
    const bridgeDeploy = vi.fn().mockResolvedValue({ ok: true });
    const bridgeStart = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeDeploy,
      bridgeStart,
    } as unknown as typeof window.electronAPI;

    const getBridgeBundle = vi.fn().mockResolvedValue({
      code: "console.log('bridge')",
      env: { STELLA_BRIDGE_OWNER_ID: "owner-1" },
      dependencies: "ws@8.18.3",
    });

    const result = await deployAndStartLocalBridge(
      "signal",
      getBridgeBundle,
    );

    expect(result).toBe(true);
    expect(bridgeDeploy).toHaveBeenCalledWith({
      provider: "signal",
      code: "console.log('bridge')",
      env: { STELLA_BRIDGE_OWNER_ID: "owner-1" },
      dependencies: "ws@8.18.3",
    });
    expect(bridgeStart).toHaveBeenCalledWith({ provider: "signal" });
  });

  it("supports legacy config fallback when env is missing", async () => {
    const bridgeDeploy = vi.fn().mockResolvedValue({ ok: true });
    const bridgeStart = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeDeploy,
      bridgeStart,
    } as unknown as typeof window.electronAPI;

    const getBridgeBundle = vi.fn().mockResolvedValue({
      code: "console.log('bridge')",
      dependencies: "",
      config: '{"STELLA_BRIDGE_OWNER_ID":"owner-legacy"}',
    });

    const result = await deployAndStartLocalBridge(
      "whatsapp",
      getBridgeBundle as never,
    );

    expect(result).toBe(true);
    expect(bridgeDeploy).toHaveBeenCalledWith({
      provider: "whatsapp",
      code: "console.log('bridge')",
      env: { STELLA_BRIDGE_OWNER_ID: "owner-legacy" },
      dependencies: "",
    });
  });

  it("falls back to empty env when legacy config is invalid json", async () => {
    const bridgeDeploy = vi.fn().mockResolvedValue({ ok: true });
    const bridgeStart = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeDeploy,
      bridgeStart,
    } as unknown as typeof window.electronAPI;

    const getBridgeBundle = vi.fn().mockResolvedValue({
      code: "console.log('bridge')",
      dependencies: "",
      config: "{not-json}",
    });

    await deployAndStartLocalBridge("whatsapp", getBridgeBundle as never);

    expect(bridgeDeploy).toHaveBeenCalledWith({
      provider: "whatsapp",
      code: "console.log('bridge')",
      env: {},
      dependencies: "",
    });
  });

  it("throws when deploy fails", async () => {
    const bridgeDeploy = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "deploy failed" });
    const bridgeStart = vi.fn();
    window.electronAPI = {
      bridgeDeploy,
      bridgeStart,
    } as unknown as typeof window.electronAPI;

    const getBridgeBundle = vi.fn().mockResolvedValue({
      code: "console.log('bridge')",
      env: {},
      dependencies: "",
    });

    await expect(
      deployAndStartLocalBridge("signal", getBridgeBundle),
    ).rejects.toThrow("deploy failed");
    expect(bridgeStart).not.toHaveBeenCalled();
  });

  it("throws when start fails", async () => {
    const bridgeDeploy = vi.fn().mockResolvedValue({ ok: true });
    const bridgeStart = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "start failed" });
    window.electronAPI = {
      bridgeDeploy,
      bridgeStart,
    } as unknown as typeof window.electronAPI;

    const getBridgeBundle = vi.fn().mockResolvedValue({
      code: "console.log('bridge')",
      env: {},
      dependencies: "",
    });

    await expect(
      deployAndStartLocalBridge("signal", getBridgeBundle),
    ).rejects.toThrow("start failed");
  });
});
