import { useEffect, useRef, useCallback, useState } from "react";
import { useNiriState } from "./use-niri-state";
import { NiriWindowContent } from "./NiriWindowContent";
import { WINDOW_TEMPLATES, type NiriWindowType } from "./niri-types";
import "./niri.css";

const COLUMN_GAP = 8;
const STRIP_PADDING = 8;
const TITLEBAR_HEIGHT = 32;

// 70% of the current screen
const DEFAULT_WIDTH = Math.round(window.screen.width * 0.7);
const DEFAULT_HEIGHT = Math.round(window.screen.height * 0.7);

const WINDOW_TYPE_OPTIONS: NiriWindowType[] = [
  "news-feed", "music-player", "ai-search", "calendar",
  "game", "system-monitor", "weather", "notes", "file-browser",
];

/** Draggable floating panel hook */
function useNiriDrag(rootRef: React.RefObject<HTMLDivElement | null>) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only on the drag handle itself, not children buttons/inputs
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, .niri-strip-container, .niri-workspace-switcher")) return;
    e.preventDefault();
    const el = rootRef.current;
    if (!el) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: parseInt(el.style.left, 10) || el.getBoundingClientRect().left,
      origY: parseInt(el.style.top, 10) || el.getBoundingClientRect().top,
    };
  }, [rootRef]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current || !rootRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      rootRef.current.style.left = `${dragRef.current.origX + dx}px`;
      rootRef.current.style.top = `${dragRef.current.origY + dy}px`;
    };
    const handleUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [rootRef]);

  return { handleDragStart };
}

export function NiriDemo({ onClose, panelRef }: { onClose: () => void; panelRef?: React.RefObject<HTMLDivElement | null> }) {
  const {
    state, activeWorkspace,
    focusColumn, focusLeft, focusRight,
    openWindow, closeWindow,
    switchWorkspace,
    moveColumnLeft, moveColumnRight,
  } = useNiriState();

  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [showLauncher, setShowLauncher] = useState(false);
  const [time, setTime] = useState(() => new Date());

  // Merge internal rootRef with external panelRef for hit-testing
  const setRootRef = useCallback((el: HTMLDivElement | null) => {
    (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (panelRef && "current" in panelRef) {
      (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  }, [panelRef]);

  const { handleDragStart } = useNiriDrag(rootRef);

  // Center on primary screen
  const [initialPos] = useState(() => ({
    left: Math.round((window.screen.width - DEFAULT_WIDTH) / 2),
    top: Math.round((window.screen.height - DEFAULT_HEIGHT) / 2),
  }));

  // Clock
  useEffect(() => {
    const iv = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }

      switch (e.key) {
        case "Escape":
          if (showLauncher) { setShowLauncher(false); }
          else { onClose(); }
          e.preventDefault();
          break;
        case "ArrowLeft":
          if (e.ctrlKey || e.metaKey) moveColumnLeft();
          else focusLeft();
          e.preventDefault();
          break;
        case "ArrowRight":
          if (e.ctrlKey || e.metaKey) moveColumnRight();
          else focusRight();
          e.preventDefault();
          break;
        case "ArrowUp":
          if (state.activeWorkspaceIndex > 0) switchWorkspace(state.activeWorkspaceIndex - 1);
          e.preventDefault();
          break;
        case "ArrowDown":
          if (state.activeWorkspaceIndex < state.workspaces.length - 1) switchWorkspace(state.activeWorkspaceIndex + 1);
          e.preventDefault();
          break;
        case "Enter":
          if (e.ctrlKey || e.metaKey) setShowLauncher(true);
          e.preventDefault();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, showLauncher, focusLeft, focusRight, moveColumnLeft, moveColumnRight, switchWorkspace, state.activeWorkspaceIndex, state.workspaces.length]);

  // Scroll focused column into view
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeWorkspace.focusedColumnIndex < 0) return;

    const columns = strip.querySelectorAll<HTMLElement>(".niri-column");
    const col = columns[activeWorkspace.focusedColumnIndex];
    if (!col) return;

    const stripRect = strip.getBoundingClientRect();
    const colRect = col.getBoundingClientRect();
    const colCenter = colRect.left + colRect.width / 2 - stripRect.left + strip.scrollLeft;
    const targetScroll = colCenter - stripRect.width / 2;

    strip.scrollTo({ left: targetScroll, behavior: "smooth" });
  }, [activeWorkspace.focusedColumnIndex, activeWorkspace.columns.length]);

  // Wheel scroll
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const strip = stripRef.current;
    if (!strip) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      strip.scrollLeft += e.deltaY;
    }
  }, []);

  const handleOpenWindow = useCallback((type: NiriWindowType) => {
    openWindow(type);
    setShowLauncher(false);
  }, [openWindow]);

  return (
    <div className="niri-backdrop">
      <div
        ref={setRootRef}
        className="niri-root"
        style={{
          left: initialPos.left,
          top: initialPos.top,
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        }}
      >
        {/* Status bar — draggable handle */}
        <div className="niri-statusbar" onMouseDown={handleDragStart}>
          <div className="niri-statusbar-left">
            <span className="niri-statusbar-pill">niri</span>
            <span className="niri-statusbar-pill subtle">
              Workspace {state.activeWorkspaceIndex + 1}
            </span>
            {activeWorkspace.columns.length > 0 && (
              <span className="niri-statusbar-pill subtle">
                {activeWorkspace.columns.length} window{activeWorkspace.columns.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="niri-statusbar-center">
            {activeWorkspace.focusedColumnIndex >= 0 && activeWorkspace.columns[activeWorkspace.focusedColumnIndex] && (
              <span className="niri-statusbar-pill focused">
                {activeWorkspace.columns[activeWorkspace.focusedColumnIndex].windows[0]?.title}
              </span>
            )}
          </div>
          <div className="niri-statusbar-right">
            <button className="niri-statusbar-btn" onClick={() => setShowLauncher(true)} title="Open window (Ctrl+Enter)">+</button>
            <span className="niri-statusbar-pill subtle">
              {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <button className="niri-close-btn" onClick={onClose} title="Exit niri demo (Esc)">✕</button>
          </div>
        </div>

        {/* Main area: workspace switcher + strip */}
        <div className="niri-main">
          {/* Workspace switcher (left edge) */}
          <div className="niri-workspace-switcher">
            {state.workspaces.map((ws, i) => (
              <button
                key={ws.id}
                className={`niri-ws-dot ${i === state.activeWorkspaceIndex ? "active" : ""} ${ws.columns.length === 0 ? "empty" : ""}`}
                onClick={() => switchWorkspace(i)}
                title={`Workspace ${i + 1}${ws.columns.length === 0 ? " (empty)" : ` (${ws.columns.length} windows)`}`}
              >
                <span className="niri-ws-dot-indicator" />
                {ws.columns.length > 0 && (
                  <span className="niri-ws-dot-count">{ws.columns.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Window strip */}
          <div className="niri-strip-container" onWheel={handleWheel}>
            <div className="niri-strip" ref={stripRef}>
              <div className="niri-strip-inner" style={{ padding: `${STRIP_PADDING}px`, gap: `${COLUMN_GAP}px` }}>
                {activeWorkspace.columns.length === 0 && (
                  <div className="niri-empty-workspace">
                    <div className="niri-empty-text">Empty workspace</div>
                    <div className="niri-empty-hint">Press Ctrl+Enter to open a window</div>
                  </div>
                )}
                {activeWorkspace.columns.map((col, colIdx) => (
                  <div
                    key={col.id}
                    className={`niri-column ${colIdx === activeWorkspace.focusedColumnIndex ? "focused" : ""}`}
                    style={{ width: col.windows[0]?.width ?? 400 }}
                    onClick={() => focusColumn(colIdx)}
                  >
                    {col.windows.map((win) => (
                      <div key={win.id} className="niri-window">
                        <div className="niri-window-titlebar" style={{ height: TITLEBAR_HEIGHT }}>
                          <div className="niri-window-titlebar-left">
                            <span className="niri-window-title">{win.title}</span>
                          </div>
                          <div className="niri-window-titlebar-right">
                            <button
                              className="niri-window-btn"
                              onClick={(e) => { e.stopPropagation(); closeWindow(col.id, win.id); }}
                              title="Close window"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="niri-window-content">
                          <NiriWindowContent type={win.type} />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom hints — floating pills */}
        <div className="niri-hints">
          <span className="niri-hint-pill">←/→ Focus</span>
          <span className="niri-hint-pill">Ctrl+←/→ Move</span>
          <span className="niri-hint-pill">↑/↓ Workspace</span>
          <span className="niri-hint-pill">Ctrl+Enter Open</span>
          <span className="niri-hint-pill">Esc Close</span>
        </div>

        {/* Launcher overlay */}
        {showLauncher && (
          <div className="niri-launcher-backdrop" onClick={() => setShowLauncher(false)}>
            <div className="niri-launcher" onClick={(e) => e.stopPropagation()}>
              <div className="niri-launcher-title">Open Window</div>
              <div className="niri-launcher-grid">
                {WINDOW_TYPE_OPTIONS.map((type) => {
                  const t = WINDOW_TEMPLATES[type];
                  return (
                    <button
                      key={type}
                      className="niri-launcher-item"
                      onClick={() => handleOpenWindow(type)}
                    >
                      <span className="niri-launcher-icon">{getWindowIcon(type)}</span>
                      <span className="niri-launcher-label">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getWindowIcon(type: NiriWindowType): string {
  switch (type) {
    case "news-feed": return "📰";
    case "music-player": return "🎵";
    case "ai-search": return "🔍";
    case "calendar": return "📅";
    case "game": return "🎮";
    case "system-monitor": return "📊";
    case "weather": return "🌤";
    case "notes": return "📝";
    case "file-browser": return "📁";
  }
}

export default NiriDemo;
