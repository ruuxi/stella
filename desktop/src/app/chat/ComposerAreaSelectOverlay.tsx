import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatContext } from "@/shared/types/electron";
import {
  resolveStellaAnnotationTarget,
  type SelectionTarget,
} from "./context-select";
import type { ReactSource } from "./react-fiber-source";
import "./composer-area-select.css";

type AnnotationSelection = NonNullable<ChatContext["appSelection"]>;

/**
 * Source resolution reads React's dev-only debug fields (`_debugOwner`,
 * `_debugStack`), which a production build does not emit — there is nothing to
 * find, and the component names that survive minification are mangled, so a
 * production answer would be noise rather than context. Gating on
 * `import.meta.env.DEV` also lets the resolver and its source-map decoder drop
 * out of the production bundle entirely.
 */
let sourceModule: Promise<typeof import("./react-fiber-source")> | null = null;

const loadSourceModule = () => {
  if (!import.meta.env.DEV) return null;
  sourceModule ??= import("./react-fiber-source");
  return sourceModule;
};

/** Starts the module fetch when the picker opens, so the click doesn't wait. */
const primeSelectionSource = (): void => {
  void loadSourceModule();
};

const resolveSelectionSource = async (
  element: Element,
): Promise<ReactSource | null> => {
  const loaded = await loadSourceModule();
  return loaded ? loaded.resolveReactSource(element) : null;
};

type ComposerAreaSelectOverlayProps = {
  active: boolean;
  requestId?: number | null;
  onCancel: () => void;
  /**
   * Fired once the user clicks an element. The selection is added to the
   * composer as an app-selection chip (mirrors the normal capture flow);
   * there is no inline composer — the user types in the real composer.
   */
  onSelect: (
    selection: AnnotationSelection,
    requestId?: number | null,
  ) => void;
};

const withResolvedSource = (
  base: AnnotationSelection,
  resolved: ReactSource | null,
): AnnotationSelection => {
  if (!resolved) return base;
  const hasSource =
    Boolean(resolved.filePath) ||
    typeof resolved.lineNumber === "number" ||
    Boolean(resolved.componentName);
  return {
    ...base,
    ...(hasSource
      ? {
          source: {
            ...(resolved.filePath ? { filePath: resolved.filePath } : {}),
            ...(typeof resolved.lineNumber === "number"
              ? { lineNumber: resolved.lineNumber }
              : {}),
            ...(resolved.componentName
              ? { componentName: resolved.componentName }
              : {}),
          },
        }
      : {}),
    ...(resolved.stack ? { stack: resolved.stack } : {}),
  };
};

export function ComposerAreaSelectOverlay({
  active,
  requestId = null,
  onCancel,
  onSelect,
}: ComposerAreaSelectOverlayProps) {
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const targetRef = useRef<SelectionTarget | null>(null);

  const updateTarget = useCallback((event: PointerEvent | MouseEvent) => {
    const next = resolveStellaAnnotationTarget(event.clientX, event.clientY);
    targetRef.current = next;
    setTarget(next);
  }, []);

  useEffect(() => {
    if (!active) {
      targetRef.current = null;
      setTarget(null);
      setSelection(null);
      return;
    }
    setSelection(null);
  }, [active, requestId]);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.stellaAnnotationMode = "true";
    return () => {
      delete root.dataset.stellaAnnotationMode;
    };
  }, [active]);

  const commitSelection = useCallback(
    (selected: SelectionTarget) => {
      const baseSelection: AnnotationSelection = {
        label: selected.label,
        snapshot: selected.snapshot,
        bounds: selected.bounds,
        surface: selected.surface,
        ...(selected.anchor ? { anchor: selected.anchor } : {}),
      };
      // Lock the ring in place while we resolve source info, then add the
      // selection to the composer as a chip and close the overlay.
      setSelection(baseSelection);
      void resolveSelectionSource(selected.element)
        .then((resolved) => withResolvedSource(baseSelection, resolved))
        .catch(() => baseSelection)
        .then((finalSelection) => {
          onSelect(finalSelection, requestId);
        });
    },
    [onSelect, requestId],
  );

  useEffect(() => {
    if (!active || selection) return;
    primeSelectionSource();
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "crosshair";

    const handlePointerMove = (event: PointerEvent) => {
      updateTarget(event);
    };

    const handlePointerDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const selected =
        targetRef.current ??
        resolveStellaAnnotationTarget(event.clientX, event.clientY);
      if (selected) {
        commitSelection(selected);
      }
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      document.body.style.cursor = previousCursor;
    };
  }, [active, commitSelection, selection, updateTarget]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active, onCancel]);

  if (!active) return null;

  const displayedTarget = selection ? selection : target;

  return createPortal(
    <div
      className="composer-area-select-overlay"
      data-composer-area-select-ignore="true"
      data-state={selection ? "captured" : "selecting"}
    >
      <div className="composer-area-select-scrim" />
      {displayedTarget ? (
        <div
          className="composer-area-select-ring"
          style={{
            left: displayedTarget.bounds.x,
            top: displayedTarget.bounds.y,
            width: displayedTarget.bounds.width,
            height: displayedTarget.bounds.height,
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
