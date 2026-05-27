import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
import type { ChatColumnScroll } from "@/app/chat/chat-column-types";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import {
  ComposerContextRow,
  ComposerSuggestionContextRow,
} from "@/app/chat/ComposerContextRow";
import { ComposerAddMenu } from "@/app/chat/ComposerAddMenu";
import { ComposerAreaSelectOverlay } from "@/app/chat/ComposerAreaSelectOverlay";
import {
  ComposerMicButton,
  ComposerSubmitButton,
  ComposerStopButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "@/app/chat/composer-context";
import type { InlineWorkingIndicatorMountProps } from "@/app/chat/InlineWorkingIndicator";
import { getCurrentRunningTool } from "@/app/chat/lib/event-transforms";
import { useAgentSessionStartedAt } from "@/app/chat/hooks/use-agent-session-started-at";
import { useFooterTasks } from "@/app/chat/hooks/use-footer-tasks";
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import { useScreenshotPreview, ScreenshotPreviewOverlay } from "@/app/chat/ScreenshotPreview";
import type { ChatContext } from "@/shared/types/electron";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import type { MessageRecord } from "../../../runtime/contracts/local-chat.js";
import type { QueuedUserMessage } from "@/app/chat/hooks/use-streaming-chat";
import { useCapturedChatContext } from "./use-captured-chat-context";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import { AssistantReplyPeek } from "@/app/chat/AssistantReplyPeek";
import { useAssistantReplyPeek } from "@/app/chat/hooks/use-assistant-reply-peek";
import { ChatWorkspaceStrip } from "@/app/chat/ChatWorkspaceStrip";
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
  messages: MessageRecord[];
  activities: EventRecord[];
  latestMessageTimestampMs: number | null;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
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

export function ChatPanelTab(
    {
      openRequest,
      wideLayout = false,
      messages,
      activities,
      latestMessageTimestampMs,
      isStreaming,
      runtimeStatusText,
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
    }: ChatPanelTabProps,
  ) {
    const [inputText, setInputText] = useState("");
    const [sidebarExpanded, setSidebarExpanded] = useState(false);
    const [areaSelectActive, setAreaSelectActive] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);

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
        thumbState: sidebarScroll.thumbState,
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
        sidebarScroll.thumbState,
      ],
    );

    const appSessionStartedAtMs = useAgentSessionStartedAt();
    const runningTool = useMemo(
      () => getCurrentRunningTool(messages),
      [messages],
    );
    const footerTasks = useFooterTasks({
      activities,
      latestMessageTimestampMs,
      liveTasks,
      appSessionStartedAtMs,
    });
    useReadAloud(messages);
    const hasActiveWork =
      footerTasks.length > 0 ||
      Boolean(isStreaming) ||
      Boolean(runtimeStatusText);
    const suggestionIndicatorProps: InlineWorkingIndicatorMountProps = {
      active: hasActiveWork,
      tasks: footerTasks,
      runningTool: runningTool?.tool,
      runningToolId: runningTool?.id,
      isStreaming,
      status: runtimeStatusText ?? null,
    };

    const { chatContext, setChatContext, selectedText, setSelectedText } =
      useCapturedChatContext();
    const { screenshot: previewScreenshot, previewIndex: previewScreenshotIndex, setPreviewIndex: setPreviewScreenshotIndex } =
      useScreenshotPreview(chatContext);

    const formRef = useRef<HTMLFormElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const shellContentRef = useRef<HTMLDivElement | null>(null);

    const { isDragOver, dropHandlers } = useFileDrop({
      setChatContext,
      disabled: isStreaming,
    });

    const submitFromDictationRef = useRef<() => void>(() => {});

    const dictation = useDictation({
      message: inputText,
      setMessage: setInputText,
      disabled: isStreaming,
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
        // list, just a chip in the trailing region. Nudging would
        // fall through to the prior turn's user bubble and scroll
        // backwards; the streaming-row auto-follow already owns the
        // viewport here.
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

    const handleSubmit = useCallback(
      (event: React.FormEvent) => {
        event.preventDefault();
        sendCurrentMessage();
      },
      [sendCurrentMessage],
    );

    const submitFromDictation = useCallback(() => {
      sendCurrentMessage();
    }, [sendCurrentMessage]);

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
        updateComposerTextareaExpansion(
          inputRef.current,
          setSidebarExpanded,
        );
      });
      return () => cancelAnimationFrame(raf);
    }, [inputText]);

    return (
      <div
        className={`chat-panel-tab${wideLayout ? " chat-panel-tab--wide" : ""}`}
        {...dropHandlers}
      >
        <div
          className={
            wideLayout ? "full-body-row chat-panel-tab__row" : "chat-panel-tab__body"
          }
        >
        <div className="chat-sidebar-inner">
          <div className="chat-sidebar-main">
            <CompactConversationSurface
              className="chat-sidebar-messages"
              variant="sidebar"
              scroll={sidebarScrollApi}
              messages={messages}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              liveTasks={liveTasks}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
              contentContainerStyle={
                wideLayout ? WIDE_PANEL_CONTENT_STYLE : SIDEBAR_CONTENT_STYLE
              }
              estimatedItemSize={wideLayout ? 140 : undefined}
            />

            <div className="chat-sidebar-composer">
              <div className="composer-context-peek-anchor">
                {assistantReplyPeek.visible ? (
                  <AssistantReplyPeek
                    text={assistantReplyPeek.previewText}
                    onJumpToBottom={() =>
                      sidebarScroll.scrollToBottom("smooth")
                    }
                    onDismiss={assistantReplyPeek.dismiss}
                  />
                ) : null}
                <ComposerSuggestionContextRow
                  chatContext={chatContext}
                  setChatContext={setChatContext}
                  indicator={suggestionIndicatorProps}
                />
              </div>

              <div
                ref={shellRef}
                className={`chat-sidebar-shell${isDragOver ? " chat-sidebar-shell--drag-over" : ""}`}
              >
                <div ref={shellContentRef} className="chat-sidebar-shell-content">
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
                      if (dictation.isRecording) {
                        event.preventDefault();
                        return;
                      }
                      handleSubmit(event);
                    }}
                  >
                    <ComposerAddMenu
                      className="composer-add-button"
                      title="Add"
                      setChatContext={setChatContext}
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
                              handleSubmit(event);
                            }
                          }}
                          placeholder={composerState.placeholder}
                        />

                        <div className="composer-toolbar">
                          <div className="composer-toolbar-left">
                            <ComposerAddMenu
                              className="composer-add-button composer-add-button--toolbar"
                              title="Add"
                              setChatContext={setChatContext}
                            />
                          </div>

                          <div className="composer-toolbar-right">
                            <ComposerMicButton
                              className="composer-mic"
                              isTranscribing={dictation.isTranscribing}
                              disabled={
                                isStreaming || dictation.isTranscribing
                              }
                              onClick={dictation.toggle}
                              title={dictation.error ? `Dictation: ${dictation.error}` : undefined}
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
        {wideLayout ? (
          <ChatWorkspaceStrip
            embeddedInDisplayPanel
            onNewChat={onNewChat}
            onSelectArea={() => setAreaSelectActive(true)}
          />
        ) : null}
        </div>
        {previewScreenshot && previewScreenshotIndex !== null && (
          <ScreenshotPreviewOverlay
            screenshot={previewScreenshot}
            index={previewScreenshotIndex}
            onClose={() => setPreviewScreenshotIndex(null)}
          />
        )}
        <ComposerAreaSelectOverlay
          active={areaSelectActive}
          setChatContext={setChatContext}
          onCancel={() => setAreaSelectActive(false)}
        />
      </div>
    );
}
