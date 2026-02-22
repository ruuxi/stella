import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppBootstrap } from "./AppBootstrap";

const mockSetConversationId = vi.fn();
vi.mock("./state/ui-state", () => ({
  useUiState: () => ({ setConversationId: mockSetConversationId }),
}));

const mockGetOrCreateDefaultConversation = vi.fn();
const mockUseConvexAuth = vi.fn(() => ({
  isAuthenticated: true,
  isLoading: false,
}));
vi.mock("convex/react", () => ({
  useMutation: () => mockGetOrCreateDefaultConversation,
  useConvexAuth: () => mockUseConvexAuth(),
}));

vi.mock("../convex/api", () => ({
  api: {
    conversations: {
      getOrCreateDefaultConversation: "getOrCreateDefaultConversation",
    },
  },
}));

const mockConfigureLocalHost = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
vi.mock("../services/device", () => ({
  configureLocalHost: () => mockConfigureLocalHost(),
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));

describe("AppBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    mockConfigureLocalHost.mockResolvedValue(undefined);
    mockGetOrCreateDeviceId.mockResolvedValue("device-id-123");
    mockGetOrCreateDefaultConversation.mockResolvedValue({
      _id: "conv-123",
    });
  });

  it("renders nothing (returns null)", () => {
    const { container } = render(<AppBootstrap />);
    expect(container.innerHTML).toBe("");
  });

  it("calls getOrCreateDefaultConversation on mount", async () => {
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockGetOrCreateDefaultConversation).toHaveBeenCalledWith({});
    });
  });

  it("sets conversation ID from returned conversation", async () => {
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("conv-123");
    });
  });

  it("calls configureLocalHost and getOrCreateDeviceId", async () => {
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockConfigureLocalHost).toHaveBeenCalled();
      expect(mockGetOrCreateDeviceId).toHaveBeenCalled();
    });
  });

  it("does not set conversation ID when conversation has no _id", async () => {
    mockGetOrCreateDefaultConversation.mockResolvedValue({});
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockGetOrCreateDefaultConversation).toHaveBeenCalled();
    });
    expect(mockSetConversationId).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).toHaveBeenCalledWith(null);
  });

  it("does not set conversation ID when conversation is null", async () => {
    mockGetOrCreateDefaultConversation.mockResolvedValue(null);
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockGetOrCreateDefaultConversation).toHaveBeenCalled();
    });
    expect(mockSetConversationId).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).toHaveBeenCalledWith(null);
  });

  it("does not set conversation ID after unmount (cancelled)", async () => {
    let resolveConversation: (value: { _id: string }) => void;
    mockGetOrCreateDefaultConversation.mockReturnValue(
      new Promise((resolve) => {
        resolveConversation = resolve;
      }),
    );

    const { unmount } = render(<AppBootstrap />);
    unmount();

    // Resolve after unmount -- setConversationId should not be called
    resolveConversation!({ _id: "conv-456" });
    await waitFor(() => {
      expect(mockGetOrCreateDefaultConversation).toHaveBeenCalled();
    });
    expect(mockSetConversationId).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).toHaveBeenCalledWith(null);
  });

  it("handles configureLocalHost failure gracefully", async () => {
    mockConfigureLocalHost.mockRejectedValue(new Error("host setup failed"));
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("conv-123");
    });
    // Should not throw -- Promise.allSettled handles the rejection
  });

  it("handles getOrCreateDeviceId failure gracefully", async () => {
    mockGetOrCreateDeviceId.mockRejectedValue(new Error("device setup failed"));
    render(<AppBootstrap />);
    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("conv-123");
    });
    // Should not throw -- Promise.allSettled handles the rejection
  });

  it("skips cloud conversation bootstrap when unauthenticated", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockConfigureLocalHost).toHaveBeenCalled();
      expect(mockGetOrCreateDeviceId).toHaveBeenCalled();
    });
    expect(mockGetOrCreateDefaultConversation).not.toHaveBeenCalled();
    expect(mockSetConversationId).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).toHaveBeenCalledWith(null);
  });
});
