import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { applyMorphdomHtml } from "./apply-morphdom-html";
import "./display-sidebar.css";

export interface DisplaySidebarHandle {
  open(html: string): void;
  update(html: string): void;
  close(): void;
}

export const DisplaySidebar = forwardRef<DisplaySidebarHandle>(
  function DisplaySidebar(_props, ref) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const applyHtml = useCallback((html: string) => {
      const container = containerRef.current;
      if (!container) return;
      applyMorphdomHtml(container, "display-sidebar__content", html);
    }, []);

    useImperativeHandle(ref, () => ({
      open(html: string) {
        setIsOpen(true);
        requestAnimationFrame(() => applyHtml(html));
      },
      update(html: string) {
        requestAnimationFrame(() => applyHtml(html));
      },
      close() {
        setIsOpen(false);
      },
    }), [applyHtml]);

    useEffect(() => {
      if (!isOpen) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setIsOpen(false);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [isOpen]);

    const handleClick = useCallback((e: React.MouseEvent) => {
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
          <div
            ref={containerRef}
            className="display-sidebar__content"
            onClick={handleClick}
          />
        </div>
      </aside>,
      portalTarget,
    );
  },
);
