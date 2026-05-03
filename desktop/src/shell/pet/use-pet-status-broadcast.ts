import { useEffect, useMemo, useRef } from "react";
import type {
  PetOverlayState,
  PetOverlayStatus,
} from "@/shared/contracts/pet";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { getWorkingIndicatorDisplayStatus } from "@/app/chat/working-indicator-state";

const IDLE_STATUS: PetOverlayStatus = {
  state: "idle",
  title: "",
  message: "",
  isLoading: false,
};

type WorkingTaskShape = TaskItem & {
  /** A handful of agent flows tag tasks with a "needs input" hint via
   *  the `requiresUserInput` flag — when present the pet should show
   *  the waiting mood. */
  requiresUserInput?: boolean;
};

const summarizeTitle = (
  liveTasks: TaskItem[] | null | undefined,
  isStreaming: boolean,
  runtimeStatusText: string,
): string => {
  const firstRunning = (liveTasks ?? []).find(
    (task) => task.status === "running",
  );
  if (firstRunning?.description && firstRunning.description !== "Task") {
    return firstRunning.description;
  }
  if (firstRunning?.statusText) return firstRunning.statusText;
  if (isStreaming) return "Working";
  return runtimeStatusText || "";
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

type UsePetStatusBroadcastInput = {
  liveTasks: TaskItem[] | null | undefined;
  runtimeStatusText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null | undefined;
};

/**
 * Derive a `PetOverlayStatus` from the full-shell chat surface and push
 * it to every renderer (the overlay tree subscribes via
 * `electronAPI.pet.onStatus`).
 *
 * The chat surface already runs once per app via `ChatRuntimeProvider`,
 * so we don't pay any extra subscription cost here — we just pluck the
 * fields the pet cares about, debounce-by-equality, and fan out.
 */
export const usePetStatusBroadcast = ({
  liveTasks,
  runtimeStatusText,
  isStreaming,
  pendingUserMessageId,
}: UsePetStatusBroadcastInput): void => {
  const status: PetOverlayStatus = useMemo(() => {
    const state = deriveState({
      liveTasks,
      isStreaming,
      pendingUserMessageId: pendingUserMessageId ?? null,
    });
    if (state === "idle") return IDLE_STATUS;

    const message = getWorkingIndicatorDisplayStatus({
      status: runtimeStatusText,
      tasks: liveTasks ?? undefined,
    });
    return {
      state,
      title: summarizeTitle(liveTasks, isStreaming, runtimeStatusText),
      message,
      isLoading: state === "running" || isStreaming,
    };
  }, [liveTasks, runtimeStatusText, isStreaming, pendingUserMessageId]);

  const lastSentRef = useRef<string>("");

  useEffect(() => {
    const fingerprint = `${status.state}|${status.title}|${status.message}|${status.isLoading ? 1 : 0}`;
    if (fingerprint === lastSentRef.current) return;
    lastSentRef.current = fingerprint;
    window.electronAPI?.pet?.pushStatus?.(status);
  }, [status]);

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
