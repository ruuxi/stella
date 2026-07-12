import type { Dispatch, RefObject, SetStateAction } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type {
  EventRecord,
  TaskItem,
} from "@/features/chat/lib/event-transforms";

export type { EventRecord };
import type { ChatContext } from "@/shared/types/electron";

/**
 * Stable per-conversation slice of the chat runtime.
 *
 * The high-frequency visible timeline (`MessageRecord[]`, mutated ~once
 * per animation frame while a reply streams) is intentionally NOT here —
 * it is published through `ChatMessagesContext` / `useChatMessages` so this
 * value keeps a stable identity across streamed frames and its consumers
 * (shell chrome, left sidebar) don't re-render per token.
 */
export type ChatColumnConversation = {
  /**
   * The conversation's background-agent tasks: authoritative thread rows
   * (runtime `runtime_agents` table via `useThreadActivity`) overlaid with
   * live stream decoration by `buildActivityTasks`. Every task surface —
   * Activity sidebar, composer pill, Now/Done sections, working indicator,
   * mobile bridge — reads this single list; nothing folds lifecycle events
   * into state anymore.
   */
  tasks: TaskItem[];
  /**
   * Agent-lifecycle activity events for the conversation. Fed by
   * `useConversationActivity` in local mode. Only file-derived surfaces
   * read this now (per-agent file lists merge the `agent-completed` file
   * rollups with the files window) — task state comes from `tasks`.
   */
  activity: {
    activities: EventRecord[];
    latestMessageTimestampMs: number | null;
    hasOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: () => void;
  };
  /**
   * File-carrying events (`tool_result` / `agent-completed` whose
   * payload has a non-empty `fileChanges` or `producedFiles` array)
   * for the conversation. Fed by `useConversationFiles` in local mode
   * and a `displayEvents` filter in cloud mode. The Recent Files
   * surfaces (Chat tab Recent Files, ActivityHistoryDialog "files")
   * read from this rather than scanning `events`.
   */
  files: {
    files: EventRecord[];
    hasOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: () => void;
  };
  streaming: {
    reasoningText: string;
    isStreaming: boolean;
    /** True once the in-flight run has streamed any visible assistant text. */
    isStreamingResponseText: boolean;
    runtimeStatusText?: string | null;
    activeToolCallId?: string | null;
    activeToolName?: string | null;
    hasToolActivity?: boolean;
    isToolActive?: boolean;
    pendingUserMessageId: string | null;
    queuedUserMessages: QueuedUserMessage[];
    /**
     * Removes a still-queued follow-up message from the pending-send queue
     * by id. Wired to the hover-cancel control on a queued bubble; the
     * surface pairs it with restoring the bubble's text to its own composer.
     */
    removeQueuedUserMessage: (messageId: string) => void;
  };
  history: {
    hasOlderMessages: boolean;
    isLoadingOlder: boolean;
    isInitialLoading: boolean;
  };
};

export type ChatColumnComposer = {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  canSubmit: boolean;
  focusRequestId?: number;
  requestFocus?: () => void;
  onSelectArea?: () => void;
  onSend: () => void;
  onStop: () => void;
  onNewChat: () => void | Promise<void>;
};

/**
 * Scroll API for chat surfaces.
 *
 * Backed by `@legendapp/list/react` (Legend List v3 web entry):
 * the surface attaches `listRef` to the `<LegendList>`. The hook listens to
 * the native scroll node and drives custom scrollbar thumb state, "at bottom"
 * tracking, and `scrollToBottom` via the list's imperative API.
 */
export type ChatColumnScroll = {
  listRef: RefObject<LegendListRef | null>;
  showScrollButton: boolean;
  /** True when the user is at (or within ~1px of) the newest-content edge. */
  isAtBottom: boolean;
  /** True while stream/send auto-follow is armed (intent latch, not raw scrollTop). */
  isFollowingLatest: boolean;
  /** True during direct wheel/touch/keyboard/thumb scrolling and its short settle. */
  isUserScrolling: boolean;
  /** Marks imperative scrollbar-thumb movement as direct user scrolling. */
  noteManualScroll: () => void;
  getIsFollowing: () => boolean;
  scrollToBottom: (behavior?: "instant" | "smooth") => void;
  /**
   * Callback ref for the custom scrollbar thumb node. The scroll hook
   * writes the thumb's position/visibility straight to this element on
   * each scroll frame (no React state) so panning stays smooth. Surfaces
   * without a custom thumb just don't attach it.
   */
  thumbRef: (el: HTMLDivElement | null) => void;
};

export type ChatColumnProps = {
  conversation: ChatColumnConversation;
  composer: ChatColumnComposer;
  scroll: ChatColumnScroll;
  composerEntering?: boolean;
  conversationId: string | null;
  showHomeContent?: boolean;
  onDismissHome?: () => void;
};
