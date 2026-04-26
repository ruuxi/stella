import { type ReactNode } from "react";
import { CozyCatAvatar, CozyWidget } from "./cozy-cat";
import { SELF_MOD_STAGES, type SelfModLevel } from "./data";
import {
  STELLA_GLYPH,
  STELLA_ICON_DEVICE,
  STELLA_ICON_HOUSE,
  STELLA_ICON_LOGIN,
  STELLA_ICON_PALETTE,
  STELLA_ICON_PLUS,
  STELLA_ICON_PLUS_SQUARE,
  STELLA_ICON_SEND,
  STELLA_ICON_SETTINGS,
  STELLA_ICON_STORE,
  STELLA_ICON_USERS,
} from "./stella-shell-icons";
import "./selfmod-shell.css";

/* ──────────────────────────────────────────────────────────────────────
 * Mock of the real Stella desktop shell — same 170px brand-on-right
 * sidebar, Home/Social/New App nav, italic Cormorant home title with
 * category pills + suggestions, and a pill composer at the bottom.
 *
 * Stages mirror the four "transformation" pills in the desktop
 * onboarding's StellaAppMock. Each stage applies a distinct paradigm
 * shift so the demo reads as "Stella can rebuild itself", not just
 * a colour swap:
 *   • low    → default home with a subtle "messages are blue" tweak
 *   • medium → modern workspace rail + tabs + dashboard cards
 *   • high   → cozy tuxedo-cat theme across the whole shell
 * ────────────────────────────────────────────────────────────────────── */

const HOME_CATEGORIES = ["Stella", "Task", "Explore", "Schedule"] as const;
const HOME_SUGGESTIONS = [
  "Add a music player to home",
  "Change my theme to dark",
  "Build me a budget tracker app",
  "Make me sound more casual",
];

const COZY_HOME_CATEGORIES = ["Mochi", "Calm", "Cozy", "Cute"] as const;
const COZY_HOME_SUGGESTIONS = [
  "Set a quiet hour while Mochi naps",
  "Schedule Mochi's next vet visit",
  "Play soft rainfall sounds tonight",
  "Remind me to refill Mochi's water",
];

const COZY_NAV: { label: string; icon: ReactNode; active?: boolean }[] = [
  {
    label: "Home",
    active: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <ellipse cx="12" cy="17" rx="4.2" ry="3.6" />
        <ellipse cx="6" cy="11.5" rx="2" ry="2.6" />
        <ellipse cx="18" cy="11.5" rx="2" ry="2.6" />
        <ellipse cx="9" cy="6.5" rx="1.8" ry="2.4" />
        <ellipse cx="15" cy="6.5" rx="1.8" ry="2.4" />
      </svg>
    ),
  },
  {
    label: "Naps",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
  {
    label: "Treats",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="6" cy="12" r="2" />
        <path d="M8 12 L18 12" />
        <path d="M11 9.5 L11 14.5 M14 9.5 L14 14.5 M17 10.5 L17 13.5" />
        <path d="M18 12 L21 9 M18 12 L21 15" />
      </svg>
    ),
  },
  {
    label: "Play",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8" />
        <path d="M5 9c4 4 10 4 14 0M5 15c4-4 10-4 14 0M9 5c4 4 4 10 0 14M15 5c-4 4-4 10 0 14" />
      </svg>
    ),
  },
  {
    label: "Cuddles",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 21l-1.4-1.3C5.4 15.4 2 12.3 2 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 10 3.5c0 3.8-3.4 6.9-8.6 11.2L12 21z" />
      </svg>
    ),
  },
];

const TAB_ICON = (d: string): ReactNode => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

const TABS: { label: string; icon: ReactNode; active?: boolean }[] = [
  {
    label: "Home",
    active: true,
    icon: TAB_ICON("M3 10l9-7 9 7M5 10v10a1 1 0 001 1h12a1 1 0 001-1V10"),
  },
  {
    label: "Trip plan",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 16l20-7-7 13-3-6-10-0z" />
      </svg>
    ),
  },
  {
    label: "Now playing",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    label: "Budget",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 3v18h18" />
        <path d="M7 15l4-5 3 3 5-7" />
      </svg>
    ),
  },
];

const CARDS: {
  label: string;
  title: string;
  meta: string;
  accent: string;
  progress: number;
  icon: ReactNode;
}[] = [
  {
    label: "Inbox",
    title: "3 unread, 1 needs reply",
    meta: "Alex · design review moved",
    accent: "#3f7ff5",
    progress: 0.4,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4h16v16H4z" />
        <path d="M4 4l8 8 8-8" />
      </svg>
    ),
  },
  {
    label: "Calendar",
    title: "Design review · Thu 2pm",
    meta: "in 2 days · 4 attendees",
    accent: "#1aa5ff",
    progress: 0.7,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    label: "Tasks",
    title: "Ship onboarding rework",
    meta: "due today · 67% done",
    accent: "#34c896",
    progress: 0.67,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
  },
  {
    label: "Focus",
    title: "Deep work · 22:14 left",
    meta: "session 2 of 4",
    accent: "#f59e3b",
    progress: 0.55,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l3 2" />
      </svg>
    ),
  },
];

export function SelfModShell({
  stage,
  onStageSelect,
}: {
  stage: SelfModLevel;
  onStageSelect?: (stage: SelfModLevel) => void;
}) {
  const isModern = stage === "medium";
  const isCozy = stage === "high";

  return (
    <div
      className="selfmod-shell"
      data-stage={stage}
      data-modern={isModern || undefined}
      data-cozy={isCozy || undefined}
    >
      <div className="selfmod-shell__frame">
        <div className="selfmod-shell__titlebar">
          <div className="selfmod-shell__traffic">
            <span />
            <span />
            <span />
          </div>
          <div className="selfmod-shell__path">
            {isCozy ? "Mochi's house" : "Stella"}
          </div>
        </div>

        <div className="selfmod-shell__body">
          <aside className="selfmod-shell__sidebar">
            <div className="selfmod-shell__sidebar-default">
              <div className="selfmod-shell__sidebar-header" />
              <div className="selfmod-shell__brand">
                <span className="selfmod-shell__brand-glyph" aria-hidden="true">
                  {STELLA_GLYPH}
                </span>
                <span className="selfmod-shell__brand-text">Stella</span>
              </div>
              <nav className="selfmod-shell__nav">
                <div className="selfmod-shell__nav-item active">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_HOUSE}
                  </span>
                  <span>Home</span>
                </div>
                <div className="selfmod-shell__nav-item">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_USERS}
                  </span>
                  <span>Social</span>
                </div>
                <div className="selfmod-shell__nav-item">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_PLUS_SQUARE}
                  </span>
                  <span>New App</span>
                </div>
              </nav>
              <div className="selfmod-shell__sidebar-footer">
                <div className="selfmod-shell__footer-icons">
                  <span
                    className="selfmod-shell__icon-button"
                    aria-hidden="true"
                  >
                    {STELLA_ICON_PALETTE}
                  </span>
                  <span
                    className="selfmod-shell__icon-button"
                    aria-hidden="true"
                  >
                    {STELLA_ICON_SETTINGS}
                  </span>
                </div>
                <div className="selfmod-shell__nav-item">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_STORE}
                  </span>
                  <span>Store</span>
                </div>
                <div className="selfmod-shell__nav-item">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_DEVICE}
                  </span>
                  <span>Connect</span>
                </div>
                <div className="selfmod-shell__nav-item">
                  <span className="selfmod-shell__nav-icon">
                    {STELLA_ICON_LOGIN}
                  </span>
                  <span>Sign in</span>
                </div>
              </div>
            </div>

            <div className="selfmod-shell__sidebar-modern">
              <div className="selfmod-shell__modern-search">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
                <span>Search anything</span>
                <span className="selfmod-shell__modern-kbd">⌘K</span>
              </div>
              <div className="selfmod-shell__modern-section">Workspace</div>
              <div className="selfmod-shell__modern-item active">
                <svg
                  className="selfmod-shell__modern-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 10l9-7 9 7M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />
                </svg>
                <span>Home</span>
                <span className="selfmod-shell__modern-badge">3</span>
              </div>
              <div className="selfmod-shell__modern-item">
                <svg
                  className="selfmod-shell__modern-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
                <span>Projects</span>
              </div>
              <div className="selfmod-shell__modern-item">
                <svg
                  className="selfmod-shell__modern-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 9h18M8 3v4M16 3v4" />
                </svg>
                <span>Calendar</span>
              </div>
              <div className="selfmod-shell__modern-section">Memory</div>
              <div className="selfmod-shell__modern-item">
                <svg
                  className="selfmod-shell__modern-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <span>Recent</span>
              </div>
              <div className="selfmod-shell__modern-item">
                <svg
                  className="selfmod-shell__modern-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 21l-1.4-1.3C5.4 15.4 2 12.3 2 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 10 3.5c0 3.8-3.4 6.9-8.6 11.2L12 21z" />
                </svg>
                <span>Pinned</span>
              </div>
            </div>

            <div className="selfmod-shell__sidebar-cozy">
              <div className="selfmod-shell__cozy-rail-header" />
              <div className="selfmod-shell__cozy-rail-brand">
                <span
                  className="selfmod-shell__cozy-rail-paw"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <ellipse cx="12" cy="17" rx="4.2" ry="3.6" />
                    <ellipse cx="6" cy="11.5" rx="2" ry="2.6" />
                    <ellipse cx="18" cy="11.5" rx="2" ry="2.6" />
                    <ellipse cx="9" cy="6.5" rx="1.8" ry="2.4" />
                    <ellipse cx="15" cy="6.5" rx="1.8" ry="2.4" />
                  </svg>
                </span>
                <span className="selfmod-shell__cozy-rail-name">Mochi</span>
              </div>
              <nav className="selfmod-shell__cozy-rail-nav">
                {COZY_NAV.map((item) => (
                  <div
                    key={item.label}
                    className={`selfmod-shell__cozy-rail-item${item.active ? " active" : ""}`}
                  >
                    <span className="selfmod-shell__cozy-rail-icon">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </div>
                ))}
              </nav>
              <div className="selfmod-shell__cozy-rail-footer">
                <span
                  className="selfmod-shell__cozy-rail-avatar"
                  aria-hidden="true"
                >
                  <CozyCatAvatar />
                </span>
                <div className="selfmod-shell__cozy-rail-meta">
                  <div className="selfmod-shell__cozy-rail-meta-name">
                    Mochi
                  </div>
                  <div className="selfmod-shell__cozy-rail-meta-status">
                    <span className="selfmod-shell__cozy-rail-pulse" />
                    Purring
                  </div>
                </div>
              </div>
            </div>
          </aside>

          <div className="selfmod-shell__main">
            <div className="selfmod-shell__header">
              <div className="selfmod-shell__tabs">
                {TABS.map((tab) => (
                  <div
                    key={tab.label}
                    className={`selfmod-shell__tab${tab.active ? " active" : ""}`}
                  >
                    <span className="selfmod-shell__tab-icon">{tab.icon}</span>
                    <span className="selfmod-shell__tab-label">
                      {tab.label}
                    </span>
                  </div>
                ))}
                <span className="selfmod-shell__tab-add" aria-hidden="true">
                  +
                </span>
              </div>
            </div>

            <div className="selfmod-shell__body-area">
              <div className="selfmod-shell__home">
                <h1 className="selfmod-shell__home-title">
                  What can I do for you today?
                </h1>
                <div className="selfmod-shell__home-categories">
                  {HOME_CATEGORIES.map((label, index) => (
                    <span
                      key={label}
                      className={`selfmod-shell__home-category${index === 0 ? " active" : ""}`}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="selfmod-shell__home-suggestions">
                  {HOME_SUGGESTIONS.map((text) => (
                    <span
                      key={text}
                      className="selfmod-shell__home-suggestion"
                    >
                      {text}
                    </span>
                  ))}
                </div>
              </div>

              <div className="selfmod-shell__cards">
                {CARDS.map((card) => (
                  <div
                    key={card.label}
                    className="selfmod-shell__card"
                    style={
                      {
                        ["--card-accent" as string]: card.accent,
                      } as React.CSSProperties
                    }
                  >
                    <div className="selfmod-shell__card-head">
                      <span className="selfmod-shell__card-head-icon">
                        {card.icon}
                      </span>
                      <span className="selfmod-shell__card-head-label">
                        {card.label}
                      </span>
                    </div>
                    <div className="selfmod-shell__card-title">
                      {card.title}
                    </div>
                    <div className="selfmod-shell__card-meta">{card.meta}</div>
                    <div className="selfmod-shell__card-bar">
                      <div
                        className="selfmod-shell__card-bar-fill"
                        style={{ width: `${Math.round(card.progress * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="selfmod-shell__home-cozy">
                <h1 className="selfmod-shell__home-cozy-title">
                  What can Mochi do for you today?
                </h1>
                <div className="selfmod-shell__home-cozy-categories">
                  {COZY_HOME_CATEGORIES.map((label, index) => (
                    <span
                      key={label}
                      className={`selfmod-shell__home-cozy-category${index === 0 ? " active" : ""}`}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="selfmod-shell__home-cozy-suggestions">
                  {COZY_HOME_SUGGESTIONS.map((text) => (
                    <span
                      key={text}
                      className="selfmod-shell__home-cozy-suggestion"
                    >
                      {text}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="selfmod-shell__composer-wrap">
              <div className="selfmod-shell__composer">
                <div className="selfmod-shell__composer-form">
                  <span
                    className="selfmod-shell__composer-add"
                    aria-hidden="true"
                  >
                    {STELLA_ICON_PLUS}
                  </span>
                  <span className="selfmod-shell__composer-input">
                    Ask me anything...
                  </span>
                  <span
                    className="selfmod-shell__composer-submit"
                    aria-hidden="true"
                  >
                    {STELLA_ICON_SEND}
                  </span>
                </div>
                <div className="selfmod-shell__composer-cozy">
                  <CozyWidget />
                </div>
              </div>
            </div>

            <div className="selfmod-shell__stages" aria-label="Creation examples">
              {SELF_MOD_STAGES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="selfmod-shell__stage-chip"
                  data-active={stage === option.id || undefined}
                  onClick={() => onStageSelect?.(option.id)}
                >
                  <span className="selfmod-shell__stage-chip-level">
                    {option.title}
                  </span>
                  <span className="selfmod-shell__stage-chip-prompt">
                    {option.prompt}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
