import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePersonalizedCategories } from "@/app/home/categories";
import { useIdeasSeen } from "@/app/home/use-ideas-seen";
import "./home.css";

type HomeContentProps = {
  conversationId?: string | null;
  onDismissHome?: () => void;
  onSuggestionClick?: (prompt: string) => void;
  children?: ReactNode;
};

const SIDEBAR_HINT_STORAGE_KEY = "stella.home.sidebarHintSeen";

function shouldShowSidebarHint(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_HINT_STORAGE_KEY) !== "1";
  } catch {
    return false;
  }
}

function getTimeBasedGreeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

const FUN_GREETINGS: readonly string[] = [
  "Welcome back!",
  "Hey there!",
  "Glad you're here",
  "Ready when you are",
  "Let's make today great",
  "What's on your mind?",
  "Where should we start?",
  "Let's dive in",
  "Good to see you",
  "Hey, I'm all ears",
  "Let's create something",
  "Ready to roll?",
  "What are we tackling?",
  "Hello, friend",
  "Howdy!",
  "Welcome aboard",
  "Let's go!",
  "What's up?",
  "Let's make magic",
  "Pick a quest",
  "Adventure awaits",
  "Let's build something cool",
  "Good to have you back",
  "Let's do this",
  "Onward!",
  "What can we explore today?",
  "Hello, hello",
  "Greetings, traveler",
  "Let's chase some ideas",
  "Where to next?",
  "Hey, friend",
  "Ready to make a dent?",
  "Let's cook something up",
  "What's the mission?",
  "Hi! What's first?",
  "Let's get curious",
  "Bring me your best ideas",
  "Tell me everything",
  "What's the plan?",
  "Let's make something",
];

// Probability the greeting is a random fun message instead of the time-of-day greeting.
const FUN_GREETING_CHANCE = 0.25;

type GreetingState = { kind: "fun"; text: string } | { kind: "time" };

function pickInitialGreetingState(): GreetingState {
  if (Math.random() < FUN_GREETING_CHANCE) {
    const idx = Math.floor(Math.random() * FUN_GREETINGS.length);
    return { kind: "fun", text: FUN_GREETINGS[idx] };
  }
  return { kind: "time" };
}

function useGreeting(): string {
  const [state] = useState<GreetingState>(pickInitialGreetingState);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (state.kind !== "time") return;
    // Re-evaluate every minute so the time-of-day greeting stays accurate across boundaries.
    const interval = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(interval);
  }, [state.kind]);

  if (state.kind === "fun") return state.text;
  return getTimeBasedGreeting(new Date());
}

/**
 * Footer category pills with a dropup of options on click. Plain text
 * everywhere — no card, no popover background, no border. Always
 * absolutely positioned so opening / closing the dropup never shifts the
 * surrounding layout.
 *
 * The small dot in the top-right of a pill label means: this category's
 * suggestions changed since the user last opened it. Logic lives in
 * `useIdeasSeen`; opening the dropup marks the category seen.
 */
function HomeIdeasFooter({
  conversationId,
  onSuggestionClick,
}: {
  conversationId: string | null;
  onSuggestionClick: (prompt: string) => void;
}) {
  const { categories, ready: categoriesReady } =
    usePersonalizedCategories(conversationId);
  const { isUnseen, markSeen } = useIdeasSeen(
    conversationId,
    categories,
    categoriesReady,
    true,
  );
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape so the footer stays a low-commitment
  // surface — no manual close affordance is needed.
  useEffect(() => {
    if (!openLabel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpenLabel(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenLabel(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openLabel]);

  // If the active category disappears from a refresh, drop the dropup.
  useEffect(() => {
    if (!openLabel) return;
    if (!categories.some((category) => category.label === openLabel)) {
      setOpenLabel(null);
    }
  }, [categories, openLabel]);

  const handleTogglePill = useCallback(
    (label: string) => {
      setOpenLabel((current) => {
        const next = current === label ? null : label;
        if (next) markSeen(next);
        return next;
      });
    },
    [markSeen],
  );

  const handleSelectOption = useCallback(
    (prompt: string) => {
      onSuggestionClick(prompt);
      setOpenLabel(null);
    },
    [onSuggestionClick],
  );

  if (categories.length === 0) return null;

  const activeCategory = openLabel
    ? categories.find((category) => category.label === openLabel) ?? null
    : null;

  return (
    <div className="home-ideas-footer" ref={rootRef}>
      {activeCategory && (
        <ul
          className="home-ideas-dropup"
          role="listbox"
          aria-label={`${activeCategory.label} suggestions`}
        >
          {activeCategory.options.map((option) => (
            <li key={option.label} className="home-ideas-dropup__item">
              <button
                type="button"
                className="home-ideas-dropup__option"
                onClick={() => handleSelectOption(option.prompt)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="home-ideas-footer__pills" role="tablist">
        {categories.map((category) => {
          const isOpen = category.label === openLabel;
          const showDot = isUnseen(category.label);
          return (
            <button
              key={category.label}
              type="button"
              role="tab"
              aria-selected={isOpen}
              aria-expanded={isOpen}
              className={`home-ideas-footer__pill${
                isOpen ? " home-ideas-footer__pill--open" : ""
              }`}
              onClick={() => handleTogglePill(category.label)}
            >
              <span className="home-ideas-footer__pill-label">
                {category.label}
                {showDot && (
                  <span
                    className="home-ideas-footer__pill-dot"
                    aria-label="Updated"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function HomeContent({
  conversationId = null,
  onDismissHome,
  onSuggestionClick,
  children,
}: HomeContentProps) {
  const greeting = useGreeting();
  const showViewMessages = Boolean(onDismissHome);
  const [showSidebarHint, setShowSidebarHint] = useState(shouldShowSidebarHint);

  useEffect(() => {
    if (!showSidebarHint) return;
    try {
      window.localStorage.setItem(SIDEBAR_HINT_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures; the hint is nonessential.
    }
  }, [showSidebarHint]);

  // Dismiss the hint the moment the user actually right-clicks anywhere —
  // waiting for the next mount felt broken because the cue lingered after
  // its instruction was followed.
  useEffect(() => {
    if (!showSidebarHint) return;
    const dismiss = () => setShowSidebarHint(false);
    window.addEventListener("contextmenu", dismiss, { once: true });
    return () => window.removeEventListener("contextmenu", dismiss);
  }, [showSidebarHint]);

  return (
    <div className="home-content">
      <h1 className="home-stella-title">{greeting}</h1>

      {children}

      {showViewMessages && (
        <button
          className="home-view-messages-link"
          type="button"
          onClick={onDismissHome}
        >
          <span>Back to chat</span>
          <svg
            className="home-view-messages-link__arrow"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      )}

      {showSidebarHint && (
        <div className="home-sidebar-hint" role="status">
          <RightClickMouse className="home-sidebar-hint__mouse" />
          <span>Right-click to open the workspace panel</span>
        </div>
      )}

      {onSuggestionClick && (
        <HomeIdeasFooter
          conversationId={conversationId}
          onSuggestionClick={onSuggestionClick}
        />
      )}
    </div>
  );
}

function RightClickMouse({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="26"
      viewBox="0 0 28 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="home-hint-mouse-body">
          <rect x="1" y="1" width="26" height="38" rx="13" ry="13" />
        </clipPath>
      </defs>
      <g clipPath="url(#home-hint-mouse-body)">
        <rect
          x="14"
          y="1"
          width="13"
          height="16"
          className="home-sidebar-hint__mouse-highlight"
        />
      </g>
      <rect
        x="1"
        y="1"
        width="26"
        height="38"
        rx="13"
        ry="13"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="14"
        y1="1.5"
        x2="14"
        y2="17"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="1.75"
        y1="17"
        x2="26.25"
        y2="17"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="14"
        y1="7"
        x2="14"
        y2="12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
