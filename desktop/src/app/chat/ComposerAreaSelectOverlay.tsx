import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  ComposerSubmitButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import type { ChatContext } from "@/shared/types/electron";
import {
  resolveStellaAnnotationTarget,
  type SelectionTarget,
} from "./context-select";
import {
  primeReactGrabSource,
  resolveReactGrabSource,
} from "./react-grab-source";
import "./full-shell.composer.css";
import "./composer-area-select.css";

type AnnotationSelection = NonNullable<ChatContext["appSelection"]>;

type ComposerAreaSelectOverlayProps = {
  active: boolean;
  requestId?: number | null;
  onCancel: () => void;
  onSubmit: (
    payload: {
      text: string;
      selection: AnnotationSelection;
    },
    requestId?: number | null,
  ) => void;
};

const ANNOTATION_COMPOSER_WIDTH = 360;
const ANNOTATION_COMPOSER_MIN_HEIGHT = 46;
const ANNOTATION_COMPOSER_GAP = 10;
const ANNOTATION_COMPOSER_MARGIN = 12;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const getComposerPosition = (
  bounds: AnnotationSelection["bounds"],
  measuredHeight: number,
) => {
  const width = Math.min(
    ANNOTATION_COMPOSER_WIDTH,
    Math.max(260, window.innerWidth - ANNOTATION_COMPOSER_MARGIN * 2),
  );
  const height = Math.max(ANNOTATION_COMPOSER_MIN_HEIGHT, measuredHeight);
  const left = clamp(
    bounds.x + bounds.width / 2 - width / 2,
    ANNOTATION_COMPOSER_MARGIN,
    Math.max(
      ANNOTATION_COMPOSER_MARGIN,
      window.innerWidth - width - ANNOTATION_COMPOSER_MARGIN,
    ),
  );
  const topCandidate = bounds.y - height - ANNOTATION_COMPOSER_GAP;
  const belowTop = bounds.y + bounds.height + ANNOTATION_COMPOSER_GAP;
  const spaceAbove =
    bounds.y - ANNOTATION_COMPOSER_GAP - ANNOTATION_COMPOSER_MARGIN;
  const spaceBelow =
    window.innerHeight -
    (bounds.y + bounds.height) -
    ANNOTATION_COMPOSER_GAP -
    ANNOTATION_COMPOSER_MARGIN;
  const fitsBelow = spaceBelow >= height;
  const fitsAbove = spaceAbove >= height;
  const preferBelow = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);
  const top = clamp(
    preferBelow ? belowTop : topCandidate,
    ANNOTATION_COMPOSER_MARGIN,
    Math.max(
      ANNOTATION_COMPOSER_MARGIN,
      window.innerHeight - height - ANNOTATION_COMPOSER_MARGIN,
    ),
  );

  return {
    left,
    top,
    width,
    placement: preferBelow ? "bottom" : "top",
  };
};

const sameSelection = (
  current: AnnotationSelection,
  expected: AnnotationSelection,
): boolean =>
  current.label === expected.label &&
  current.snapshot === expected.snapshot &&
  current.surface === expected.surface &&
  current.bounds.x === expected.bounds.x &&
  current.bounds.y === expected.bounds.y &&
  current.bounds.width === expected.bounds.width &&
  current.bounds.height === expected.bounds.height;

export function ComposerAreaSelectOverlay({
  active,
  requestId = null,
  onCancel,
  onSubmit,
}: ComposerAreaSelectOverlayProps) {
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [draft, setDraft] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerHeight, setComposerHeight] = useState(
    ANNOTATION_COMPOSER_MIN_HEIGHT,
  );
  const targetRef = useRef<SelectionTarget | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

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
      setDraft("");
      setComposerExpanded(false);
      setComposerHeight(ANNOTATION_COMPOSER_MIN_HEIGHT);
      return;
    }
    setSelection(null);
    setDraft("");
    setComposerExpanded(false);
    setComposerHeight(ANNOTATION_COMPOSER_MIN_HEIGHT);
  }, [active, requestId]);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.stellaAnnotationMode = "true";
    return () => {
      delete root.dataset.stellaAnnotationMode;
    };
  }, [active]);

  useEffect(() => {
    if (!active || selection) return;
    primeReactGrabSource();
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
        const baseSelection: AnnotationSelection = {
          label: selected.label,
          snapshot: selected.snapshot,
          bounds: selected.bounds,
          surface: selected.surface,
          ...(selected.anchor ? { anchor: selected.anchor } : {}),
        };
        setSelection(baseSelection);

        void resolveReactGrabSource(selected.element)
          .then((resolved) => {
            if (!resolved) return;
            setSelection((current) => {
              if (!current || !sameSelection(current, baseSelection)) {
                return current;
              }
              const hasSource =
                Boolean(resolved.filePath) ||
                typeof resolved.lineNumber === "number" ||
                Boolean(resolved.componentName);
              return {
                ...current,
                ...(hasSource
                  ? {
                      source: {
                        ...(resolved.filePath
                          ? { filePath: resolved.filePath }
                          : {}),
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
            });
          })
          .catch(() => {
            // Source resolution is best-effort; fall back to aria/text snapshot.
          });
      }
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      document.body.style.cursor = previousCursor;
    };
  }, [active, selection, updateTarget]);

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

  useEffect(() => {
    if (!active || !selection) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, selection]);

  useAnimatedComposerShell({
    active: active && Boolean(selection),
    shellRef,
    contentRef: shellContentRef,
    formRef,
    syncOnNextFrame: true,
  });

  useEffect(() => {
    if (!active || !selection) return;
    const content = shellContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const syncHeight = () => {
      setComposerHeight(
        Math.ceil(
          Math.max(
            ANNOTATION_COMPOSER_MIN_HEIGHT,
            content.getBoundingClientRect().height,
          ),
        ),
      );
    };
    syncHeight();
    const frame = requestAnimationFrame(syncHeight);
    const observer = new ResizeObserver(syncHeight);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, selection]);

  useEffect(() => {
    if (!selection) return;
    const frame = requestAnimationFrame(() => {
      updateComposerTextareaExpansion(inputRef.current, setComposerExpanded);
    });
    return () => cancelAnimationFrame(frame);
  }, [draft, selection]);

  const submitDraft = useCallback(
    (event?: Pick<FormEvent, "preventDefault">) => {
      event?.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed || !selection) return;
      onSubmit({ text: trimmed, selection }, requestId);
      setDraft("");
    },
    [draft, onSubmit, requestId, selection],
  );

  if (!active) return null;

  const displayedTarget = selection ? selection : target;
  const composerPosition = selection
    ? getComposerPosition(selection.bounds, composerHeight)
    : null;
  const canSubmit = draft.trim().length > 0;

  return createPortal(
    <div
      className="composer-area-select-overlay"
      data-composer-area-select-ignore="true"
      data-state={selection ? "annotating" : "selecting"}
      onPointerDown={(event) => {
        if (!selection) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
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
      {selection && composerPosition ? (
        <div
          className="composer-area-annotation"
          data-placement={composerPosition.placement}
          style={{
            left: composerPosition.left,
            top: composerPosition.top,
            width: composerPosition.width,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div
            ref={shellRef}
            className="composer-shell composer-area-annotation__shell"
          >
            <div
              ref={shellContentRef}
              className="composer-shell-content composer-area-annotation__content"
            >
              <form
                ref={formRef}
                className={`composer-form composer-area-annotation__form${composerExpanded ? " expanded" : ""}`}
                onSubmit={submitDraft}
              >
                <ComposerTextarea
                  ref={inputRef}
                  className="composer-input composer-area-annotation__input"
                  rows={1}
                  value={draft}
                  placeholder="Ask Stella..."
                  onChange={(event) => {
                    setDraft(event.target.value);
                    requestAnimationFrame(() => {
                      updateComposerTextareaExpansion(
                        inputRef.current,
                        setComposerExpanded,
                      );
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      submitDraft(event);
                    }
                  }}
                  aria-label={`Ask Stella about ${selection.label}`}
                />
                <div className="composer-toolbar">
                  <div className="composer-toolbar-left" />
                  <div className="composer-toolbar-right">
                    <button
                      type="button"
                      className="chat-composer-icon-button chat-composer-icon-button--add composer-area-annotation__cancel"
                      onClick={onCancel}
                      aria-label="Cancel"
                      title="Cancel"
                    >
                      <X size={16} strokeWidth={1.75} />
                    </button>
                    <ComposerSubmitButton
                      className="composer-submit"
                      disabled={!canSubmit}
                      animated
                      aria-label="Send"
                      title="Send"
                    />
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
