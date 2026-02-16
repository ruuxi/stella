import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { StellaAnimationHandle } from "../../components/ascii-creature/StellaAnimation";
import { ChatColumn } from "./ChatColumn";

vi.mock("../ConversationEvents", () => ({
  ConversationEvents: () => <div data-testid="conversation-events" />,
}));

vi.mock("./OnboardingOverlay", () => ({
  OnboardingView: () => <div data-testid="onboarding-view" />,
}));

vi.mock("./Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("../../components/chat/CommandChips", () => ({
  CommandChips: () => <div data-testid="command-chips" />,
}));

vi.mock("../../hooks/use-command-suggestions", () => ({
  useCommandSuggestions: () => [],
}));

function makeProps(overrides: Partial<Parameters<typeof ChatColumn>[0]> = {}) {
  return {
    events: [],
    streamingText: "",
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    message: "",
    setMessage: vi.fn(),
    chatContext: null,
    setChatContext: vi.fn(),
    selectedText: null,
    setSelectedText: vi.fn(),
    queueNext: false,
    setQueueNext: vi.fn(),
    scrollContainerRef: React.createRef<HTMLDivElement>(),
    handleScroll: vi.fn(),
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    conversationId: null,
    onboardingDone: true,
    onboardingExiting: false,
    isAuthenticated: true,
    canSubmit: true,
    onSend: vi.fn(),
    hasExpanded: false,
    splitMode: false,
    onboardingKey: 0,
    stellaAnimationRef: React.createRef<StellaAnimationHandle | null>(),
    triggerFlash: vi.fn(),
    startBirthAnimation: vi.fn(),
    completeOnboarding: vi.fn(),
    handleEnterSplit: vi.fn(),
    onDiscoveryConfirm: vi.fn(),
    ...overrides,
  };
}

describe("ChatColumn", () => {
  it("shows OnboardingView when onboardingDone=false", () => {
    render(<ChatColumn {...makeProps({ onboardingDone: false })} />);
    expect(screen.getByTestId("onboarding-view")).toBeTruthy();
    expect(screen.queryByTestId("conversation-events")).toBeNull();
  });

  it("shows ConversationEvents when authenticated + onboardingDone", () => {
    render(
      <ChatColumn
        {...makeProps({ isAuthenticated: true, onboardingDone: true })}
      />,
    );
    expect(screen.getByTestId("conversation-events")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-view")).toBeNull();
  });

  it("shows Composer when authenticated + onboardingDone", () => {
    render(
      <ChatColumn
        {...makeProps({ isAuthenticated: true, onboardingDone: true })}
      />,
    );
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("hides Composer when not authenticated", () => {
    render(<ChatColumn {...makeProps({ isAuthenticated: false })} />);
    expect(screen.queryByTestId("composer")).toBeNull();
  });

  it("shows scroll-to-bottom button when showScrollButton=true and conversation visible", () => {
    const events = [{ id: "1", type: "user", body: "hi" }] as any;
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          isAuthenticated: true,
          onboardingDone: true,
          events,
        })}
      />,
    );
    expect(screen.getByLabelText("Scroll to bottom")).toBeTruthy();
  });

  it("hides scroll-to-bottom button when not authenticated", () => {
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          isAuthenticated: false,
          onboardingDone: true,
        })}
      />,
    );
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
  });

  it("shows nothing when auth is loading and onboarding done", () => {
    render(
      <ChatColumn
        {...makeProps({
          isAuthenticated: false,
          isAuthLoading: true,
          onboardingDone: true,
        })}
      />,
    );
    expect(screen.queryByTestId("onboarding-view")).toBeNull();
    expect(screen.queryByTestId("conversation-events")).toBeNull();
  });

  it('calls scrollToBottom("smooth") when scroll button clicked', () => {
    const scrollToBottom = vi.fn();
    const events = [{ id: "1", type: "user", body: "hi" }] as any;
    render(
      <ChatColumn
        {...makeProps({
          showScrollButton: true,
          isAuthenticated: true,
          onboardingDone: true,
          events,
          scrollToBottom,
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Scroll to bottom"));
    expect(scrollToBottom).toHaveBeenCalledWith("smooth");
  });

  it("has class full-body-main", () => {
    const { container } = render(<ChatColumn {...makeProps()} />);
    expect(container.querySelector(".full-body-main")).toBeTruthy();
  });
});
