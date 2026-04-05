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
  Scan,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_RADIAL_TRIGGER_CODE,
  getRadialTriggerLabel,
} from "@/shared/lib/radial-trigger";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";

type ShortcutsPhaseProps = {
  mode: "global" | "local";
  splitTransitionActive: boolean;
  onFinish: () => void;
};

const TRIGGER_KEYS_BY_PLATFORM: Record<string, { symbol: string; label: string }[]> = {
  darwin: [
    { symbol: "⌥", label: "Option" },
    { symbol: "⌘", label: "Command" },
  ],
  win32: [
    { symbol: "Alt", label: "Alt" },
    { symbol: "⊞", label: "Win" },
  ],
  linux: [
    { symbol: "Alt", label: "Alt" },
    { symbol: "Super", label: "Super" },
  ],
};

function TriggerKeyCaps({ platform }: { platform?: string }) {
  const keys = TRIGGER_KEYS_BY_PLATFORM[platform ?? ""] ?? TRIGGER_KEYS_BY_PLATFORM.darwin;
  return (
    <span className="onboarding-keycaps">
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="onboarding-keycap-plus">+</span>}
          <kbd className="onboarding-keycap" aria-label={key.label}>{key.symbol}</kbd>
        </span>
      ))}
    </span>
  );
}

type RadialActionId = "capture" | "chat" | "full" | "voice" | "auto" | "dismiss";
type MenuActionId = "open-chat";

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
    resultBody: "I grab the area you marked and open it as context for the next question.",
    resultPrompt: "Ask about this screenshot...",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    resultTitle: "Quick chat opened",
    resultBody: "A lightweight chat with me opens over what you were already doing.",
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
    resultBody: "Talk naturally and I'll keep the current context while transcribing.",
    resultPrompt: "Listening...",
  },
  {
    id: "auto",
    label: "Auto",
    icon: Sparkles,
    resultTitle: "Auto summary ready",
    resultBody: "I read the current surface and bring back a fast summary with key takeaways.",
    resultPrompt: "3 key points extracted",
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
  const platform = window.electronAPI?.platform;
  const radialTriggerLabel = getRadialTriggerLabel(
    DEFAULT_RADIAL_TRIGGER_CODE,
    platform,
  );
  const radialSurfaceRef = useRef<HTMLDivElement | null>(null);
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);

  const [radialOpen, setRadialOpen] = useState(false);
  const [radialAnchor, setRadialAnchor] = useState<Point>({ x: 0, y: 0 });
  const [radialSelected, setRadialSelected] = useState<RadialActionId>("dismiss");
  const [radialResult, setRadialResult] = useState<Exclude<RadialActionId, "dismiss"> | null>(null);

  const [menuSidebarOpen, setMenuSidebarOpen] = useState(false);
  const [menuResult, setMenuResult] = useState<MenuActionId | null>(null);

  // Capture region selection state
  const [capturePhase, setCapturePhase] = useState<"idle" | "ready" | "dragging" | "done">("idle");
  const [captureStart, setCaptureStart] = useState<Point>({ x: 0, y: 0 });
  const [captureEnd, setCaptureEnd] = useState<Point>({ x: 0, y: 0 });

  const gestureModeRef = useRef<"idle" | "radial">("idle");
  const triggerKeysHeld = useRef(false);

  const radialResultCard = useMemo(
    () => RADIAL_ACTIONS.find((action) => action.id === radialResult) ?? null,
    [radialResult],
  );
  const menuResultCard = menuResult ? MENU_ACTION : null;

  const closeGesture = useCallback(() => {
    gestureModeRef.current = "idle";
    triggerKeysHeld.current = false;
    setRadialOpen(false);
    setRadialSelected("dismiss");
  }, []);

  // Check if the chord keys (Option+Cmd / Alt+Win) are both held
  const isTriggerChord = useCallback((event: KeyboardEvent) => {
    const platform = window.electronAPI?.platform;
    if (platform === "darwin") {
      return event.altKey && event.metaKey;
    }
    // win32 / linux: Alt + Meta(Win)
    return event.altKey && event.metaKey;
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
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeGesture();
        return;
      }

      if (!triggerKeysHeld.current && isTriggerChord(event)) {
        triggerKeysHeld.current = true;

        // Open radial at center of the surface
        const surface = radialSurfaceRef.current;
        if (!surface) return;

        const rect = surface.getBoundingClientRect();
        const localX = rect.width / 2;
        const localY = rect.height / 2;

        gestureModeRef.current = "radial";
        setRadialAnchor({ x: localX, y: localY });
        setRadialSelected("dismiss");
        setRadialResult(null);
        setCapturePhase("idle");
        setRadialOpen(true);
      }
    };

    const handleKeyUp = () => {
      if (!triggerKeysHeld.current) return;

      if (gestureModeRef.current === "radial") {
        if (radialSelected !== "dismiss") {
          setRadialResult(radialSelected);
          setCapturePhase(radialSelected === "capture" ? "ready" : "idle");
        }
      }

      closeGesture();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [closeGesture, isTriggerChord, radialAnchor.x, radialAnchor.y, radialSelected]);

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

  const handleMenuContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setMenuSidebarOpen((prev) => {
      const next = !prev;
      if (next) {
        setMenuResult("open-chat");
      }
      return next;
    });
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
            <h3 className="onboarding-shortcut-demo__title">Hold <TriggerKeyCaps platform={platform} />, drag to an option, release.</h3>
          </div>

          <div
            ref={radialSurfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--radial"
            data-testid="shortcuts-radial-surface"
            data-result={radialResult ?? undefined}
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
              Try it here
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
            <h3 className="onboarding-shortcut-demo__title">Right-click anywhere to open chat.</h3>
          </div>

          <div
            ref={menuSurfaceRef}
            className="onboarding-shortcut-surface onboarding-shortcut-surface--menu"
            data-testid="shortcuts-menu-surface"
            data-menu-result={menuResult ?? undefined}
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

              {menuSidebarOpen && (
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
