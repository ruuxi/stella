/**
 * ChatColumn: .session-content + .session-messages, scroll management, message rendering.
 */

import { ConversationEvents } from "../ConversationEvents";
import { OnboardingView } from "./OnboardingOverlay";
import { Composer } from "./Composer";
import type { EventRecord } from "../../hooks/use-conversation-events";
import type { AsciiBlackHoleHandle } from "../../components/AsciiBlackHole";
import type { ChatContext } from "../../types/electron";

type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

type ChatColumnProps = {
  // Events
  events: EventRecord[];

  // Streaming
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;

  // Message input
  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  queueNext: boolean;
  setQueueNext: (value: boolean) => void;

  // Scroll
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  showScrollButton: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;

  // State
  conversationId: string | null;
  onboardingDone: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  canSubmit: boolean;
  onSend: () => void;

  // Onboarding
  hasExpanded: boolean;
  onboardingKey: number;
  blackHoleRef: React.RefObject<AsciiBlackHoleHandle | null>;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  handleOpenThemePicker: () => void;
  handleConfirmTheme: () => void;
  themeConfirmed: boolean;
  hasSelectedTheme: boolean;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSignIn: () => void;
};

export function ChatColumn({
  events,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  message,
  setMessage,
  chatContext,
  setChatContext,
  selectedText,
  setSelectedText,
  queueNext,
  setQueueNext,
  scrollContainerRef,
  handleScroll,
  showScrollButton,
  scrollToBottom,
  conversationId,
  onboardingDone,
  isAuthenticated,
  isAuthLoading,
  canSubmit,
  onSend,
  hasExpanded,
  onboardingKey,
  blackHoleRef,
  triggerFlash,
  startBirthAnimation,
  completeOnboarding,
  handleOpenThemePicker,
  handleConfirmTheme,
  themeConfirmed,
  hasSelectedTheme,
  onDiscoveryConfirm,
  onSignIn,
}: ChatColumnProps) {
  const hasMessages = events.length > 0 || isStreaming;

  return (
    <div className="full-body-main">
      <div
        className="session-content"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {hasMessages && onboardingDone ? (
          <div className="session-messages">
            <ConversationEvents
              events={events}
              streamingText={streamingText}
              reasoningText={reasoningText}
              isStreaming={isStreaming}
              pendingUserMessageId={pendingUserMessageId}
              scrollContainerRef={scrollContainerRef}
            />
          </div>
        ) : (
          <OnboardingView
            hasExpanded={hasExpanded}
            onboardingDone={onboardingDone}
            isAuthenticated={isAuthenticated}
            isAuthLoading={isAuthLoading}
            blackHoleRef={blackHoleRef}
            onboardingKey={onboardingKey}
            triggerFlash={triggerFlash}
            startBirthAnimation={startBirthAnimation}
            completeOnboarding={completeOnboarding}
            onSignIn={onSignIn}
            handleOpenThemePicker={handleOpenThemePicker}
            handleConfirmTheme={handleConfirmTheme}
            themeConfirmed={themeConfirmed}
            hasSelectedTheme={hasSelectedTheme}
            onDiscoveryConfirm={onDiscoveryConfirm}
          />
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && hasMessages && onboardingDone && (
        <button
          className="scroll-to-bottom"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Scroll to bottom"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}

      {/* Composer - only when authenticated */}
      {isAuthenticated && onboardingDone && (
        <Composer
          message={message}
          setMessage={setMessage}
          chatContext={chatContext}
          setChatContext={setChatContext}
          selectedText={selectedText}
          setSelectedText={setSelectedText}
          isStreaming={isStreaming}
          queueNext={queueNext}
          setQueueNext={setQueueNext}
          canSubmit={canSubmit}
          conversationId={conversationId}
          onSend={onSend}
        />
      )}
    </div>
  );
}
