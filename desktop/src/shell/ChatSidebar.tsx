import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { useScreenshotPreview, ScreenshotPreviewOverlay } from "@/app/chat/ScreenshotPreview";
import type { ChatContext } from "@/shared/types/electron";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import type {
  AgentResponseTarget,
  SelfModAppliedData,
} from "@/app/chat/streaming/streaming-types";
import { useCapturedChatContext } from "./use-captured-chat-context";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import "./chat-sidebar.css";

export interface ChatSidebarOpenOptions {
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
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  streamingResponseTarget?: AgentResponseTarget | null;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  selfModMap: Record<string, SelfModAppliedData>;
  liveTasks?: TaskItem[];
  hasOlderEvents: boolean;
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
      events,
      streamingText,
      reasoningText,
      streamingResponseTarget,
      isStreaming,
      runtimeStatusText,
      pendingUserMessageId,
      selfModMap,
      liveTasks,
      hasOlderEvents,
      isLoadingOlder,
      isInitialLoading,
      onSend,
      onStop,
    }: ChatPanelTabProps,
  ) {
    const [inputText, setInputText] = useState("");
    const [sidebarExpanded, setSidebarExpanded] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const pinnedTurnIdRef = useRef<string | null>(null);

    /*
     * Own scroll-management instance for the sidebar viewport. Mirrors the
     * full chat (`useFullShellChat` → `useChatScrollManagement`) so the
     * sidebar gets the same user-bubble pin-to-top, custom auto-anchor,
     * and ResizeObserver-driven follow behavior — instead of the previous
     * raw `scrollTop = 0` snap that visibly "unsettled" assistant replies
     * mid-stream and after CV containment toggled on completed turns.
     *
     * `pauseResizeFollow` mirrors the full-chat semantic: while a reply is
     * in flight (`pendingUserMessageId`), don't re-snap to the newest edge
     * on resize — the user bubble is pinned to the top instead.
     */
    const sidebarScroll = useChatScrollManagement({
      hasOlderEvents,
      isLoadingOlder,
      isWorking: isStreaming,
      pauseResizeFollow: Boolean(pendingUserMessageId),
    });

    const sidebarScrollApi = useMemo<ChatColumnScroll>(
      () => ({
        setViewportElement: sidebarScroll.setScrollContainerElement,
        setContentElement: sidebarScroll.setContentElement,
        onScroll: sidebarScroll.handleScroll,
        showScrollButton: sidebarScroll.showScrollButton,
        isAtBottom: sidebarScroll.isNearBottom,
        scrollToBottom: sidebarScroll.scrollToBottom,
        scrollTurnToPinTop: sidebarScroll.scrollTurnToPinTop,
        overflowAnchor: sidebarScroll.overflowAnchor,
        thumbState: sidebarScroll.thumbState,
        hasScrollElement: sidebarScroll.hasScrollElement,
      }),
      [
        sidebarScroll.setScrollContainerElement,
        sidebarScroll.setContentElement,
        sidebarScroll.handleScroll,
        sidebarScroll.showScrollButton,
        sidebarScroll.isNearBottom,
        sidebarScroll.scrollToBottom,
        sidebarScroll.scrollTurnToPinTop,
        sidebarScroll.overflowAnchor,
        sidebarScroll.thumbState,
        sidebarScroll.hasScrollElement,
      ],
    );

    /*
     * Pin the freshly-sent user bubble to the top of the sidebar viewport
     * once `pendingUserMessageId` arrives. Mirrors `ChatColumn`'s effect.
     * The retry loop covers the case where the new turn isn't laid out yet
     * on the same frame the pendingUserMessageId becomes available.
     */
    const { scrollTurnToPinTop, hasScrollElement: hasSidebarScroll } =
      sidebarScrollApi;
    useLayoutEffect(() => {
      if (!pendingUserMessageId) {
        pinnedTurnIdRef.current = null;
        return;
      }
      if (pinnedTurnIdRef.current === pendingUserMessageId) return;

      let attempts = 0;
      const maxAttempts = 36;
      const tick = () => {
        const ok = scrollTurnToPinTop(pendingUserMessageId);
        if (ok) {
          pinnedTurnIdRef.current = pendingUserMessageId;
          return;
        }
        attempts += 1;
        if (attempts < maxAttempts) {
          requestAnimationFrame(tick);
        }
      };
      tick();
    }, [
      pendingUserMessageId,
      events.length,
      hasSidebarScroll,
      scrollTurnToPinTop,
    ]);

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

    const dictation = useDictation({
      message: inputText,
      setMessage: setInputText,
      disabled: isStreaming,
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

    const handleSubmit = useCallback(
      (event: React.FormEvent) => {
        event.preventDefault();
        const { canSubmit, trimmedMessage } = deriveComposerState({
          message: inputText,
          chatContext,
        });
        if (!canSubmit) return;
        onSend(trimmedMessage, chatContext, selectedText);
        setInputText("");
        setChatContext(null);
        setSelectedText(null);
        setSidebarExpanded(false);
      },
      [inputText, chatContext, onSend, selectedText, setChatContext, setSelectedText],
    );

    const composerState = deriveComposerState({
      message: inputText,
      chatContext,
      selectedText,
    });

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
              conversationClassName="chat-sidebar-conversation"
              variant="sidebar"
              scroll={sidebarScrollApi}
              events={events}
              streamingText={streamingText}
              reasoningText={reasoningText}
              streamingResponseTarget={streamingResponseTarget}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              selfModMap={selfModMap}
              liveTasks={liveTasks}
              hasOlderEvents={hasOlderEvents}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
            />

            <div className="chat-sidebar-composer">
              <ComposerSuggestionContextRow
                chatContext={chatContext}
                setChatContext={setChatContext}
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
                    className={`chat-sidebar-form${sidebarExpanded ? " expanded" : ""}`}
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
                      disabled={isStreaming}
                    />

                    {dictation.isRecording ? (
                      <DictationRecordingBar
                        levels={dictation.levels}
                        elapsedMs={dictation.elapsedMs}
                        onCancel={dictation.cancel}
                        onConfirm={dictation.toggle}
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
      </div>
    );
}
