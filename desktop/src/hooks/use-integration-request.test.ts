import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIntegrationRequest } from "./use-integration-request";

const mockUseAction = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

describe("useIntegrationRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns successful proxy response and toggles loading", async () => {
    const proxyAction = vi.fn().mockResolvedValue({ data: { ok: true } });
    mockUseAction.mockReturnValue(proxyAction);

    const { result } = renderHook(() => useIntegrationRequest());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    let response: unknown;
    await act(async () => {
      response = await result.current.execute({
        provider: "slack",
        request: { url: "https://api.example.com", method: "GET" },
        responseType: "json",
      });
    });

    expect(proxyAction).toHaveBeenCalledWith({
      provider: "slack",
      request: { url: "https://api.example.com", method: "GET" },
      responseType: "json",
    });
    expect(response).toEqual({ data: { ok: true } });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("stores error when proxy result contains error", async () => {
    const proxyAction = vi.fn().mockResolvedValue({ error: "Unauthorized" });
    mockUseAction.mockReturnValue(proxyAction);

    const { result } = renderHook(() => useIntegrationRequest());

    await act(async () => {
      await result.current.execute({
        provider: "discord",
        request: { url: "https://api.example.com" },
      });
    });

    expect(result.current.error).toBe("Unauthorized");
    expect(result.current.loading).toBe(false);
  });

  it("returns caught error when action throws", async () => {
    const proxyAction = vi.fn().mockRejectedValue(new Error("Network down"));
    mockUseAction.mockReturnValue(proxyAction);

    const { result } = renderHook(() => useIntegrationRequest());

    let response: unknown;
    await act(async () => {
      response = await result.current.execute({
        provider: "teams",
        request: { url: "https://api.example.com" },
      });
    });

    expect(response).toEqual({ error: "Network down" });
    expect(result.current.error).toBe("Network down");
    expect(result.current.loading).toBe(false);
  });
});
