import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { AsciiBlackHole } from "../components/AsciiBlackHole";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents, type EventRecord } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";

export const MiniShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
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
    (args: { userMessageId: string; attachments?: Array<{ id?: string; url?: string; mimeType?: string }> }) => {
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
        attachments?: Array<{ id?: string; url?: string; mimeType?: string }>;
      };
      if (payload.mode !== "follow_up") continue;
      if (responded.has(event._id)) continue;
      return { event, attachments: payload.attachments ?? [] };
    }
    return null;
  }, []);

  // Mode is set by the radial menu selection
  const isAskMode = state.mode === "ask";

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
      setStreamingText("");
      setReasoningText("");
      setIsStreaming(false);
      setPendingUserMessageId(null);
      streamAbortRef.current = null;
    }
  }, [events, pendingUserMessageId]);

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
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    const rawText = message.trim();
    setMessage("");

    const followUpMatch = rawText.match(/^\/(followup|queue)\s+/i);
    const cleanedText = followUpMatch ? rawText.slice(followUpMatch[0].length).trim() : rawText;
    if (!cleanedText) {
      return;
    }

    let attachments: Array<{ id?: string; url?: string; mimeType?: string }> = [];

    // In Ask mode, capture screenshot automatically
    if (isAskMode) {
      try {
        const screenshot = await captureScreenshot();
        if (!screenshot?.dataUrl) {
          throw new Error("Screenshot capture failed.");
        }
        const attachment = await createAttachment({
          conversationId: state.conversationId,
          deviceId,
          dataUrl: screenshot.dataUrl,
        });
        if (attachment?._id) {
          attachments = [
            {
              id: attachment._id as string,
              url: attachment.url,
              mimeType: attachment.mimeType,
            },
          ];
        }
      } catch (error) {
        console.error("Screenshot capture failed", error);
        return;
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
      payload: { text: cleanedText, attachments, platform, ...(mode && { mode }) },
    });

    if (event?._id) {
      if (mode === "follow_up") {
        return;
      }
      startStream({ userMessageId: event._id, attachments });
    }
  };

  const hasConversation = events.length > 0 || streamingText;

  return (
    <div className="raycast-shell">
      {/* Raycast-style unified panel - no gradient, solid panel */}
      <div className="raycast-panel">
        {/* Search bar header */}
        <div className="raycast-header">
          <div className="raycast-search">
            <div className="raycast-search-icon">
              <AsciiBlackHole width={32} height={32} />
            </div>
            <input
              className="raycast-input"
              placeholder={isAskMode ? "Ask about your screen..." : "Search for apps and commands..."}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              if (event.key === "Escape") {
                // Hide the mini shell window
                window.electronAPI?.closeWindow?.();
              }
              }}
              autoFocus
            />
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

        {/* Results/conversation area */}
        {hasConversation && (
          <>
            <div className="raycast-results">
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
            </div>

            {/* Footer hint - only when conversation exists */}
            <div className="raycast-footer">
              <div className="raycast-footer-hint">
                <kbd className="raycast-kbd-small">Enter</kbd>
                <span>to send</span>
              </div>
              {isStreaming && (
                <div className="raycast-footer-hint">
                  <kbd className="raycast-kbd-small">/queue</kbd>
                  <span>to send next</span>
                </div>
              )}
              <div className="raycast-footer-hint">
                <kbd className="raycast-kbd-small">Esc</kbd>
                <span>to close</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
