import {
  useEffect,
  useState,
  useRef,
  useCallback,
} from "react";
import { useAction, useMutation, useConvexAuth } from "convex/react";
import { Spinner } from "../components/spinner";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";
import { ShiftingGradient } from "../components/background/ShiftingGradient";
import { useTheme } from "../theme/theme-context";
import { Button } from "../components/button";
import { AuthDialog } from "../app/AuthDialog";

type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

import { AsciiBlackHole } from "../components/AsciiBlackHole";
import { TitleBar } from "../components/TitleBar";
import { OnboardingStep1, useOnboardingState } from "../components/Onboarding";

export const FullShell = () => {
  const { state } = useUiState();
  const { completed: onboardingDone, complete: completeOnboarding, reset: resetOnboarding } = useOnboardingState();
  const { gradientMode, gradientColor } = useTheme();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [birthProgress, setBirthProgress] = useState(() => onboardingDone ? 1 : 0);
  const birthAnimationRef = useRef<number | null>(null);

  const startBirthAnimation = useCallback(() => {
    const startTime = performance.now();
    const duration = 6000; // 6 seconds for full emergence
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out curve for organic feel
      const eased = 1 - Math.pow(1 - progress, 3);
      setBirthProgress(eased);
      
      if (progress < 1) {
        birthAnimationRef.current = requestAnimationFrame(animate);
      }
    };
    
    birthAnimationRef.current = requestAnimationFrame(animate);
  }, []);

  const handleResetOnboarding = useCallback(() => {
    if (birthAnimationRef.current) {
      cancelAnimationFrame(birthAnimationRef.current);
    }
    setBirthProgress(0);
    resetOnboarding();
  }, [resetOnboarding]);

  useEffect(() => {
    return () => {
      if (birthAnimationRef.current) {
        cancelAnimationFrame(birthAnimationRef.current);
      }
    };
  }, []);

  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const events = useConversationEvents(state.conversationId ?? undefined);

  // Full view is always chat mode (no screenshot)
  const isAskMode = state.mode === "ask";

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
    const deviceId = await getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

    let attachments: AttachmentRef[] = [];

    // In Ask mode, capture screenshot
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
    const event = await appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text, attachments, platform },
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

  const hasMessages = events.length > 0 || isStreaming;

  return (
    <div className="window-shell full">
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />


      {/* Main content area - full screen with gradient visible */}
      <div className="full-body">
        <div className="session-content">
          {hasMessages ? (
            <div className="session-messages">
              <ConversationEvents
                events={events}
                streamingText={streamingText}
                isStreaming={isStreaming}
              />
            </div>
          ) : (
            <div className="new-session-view" style={{
              width: '100%',
              maxWidth: 'none',
              padding: 0,
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              position: 'relative'
            }}>
              <div
                className="new-session-title"
                style={{
                  position: 'absolute',
                  top: '30%',
                  zIndex: 10,
                  opacity: birthProgress * 0.5,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  fontSize: '16px',
                  mixBlendMode: 'plus-lighter',
                  transition: 'opacity 0.3s ease',
                }}
              >
                Stellar
              </div>
              <AsciiBlackHole width={120} height={56} birthProgress={birthProgress} />
              {!onboardingDone && (
                <OnboardingStep1 
                  onComplete={completeOnboarding} 
                  onAccept={startBirthAnimation}
                />
              )}
              {!isAuthenticated && onboardingDone && (
                <Button
                  variant="secondary"
                  size="large"
                  onClick={() => setAuthDialogOpen(true)}
                  disabled={isAuthLoading}
                  style={{
                    position: 'absolute',
                    bottom: '18%',
                    zIndex: 10,
                    background: 'transparent',
                    border: '2px solid var(--border-strong)',
                    minWidth: '140px',
                  }}
                >
                  {isAuthLoading ? <Spinner size="sm" /> : "Sign in"}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Composer - Aura-style prompt bar at bottom (only when authenticated) */}
        {isAuthenticated && <div className="composer">
          <form
            className="composer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            {/* Input scroll container */}
            <div className="composer-scroll">
              <textarea
                className="composer-input"
                placeholder="Type a message..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                disabled={!state.conversationId}
                rows={1}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                {/* Placeholder for model/agent selector */}
                <button type="button" className="composer-selector">
                  <svg className="composer-selector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <span>Model</span>
                </button>
              </div>

              <div className="composer-toolbar-right">
                {/* Placeholder action buttons */}
                <button type="button" className="composer-action" title="Attach file">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21,15 16,10 5,21" />
                  </svg>
                </button>

                {/* Submit button */}
                <button
                  type="submit"
                  className="composer-submit"
                  disabled={!state.conversationId || !message.trim()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </form>
        </div>}
      </div>

      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

      {/* Dev: Reset onboarding button */}
      <button
        onClick={handleResetOnboarding}
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          padding: '6px 12px',
          fontSize: 11,
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 4,
          color: 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          zIndex: 9999,
        }}
      >
        Reset Onboarding
      </button>
    </div>
  );
};
