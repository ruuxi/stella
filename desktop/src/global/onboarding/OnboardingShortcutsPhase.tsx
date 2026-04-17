import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Camera,
  Maximize2,
  MessageSquare,
  Mic,
  Plus,
  Scan,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

type ShortcutsPhaseProps = {
  mode: "global" | "local";
  splitTransitionActive: boolean;
  onFinish: () => void;
};

const TRIGGER_KEYS_BY_PLATFORM: Record<string, { symbol: string; label: string }> = {
  darwin: { symbol: "⌘", label: "Command" },
  win32: { symbol: "Ctrl", label: "Control" },
  linux: { symbol: "Ctrl", label: "Control" },
};

function TriggerHint({ platform }: { platform?: string }) {
  const key = TRIGGER_KEYS_BY_PLATFORM[platform ?? ""] ?? TRIGGER_KEYS_BY_PLATFORM.darwin;
  return (
    <span className="onboarding-keycaps">
      <kbd className="onboarding-keycap" aria-label={key.label}>
        {key.symbol}
      </kbd>
      <span className="onboarding-keycap-plus">+</span>
      <span className="onboarding-keycap" aria-label="Right click">
        Right click
      </span>
    </span>
  );
}

type GlobalActionId = "capture" | "chat" | "add" | "voice";
type MenuActionId = "open-chat";

type Point = { x: number; y: number };

const GLOBAL_ACTIONS: {
  id: GlobalActionId;
  label: string;
  icon: LucideIcon;
  resultTitle: string;
  resultBody: string;
  resultPrompt: string;
}[] = [
  {
    id: "chat",
    label: "Open chat",
    icon: MessageSquare,
    resultTitle: "Quick chat opened",
    resultBody: "A lightweight chat with me opens over what you were already doing.",
    resultPrompt: "Ask Stella about this page...",
  },
  {
    id: "capture",
    label: "Capture region",
    icon: Camera,
    resultTitle: "Captured selection",
    resultBody: "I grab the area you marked and open it as context for the next question.",
    resultPrompt: "Ask about this screenshot...",
  },
  {
    id: "add",
    label: "Add to context",
    icon: Plus,
    resultTitle: "Context added",
    resultBody: "I quietly stage the active window or selection so the next question already knows about it.",
    resultPrompt: "Context staged",
  },
  {
    id: "voice",
    label: "Voice mode",
    icon: Mic,
    resultTitle: "Voice mode listening",
    resultBody: "Talk naturally and I'll keep the current context while transcribing.",
    resultPrompt: "Listening...",
  },
];

const MENU_ACTION: {
  id: MenuActionId;
  resultTitle: string;
  resultBody: string;
} = {
  id: "open-chat",
  resultTitle: "Chat sidebar opened",
  resultBody: "Right-click anywhere inside Stella to open the chat sidebar. If it\u2019s already open, right-click again to close it.",
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 28;
const MENU_PADDING_Y = 6;
const MENU_HEIGHT = GLOBAL_ACTIONS.length * MENU_ITEM_HEIGHT + MENU_PADDING_Y * 2;

export function OnboardingShortcutsPhase({
  mode,
  splitTransitionActive,
  onFinish,
}: ShortcutsPhaseProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<Point>({ x: 0, y: 0 });
  const [menuResult, setMenuResult] = useState<GlobalActionId | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [localResult, setLocalResult] = useState<MenuActionId | null>(null);

  // Capture region selection state (used for the "capture" demo).
  const [capturePhase, setCapturePhase] = useState<"idle" | "ready" | "dragging" | "done">("idle");
  const [captureStart, setCaptureStart] = useState<Point>({ x: 0, y: 0 });
  const selectionRef = useRef<HTMLDivElement | null>(null);

  const platform = window.electronAPI?.platform;

  const globalResultCard = useMemo(
    () => GLOBAL_ACTIONS.find((action) => action.id === menuResult) ?? null,
    [menuResult],
  );
  const localResultCard = localResult ? MENU_ACTION : null;

  // Detect Cmd+Right Click (mac) or Ctrl+Right Click (Windows / Linux) inside
  // the demo surface and pop the mock context menu at the cursor position.
  const handleSurfaceContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const isMac = platform === "darwin";
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
      if (!modifierHeld) {
        // Without the modifier, we don't intercept — let the OS / app handle it.
        return;
      }
      event.preventDefault();
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 8, rect.width - MENU_WIDTH - 8);
      const y = clamp(event.clientY - rect.top, 8, rect.height - MENU_HEIGHT - 8);
      setMenuAnchor({ x, y });
      setMenuOpen(true);
    },
    [platform],
  );

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  const handleMenuItemClick = useCallback((action: GlobalActionId) => {
    setMenuOpen(false);
    setMenuResult(action);
    setCapturePhase(action === "capture" ? "ready" : "idle");
  }, []);

  // Click anywhere outside the open menu to dismiss it.
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const surface = surfaceRef.current;
      if (!surface || !target) return;
      const menu = surface.querySelector('[data-shortcuts-menu="true"]');
      if (menu && menu.contains(target)) return;
      closeMenu();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen, closeMenu]);

  const handleCaptureMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (capturePhase !== "ready" || event.button !== 0) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setCaptureStart(point);
    setCapturePhase("dragging");
  }, [capturePhase]);

  useEffect(() => {
    if (capturePhase !== "dragging") return;

    let rafId = 0;
    let pendingEnd: Point | null = null;

    const handleMove = (event: MouseEvent) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const end = {
        x: clamp(event.clientX - rect.left, 0, rect.width),
        y: clamp(event.clientY - rect.top, 0, rect.height),
      };
      pendingEnd = end;

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (!pendingEnd) return;
          const el = selectionRef.current;
          if (el) {
            const left = Math.min(captureStart.x, pendingEnd.x);
            const top = Math.min(captureStart.y, pendingEnd.y);
            const width = Math.abs(pendingEnd.x - captureStart.x);
            const height = Math.abs(pendingEnd.y - captureStart.y);
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.width = `${width}px`;
            el.style.height = `${height}px`;
          }
        });
      }
    };

    const handleUp = () => {
      setCapturePhase("done");
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [capturePhase, captureStart]);

  const handleMenuContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setSidebarOpen((prev) => {
      const next = !prev;
      if (next) {
        setLocalResult("open-chat");
      }
      return next;
    });
  }, []);

  const finishVisible = mode === "global" ? menuResult !== null : localResult !== null;

  return (
    <div className="onboarding-step-content onboarding-shortcuts-phase">
      <p className="onboarding-step-desc">
        {mode === "global"
          ? "Trigger Stella from anywhere by holding the modifier key and right-clicking. Pick an option to preview what happens."
          : "Inside Stella, the hold menu gives you fast context-aware actions on cards, notes, and other app content."}
      </p>

      <div className="onboarding-shortcuts-grid">
        {mode === "global" ? (
          <section className="onboarding-shortcut-demo">
          <div className="onboarding-shortcut-demo__copy">
            <span className="onboarding-step-label">How to use Stella on your computer</span>
          </div>

          <div
            ref={surfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--menu"
            data-testid="shortcuts-global-surface"
            data-result={menuResult ?? undefined}
            onContextMenu={handleSurfaceContextMenu}
          >
            {!menuOpen && !menuResult && (
              <div className="onboarding-shortcut-surface__instruction">
                <h3 className="onboarding-shortcut-demo__title">
                  <TriggerHint platform={platform} /> anywhere to open the menu.
                </h3>
              </div>
            )}
            <div className="onboarding-shortcut-scene onboarding-shortcut-scene--article">
              <div className="onboarding-shortcut-window onboarding-shortcut-window--bg">
                <div className="onboarding-shortcut-window__bar">
                  <span />
                  <span />
                  <span />
                  <strong>Notes</strong>
                </div>
              </div>

              <div className="onboarding-shortcut-taskbar">
                <span /><span /><span /><span />
              </div>

              <div className="onboarding-shortcut-window onboarding-shortcut-window--main">
                <div className="onboarding-shortcut-window__bar">
                  <span />
                  <span />
                  <span />
                  <strong>Research Report</strong>
                </div>
                <div className="onboarding-shortcut-window__body">
                  <div className="mock-report">
                    <span className="mock-report__eyebrow">Q2 2026 Analysis</span>
                    <h4 className="mock-report__title">Market Performance Overview</h4>
                    <p className="mock-report__text">
                      Revenue increased 23% year-over-year, driven by strong enterprise
                      adoption across three core verticals. The mid-market segment showed
                      early traction with 14% quarterly growth.
                    </p>
                    <div className="mock-report__cards">
                      <div className="mock-report__card">
                        <span className="mock-report__card-label">Revenue by quarter</span>
                        <svg className="mock-report__chart" viewBox="0 0 160 60" fill="none">
                          <rect x="8" y="38" width="16" height="22" rx="3" fill="oklch(0.72 0.14 235 / 0.25)" />
                          <rect x="32" y="28" width="16" height="32" rx="3" fill="oklch(0.72 0.14 235 / 0.35)" />
                          <rect x="56" y="20" width="16" height="40" rx="3" fill="oklch(0.72 0.14 235 / 0.5)" />
                          <rect x="80" y="10" width="16" height="50" rx="3" fill="oklch(0.62 0.18 235 / 0.7)" />
                          <rect x="104" y="4" width="16" height="56" rx="3" fill="oklch(0.62 0.18 235 / 0.85)" />
                          <line x1="4" y1="59" x2="156" y2="59" stroke="oklch(0.5 0 0 / 0.12)" strokeWidth="1" />
                        </svg>
                      </div>
                      <div className="mock-report__card">
                        <span className="mock-report__card-label">Key metrics</span>
                        <div className="mock-report__metrics">
                          <div><span>ARR</span><strong>$4.2M</strong></div>
                          <div><span>Growth</span><strong>+23%</strong></div>
                          <div><span>NPS</span><strong>72</strong></div>
                        </div>
                      </div>
                    </div>
                    <h5 className="mock-report__subtitle">Pipeline &amp; Outlook</h5>
                    <p className="mock-report__text">
                      Enterprise pipeline expanded to 340 qualified opportunities,
                      up from 218 in the prior quarter. Win rates held steady at
                      32%, with average deal size increasing 11% to $48K.
                    </p>
                    <p className="mock-report__text mock-report__text--sm">
                      Regional breakdown shows EMEA leading at 41% of new bookings,
                      followed by NA at 38% and APAC at 21%. The APAC segment
                      represents the fastest-growing region quarter-over-quarter.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Per-action visual effects */}
            <div
              className="onboarding-shortcut-effects"
              aria-hidden="true"
              data-capture-phase={capturePhase !== "idle" ? capturePhase : undefined}
              onMouseDown={handleCaptureMouseDown}
            >
              {/* Capture: interactive region selection → vacuum → mini chat */}
              <div className="scene-effect scene-effect--capture">
                {capturePhase === "ready" && (
                  <div className="scene-effect__capture-dim" />
                )}
                {capturePhase === "ready" && (
                  <div className="scene-effect__capture-hint">
                    <Scan size={13} />
                    <span>Click and drag to select a region</span>
                  </div>
                )}
                {capturePhase === "dragging" && (
                  <div
                    ref={selectionRef}
                    className="scene-effect__capture-selection"
                  />
                )}
                {capturePhase === "done" && (
                  <div className="scene-effect__capture-chat">
                    <div className="scene-effect__mini-shell">
                      <div className="scene-effect__mini-shell-bar">
                        <span>Stella</span>
                        <div className="scene-effect__mini-shell-actions">
                          <Maximize2 size={11} />
                          <X size={11} />
                        </div>
                      </div>
                      <div className="scene-effect__mini-shell-messages">
                        <div className="scene-effect__capture-screenshot">
                          <Camera size={14} />
                          <span>Screenshot attached</span>
                        </div>
                        <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                          I can see the chart from your report. What would you like to know about the revenue trends?
                        </div>
                      </div>
                      <div className="scene-effect__mini-shell-composer">
                        <span>Ask about this screenshot...</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Chat: mini shell widget */}
              <div className="scene-effect scene-effect--chat">
                <div className="scene-effect__mini-shell">
                  <div className="scene-effect__mini-shell-bar">
                    <span>Stella</span>
                    <div className="scene-effect__mini-shell-actions">
                      <Maximize2 size={11} />
                      <X size={11} />
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-messages">
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      I can see your research report. What would you like to know?
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--user">
                      Summarize the key findings
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      The report highlights three main findings: revenue grew 23% YoY, enterprise is the leading segment, and the Q3 pipeline needs expansion.
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-composer">
                    <span>Ask a follow-up...</span>
                  </div>
                </div>
              </div>

              {/* Add: subtle "context staged" badge */}
              <div className="scene-effect scene-effect--add">
                <div className="scene-effect__add-badge">
                  <Plus size={14} />
                  <span>Context staged</span>
                </div>
              </div>

              {/* Voice: pulsing mic indicator */}
              <div className="scene-effect scene-effect--voice">
                <div className="scene-effect__voice-rings">
                  <div className="scene-effect__voice-ring" />
                  <div className="scene-effect__voice-ring" />
                  <div className="scene-effect__voice-ring" />
                  <div className="scene-effect__voice-mic">
                    <Mic size={18} />
                  </div>
                </div>
                <span className="scene-effect__voice-label">Listening...</span>
              </div>
            </div>

            <div className="onboarding-shortcut-hint">
              Try it here
            </div>

            {menuOpen ? (
              <div
                data-shortcuts-menu="true"
                data-testid="shortcuts-menu-overlay"
                className="onboarding-shortcut-context-menu"
                style={{
                  left: menuAnchor.x,
                  top: menuAnchor.y,
                  width: MENU_WIDTH,
                }}
              >
                {GLOBAL_ACTIONS.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className="onboarding-shortcut-context-menu__item"
                      onClick={() => handleMenuItemClick(action.id)}
                    >
                      <Icon size={14} />
                      <span>{action.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

          </div>

          </section>
        ) : (
          <section className="onboarding-shortcut-demo">
          <div className="onboarding-shortcut-demo__copy">
            <span className="onboarding-step-label">How to use Stella inside the app</span>
            <h3 className="onboarding-shortcut-demo__title">Right-click anywhere to open chat.</h3>
          </div>

          <div
            ref={menuSurfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--menu"
            data-testid="shortcuts-menu-surface"
            data-menu-result={localResult ?? undefined}
            onContextMenu={handleMenuContextMenu}
          >
            <div className="onboarding-shortcut-app">
              <div className="onboarding-shortcut-app__sidebar">
                <div className="onboarding-shortcut-app__sidebar-logo">S</div>
                <div className="onboarding-shortcut-app__sidebar-nav">
                  <div data-active><MessageSquare size={13} /></div>
                  <div><Search size={13} /></div>
                  <div><Sparkles size={13} /></div>
                </div>
              </div>
              <div className="onboarding-shortcut-app__content">
                <div className="onboarding-shortcut-app__header">
                  <strong>Project notes</strong>
                </div>
                <div className="onboarding-shortcut-context-card">
                  <div className="onboarding-shortcut-context-card__eyebrow">
                    Sprint planning
                  </div>
                  <div className="onboarding-shortcut-context-card__title">
                    Q2 launch prep
                  </div>
                  <p className="onboarding-shortcut-context-card__text">
                    Finalize feature scope for the June release. Coordinate with
                    design on the new dashboard layout and confirm API deadlines
                    with the backend team.
                  </p>
                  <div className="onboarding-shortcut-context-card__tags">
                    <span>Design</span>
                    <span>Backend</span>
                    <span>June 15</span>
                  </div>
                </div>
                <div className="onboarding-shortcut-context-card onboarding-shortcut-context-card--secondary">
                  <div className="onboarding-shortcut-context-card__eyebrow">Backlog</div>
                  <div className="onboarding-shortcut-context-card__title">User onboarding flow</div>
                  <p className="onboarding-shortcut-context-card__text">
                    Redesign the first-run experience based on user testing feedback.
                  </p>
                </div>
              </div>

              {sidebarOpen && (
                <div className="onboarding-shortcut-sidebar-demo">
                  <div className="onboarding-shortcut-sidebar-demo__header">
                    <span>Stella</span>
                    <X size={11} />
                  </div>
                  <div className="onboarding-shortcut-sidebar-demo__messages">
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      I can see your sprint planning card. What would you like to know?
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--user">
                      Break down the remaining tasks
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      Here are the key tasks before the June 15 deadline: finalize dashboard layout, confirm API deadlines, and coordinate with design.
                    </div>
                  </div>
                  <div className="onboarding-shortcut-sidebar-demo__composer">
                    <span>Ask Stella...</span>
                  </div>
                </div>
              )}
            </div>

            <div className="onboarding-shortcut-hint onboarding-shortcut-hint--left">
              Try it here
            </div>
          </div>
          </section>
        )}
      </div>

      <div
        className="onboarding-shortcut-result-description"
        data-visible={mode === "global" ? (globalResultCard ? "true" : undefined) : (localResultCard ? "true" : undefined)}
      >
        {mode === "global" && globalResultCard ? (
          <>
            <strong>{globalResultCard.resultTitle}</strong>
            <span>{globalResultCard.resultBody}</span>
          </>
        ) : null}
        {mode === "local" && localResultCard ? (
          <>
            <strong>{localResultCard.resultTitle}</strong>
            <span>{localResultCard.resultBody}</span>
          </>
        ) : null}
      </div>

      <button
        className="onboarding-confirm"
        data-visible={finishVisible}
        disabled={splitTransitionActive || !finishVisible}
        onClick={onFinish}
      >
        {mode === "global" ? "Continue" : "Finish"}
      </button>
    </div>
  );
}
