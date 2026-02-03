import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { AsciiBlackHole } from "../components/AsciiBlackHole";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents, type EventRecord } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getElectronApi } from "../services/electron";
import { streamChat } from "../services/model-gateway";
import type { ChatContext, ChatContextUpdate } from "../types/electron";

type AttachmentRef = { id?: string; url?: string; mimeType?: string };

export const MiniShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
  const [message, setMessage] = useState("");
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [shellVisible, setShellVisible] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);
  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);

  const resetStreamingState = useCallback((runId?: number) => {
    if (typeof runId === "number" && runId !== streamRunIdRef.current) {
      return;
    }
    setStreamingText("");
    setReasoningText("");
    setIsStreaming(false);
    setPendingUserMessageId(null);
    streamAbortRef.current = null;
  }, []);

  const cancelCurrentStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    streamAbortRef.current = null;
  }, []);

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
      if (!state.conversationId) {
        return;
      }
      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setStreamingText("");
      setReasoningText("");
      setIsStreaming(true);
      setPendingUserMessageId(args.userMessageId);

      void streamChat(
        {
          conversationId: state.conversationId,
          userMessageId: args.userMessageId,
          attachments: args.attachments ?? [],
        },
        {
          onTextDelta: (delta) => {
            if (runId !== streamRunIdRef.current) return;
            setStreamingText((prev) => prev + delta);
          },
          onReasoningDelta: (delta) => {
            if (runId !== streamRunIdRef.current) return;
            setReasoningText((prev) => prev + delta);
          },
          onDone: () => {
            if (runId !== streamRunIdRef.current) return;
            streamAbortRef.current = null;
            setIsStreaming(false);
          },
          onAbort: () => resetStreamingState(runId),
          onError: (error) => {
            if (runId !== streamRunIdRef.current) return;
            console.error("Model gateway error", error);
            resetStreamingState(runId);
          },
        },
        { signal: controller.signal },
      ).catch((error) => {
        if (runId !== streamRunIdRef.current) return;
        console.error("Model gateway error", error);
        resetStreamingState(runId);
      });
    },
    [resetStreamingState, state.conversationId],
  );

  const findQueuedFollowUp = useCallback((source: EventRecord[]) => {
    const responded = new Set<string>();
    for (const event of source) {
      if (event.type !== "assistant_message") continue;
      if (event.payload && typeof event.payload === "object") {
        const payload = event.payload as { userMessageId?: string };
        if (payload.userMessageId) {
          responded.add(payload.userMessageId);
        }
      }
    }

    for (const event of source) {
      if (event.type !== "user_message") continue;
      if (!event.payload || typeof event.payload !== "object") continue;
      const payload = event.payload as {
        mode?: string;
        attachments?: AttachmentRef[];
      };
      if (payload.mode !== "follow_up") continue;
      if (responded.has(event._id)) continue;
      return { event, attachments: payload.attachments ?? [] };
    }
    return null;
  }, []);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi) return;

    const unsubscribeVisibility = electronApi.onMiniVisibility?.((visible) => {
      setShellVisible(visible);
    });

    const unsubscribeDismissPreview = electronApi.onDismissPreview?.(() => {
      setPreviewIndex(null);
    });

    // Fetch initial context
    electronApi.getChatContext?.()
      .then((context) => {
        if (!context) return;
        setChatContext(context);
        setSelectedText(context.selectedText ?? null);
      })
      .catch((error) => {
        console.warn("Failed to load chat context", error);
      });

    // Subscribe to context updates.
    // When the mini window is hidden, Windows can show the last cached frame for a moment on next show.
    // We ack after a couple rAFs so main can wait for a "fresh" frame before showing the window.
    if (!electronApi.onChatContext) return;
    const unsubscribe = electronApi.onChatContext((payload) => {
      let context: ChatContext | null = null;
      let version: number | null = null;

      if (payload && typeof payload === "object" && "context" in payload) {
        const update = payload as ChatContextUpdate;
        context = update.context ?? null;
        version = typeof update.version === "number" ? update.version : null;
      } else {
        context = (payload as ChatContext | null) ?? null;
      }

      setChatContext(context);
      setSelectedText(context?.selectedText ?? null);

      if (version !== null) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.electronAPI?.ackChatContext?.({ version });
          });
        });
      }
    });
    return () => {
      unsubscribe?.();
      unsubscribeVisibility?.();
      unsubscribeDismissPreview?.();
    };
  }, []);

  useEffect(() => {
    window.electronAPI?.setMiniPreviewOpen?.(previewIndex !== null);
  }, [previewIndex]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setMiniPreviewOpen?.(false);
    };
  }, []);

  // Auto-create conversation if none exists
  useEffect(() => {
    if (!state.conversationId) {
      void createConversation({}).then(
        (conversation: { _id?: string } | null) => {
          if (conversation?._id) {
            setConversationId(conversation._id);
          }
        },
      );
    }
  }, [state.conversationId, createConversation, setConversationId]);

  useEffect(() => {
    if (!pendingUserMessageId) {
      return;
    }
    const hasAssistantReply = events.some((event) => {
      if (event.type !== "assistant_message") {
        return false;
      }
      if (event.payload && typeof event.payload === "object") {
        return (
          (event.payload as { userMessageId?: string }).userMessageId ===
          pendingUserMessageId
        );
      }
      return false;
    });

    if (hasAssistantReply) {
      resetStreamingState();
    }
  }, [events, pendingUserMessageId, resetStreamingState]);

  useEffect(() => {
    if (isStreaming || pendingUserMessageId || !state.conversationId) {
      return;
    }
    const queued = findQueuedFollowUp(events);
    if (!queued) {
      return;
    }
    startStream({
      userMessageId: queued.event._id,
      attachments: queued.attachments,
    });
  }, [
    events,
    findQueuedFollowUp,
    isStreaming,
    pendingUserMessageId,
    startStream,
    state.conversationId,
  ]);

  const sendMessage = async () => {
    const selectedSnippet = selectedText?.trim() ?? "";
    const rawText = message.trim();
    if (!state.conversationId || (!rawText && !selectedSnippet)) {
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    setMessage("");

    const followUpMatch = rawText.match(/^\/(followup|queue)\s+/i);
    const cleanedText = followUpMatch ? rawText.slice(followUpMatch[0].length).trim() : rawText;
    const combinedText = selectedSnippet
      ? `"${selectedSnippet}"${cleanedText ? `\n\n${cleanedText}` : ""}`
      : cleanedText;
    if (!combinedText) {
      return;
    }

    const attachments: AttachmentRef[] = [];

    if (chatContext?.regionScreenshots?.length) {
      for (const screenshot of chatContext.regionScreenshots) {
        try {
          const attachment = await createAttachment({
            conversationId: state.conversationId,
            deviceId,
            dataUrl: screenshot.dataUrl,
          });
          if (attachment?._id) {
            attachments.push({
              id: attachment._id as string,
              url: attachment.url,
              mimeType: attachment.mimeType,
            });
          }
        } catch (error) {
          console.error("Screenshot upload failed", error);
        }
      }
    }

    const platform = window.electronAPI?.platform ?? "unknown";
    const mode = isStreaming && followUpMatch ? "follow_up" : isStreaming ? "steer" : undefined;

    if (isStreaming && mode === "steer") {
      cancelCurrentStream();
      resetStreamingState();
    }

    const event = await appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text: combinedText, attachments, platform, ...(mode && { mode }) },
    });

    if (event?._id) {
      if (mode === "follow_up") {
        return;
      }
      setSelectedText(null);
      setChatContext(null);
      window.electronAPI?.clearSelectedText?.();
      setExpanded(true);
      startStream({ userMessageId: event._id, attachments });
    }
  };

  const hasConversation = events.length > 0 || streamingText;
  const showConversation = expanded && hasConversation;

  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Close if clicking directly on the shell background (not the panel)
    if (e.target === e.currentTarget) {
      if (previewIndex !== null) {
        setPreviewIndex(null);
      } else {
        window.electronAPI?.closeWindow?.();
      }
    }
  };

  return (
    <div className={`raycast-shell${shellVisible ? " is-visible" : ""}`} onClick={handleShellClick}>
      {/* Raycast-style unified panel - no gradient, solid panel */}
      <div className="raycast-panel">
        {/* Search bar header */}
        <div className="raycast-header">
          <div className="raycast-search">
            <div className="raycast-search-icon">
              <AsciiBlackHole width={32} height={32} paused={!shellVisible} />
            </div>
            <div className="raycast-input-wrap">
              {chatContext?.regionScreenshots?.map((screenshot, index) => (
                <div key={index} className="raycast-screenshot-chip">
                  <img
                    src={screenshot.dataUrl}
                    className="raycast-screenshot-thumb"
                    alt={`Screenshot ${index + 1}`}
                    onClick={() => setPreviewIndex(index)}
                  />
                  <button
                    type="button"
                    className="raycast-screenshot-dismiss"
                    aria-label="Remove screenshot"
                    onClick={(e) => {
                      e.stopPropagation();
                      setChatContext((prev) => {
                        if (!prev) return prev;
                        const next = [...(prev.regionScreenshots ?? [])];
                        next.splice(index, 1);
                        return { ...prev, regionScreenshots: next };
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {chatContext?.capturePending && (
                <div className="raycast-screenshot-chip raycast-screenshot-skeleton">
                  <div className="raycast-screenshot-skeleton-inner" />
                </div>
              )}
              {selectedText && (
                <div className="raycast-selected-text-chip">
                  <span className="raycast-selected-text">"{selectedText}"</span>
                  <button
                    type="button"
                    className="raycast-screenshot-dismiss"
                    aria-label="Remove selected text"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedText(null);
                      setChatContext((prev) =>
                        prev ? { ...prev, selectedText: null } : prev,
                      );
                      window.electronAPI?.clearSelectedText?.();
                    }}
                  >
                    &times;
                  </button>
                </div>
              )}
              <input
                className="raycast-input"
                placeholder={
                  chatContext?.capturePending
                    ? "Capturing screen..."
                    : chatContext?.regionScreenshots?.length
                      ? "Ask about the capture..."
                      : selectedText
                        ? "Ask about the selection..."
                        : "Ask about your screen..."
                }
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && !message && selectedText) {
                    setSelectedText(null);
                    setChatContext((prev) =>
                      prev ? { ...prev, selectedText: null } : prev,
                    );
                    window.electronAPI?.clearSelectedText?.();
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                  if (event.key === "Escape") {
                    if (previewIndex !== null) {
                      setPreviewIndex(null);
                    } else {
                      window.electronAPI?.closeWindow?.();
                    }
                  }
                }}
                autoFocus
              />
            </div>
            <div className="raycast-actions">
              <button
                className="raycast-action-button"
                type="button"
                onClick={() => setWindow("full")}
                title="Expand to full view"
              >
                <span className="raycast-action-label">Expand</span>
                <kbd className="raycast-kbd">Tab</kbd>
              </button>
            </div>
          </div>
        </div>

        {/* Results/conversation area.
            Keep the container mounted so its enter animation doesn't replay on every window show/hide. */}
        <div className={`raycast-results${showConversation ? " is-open" : ""}`}>
          {showConversation && (
            <div className="raycast-section">
              <div className="raycast-section-header">Conversation</div>
              <div className="raycast-conversation-content">
                <ConversationEvents
                  events={events}
                  maxItems={5}
                  streamingText={streamingText}
                  reasoningText={reasoningText}
                  isStreaming={isStreaming}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer hint - only when streaming */}
        {showConversation && isStreaming && (
          <div className="raycast-footer">
            <div className="raycast-footer-hint">
              <kbd className="raycast-kbd-small">/queue</kbd>
              <span>to send next</span>
            </div>
          </div>
        )}
      </div>
      {previewIndex !== null && chatContext?.regionScreenshots?.[previewIndex] && (
        <div className="raycast-screenshot-overlay" onClick={() => setPreviewIndex(null)}>
          <img
            src={chatContext.regionScreenshots[previewIndex].dataUrl}
            className="raycast-screenshot-preview"
            alt="Screenshot preview"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

