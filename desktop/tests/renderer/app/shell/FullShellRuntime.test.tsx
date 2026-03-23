import { render } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STELLA_CLOSE_ORB_CHAT_EVENT,
  STELLA_OPEN_ORB_CHAT_EVENT,
} from "../../../../src/shared/lib/stella-orb-chat";

const mockOrbOpenChat = vi.fn();
const mockOrbCloseChat = vi.fn();

vi.mock("@/shell/FloatingOrb", () => ({
  FloatingOrb: forwardRef((_props: any, ref) => {
    useImperativeHandle(ref, () => ({
      openChat: mockOrbOpenChat,
      closeChat: mockOrbCloseChat,
      openWithText: vi.fn(),
    }));
    return <div data-testid="floating-orb" />;
  }),
}));

vi.mock("@/shell/mini/MiniBridgeRelay", () => ({
  MiniBridgeRelay: () => null,
}));

vi.mock("@/shell/use-full-shell-voice-transcript", () => ({
  useFullShellVoiceTranscript: vi.fn(),
}));

vi.mock("@/app/chat/ChatColumn", () => ({
  ChatColumn: () => <div data-testid="chat-column" />,
}));

vi.mock("@/app/social/SocialView", () => ({
  SocialView: () => <div data-testid="social-view" />,
}));

vi.mock("@/shell/use-full-shell-chat", () => ({
  useFullShellChat: () => ({
    conversation: {
      events: [],
      streamingText: "",
      reasoningText: "",
      isStreaming: false,
      pendingUserMessageId: null,
      selfModMap: {},
      hasOlderEvents: false,
      isLoadingOlder: false,
      isInitialLoading: false,
      sendMessage: vi.fn(),
      sendContextlessMessage: vi.fn(),
      sendMessageWithContext: vi.fn(),
      cancelCurrentStream: vi.fn(),
    },
    composer: {
      message: "",
      setMessage: vi.fn(),
      chatContext: null,
      setChatContext: vi.fn(),
      selectedText: null,
      setSelectedText: vi.fn(),
      canSubmit: false,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onCommandSelect: vi.fn(),
      handleSend: vi.fn(),
      handleStop: vi.fn(),
      handleCommandSelect: vi.fn(),
    },
    scroll: {
      setViewportElement: vi.fn(),
      setContentElement: vi.fn(),
      onScroll: vi.fn(),
      showScrollButton: false,
      scrollToBottom: vi.fn(),
      overflowAnchor: "none",
      thumbState: { visible: false, height: 0, offset: 0 },
      hasScrollElement: false,
      setScrollContainerElement: vi.fn(),
    },
  }),
}));

const { FullShellRuntime } = await import("@/shell/FullShellRuntime");

describe("FullShellRuntime orb events", () => {
  beforeEach(() => {
    mockOrbOpenChat.mockReset();
    mockOrbCloseChat.mockReset();
  });

  it("opens the floating orb with captured chat context when requested", () => {
    render(
      <FullShellRuntime
        activeConversationId="conv-123"
        activeView="home"
        composerEntering={false}
        conversationId="conv-123"
        isOrbVisible
        onSignIn={vi.fn()}
        pendingAskStellaRequest={null}
        onPendingAskStellaHandled={vi.fn()}
      />,
    );

    const chatContext = { window: null, windowText: "Captured section" };
    window.dispatchEvent(
      new CustomEvent(STELLA_OPEN_ORB_CHAT_EVENT, {
        detail: { chatContext },
      }),
    );

    expect(mockOrbOpenChat).toHaveBeenCalledWith(chatContext);
  });

  it("opens the floating orb without context when none is provided", () => {
    render(
      <FullShellRuntime
        activeConversationId="conv-123"
        activeView="home"
        composerEntering={false}
        conversationId="conv-123"
        isOrbVisible
        onSignIn={vi.fn()}
        pendingAskStellaRequest={null}
        onPendingAskStellaHandled={vi.fn()}
      />,
    );

    window.dispatchEvent(new CustomEvent(STELLA_OPEN_ORB_CHAT_EVENT, { detail: {} }));

    expect(mockOrbOpenChat).toHaveBeenCalledWith();
  });

  it("closes the floating orb when requested", () => {
    render(
      <FullShellRuntime
        activeConversationId="conv-123"
        activeView="home"
        composerEntering={false}
        conversationId="conv-123"
        isOrbVisible
        onSignIn={vi.fn()}
        pendingAskStellaRequest={null}
        onPendingAskStellaHandled={vi.fn()}
      />,
    );

    window.dispatchEvent(new CustomEvent(STELLA_CLOSE_ORB_CHAT_EVENT));

    expect(mockOrbCloseChat).toHaveBeenCalledTimes(1);
  });
});
