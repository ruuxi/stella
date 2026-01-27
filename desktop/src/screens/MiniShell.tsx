import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { Maximize2 } from "lucide-react";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";

export const MiniShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);

  // Mode is set by the radial menu selection
  const isAskMode = state.mode === "ask";

  // Auto-create conversation if none exists
  useEffect(() => {
    if (!state.conversationId) {
      void createConversation({ ownerId: getOwnerId() }).then(
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
      setIsStreaming(false);
      setPendingUserMessageId(null);
    }
  }, [events, pendingUserMessageId]);

  const sendMessage = async () => {
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

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

    const event = await appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text, attachments },
    });

    if (event?._id) {
      setStreamingText("");
      setIsStreaming(true);
      setPendingUserMessageId(event._id);
      void streamChat(
        {
          conversationId: state.conversationId!,
          userMessageId: event._id,
          attachments,
        },
        {
          onTextDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onDone: () => {
            setIsStreaming(false);
          },
          onError: (error) => {
            console.error("Model gateway error", error);
            setIsStreaming(false);
          },
        },
      ).catch((error) => {
        console.error("Model gateway error", error);
        setIsStreaming(false);
      });
    }
  };

  const hasConversation = events.length > 0 || streamingText;

  return (
    <div className="spotlight-shell">
      {/* Conversation appears above the input */}
      {hasConversation && (
        <div className="spotlight-conversation">
          <ConversationEvents
            events={events}
            maxItems={5}
            streamingText={streamingText}
            isStreaming={isStreaming}
          />
        </div>
      )}

      {/* Spotlight-style input bar */}
      <div className="spotlight-bar">
        <input
          className="spotlight-input"
          placeholder={isAskMode ? "Ask about your screen..." : "Ask Stellar anything..."}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
            if (event.key === "Escape") {
              // Could hide window on escape
            }
          }}
          autoFocus
        />
        <button
          className="spotlight-expand"
          type="button"
          onClick={() => setWindow("full")}
          title="Expand to full view"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
