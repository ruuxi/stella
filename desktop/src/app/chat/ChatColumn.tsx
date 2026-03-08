/**
 * ChatColumn: .session-content + .session-messages, scroll management, message rendering.
 */

import { memo } from "react";
import { ConversationEvents } from "./ConversationEvents";
import { OnboardingView } from "../onboarding/OnboardingOverlay";
import { Composer } from "./Composer";
import { CommandChips } from "@/app/chat/CommandChips";
import { useCommandSuggestions, type CommandSuggestion } from "@/hooks/use-command-suggestions";
import type { EventRecord } from "@/hooks/use-conversation-events";
import type { StellaAnimationHandle } from "@/app/shell/ascii-creature/StellaAnimation";
import type { ChatContext } from "@/types/electron";
import type { SelfModAppliedData } from "@/hooks/use-streaming-chat";
import type { DiscoveryCategory } from "@/app/onboarding/use-onboarding-state";
import "./full-shell.chat.css";

export type StreamingState = {
  text: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  selfModMap: Record<string, SelfModAppliedData>;
};

export type HistoryState = {
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
};

export type ComposerState = {
  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  canSubmit: boolean;
  onSend: () => void;
};

export type OnboardingState = {
  done: boolean;
  exiting: boolean;
  isAuthenticated: boolean;
  hasExpanded: boolean;
  splitMode: boolean;
  hasDiscoverySelections?: boolean;
  key: number;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  handleEnterSplit: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  onDemoChange?: (demo: "dj-studio" | "weather-station" | null) => void;
};

export type ChatColumnProps = {
  events: EventRecord[];
  streaming: StreamingState;
  history: HistoryState;
  composer: ComposerState;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  showScrollButton: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  onboarding: OnboardingState;
  conversationId: string | null;
  onCommandSelect?: (suggestion: CommandSuggestion) => void;
};

export const ChatColumn = memo(function ChatColumn({
  events,
  streaming,
  history,
  composer,
  scrollContainerRef,
  onScroll,
  showScrollButton,
  scrollToBottom,
  onboarding,
  conversationId,
  onCommandSelect,
}: ChatColumnProps) {
  const suggestions = useCommandSuggestions(events, streaming.isStreaming);
  const showConversation = onboarding.done;

  return (
    <div className="full-body-main">
      <div
        className="session-content"
        ref={scrollContainerRef}
        onScroll={onScroll}
      >
        {showConversation ? (
          <div className="session-messages">
            <ConversationEvents
              events={events}
              streamingText={streaming.text}
              reasoningText={streaming.reasoningText}
              isStreaming={streaming.isStreaming}
              pendingUserMessageId={streaming.pendingUserMessageId}
              selfModMap={streaming.selfModMap}
              hasOlderEvents={history.hasOlderEvents}
              isLoadingOlder={history.isLoadingOlder}
              isLoadingHistory={history.isInitialLoading}
              scrollContainerRef={scrollContainerRef}
            />
            {!streaming.isStreaming && suggestions.length > 0 && onCommandSelect && (
              <CommandChips
                suggestions={suggestions}
                onSelect={onCommandSelect}
              />
            )}
          </div>
        ) : (
          <OnboardingView
            hasExpanded={onboarding.hasExpanded}
            onboardingDone={onboarding.done}
            onboardingExiting={onboarding.exiting}
            isAuthenticated={onboarding.isAuthenticated}
            splitMode={onboarding.splitMode}
            hasDiscoverySelections={onboarding.hasDiscoverySelections}
            stellaAnimationRef={onboarding.stellaAnimationRef}
            onboardingKey={onboarding.key}
            triggerFlash={onboarding.triggerFlash}
            startBirthAnimation={onboarding.startBirthAnimation}
            completeOnboarding={onboarding.completeOnboarding}
            handleEnterSplit={onboarding.handleEnterSplit}
            onDiscoveryConfirm={onboarding.onDiscoveryConfirm}
            onSelectionChange={onboarding.onSelectionChange}
            onDemoChange={onboarding.onDemoChange}
          />
        )}
      </div>

      {showScrollButton && showConversation && (
        <button
          className="scroll-to-bottom"
          onClick={() => scrollToBottom("instant")}
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

      {showConversation && (
        <div className={onboarding.exiting ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
          <Composer
            message={composer.message}
            setMessage={composer.setMessage}
            chatContext={composer.chatContext}
            setChatContext={composer.setChatContext}
            selectedText={composer.selectedText}
            setSelectedText={composer.setSelectedText}
            isStreaming={streaming.isStreaming}
            canSubmit={composer.canSubmit}
            conversationId={conversationId}
            onSend={composer.onSend}
          />
        </div>
      )}
    </div>
  );
});


