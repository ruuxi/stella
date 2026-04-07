import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ChatContext } from "@/shared/types/electron";

export function useScreenshotPreview(chatContext: ChatContext | null) {
  const [index, setIndex] = useState<number | null>(null);

  const screenshot =
    index !== null
      ? chatContext?.regionScreenshots?.[index] ?? null
      : null;

  // Clear index if the screenshot array shrinks or gets cleared externally
  useEffect(() => {
    if (!screenshot) setIndex(null);
  }, [screenshot]);

  useEffect(() => {
    if (index === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIndex(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [index]);

  return { screenshot, previewIndex: index, setPreviewIndex: setIndex };
}

export function ScreenshotPreviewOverlay({
  screenshot,
  index,
  onClose,
}: {
  screenshot: { dataUrl: string };
  index: number;
  onClose: () => void;
}) {
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.72)",
        padding: "24px",
      }}
    >
      <img
        src={screenshot.dataUrl}
        alt={`Screenshot preview ${index + 1}`}
        onClick={(event) => event.stopPropagation()}
        style={{
          maxWidth: "92vw",
          maxHeight: "92vh",
          objectFit: "contain",
          borderRadius: "12px",
          boxShadow: "0 16px 60px rgba(0, 0, 0, 0.4)",
        }}
      />
    </div>,
    document.body,
  );
}
