import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "@/ui/toast";
import {
  EMPTY_STORE_THREAD_MESSAGES,
  type StoreThreadMessage,
  type StoreThreadResult,
} from "./types";

type SendThreadTurnArgs = {
  text: string;
  attachedFeatureNames?: string[];
  editingBlueprint?: boolean;
};

/**
 * Owns the live Store-thread state: the snapshot, the pending/sending
 * flags, and the four mutation entry points (send / cancel / deny /
 * markPublished). Subscribes to the runtime's `store.onThreadUpdated`
 * push channel so live changes from the worker land here without any
 * polling.
 */
export function useStoreThread() {
  const [thread, setThread] = useState<StoreThreadResult>({
    threadId: null,
    messages: [],
  });
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [denying, setDenying] = useState(false);

  useEffect(() => {
    void window.electronAPI?.store
      ?.getThread?.()
      .then((nextThread) => {
        if (nextThread) setThread(nextThread);
      })
      .catch(() => undefined);
    const unsubscribe = window.electronAPI?.store?.onThreadUpdated?.(
      (snapshot) => {
        setThread(snapshot);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, []);

  const messages = thread?.messages ?? EMPTY_STORE_THREAD_MESSAGES;

  const isInFlight = useMemo(
    () =>
      messages.some((msg) => msg.role === "assistant" && msg.pending === true),
    [messages],
  );

  const latestPublishableBlueprint = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (
        msg &&
        msg.role === "assistant" &&
        msg.isBlueprint &&
        !msg.denied &&
        !msg.published
      ) {
        return msg;
      }
    }
    return null;
  }, [messages]);

  const sendThreadTurn = useCallback(async (args: SendThreadTurnArgs) => {
    const storeApi = window.electronAPI?.store;
    if (!storeApi?.sendThreadMessage) {
      showToast({
        title: "Send failed",
        description:
          "The local Store agent is not ready yet. Try again in a moment.",
        variant: "error",
      });
      return;
    }
    setSending(true);
    try {
      const nextThread = await storeApi.sendThreadMessage({
        text: args.text,
        ...(args.attachedFeatureNames && args.attachedFeatureNames.length > 0
          ? { attachedFeatureNames: args.attachedFeatureNames }
          : {}),
        ...(args.editingBlueprint ? { editingBlueprint: true } : {}),
      });
      setThread(nextThread);
    } catch (error) {
      showToast({
        title: "Send failed",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setSending(false);
    }
  }, []);

  const cancelTurn = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const nextThread = await window.electronAPI?.store.cancelThreadTurn();
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
    } catch (error) {
      showToast({
        title: "Couldn't stop the agent",
        description: (error as Error)?.message,
        variant: "error",
      });
    } finally {
      setStopping(false);
    }
  }, [stopping]);

  const denyLatestBlueprint = useCallback(async (): Promise<boolean> => {
    if (denying) return false;
    setDenying(true);
    try {
      const nextThread = await window.electronAPI?.store.denyLatestBlueprint();
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
      return true;
    } catch (error) {
      showToast({
        title: "Couldn't deny the draft",
        description: (error as Error)?.message,
        variant: "error",
      });
      return false;
    } finally {
      setDenying(false);
    }
  }, [denying]);

  const markBlueprintPublished = useCallback(
    async (args: { messageId: string; releaseNumber: number }) => {
      const nextThread =
        await window.electronAPI?.store.markBlueprintPublished(args);
      if (!nextThread) throw new Error("The local Store agent is not ready.");
      setThread(nextThread);
    },
    [],
  );

  /**
   * Append a synthetic prompt message into the local thread without
   * round-tripping the runtime. Used to surface "What do you want to
   * change?" when the user clicks Edit on a blueprint badge — the
   * runtime hasn't been asked anything yet.
   */
  const appendSyntheticAssistantMessage = useCallback(
    (message: StoreThreadMessage) => {
      setThread((prev) => {
        if (prev.messages.some((entry) => entry._id === message._id)) {
          return prev;
        }
        return {
          ...prev,
          messages: [...prev.messages, message],
        };
      });
    },
    [],
  );

  return {
    thread,
    messages,
    sending,
    stopping,
    denying,
    isInFlight,
    latestPublishableBlueprint,
    sendThreadTurn,
    cancelTurn,
    denyLatestBlueprint,
    markBlueprintPublished,
    appendSyntheticAssistantMessage,
  };
}
