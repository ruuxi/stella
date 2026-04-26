import { useEffect, useState, type ReactNode } from "react";
import "./home.css";

type HomeContentProps = {
  onDismissHome?: () => void;
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

export function HomeContent({
  onDismissHome,
  children,
}: HomeContentProps) {
  const greeting = useGreeting();
  const showViewMessages = Boolean(onDismissHome);
  const [showSidebarHint] = useState(shouldShowSidebarHint);

  useEffect(() => {
    if (!showSidebarHint) return;
    try {
      window.localStorage.setItem(SIDEBAR_HINT_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures; the hint is nonessential.
    }
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
          Right-click to open the display sidebar
        </div>
      )}
    </div>
  );
}
