import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  Maximize2,
  MessageSquare,
  Mic,
  Phone,
  Plus,
  Presentation,
  Send,
  Sparkles,
  Upload,
  User,
  Users,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import "./OnboardingCapabilitiesPhase.css";

type CapabilitiesPhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type SceneId =
  | "creation"
  | "productivity"
  | "connection"
  | "store"
  | "together"
  | "modes"
  | "actions";

type Scene = {
  id: SceneId;
  category: string;
  title: string;
  caption: string;
  durationMs: number;
  render: (active: boolean) => ReactNode;
};

const SCENE_DURATION_MS = 5400;
const LONG_SCENE_DURATION_MS = 6200;

const PRODUCTIVITY_APPS: Array<{
  id: string;
  Icon: LucideIcon;
  label: string;
  color: string;
}> = [
  {
    id: "excel",
    Icon: FileSpreadsheet,
    label: "Q3-revenue.xlsx",
    color: "var(--cap-excel)",
  },
  {
    id: "word",
    Icon: FileText,
    label: "Proposal.docx",
    color: "var(--cap-word)",
  },
  {
    id: "ppt",
    Icon: Presentation,
    label: "Board deck.pptx",
    color: "var(--cap-ppt)",
  },
  { id: "web", Icon: Globe, label: "yourname.com", color: "var(--cap-web)" },
];

const STORE_ITEMS: Array<{
  name: string;
  author: string;
  action: "publish" | "install" | "browse";
  Icon: LucideIcon;
}> = [
  { name: "Habit tracker", author: "by you", action: "publish", Icon: Check },
  { name: "Recipe box", author: "by @maya", action: "install", Icon: Download },
  {
    name: "Mood journal",
    author: "by @rahul",
    action: "browse",
    Icon: Sparkles,
  },
  { name: "Workout plan", author: "by @leo", action: "browse", Icon: Sparkles },
];

const ACTION_TIME_SLOTS = ["7:00", "7:30", "8:00", "8:30", "9:00"];
const ACTION_DESKTOP_FILES = [
  { name: "IMG_4209.jpg", delay: 400 },
  { name: "invoice.pdf", delay: 560 },
  { name: "notes.md", delay: 720 },
  { name: "cat.gif", delay: 880 },
];
const ACTION_FOLDERS = [
  { name: "Photos", delay: "1300ms" },
  { name: "Receipts", delay: "1450ms" },
  { name: "Notes", delay: "1600ms" },
];

const SCENES: Scene[] = [
  {
    id: "creation",
    category: "Creation",
    title: "Stella reshapes itself for you.",
    caption:
      "Change how Stella looks, talks, and what it can do. Add a habit tracker, swap a theme, give it a new personality — anything is modifiable.",
    durationMs: LONG_SCENE_DURATION_MS,
    render: (active) => <CreationScene active={active} />,
  },
  {
    id: "productivity",
    category: "Work",
    title: "Real apps. Real work.",
    caption:
      "Stella works in Excel, Word, PowerPoint, and the browser — fills spreadsheets, drafts docs, builds slides, and ships a website if you ask for one.",
    durationMs: SCENE_DURATION_MS,
    render: (active) => <ProductivityScene active={active} />,
  },
  {
    id: "connection",
    category: "Connection",
    title: "Text Stella from anywhere.",
    caption:
      "Send a message from your phone — Stella picks it up on your computer and gets the work done while you're away.",
    durationMs: LONG_SCENE_DURATION_MS,
    render: (active) => <ConnectionScene active={active} />,
  },
  {
    id: "store",
    category: "Store",
    title: "Share what you make.",
    caption:
      "Publish modifications you've made to your Stella. Install ones built by other people. The store is community-powered.",
    durationMs: SCENE_DURATION_MS,
    render: (active) => <StoreScene active={active} />,
  },
  {
    id: "together",
    category: "Together",
    title: "Build with a friend.",
    caption:
      "Invite someone into a shared session. Brainstorm, plan, or build something — Stella works with both of you, live.",
    durationMs: SCENE_DURATION_MS,
    render: (active) => <TogetherScene active={active} />,
  },
  {
    id: "modes",
    category: "Modes",
    title: "Full window. Mini chat. Just your voice.",
    caption:
      "Stella is wherever you need it — a focused full window, a small chat tucked in the corner, or hands-free voice and dictation.",
    durationMs: SCENE_DURATION_MS,
    render: (active) => <ModesScene active={active} />,
  },
  {
    id: "actions",
    category: "Actions",
    title: "Stella takes action for you.",
    caption:
      "Reserve dinner on OpenTable, organize your messy desktop, click through forms — Stella drives your computer and the web on your behalf.",
    durationMs: LONG_SCENE_DURATION_MS,
    render: (active) => <ActionsScene active={active} />,
  },
];

export function OnboardingCapabilitiesPhase({
  splitTransitionActive,
  onContinue,
}: CapabilitiesPhaseProps) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [visitCount, setVisitCount] = useState(0);
  const [completedFirstCycle, setCompletedFirstCycle] = useState(false);
  const [stageHovered, setStageHovered] = useState(false);
  const sceneIndexRef = useRef(0);
  const completedRef = useRef(false);
  const pauseRef = useRef<() => void>(() => {});
  const resumeRef = useRef<() => void>(() => {});

  // Honor reduced-motion: skip the auto-cycle entirely; the word nav stays
  // functional so the user can still step between scenes manually.
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const goToScene = useCallback((next: number) => {
    sceneIndexRef.current = next;
    setSceneIndex(next);
    setVisitCount((v) => v + 1);
  }, []);

  // Auto-cycle with visibility-aware pause/resume. We track elapsed time on
  // the active scene so when the cycle is paused (window hidden, mid-phase
  // transition, or pointer hovering the mock) we resume where we left off
  // rather than skipping ahead or restarting. Pause/resume are exposed via
  // refs so external triggers (hover, splitTransitionActive) can poke the
  // same timer without re-running the effect — re-running would reset the
  // remaining-time bookkeeping and visually jolt the underline progress.
  useEffect(() => {
    if (prefersReducedMotion) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sceneStartedAt = 0;
    let remainingMs = SCENES[sceneIndexRef.current].durationMs;
    let paused = false;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const advance = () => {
      if (cancelled) return;
      const i = sceneIndexRef.current;
      const next = (i + 1) % SCENES.length;
      if (next === 0 && !completedRef.current) {
        completedRef.current = true;
        setCompletedFirstCycle(true);
      }
      remainingMs = SCENES[next].durationMs;
      goToScene(next);
      sceneStartedAt = Date.now();
      timer = setTimeout(advance, remainingMs);
    };

    const pause = () => {
      if (paused || cancelled) return;
      paused = true;
      const elapsed = Date.now() - sceneStartedAt;
      remainingMs = Math.max(0, remainingMs - elapsed);
      clearTimer();
    };

    const resume = () => {
      if (!paused || cancelled) return;
      paused = false;
      sceneStartedAt = Date.now();
      timer = setTimeout(advance, remainingMs);
    };

    pauseRef.current = pause;
    resumeRef.current = resume;

    const isHidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    sceneStartedAt = Date.now();
    if (isHidden()) {
      paused = true;
    } else {
      timer = setTimeout(advance, remainingMs);
    }

    const onVisibility = () => {
      if (cancelled) return;
      if (isHidden()) pause();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearTimer();
      pauseRef.current = () => {};
      resumeRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [goToScene, prefersReducedMotion]);

  // External pause sources: split transition (phase change) and pointer
  // hover over the mock. Both call into the same pause/resume bookkeeping
  // so the underline animation freezes/resumes in lockstep.
  const externallyPaused = splitTransitionActive || stageHovered;
  useEffect(() => {
    if (externallyPaused) {
      pauseRef.current();
    } else {
      resumeRef.current();
    }
  }, [externallyPaused]);

  const activeScene = SCENES[sceneIndex];
  const sceneKey = `${activeScene.id}-${visitCount}`;
  const isLastScene = sceneIndex === SCENES.length - 1;
  const continueEmphasized = completedFirstCycle || isLastScene;

  const handleSelectScene = useCallback(
    (i: number) => {
      goToScene(i);
    },
    [goToScene],
  );

  return (
    <div className="onboarding-step-content onboarding-cap-step">
      <h3
        className="onboarding-cap-title"
        key={`title-${sceneKey}`}
      >
        {activeScene.title}
      </h3>

      <div
        className="onboarding-cap-frame"
        data-paused={externallyPaused || undefined}
      >
        <div
          className="onboarding-cap-stage"
          data-scene={activeScene.id}
          onMouseEnter={() => setStageHovered(true)}
          onMouseLeave={() => setStageHovered(false)}
        >
          <div key={sceneKey} className="onboarding-cap-scene" data-active>
            {activeScene.render(true)}
          </div>
        </div>

        <div
          className="onboarding-cap-words"
          role="tablist"
          aria-label="Capability scenes"
        >
          {SCENES.map((scene, i) => {
            const active = i === sceneIndex;
            const completed = completedFirstCycle || i < sceneIndex;
            return (
              <button
                key={scene.id}
                type="button"
                role="tab"
                aria-selected={active}
                className="onboarding-cap-words__word"
                data-active={active || undefined}
                data-completed={completed || undefined}
                onClick={() => handleSelectScene(i)}
              >
                <span className="onboarding-cap-words__label">
                  {scene.category}
                </span>
                <span
                  className="onboarding-cap-words__track"
                  aria-hidden="true"
                >
                  {active ? (
                    <span
                      key={sceneKey}
                      className="onboarding-cap-words__fill"
                      style={{
                        animationDuration: `${activeScene.durationMs}ms`,
                      }}
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p
        className="onboarding-cap-caption__body"
        key={`caption-${sceneKey}`}
      >
        {activeScene.caption}
      </p>

      <button
        className="onboarding-confirm onboarding-cap-continue"
        data-visible={true}
        data-emphasized={continueEmphasized || undefined}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Scene components — each one mirrors a slice of the real Stella surface
 * (sidebar, chat bubbles, pill composer, app windows). Animations only
 * play when the scene is active so off-screen scenes stay quiet.
 * ────────────────────────────────────────────────────────────────────── */

function StellaShell({
  children,
  highlightSidebar,
  variant,
  badge,
}: {
  children: ReactNode;
  highlightSidebar?: "habits" | "store" | null;
  variant?: "default" | "themed";
  badge?: string;
}) {
  return (
    <div className="onboarding-cap-shell" data-variant={variant ?? "default"}>
      <div className="onboarding-cap-shell__sidebar">
        <div className="onboarding-cap-shell__brand">
          <Sparkles size={12} />
          <span>STELLA</span>
        </div>
        <div className="onboarding-cap-shell__nav">
          <span className="onboarding-cap-shell__nav-item" data-active>
            Home
          </span>
          <span className="onboarding-cap-shell__nav-item">
            <Users size={11} /> Together
          </span>
          <span className="onboarding-cap-shell__nav-item">
            <Plus size={11} /> New app
          </span>
          {highlightSidebar === "habits" ? (
            <span
              className="onboarding-cap-shell__nav-item onboarding-cap-shell__nav-item--new"
              data-fresh
            >
              <Check size={11} /> Habits
            </span>
          ) : null}
          {highlightSidebar === "store" ? (
            <span
              className="onboarding-cap-shell__nav-item onboarding-cap-shell__nav-item--new"
              data-fresh
            >
              <Download size={11} /> Recipe Box
            </span>
          ) : null}
        </div>
        <div className="onboarding-cap-shell__footer">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="onboarding-cap-shell__main">
        <div className="onboarding-cap-shell__title">
          {badge ? (
            <span className="onboarding-cap-shell__badge">{badge}</span>
          ) : null}
          <span className="onboarding-cap-shell__wordmark">Stella</span>
        </div>
        <div className="onboarding-cap-shell__body">{children}</div>
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  children,
  delay = 0,
  active,
}: {
  role: "user" | "assistant";
  children: ReactNode;
  delay?: number;
  active: boolean;
}) {
  return (
    <div
      className="onboarding-cap-bubble"
      data-role={role}
      data-visible={active || undefined}
      style={{ animationDelay: active ? `${delay}ms` : undefined }}
    >
      {children}
    </div>
  );
}

function PillComposer({ placeholder }: { placeholder: string }) {
  return (
    <div className="onboarding-cap-composer">
      <span className="onboarding-cap-composer__add">
        <Plus size={12} />
      </span>
      <span className="onboarding-cap-composer__input">{placeholder}</span>
      <span className="onboarding-cap-composer__send">
        <Send size={12} />
      </span>
    </div>
  );
}

/* ── Scene 1: Creation ─────────────────────────────────────────────── */

function CreationScene({ active }: { active: boolean }) {
  return (
    <StellaShell
      highlightSidebar={active ? "habits" : null}
      variant={active ? "themed" : "default"}
    >
      <div className="onboarding-cap-creation">
        <ChatBubble role="user" active={active} delay={120}>
          Add a habit tracker, give yourself a softer voice, and use the moss
          theme.
        </ChatBubble>
        <ChatBubble role="assistant" active={active} delay={1200}>
          <span className="onboarding-cap-bubble__wand">
            <Wand2 size={12} />
            Reshaping...
          </span>
        </ChatBubble>
        <div
          className="onboarding-cap-creation__artifact"
          data-visible={active || undefined}
        >
          <div className="onboarding-cap-creation__habit">
            <span className="onboarding-cap-creation__habit-title">
              Daily habits
            </span>
            <div className="onboarding-cap-creation__habit-row">
              <span /> Morning walk <Check size={11} />
            </div>
            <div className="onboarding-cap-creation__habit-row">
              <span /> Read 20 pages <Check size={11} />
            </div>
            <div className="onboarding-cap-creation__habit-row" data-pending>
              <span /> Write in journal
            </div>
          </div>
        </div>
        <PillComposer placeholder="Ask Stella to change anything..." />
      </div>
    </StellaShell>
  );
}

/* ── Scene 2: Productivity ─────────────────────────────────────────── */

function ProductivityScene({ active }: { active: boolean }) {
  return (
    <StellaShell>
      <div className="onboarding-cap-productivity">
        <ChatBubble role="user" active={active} delay={120}>
          Update the Q3 revenue sheet, draft the board proposal, build matching
          slides, and put it all on my website.
        </ChatBubble>
        <div className="onboarding-cap-productivity__row">
          {PRODUCTIVITY_APPS.map((app, i) => {
            const Icon = app.Icon;
            return (
              <div
                key={app.id}
                className="onboarding-cap-app-card"
                data-visible={active || undefined}
                style={
                  {
                    "--cap-accent": app.color,
                    animationDelay: `${600 + i * 240}ms`,
                  } as CSSProperties
                }
              >
                <div className="onboarding-cap-app-card__icon">
                  <Icon size={16} />
                </div>
                <div className="onboarding-cap-app-card__meta">
                  <span className="onboarding-cap-app-card__name">
                    {app.label}
                  </span>
                  <div className="onboarding-cap-app-card__bar">
                    <span
                      className="onboarding-cap-app-card__bar-fill"
                      style={{ animationDelay: `${800 + i * 240}ms` }}
                    />
                  </div>
                </div>
                <div className="onboarding-cap-app-card__check">
                  <Check size={12} />
                </div>
              </div>
            );
          })}
        </div>
        <ChatBubble role="assistant" active={active} delay={2800}>
          Updated the spreadsheet, wrote the doc, and pushed your site live.
        </ChatBubble>
      </div>
    </StellaShell>
  );
}

/* ── Scene 3: Connection (phone → desktop) ─────────────────────────── */

function ConnectionScene({ active }: { active: boolean }) {
  return (
    <div className="onboarding-cap-connection">
      <div className="onboarding-cap-phone" data-visible={active || undefined}>
        <div className="onboarding-cap-phone__notch" />
        <div className="onboarding-cap-phone__header">
          <span className="onboarding-cap-phone__avatar">
            <Sparkles size={11} />
          </span>
          <span className="onboarding-cap-phone__name">Stella</span>
        </div>
        <div className="onboarding-cap-phone__messages">
          <div
            className="onboarding-cap-phone__msg"
            data-role="user"
            data-visible={active || undefined}
            style={{ animationDelay: "200ms" }}
          >
            Hey, my flight just landed — can you confirm dinner tonight at 8?
          </div>
          <div
            className="onboarding-cap-phone__msg"
            data-role="assistant"
            data-visible={active || undefined}
            style={{ animationDelay: "1500ms" }}
          >
            On it. Pinging your desk now.
          </div>
        </div>
        <div className="onboarding-cap-phone__composer">
          <span>iMessage</span>
        </div>
      </div>

      <div className="onboarding-cap-bridge" data-visible={active || undefined}>
        <Phone size={14} />
        <span className="onboarding-cap-bridge__line" />
        <ArrowRight size={14} />
      </div>

      <div
        className="onboarding-cap-desktop"
        data-visible={active || undefined}
      >
        <div className="onboarding-cap-desktop__bar">
          <span />
          <span />
          <span />
          <strong>Mac · Stella</strong>
        </div>
        <div className="onboarding-cap-desktop__body">
          <div
            className="onboarding-cap-desktop__step"
            style={{ animationDelay: "1800ms" }}
          >
            <Globe size={11} /> Opening opentable.com
          </div>
          <div
            className="onboarding-cap-desktop__step"
            style={{ animationDelay: "2400ms" }}
          >
            <Check size={11} /> 8:00 PM · party of 2
          </div>
          <div
            className="onboarding-cap-desktop__step"
            style={{ animationDelay: "3000ms" }}
          >
            <Send size={11} /> Confirmation sent to your phone
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 4: Store ────────────────────────────────────────────────── */

function StoreScene({ active }: { active: boolean }) {
  return (
    <StellaShell highlightSidebar={active ? "store" : null}>
      <div className="onboarding-cap-store">
        <div className="onboarding-cap-store__header">
          <span className="onboarding-cap-store__title">Stella store</span>
          <span className="onboarding-cap-store__subtitle">
            What other people built — and what you've shared.
          </span>
        </div>
        <div className="onboarding-cap-store__grid">
          {STORE_ITEMS.map((item, i) => {
            const Icon = item.Icon;
            return (
              <div
                key={item.name}
                className="onboarding-cap-store__card"
                data-visible={active || undefined}
                data-action={item.action}
                style={{ animationDelay: `${300 + i * 200}ms` }}
              >
                <div className="onboarding-cap-store__card-art">
                  <Icon size={12} />
                </div>
                <div className="onboarding-cap-store__card-meta">
                  <span className="onboarding-cap-store__card-name">
                    {item.name}
                  </span>
                  <span className="onboarding-cap-store__card-author">
                    {item.author}
                  </span>
                </div>
                {item.action === "publish" ? (
                  <span className="onboarding-cap-store__card-tag">
                    <Upload size={10} /> Publishing
                  </span>
                ) : item.action === "install" ? (
                  <span className="onboarding-cap-store__card-tag">
                    <ArrowDown size={10} /> Installing
                  </span>
                ) : (
                  <span className="onboarding-cap-store__card-tag" data-quiet>
                    Browse
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </StellaShell>
  );
}

/* ── Scene 5: Together ─────────────────────────────────────────────── */

function TogetherScene({ active }: { active: boolean }) {
  return (
    <StellaShell badge="Shared session">
      <div className="onboarding-cap-together">
        <div className="onboarding-cap-together__people">
          <span className="onboarding-cap-together__avatar" data-color="a">
            <User size={11} />
            You
          </span>
          <span className="onboarding-cap-together__avatar" data-color="b">
            <User size={11} />
            Maya
          </span>
          <span className="onboarding-cap-together__avatar" data-color="stella">
            <Sparkles size={11} />
            Stella
          </span>
        </div>

        <div className="onboarding-cap-together__chat">
          <ChatBubble role="user" active={active} delay={200}>
            Plan our trip to Lisbon — flights, a hotel near Alfama, and a food
            list.
          </ChatBubble>
          <ChatBubble role="assistant" active={active} delay={1200}>
            <span className="onboarding-cap-bubble__wand">
              <Wand2 size={12} /> Building the plan...
            </span>
          </ChatBubble>
          <ChatBubble role="user" active={active} delay={2200}>
            <span className="onboarding-cap-together__friend-msg">
              <span data-name>Maya:</span> add a day trip to Sintra please
            </span>
          </ChatBubble>
          <ChatBubble role="assistant" active={active} delay={3300}>
            Added Sintra · Day 3. Reservation set at Tascardoso for night two.
          </ChatBubble>
        </div>

        <div className="onboarding-cap-together__cursors" aria-hidden="true">
          <span className="onboarding-cap-together__cursor" data-color="a" />
          <span className="onboarding-cap-together__cursor" data-color="b" />
        </div>
      </div>
    </StellaShell>
  );
}

/* ── Scene 6: Modes ────────────────────────────────────────────────── */

function ModesScene({ active }: { active: boolean }) {
  return (
    <div className="onboarding-cap-modes">
      <div
        className="onboarding-cap-mode onboarding-cap-mode--full"
        data-visible={active || undefined}
        style={{ animationDelay: "150ms" }}
      >
        <div className="onboarding-cap-mode__label">
          <Maximize2 size={11} /> Full window
        </div>
        <StellaShell>
          <div className="onboarding-cap-modes__bubbles">
            <ChatBubble role="user" active={active} delay={400}>
              Walk me through last week's calendar.
            </ChatBubble>
            <ChatBubble role="assistant" active={active} delay={1100}>
              You had 14 meetings — 4 with the design team, 3 one-on-ones...
            </ChatBubble>
            <PillComposer placeholder="Ask Stella anything..." />
          </div>
        </StellaShell>
      </div>

      <div
        className="onboarding-cap-mode onboarding-cap-mode--mini"
        data-visible={active || undefined}
        style={{ animationDelay: "650ms" }}
      >
        <div className="onboarding-cap-mode__label">
          <MessageSquare size={11} /> Mini chat
        </div>
        <div className="onboarding-cap-mini">
          <div className="onboarding-cap-mini__bar">
            <Sparkles size={11} />
            <span>Stella</span>
            <span className="onboarding-cap-mini__actions">
              <Maximize2 size={10} />
              <X size={10} />
            </span>
          </div>
          <div className="onboarding-cap-mini__messages">
            <div className="onboarding-cap-mini__msg" data-role="assistant">
              Reminder — your dad's birthday is Saturday.
            </div>
            <div className="onboarding-cap-mini__msg" data-role="user">
              Order flowers for him.
            </div>
            <div className="onboarding-cap-mini__msg" data-role="assistant">
              Done. Delivering Saturday by 11am.
            </div>
          </div>
          <div className="onboarding-cap-mini__composer">
            <Plus size={10} />
            <span>Ask Stella…</span>
            <ArrowUp size={10} />
          </div>
        </div>
      </div>

      <div
        className="onboarding-cap-mode onboarding-cap-mode--voice"
        data-visible={active || undefined}
        style={{ animationDelay: "1100ms" }}
      >
        <div className="onboarding-cap-mode__label">
          <Mic size={11} /> Voice & dictation
        </div>
        <div className="onboarding-cap-voice">
          <span className="onboarding-cap-voice__ring" />
          <span
            className="onboarding-cap-voice__ring"
            style={{ animationDelay: "0.3s" }}
          />
          <span
            className="onboarding-cap-voice__ring"
            style={{ animationDelay: "0.6s" }}
          />
          <span className="onboarding-cap-voice__mic">
            <Mic size={20} />
          </span>
          <span className="onboarding-cap-voice__caption">
            "...so make sure the report goes out by five."
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 7: Actions ──────────────────────────────────────────────── */

function ActionsScene({ active }: { active: boolean }) {
  return (
    <div className="onboarding-cap-actions">
      <div
        className="onboarding-cap-actions__browser"
        data-visible={active || undefined}
      >
        <div className="onboarding-cap-actions__browser-bar">
          <span />
          <span />
          <span />
          <span className="onboarding-cap-actions__url">
            <Globe size={10} /> opentable.com/r/luna-cucina
          </span>
        </div>
        <div className="onboarding-cap-actions__browser-body">
          <div className="onboarding-cap-actions__rest">
            <div className="onboarding-cap-actions__rest-name">Luna Cucina</div>
            <div className="onboarding-cap-actions__rest-meta">
              Italian · West Village · ⭐ 4.8
            </div>
            <div className="onboarding-cap-actions__time-row">
              {ACTION_TIME_SLOTS.map((t, i) => (
                <span
                  key={t}
                  className="onboarding-cap-actions__time"
                  data-active={t === "8:00" || undefined}
                  data-stella-click={i === 2 || undefined}
                  style={{ animationDelay: `${1200 + i * 80}ms` }}
                >
                  {t}
                </span>
              ))}
            </div>
            <div
              className="onboarding-cap-actions__confirm"
              style={{ animationDelay: "2200ms" }}
            >
              Reserve · Party of 2
            </div>
          </div>
          <div
            className="onboarding-cap-actions__cursor"
            aria-hidden="true"
            data-visible={active || undefined}
          />
        </div>
      </div>

      <div
        className="onboarding-cap-actions__desktop"
        data-visible={active || undefined}
      >
        <div className="onboarding-cap-actions__desktop-label">
          Desktop · cleaning up
        </div>
        <div className="onboarding-cap-actions__file-row">
          {ACTION_DESKTOP_FILES.map((file) => (
            <span
              key={file.name}
              className="onboarding-cap-actions__file"
              style={{ "--delay": `${file.delay}ms` } as CSSProperties}
            >
              {file.name}
            </span>
          ))}
        </div>
        <div className="onboarding-cap-actions__folders">
          {ACTION_FOLDERS.map((folder) => (
            <span
              key={folder.name}
              className="onboarding-cap-actions__folder"
              style={{ animationDelay: folder.delay }}
            >
              {folder.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
