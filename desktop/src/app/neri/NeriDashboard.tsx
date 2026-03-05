import { memo, useEffect, useRef, useCallback, useState } from "react";
import { useNeriState } from "./use-neri-state";
import { NeriWindowContent } from "./NeriWindowContent";
import { WINDOW_TEMPLATES, type NeriWindowType } from "./neri-types";
import { useNeriDrag } from "./use-neri-drag";
import "./neri.css";

const COLUMN_GAP = 8;
const STRIP_PADDING = 8;
const TITLEBAR_HEIGHT = 32;
const STRIP_INNER_STYLE = { padding: `${STRIP_PADDING}px`, gap: `${COLUMN_GAP}px` };
const WINDOW_TITLEBAR_STYLE = { height: TITLEBAR_HEIGHT } as const;
const CLOCK_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

// Lazily computed on first use to avoid reading window.screen at module parse time
let _defaultWidth = 0;
let _defaultHeight = 0;
function getDefaultSize() {
  if (!_defaultWidth) {
    _defaultWidth = Math.round(window.screen.width * 0.7);
    _defaultHeight = Math.round(window.screen.height * 0.7);
  }
  return { width: _defaultWidth, height: _defaultHeight };
}

// Mercury-only types excluded from the launcher
const MERCURY_ONLY = new Set<NeriWindowType>(["search", "canvas"]);
const WINDOW_TYPE_OPTIONS = (Object.keys(WINDOW_TEMPLATES) as NeriWindowType[]).filter((t) => !MERCURY_ONLY.has(t));

const WINDOW_ICONS: Record<NeriWindowType, string> = {
  "news-feed": "📰",
  "music-player": "🎵",
  "ai-search": "🔍",
  "calendar": "📅",
  "game": "🎮",
  "system-monitor": "📊",
  "weather": "🌤",
  "notes": "📝",
  "file-browser": "📁",
  "search": "🔎",
  "canvas": "🎨",
};

const StatusClock = memo(function StatusClock() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <span className="neri-statusbar-pill subtle">
      {time.toLocaleTimeString([], CLOCK_FORMAT_OPTIONS)}
    </span>
  );
});

/** Draggable floating panel hook */
function useNeriPanelDrag(rootRef: React.RefObject<HTMLDivElement | null>) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only on the drag handle itself, not children buttons/inputs
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, .neri-strip-container, .neri-workspace-switcher")) return;
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

export function NeriDashboard({ onClose, panelRef, cursorPosition }: { onClose: () => void; panelRef?: React.RefObject<HTMLDivElement | null>; cursorPosition?: { x: number; y: number } | null }) {
  const {
    state, activeWorkspace,
    focusColumn, focusLeft, focusRight,
    openWindow, closeWindow,
    switchWorkspace,
    moveColumnLeft, moveColumnRight,
  } = useNeriState();

  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripContainerRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);
  const [showLauncher, setShowLauncher] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const workspaceBoundsRef = useRef({
    activeWorkspaceIndex: state.activeWorkspaceIndex,
    workspaceCount: state.workspaces.length,
  });
  const keyboardStateRef = useRef({
    showLauncher,
    activeWorkspaceIndex: state.activeWorkspaceIndex,
    workspaceCount: state.workspaces.length,
  });

  workspaceBoundsRef.current.activeWorkspaceIndex = state.activeWorkspaceIndex;
  workspaceBoundsRef.current.workspaceCount = state.workspaces.length;
  keyboardStateRef.current.showLauncher = showLauncher;
  keyboardStateRef.current.activeWorkspaceIndex = state.activeWorkspaceIndex;
  keyboardStateRef.current.workspaceCount = state.workspaces.length;

  // Merge internal rootRef with external panelRef for hit-testing
  const setRootRef = useCallback((el: HTMLDivElement | null) => {
    (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (panelRef && "current" in panelRef) {
      (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  }, [panelRef]);

  const { handleDragStart } = useNeriPanelDrag(rootRef);

  // Right-click drag navigation
  const handleWorkspaceSwitch = useCallback((delta: number) => {
    const { activeWorkspaceIndex, workspaceCount } = workspaceBoundsRef.current;
    const newIdx = activeWorkspaceIndex + delta;
    if (newIdx >= 0 && newIdx < workspaceCount) {
      switchWorkspace(newIdx);
    }
  }, [switchWorkspace]);

  useNeriDrag(stripContainerRef, handleWorkspaceSwitch);

  const handleClose = useCallback(() => {
    setIsClosing((wasClosing) => {
      if (wasClosing) return wasClosing;
      closeTimeoutRef.current = window.setTimeout(() => onClose(), 200); // match neri-panel-exit duration
      return true;
    });
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  // Center on the screen where the cursor is (multi-monitor aware)
  const [{ initialPos, panelSize }] = useState(() => {
    const size = getDefaultSize();
    const pos = cursorPosition
      ? { left: Math.round(cursorPosition.x - size.width / 2), top: Math.round(cursorPosition.y - size.height / 2) }
      : { left: Math.round((window.screen.width - size.width) / 2), top: Math.round((window.screen.height - size.height) / 2) };
    return { initialPos: pos, panelSize: size };
  });

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { showLauncher: launcherOpen, activeWorkspaceIndex, workspaceCount } = keyboardStateRef.current;

      // Don't intercept if typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }

      switch (e.key) {
        case "Escape":
          if (launcherOpen) { setShowLauncher(false); }
          else { handleClose(); }
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
          if (activeWorkspaceIndex > 0) switchWorkspace(activeWorkspaceIndex - 1);
          e.preventDefault();
          break;
        case "ArrowDown":
          if (activeWorkspaceIndex < workspaceCount - 1) switchWorkspace(activeWorkspaceIndex + 1);
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
  }, [handleClose, focusLeft, focusRight, moveColumnLeft, moveColumnRight, switchWorkspace]);

  // Scroll focused column into view
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeWorkspace.focusedColumnIndex < 0) return;

    const columns = strip.querySelectorAll<HTMLElement>(".neri-column");
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

  const handleOpenWindow = useCallback((type: NeriWindowType) => {
    openWindow(type);
    setShowLauncher(false);
  }, [openWindow]);

  const workspaceColumnCount = activeWorkspace.columns.length;
  const focusedColumn = activeWorkspace.focusedColumnIndex >= 0
    ? activeWorkspace.columns[activeWorkspace.focusedColumnIndex]
    : null;

  return (
    <div className="neri-backdrop">
      <div
        ref={setRootRef}
        className={`neri-root${isClosing ? " closing" : ""}`}
        style={{
          left: initialPos.left,
          top: initialPos.top,
          width: panelSize.width,
          height: panelSize.height,
        }}
      >
        {/* Status bar — draggable handle */}
        <div className="neri-statusbar" onMouseDown={handleDragStart}>
          <div className="neri-statusbar-left">
            <span className="neri-statusbar-pill">neri</span>
            <span className="neri-statusbar-pill subtle">
              Workspace {state.activeWorkspaceIndex + 1}
            </span>
            {activeWorkspace.columns.length > 0 && (
              <span className="neri-statusbar-pill subtle">
                {activeWorkspace.columns.length} window{activeWorkspace.columns.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="neri-statusbar-center">
            {activeWorkspace.focusedColumnIndex >= 0 && activeWorkspace.columns[activeWorkspace.focusedColumnIndex] && (
              <span className="neri-statusbar-pill focused">
                {activeWorkspace.columns[activeWorkspace.focusedColumnIndex].windows[0]?.title}
              </span>
            )}
          </div>
          <div className="neri-statusbar-right">
            <button className="neri-statusbar-btn" onClick={() => setShowLauncher(true)} title="Open window (Ctrl+Enter)">+</button>
            <span className="neri-statusbar-pill subtle">
              {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <button className="neri-close-btn" onClick={handleClose} title="Exit Neri (Esc)">✕</button>
          </div>
        </div>

        {/* Main area: workspace switcher + strip */}
        <div className="neri-main">
          {/* Workspace switcher (left edge) */}
          <div className="neri-workspace-switcher">
            {state.workspaces.map((ws, i) => (
              <button
                key={ws.id}
                className={`neri-ws-dot ${i === state.activeWorkspaceIndex ? "active" : ""} ${ws.columns.length === 0 ? "empty" : ""}`}
                onClick={() => switchWorkspace(i)}
                title={`Workspace ${i + 1}${ws.columns.length === 0 ? " (empty)" : ` (${ws.columns.length} windows)`}`}
              >
                <span className="neri-ws-dot-indicator" />
                {ws.columns.length > 0 && (
                  <span className="neri-ws-dot-count">{ws.columns.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Window strip */}
          <div className="neri-strip-container" ref={stripContainerRef} onWheel={handleWheel}>
            <div className="neri-strip" ref={stripRef}>
              <div className="neri-strip-inner" style={{ padding: `${STRIP_PADDING}px`, gap: `${COLUMN_GAP}px` }}>
                {activeWorkspace.columns.length === 0 && (
                  <div className="neri-empty-workspace">
                    <div className="neri-empty-text">Empty workspace</div>
                    <div className="neri-empty-hint">Press Ctrl+Enter to open a window</div>
                  </div>
                )}
                {activeWorkspace.columns.map((col, colIdx) => (
                  <div
                    key={col.id}
                    className={`neri-column ${colIdx === activeWorkspace.focusedColumnIndex ? "focused" : ""}`}
                    style={{ width: col.windows[0]?.width ?? 400 }}
                    onClick={() => focusColumn(colIdx)}
                  >
                    {col.windows.map((win) => (
                      <div key={win.id} className="neri-window">
                        <div className="neri-window-titlebar" style={{ height: TITLEBAR_HEIGHT }}>
                          <div className="neri-window-titlebar-left">
                            <span className="neri-window-title">{win.title}</span>
                          </div>
                          <div className="neri-window-titlebar-right">
                            <button
                              className="neri-window-btn"
                              onClick={(e) => { e.stopPropagation(); closeWindow(col.id, win.id); }}
                              title="Close window"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="neri-window-content">
                          <NeriWindowContent type={win.type} win={win} />
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
        <div className="neri-hints">
          <span className="neri-hint-pill">Right-drag Scroll</span>
          <span className="neri-hint-pill">←/→ Focus</span>
          <span className="neri-hint-pill">↑/↓ Workspace</span>
          <span className="neri-hint-pill">Ctrl+Enter Open</span>
          <span className="neri-hint-pill">Esc Close</span>
        </div>

        {/* Launcher overlay */}
        {showLauncher && (
          <div className="neri-launcher-backdrop" onClick={() => setShowLauncher(false)}>
            <div className="neri-launcher" onClick={(e) => e.stopPropagation()}>
              <div className="neri-launcher-title">Open Window</div>
              <div className="neri-launcher-grid">
                {WINDOW_TYPE_OPTIONS.map((type) => {
                  const t = WINDOW_TEMPLATES[type];
                  return (
                    <button
                      key={type}
                      className="neri-launcher-item"
                      onClick={() => handleOpenWindow(type)}
                    >
                      <span className="neri-launcher-icon">{WINDOW_ICONS[type]}</span>
                      <span className="neri-launcher-label">{t.title}</span>
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

export default NeriDashboard;
