import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppBootstrap } from "./AppBootstrap";

const mockSetConversationId = vi.fn();
vi.mock("./state/ui-state", () => ({
  useUiState: () => ({ setConversationId: mockSetConversationId }),
}));

const mockGetOrCreateDefaultConversation = vi.fn();
const mockImportLocalMessagesChunk = vi.fn();
const mockUseQuery = vi.fn(() => "connected");
const mockUseConvexAuth = vi.fn(() => ({
  isAuthenticated: true,
  isLoading: false,
}));
vi.mock("convex/react", () => ({
  useMutation: (path: unknown) =>
    path === "importLocalMessagesChunk"
      ? mockImportLocalMessagesChunk
      : mockGetOrCreateDefaultConversation,
  useConvexAuth: () => mockUseConvexAuth(),
  useQuery: () => mockUseQuery(),
}));

vi.mock("../convex/api", () => ({
  api: {
    conversations: {
      getOrCreateDefaultConversation: "getOrCreateDefaultConversation",
    },
    data: {
      preferences: {
        getAccountMode: "getAccountMode",
      },
    },
    events: {
      importLocalMessagesChunk: "importLocalMessagesChunk",
    },
  },
}));

const mockConfigureLocalHost = vi.fn();
const mockGetOrCreateDeviceId = vi.fn();
const mockGetOrCreateLocalConversationId = vi.fn(() => "01KHVRH3ZAPQN48JWYNJNYDCVC");
const mockBuildLocalSyncMessages = vi.fn(() => [] as Array<{
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  deviceId?: string;
}>);
const mockGetLocalSyncCheckpoint = vi.fn((): string | null => null);
const mockSetLocalSyncCheckpoint = vi.fn();
vi.mock("../services/device", () => ({
  configureLocalHost: () => mockConfigureLocalHost(),
  getOrCreateDeviceId: () => mockGetOrCreateDeviceId(),
}));
vi.mock("../services/local-chat-store", () => ({
  getOrCreateLocalConversationId: () => mockGetOrCreateLocalConversationId(),
  buildLocalSyncMessages: () => mockBuildLocalSyncMessages(),
  getLocalSyncCheckpoint: () => mockGetLocalSyncCheckpoint(),
  setLocalSyncCheckpoint: (...args: [string, string]) => mockSetLocalSyncCheckpoint(...args),
}));

describe("AppBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    mockUseQuery.mockReturnValue("connected");
    mockConfigureLocalHost.mockResolvedValue(undefined);
    mockGetOrCreateDeviceId.mockResolvedValue("device-id-123");
    mockGetOrCreateDefaultConversation.mockResolvedValue({
      _id: "conv-123",
    });
    mockImportLocalMessagesChunk.mockResolvedValue({ imported: 0, skipped: 0 });
    mockBuildLocalSyncMessages.mockReturnValue([]);
    mockGetLocalSyncCheckpoint.mockReturnValue(null);
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

  it("uses local conversation bootstrap when unauthenticated", async () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockConfigureLocalHost).toHaveBeenCalled();
      expect(mockGetOrCreateDeviceId).toHaveBeenCalled();
    });
    expect(mockGetOrCreateDefaultConversation).not.toHaveBeenCalled();
    expect(mockGetOrCreateLocalConversationId).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).toHaveBeenNthCalledWith(1, null);
    expect(mockSetConversationId).toHaveBeenNthCalledWith(2, "01KHVRH3ZAPQN48JWYNJNYDCVC");
  });

  it("uses local conversation id when account mode is private_local", async () => {
    mockUseQuery.mockReturnValue("private_local");

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockGetOrCreateLocalConversationId).toHaveBeenCalled();
    });
    expect(mockGetOrCreateDefaultConversation).not.toHaveBeenCalled();
    expect(mockSetConversationId).toHaveBeenCalledWith("01KHVRH3ZAPQN48JWYNJNYDCVC");
  });

  it("imports unsynced local messages before switching to connected conversation", async () => {
    mockBuildLocalSyncMessages.mockReturnValue([
      {
        localMessageId: "local-1",
        role: "user",
        text: "Hello",
        timestamp: 100,
        deviceId: "device-id-123",
      },
      {
        localMessageId: "local-2",
        role: "assistant",
        text: "Hi there",
        timestamp: 101,
      },
    ]);

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockImportLocalMessagesChunk).toHaveBeenCalledTimes(1);
    });

    expect(mockImportLocalMessagesChunk).toHaveBeenCalledWith({
      conversationId: "conv-123",
      messages: [
        {
          localMessageId: "local-1",
          role: "user",
          text: "Hello",
          timestamp: 100,
          deviceId: "device-id-123",
        },
        {
          localMessageId: "local-2",
          role: "assistant",
          text: "Hi there",
          timestamp: 101,
        },
      ],
    });
    expect(mockSetLocalSyncCheckpoint).toHaveBeenCalledWith(
      "01KHVRH3ZAPQN48JWYNJNYDCVC",
      "local-2",
    );
    expect(mockSetConversationId).toHaveBeenCalledWith("conv-123");
  });

  it("only imports messages after the local sync checkpoint", async () => {
    mockGetLocalSyncCheckpoint.mockReturnValue("local-1");
    mockBuildLocalSyncMessages.mockReturnValue([
      {
        localMessageId: "local-1",
        role: "user",
        text: "Old",
        timestamp: 100,
      },
      {
        localMessageId: "local-2",
        role: "assistant",
        text: "New",
        timestamp: 101,
      },
    ]);

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockImportLocalMessagesChunk).toHaveBeenCalledTimes(1);
    });

    expect(mockImportLocalMessagesChunk).toHaveBeenCalledWith({
      conversationId: "conv-123",
      messages: [
        {
          localMessageId: "local-2",
          role: "assistant",
          text: "New",
          timestamp: 101,
        },
      ],
    });
    expect(mockSetLocalSyncCheckpoint).toHaveBeenCalledWith(
      "01KHVRH3ZAPQN48JWYNJNYDCVC",
      "local-2",
    );
  });

  it("still switches to cloud conversation when local sync fails", async () => {
    mockBuildLocalSyncMessages.mockReturnValue([
      {
        localMessageId: "local-1",
        role: "user",
        text: "Hello",
        timestamp: 100,
      },
    ]);
    mockImportLocalMessagesChunk.mockRejectedValue(new Error("sync failed"));

    render(<AppBootstrap />);

    await waitFor(() => {
      expect(mockSetConversationId).toHaveBeenCalledWith("conv-123");
    });
  });
});
