import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { ChatContext } from "@/shared/types/electron";
import {
  resolveComposerAreaSelection,
  type SelectionTarget,
} from "./context-select";
import "./composer-area-select.css";

type ComposerAreaSelectOverlayProps = {
  active: boolean;
  onCancel: () => void;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
};

export function ComposerAreaSelectOverlay({
  active,
  onCancel,
  setChatContext,
}: ComposerAreaSelectOverlayProps) {
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const targetRef = useRef<SelectionTarget | null>(null);

  const updateTarget = useCallback((event: PointerEvent | MouseEvent) => {
    const next = resolveComposerAreaSelection(event.clientX, event.clientY);
    targetRef.current = next;
    setTarget(next);
  }, []);

  useEffect(() => {
    if (!active) {
      targetRef.current = null;
      setTarget(null);
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateTarget(event);
    };

    const handlePointerDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const selected =
        targetRef.current ?? resolveComposerAreaSelection(event.clientX, event.clientY);
      if (selected) {
        setChatContext((prev) => ({
          ...(prev ?? {
            window: null,
            browserUrl: null,
            selectedText: null,
            regionScreenshots: [],
          }),
          appSelection: {
            label: selected.label,
            snapshot: selected.snapshot,
            bounds: selected.bounds,
          },
        }));
      }
      onCancel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active, onCancel, setChatContext, updateTarget]);

  if (!active) return null;

  return createPortal(
    <div
      className="composer-area-select-overlay"
      data-composer-area-select-ignore="true"
      aria-hidden="true"
    >
      <div className="composer-area-select-scrim" />
      {target ? (
        <div
          className="composer-area-select-ring"
          style={{
            left: target.bounds.x,
            top: target.bounds.y,
            width: target.bounds.width,
            height: target.bounds.height,
          }}
        >
          <span className="composer-area-select-label">{target.label}</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
