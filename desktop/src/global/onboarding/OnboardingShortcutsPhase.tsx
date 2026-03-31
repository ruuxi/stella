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
  MessageCircle,
  MessageSquare,
  Mic,
  Scan,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { getPlatform } from "@/platform/electron/platform";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";

type ShortcutsPhaseProps = {
  mode: "global" | "local";
  splitTransitionActive: boolean;
  onFinish: () => void;
};

type RadialActionId = "capture" | "chat" | "full" | "voice" | "auto" | "dismiss";
type MenuActionId = "ask-anything" | "ask-about-this" | "close";

type Point = {
  x: number;
  y: number;
};

const RADIAL_SIZE = 280;
const RADIAL_CENTER = RADIAL_SIZE / 2;
const RADIAL_INNER_RADIUS = 40;
const RADIAL_OUTER_RADIUS = 125;
const RADIAL_DEAD_ZONE_RADIUS = 30;
const RADIAL_CENTER_BG_RADIUS = RADIAL_INNER_RADIUS - 5;
const RADIAL_WEDGE_ANGLE = 72;
const SURFACE_PADDING = 28;
const MENU_WIDTH = 264;
const MENU_HEIGHT = 214;

const RADIAL_ACTIONS: {
  id: Exclude<RadialActionId, "dismiss">;
  label: string;
  icon: LucideIcon;
  resultTitle: string;
  resultBody: string;
  resultPrompt: string;
}[] = [
  {
    id: "capture",
    label: "Capture",
    icon: Camera,
    resultTitle: "Captured selection",
    resultBody: "Stella grabs the area you marked and opens it as context for the next question.",
    resultPrompt: "Ask about this screenshot...",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    resultTitle: "Quick chat opened",
    resultBody: "A lightweight Stella chat opens over what you were already doing.",
    resultPrompt: "Ask Stella about this page...",
  },
  {
    id: "full",
    label: "Full",
    icon: Maximize2,
    resultTitle: "Full Stella opened",
    resultBody: "Your full workspace comes forward when you want the bigger canvas.",
    resultPrompt: "Continue in full workspace",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    resultTitle: "Voice mode listening",
    resultBody: "Talk naturally and Stella keeps the current context while transcribing.",
    resultPrompt: "Listening...",
  },
  {
    id: "auto",
    label: "Auto",
    icon: Sparkles,
    resultTitle: "Auto summary ready",
    resultBody: "Stella reads the current surface and brings back a fast summary with key takeaways.",
    resultPrompt: "3 key points extracted",
  },
];

const MENU_ACTIONS: {
  id: MenuActionId;
  label: string;
  icon: LucideIcon;
  resultTitle: string;
  resultBody: string;
}[] = [
  {
    id: "ask-anything",
    label: "Ask Stella anything",
    icon: MessageCircle,
    resultTitle: "Floating chat opened",
    resultBody: "Use this when you just want Stella without attaching any nearby context.",
  },
  {
    id: "ask-about-this",
    label: "Ask about this card",
    icon: Scan,
    resultTitle: "Context attached",
    resultBody: "Stella captures the thing you hovered and opens chat with that content already in view.",
  },
  {
    id: "close",
    label: "Close",
    icon: X,
    resultTitle: "Quick chat closed",
    resultBody: "If Stella is already open, this dismisses it right from the hold menu.",
  },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const createWedgePath = (startAngle: number, endAngle: number): string => {
  const startRad = (startAngle - 90) * (Math.PI / 180);
  const endRad = (endAngle - 90) * (Math.PI / 180);

  const x1 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.cos(startRad);
  const y1 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.sin(startRad);
  const x2 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.cos(startRad);
  const y2 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.sin(startRad);
  const x3 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.cos(endRad);
  const y3 = RADIAL_CENTER + RADIAL_OUTER_RADIUS * Math.sin(endRad);
  const x4 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.cos(endRad);
  const y4 = RADIAL_CENTER + RADIAL_INNER_RADIUS * Math.sin(endRad);

  return `
    M ${x1} ${y1}
    L ${x2} ${y2}
    A ${RADIAL_OUTER_RADIUS} ${RADIAL_OUTER_RADIUS} 0 0 1 ${x3} ${y3}
    L ${x4} ${y4}
    A ${RADIAL_INNER_RADIUS} ${RADIAL_INNER_RADIUS} 0 0 0 ${x1} ${y1}
    Z
  `;
};

const getWedgePosition = (index: number) => {
  const midAngle =
    (index * RADIAL_WEDGE_ANGLE + RADIAL_WEDGE_ANGLE / 2 - 90) *
    (Math.PI / 180);
  const contentRadius = (RADIAL_INNER_RADIUS + RADIAL_OUTER_RADIUS) / 2;
  return {
    x: RADIAL_CENTER + contentRadius * Math.cos(midAngle),
    y: RADIAL_CENTER + contentRadius * Math.sin(midAngle),
  };
};

const RADIAL_LAYOUT = RADIAL_ACTIONS.map((action, index) => ({
  ...action,
  path: createWedgePath(index * RADIAL_WEDGE_ANGLE, (index + 1) * RADIAL_WEDGE_ANGLE),
  position: getWedgePosition(index),
}));

const getRadialAction = (
  point: Point,
  center: Point,
): RadialActionId => {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < RADIAL_DEAD_ZONE_RADIUS) {
    return "dismiss";
  }

  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  if (angle < 0) {
    angle += 360;
  }
  angle = (angle + 90) % 360;

  const wedgeIndex = Math.floor(angle / RADIAL_WEDGE_ANGLE);
  return RADIAL_ACTIONS[wedgeIndex]?.id ?? "dismiss";
};

export function OnboardingShortcutsPhase({
  mode,
  splitTransitionActive,
  onFinish,
}: ShortcutsPhaseProps) {
  const platform = getPlatform();
  const radialTriggerLabel =
    platform === "darwin" ? "Cmd + right click" : "Ctrl + right click";
  const radialSurfaceRef = useRef<HTMLDivElement | null>(null);
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [radialOpen, setRadialOpen] = useState(false);
  const [radialAnchor, setRadialAnchor] = useState<Point>({ x: 0, y: 0 });
  const [radialSelected, setRadialSelected] = useState<RadialActionId>("dismiss");
  const [radialResult, setRadialResult] = useState<Exclude<RadialActionId, "dismiss"> | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<Point>({ x: 0, y: 0 });
  const [menuHovered, setMenuHovered] = useState<MenuActionId | null>(null);
  const [menuResult, setMenuResult] = useState<MenuActionId | null>(null);

  // Capture region selection state
  const [capturePhase, setCapturePhase] = useState<"idle" | "ready" | "dragging" | "done">("idle");
  const [captureStart, setCaptureStart] = useState<Point>({ x: 0, y: 0 });
  const [captureEnd, setCaptureEnd] = useState<Point>({ x: 0, y: 0 });

  const gestureModeRef = useRef<"idle" | "radial" | "menu">("idle");

  const radialResultCard = useMemo(
    () => RADIAL_ACTIONS.find((action) => action.id === radialResult) ?? null,
    [radialResult],
  );
  const menuResultCard = useMemo(
    () => MENU_ACTIONS.find((action) => action.id === menuResult) ?? null,
    [menuResult],
  );

  const closeGesture = useCallback(() => {
    gestureModeRef.current = "idle";
    setRadialOpen(false);
    setMenuOpen(false);
    setMenuHovered(null);
    setRadialSelected("dismiss");
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (gestureModeRef.current === "radial") {
        const surface = radialSurfaceRef.current;
        if (!surface) {
          return;
        }

        const rect = surface.getBoundingClientRect();
        const center = {
          x: rect.left + radialAnchor.x,
          y: rect.top + radialAnchor.y,
        };

        setRadialSelected(
          getRadialAction({ x: event.clientX, y: event.clientY }, center),
        );
        return;
      }

      if (gestureModeRef.current === "menu") {
        const menu = menuRef.current;
        if (!menu) {
          return;
        }

        const items = menu.querySelectorAll<HTMLElement>("[data-menu-id]");
        let hoveredId: MenuActionId | null = null;
        for (const item of items) {
          const rect = item.getBoundingClientRect();
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            hoveredId = item.dataset.menuId as MenuActionId;
            break;
          }
        }

        setMenuHovered(hoveredId);
      }
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 2) {
        return;
      }

      if (gestureModeRef.current === "radial") {
        if (radialSelected !== "dismiss") {
          setRadialResult(radialSelected);
        }
      } else if (gestureModeRef.current === "menu") {
        if (menuHovered) {
          setMenuResult(menuHovered);
        }
      }

      closeGesture();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeGesture();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeGesture, menuHovered, radialAnchor.x, radialAnchor.y, radialSelected]);

  // Activate capture mode when "capture" is selected from radial
  useEffect(() => {
    if (radialResult === "capture" && capturePhase === "idle") {
      setCapturePhase("ready");
    } else if (radialResult !== "capture") {
      setCapturePhase("idle");
    }
  }, [radialResult, capturePhase]);

  const handleCaptureMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (capturePhase !== "ready" || event.button !== 0) return;
    const surface = radialSurfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setCaptureStart(point);
    setCaptureEnd(point);
    setCapturePhase("dragging");
  }, [capturePhase]);

  useEffect(() => {
    if (capturePhase !== "dragging") return;

    const handleMove = (event: MouseEvent) => {
      const surface = radialSurfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      setCaptureEnd({
        x: clamp(event.clientX - rect.left, 0, rect.width),
        y: clamp(event.clientY - rect.top, 0, rect.height),
      });
    };

    const handleUp = () => {
      setCapturePhase("done");
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [capturePhase]);

  const captureRect = useMemo(() => {
    if (capturePhase !== "dragging" && capturePhase !== "done") return null;
    return {
      left: Math.min(captureStart.x, captureEnd.x),
      top: Math.min(captureStart.y, captureEnd.y),
      width: Math.abs(captureEnd.x - captureStart.x),
      height: Math.abs(captureEnd.y - captureStart.y),
    };
  }, [capturePhase, captureStart, captureEnd]);

  const handleRadialMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) {
      return;
    }

    event.preventDefault();

    const surface = radialSurfaceRef.current;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    const localX = clamp(
      event.clientX - rect.left,
      SURFACE_PADDING + RADIAL_CENTER,
      rect.width - SURFACE_PADDING - RADIAL_CENTER,
    );
    const localY = clamp(
      event.clientY - rect.top,
      SURFACE_PADDING + RADIAL_CENTER,
      rect.height - SURFACE_PADDING - RADIAL_CENTER,
    );

    gestureModeRef.current = "radial";
    setRadialAnchor({ x: localX, y: localY });
    setRadialSelected("dismiss");
    setRadialResult(null);
    setRadialOpen(true);
  }, []);

  const handleMenuMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) {
      return;
    }

    event.preventDefault();

    const surface = menuSurfaceRef.current;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    const localX = clamp(
      event.clientX - rect.left + 12,
      14,
      rect.width - MENU_WIDTH - 14,
    );
    const localY = clamp(
      event.clientY - rect.top - MENU_HEIGHT / 2,
      14,
      rect.height - MENU_HEIGHT - 14,
    );

    gestureModeRef.current = "menu";
    setMenuPosition({ x: localX, y: localY });
    setMenuHovered(null);
    setMenuResult(null);
    setMenuOpen(true);
  }, []);

  const finishVisible = mode === "global" ? radialResult !== null : menuResult !== null;

  return (
    <div className="onboarding-step-content onboarding-shortcuts-phase">
      <p className="onboarding-step-desc">
        {mode === "global"
          ? "Trigger Stella from anywhere with the system quick gesture, then release on an option to preview what happens."
          : "Inside Stella, the hold menu gives you fast context-aware actions on cards, notes, and other app content."}
      </p>

      <div className="onboarding-shortcuts-grid">
        {mode === "global" ? (
          <section className="onboarding-shortcut-demo">
          <div className="onboarding-shortcut-demo__copy">
            <span className="onboarding-step-label">How to use Stella on your computer</span>
            <h3 className="onboarding-shortcut-demo__title">{radialTriggerLabel} for the radial dial</h3>
            <p className="onboarding-step-subdesc">
              Hold the modifier, drag through the wedge you want, then release.
              This mirrors Stella&apos;s system-level quick gesture.
            </p>
          </div>

          <div
            ref={radialSurfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--radial"
            data-testid="shortcuts-radial-surface"
            data-result={radialResult ?? undefined}
            onMouseDown={handleRadialMouseDown}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="onboarding-shortcut-scene onboarding-shortcut-scene--article">
              {/* Background window for depth */}
              <div className="onboarding-shortcut-window onboarding-shortcut-window--bg">
                <div className="onboarding-shortcut-window__bar">
                  <span />
                  <span />
                  <span />
                  <strong>Notes</strong>
                </div>
              </div>

              {/* Desktop taskbar */}
              <div className="onboarding-shortcut-taskbar">
                <span /><span /><span /><span />
              </div>

              {/* Main window */}
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
                {(capturePhase === "ready" || capturePhase === "dragging") && (
                  <div className="scene-effect__capture-dim" />
                )}
                {capturePhase === "ready" && (
                  <div className="scene-effect__capture-hint">
                    <Scan size={13} />
                    <span>Click and drag to select a region</span>
                  </div>
                )}
                {captureRect && capturePhase === "dragging" && (
                  <div
                    className="scene-effect__capture-selection"
                    style={{
                      left: captureRect.left,
                      top: captureRect.top,
                      width: captureRect.width,
                      height: captureRect.height,
                    }}
                  />
                )}
                {capturePhase === "done" && captureRect && (
                  <>
                    <div
                      className="scene-effect__capture-vacuum"
                      style={{
                        left: captureRect.left,
                        top: captureRect.top,
                        width: captureRect.width,
                        height: captureRect.height,
                      }}
                    />
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
                  </>
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

              {/* Full: realistic workspace */}
              <div className="scene-effect scene-effect--full">
                <div className="scene-effect__workspace">
                  <div className="scene-effect__workspace-sidebar">
                    <div className="scene-effect__workspace-logo">S</div>
                    <div className="scene-effect__workspace-nav">
                      <div data-active><MessageSquare size={12} /><span>Chat</span></div>
                      <div><Search size={12} /><span>Browse</span></div>
                      <div><Sparkles size={12} /><span>Store</span></div>
                    </div>
                  </div>
                  <div className="scene-effect__workspace-content">
                    <div className="scene-effect__workspace-chat">
                      <div className="scene-effect__workspace-msg scene-effect__workspace-msg--user">
                        Help me analyze this report
                      </div>
                      <div className="scene-effect__workspace-msg scene-effect__workspace-msg--assistant">
                        <div className="onboarding-shortcut-text-line" />
                        <div className="onboarding-shortcut-text-line" />
                        <div className="onboarding-shortcut-text-line onboarding-shortcut-text-line--short" />
                      </div>
                    </div>
                    <div className="scene-effect__workspace-composer-bar">
                      <span>Message Stella...</span>
                    </div>
                  </div>
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

              {/* Auto: slide-in panel with summary */}
              <div className="scene-effect scene-effect--auto">
                <div className="scene-effect__auto-panel">
                  <div className="scene-effect__auto-panel-header">
                    <Sparkles size={12} />
                    <span>Auto summary</span>
                    <X size={12} className="scene-effect__auto-panel-close" />
                  </div>
                  <div className="scene-effect__auto-panel-body">
                    <div className="scene-effect__auto-section">
                      <div className="scene-effect__auto-section-title">Key findings</div>
                      <p>Revenue grew <strong>23% YoY</strong> driven primarily by enterprise expansion. The top performing segment exceeded targets by 18%.</p>
                    </div>
                    <div className="scene-effect__auto-section">
                      <div className="scene-effect__auto-section-title">Action items</div>
                      <ul>
                        <li>Expand Q3 pipeline capacity</li>
                        <li>Review enterprise pricing tiers</li>
                        <li>Schedule follow-up with sales</li>
                      </ul>
                    </div>
                    <div className="scene-effect__auto-section">
                      <div className="scene-effect__auto-section-title">Risk factors</div>
                      <p>Market volatility in adjacent segments may impact projected growth in Q4.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="onboarding-shortcut-hint">
              Hold {radialTriggerLabel}, drag, release
            </div>

            {radialOpen ? (
              <div className="onboarding-shortcut-radial-backdrop">
                <div
                  className="onboarding-shortcut-radial"
                  data-testid="shortcuts-radial-overlay"
                  style={{
                    left: radialAnchor.x,
                    top: radialAnchor.y,
                  }}
                >
                  <div className="radial-dial-container">
                    <div className="onboarding-shortcut-radial-glow" />
                    <div className="radial-dial-frame radial-dial-frame--visible">
                      <svg
                        width={RADIAL_SIZE}
                        height={RADIAL_SIZE}
                        viewBox={`0 0 ${RADIAL_SIZE} ${RADIAL_SIZE}`}
                        className="radial-dial"
                      >
                        {RADIAL_LAYOUT.map((action) => {
                          const isSelected = radialSelected === action.id;
                          return (
                            <path
                              key={action.id}
                              d={action.path}
                              className="onboarding-shortcut-radial__wedge"
                              data-selected={isSelected || undefined}
                            />
                          );
                        })}
                        <circle
                          cx={RADIAL_CENTER}
                          cy={RADIAL_CENTER}
                          r={RADIAL_CENTER_BG_RADIUS}
                          className="onboarding-shortcut-radial__center"
                        />
                      </svg>

                      {RADIAL_LAYOUT.map((action) => {
                        const Icon = action.icon;
                        const isSelected = radialSelected === action.id;

                        return (
                          <div
                            key={action.id}
                            className="radial-wedge-content onboarding-shortcut-radial__content"
                            data-selected={isSelected || undefined}
                            style={{
                              left: action.position.x,
                              top: action.position.y,
                            }}
                          >
                            <Icon width={16} height={16} />
                            <span className="radial-wedge-label">{action.label}</span>
                          </div>
                        );
                      })}

                      <div className="radial-center-stella-animation onboarding-shortcut-radial__stella">
                        <StellaAnimation
                          width={20}
                          height={20}
                          initialBirthProgress={1}
                          maxDpr={1}
                          frameSkip={1}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

          </div>

          </section>
        ) : (
          <section className="onboarding-shortcut-demo">
          <div className="onboarding-shortcut-demo__copy">
            <span className="onboarding-step-label">How to use Stella inside the app</span>
            <h3 className="onboarding-shortcut-demo__title">Right-click hold for the context menu</h3>
            <p className="onboarding-step-subdesc">
              Hold right-click on any card, note, or content inside Stella to
              get quick actions without leaving what you&apos;re doing.
            </p>
          </div>

          <div
            ref={menuSurfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--menu"
            data-testid="shortcuts-menu-surface"
            data-menu-result={menuResult ?? undefined}
            onMouseDown={handleMenuMouseDown}
            onContextMenu={(event) => event.preventDefault()}
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
                <div
                  className="onboarding-shortcut-context-card"
                  data-highlighted={
                    menuOpen && menuHovered === "ask-about-this" ? "true" : undefined
                  }
                >
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
            </div>

            <div className="onboarding-shortcut-hint onboarding-shortcut-hint--left">
              Hold right click over a card
            </div>

            {menuOpen ? (
              <div
                ref={menuRef}
                className="onboarding-shortcut-menu"
                data-testid="shortcuts-menu"
                style={{
                  left: menuPosition.x,
                  top: menuPosition.y,
                }}
              >
                {MENU_ACTIONS.map((action) => {
                  const Icon = action.icon;
                  const isHovered = menuHovered === action.id;

                  return (
                    <div
                      key={action.id}
                      data-menu-id={action.id}
                      className="onboarding-shortcut-menu__item"
                      data-hovered={isHovered || undefined}
                    >
                      <span className="onboarding-shortcut-menu__icon">
                        <Icon size={18} strokeWidth={1.8} />
                      </span>
                      <span className="onboarding-shortcut-menu__label">
                        {action.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Per-action visual effects */}
            <div className="onboarding-shortcut-menu-effects" aria-hidden="true">
              {/* Ask anything: floating orb chat */}
              <div className="menu-effect menu-effect--ask-anything">
                <div className="scene-effect__mini-shell menu-effect__shell">
                  <div className="scene-effect__mini-shell-bar">
                    <span>Stella</span>
                    <div className="scene-effect__mini-shell-actions">
                      <Maximize2 size={11} />
                      <X size={11} />
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-messages">
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      What can I help you with?
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-composer">
                    <span>Ask anything...</span>
                  </div>
                </div>
              </div>

              {/* Ask about this: chat with context */}
              <div className="menu-effect menu-effect--ask-about-this">
                <div className="scene-effect__mini-shell menu-effect__shell">
                  <div className="scene-effect__mini-shell-bar">
                    <span>Stella</span>
                    <div className="scene-effect__mini-shell-actions">
                      <Maximize2 size={11} />
                      <X size={11} />
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-messages">
                    <div className="menu-effect__context-badge">
                      <Scan size={11} />
                      <span>Q2 launch prep</span>
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      I can see your sprint planning card. The June 15 deadline is
                      tight — want me to help break down the remaining tasks?
                    </div>
                  </div>
                  <div className="scene-effect__mini-shell-composer">
                    <span>Ask about this card...</span>
                  </div>
                </div>
              </div>

              {/* Close: dismiss animation */}
              <div className="menu-effect menu-effect--close">
                <div className="menu-effect__dismiss-indicator">
                  <X size={16} />
                  <span>Dismissed</span>
                </div>
              </div>
            </div>
          </div>
          </section>
        )}
      </div>

      <div
        className="onboarding-shortcut-result-description"
        data-visible={mode === "global" ? (radialResultCard ? "true" : undefined) : (menuResultCard ? "true" : undefined)}
      >
        {mode === "global" && radialResultCard ? (
          <>
            <strong>{radialResultCard.resultTitle}</strong>
            <span>{radialResultCard.resultBody}</span>
          </>
        ) : null}
        {mode === "local" && menuResultCard ? (
          <>
            <strong>{menuResultCard.resultTitle}</strong>
            <span>{menuResultCard.resultBody}</span>
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
