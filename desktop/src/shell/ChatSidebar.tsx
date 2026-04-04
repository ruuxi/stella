import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
import {
  ComposerAddButton,
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
import type { EventRecord } from "@/app/chat/lib/event-transforms";
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
    const inputRef = useRef<HTMLTextAreaElement>(null);

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
            hasOlderEvents={hasOlderEvents}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isInitialLoading}
          />

          <form
            className="chat-sidebar-composer"
            onSubmit={handleSubmit}
            {...dropHandlers}
          >
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

            <div className="chat-sidebar-input-row">
              <ComposerAddButton
                className="chat-sidebar-add"
                title="Add"
                onClick={onAdd}
              />
              <ComposerTextarea
                ref={inputRef}
                className="chat-sidebar-input"
                tone="default"
                value={inputText}
                rows={1}
                onChange={(event) => setInputText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSubmit(event);
                  }
                }}
                placeholder={composerState.placeholder}
              />
            </div>
          </form>
        </div>
      </aside>,
      portalTarget,
    );
  },
);
