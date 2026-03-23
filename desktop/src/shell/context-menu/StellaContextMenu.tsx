/**
 * StellaContextMenu — in-app right-click-hold-drag-release menu.
 *
 * Interaction model:
 *   Right-click and HOLD → menu appears at cursor
 *   Drag (while holding) → hovered item highlights; contextual items
 *     highlight the referenced DOM region
 *   Release on an item → action fires
 *   Release outside → dismisses
 *
 * Items:
 *   1. Ask Stella anything   — opens floating orb chat
 *   2. Ask about this        — opens floating orb chat with captured context
 *   3. Close                 — closes floating orb chat (disabled when it is not open)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import MessageCircle from "lucide-react/dist/esm/icons/message-circle";
import Scan from "lucide-react/dist/esm/icons/scan";
import X from "lucide-react/dist/esm/icons/x";
import type { ChatContext } from "@/shared/types/electron";
import {
  captureContextAtPoint,
  type CapturedContext,
} from "./context-capture";
import "./stella-context-menu.css";

const HIGHLIGHT_CLASS = "stella-context-highlight";
const HIGHLIGHT_BROAD_CLASS = "stella-context-highlight--broad";

const MENU_ID = {
  ASK_ANYTHING: "ask-anything",
  ASK_ABOUT_THIS: "ask-about-this",
  CLOSE: "close",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MenuItemDef = {
  id: string;
  label: string;
  icon: typeof MessageCircle;
  disabled?: boolean;
  /** Whether to highlight the broad container on hover. */
  highlightContext: boolean;
};

type StellaContextMenuProps = {
  children: ReactNode;
  /** Whether the floating orb chat is currently open (controls Close item state). */
  isOrbChatOpen: boolean;
  /** Open the floating orb chat, optionally seeded with captured context. */
  onOpenOrbChat: (chatContext?: ChatContext | null) => void;
  /** Close the floating orb chat. */
  onCloseOrbChat: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StellaContextMenu({
  children,
  isOrbChatOpen,
  onOpenOrbChat,
  onCloseOrbChat,
}: StellaContextMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const contextRef = useRef<CapturedContext | null>(null);
  const highlightedRef = useRef<Element | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextLabel, setContextLabel] = useState("this");

  // Stable refs for callbacks used inside global listeners, avoiding
  // listener re-registration when these values change.
  const isOrbChatOpenRef = useRef(isOrbChatOpen);
  isOrbChatOpenRef.current = isOrbChatOpen;
  const onOpenOrbChatRef = useRef(onOpenOrbChat);
  onOpenOrbChatRef.current = onOpenOrbChat;
  const onCloseOrbChatRef = useRef(onCloseOrbChat);
  onCloseOrbChatRef.current = onCloseOrbChat;

  const menuItems: MenuItemDef[] = [
    {
      id: MENU_ID.ASK_ANYTHING,
      label: "Ask Stella anything",
      icon: MessageCircle,
      highlightContext: false,
    },
    {
      id: MENU_ID.ASK_ABOUT_THIS,
      label: `Ask about ${contextLabel}`,
      icon: Scan,
      highlightContext: true,
    },
    {
      id: MENU_ID.CLOSE,
      label: "Close",
      icon: X,
      disabled: !isOrbChatOpen,
      highlightContext: false,
    },
  ];

  const clearHighlight = useCallback(() => {
    if (highlightedRef.current) {
      highlightedRef.current.classList.remove(HIGHLIGHT_CLASS, HIGHLIGHT_BROAD_CLASS);
      highlightedRef.current = null;
    }
  }, []);

  const applyHighlight = useCallback((el: Element) => {
    clearHighlight();
    el.classList.add(HIGHLIGHT_CLASS, HIGHLIGHT_BROAD_CLASS);
    highlightedRef.current = el;
  }, [clearHighlight]);

  const toOrbChatContext = useCallback((captured: CapturedContext): ChatContext => ({
    window: {
      app: "Stella",
      title: captured.contextLabel,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    },
    windowText: captured.broadSnapshot,
  }), []);

  const handleSelect = useCallback(
    (id: string) => {
      const ctx = contextRef.current;

      switch (id) {
        case MENU_ID.ASK_ANYTHING:
          onOpenOrbChatRef.current(null);
          break;

        case MENU_ID.ASK_ABOUT_THIS:
          onOpenOrbChatRef.current(ctx ? toOrbChatContext(ctx) : null);
          break;

        case MENU_ID.CLOSE:
          onCloseOrbChatRef.current();
          break;
      }
    },
    [toOrbChatContext],
  );

  // ---- Right-click-hold interaction ----

  const closeMenu = useCallback(() => {
    clearHighlight();
    setMenuOpen(false);
    setHoveredId(null);
    hoveredIdRef.current = null;
  }, [clearHighlight]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 2) return;

      e.preventDefault();
      e.stopPropagation();

      const target = e.target as Element;
      if (menuRef.current?.contains(target)) return;

      const captured = captureContextAtPoint(target);
      contextRef.current = captured;
      setContextLabel(captured.contextLabel);

      const menuWidth = 260;
      const menuHeight = 228;
      const cursorGap = 8;
      const x = Math.min(e.clientX + cursorGap, window.innerWidth - menuWidth - 8);
      const y = Math.max(8, Math.min(
        e.clientY - menuHeight / 2,
        window.innerHeight - menuHeight - 8,
      ));
      setPosition({ x, y });
      setMenuOpen(true);
      setHoveredId(null);
      hoveredIdRef.current = null;
    },
    [],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Stable callbacks that read mutable state from refs — avoids
  // tearing down and re-registering global listeners on every hover.
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!menuRef.current) return;

      const menuRect = menuRef.current.getBoundingClientRect();
      const isInMenu =
        e.clientX >= menuRect.left &&
        e.clientX <= menuRect.right &&
        e.clientY >= menuRect.top &&
        e.clientY <= menuRect.bottom;

      if (!isInMenu) {
        if (hoveredIdRef.current !== null) {
          hoveredIdRef.current = null;
          setHoveredId(null);
          clearHighlight();
        }
        return;
      }

      const items = menuRef.current.querySelectorAll("[data-menu-id]");
      let foundId: string | null = null;
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom &&
          e.clientX >= rect.left &&
          e.clientX <= rect.right
        ) {
          foundId = item.getAttribute("data-menu-id");
          break;
        }
      }

      if (foundId !== hoveredIdRef.current) {
        hoveredIdRef.current = foundId;
        setHoveredId(foundId);
        clearHighlight();

        if (foundId === MENU_ID.ASK_ABOUT_THIS && contextRef.current) {
          applyHighlight(contextRef.current.containers.broad);
        }
      }
    },
    [clearHighlight, applyHighlight],
  );

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 2) return;

      const id = hoveredIdRef.current;
      if (id) {
        const isDisabled = id === MENU_ID.CLOSE && !isOrbChatOpenRef.current;
        if (!isDisabled) {
          handleSelect(id);
        }
      }

      closeMenu();
    },
    [handleSelect, closeMenu],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
      }
    },
    [closeMenu],
  );

  useEffect(() => {
    if (!menuOpen) return;

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
      clearHighlight();
    };
  }, [menuOpen, handleMouseMove, handleMouseUp, handleKeyDown, clearHighlight]);

  useEffect(() => {
    return () => clearHighlight();
  }, [clearHighlight]);

  return (
    <div
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      style={{ display: "contents" }}
    >
      {children}

      {menuOpen && (
        <div
          ref={menuRef}
          className="stella-context-menu"
          style={{
            left: position.x,
            top: position.y,
          }}
        >
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isHovered = hoveredId === item.id;
            const isDisabled = item.disabled;

            return (
              <div
                key={item.id}
                data-menu-id={item.id}
                className={[
                  "stella-context-menu-item",
                  isHovered && !isDisabled
                    ? "stella-context-menu-item--hovered"
                    : "",
                  isDisabled ? "stella-context-menu-item--disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="stella-context-menu-item-icon">
                  <Icon size={18} strokeWidth={1.8} />
                </span>
                <span className="stella-context-menu-item-label">
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
