import {
  useEffect,
  useState,
  useRef,
  useCallback,
} from "react";
import { useRafStringAccumulator } from "../hooks/use-raf-state";
import { useMutation, useConvexAuth } from "convex/react";
import { Spinner } from "../components/spinner";
import { useUiState } from "../app/state/ui-state";
import { useCanvas } from "../app/state/canvas-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents, type EventRecord } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { streamChat } from "../services/model-gateway";
import { synthesizeCoreMemory, seedDiscoveryMemories } from "../services/synthesis";
import { ShiftingGradient } from "../components/background/ShiftingGradient";
import { useTheme } from "../theme/theme-context";
import { Button } from "../components/button";
import { AuthDialog } from "../app/AuthDialog";
import { CanvasPanel } from "../components/canvas/CanvasPanel";
import type { AllUserSignalsResult } from "../types/electron";

type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

import { AsciiBlackHole, type AsciiBlackHoleHandle } from "../components/AsciiBlackHole";
import { TitleBar } from "../components/TitleBar";
import { OnboardingStep1, useOnboardingState } from "../components/Onboarding";

const CREATURE_INITIAL_SIZE = 0.22; // Small delicate neural network creature
const SCROLL_THRESHOLD = 100; // Pixels from bottom to consider "at bottom"
const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

const DEFAULT_DISCOVERY_CATEGORIES = [
  "browsing_bookmarks",
  "dev_environment",
  "apps_system",
] as const;

type DiscoveryCategory =
  | (typeof DEFAULT_DISCOVERY_CATEGORIES)[number]
  | "messages_notes";

const parseStoredDiscoveryCategories = (
  raw: string | null,
): DiscoveryCategory[] => {
  if (!raw) {
    return [...DEFAULT_DISCOVERY_CATEGORIES];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_DISCOVERY_CATEGORIES];
    }
    const valid = parsed.filter((value): value is DiscoveryCategory =>
      value === "browsing_bookmarks" ||
      value === "dev_environment" ||
      value === "apps_system" ||
      value === "messages_notes",
    );
    if (parsed.length === 0) {
      return [];
    }
    return valid.length > 0 ? valid : [...DEFAULT_DISCOVERY_CATEGORIES];
  } catch {
    return [...DEFAULT_DISCOVERY_CATEGORIES];
  }
};

export const FullShell = () => {
  const { state } = useUiState();
  const { state: canvasState } = useCanvas();
  const { completed: onboardingDone, complete: completeOnboarding, reset: resetOnboarding } = useOnboardingState();
  const { gradientMode, gradientColor } = useTheme();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const isDev = import.meta.env.DEV;
  const [message, setMessage] = useState("");
  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] = useRafStringAccumulator();
  const [reasoningText, appendReasoningDelta, resetReasoningText] = useRafStringAccumulator();
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef(0);
  const [queueNext, setQueueNext] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [hasExpanded, setHasExpanded] = useState(() => onboardingDone);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themeConfirmed, setThemeConfirmed] = useState(false);
  const [hasSelectedTheme, setHasSelectedTheme] = useState(false);
  const blackHoleRef = useRef<AsciiBlackHoleHandle | null>(null);

  // Scroll management
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const scrollRafRef = useRef<number | null>(null);

  // Derive showScrollButton from isNearBottom - no need for separate state
  const showScrollButton = !isNearBottom;

  const checkIfNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  // Throttle scroll handler with RAF - reduces ~60 state updates/sec to ~1 per frame
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return; // Already scheduled
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const nearBottom = checkIfNearBottom();
      setIsNearBottom(nearBottom);
    });
  }, [checkIfNearBottom]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const triggerFlash = useCallback(() => {
    blackHoleRef.current?.triggerFlash();
  }, []);

  const startBirthAnimation = useCallback(() => {
    if (hasExpanded) return; // Already expanded
    setHasExpanded(true);
    blackHoleRef.current?.startBirth();
  }, [hasExpanded]);

  const appendEvent = useMutation(api.events.appendEvent).withOptimisticUpdate(
    (localStore, args) => {
      if (args.type !== "user_message") return;

      const queryArgs = {
        conversationId: args.conversationId,
        paginationOpts: { cursor: null, numItems: 200 }
      };
      const current = localStore.getQuery(api.events.listEvents, queryArgs);
      if (!current?.page) return;

      // Create optimistic event (query returns newest-first, reversed in hook)
      const optimisticEvent = {
        _id: `optimistic-${crypto.randomUUID()}`,
        timestamp: Date.now(),
        type: args.type,
        deviceId: args.deviceId,
        payload: args.payload,
      };

      // Prepend to page (newest first in raw query result)
      localStore.setQuery(api.events.listEvents, queryArgs, {
        ...current,
        page: [optimisticEvent, ...current.page],
      });
    }
  );

  const resetStreamingState = useCallback((runId?: number) => {
    if (typeof runId === "number" && runId !== streamRunIdRef.current) {
      return;
    }
    const scheduledForRunId = streamRunIdRef.current;
    resetStreamingText();
    resetReasoningText();
    setIsStreaming(false);
    // `resetStreamingText` is RAF-batched; clearing `pendingUserMessageId` immediately can
    // cause a one-frame flash where the UI renders a standalone streaming row with the
    // previous `streamingText`. Clear the pending id on the next frame instead.
    requestAnimationFrame(() => {
      if (scheduledForRunId !== streamRunIdRef.current) {
        return;
      }
      setPendingUserMessageId(null);
    });
    streamAbortRef.current = null;
  }, [resetStreamingText, resetReasoningText]);

  const cancelCurrentStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    streamAbortRef.current = null;
  }, []);

  const handleResetOnboarding = useCallback(() => {
    setHasExpanded(false);
    setOnboardingKey(k => k + 1);
    setThemeConfirmed(false);
    setHasSelectedTheme(false);
    setThemePickerOpen(false);
    blackHoleRef.current?.reset(CREATURE_INITIAL_SIZE);
    resetOnboarding();
  }, [resetOnboarding]);

  const handleOpenThemePicker = useCallback(() => {
    setThemePickerOpen(true);
  }, []);

  const handleConfirmTheme = useCallback(() => {
    setThemeConfirmed(true);
    setThemePickerOpen(false);
  }, []);

  const handleThemeSelect = useCallback(() => {
    setHasSelectedTheme(true);
  }, []);

  // Broadcast gate state to main process (controls radial menu + mini shell access)
  useEffect(() => {
    const ready = isAuthenticated && onboardingDone;
    window.electronAPI?.setAppReady?.(ready);
  }, [isAuthenticated, onboardingDone]);

  // ---------------------------------------------------------------------------
  // Background Discovery System
  // ---------------------------------------------------------------------------
  // Discovery is DELAYED until the user selects categories during onboarding.
  // Synthesis happens only after auth + onboarding are complete.
  // Discovery data is also seeded into ephemeral memory (fire-and-forget).
  // ---------------------------------------------------------------------------
  const discoveryRef = useRef<{
    started: boolean;
    synthesized: boolean;
    result: AllUserSignalsResult | null;
    error: string | null;
  }>({ started: false, synthesized: false, result: null, error: null });

  const [discoveryCategories, setDiscoveryCategories] = useState<
    DiscoveryCategory[] | null
  >(() => {
    if (!onboardingDone) {
      return null;
    }
    return parseStoredDiscoveryCategories(
      localStorage.getItem(DISCOVERY_CATEGORIES_KEY),
    );
  });

  const waitForSignalCollection = async (maxWaitSeconds: number): Promise<boolean> => {
    let attempts = 0;
    const maxAttempts = maxWaitSeconds;
    while (!discoveryRef.current.result && !discoveryRef.current.error && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    return !!discoveryRef.current.result && !discoveryRef.current.error;
  };

  // Callback from onboarding discovery phase
  const handleDiscoveryConfirm = useCallback(
    (categories: DiscoveryCategory[]) => {
      setDiscoveryCategories(categories);
    },
    [],
  );

  // Returning users may have completed onboarding in a previous version.
  // If so, hydrate categories from localStorage (or use defaults) so discovery can run.
  useEffect(() => {
    if (!onboardingDone || discoveryCategories) return;
    setDiscoveryCategories(
      parseStoredDiscoveryCategories(
        localStorage.getItem(DISCOVERY_CATEGORIES_KEY),
      ),
    );
  }, [onboardingDone, discoveryCategories]);

  // Step 1: Start signal collection when categories are selected (delayed)
  useEffect(() => {
    if (!discoveryCategories || discoveryRef.current.started) return;
    discoveryRef.current.started = true;

    const collectSignals = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        const result = await window.electronAPI?.collectAllSignals?.({ categories: discoveryCategories });

        if (!result) {
          discoveryRef.current.error = "No result from signal collection";
          return;
        }

        if (result.error) {
          discoveryRef.current.error = result.error;
          return;
        }

        discoveryRef.current.result = result;
      } catch (error) {
        discoveryRef.current.error = (error as Error).message;
      }
    };

    void collectSignals();
  }, [discoveryCategories]);

  // Step 2: After auth + onboarding + conversationId, synthesize and inject welcome message
  useEffect(() => {
    if (!isAuthenticated || !onboardingDone || !state.conversationId) return;
    if (discoveryRef.current.synthesized) return; // Only run once

    const synthesize = async () => {
      try {
        const exists = await window.electronAPI?.checkCoreMemoryExists?.();
        if (exists) return;

        discoveryRef.current.synthesized = true;

        const collectionReady = await waitForSignalCollection(30);
        if (!collectionReady) return;

        const result = discoveryRef.current.result;
        if (!result?.formatted) return;

        const synthesisResult = await synthesizeCoreMemory(result.formatted);
        if (!synthesisResult.coreMemory) return;

        await window.electronAPI?.writeCoreMemory?.(synthesisResult.coreMemory);

        // Seed discovery data into ephemeral memory (fire-and-forget)
        void seedDiscoveryMemories(result.formatted);

        // Add welcome message as the first assistant message in the conversation
        if (synthesisResult.welcomeMessage && state.conversationId) {
          const deviceId = await getOrCreateDeviceId();
          await appendEvent({
            conversationId: state.conversationId,
            type: "assistant_message",
            deviceId,
            payload: { text: synthesisResult.welcomeMessage },
          });
        }
      } catch {
        // Silent fail - discovery is non-critical
      }
    };

    void synthesize();
  }, [isAuthenticated, onboardingDone, state.conversationId, appendEvent]);

  const events = useConversationEvents(state.conversationId ?? undefined);

  const startStream = useCallback(
    (args: { userMessageId: string; attachments?: AttachmentRef[] }) => {
      if (!state.conversationId) {
        return;
      }
      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      resetStreamingText();
      resetReasoningText();
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
            appendStreamingDelta(delta);
          },
          onReasoningDelta: (delta) => {
            if (runId !== streamRunIdRef.current) return;
            appendReasoningDelta(delta);
          },
          onDone: () => {
            if (runId !== streamRunIdRef.current) return;
            streamAbortRef.current = null;
            setIsStreaming(false);
            if (streamingTextRef.current.trim().length === 0) {
              resetStreamingText();
              setPendingUserMessageId(null);
            }
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
    [resetStreamingState, state.conversationId, resetStreamingText, resetReasoningText, appendStreamingDelta, appendReasoningDelta, streamingTextRef],
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

  useEffect(() => {
    if (!isStreaming && queueNext) {
      setQueueNext(false);
    }
  }, [isStreaming, queueNext]);

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

    let attachments: AttachmentRef[] = [];

    const platform = window.electronAPI?.platform ?? "unknown";
    const shouldQueue =
      isStreaming && (queueNext || Boolean(followUpMatch));
    const mode = shouldQueue ? "follow_up" : isStreaming ? "steer" : undefined;

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
        setQueueNext(false);
        return;
      }
      setQueueNext(false);
      startStream({ userMessageId: event._id, attachments });
    }
  };

  const hasMessages = events.length > 0 || isStreaming;

  // Auto-scroll when new content arrives (if user is near bottom)
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom("smooth");
    }
  }, [events.length, streamingText, isNearBottom, scrollToBottom]);

  // Scroll to bottom immediately when streaming starts
  useEffect(() => {
    if (isStreaming && isNearBottom) {
      scrollToBottom("smooth");
    }
  }, [isStreaming, isNearBottom, scrollToBottom]);

  const canvasOpen = canvasState.isOpen && canvasState.canvas !== null;
  const shellClassName = `window-shell full${canvasOpen ? ' has-canvas' : ''}`;
  const canvasWidthVar = canvasOpen
    ? { '--canvas-panel-width': `${canvasState.width}px` } as React.CSSProperties
    : undefined;

  return (
    <div className={shellClassName} style={canvasWidthVar}>
      <TitleBar
        hideThemePicker={!onboardingDone}
        themePickerOpen={themePickerOpen}
        onThemePickerOpenChange={setThemePickerOpen}
        onThemeSelect={handleThemeSelect}
      />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      {/* Main content area - row layout: chat + optional canvas */}
      <div className="full-body">
        <div className="full-body-main">
          <div
            className="session-content"
            ref={scrollContainerRef}
            onScroll={handleScroll}
          >
            {hasMessages && onboardingDone ? (
              <div className="session-messages">
                <ConversationEvents
                  events={events}
                  streamingText={streamingText}
                  reasoningText={reasoningText}
                  isStreaming={isStreaming}
                  pendingUserMessageId={pendingUserMessageId}
                  scrollContainerRef={scrollContainerRef}
                />
              </div>
            ) : (
              <div className="new-session-view">
                <div
                  className="new-session-title"
                  data-expanded={hasExpanded ? "true" : "false"}
                >
                  Stella
                </div>
                <div
                  onClick={() => {
                    triggerFlash();
                    if (!hasExpanded) {
                      startBirthAnimation();
                    }
                  }}
                  className="onboarding-blackhole"
                  data-expanded={hasExpanded ? "true" : "false"}
                  title={!hasExpanded ? 'Click to awaken' : undefined}
                >
                  <AsciiBlackHole
                    ref={blackHoleRef}
                    width={120}
                    height={56}
                    initialBirthProgress={onboardingDone ? 1 : CREATURE_INITIAL_SIZE}
                  />
                </div>
                {!onboardingDone && (
                  <OnboardingStep1
                    key={onboardingKey}
                    onComplete={completeOnboarding}
                    onAccept={startBirthAnimation}
                    onInteract={triggerFlash}
                    onSignIn={() => setAuthDialogOpen(true)}
                    onOpenThemePicker={handleOpenThemePicker}
                    onConfirmTheme={handleConfirmTheme}
                    onDiscoveryConfirm={handleDiscoveryConfirm}
                    themeConfirmed={themeConfirmed}
                    hasSelectedTheme={hasSelectedTheme}
                    isAuthenticated={isAuthenticated}
                  />
                )}
                {!isAuthenticated && onboardingDone && (
                  <Button
                    variant="secondary"
                    size="large"
                    onClick={() => setAuthDialogOpen(true)}
                    disabled={isAuthLoading}
                    className="onboarding-signin"
                  >
                    {isAuthLoading ? <Spinner size="sm" /> : "Sign in"}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Scroll to bottom button */}
          {showScrollButton && hasMessages && onboardingDone && (
            <button
              className="scroll-to-bottom"
              onClick={() => scrollToBottom("smooth")}
              aria-label="Scroll to bottom"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}

          {/* Composer - Aura-style prompt bar at bottom (only when authenticated) */}
          {isAuthenticated && onboardingDone && <div className="composer">
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
                  {isStreaming && (
                    <button
                      type="button"
                      className="composer-selector"
                      data-active={queueNext ? "true" : "false"}
                      onClick={() => setQueueNext((prev) => !prev)}
                      title="Queue the next message to send after the current response"
                    >
                      <span>Queue</span>
                    </button>
                  )}
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

        {/* Canvas panel - right side, conditionally rendered */}
        {canvasOpen && <CanvasPanel />}
      </div>

      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

      {isDev && (
        <button className="onboarding-reset" onClick={handleResetOnboarding}>
          Reset Onboarding
        </button>
      )}
    </div>
  );
};
