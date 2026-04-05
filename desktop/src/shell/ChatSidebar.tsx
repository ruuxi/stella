import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { animate } from "motion";
import { createPortal } from "react-dom";
import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
import {
  ComposerAddButton,
  ComposerSubmitButton,
  ComposerStopButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import {
  FileContextChips,
  ScreenshotContextChips,
} from "@/app/chat/ComposerContextChips";
import { ComposerWindowContextSection } from "@/app/chat/ComposerContextSections";
import { deriveComposerState } from "@/app/chat/composer-context";
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { DropOverlay } from "@/app/chat/DropOverlay";
import type { ChatContext } from "@/shared/types/electron";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import "./chat-sidebar.css";

export interface ChatSidebarHandle {
  open(chatContext?: ChatContext | null): void;
  close(): void;
}

interface ChatSidebarProps {
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  selfModMap: Record<string, SelfModAppliedData>;
  liveTasks?: TaskItem[];
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  onSend: (text: string, chatContext?: ChatContext | null) => void;
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
    const [chatContext, setChatContext] = useState<ChatContext | null>(null);
    const [sidebarExpanded, setSidebarExpanded] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const formRef = useRef<HTMLFormElement | null>(null);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const heightAnimRef = useRef<ReturnType<typeof animate> | null>(null);
    const lastHeightRef = useRef(0);

    const { isDragOver, dropHandlers } = useFileDrop({
      setChatContext,
      disabled: isStreaming,
    });

    useImperativeHandle(ref, () => ({
      open(ctx?: ChatContext | null) {
        if (ctx !== undefined) {
          setChatContext(ctx);
        }
        setIsOpen(true);
      },
      close() {
        setIsOpen(false);
        setInputText("");
        setChatContext(null);
        setSidebarExpanded(false);
      },
    }));

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
       (ResizeObserver + spring). Only attach while sidebar is open so layout
       is valid after the panel width finishes expanding. */
    useEffect(() => {
      if (!isOpen) return;

      const form = formRef.current;
      const shell = shellRef.current;
      if (!form || !shell || typeof ResizeObserver === "undefined") return;

      const syncShellToForm = () => {
        lastHeightRef.current = form.getBoundingClientRect().height;
        shell.style.height = `${lastHeightRef.current}px`;
        shell.style.borderRadius = form.classList.contains("expanded")
          ? "20px"
          : `${Math.min(999, lastHeightRef.current)}px`;
      };

      syncShellToForm();

      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const newH =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs(newH - lastHeightRef.current) < 1) return;

        lastHeightRef.current = newH;
        const expanded = form.classList.contains("expanded");
        const targetRadius = expanded ? 20 : Math.min(999, newH);

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

      ro.observe(form);

      const id = requestAnimationFrame(() => {
        syncShellToForm();
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
        onSend(trimmedMessage, chatContext);
        setInputText("");
        setChatContext(null);
        setSidebarExpanded(false);
      },
      [inputText, chatContext, onSend],
    );

    const composerState = deriveComposerState({
      message: inputText,
      chatContext,
    });

    const hasContextChips = Boolean(
      chatContext?.window ||
        chatContext?.regionScreenshots?.length ||
        chatContext?.files?.length,
    );

    const portalTarget =
      document.querySelector(".full-body") ?? document.body;

    return createPortal(
      <aside
        className={`chat-sidebar${isOpen ? " chat-sidebar--open" : ""}`}
        aria-hidden={!isOpen}
      >
        <div className="chat-sidebar-inner">
          <CompactConversationSurface
            className="chat-sidebar-messages"
            conversationClassName="chat-sidebar-conversation"
            variant="sidebar"
            events={events}
            streamingText={streamingText}
            reasoningText={reasoningText}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
            selfModMap={selfModMap}
            liveTasks={liveTasks}
            hasOlderEvents={hasOlderEvents}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isInitialLoading}
          />

          <div className="chat-sidebar-composer" {...dropHandlers}>
            <DropOverlay visible={isDragOver} variant="orb" />

            {hasContextChips && (
              <div className="chat-sidebar-attachments">
                <ComposerWindowContextSection
                  variant="mini"
                  chatContext={chatContext}
                  setChatContext={setChatContext}
                />
                {(chatContext?.regionScreenshots?.length ?? 0) > 0 && (
                  <ScreenshotContextChips
                    screenshots={chatContext!.regionScreenshots!}
                    setChatContext={setChatContext}
                    chipClassName="chat-composer-context-chip chat-composer-context-chip--screenshot mini-context-chip mini-context-chip--screenshot"
                    imageClassName="chat-composer-context-thumb mini-context-thumb"
                    removeClassName="chat-composer-context-remove mini-context-remove"
                  />
                )}
                {(chatContext?.files?.length ?? 0) > 0 && (
                  <FileContextChips
                    files={chatContext!.files!}
                    setChatContext={setChatContext}
                    chipClassName="mini-context-chip"
                    removeClassName="chat-composer-context-remove mini-context-remove"
                  />
                )}
              </div>
            )}

            <div ref={shellRef} className="chat-sidebar-shell">
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
      </aside>,
      portalTarget,
    );
  },
);
