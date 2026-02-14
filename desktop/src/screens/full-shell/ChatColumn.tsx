/**
 * ChatColumn: .session-content + .session-messages, scroll management, message rendering.
 */

import { ConversationEvents } from "../ConversationEvents";
import { OnboardingView } from "./OnboardingOverlay";
import { Composer } from "./Composer";
import { CommandChips } from "../../components/chat/CommandChips";
import { WelcomeSuggestions } from "../../components/chat/WelcomeSuggestions";
import { StellaAnimation } from "../../components/StellaAnimation";
import { useCommandSuggestions, type CommandSuggestion } from "../../hooks/use-command-suggestions";
import { useWelcomeSuggestions } from "../../hooks/use-welcome-suggestions";
import type { WelcomeSuggestion } from "../../services/synthesis";
import type { EventRecord } from "../../hooks/use-conversation-events";
import type { StellaAnimationHandle } from "../../components/StellaAnimation";
import type { ChatContext } from "../../types/electron";

type DiscoveryCategory = "dev_environment" | "apps_system" | "messages_notes";

type ChatColumnProps = {
  events: EventRecord[];

  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;

  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  queueNext: boolean;
  setQueueNext: (value: boolean) => void;

  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  showScrollButton: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;

  conversationId: string | null;
  onboardingDone: boolean;
  onboardingExiting: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  canSubmit: boolean;
  onSend: () => void;

  hasExpanded: boolean;
  splitMode: boolean;
  onboardingKey: number;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  handleEnterSplit: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSignIn: () => void;
  onDemoChange?: (demo: "dj-studio" | "weather-station" | null) => void;
  onCommandSelect?: (suggestion: CommandSuggestion) => void;
  onWelcomeSuggestionSelect?: (suggestion: WelcomeSuggestion) => void;
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
  onboardingExiting,
  isAuthenticated,
  isAuthLoading,
  canSubmit,
  onSend,
  hasExpanded,
  splitMode,
  onboardingKey,
  stellaAnimationRef,
  triggerFlash,
  startBirthAnimation,
  completeOnboarding,
  handleEnterSplit,
  onDiscoveryConfirm,
  onSignIn,
  onDemoChange,
  onCommandSelect,
  onWelcomeSuggestionSelect,
}: ChatColumnProps) {
  const suggestions = useCommandSuggestions(events, isStreaming);
  const welcomeSuggestions = useWelcomeSuggestions(events);
  const hasMessages = events.length > 0 || isStreaming;
  const showConversation = isAuthenticated && onboardingDone && hasMessages;

  return (
    <div className="full-body-main">
      <div
        className="session-content"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {showConversation ? (
          <div className="session-messages">
            <ConversationEvents
              events={events}
              streamingText={streamingText}
              reasoningText={reasoningText}
              isStreaming={isStreaming}
              pendingUserMessageId={pendingUserMessageId}
              scrollContainerRef={scrollContainerRef}
            />
            {!isStreaming && welcomeSuggestions.length > 0 && onWelcomeSuggestionSelect && (
              <WelcomeSuggestions
                suggestions={welcomeSuggestions}
                onSelect={onWelcomeSuggestionSelect}
              />
            )}
            {!isStreaming && suggestions.length > 0 && onCommandSelect && (
              <CommandChips
                suggestions={suggestions}
                onSelect={onCommandSelect}
              />
            )}
          </div>
        ) : (
          <OnboardingView
            hasExpanded={hasExpanded}
            onboardingDone={onboardingDone}
            onboardingExiting={onboardingExiting}
            isAuthenticated={isAuthenticated}
            isAuthLoading={isAuthLoading}
            splitMode={splitMode}
            stellaAnimationRef={stellaAnimationRef}
            onboardingKey={onboardingKey}
            triggerFlash={triggerFlash}
            startBirthAnimation={startBirthAnimation}
            completeOnboarding={completeOnboarding}
            onSignIn={onSignIn}
            handleEnterSplit={handleEnterSplit}
            onDiscoveryConfirm={onDiscoveryConfirm}
            onDemoChange={onDemoChange}
          />
        )}
      </div>

      {showScrollButton && showConversation && (
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

      {isAuthenticated && onboardingDone && (
        <div className={onboardingExiting ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
          <div className="composer-stella-ambient">
            <StellaAnimation width={80} height={40} />
          </div>
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
        </div>
      )}
    </div>
  );
}
