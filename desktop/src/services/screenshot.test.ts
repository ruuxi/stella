import { describe, expect, it, vi, afterEach } from "vitest";
import { captureScreenshot } from "./screenshot";

describe("captureScreenshot", () => {
  afterEach(() => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("returns null when electronAPI is not available", async () => {
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
    const result = await captureScreenshot();
    expect(result).toBeNull();
  });

  it("returns null when captureScreenshot method is missing", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};
    const result = await captureScreenshot();
    expect(result).toBeNull();
  });

  it("calls electronAPI.captureScreenshot without point", async () => {
    const mockCapture = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,abc",
      width: 800,
      height: 600,
    });
    ((window as unknown as Record<string, unknown>)).electronAPI = { captureScreenshot: mockCapture };

    const result = await captureScreenshot();
    expect(mockCapture).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,abc",
      width: 800,
      height: 600,
    });
  });

  it("passes point parameter to electronAPI", async () => {
    const mockCapture = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,def",
      width: 100,
      height: 100,
    });
    ((window as unknown as Record<string, unknown>)).electronAPI = { captureScreenshot: mockCapture };

    const point = { x: 50, y: 75 };
    await captureScreenshot(point);
    expect(mockCapture).toHaveBeenCalledWith(point);
  });
});
