import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppBootstrap } from "../../../src/systems/boot/AppBootstrap";

const mockSetConversationId = vi.fn();
const mockConfigurePiRuntime = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
const mockGetOrCreateLocalConversationId = vi.fn(() =>
  Promise.resolve("01KHVRH3ZAPQN48JWYNJNYDCVC"),
);
const mockMarkPreparing = vi.fn();
const mockMarkReady = vi.fn();
const mockMarkFailed = vi.fn();

vi.mock("../../../src/context/ui-state", () => ({
  useUiState: () => ({ setConversationId: mockSetConversationId }),
}));

vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: () => mockConfigurePiRuntime(),
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));

vi.mock("@/app/chat/services/local-chat-store", () => ({
  getOrCreateLocalConversationId: () => mockGetOrCreateLocalConversationId(),
}));

vi.mock("@/systems/boot/bootstrap-state", () => ({
  useBootstrapState: () => ({
    bootstrapAttempt: 0,
    runtimeStatus: "preparing",
    runtimeError: null,
    markPreparing: mockMarkPreparing,
    markReady: mockMarkReady,
    markFailed: mockMarkFailed,
    retryRuntimeBootstrap: vi.fn(),
  }),
}));

describe("AppBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigurePiRuntime.mockResolvedValue(undefined);
    mockGetOrCreateDeviceId.mockResolvedValue("device-id-123");
    mockGetOrCreateLocalConversationId.mockImplementation(() =>
      Promise.resolve("01KHVRH3ZAPQN48JWYNJNYDCVC"),
    );
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
      expect(mockMarkPreparing).toHaveBeenCalledTimes(1);
      expect(mockMarkReady).toHaveBeenCalledTimes(1);
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
    expect(mockMarkReady).not.toHaveBeenCalled();
  });

  it("still uses the local conversation when runtime setup fails", async () => {
    mockConfigurePiRuntime.mockRejectedValue(new Error("host setup failed"));

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });

  it("still uses the local conversation when device setup fails", async () => {
    mockGetOrCreateDeviceId.mockRejectedValue(new Error("device setup failed"));

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });

  it("retries conversation bootstrap before failing startup", async () => {
    let callCount = 0;
    mockGetOrCreateLocalConversationId.mockImplementation(() => {
      callCount += 1;
      return callCount === 1
        ? Promise.reject(new Error("runtime unavailable"))
        : Promise.resolve("local-conv-456");
    });

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockGetOrCreateLocalConversationId).toHaveBeenCalledTimes(2);
      expect(mockSetConversationId).toHaveBeenCalledWith("local-conv-456");
      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });
});
