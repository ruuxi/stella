import { useCallback, useEffect, useState } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { useCapturedChatContext } from "../use-captured-chat-context";

export function useContextCapture() {
  const [shellVisible, setShellVisible] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const handleContextUpdate = useCallback(
    (update: { version?: number } | null, electronApi: NonNullable<ReturnType<typeof getElectronApi>>) => {
      const version = typeof update?.version === "number" ? update.version : null;
      if (version !== null) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            electronApi.capture.ackContext({ version });
          });
        });
      }
    },
    [],
  );
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext({ onContextUpdate: handleContextUpdate });

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi) return;

    const unsubscribeVisibility = electronApi.mini.onVisibility((visible) => {
      setShellVisible(visible);
    });

    const unsubscribeDismissPreview = electronApi.mini.onDismissPreview(() => {
      setPreviewIndex(null);
    });

    return () => {
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

