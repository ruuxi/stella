import { useEffect, useMemo, useRef } from "react";
import type {
  PetOverlayState,
  PetOverlayStatus,
} from "@/shared/contracts/pet";
import {
  getEventText,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { filterMessagesForUiDisplay } from "@/app/chat/lib/message-display";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat.js";
import { getWorkingIndicatorDisplayStatus } from "@/app/chat/working-indicator-state";
import {
  readLastSeenPetAssistantMessageId,
  writeLastSeenPetAssistantMessageId,
} from "./pet-preferences";

const IDLE_STATUS: PetOverlayStatus = {
  state: "idle",
  title: "",
  message: "",
  isLoading: false,
};

const WORKING_PHRASES = [
  "Scheming",
  "Cooking",
  "Pondering",
  "Thinking",
  "Tinkering",
  "Investigating",
  "Exploring",
  "Untangling",
  "Polishing",
  "Composing",
  "Drafting",
  "Inspecting",
  "Tracing",
  "Scanning",
  "Crunching",
  "Stitching",
  "Weaving",
  "Sharpening",
  "Assembling",
  "Calibrating",
  "Brewing",
  "Mulling",
  "Plotting",
  "Refining",
  "Chiseling",
  "Sorting",
  "Mapping",
  "Navigating",
  "Sleuthing",
  "Experimenting",
  "Debugging",
  "Reworking",
  "Balancing",
  "Sifting",
  "Loading thoughts",
  "Following clues",
  "Making sparks",
  "Herding bits",
  "Checking corners",
  "Connecting dots",
] as const;

type WorkingTaskShape = TaskItem & {
  /** A handful of agent flows tag tasks with a "needs input" hint via
   *  the `requiresUserInput` flag — when present the pet should show
   *  the waiting mood. */
  requiresUserInput?: boolean;
};

const deriveState = ({
  liveTasks,
  isStreaming,
  pendingUserMessageId,
}: {
  liveTasks: TaskItem[] | null | undefined;
  isStreaming: boolean;
  pendingUserMessageId: string | null | undefined;
}): PetOverlayState => {
  const tasks = (liveTasks ?? []) as WorkingTaskShape[];
  if (tasks.some((task) => task.status === "error")) return "failed";
  if (tasks.some((task) => task.requiresUserInput)) return "waiting";
  if (
    isStreaming ||
    Boolean(pendingUserMessageId) ||
    tasks.some((task) => task.status === "running")
  ) {
    return "running";
  }
  if (tasks.some((task) => task.status === "completed")) return "review";
  return "idle";
};

type LatestAssistantMessage = {
  id: string;
  text: string;
};

const latestAssistantMessage = (
  messages: MessageRecord[] | null | undefined,
): LatestAssistantMessage | null => {
  const displayMessages = filterMessagesForUiDisplay(messages ?? []);
  for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
    const message = displayMessages[index];
    if (!message || message.type !== "assistant_message") continue;
    const text = getEventText(message).replace(/\s+/g, " ").trim();
    if (text.length > 0) return { id: message._id, text };
  }
  return null;
};

const getWorkingPhrase = (seed: string): string => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return WORKING_PHRASES[hash % WORKING_PHRASES.length];
};

type UsePetStatusBroadcastInput = {
  messages: MessageRecord[] | null | undefined;
  liveTasks: TaskItem[] | null | undefined;
  runtimeStatusText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null | undefined;
};

/**
 * Derive a `PetOverlayStatus` from the full-shell chat surface and push
 * it to every renderer (the pet window subscribes via
 * `electronAPI.pet.onStatus`).
 *
 * The chat surface already runs once per app via `ChatRuntimeProvider`,
 * so we don't pay any extra subscription cost here — we just pluck the
 * fields the pet cares about, debounce-by-equality, and fan out.
 */
export const usePetStatusBroadcast = ({
  messages,
  liveTasks,
  runtimeStatusText,
  isStreaming,
  pendingUserMessageId,
}: UsePetStatusBroadcastInput): void => {
  const lastSeenAssistantMessageIdRef = useRef<string | null>(
    readLastSeenPetAssistantMessageId(),
  );

  const latestAssistant = useMemo(
    () => (isStreaming ? null : latestAssistantMessage(messages)),
    [isStreaming, messages],
  );

  const status: PetOverlayStatus = useMemo(() => {
    const state = deriveState({
      liveTasks,
      isStreaming,
      pendingUserMessageId: pendingUserMessageId ?? null,
    });
    const assistantMessage = latestAssistant?.text ?? "";
    if (state === "idle") {
      return assistantMessage &&
        latestAssistant?.id !== lastSeenAssistantMessageIdRef.current
        ? {
            state,
            title: "",
            message: assistantMessage,
            isLoading: false,
          }
        : IDLE_STATUS;
    }

    const statusMessage = getWorkingIndicatorDisplayStatus({
      status: runtimeStatusText,
      tasks: liveTasks ?? undefined,
    });
    return {
      state,
      title: "",
      message:
        state === "running"
          ? getWorkingPhrase(
              `${statusMessage}|${runtimeStatusText}|${pendingUserMessageId ?? ""}|${liveTasks?.[0]?.id ?? ""}`,
            )
          : assistantMessage || statusMessage,
      isLoading: false,
    };
  }, [
    liveTasks,
    runtimeStatusText,
    isStreaming,
    pendingUserMessageId,
    latestAssistant,
  ]);

  const lastSentRef = useRef<string>("");

  useEffect(() => {
    const fingerprint = `${status.state}|${status.title}|${status.message}|${status.isLoading ? 1 : 0}`;
    if (fingerprint === lastSentRef.current) return;
    lastSentRef.current = fingerprint;
    window.electronAPI?.pet?.pushStatus?.(status);
  }, [status]);

  useEffect(() => {
    if (status.state !== "idle" || !status.message.trim()) return;
    const id = latestAssistant?.id;
    if (!id || id === lastSeenAssistantMessageIdRef.current) return;
    writeLastSeenPetAssistantMessageId(id);
    lastSeenAssistantMessageIdRef.current = id;
  }, [latestAssistant, status.message, status.state]);

  // Subscribe to inbound `pet:sendMessage` from the overlay popover and
  // re-emit it as a Stella send-message custom event so the existing
  // chat surface ingests it (same path used by the radial dial). We
  // mount this in the chat runtime provider, which is the only React
  // tree that listens for `STELLA_SEND_MESSAGE_EVENT`.
  useEffect(() => {
    const cleanup = window.electronAPI?.pet?.onSendMessage?.((text) => {
      if (typeof text !== "string" || text.trim().length === 0) return;
      window.dispatchEvent(
        new CustomEvent("stella:send-message", {
          detail: { text, source: "pet" },
        }),
      );
    });
    return () => cleanup?.();
  }, []);
};
