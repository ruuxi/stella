import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppBootstrap } from "../../../src/systems/boot/AppBootstrap";

const mockSetConversationId = vi.fn();
vi.mock("../../../src/context/ui-state", () => ({
  useUiState: () => ({ setConversationId: mockSetConversationId }),
}));

const mockConfigurePiRuntime = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
const mockGetOrCreateLocalConversationId = vi.fn(() =>
  Promise.resolve("01KHVRH3ZAPQN48JWYNJNYDCVC"),
);

vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: () => mockConfigurePiRuntime(),
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));

vi.mock("@/app/chat/services/local-chat-store", () => ({
  getOrCreateLocalConversationId: () => mockGetOrCreateLocalConversationId(),
}));

describe("AppBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigurePiRuntime.mockResolvedValue(undefined);
    mockGetOrCreateDeviceId.mockResolvedValue("device-id-123");
  });

  it("renders nothing (returns null)", () => {
    const { container } = render(<AppBootstrap />);
    expect(container.innerHTML).toBe("");
  });

  it("boots with the local conversation id", async () => {
    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockGetOrCreateLocalConversationId).toHaveBeenCalledTimes(1);
      expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
    });
  });

  it("calls configurePiRuntime and getOrCreateDeviceId", async () => {
    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockConfigurePiRuntime).toHaveBeenCalled();
      expect(mockGetOrCreateDeviceId).toHaveBeenCalled();
    });
  });

  it("does not set conversation id after unmount", async () => {
    let resolveConversation!: (value: string) => void;
    mockGetOrCreateLocalConversationId.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConversation = resolve;
      }),
    );

    const { unmount } = render(<AppBootstrap />);
    unmount();

    resolveConversation("local-conv-456");

    await waitFor(() => {
      expect(mockGetOrCreateLocalConversationId).toHaveBeenCalled();
    });
    expect(mockSetConversationId).not.toHaveBeenCalled();
  });

  it("still uses the local conversation when runtime setup fails", async () => {
    mockConfigurePiRuntime.mockRejectedValue(new Error("host setup failed"));

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
    });
  });

  it("still uses the local conversation when device setup fails", async () => {
    mockGetOrCreateDeviceId.mockRejectedValue(new Error("device setup failed"));

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
    });
  });
});



