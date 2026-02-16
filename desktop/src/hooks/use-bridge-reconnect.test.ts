import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBridgeAutoReconnect } from "./use-bridge-reconnect";

const mockUseQuery = vi.fn();
const mockUseAction = vi.fn();
const mockDeployAndStartLocalBridge = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

vi.mock("@/lib/bridge-local", () => ({
  deployAndStartLocalBridge: (...args: unknown[]) =>
    mockDeployAndStartLocalBridge(...args),
}));

describe("useBridgeAutoReconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.electronAPI;

    mockUseAction.mockReturnValue(vi.fn());
    mockUseQuery.mockImplementation((_ref: unknown, args: { provider: string }) => {
      if (args.provider === "whatsapp") return null;
      if (args.provider === "signal") return null;
      return null;
    });
  });

  it("restarts a local connected bridge when process is not running", async () => {
    const getBridgeBundle = vi.fn();
    mockUseAction.mockReturnValue(getBridgeBundle);
    mockUseQuery.mockImplementation((_ref: unknown, args: { provider: string }) => {
      if (args.provider === "whatsapp") {
        return { mode: "local", status: "connected" };
      }
      return null;
    });

    const bridgeStatus = vi.fn().mockResolvedValue({ running: false });
    const bridgeStop = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeStatus,
      bridgeStop,
    } as unknown as typeof window.electronAPI;

    mockDeployAndStartLocalBridge.mockResolvedValue(true);

    renderHook(() => useBridgeAutoReconnect());

    await waitFor(() => {
      expect(bridgeStatus).toHaveBeenCalledWith({ provider: "whatsapp" });
      expect(mockDeployAndStartLocalBridge).toHaveBeenCalledWith(
        "whatsapp",
        getBridgeBundle,
      );
    });
  });

  it("does not restart when bridge process is already running", async () => {
    mockUseQuery.mockImplementation((_ref: unknown, args: { provider: string }) => {
      if (args.provider === "whatsapp") {
        return { mode: "local", status: "awaiting_auth" };
      }
      return null;
    });

    const bridgeStatus = vi.fn().mockResolvedValue({ running: true });
    const bridgeStop = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeStatus,
      bridgeStop,
    } as unknown as typeof window.electronAPI;

    renderHook(() => useBridgeAutoReconnect());

    await waitFor(() => {
      expect(bridgeStatus).toHaveBeenCalledWith({ provider: "whatsapp" });
    });
    expect(mockDeployAndStartLocalBridge).not.toHaveBeenCalled();
  });

  it("stops orphaned local processes when status is stopped or error", async () => {
    mockUseQuery.mockImplementation((_ref: unknown, args: { provider: string }) => {
      if (args.provider === "whatsapp") {
        return { mode: "local", status: "stopped" };
      }
      if (args.provider === "signal") {
        return { mode: "local", status: "error" };
      }
      return null;
    });

    const bridgeStatus = vi.fn().mockResolvedValue({ running: false });
    const bridgeStop = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeStatus,
      bridgeStop,
    } as unknown as typeof window.electronAPI;

    renderHook(() => useBridgeAutoReconnect());

    await waitFor(() => {
      expect(bridgeStop).toHaveBeenCalledWith({ provider: "whatsapp" });
      expect(bridgeStop).toHaveBeenCalledWith({ provider: "signal" });
    });
  });

  it("ignores non-local sessions", async () => {
    mockUseQuery.mockImplementation((_ref: unknown, args: { provider: string }) => {
      if (args.provider === "whatsapp") {
        return { mode: "cloud", status: "connected" };
      }
      return null;
    });

    const bridgeStatus = vi.fn().mockResolvedValue({ running: false });
    const bridgeStop = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      bridgeStatus,
      bridgeStop,
    } as unknown as typeof window.electronAPI;

    renderHook(() => useBridgeAutoReconnect());

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bridgeStatus).not.toHaveBeenCalled();
    expect(bridgeStop).not.toHaveBeenCalled();
    expect(mockDeployAndStartLocalBridge).not.toHaveBeenCalled();
  });
});
