"use client";

/**
 * Stella App Mock — onboarding preview that mirrors the real desktop app.
 *
 * The default state reproduces the actual Stella surface: a 170px sidebar
 * (brand + Home/Social/New App + footer icons) and a centered home column
 * with the italic Cormorant Garamond title, category pills, and a pill
 * composer — exactly what users see when they finish onboarding.
 *
 * When `interactive` is true, four floating "transformation" pills hover
 * over each section (sidebar, header, messages, composer). Clicking a pill
 * swaps that section for an alternate paradigm so the user can feel how
 * completely Stella can remake itself.
 */

import { memo, useCallback, useState, type ReactNode } from "react";
import {
  EMPTY_SECTION_TOGGLES,
  type SectionKey,
  type SectionToggles,
} from "./stella-app-mock-types";
import "./StellaAppMock.css";

type SectionPill = {
  key: SectionKey;
  label: string;
  icon: ReactNode;
};

const ICON_SVG_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const SECTION_PILLS: SectionPill[] = [
  {
    key: "sidebar",
    label: "Add a workspace rail",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="3" width="6" height="18" rx="1.5" />
        <path d="M13 7h8M13 12h8M13 17h5" />
      </svg>
    ),
  },
  {
    key: "header",
    label: "Give me tabs",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <path d="M3 9h6a1 1 0 0 0 1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" />
        <path d="M3 9V8a1 1 0 0 1 1-1h5" />
      </svg>
    ),
  },
  {
    key: "messages",
    label: "Make it a dashboard",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "composer",
    label: "Make it cozy",
    icon: (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
        <ellipse cx="12" cy="17" rx="4.2" ry="3.6" />
        <ellipse cx="6" cy="11.5" rx="2" ry="2.6" />
        <ellipse cx="18" cy="11.5" rx="2" ry="2.6" />
        <ellipse cx="9" cy="6.5" rx="1.8" ry="2.4" />
        <ellipse cx="15" cy="6.5" rx="1.8" ry="2.4" />
      </svg>
    ),
  },
  {
    key: "createApp",
    label: "Build me an app",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <path d="M12 3v18M3 12h18" />
      </svg>
    ),
  },
];

/* ──────────────────────────────────────────────────────────────────────
 * Reusable inline icons that match the real `SidebarIcons.tsx` set.
 * Kept inline so the mock is self-contained and renders identically when
 * the onboarding is themed differently from the rest of the app.
 * ────────────────────────────────────────────────────────────────────── */

const stroke = (d: string, extra?: ReactNode) => (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
    {extra}
  </svg>
);

const ICON_HOUSE = stroke(
  "M3 10l9-7 9 7M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10",
);
const ICON_USERS = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 00-3-3.87" />
    <path d="M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const ICON_MUSIC = (
  <svg
    width={18}
    height={18}
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
);
const ICON_SETTINGS = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);
const ICON_STORE = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 01-8 0" />
  </svg>
);
const ICON_LOGIN = (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </svg>
);

/* Send button used inside the pill composer (matches ComposerPrimitives). */
const ICON_SEND = (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const ICON_PLUS = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);


/* Default suggestions (rendered when `messages` toggle is OFF). Mirror the
 * `Stella` category from `HomeContent.DEFAULT_CATEGORIES`. */
const HOME_SUGGESTIONS: string[] = [
  "Add a music player to home",
  "Change my theme to dark",
  "Build me a budget tracker app",
  "Make me sound more casual",
];

/* Cards rendered when `messages` toggle is ON. */
const CARDS = [
  {
    label: "Inbox",
    title: "3 unread, 1 needs reply",
    meta: "Alex \u00b7 design review moved",
    accent: "var(--primary)",
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
    title: "Design review \u00b7 Thu 2pm",
    meta: "in 2 days \u00b7 4 attendees",
    accent: "oklch(0.65 0.18 200)",
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
    meta: "due today \u00b7 67% done",
    accent: "oklch(0.65 0.16 150)",
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
    title: "Deep work \u00b7 22:14 left",
    meta: "session 2 of 4",
    accent: "oklch(0.7 0.18 60)",
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
] as const;

const CHECK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/* Stella brand glyph — small inline mark so the sidebar reads as Stella
 * even when running outside the bundled assets pipeline. */
const STELLA_GLYPH = (
  <svg viewBox="0 0 32 32" width="100%" height="100%" fill="none">
    <path
      d="M16 2 L19 13 L30 16 L19 19 L16 30 L13 19 L2 16 L13 13 Z"
      fill="currentColor"
      opacity="0.85"
    />
  </svg>
);

const HOME_CATEGORIES = ["Stella", "Task", "Skills", "Schedule"] as const;

/* Tabs rendered when the `header` toggle is ON. Reads as a multi-context
 * workspace where Stella keeps several conversations/apps alive at once. */
const TAB_ICON = (d: string) => (
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

/* ──────────────────────────────────────────────────────────────────────
 * Cozy theme content. When the user clicks the "Cozy mode" pill, the
 * ENTIRE mock retints into a tuxedo-cat themed personalization — to
 * showcase that Stella can transform the whole app, not just one panel.
 * The data below drives the cozy sidebar (cat-themed nav) and the cozy
 * home content. The composer's sleeping cat scene is defined separately.
 * ────────────────────────────────────────────────────────────────────── */
const cozyIconStroke = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const COZY_ICON_PAW = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <ellipse cx="12" cy="17" rx="4.2" ry="3.6" />
    <ellipse cx="6" cy="11.5" rx="2" ry="2.6" />
    <ellipse cx="18" cy="11.5" rx="2" ry="2.6" />
    <ellipse cx="9" cy="6.5" rx="1.8" ry="2.4" />
    <ellipse cx="15" cy="6.5" rx="1.8" ry="2.4" />
  </svg>
);
const COZY_ICON_MOON = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const COZY_ICON_FISH = cozyIconStroke(
  <>
    <circle cx="6" cy="12" r="2" />
    <path d="M8 12 L18 12" />
    <path d="M11 9.5 L11 14.5 M14 9.5 L14 14.5 M17 10.5 L17 13.5" />
    <path d="M18 12 L21 9 M18 12 L21 15" />
  </>,
);
const COZY_ICON_YARN = cozyIconStroke(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M5 9c4 4 10 4 14 0M5 15c4-4 10-4 14 0M9 5c4 4 4 10 0 14M15 5c-4 4-4 10 0 14" />
  </>,
);
const COZY_ICON_HEART = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 21l-1.4-1.3C5.4 15.4 2 12.3 2 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 10 3.5c0 3.8-3.4 6.9-8.6 11.2L12 21z" />
  </svg>
);

const COZY_NAV: { label: string; icon: ReactNode; active?: boolean }[] = [
  { label: "Home", icon: COZY_ICON_PAW, active: true },
  { label: "Naps", icon: COZY_ICON_MOON },
  { label: "Treats", icon: COZY_ICON_FISH },
  { label: "Play", icon: COZY_ICON_YARN },
  { label: "Cuddles", icon: COZY_ICON_HEART },
];

const COZY_HOME_CATEGORIES = ["Mochi", "Calm", "Cozy", "Cute"] as const;

/* "Music Studio" — created-app body. The waveform points are deterministic
 * so re-renders settle on the same shape; this lets the surface read as a
 * finished track instead of random noise. Each track has multiple regions
 * arranged along an 8-bar timeline, drawn as filled clips with a SVG
 * waveform inside — same vocabulary as Logic / Ableton / GarageBand. */
type StudioRegion = {
  start: number;
  length: number;
  points: number[];
  upperPath: string;
  lowerPath: string;
};
type StudioTrack = {
  label: string;
  instrument: string;
  color: string;
  regions: StudioRegion[];
};

const createStudioRegion = (
  start: number,
  length: number,
  points: number[],
): StudioRegion => {
  const lastPoint = points.length - 1;
  const upperPath = `M0 50 ${points
    .map((p, i) => `L${i} ${50 - (p - 50) * 0.9}`)
    .join(" ")} L${lastPoint} 50 Z`;
  const lowerPath = `M0 50 ${points
    .map((p, i) => `L${i} ${50 + (p - 50) * 0.9}`)
    .join(" ")} L${lastPoint} 50 Z`;

  return { start, length, points, upperPath, lowerPath };
};

const STUDIO_TRACKS: StudioTrack[] = [
  {
    label: "Drums",
    instrument: "Kit · Analog",
    color: "#0f62fe",
    regions: [
      createStudioRegion(
        0,
        4,
        [50, 80, 30, 90, 45, 85, 35, 95, 50, 80, 30, 88, 42, 90, 35, 92],
      ),
      createStudioRegion(
        4,
        4,
        [55, 82, 32, 88, 48, 86, 38, 94, 52, 78, 34, 90, 44, 92, 38, 95],
      ),
    ],
  },
  {
    label: "Bass",
    instrument: "Sub · Mono",
    color: "#9c5bff",
    regions: [
      createStudioRegion(
        0,
        6,
        [55, 60, 65, 70, 60, 55, 50, 60, 70, 75, 65, 55, 50, 60, 70, 65],
      ),
    ],
  },
  {
    label: "Pads",
    instrument: "Strings · Soft",
    color: "#37c2a4",
    regions: [
      createStudioRegion(
        1,
        3,
        [40, 45, 50, 55, 60, 58, 55, 52, 50, 48, 50, 55, 58, 60, 55, 50],
      ),
      createStudioRegion(
        4,
        4,
        [45, 50, 55, 60, 65, 62, 58, 55, 52, 50, 52, 55, 58, 60, 58, 55],
      ),
    ],
  },
  {
    label: "Lead",
    instrument: "Synth · Lyrical",
    color: "#ff8a4c",
    regions: [
      createStudioRegion(
        2,
        2,
        [30, 60, 80, 70, 50, 70, 85, 60, 40, 65, 80, 70, 50, 60, 75, 55],
      ),
      createStudioRegion(
        5,
        3,
        [40, 70, 85, 75, 55, 65, 80, 70, 45, 60, 75, 80, 60, 50, 70, 65],
      ),
    ],
  },
];

const STUDIO_BARS = 8;
const STUDIO_RULER_TICKS = Array.from({ length: STUDIO_BARS }, (_, i) => i);
const STUDIO_GRID_TICKS = Array.from({ length: STUDIO_BARS - 1 }, (_, i) => ({
  index: i,
  left: `${((i + 1) / STUDIO_BARS) * 100}%`,
}));
const STUDIO_KNOBS = [
  { label: "Warmth", value: 0.72 },
  { label: "Air", value: 0.46 },
  { label: "Reverb", value: 0.58 },
] as const;
const STUDIO_METER_LEVELS = [6, 7, 8, 7, 6, 5, 4, 3] as const;
const MOCHI_CHIPS = ["Home", "Store", "Social", "Memories"] as const;
const COZY_HOME_SUGGESTIONS: string[] = [
  "Set a quiet hour while Mochi naps",
  "Schedule Mochi's next vet visit",
  "Play soft rainfall sounds tonight",
  "Remind me to refill Mochi's water",
];

/* Tiny cat avatar used in the cozy sidebar footer — a simple tuxedo
 * face so the rail clearly belongs to a single, beloved cat. */
const COZY_AVATAR = (
  <svg viewBox="0 0 32 32" fill="#1c1c1c">
    <ellipse cx="16" cy="20" rx="11" ry="9" />
    <path d="M9 12 L7 4 L14 11 Z" />
    <path d="M23 12 L25 4 L18 11 Z" />
    <ellipse cx="16" cy="22" rx="6" ry="4.5" fill="white" />
    <path
      d="M11 18 Q12 16 13 18"
      stroke="white"
      strokeWidth="1"
      fill="none"
      strokeLinecap="round"
    />
    <path
      d="M19 18 Q20 16 21 18"
      stroke="white"
      strokeWidth="1"
      fill="none"
      strokeLinecap="round"
    />
    <path d="M14.5 21 L17.5 21 L16 22.5 Z" fill="#e89a98" />
  </svg>
);

/* Sleeping tuxedo cat illustration shown in cozy mode. Hand-drawn so the
 * mock feels personal and "drastic" — a true vibe shift from the default
 * pill composer rather than another utilitarian variation. */
const COZY_CAT_SVG = (
  <svg viewBox="0 0 180 140" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="samCatBody" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#2E303F" />
        <stop offset="100%" stopColor="#14151B" />
      </linearGradient>
      <linearGradient id="samCatBelly" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="100%" stopColor="#F5F6F9" />
      </linearGradient>
      <linearGradient id="samCatInner" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#F4D3D2" />
        <stop offset="100%" stopColor="#E2A6A4" />
      </linearGradient>
      <filter id="samCatShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow
          dx="0"
          dy="3"
          stdDeviation="4"
          floodColor="#0D0E12"
          floodOpacity="0.15"
        />
      </filter>
    </defs>

    <g className="sam-cozy-cat-tail">
      {/* Sleek wrapping tail */}
      <path
        d="M 135 98 C 158 98 168 114 154 124 C 142 129 116 129 96 129 L 65 129"
        stroke="url(#samCatBody)"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Subtle tail tip highlight */}
      <path
        d="M 75 129 L 60 129"
        stroke="url(#samCatBelly)"
        strokeWidth="11"
        strokeLinecap="round"
        fill="none"
      />
    </g>

    <g className="sam-cozy-cat-body">
      {/* Sleek, flowing body silhouette */}
      <path
        d="M 52 116 C 36 98 42 78 68 70 C 88 64 112 60 132 72 C 148 82 152 102 142 118 C 134 124 115 124 95 123 C 75 122 58 121 52 116 Z"
        fill="url(#samCatBody)"
      />

      {/* Elegant cream chest patch */}
      <path
        d="M 52 110 C 48 95 58 85 75 85 C 88 85 92 98 92 110 C 92 118 78 119 65 118 C 56 117 53 113 52 110 Z"
        fill="url(#samCatBelly)"
      />

      {/* Tucked minimal paws */}
      <rect
        x="50"
        y="112"
        width="14"
        height="8"
        rx="4"
        fill="url(#samCatBelly)"
      />
      <rect
        x="70"
        y="112"
        width="14"
        height="8"
        rx="4"
        fill="url(#samCatBelly)"
      />

      {/* Head Group with sleek ears & face */}
      <g transform="translate(17.5, 23) scale(0.75)">
        {/* Sleek ears */}
        <path d="M 42 53 C 38 20 48 18 58 42 Z" fill="url(#samCatBody)" />
        <path d="M 45 49 C 42 25 49 23 55 39 Z" fill="url(#samCatInner)" />

        <path d="M 98 53 C 102 20 92 18 82 42 Z" fill="url(#samCatBody)" />
        <path d="M 95 49 C 98 25 91 23 85 39 Z" fill="url(#samCatInner)" />

        {/* Head Base with Soft Shadow */}
        <g filter="url(#samCatShadow)">
          <circle cx="70" cy="65" r="31" fill="url(#samCatBody)" />

          {/* Minimal cream mask */}
          <path
            d="M 70 48 C 62 60 52 70 44 76 C 54 90 86 90 96 76 C 88 70 78 60 70 48 Z"
            fill="url(#samCatBelly)"
          />

          {/* Serene sleeping eyes (ultra-fine lines) */}
          <path
            d="M 49 69 Q 55 73 61 69"
            stroke="#14151B"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 79 69 Q 85 73 91 69"
            stroke="#14151B"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />

          {/* Tiny clean nose */}
          <path d="M 68 78 L 72 78 L 70 81 Z" fill="url(#samCatInner)" />

          {/* Soft elegant whiskers (fine, high transparency) */}
          <path
            d="M 38 76 L 24 74 M 38 81 L 21 81"
            stroke="#FFFFFF"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.45"
          />
          <path
            d="M 102 76 L 116 74 M 102 81 L 119 81"
            stroke="#FFFFFF"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.45"
          />
        </g>
      </g>
    </g>
  </svg>
);

function StellaAppMockImpl({
  interactive = false,
  toggles: controlledToggles,
  onToggleSection,
  pillsDisabled = false,
}: {
  interactive?: boolean;
  /** When provided, the component runs as a controlled component. */
  toggles?: SectionToggles;
  /** Required when `toggles` is controlled; otherwise internal state is used. */
  onToggleSection?: (section: SectionKey) => void;
  /** Disables transformation pill clicks while an outer morph is running. */
  pillsDisabled?: boolean;
}) {
  const [internalToggles, setInternalToggles] = useState<SectionToggles>(
    EMPTY_SECTION_TOGGLES,
  );

  const isControlled = controlledToggles !== undefined;
  const toggles = controlledToggles ?? internalToggles;

  const toggleSection = useCallback(
    (section: SectionKey) => {
      if (isControlled) {
        onToggleSection?.(section);
        return;
      }
      setInternalToggles((prev) => ({ ...prev, [section]: !prev[section] }));
    },
    [isControlled, onToggleSection],
  );

  const anyActive = Object.values(toggles).some(Boolean);

  return (
    <div
      className="sam-root"
      data-interactive={interactive || undefined}
      data-any-active={interactive ? String(anyActive) : undefined}
      data-cozy={toggles.composer || undefined}
      data-create-app={toggles.createApp || undefined}
      data-pills-disabled={pillsDisabled || undefined}
    >
      {/* SIDEBAR ─────────────────────────────────────────────── */}
      <aside className="sam-sidebar" data-modern={toggles.sidebar || undefined}>
        <div className="sam-sidebar-default">
          <div className="sam-sidebar-header" />
          <div className="sam-sidebar-brand">
            <span className="sam-sidebar-brand-glyph" aria-hidden="true">
              {STELLA_GLYPH}
            </span>
            <span className="sam-sidebar-brand-text">Stella</span>
          </div>
          <nav className="sam-sidebar-nav">
            <button type="button" className="sam-nav-item sam-nav-item--home">
              <span className="sam-nav-icon">{ICON_HOUSE}</span>
              <span>Home</span>
            </button>
            <button type="button" className="sam-nav-item">
              <span className="sam-nav-icon">{ICON_STORE}</span>
              <span>Store</span>
            </button>
            <button type="button" className="sam-nav-item">
              <span className="sam-nav-icon">{ICON_USERS}</span>
              <span>Social</span>
            </button>
            <button type="button" className="sam-nav-item sam-nav-item--studio">
              <span className="sam-nav-icon">{ICON_MUSIC}</span>
              <span>Music</span>
              <span className="sam-nav-item-tag" aria-hidden="true">
                New
              </span>
            </button>
          </nav>
          <div className="sam-sidebar-footer">
            <button type="button" className="sam-nav-item">
              <span className="sam-nav-icon">{ICON_LOGIN}</span>
              <span>Sign in</span>
            </button>
            <button
              type="button"
              className="sam-icon-button"
              aria-label="Menu"
            >
              {ICON_SETTINGS}
            </button>
          </div>
        </div>

        <div className="sam-sidebar-modern">
          <div className="sam-modern-search">
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
            <span className="sam-modern-search-kbd">{"\u2318K"}</span>
          </div>
          <div className="sam-modern-section">Workspace</div>
          <div className="sam-modern-item active">
            <svg
              className="sam-modern-item-icon"
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
            <span className="sam-modern-item-badge">3</span>
          </div>
          <div className="sam-modern-item">
            <svg
              className="sam-modern-item-icon"
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
          <div className="sam-modern-item">
            <svg
              className="sam-modern-item-icon"
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
          <div className="sam-modern-section">Memory</div>
          <div className="sam-modern-item">
            <svg
              className="sam-modern-item-icon"
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
          <div className="sam-modern-item">
            <svg
              className="sam-modern-item-icon"
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
          <div className="sam-modern-spacer" />
          <div className="sam-modern-item">
            <svg
              className="sam-modern-item-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 005.6 15a1.65 1.65 0 00-1.51-1H4a2 2 0 010-4h.09A1.65 1.65 0 005.6 9 1.65 1.65 0 005.27 7.18l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.6 1.65 1.65 0 0010 3.09V3a2 2 0 014 0v.09c0 .67.39 1.27 1 1.51.6.25 1.31.11 1.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.25.6.85 1 1.51 1H21a2 2 0 010 4h-.09c-.67 0-1.27.39-1.51 1z" />
            </svg>
            <span>Settings</span>
          </div>
        </div>

        <div className="sam-sidebar-cozy">
          <div className="sam-cozy-rail-header" />
          <div className="sam-cozy-rail-brand">
            <span className="sam-cozy-rail-paw" aria-hidden="true">
              {COZY_ICON_PAW}
            </span>
            <span className="sam-cozy-rail-name">Mochi</span>
          </div>
          <nav className="sam-cozy-rail-nav">
            {COZY_NAV.map((item) => (
              <div
                key={item.label}
                className={`sam-cozy-rail-item${item.active ? " active" : ""}`}
              >
                <span className="sam-cozy-rail-icon">{item.icon}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </nav>
          <div className="sam-cozy-rail-footer">
            <span className="sam-cozy-rail-avatar" aria-hidden="true">
              {COZY_AVATAR}
            </span>
            <div className="sam-cozy-rail-meta">
              <div className="sam-cozy-rail-meta-name">Mochi</div>
              <div className="sam-cozy-rail-meta-status">
                <span className="sam-cozy-rail-pulse" />
                Purring
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN COLUMN ─────────────────────────────────────────── */}
      <div className="sam-main">
        {/* HEADER (only visible when modern) */}
        <div className="sam-header" data-modern={toggles.header || undefined}>
          <div className="sam-tabs">
            {TABS.map((tab) => (
              <div
                key={tab.label}
                className={`sam-tab${tab.active ? " active" : ""}`}
              >
                <span className="sam-tab-icon">{tab.icon}</span>
                <span className="sam-tab-label">{tab.label}</span>
              </div>
            ))}
            <button type="button" className="sam-tab-add" aria-label="New tab">
              +
            </button>
          </div>
        </div>

        {/* BODY */}
        <div
          className="sam-body"
          data-modern={toggles.messages || undefined}
          data-create-app={toggles.createApp || undefined}
        >
          <div className="sam-body-default">
            <h1 className="sam-home-title">What can I do for you today?</h1>
            <div className="sam-home-categories">
              {HOME_CATEGORIES.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={`sam-home-category${index === 0 ? " active" : ""}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="sam-home-suggestions">
              {HOME_SUGGESTIONS.map((text) => (
                <span key={text} className="sam-home-suggestion">
                  {text}
                </span>
              ))}
            </div>
          </div>

          <div className="sam-cards">
            {CARDS.map((card) => (
              <div
                key={card.label}
                className="sam-card"
                style={{ ["--card-accent" as string]: card.accent }}
              >
                <div className="sam-card-head">
                  <span className="sam-card-head-icon">{card.icon}</span>
                  <span className="sam-card-head-label">{card.label}</span>
                </div>
                <div className="sam-card-title">{card.title}</div>
                <div className="sam-card-meta">{card.meta}</div>
                <div className="sam-card-bar">
                  <div
                    className="sam-card-bar-fill"
                    style={{ width: `${Math.round(card.progress * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="sam-body-create" aria-hidden={!toggles.createApp}>
            <div className="sam-studio">
              {/* TOPBAR — project identity, transport-adjacent meta. */}
              <div className="sam-studio-topbar">
                <div className="sam-studio-identity">
                  <span className="sam-studio-eyebrow">Built just now</span>
                  <h2 className="sam-studio-name">Untitled Track</h2>
                </div>
                <div className="sam-studio-meta">
                  <div className="sam-studio-meta-item">
                    <span className="sam-studio-meta-label">Tempo</span>
                    <span className="sam-studio-meta-value">120</span>
                  </div>
                  <div className="sam-studio-meta-item">
                    <span className="sam-studio-meta-label">Sig</span>
                    <span className="sam-studio-meta-value">4 / 4</span>
                  </div>
                  <div className="sam-studio-meta-item">
                    <span className="sam-studio-meta-label">Key</span>
                    <span className="sam-studio-meta-value">C maj</span>
                  </div>
                </div>
              </div>

              {/* TIMELINE + INSPECTOR */}
              <div className="sam-studio-stage">
                <div className="sam-studio-arrange">
                  <span className="sam-studio-playhead" aria-hidden="true" />
                  {/* Bar ruler */}
                  <div className="sam-studio-ruler">
                    {STUDIO_RULER_TICKS.map((i) => (
                      <span key={i} className="sam-studio-ruler-tick">
                        <span>{i + 1}</span>
                      </span>
                    ))}
                  </div>

                  {/* Tracks */}
                  <div className="sam-studio-tracks">
                    {STUDIO_TRACKS.map((track, trackIdx) => (
                      <div
                        key={track.label}
                        className="sam-studio-track"
                        style={{ ["--studio-accent" as string]: track.color }}
                      >
                        <div className="sam-studio-track-head">
                          <span className="sam-studio-track-name">
                            <span className="sam-studio-track-dot" />
                            {track.label}
                          </span>
                          <span className="sam-studio-track-instrument">
                            {track.instrument}
                          </span>
                          <div
                            className="sam-studio-track-controls"
                            aria-hidden="true"
                          >
                            <span className="sam-studio-track-chip">M</span>
                            <span className="sam-studio-track-chip">S</span>
                          </div>
                        </div>
                        <div className="sam-studio-lane">
                          {STUDIO_GRID_TICKS.map((tick) => (
                            <span
                              key={tick.index}
                              className="sam-studio-grid"
                              style={{ left: tick.left }}
                            />
                          ))}
                          {track.regions.map((region, regionIdx) => (
                            <span
                              key={regionIdx}
                              className="sam-studio-region"
                              style={{
                                left: `${(region.start / STUDIO_BARS) * 100}%`,
                                width: `${(region.length / STUDIO_BARS) * 100}%`,
                                ["--region-delay" as string]: `${
                                  trackIdx * 80 + regionIdx * 90
                                }ms`,
                              }}
                            >
                              <svg
                                className="sam-studio-region-wave"
                                viewBox={`0 0 ${region.points.length - 1} 100`}
                                preserveAspectRatio="none"
                                aria-hidden="true"
                              >
                                <path
                                  d={region.upperPath}
                                  fill="currentColor"
                                  opacity="0.85"
                                />
                                <path
                                  d={region.lowerPath}
                                  fill="currentColor"
                                  opacity="0.55"
                                />
                              </svg>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* INSPECTOR */}
                <aside className="sam-studio-inspector">
                  <div className="sam-studio-card">
                    <div className="sam-studio-card-eyebrow">
                      Generated by Stella
                    </div>
                    <div className="sam-studio-card-title">
                      Late-night drive · lo-fi keys, soft kick
                    </div>
                    <div className="sam-studio-card-prompt">
                      &ldquo;something I can write to&rdquo;
                    </div>
                  </div>

                  <div className="sam-studio-knobs">
                    {STUDIO_KNOBS.map((knob) => (
                      <div key={knob.label} className="sam-studio-knob">
                        <div className="sam-studio-knob-dial">
                          <svg viewBox="0 0 36 36">
                            <circle
                              cx="18"
                              cy="18"
                              r="14"
                              fill="none"
                              stroke="currentColor"
                              strokeOpacity="0.12"
                              strokeWidth="2.5"
                            />
                            <circle
                              cx="18"
                              cy="18"
                              r="14"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeDasharray={`${knob.value * 88} 88`}
                              transform="rotate(-220 18 18)"
                            />
                          </svg>
                          <span className="sam-studio-knob-readout">
                            {Math.round(knob.value * 100)}
                          </span>
                        </div>
                        <span className="sam-studio-knob-label">
                          {knob.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </aside>
              </div>

              {/* TRANSPORT */}
              <div className="sam-studio-transport">
                <div className="sam-studio-transport-controls">
                  <button
                    type="button"
                    className="sam-studio-tx"
                    aria-label="Rewind"
                  >
                    <svg
                      width={13}
                      height={13}
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M11 5l-7 7 7 7V5zm9 0l-7 7 7 7V5z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="sam-studio-tx sam-studio-tx--play"
                    aria-label="Play"
                  >
                    <svg
                      width={15}
                      height={15}
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="sam-studio-tx"
                    aria-label="Forward"
                  >
                    <svg
                      width={13}
                      height={13}
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M13 5l7 7-7 7V5zm-9 0l7 7-7 7V5z" />
                    </svg>
                  </button>
                </div>
                <span className="sam-studio-time">
                  <span className="sam-studio-time-now">00:14</span>
                  <span className="sam-studio-time-sep">/</span>
                  <span className="sam-studio-time-total">02:08</span>
                </span>
                <div className="sam-studio-meter" aria-hidden="true">
                  {STUDIO_METER_LEVELS.map((level, i) => (
                    <span
                      key={i}
                      className="sam-studio-meter-bar"
                      style={{ ["--meter-h" as string]: `${level * 10}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="sam-body-cozy">
            <h1 className="sam-cozy-home-title">
              What can Mochi do for you today?
            </h1>
            <div className="sam-cozy-home-categories">
              {COZY_HOME_CATEGORIES.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={`sam-cozy-home-category${index === 0 ? " active" : ""}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="sam-cozy-home-suggestions">
              {COZY_HOME_SUGGESTIONS.map((text) => (
                <span key={text} className="sam-cozy-home-suggestion">
                  {text}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* COMPOSER */}
        <div className="sam-composer-wrap">
          <div
            className="sam-composer"
            data-modern={toggles.composer || undefined}
          >
            <div className="sam-composer-form">
              <span className="sam-composer-add" aria-hidden="true">
                {ICON_PLUS}
              </span>
              <span className="sam-composer-input">
                <span className="sam-composer-input-placeholder">
                  Ask me anything...
                </span>
              </span>
              <span className="sam-composer-submit" aria-hidden="true">
                {ICON_SEND}
              </span>
            </div>

            <div className="sam-cozy">
              <div className="sam-cozy-cat" aria-hidden="true">
                <span className="sam-cozy-zzz sam-cozy-zzz-1">z</span>
                <span className="sam-cozy-zzz sam-cozy-zzz-2">z</span>
                <span className="sam-cozy-zzz sam-cozy-zzz-3">Z</span>
                {COZY_CAT_SVG}
              </div>
              <div className="sam-cozy-meta">
                <div className="sam-cozy-state">
                  <span className="sam-cozy-state-dot" />
                  Cozy mode &middot; purring
                </div>
                <div className="sam-cozy-line">
                  Mochi is curled up beside you.
                </div>
              </div>
              <div className="sam-cozy-meter">
                <span className="sam-cozy-heart" aria-hidden="true">
                  {"\u2665"}
                </span>
                <span>2h 14m</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* COZY MODE — when the user picks the cozy pill, Stella drops
            the chat shell entirely and becomes a single contemplative
            scene: soft rain on the window, the cat asleep in a pool of
            silver light. No chrome, no chat, no cards — the transformation
            IS the demo. */}
      <div className="sam-mochi" aria-hidden={!toggles.composer}>
        <div className="sam-mochi__lamp" aria-hidden="true" />
        <div className="sam-mochi__rain" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              className="sam-mochi__drop"
              style={{ ["--drop-i" as string]: i }}
            />
          ))}
        </div>

        <header className="sam-mochi__header">
          <span className="sam-mochi__brand">Mochi</span>
          <nav className="sam-mochi__nav" aria-label="Mochi sections">
            {MOCHI_CHIPS.map((label, idx) => (
              <span
                key={label}
                className={`sam-mochi__nav-item${idx === 0 ? " is-active" : ""}`}
              >
                {label}
              </span>
            ))}
          </nav>
        </header>

        <div className="sam-mochi__copy">
          <h1 className="sam-mochi__headline">
            <span>She&rsquo;s asleep</span>
            <span className="sam-mochi__headline-em">by the window.</span>
          </h1>
          <p className="sam-mochi__sub">
            Soft rain. The radiator hums. Don&rsquo;t wake her.
          </p>
        </div>

        <div className="sam-mochi__cat" aria-hidden="true">
          {COZY_CAT_SVG}
        </div>

        <footer className="sam-mochi__compose">
          <button
            type="button"
            className="sam-mochi__compose-attach"
            aria-label="Attach"
          >
            <span aria-hidden="true">{"\u002B"}</span>
          </button>
          <span className="sam-mochi__compose-input">
            <span className="sam-mochi__compose-placeholder">
              Message Mochi&hellip;
            </span>
          </span>
          <button
            type="button"
            className="sam-mochi__compose-send"
            aria-label="Send"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </footer>
      </div>

      {/* TRANSFORMATION PILLS (only when interactive) */}
      {interactive
        ? SECTION_PILLS.map((pill) => {
            const active = toggles[pill.key];
            return (
              <button
                key={pill.key}
                type="button"
                className="sam-pill"
                data-section={pill.key}
                data-active={active || undefined}
                aria-pressed={active}
                disabled={pillsDisabled}
                aria-disabled={pillsDisabled || undefined}
                onClick={() => toggleSection(pill.key)}
              >
                <span className="sam-pill-icon">{pill.icon}</span>
                <span className="sam-pill-label">{pill.label}</span>
                <span className="sam-pill-check" aria-hidden="true">
                  {CHECK_ICON}
                </span>
              </button>
            );
          })
        : null}
    </div>
  );
}

export const StellaAppMock = memo(StellaAppMockImpl);
