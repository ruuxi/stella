import { useEffect, useState } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import type { ChatContext, ChatContextUpdate } from "@/types/electron";

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

    const unsubscribe = electronApi.capture.onContext((payload) => {
      const update = payload as ChatContextUpdate | null;
      const context = update?.context ?? null;
      const version = typeof update?.version === "number" ? update.version : null;

      setChatContext(context);
      setSelectedText(context?.selectedText ?? null);

      if (version !== null) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            electronApi.capture.ackContext({ version });
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


