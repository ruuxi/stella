import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock the electron service
vi.mock("../../services/electron", () => ({
  getElectronApi: vi.fn(() => undefined),
}));

import { useContextCapture } from "./use-context-capture";
import { getElectronApi } from "../../services/electron";

const mockGetElectronApi = getElectronApi as ReturnType<typeof vi.fn>;

describe("useContextCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetElectronApi.mockReturnValue(undefined);
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Initial state
  // ----------------------------------------------------------------
  describe("initial state", () => {
    it("starts with null chatContext and selectedText", () => {
      const { result } = renderHook(() => useContextCapture());

      expect(result.current.chatContext).toBeNull();
      expect(result.current.selectedText).toBeNull();
      expect(result.current.shellVisible).toBe(false);
      expect(result.current.previewIndex).toBeNull();
    });

    it("provides setter functions", () => {
      const { result } = renderHook(() => useContextCapture());

      expect(typeof result.current.setChatContext).toBe("function");
      expect(typeof result.current.setSelectedText).toBe("function");
      expect(typeof result.current.setPreviewIndex).toBe("function");
    });
  });

  // ----------------------------------------------------------------
  // Without Electron API
  // ----------------------------------------------------------------
  describe("without electron API", () => {
    it("does not subscribe to any callbacks", () => {
      renderHook(() => useContextCapture());
      // No errors thrown, and getElectronApi was called
      expect(mockGetElectronApi).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // With Electron API
  // ----------------------------------------------------------------
  describe("with electron API", () => {
    it("fetches initial context from getChatContext", async () => {
      const mockContext = {
        window: {
          title: "Test Window",
          app: "TestApp",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
        selectedText: "selected snippet",
      };

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(mockContext),
        onChatContext: vi.fn(() => vi.fn()),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      // Wait for the promise to settle
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(result.current.chatContext).toEqual(mockContext);
      expect(result.current.selectedText).toBe("selected snippet");
    });

    it("handles getChatContext returning null", async () => {
      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn(() => vi.fn()),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(result.current.chatContext).toBeNull();
      expect(result.current.selectedText).toBeNull();
    });

    it("handles getChatContext error gracefully", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockApi = {
        getChatContext: vi.fn().mockRejectedValue(new Error("fail")),
        onChatContext: vi.fn(() => vi.fn()),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(result.current.chatContext).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to load chat context",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("subscribes to onMiniVisibility and updates shellVisible", async () => {
      let visibilityCallback: ((visible: boolean) => void) | null = null;

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn(() => vi.fn()),
        onMiniVisibility: vi.fn((cb: (visible: boolean) => void) => {
          visibilityCallback = cb;
          return vi.fn();
        }),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      expect(result.current.shellVisible).toBe(false);

      act(() => {
        visibilityCallback?.(true);
      });

      expect(result.current.shellVisible).toBe(true);

      act(() => {
        visibilityCallback?.(false);
      });

      expect(result.current.shellVisible).toBe(false);
    });

    it("subscribes to onDismissPreview and resets previewIndex", () => {
      let dismissCallback: (() => void) | null = null;

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn(() => vi.fn()),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn((cb: () => void) => {
          dismissCallback = cb;
          return vi.fn();
        }),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      // Set a preview index first
      act(() => {
        result.current.setPreviewIndex(2);
      });
      expect(result.current.previewIndex).toBe(2);

      // Dismiss should reset to null
      act(() => {
        dismissCallback?.();
      });
      expect(result.current.previewIndex).toBeNull();
    });

    it("subscribes to onChatContext with ChatContextUpdate format", () => {
      let contextCallback: ((payload: unknown) => void) | null = null;

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn((cb: (payload: unknown) => void) => {
          contextCallback = cb;
          return vi.fn();
        }),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      const newContext = {
        window: {
          title: "Updated",
          app: "App",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
        selectedText: "new selection",
      };

      act(() => {
        contextCallback?.({ context: newContext, version: 1 });
      });

      expect(result.current.chatContext).toEqual(newContext);
      expect(result.current.selectedText).toBe("new selection");
    });

    it("subscribes to onChatContext with plain ChatContext format", () => {
      let contextCallback: ((payload: unknown) => void) | null = null;

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn((cb: (payload: unknown) => void) => {
          contextCallback = cb;
          return vi.fn();
        }),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      const plainContext = {
        window: null,
        selectedText: "plain selected",
      };

      act(() => {
        contextCallback?.(plainContext);
      });

      expect(result.current.chatContext).toEqual(plainContext);
      expect(result.current.selectedText).toBe("plain selected");
    });

    it("handles null payload in onChatContext", () => {
      let contextCallback: ((payload: unknown) => void) | null = null;

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn((cb: (payload: unknown) => void) => {
          contextCallback = cb;
          return vi.fn();
        }),
        onMiniVisibility: vi.fn(() => vi.fn()),
        onDismissPreview: vi.fn(() => vi.fn()),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { result } = renderHook(() => useContextCapture());

      act(() => {
        contextCallback?.(null);
      });

      expect(result.current.chatContext).toBeNull();
      expect(result.current.selectedText).toBeNull();
    });

    it("cleans up subscriptions on unmount", () => {
      const unsubContext = vi.fn();
      const unsubVisibility = vi.fn();
      const unsubDismiss = vi.fn();

      const mockApi = {
        getChatContext: vi.fn().mockResolvedValue(null),
        onChatContext: vi.fn(() => unsubContext),
        onMiniVisibility: vi.fn(() => unsubVisibility),
        onDismissPreview: vi.fn(() => unsubDismiss),
      };
      mockGetElectronApi.mockReturnValue(mockApi);

      const { unmount } = renderHook(() => useContextCapture());

      unmount();

      expect(unsubContext).toHaveBeenCalled();
      expect(unsubVisibility).toHaveBeenCalled();
      expect(unsubDismiss).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Setters
  // ----------------------------------------------------------------
  describe("setters", () => {
    it("setChatContext updates chatContext", () => {
      const { result } = renderHook(() => useContextCapture());

      const ctx = {
        window: {
          title: "Test",
          app: "App",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        },
      };

      act(() => {
        result.current.setChatContext(ctx);
      });

      expect(result.current.chatContext).toEqual(ctx);
    });

    it("setSelectedText updates selectedText", () => {
      const { result } = renderHook(() => useContextCapture());

      act(() => {
        result.current.setSelectedText("my selection");
      });

      expect(result.current.selectedText).toBe("my selection");
    });

    it("setPreviewIndex updates previewIndex", () => {
      const { result } = renderHook(() => useContextCapture());

      act(() => {
        result.current.setPreviewIndex(3);
      });

      expect(result.current.previewIndex).toBe(3);
    });
  });
});
