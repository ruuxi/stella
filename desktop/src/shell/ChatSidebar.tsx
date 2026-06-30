import {
  useState,
  useRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { CompactConversationSurface } from "@/features/chat/CompactConversationSurface";
import type { ChatColumnScroll } from "@/features/chat/chat-column-types";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import { ComposerContextRow } from "@/app/chat/ComposerContextRow";
import { ComposerLeadRow } from "@/app/chat/ComposerLeadRow";
import { ComposerAddMenu } from "@/app/chat/ComposerAddMenu";
import {
  ComposerMicButton,
  ComposerSubmitButton,
  ComposerStopButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import {
  attachComposerAppSelectionContext,
  deriveComposerState,
  hasAttachedComposerChips,
} from "@/features/chat/composer-context";
import { buildInlineWorkingIndicatorProps } from "@/features/chat/working-indicator-state";
import { useFileDrop } from "@/features/chat/hooks/use-file-drop";
import { handleComposerPaste } from "@/features/chat/lib/paste-context";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import {
  useScreenshotPreview,
  ScreenshotPreviewOverlay,
} from "@/app/chat/ScreenshotPreview";
import type { ChatContext } from "@/shared/types/electron";
import type {
  EventRecord,
  TaskItem,
} from "@/features/chat/lib/event-transforms";
import type { MessageRecord } from "../../../runtime/contracts/local-chat.js";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type { AnnotationSelection } from "./use-full-shell-chat";
import { useCapturedChatContext } from "./use-captured-chat-context";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import { useAssistantReplyPeek } from "@/features/chat/hooks/use-assistant-reply-peek";
import { ChatRuntimeContext } from "@/context/chat-runtime-context";
import "./chat-sidebar.css";

// Legend List sums numeric paddings into its content length; passing
// strings (`"10px"`) breaks the math. Keep these as numbers.
const SIDEBAR_CONTENT_STYLE = {
  paddingLeft: 10,
  paddingRight: 10,
  paddingTop: 8,
  paddingBottom: 4,
} as const;

/** Centered column when the display panel owns the full content area. */
const WIDE_PANEL_CONTENT_STYLE = {
  maxWidth: "min(50rem, 100%)",
  marginLeft: "auto",
  marginRight: "auto",
  paddingLeft: 24,
  paddingRight: 24,
  paddingTop: 16,
  paddingBottom: 4,
} as const;

interface ChatSidebarOpenOptions {
  /** When provided, attaches/replaces the current chat context before opening. */
  chatContext?: ChatContext | null;
  /** When provided, sets the composer text (replaces existing input). */
  prefillText?: string;
}

export type ChatPanelOpenRequest = ChatSidebarOpenOptions & {
  id: number;
};

interface ChatPanelTabProps {
  openRequest?: ChatPanelOpenRequest | null;
  variant?: "mini" | "sidebar";
  messages: MessageRecord[];
  conversationId?: string | null;
  /**
   * Persisted agent-lifecycle activity + the latest message timestamp,
   * merged with `liveTasks` in CompactConversationSurface to back the
   * inline background-work cards (reload-safe terminal status).
   */
  activities: EventRecord[];
  latestMessageTimestampMs: number | null;
  isStreaming: boolean;
  /** True once the in-flight run has streamed any visible assistant text. */
  isStreamingResponseText?: boolean;
  runtimeStatusText?: string | null;
  /** Run id of the in-flight orchestrator run, used to scope the working
   * indicator's "step aside for a sub-agent" behavior to the current
   * run's own spawned agents. */
  activeRunId?: string | null;
  activeToolCallId?: string | null;
  activeToolName?: string | null;
  hasToolActivity?: boolean;
  isToolActive?: boolean;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  liveTasks?: TaskItem[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  onLoadOlder: () => void;
  onSend: (
    text: string,
    chatContext?: ChatContext | null,
    selectedText?: string | null,
  ) => void;
  onStop?: () => void;
  onNewChat: () => void | Promise<void>;
  /** When the display sidebar is expanded to full width. */
  wideLayout?: boolean;
}

export function ChatPanelTab({
  openRequest,
  variant = "sidebar",
  wideLayout = false,
  messages,
  conversationId,
  activities,
  latestMessageTimestampMs,
  isStreaming,
  isStreamingResponseText,
  runtimeStatusText,
  activeRunId,
  activeToolCallId,
  activeToolName,
  hasToolActivity,
  isToolActive,
  pendingUserMessageId,
  queuedUserMessages,
  liveTasks,
  hasOlderMessages,
  isLoadingOlder,
  isInitialLoading,
  onLoadOlder,
  onSend,
  onStop,
  onNewChat,
}: ChatPanelTabProps) {
  const [inputText, setInputText] = useState("");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoredConversationScrollRef = useRef<string | null>(null);

  // Perf: the auto-context suggestion strip polls native window/AX
  // enumeration on an interval. Only treat the composer surface as "active"
  // (and thus pollable) while this window is focused and visible — otherwise
  // a backgrounded/hidden renderer (full or mini) keeps spawning the macOS
  // helper + osascript for chips nobody can see. The hook also self-gates on
  // visibility, but unmounting the poll setup here avoids even arming it.
  const [surfaceActive, setSurfaceActive] = useState(
    () =>
      typeof document === "undefined" ||
      (!document.hidden && document.hasFocus()),
  );
  useEffect(() => {
    const sync = () =>
      setSurfaceActive(!document.hidden && document.hasFocus());
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  // The mini window mounts ChatPanelTab without a ChatRuntimeProvider, so
  // read the runtime optionally. Area annotation is a full-window feature;
  // when there's no provider the "Select area" action is simply omitted.
  const chatRuntime = useContext(ChatRuntimeContext);
  const startAnnotation = chatRuntime?.annotation.start;
  // The activity pill reads the shared chat runtime, so it can only mount
  // where a provider exists. The mini window has none, so it keeps the inline
  // indicator covering spawned-agent work; every provider-backed surface shows
  // the pill (and its progress summaries) just like the full shell.
  const showActivityPill = variant !== "mini" && Boolean(chatRuntime);

  /*
   * Own scroll-management instance for the sidebar list. Mirrors the
   * full chat (`useFullShellChat` → `useChatScrollManagement`) so the
   * sidebar gets the same Legend-List-backed at-bottom tracking and
   * thumb behavior as the home full chat.
   */
  const sidebarScroll = useChatScrollManagement({
    hasOlderEvents: hasOlderMessages,
    isLoadingOlder,
    onLoadOlder,
    surface: "compact",
  });

  useEffect(() => {
    if (
      !conversationId ||
      isInitialLoading ||
      messages.length === 0 ||
      restoredConversationScrollRef.current === conversationId
    ) {
      return;
    }
    const restoredConversationId = conversationId;
    const frame = window.requestAnimationFrame(() => {
      sidebarScroll.scrollToBottom("instant");
      restoredConversationScrollRef.current = restoredConversationId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationId,
    isInitialLoading,
    messages.length,
    sidebarScroll.scrollToBottom,
  ]);

  const assistantReplyPeek = useAssistantReplyPeek({
    messages,
    isFollowingLatest: sidebarScroll.isFollowingLatest,
  });

  const sidebarScrollApi = useMemo<ChatColumnScroll>(
    () => ({
      listRef: sidebarScroll.listRef,
      onListScroll: sidebarScroll.onListScroll,
      onStartReached: sidebarScroll.onStartReached,
      showScrollButton: sidebarScroll.showScrollButton,
      isAtBottom: sidebarScroll.isAtBottom,
      isFollowingLatest: sidebarScroll.isFollowingLatest,
      getIsFollowing: sidebarScroll.getIsFollowing,
      scrollToBottom: sidebarScroll.scrollToBottom,
      thumbRef: sidebarScroll.thumbRef,
    }),
    [
      sidebarScroll.listRef,
      sidebarScroll.onListScroll,
      sidebarScroll.onStartReached,
      sidebarScroll.showScrollButton,
      sidebarScroll.isAtBottom,
      sidebarScroll.isFollowingLatest,
      sidebarScroll.getIsFollowing,
      sidebarScroll.scrollToBottom,
      sidebarScroll.thumbRef,
    ],
  );

  useReadAloud(messages);
  // The inline background-work card now owns spawned-agent state in every
  // surface (full, sidebar, mini), so the inline indicator always steps
  // aside for sub-agent work and doesn't double up with the card.
  const indicatorProps = buildInlineWorkingIndicatorProps({
    isStreaming: Boolean(isStreaming),
    isStreamingResponseText: Boolean(isStreamingResponseText),
    isToolActive: Boolean(isToolActive),
    hasToolActivity: Boolean(hasToolActivity),
    activeToolName,
    activeToolCallId,
    runtimeStatusText,
    liveTasks,
    activeRunId,
  });

  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const {
    screenshot: previewScreenshot,
    previewIndex: previewScreenshotIndex,
    setPreviewIndex: setPreviewScreenshotIndex,
  } = useScreenshotPreview(chatContext);

  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext,
    disabled: isStreaming,
  });

  const submitFromDictationRef = useRef<() => void>(() => {});

  const attachAnnotation = useCallback(
    (selection: AnnotationSelection) => {
      attachComposerAppSelectionContext(selection, setChatContext);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [setChatContext],
  );

  const handleSelectArea = useMemo(() => {
    if (!startAnnotation) return undefined;
    return () => startAnnotation({ submit: attachAnnotation });
  }, [startAnnotation, attachAnnotation]);

  const handleNewChat = useCallback(async () => {
    await onNewChat();
    setInputText("");
    setChatContext(null);
    setSelectedText(null);
    setSidebarExpanded(false);
  }, [onNewChat, setChatContext, setSelectedText]);

  const dictation = useDictation({
    message: inputText,
    setMessage: setInputText,
    // Dictation stays available even while the orchestrator is busy
    // (mid-turn / streaming) — the mic is intentionally NOT gated on
    // `isStreaming`. See `submitComposer` for the in-flight submit flow.
    onTranscriptCommitted: () => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
    onCommit: () => {
      submitFromDictationRef.current();
    },
  });

  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.chatContext !== undefined) {
      setChatContext(openRequest.chatContext);
    }
    if (typeof openRequest.prefillText === "string") {
      setInputText(openRequest.prefillText);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [openRequest, setChatContext]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInputText("");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useAnimatedComposerShell({
    active: true,
    shellRef,
    contentRef: shellContentRef,
    formRef,
    syncOnNextFrame: true,
  });

  const sendCurrentMessage = useCallback(() => {
    const { canSubmit, trimmedMessage } = deriveComposerState({
      message: inputText,
      chatContext,
    });
    if (!canSubmit) return;
    // Follow-latch (intent) wins over the physical near-bottom
    // pixel check: after a short reply the user is visually at the
    // bottom but ~150px above the absolute content end (off-screen
    // trailing-region footer). A pure pixel check would skip the
    // next send's nudge in that window.
    const shouldNudgeAfterSend = sidebarScroll.getIsFollowing();
    onSend(trimmedMessage, chatContext, selectedText);
    setInputText("");
    setChatContext(null);
    setSelectedText(null);
    setSidebarExpanded(false);
    if (isStreaming) {
      // Queued follow-up — no new user row lands in the event
      // list, just a chip in the trailing region. Keep that footer
      // stack framed without falling through to the prior turn's
      // user bubble.
      if (shouldNudgeAfterSend) {
        sidebarScroll.nudgeQueuedMessagesIntoView();
      }
    } else if (shouldNudgeAfterSend) {
      // Routes the small post-send bump through the same lerp loop
      // as streaming auto-follow so the two motions blend rather
      // than fight via separate concurrent rAF tweens.
      sidebarScroll.nudgeAfterSend();
    } else {
      sidebarScroll.releaseFollow();
    }
  }, [
    inputText,
    chatContext,
    isStreaming,
    onSend,
    selectedText,
    setChatContext,
    setSelectedText,
    sidebarScroll,
  ]);

  const submitFromDictation = useCallback(() => {
    sendCurrentMessage();
  }, [sendCurrentMessage]);

  // Submitting while a recording/transcription is still in flight must not
  // race ahead of the dictated text. `commitAndSend` stops + finalizes the
  // recording, waits for the pending transcript to be appended to the
  // composer, and only then fires `onCommit` (→ sendCurrentMessage). For the
  // idle case it sends immediately. Transcription is time-bounded (see the
  // dictation service's per-segment timeout), so a stalled request fails into
  // a recoverable error and fires the commit instead of wedging submit.
  const submitComposer = useCallback(() => {
    if (dictation.isRecording || dictation.isTranscribing) {
      dictation.commitAndSend();
      return;
    }
    sendCurrentMessage();
  }, [dictation, sendCurrentMessage]);

  useEffect(() => {
    submitFromDictationRef.current = submitFromDictation;
  }, [submitFromDictation]);

  const composerState = deriveComposerState({
    message: inputText,
    chatContext,
    selectedText,
  });
  const hasText = inputText.trim().length > 0;
  const dictationBelow = dictation.isRecordingVisible && hasText;
  const dictationInline = dictation.isRecordingVisible && !hasText;
  const formExpanded = sidebarExpanded || dictationBelow;

  // Keep the pill shape in sync when `inputText` changes outside of
  // onChange (e.g. cleared by send, or set by dictation).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      updateComposerTextareaExpansion(inputRef.current, setSidebarExpanded);
    });
    return () => cancelAnimationFrame(raf);
  }, [inputText]);

  return (
    <div
      className={`chat-panel-tab chat-panel-tab--${variant}${wideLayout ? " chat-panel-tab--wide" : ""}`}
      {...dropHandlers}
    >
      <div
        className={
          wideLayout
            ? "full-body-row chat-panel-tab__row"
            : "chat-panel-tab__body"
        }
      >
        <div className="chat-sidebar-inner">
          <div className="chat-sidebar-main">
            <CompactConversationSurface
              className="chat-sidebar-messages"
              variant={variant}
              scroll={sidebarScrollApi}
              messages={messages}
              conversationId={conversationId}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              liveTasks={liveTasks}
              activities={activities}
              latestMessageTimestampMs={latestMessageTimestampMs}
              indicator={indicatorProps}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
              contentContainerStyle={
                wideLayout ? WIDE_PANEL_CONTENT_STYLE : SIDEBAR_CONTENT_STYLE
              }
              estimatedItemSize={wideLayout ? 140 : undefined}
            />

            <div className="chat-sidebar-composer">
              <ComposerLeadRow
                replyPeek={
                  assistantReplyPeek.visible
                    ? {
                        text: assistantReplyPeek.previewText,
                        onJumpToBottom: () =>
                          sidebarScroll.scrollToBottom("smooth"),
                        onDismiss: assistantReplyPeek.dismiss,
                      }
                    : null
                }
                showActivityPill={showActivityPill}
                suggestionsActive={surfaceActive}
                chatContext={chatContext}
                setChatContext={setChatContext}
              />

              <div
                ref={shellRef}
                className={`chat-sidebar-shell${isDragOver ? " chat-sidebar-shell--drag-over" : ""}`}
              >
                <div
                  ref={shellContentRef}
                  className="chat-sidebar-shell-content"
                >
                  {hasAttachedComposerChips(chatContext, selectedText) && (
                    <div className="composer-attached-strip composer-attached-strip--mini">
                      <ComposerContextRow
                        variant="mini"
                        chatContext={chatContext}
                        selectedText={selectedText}
                        setChatContext={setChatContext}
                        setSelectedText={setSelectedText}
                        onPreviewScreenshot={setPreviewScreenshotIndex}
                      />
                    </div>
                  )}
                  <form
                    ref={formRef}
                    className={`chat-sidebar-form${formExpanded ? " expanded" : ""}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitComposer();
                    }}
                  >
                    <ComposerAddMenu
                      className="composer-add-button"
                      title="Add"
                      setChatContext={setChatContext}
                      onSelectArea={handleSelectArea}
                      onNewChat={handleNewChat}
                    />

                    {dictationInline ? (
                      <DictationRecordingBar
                        levels={dictation.levels}
                        elapsedMs={dictation.elapsedMs}
                        onCancel={dictation.cancel}
                        onConfirm={dictation.toggle}
                        onSend={dictation.commitAndSend}
                        showControls={dictation.showControls}
                      />
                    ) : (
                      <>
                        <ComposerTextarea
                          ref={inputRef}
                          className="chat-sidebar-input"
                          tone="default"
                          value={inputText}
                          rows={1}
                          onChange={(event) => {
                            setInputText(event.target.value);
                            requestAnimationFrame(() => {
                              updateComposerTextareaExpansion(
                                inputRef.current,
                                setSidebarExpanded,
                              );
                            });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              submitComposer();
                            }
                          }}
                          onPaste={(event) => {
                            handleComposerPaste(event, setChatContext);
                          }}
                          placeholder={composerState.placeholder}
                        />

                        <div className="composer-toolbar">
                          <div className="composer-toolbar-left">
                            <ComposerAddMenu
                              className="composer-add-button composer-add-button--toolbar"
                              title="Add"
                              setChatContext={setChatContext}
                              onSelectArea={handleSelectArea}
                              onNewChat={handleNewChat}
                            />
                          </div>

                          <div className="composer-toolbar-right">
                            <ComposerMicButton
                              className="composer-mic"
                              isTranscribing={dictation.isTranscribing}
                              disabled={dictation.isTranscribing}
                              onClick={dictation.toggle}
                              title={
                                dictation.error
                                  ? `Dictation: ${dictation.error}`
                                  : undefined
                              }
                            />
                            {isStreaming && (
                              <ComposerStopButton
                                className="composer-stop"
                                onClick={onStop}
                                title="Stop"
                                aria-label="Stop"
                              />
                            )}
                            <ComposerSubmitButton
                              className="composer-submit"
                              disabled={!composerState.canSubmit}
                              animated
                            />
                          </div>
                        </div>

                        {dictationBelow && (
                          <div className="composer-dictation-row">
                            <DictationRecordingBar
                              levels={dictation.levels}
                              elapsedMs={dictation.elapsedMs}
                              onCancel={dictation.cancel}
                              onConfirm={dictation.toggle}
                              onSend={dictation.commitAndSend}
                              showControls={dictation.showControls}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {previewScreenshot && previewScreenshotIndex !== null && (
        <ScreenshotPreviewOverlay
          screenshot={previewScreenshot}
          index={previewScreenshotIndex}
          onClose={() => setPreviewScreenshotIndex(null)}
        />
      )}
    </div>
  );
}
