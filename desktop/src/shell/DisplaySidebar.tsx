import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/context/theme-context";
import {
  type DisplayPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { PdfViewerCard } from "@/app/chat/PdfViewerCard";
import { applyMorphdomHtml } from "./apply-morphdom-html";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { MediaPreviewCard } from "./MediaPreviewCard";
import "./display-sidebar.css";

export interface DisplaySidebarHandle {
  /** Open the sidebar with the given payload (legacy: bare HTML string). */
  open(payload: DisplayPayload | string): void;
  /** Update the visible payload without changing open state. */
  update(payload: DisplayPayload | string): void;
  close(): void;
}

type DisplaySidebarProps = {
  onOpenChange?: (open: boolean) => void;
};

export const DisplaySidebar = forwardRef<DisplaySidebarHandle, DisplaySidebarProps>(
  function DisplaySidebar({ onOpenChange }, ref) {
    const { gradientMode, gradientColor } = useTheme();
    const [isOpen, setIsOpen] = useState(false);
    const [payload, setPayload] = useState<DisplayPayload | null>(null);
    const htmlContainerRef = useRef<HTMLDivElement>(null);

    const applyPayload = useCallback((next: DisplayPayload) => {
      setPayload(next);
      if (next.kind === "html") {
        // Defer until the html container exists in the DOM (it's gated on
        // `payload.kind === "html"` below).
        requestAnimationFrame(() => {
          const container = htmlContainerRef.current;
          if (!container) return;
          applyMorphdomHtml(container, "display-sidebar__content", next.html, {
            executeScripts: true,
          });
        });
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        open(rawPayload) {
          const next = normalizeDisplayPayload(rawPayload);
          if (!next) return;
          setIsOpen(true);
          applyPayload(next);
        },
        update(rawPayload) {
          const next = normalizeDisplayPayload(rawPayload);
          if (!next) return;
          applyPayload(next);
        },
        close() {
          setIsOpen(false);
        },
      }),
      [applyPayload],
    );

    useEffect(() => {
      if (!isOpen) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setIsOpen(false);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [isOpen]);

    useEffect(() => {
      onOpenChange?.(isOpen);
    }, [isOpen, onOpenChange]);

    const handleHtmlClick = useCallback((e: React.MouseEvent) => {
      const el = (e.target as HTMLElement).closest(
        "[data-action]",
      ) as HTMLElement | null;
      if (!el) return;
      const action = el.getAttribute("data-action");
      if (action === "send-message") {
        const prompt = el.getAttribute("data-prompt");
        if (prompt) {
          window.dispatchEvent(
            new CustomEvent("stella:send-message", { detail: { text: prompt } }),
          );
        }
      }
    }, []);

    const portalTarget =
      document.querySelector(".full-body") ?? document.body;

    return createPortal(
      <aside
        className={`display-sidebar${isOpen ? " display-sidebar--open" : ""}`}
        aria-hidden={!isOpen}
      >
        <ShiftingGradient
          mode={gradientMode}
          colorMode={gradientColor}
          contained
        />
        <div className="display-sidebar-inner">
          <button
            className="display-sidebar__close"
            onClick={() => setIsOpen(false)}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          {payload?.kind === "html" && (
            <div
              ref={htmlContainerRef}
              className="display-sidebar__content"
              onClick={handleHtmlClick}
            />
          )}

          {payload?.kind === "office" && (
            <div className="display-sidebar__rich">
              <OfficePreviewCard previewRef={payload.previewRef} />
            </div>
          )}

          {payload?.kind === "pdf" && (
            <div className="display-sidebar__rich display-sidebar__rich--pdf">
              <PdfViewerCard
                filePath={payload.filePath}
                {...(payload.title ? { title: payload.title } : {})}
              />
            </div>
          )}

          {payload?.kind === "media" && (
            <div className="display-sidebar__rich display-sidebar__rich--media">
              <MediaPreviewCard
                asset={payload.asset}
                {...(payload.prompt ? { prompt: payload.prompt } : {})}
                {...(payload.capability ? { capability: payload.capability } : {})}
              />
            </div>
          )}
        </div>
      </aside>,
      portalTarget,
    );
  },
);
