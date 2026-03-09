import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { StellaAnimationHandle } from "@/app/shell/ascii-creature/StellaAnimation";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { ChatColumn } from "../../../../src/app/chat/ChatColumn";
import type { ChatColumnProps } from "../../../../src/app/chat/ChatColumn";

vi.mock("../../../../src/app/chat/ConversationEvents", () => ({
  ConversationEvents: () => <div data-testid="conversation-events" />,
}));

vi.mock("../../../../src/app/onboarding/OnboardingOverlay", () => ({
  OnboardingView: () => <div data-testid="onboarding-view" />,
}));

vi.mock("../../../../src/app/chat/Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("@/app/chat/CommandChips", () => ({
  CommandChips: () => <div data-testid="command-chips" />,
}));

vi.mock("@/app/chat/hooks/use-command-suggestions", () => ({
  useCommandSuggestions: () => [],
}));

function makeProps(overrides: Partial<ChatColumnProps> = {}): ChatColumnProps {
  return {
    events: [],
    streaming: {
      text: "",
      reasoningText: "",
      isStreaming: false,
      pendingUserMessageId: null,
      selfModMap: {},
      ...overrides.streaming,
    },
    history: {
      hasOlderEvents: false,
      isLoadingOlder: false,
      isInitialLoading: false,
      ...overrides.history,
    },
    composer: {
      message: "",
      setMessage: vi.fn(),
      chatContext: null,
      setChatContext: vi.fn(),
      selectedText: null,
      setSelectedText: vi.fn(),
      canSubmit: true,
      onSend: vi.fn(),
      ...overrides.composer,
    },
    scrollContainerRef: React.createRef<HTMLDivElement>(),
    setScrollContainerElement: vi.fn(),
    canVirtualize: false,
    onScroll: vi.fn(),
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    onboarding: {
      done: true,
      exiting: false,
      isAuthenticated: true,
      hasExpanded: false,
      splitMode: false,
      key: 0,
      stellaAnimationRef: React.createRef<StellaAnimationHandle | null>(),
      triggerFlash: vi.fn(),
      startBirthAnimation: vi.fn(),
      completeOnboarding: vi.fn(),
      handleEnterSplit: vi.fn(),
      onDiscoveryConfirm: vi.fn(),
      ...overrides.onboarding,
    },
    conversationId: null,
    ...overrides,
  };
}

describe("ChatColumn", () => {
  it("shows OnboardingView when onboardingDone=false", () => {
    render(<ChatColumn {...makeProps({ onboarding: { ...makeProps().onboarding, done: false } })} />);
    expect(screen.getByTestId("onboarding-view")).toBeTruthy();
    expect(screen.queryByTestId("conversation-events")).toBeNull();
  });

  it("shows ConversationEvents when authenticated + onboardingDone", () => {
    render(
      <ChatColumn
        {...makeProps({ onboarding: { ...makeProps().onboarding, isAuthenticated: true, done: true } })}
      />,
    );
    expect(screen.getByTestId("conversation-events")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-view")).toBeNull();
  });

  it("shows ConversationEvents when unauthenticated + onboardingDone", () => {
    render(
      <ChatColumn
        {...makeProps({ onboarding: { ...makeProps().onboarding, isAuthenticated: false, done: true } })}
      />,
    );
    expect(screen.getByTestId("conversation-events")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-view")).toBeNull();
  });

  it("shows Composer when authenticated + onboardingDone", () => {
    render(
      <ChatColumn
        {...makeProps({ onboarding: { ...makeProps().onboarding, isAuthenticated: true, done: true } })}
      />,
    );
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("shows Composer when unauthenticated after onboarding", () => {
    render(<ChatColumn {...makeProps({ onboarding: { ...makeProps().onboarding, isAuthenticated: false } })} />);
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("shows scroll-to-bottom button when showScrollButton=true and conversation visible", () => {
    const events: EventRecord[] = [
      { _id: "event-1", timestamp: 1, type: "user_message", payload: { text: "hi" } },
    ];
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          onboarding: { ...makeProps().onboarding, isAuthenticated: true, done: true },
          events,
        })}
      />,
    );
    expect(screen.getByLabelText("Scroll to bottom")).toBeTruthy();
  });

  it("shows scroll-to-bottom button when unauthenticated after onboarding", () => {
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          onboarding: { ...makeProps().onboarding, isAuthenticated: false, done: true },
        })}
      />,
    );
    expect(screen.getByLabelText("Scroll to bottom")).toBeTruthy();
  });

  it('calls scrollToBottom("instant") when scroll button clicked', () => {
    const scrollToBottom = vi.fn();
    const events: EventRecord[] = [
      { _id: "event-1", timestamp: 1, type: "user_message", payload: { text: "hi" } },
    ];
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          scrollToBottom,
          onboarding: { ...makeProps().onboarding, isAuthenticated: true, done: true },
          events,
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Scroll to bottom"));
    expect(scrollToBottom).toHaveBeenCalledWith("instant");
  });

  it("has class full-body-main", () => {
    const { container } = render(<ChatColumn {...makeProps()} />);
    expect(container.querySelector(".full-body-main")).toBeTruthy();
  });
});
