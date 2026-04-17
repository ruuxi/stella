import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useTheme } from "@/context/theme-context";
import { animate } from "motion";
import { createPortal } from "react-dom";
import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
import {
  ComposerContextRow,
  ComposerSuggestionContextRow,
} from "@/app/chat/ComposerContextRow";
import {
  ComposerAddButton,
  ComposerSubmitButton,
  ComposerStopButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "@/app/chat/composer-context";
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { useScreenshotPreview, ScreenshotPreviewOverlay } from "@/app/chat/ScreenshotPreview";
import type { ChatContext } from "@/shared/types/electron";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import { useChatContextSync } from "./use-chat-context-sync";
import { ShiftingGradient } from "./background/ShiftingGradient";
import "./chat-sidebar.css";

export interface ChatSidebarOpenOptions {
  /** When provided, attaches/replaces the current chat context before opening. */
  chatContext?: ChatContext | null;
  /** When provided, sets the composer text (replaces existing input). */
  prefillText?: string;
}

export interface ChatSidebarHandle {
  open(options?: ChatSidebarOpenOptions | ChatContext | null): void;
  close(): void;
}

/**
 * The legacy signature was `open(chatContext)`; the new one is
 * `open({ chatContext, prefillText })`. We detect the new form by looking
 * for either explicit options key — `regionScreenshots` is unique to
 * `ChatContext` so its presence means the caller passed a raw context.
 */
const normalizeOpenArg = (
  arg?: ChatSidebarOpenOptions | ChatContext | null,
): ChatSidebarOpenOptions => {
  if (arg === undefined) return {};
  if (arg === null) return { chatContext: null };
  if ("chatContext" in arg || "prefillText" in arg) {
    return arg as ChatSidebarOpenOptions;
  }
  if ("regionScreenshots" in arg) {
    return { chatContext: arg as ChatContext };
  }
  return arg as ChatSidebarOpenOptions;
};

interface ChatSidebarProps {
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
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
  onAdd?: () => void;
  onOpenChange?: (open: boolean) => void;
}

export const ChatSidebar = forwardRef<ChatSidebarHandle, ChatSidebarProps>(
  function ChatSidebar(
    {
      events,
      streamingText,
      reasoningText,
      isStreaming,
      runtimeStatusText,
      pendingUserMessageId,
      selfModMap,
      liveTasks,
      hasOlderEvents,
      isLoadingOlder,
      isInitialLoading,
      onSend,
      onAdd,
      onOpenChange,
    },
    ref,
  ) {
    const [isOpen, setIsOpen] = useState(false);
    const [inputText, setInputText] = useState("");
    const [sidebarExpanded, setSidebarExpanded] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const { gradientMode, gradientColor } = useTheme();
    const { chatContext, setChatContext, selectedText, setSelectedText } =
      useChatContextSync();
    const { screenshot: previewScreenshot, previewIndex: previewScreenshotIndex, setPreviewIndex: setPreviewScreenshotIndex } =
      useScreenshotPreview(chatContext);

    const formRef = useRef<HTMLFormElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const shellContentRef = useRef<HTMLDivElement | null>(null);
    const heightAnimRef = useRef<ReturnType<typeof animate> | null>(null);
    const lastHeightRef = useRef(0);

    const { isDragOver, dropHandlers } = useFileDrop({
      setChatContext,
      disabled: isStreaming,
    });

    useImperativeHandle(ref, () => ({
      open(arg?: ChatSidebarOpenOptions | ChatContext | null) {
        const options = normalizeOpenArg(arg);
        if (options.chatContext !== undefined) {
          setChatContext(options.chatContext);
        }
        if (typeof options.prefillText === "string") {
          setInputText(options.prefillText);
        }
        setIsOpen(true);
      },
      close() {
        setIsOpen(false);
        setInputText("");
        setChatContext(null);
        setSelectedText(null);
        setSidebarExpanded(false);
      },
    }), [setChatContext, setSelectedText]);

    useEffect(() => {
      onOpenChange?.(isOpen);
    }, [isOpen, onOpenChange]);

    useEffect(() => {
      if (isOpen && inputRef.current) {
        inputRef.current.focus();
      }
    }, [isOpen]);

    useEffect(() => {
      if (!isOpen) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setIsOpen(false);
          setInputText("");
        }
      };

      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen]);

    /* Shell height + corner radius — same behavior as full chat Composer
       (ResizeObserver + spring). Watches the shell-content wrapper (chip
       strip + form) so the shell grows when chips are attached. Only attach
       while sidebar is open so layout is valid after the panel width finishes
       expanding. */
    useEffect(() => {
      if (!isOpen) return;

      const content = shellContentRef.current;
      const form = formRef.current;
      const shell = shellRef.current;
      if (!content || !form || !shell || typeof ResizeObserver === "undefined") return;

      const syncShellToContent = () => {
        lastHeightRef.current = content.getBoundingClientRect().height;
        shell.style.height = `${lastHeightRef.current}px`;
        const expanded = form.classList.contains("expanded");
        const hasChips = Boolean(content.querySelector(".composer-attached-strip"));
        shell.style.borderRadius = expanded || hasChips
          ? "20px"
          : `${Math.min(999, lastHeightRef.current)}px`;
      };

      syncShellToContent();

      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const newH =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs(newH - lastHeightRef.current) < 1) return;

        lastHeightRef.current = newH;
        const expanded = form.classList.contains("expanded");
        const hasChips = Boolean(content.querySelector(".composer-attached-strip"));
        const targetRadius = expanded || hasChips ? 20 : Math.min(999, newH);

        heightAnimRef.current?.stop();
        heightAnimRef.current = animate(
          shell,
          { height: `${newH}px`, borderRadius: `${targetRadius}px` },
          {
            type: "spring",
            duration: 0.35,
            bounce: 0,
          },
        );
      });

      ro.observe(content);

      const id = requestAnimationFrame(() => {
        syncShellToContent();
      });

      return () => {
        cancelAnimationFrame(id);
        ro.disconnect();
        heightAnimRef.current?.stop();
      };
    }, [isOpen]);

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

    const portalTarget =
      document.querySelector(".full-body") ?? document.body;

    return createPortal(
      <aside
        className={`chat-sidebar${isOpen ? " chat-sidebar--open" : ""}`}
        aria-hidden={!isOpen}
      >
        <div className="chat-sidebar-inner">
          <ShiftingGradient
            mode={gradientMode}
            colorMode={gradientColor}
            contained
          />
          <div className="chat-sidebar-main">
            <CompactConversationSurface
              className="chat-sidebar-messages"
              conversationClassName="chat-sidebar-conversation"
              variant="sidebar"
              events={events}
              streamingText={streamingText}
              reasoningText={reasoningText}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              selfModMap={selfModMap}
              liveTasks={liveTasks}
              hasOlderEvents={hasOlderEvents}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
            />

            <div className="chat-sidebar-composer" {...dropHandlers}>
              <DropOverlay visible={isDragOver} variant="orb" />

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
                    onSubmit={handleSubmit}
                  >
                    <ComposerAddButton
                      className="composer-add-button"
                      title="Add"
                      onClick={onAdd}
                    />

                    <ComposerTextarea
                      ref={inputRef}
                      className="chat-sidebar-input"
                      tone="default"
                      value={inputText}
                      rows={1}
                      onChange={(event) => {
                        setInputText(event.target.value);
                        requestAnimationFrame(() => {
                          const el = inputRef.current;
                          if (!el) return;
                          const form = el.closest(".chat-sidebar-form") as HTMLElement | null;
                          if (!form) return;
                          const isExp = form.classList.contains("expanded");

                          if (!isExp) {
                            if (el.scrollHeight > 44) setSidebarExpanded(true);
                          } else {
                            form.classList.remove("expanded");
                            const pillSh = el.scrollHeight;
                            form.classList.add("expanded");
                            if (pillSh <= 44) setSidebarExpanded(false);
                          }
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
                        <ComposerAddButton
                          className="composer-add-button composer-add-button--toolbar"
                          title="Add"
                          onClick={onAdd}
                        />
                      </div>

                      <div className="composer-toolbar-right">
                        {isStreaming && (
                          <ComposerStopButton
                            className="composer-stop"
                            onClick={() => {
                              /* stop handled externally */
                            }}
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
      </aside>,
      portalTarget,
    );
  },
);
