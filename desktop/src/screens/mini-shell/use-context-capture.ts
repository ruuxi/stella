import { useEffect, useState } from "react";
import { getElectronApi } from "../../services/electron";
import type { ChatContext, ChatContextUpdate } from "../../types/electron";

export function useContextCapture() {
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [shellVisible, setShellVisible] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi) return;

    const unsubscribeVisibility = electronApi.mini.onVisibility((visible) => {
      setShellVisible(visible);
    });

    const unsubscribeDismissPreview = electronApi.mini.onDismissPreview(() => {
      setPreviewIndex(null);
    });

    // Fetch initial context
    electronApi.capture
      .getContext()
      .then((context) => {
        if (!context) return;
        setChatContext(context);
        setSelectedText(context.selectedText ?? null);
      })
      .catch((error) => {
        console.warn("Failed to load chat context", error);
      });

    // Subscribe to context updates
    if (!electronApi.capture.onContext) return;
    const unsubscribe = electronApi.capture.onContext((payload) => {
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
            window.electronAPI?.capture.ackContext?.({ version });
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

  return {
    chatContext,
    setChatContext,
    selectedText,
    setSelectedText,
    shellVisible,
    previewIndex,
    setPreviewIndex,
  };
}
