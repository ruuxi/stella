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
import { DropOverlay } from "@/app/chat/DropOverlay";
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
import { smoothScrollTo } from "@/shared/lib/smooth-scroll";
import "./chat-sidebar.css";

// Legend List sums numeric paddings into its content length; passing
// strings (`"10px"`) breaks the math. Keep these as numbers.
const SIDEBAR_CONTENT_STYLE = {
  paddingLeft: 10,
  paddingRight: 10,
  paddingTop: 8,
  paddingBottom: 4,
} as const;

const SENT_MESSAGE_SCROLL_NUDGE_MS = 360;
const SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS = 80;

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
  streamingText: string;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  optimisticUserMessageIds: string[];
  liveTasks?: TaskItem[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  onSend: (
    text: string,
    chatContext?: ChatContext | null,
    selectedText?: string | null,
  ) => void;
  onStop?: () => void;
}

export function ChatPanelTab(
    {
      openRequest,
      messages,
      activities,
      latestMessageTimestampMs,
      streamingText,
      isStreaming,
      runtimeStatusText,
      pendingUserMessageId,
      queuedUserMessages,
      optimisticUserMessageIds,
      liveTasks,
      hasOlderMessages,
      isLoadingOlder,
      isInitialLoading,
      onSend,
      onStop,
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
    });

    const sidebarScrollApi = useMemo<ChatColumnScroll>(
      () => ({
        listRef: sidebarScroll.listRef,
        onListScroll: sidebarScroll.onListScroll,
        onStartReached: sidebarScroll.onStartReached,
        showScrollButton: sidebarScroll.showScrollButton,
        isAtBottom: sidebarScroll.isAtBottom,
        isNearBottom: sidebarScroll.isNearBottom,
        getIsNearBottom: sidebarScroll.getIsNearBottom,
        scrollToBottom: sidebarScroll.scrollToBottom,
        thumbState: sidebarScroll.thumbState,
      }),
      [
        sidebarScroll.listRef,
        sidebarScroll.onListScroll,
        sidebarScroll.onStartReached,
        sidebarScroll.showScrollButton,
        sidebarScroll.isAtBottom,
        sidebarScroll.isNearBottom,
        sidebarScroll.getIsNearBottom,
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

    const nudgeToCurrentBottomAfterSend = useCallback(() => {
      const scrollToCurrentBottom = () => {
        const el = sidebarScroll.listRef.current?.getScrollableNode() as
          | HTMLElement
          | null;
        if (!el) return;
        smoothScrollTo(
          el,
          el.scrollHeight - el.clientHeight,
          SENT_MESSAGE_SCROLL_NUDGE_MS,
        );
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToCurrentBottom();
          window.setTimeout(
            scrollToCurrentBottom,
            SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS,
          );
        });
      });
    }, [sidebarScroll.listRef]);

    const sendCurrentMessage = useCallback(() => {
      const { canSubmit, trimmedMessage } = deriveComposerState({
        message: inputText,
        chatContext,
      });
      if (!canSubmit) return;
      const shouldNudgeAfterSend = sidebarScrollApi.getIsNearBottom();
      onSend(trimmedMessage, chatContext, selectedText);
      setInputText("");
      setChatContext(null);
      setSelectedText(null);
      setSidebarExpanded(false);
      if (shouldNudgeAfterSend) {
        nudgeToCurrentBottomAfterSend();
      }
    }, [
      inputText,
      chatContext,
      nudgeToCurrentBottomAfterSend,
      onSend,
      selectedText,
      setChatContext,
      setSelectedText,
      sidebarScrollApi,
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
        className="chat-panel-tab"
        {...dropHandlers}
      >
        <div className="chat-sidebar-inner">
          <DropOverlay visible={isDragOver} variant="sidebar" />
          <div className="chat-sidebar-main">
            <CompactConversationSurface
              className="chat-sidebar-messages"
              variant="sidebar"
              scroll={sidebarScrollApi}
              messages={messages}
              streamingText={streamingText}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              optimisticUserMessageIds={optimisticUserMessageIds}
              liveTasks={liveTasks}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
              contentContainerStyle={SIDEBAR_CONTENT_STYLE}
            />

            <div className="chat-sidebar-composer">
              <ComposerSuggestionContextRow
                chatContext={chatContext}
                setChatContext={setChatContext}
                indicator={suggestionIndicatorProps}
              />

              <div ref={shellRef} className="chat-sidebar-shell">
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
                      onSelectArea={() => setAreaSelectActive(true)}
                      disabled={isStreaming}
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
                              onSelectArea={() => setAreaSelectActive(true)}
                              disabled={isStreaming}
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
