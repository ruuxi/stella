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

import { useCallback, useState, type ReactNode } from "react";
import {
  EMPTY_SECTION_TOGGLES,
  type SectionKey,
  type SectionToggles,
} from "./stella-app-mock-types";

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
    label: "Workspace rail",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="3" width="6" height="18" rx="1.5" />
        <path d="M13 7h8M13 12h8M13 17h5" />
      </svg>
    ),
  },
  {
    key: "header",
    label: "Tabs",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <path d="M3 9h6a1 1 0 0 0 1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" />
        <path d="M3 9V8a1 1 0 0 1 1-1h5" />
      </svg>
    ),
  },
  {
    key: "messages",
    label: "Dashboard",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "composer",
    label: "Cozy mode",
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

const ICON_HOUSE = stroke("M3 10l9-7 9 7M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10");
const ICON_USERS = (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 00-3-3.87" />
    <path d="M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const ICON_PLUS_SQUARE = (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
const ICON_PALETTE = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.6 1.5-1.5 0-.4-.1-.7-.3-1-.2-.2-.3-.5-.3-.8 0-.8.7-1.5 1.5-1.5h1.2c3.2 0 5.8-2.6 5.8-5.8C21.8 6.2 17.4 2 12 2z" />
  </svg>
);
const ICON_SETTINGS = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);
const ICON_STORE = (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 01-8 0" />
  </svg>
);
const ICON_DEVICE = (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="12" height="18" rx="2" ry="2" />
    <path d="M7 18h4" />
    <path d="M17 8.5a5 5 0 0 1 0 7" />
    <path d="M20 5.5a9 9 0 0 1 0 13" />
  </svg>
);
const ICON_LOGIN = (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </svg>
);

/* Send button used inside the pill composer (matches ComposerPrimitives). */
const ICON_SEND = (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const ICON_PLUS = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/* ──────────────────────────────────────────────────────────────────────
 * Styles. Mirrors the real app's CSS variables and dimensions so the mock
 * picks up whatever theme the user has selected during onboarding.
 * ────────────────────────────────────────────────────────────────────── */

const css = `
  .sam-root {
    width: 100%;
    height: 100%;
    display: flex;
    position: relative;
    font-family: var(--font-family-sans, "Manrope", system-ui, sans-serif);
    color: var(--text-base);
    background: transparent;
    overflow: hidden;
    user-select: none;
    border-radius: 12px;
    border: 1px solid var(--border-base);
    box-shadow: var(--shadow-md);
    /* Mock-local gradient hint so the surface reads as "the real app"
       even when the onboarding background sits behind it. */
    background-image: radial-gradient(
      120% 90% at 80% 0%,
      color-mix(in oklch, var(--primary) 8%, transparent),
      transparent 60%
    ),
    radial-gradient(
      90% 80% at 0% 100%,
      color-mix(in oklch, var(--accent, var(--primary)) 6%, transparent),
      transparent 55%
    );
    background-color: var(--background);
  }
  .sam-root[data-interactive="true"] { overflow: visible; }
  .sam-root * { box-sizing: border-box; }

  /* ──────────────────────────────────────────
     SIDEBAR — default: matches the real 170px
     '.sidebar' with brand + nav + footer.
     ────────────────────────────────────────── */
  .sam-sidebar {
    width: 170px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    overflow: hidden;
    position: relative;
    z-index: 2;
  }

  .sam-sidebar-default {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
  }
  .sam-sidebar[data-modern="true"] .sam-sidebar-default { display: none; }

  .sam-sidebar-header {
    height: 16px;
    flex-shrink: 0;
  }

  .sam-sidebar-brand {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-height: 92px;
    padding: 0 14px;
  }
  .sam-sidebar-brand-glyph {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(calc(-50% - 38px), -50%);
    width: 42px;
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.42;
    color: var(--foreground);
  }
  .sam-sidebar-brand-text {
    color: var(--text-weaker);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.2em;
    line-height: 1;
    text-transform: uppercase;
    transform: translateX(-4px);
  }

  .sam-sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 12px 12px;
    flex: 1;
    min-height: 0;
  }

  .sam-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius-md, 6px);
    background: transparent;
    border: none;
    color: var(--text-base);
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    width: 100%;
    cursor: default;
  }
  .sam-nav-item.active {
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    color: var(--text-strong);
  }
  .sam-nav-item.active .sam-nav-icon {
    color: var(--primary);
  }

  .sam-nav-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: var(--text-weak);
  }

  .sam-sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border-top: 1px solid var(--border-weak);
  }
  .sam-footer-icons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 8px;
    justify-items: center;
    align-items: center;
  }
  .sam-icon-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--text-weak);
    border-radius: var(--radius-md, 6px);
  }

  /* SIDEBAR — modern: dense workspace with project list & badges. */
  .sam-sidebar[data-modern="true"] {
    width: 220px;
    background: linear-gradient(
      180deg,
      color-mix(in oklch, var(--primary) 6%, var(--glass-bg)) 0%,
      var(--glass-bg) 100%
    );
    backdrop-filter: var(--glass-blur);
    border-right: 1px solid color-mix(in oklch, var(--primary) 18%, transparent);
  }
  .sam-sidebar-modern {
    display: none;
    flex-direction: column;
    height: 100%;
    padding: 16px 12px;
    gap: 4px;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-sidebar[data-modern="true"] .sam-sidebar-modern { display: flex; }

  .sam-modern-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-md, 6px);
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    border: 1px solid var(--border-weak);
    font-size: 12px;
    color: var(--text-weak);
    margin-bottom: 8px;
  }
  .sam-modern-search-kbd {
    margin-left: auto;
    padding: 1px 6px;
    font-family: var(--font-family-mono, monospace);
    font-size: 9.5px;
    border-radius: 3px;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    color: var(--text-weaker);
  }
  .sam-modern-section {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-weaker);
    padding: 10px 10px 4px;
  }
  .sam-modern-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: var(--radius-md, 6px);
    font-size: 12.5px;
    color: var(--text-base);
  }
  .sam-modern-item-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--text-weak);
  }
  .sam-modern-item-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 9.5px;
    font-weight: 600;
    background: color-mix(in oklch, var(--primary) 18%, transparent);
    color: var(--primary);
  }
  .sam-modern-item.active {
    background: linear-gradient(
      90deg,
      color-mix(in oklch, var(--primary) 16%, transparent),
      color-mix(in oklch, var(--primary) 4%, transparent)
    );
    color: var(--text-strong);
    box-shadow: inset 2px 0 0 var(--primary);
  }
  .sam-modern-item.active .sam-modern-item-icon { color: var(--primary); }
  .sam-modern-spacer { flex: 1; }

  /* ──────────────────────────────────────────
     MAIN COLUMN — wraps header + body + composer
     Matches '.content-area' + '.full-body-main'.
     ────────────────────────────────────────── */
  .sam-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-left: 1px solid var(--border-weak);
    border-top: 1px solid var(--border-weak);
    position: relative;
  }

  /* HEADER — default: invisible (real app has no top bar on home). */
  .sam-header {
    height: 0;
    flex-shrink: 0;
    overflow: hidden;
    transition: height 0.3s ease;
  }
  .sam-header[data-modern="true"] {
    height: 38px;
    padding: 0;
    display: flex;
    align-items: stretch;
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
    border-bottom: 1px solid var(--border-weak);
    animation: samFadeUp 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
    overflow: hidden;
  }
  .sam-tabs {
    display: flex;
    align-items: stretch;
    width: 100%;
    padding: 6px 6px 0;
    gap: 1px;
  }
  .sam-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 14px 7px 12px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-weak);
    border-radius: 7px 7px 0 0;
    border: 1px solid transparent;
    border-bottom: none;
    position: relative;
    cursor: default;
    max-width: 150px;
    white-space: nowrap;
    overflow: hidden;
    background: transparent;
  }
  .sam-tab:not(.active):hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
    color: var(--text-base);
  }
  .sam-tab.active {
    background: var(--background);
    color: var(--text-strong);
    border-color: var(--border-weak);
    font-weight: 600;
    margin-bottom: -1px;
    z-index: 1;
  }
  .sam-tab.active::before {
    content: "";
    position: absolute;
    top: 0;
    left: 8px;
    right: 8px;
    height: 2px;
    background: var(--primary);
    border-radius: 0 0 2px 2px;
  }
  .sam-tab-icon {
    width: 12px;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-weak);
  }
  .sam-tab.active .sam-tab-icon { color: var(--primary); }
  .sam-tab-label {
    text-overflow: ellipsis;
    overflow: hidden;
    letter-spacing: -0.005em;
  }
  .sam-tab-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 7px 8px 6px 6px;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: transparent;
    border: 1px dashed color-mix(in oklch, var(--foreground) 22%, transparent);
    color: var(--text-weak);
    font-size: 13px;
    font-weight: 500;
    flex-shrink: 0;
    align-self: center;
    line-height: 1;
  }

  /* BODY — default: home content (centered title + category pills). */
  .sam-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 24px 12px;
    min-height: 0;
    overflow: hidden;
  }
  .sam-body-default {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    width: 100%;
    max-width: 540px;
    flex: 1;
  }
  .sam-home-title {
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-size: clamp(1.4rem, 2.6vw, 2rem);
    font-weight: 450;
    font-style: italic;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: var(--text-strong);
    text-align: center;
    margin: 0;
    width: 100%;
  }
  .sam-home-categories {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .sam-home-category {
    padding: 6px 22px;
    min-width: 88px;
    text-align: center;
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    color: var(--text-base);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: default;
  }
  .sam-home-category.active {
    background: color-mix(in oklch, var(--foreground) 6%, var(--background));
    color: var(--text-strong);
  }
  .sam-home-suggestions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    margin-top: 4px;
    padding: 0 24px;
  }
  .sam-home-suggestion {
    font-size: 14.5px;
    font-weight: 500;
    color: var(--text-base);
    line-height: 1.45;
    letter-spacing: -0.01em;
  }

  /* BODY — modern: cards-as-tools dashboard */
  .sam-body[data-modern="true"] .sam-body-default { display: none; }
  .sam-cards {
    display: none;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    width: 100%;
    max-width: 540px;
    margin: auto 0;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-body[data-modern="true"] .sam-cards { display: grid; }

  .sam-card {
    position: relative;
    padding: 12px 14px;
    border-radius: var(--radius-lg, 8px);
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    border: 1px solid var(--border-strong);
    overflow: hidden;
  }
  .sam-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0;
    width: 32px; height: 2px;
    background: var(--card-accent, var(--primary));
    border-radius: 0 0 2px 0;
  }
  .sam-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .sam-card-head-icon {
    width: 13px;
    height: 13px;
    color: var(--card-accent, var(--primary));
  }
  .sam-card-head-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--card-accent, var(--primary));
  }
  .sam-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    line-height: 1.35;
    margin-bottom: 3px;
  }
  .sam-card-meta {
    font-size: 10.5px;
    color: var(--text-weak);
  }
  .sam-card-bar {
    margin-top: 8px;
    height: 4px;
    border-radius: 999px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    overflow: hidden;
  }
  .sam-card-bar-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--card-accent, var(--primary));
    opacity: 0.85;
  }

  /* ══════════════════════════════════════════
     COZY THEME — when [data-cozy="true"] is set on .sam-root, the
     entire mock retints to a warm tuxedo-cat palette and swaps in
     parallel "Mochi" content for the sidebar, body, and composer.
     This is the "personalize the whole app" demo: a single toggle
     drastically transforms every surface, not just one panel.
     ══════════════════════════════════════════ */
  .sam-root[data-cozy="true"] {
    background-color: #fbf2e1;
    background-image:
      radial-gradient(circle at 12% 22%, rgba(139, 105, 75, 0.08) 4px, transparent 5px),
      radial-gradient(circle at 28% 78%, rgba(139, 105, 75, 0.06) 3px, transparent 4px),
      radial-gradient(circle at 78% 28%, rgba(139, 105, 75, 0.07) 5px, transparent 6px),
      radial-gradient(circle at 88% 72%, rgba(139, 105, 75, 0.05) 3px, transparent 4px),
      radial-gradient(circle at 52% 52%, rgba(139, 105, 75, 0.04) 4px, transparent 5px),
      radial-gradient(120% 90% at 80% 0%, rgba(232, 154, 152, 0.18), transparent 60%),
      radial-gradient(90% 80% at 0% 100%, rgba(212, 134, 154, 0.12), transparent 55%),
      linear-gradient(135deg, #fef3e2, #f5e1c4);
    border-color: rgba(139, 105, 75, 0.25);
  }
  .sam-root[data-cozy="true"] .sam-main {
    border-color: rgba(139, 105, 75, 0.2);
  }

  /* SIDEBAR — cozy override. Hides default + workspace-rail, shows
     a warm-cream "Mochi's house" rail with cat-themed nav. */
  .sam-root[data-cozy="true"] .sam-sidebar {
    background: linear-gradient(180deg, #fef3e2 0%, #f4d9b8 100%);
    border-right: 1px solid rgba(139, 105, 75, 0.25);
    width: 184px;
  }
  .sam-root[data-cozy="true"] .sam-sidebar .sam-sidebar-default,
  .sam-root[data-cozy="true"] .sam-sidebar .sam-sidebar-modern { display: none; }
  .sam-sidebar-cozy {
    display: none;
    flex-direction: column;
    height: 100%;
    width: 100%;
    padding: 0;
    color: #5c3d2e;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-root[data-cozy="true"] .sam-sidebar .sam-sidebar-cozy { display: flex; }

  .sam-cozy-rail-header { height: 16px; flex-shrink: 0; }
  .sam-cozy-rail-brand {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-height: 92px;
    padding: 0 14px;
  }
  .sam-cozy-rail-paw {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(calc(-50% - 38px), -50%);
    width: 36px;
    height: 36px;
    color: #1c1c1c;
    opacity: 0.85;
  }
  .sam-cozy-rail-name {
    color: #8b6240;
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-size: 17px;
    font-weight: 600;
    font-style: italic;
    letter-spacing: 0.06em;
    line-height: 1;
  }
  .sam-cozy-rail-nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 12px 12px;
    flex: 1;
    min-height: 0;
  }
  .sam-cozy-rail-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 10px;
    color: #5c3d2e;
    font-family: inherit;
    font-size: 13.5px;
    font-weight: 500;
  }
  .sam-cozy-rail-item.active {
    background: rgba(255, 252, 246, 0.6);
    color: #1c1c1c;
    font-weight: 600;
    box-shadow:
      inset 0 0 0 1px rgba(139, 105, 75, 0.2),
      0 1px 2px rgba(139, 105, 75, 0.1);
  }
  .sam-cozy-rail-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: #b8845c;
  }
  .sam-cozy-rail-item.active .sam-cozy-rail-icon { color: #d4869a; }
  .sam-cozy-rail-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-top: 1px solid rgba(139, 105, 75, 0.18);
  }
  .sam-cozy-rail-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #1c1c1c;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
    box-shadow: 0 0 0 2px rgba(255, 252, 246, 0.7);
  }
  .sam-cozy-rail-avatar svg { width: 100%; height: 100%; }
  .sam-cozy-rail-meta { display: flex; flex-direction: column; min-width: 0; }
  .sam-cozy-rail-meta-name {
    font-size: 12px;
    font-weight: 600;
    color: #1c1c1c;
    line-height: 1.2;
  }
  .sam-cozy-rail-meta-status {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #b8845c;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .sam-cozy-rail-pulse {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #d4869a;
    animation: samCozyDot 2s ease-in-out infinite;
  }

  /* HEADER — cozy retint when also toggled to "Tabs". */
  .sam-root[data-cozy="true"] .sam-header[data-modern="true"] {
    background: rgba(254, 243, 226, 0.7);
    border-bottom: 1px solid rgba(139, 105, 75, 0.22);
  }
  .sam-root[data-cozy="true"] .sam-tab { color: #8b6240; }
  .sam-root[data-cozy="true"] .sam-tab:not(.active):hover {
    background: rgba(139, 105, 75, 0.06);
    color: #5c3d2e;
  }
  .sam-root[data-cozy="true"] .sam-tab.active {
    background: #fef3e2;
    color: #1c1c1c;
    border-color: rgba(139, 105, 75, 0.28);
  }
  .sam-root[data-cozy="true"] .sam-tab.active::before { background: #d4869a; }
  .sam-root[data-cozy="true"] .sam-tab-icon { color: #b8845c; }
  .sam-root[data-cozy="true"] .sam-tab.active .sam-tab-icon { color: #d4869a; }
  .sam-root[data-cozy="true"] .sam-tab-add {
    border-color: rgba(139, 105, 75, 0.28);
    color: #b8845c;
  }

  /* BODY — cozy override. Hides default home + cards dashboard, shows
     a warm "What can Mochi do for you today?" home. */
  .sam-root[data-cozy="true"] .sam-body .sam-body-default,
  .sam-root[data-cozy="true"] .sam-body .sam-cards { display: none; }
  .sam-body-cozy {
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    width: 100%;
    max-width: 540px;
    flex: 1;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-root[data-cozy="true"] .sam-body .sam-body-cozy { display: flex; }
  .sam-cozy-home-title {
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-size: clamp(1.4rem, 2.6vw, 2rem);
    font-weight: 450;
    font-style: italic;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: #5c3d2e;
    text-align: center;
    margin: 0;
    width: 100%;
  }
  .sam-cozy-home-categories {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .sam-cozy-home-category {
    padding: 6px 22px;
    min-width: 88px;
    text-align: center;
    background: rgba(255, 252, 246, 0.55);
    backdrop-filter: blur(6px);
    border: 1px solid rgba(139, 105, 75, 0.25);
    border-radius: 999px;
    color: #8b6240;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
  }
  .sam-cozy-home-category.active {
    background: #fef3e2;
    color: #1c1c1c;
    border-color: rgba(139, 105, 75, 0.4);
    box-shadow: 0 1px 2px rgba(139, 105, 75, 0.15);
  }
  .sam-cozy-home-suggestions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    margin-top: 4px;
    padding: 0 24px;
  }
  .sam-cozy-home-suggestion {
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-size: 16px;
    font-style: italic;
    font-weight: 500;
    color: #5c3d2e;
    line-height: 1.4;
    letter-spacing: -0.005em;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .sam-cozy-home-suggestion::before {
    content: "\\2767";
    color: #d4869a;
    font-style: normal;
    font-size: 11px;
    flex-shrink: 0;
    transform: translateY(-1px);
  }

  /* PILL OVERLAY — give the Cozy Mode pill a warm tint to hint that
     it's a different *kind* of toggle (full-app theme vs section). */
  .sam-pill[data-section="composer"] {
    background: linear-gradient(135deg, rgba(254, 243, 226, 0.92), rgba(245, 225, 196, 0.92));
    border-color: rgba(139, 105, 75, 0.28);
    color: #5c3d2e;
  }
  .sam-pill[data-section="composer"][data-active="true"] {
    background: linear-gradient(135deg, #1c1c1c, #2d2d2d);
    color: #fef3e2;
    border-color: #1c1c1c;
    box-shadow:
      0 4px 22px rgba(28, 28, 28, 0.35),
      0 0 0 5px rgba(212, 134, 154, 0.18);
  }

  /* ──────────────────────────────────────────
     COMPOSER — default: pill input mirroring
     '.composer-shell' (border-radius: 999px).
     ────────────────────────────────────────── */
  .sam-composer-wrap {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: 8px 24px 16px;
    width: 100%;
  }
  .sam-composer {
    width: 100%;
    max-width: 480px;
    background: var(--background);
    border-radius: 999px;
    box-shadow: var(--shadow-md);
    transition: border-radius 0.3s ease;
    overflow: hidden;
  }
  .sam-composer-form {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-height: 50px;
    padding: 8px 10px;
  }
  .sam-composer-add {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1.5px solid var(--text-base);
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .sam-composer-input {
    flex: 1;
    padding: 4px 4px;
    font-family: inherit;
    font-size: 13.5px;
    color: var(--text-strong);
  }
  .sam-composer-input-placeholder {
    color: var(--text-weaker);
    opacity: 0.85;
  }
  .sam-composer-submit {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--primary);
    color: var(--primary-foreground);
    border: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    opacity: 0.45;
  }

  /* COMPOSER — modern: cozy mode with sleeping tuxedo cat */
  .sam-composer[data-modern="true"] {
    border-radius: 22px;
    background: linear-gradient(135deg, #fef3e2 0%, #f5e1c4 100%);
    box-shadow:
      var(--shadow-md),
      0 0 0 1px rgba(139, 105, 75, 0.18),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
  }
  .sam-composer[data-modern="true"] .sam-composer-form { display: none; }
  .sam-cozy {
    display: none;
    align-items: center;
    width: 100%;
    gap: 14px;
    padding: 12px 18px 12px 14px;
    min-height: 82px;
    position: relative;
    overflow: hidden;
    animation: samFadeUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-composer[data-modern="true"] .sam-cozy { display: flex; }
  .sam-cozy::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(circle at 18% 28%, rgba(139, 105, 75, 0.08) 3px, transparent 4px),
      radial-gradient(circle at 64% 78%, rgba(139, 105, 75, 0.06) 2.5px, transparent 3.5px),
      radial-gradient(circle at 92% 18%, rgba(139, 105, 75, 0.07) 4px, transparent 5px),
      radial-gradient(circle at 78% 50%, rgba(139, 105, 75, 0.05) 2px, transparent 3px);
    pointer-events: none;
  }
  .sam-cozy-cat {
    flex-shrink: 0;
    width: 96px;
    height: 64px;
    position: relative;
  }
  .sam-cozy-cat svg {
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
  }
  .sam-cozy-cat-body {
    transform-origin: 60px 56px;
    animation: samCozyBreathe 3.6s ease-in-out infinite;
  }
  .sam-cozy-cat-tail {
    transform-origin: 102px 50px;
    animation: samCozyTail 3.6s ease-in-out infinite;
  }
  .sam-cozy-cat::after {
    content: "";
    position: absolute;
    bottom: 2px;
    left: 50%;
    transform: translateX(-50%);
    width: 78px;
    height: 6px;
    border-radius: 50%;
    background: radial-gradient(ellipse, rgba(92, 64, 51, 0.18), transparent 70%);
  }
  .sam-cozy-zzz {
    position: absolute;
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-style: italic;
    font-weight: 600;
    color: #b08560;
    pointer-events: none;
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5);
    z-index: 2;
  }
  .sam-cozy-zzz-1 { top: 18px; left: 78px; font-size: 10px; opacity: 0.5; animation: samCozyFloat 3.2s ease-in-out 0.0s infinite; }
  .sam-cozy-zzz-2 { top: 8px;  left: 86px; font-size: 13px; opacity: 0.65; animation: samCozyFloat 3.2s ease-in-out 0.7s infinite; }
  .sam-cozy-zzz-3 { top: -2px; left: 96px; font-size: 17px; opacity: 0.78; animation: samCozyFloat 3.2s ease-in-out 1.4s infinite; }
  .sam-cozy-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
    z-index: 1;
  }
  .sam-cozy-state {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #b8845c;
  }
  .sam-cozy-state-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #d4869a;
    box-shadow: 0 0 0 0 rgba(212, 134, 154, 0.55);
    animation: samCozyDot 2s ease-in-out infinite;
    flex-shrink: 0;
  }
  .sam-cozy-line {
    font-family: var(--font-family-display, "Cormorant Garamond", Georgia, serif);
    font-size: 17px;
    font-style: italic;
    font-weight: 500;
    color: #5c3d2e;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.1;
  }
  .sam-cozy-meter {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    font-weight: 600;
    color: #8b6240;
    flex-shrink: 0;
    padding: 7px 12px;
    background: rgba(255, 252, 246, 0.65);
    border: 1px solid rgba(139, 105, 75, 0.22);
    border-radius: 999px;
    z-index: 1;
    font-variant-numeric: tabular-nums;
  }
  .sam-cozy-heart {
    color: #d4869a;
    font-size: 13px;
    line-height: 1;
    animation: samCozyHeartbeat 1.4s ease-in-out infinite;
  }

  /* ══════════════════════════════════════════
     PILL OVERLAY (interactive mode)
     ══════════════════════════════════════════ */
  .sam-pill {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px 9px 13px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklch, var(--foreground) 14%, transparent);
    background: color-mix(in oklch, var(--background) 82%, transparent);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    opacity: 0.95;
    cursor: pointer;
    user-select: none;
    z-index: 30;
    box-shadow:
      0 4px 16px color-mix(in oklch, var(--foreground) 10%, transparent),
      0 1px 0 color-mix(in oklch, white 12%, transparent) inset;
    animation: samPillIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
    transition:
      background 0.2s ease,
      color 0.2s ease,
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  .sam-pill:hover {
    opacity: 1;
    border-color: color-mix(in oklch, var(--foreground) 26%, transparent);
    transform: translateY(-1px);
  }
  .sam-pill[data-active="true"] {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: var(--primary);
    box-shadow:
      0 4px 22px color-mix(in oklch, var(--primary) 45%, transparent),
      0 0 0 5px color-mix(in oklch, var(--primary) 14%, transparent);
    opacity: 1;
  }
  .sam-pill-icon { display: inline-flex; opacity: 0.85; }
  .sam-pill[data-active="true"] .sam-pill-icon { opacity: 1; }
  .sam-pill-label { line-height: 1; white-space: nowrap; }
  .sam-pill-check {
    display: inline-flex;
    width: 0;
    overflow: hidden;
    transition: width 0.25s ease, margin 0.25s ease;
  }
  .sam-pill[data-active="true"] .sam-pill-check {
    width: 14px;
    margin-left: 2px;
  }

  /* Pill positions */
  .sam-pill[data-section="sidebar"]  { top: 12px; left: 184px;  animation-delay: 0.05s; }
  .sam-pill[data-section="header"]   { top: 12px; right: 16px;  animation-delay: 0.12s; }
  .sam-pill[data-section="messages"] { top: calc(50% - 16px); right: 18px; animation-delay: 0.18s; }
  .sam-pill[data-section="composer"] { bottom: 24px; left: 30%;  animation-delay: 0.24s; }

  .sam-root[data-any-active="false"] .sam-pill[data-section="sidebar"] {
    animation:
      samPillIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both,
      samPillAttention 2.6s ease-in-out 1.2s 2;
  }

  /* ══════════════════════════════════════════
     ANIMATIONS
     ══════════════════════════════════════════ */
  @keyframes samFadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes samPillIn {
    from { opacity: 0; transform: translateY(-4px) scale(0.92); }
    to   { opacity: 0.95; transform: translateY(0) scale(1); }
  }
  @keyframes samPillAttention {
    0%, 100% {
      box-shadow:
        0 4px 16px color-mix(in oklch, var(--foreground) 10%, transparent),
        0 0 0 0 color-mix(in oklch, var(--primary) 0%, transparent);
    }
    50% {
      box-shadow:
        0 4px 16px color-mix(in oklch, var(--foreground) 10%, transparent),
        0 0 0 8px color-mix(in oklch, var(--primary) 14%, transparent);
    }
  }
  @keyframes samCozyFloat {
    0%   { transform: translateY(2px)  scale(0.92); opacity: 0; }
    25%  { opacity: 1; }
    100% { transform: translateY(-12px) scale(1.05); opacity: 0; }
  }
  @keyframes samCozyDot {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(212, 134, 154, 0.5);
      transform: scale(1);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(212, 134, 154, 0);
      transform: scale(1.15);
    }
  }
  @keyframes samCozyHeartbeat {
    0%, 100% { transform: scale(1); }
    20%      { transform: scale(1.22); }
    40%      { transform: scale(0.94); }
    60%      { transform: scale(1.14); }
    80%      { transform: scale(1); }
  }
  @keyframes samCozyTail {
    0%, 100% { transform: rotate(0deg); }
    50%      { transform: rotate(-3deg); }
  }
  @keyframes samCozyBreathe {
    0%, 100% { transform: scaleY(1); }
    50%      { transform: scaleY(1.04); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sam-cozy-zzz,
    .sam-cozy-state-dot,
    .sam-cozy-heart,
    .sam-cozy-cat-body,
    .sam-cozy-cat-tail { animation: none; }
    .sam-pill,
    .sam-cards,
    .sam-sidebar-modern,
    .sam-cozy { animation: none; }
    .sam-root[data-any-active="false"] .sam-pill[data-section="sidebar"] { animation: none; }
  }
`;

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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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

const HOME_CATEGORIES = ["Stella", "Task", "Explore", "Schedule"] as const;

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
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 16l20-7-7 13-3-6-10-0z" />
      </svg>
    ),
  },
  {
    label: "Now playing",
    icon: (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    label: "Budget",
    icon: (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
    <path d="M11 18 Q12 16 13 18" stroke="white" strokeWidth="1" fill="none" strokeLinecap="round" />
    <path d="M19 18 Q20 16 21 18" stroke="white" strokeWidth="1" fill="none" strokeLinecap="round" />
    <path d="M14.5 21 L17.5 21 L16 22.5 Z" fill="#e89a98" />
  </svg>
);

/* Sleeping tuxedo cat illustration shown in cozy mode. Hand-drawn so the
 * mock feels personal and "drastic" — a true vibe shift from the default
 * pill composer rather than another utilitarian variation. */
const COZY_CAT_SVG = (
  <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg">
    {/* Tail wrapping around the back, drawn first so the body sits on top. */}
    <g className="sam-cozy-cat-tail">
      <path
        d="M104 60 Q120 52 115 36 Q108 22 90 27"
        stroke="#1c1c1c"
        strokeWidth="9"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse
        cx="92"
        cy="27"
        rx="5.5"
        ry="4"
        fill="white"
        transform="rotate(18 92 27)"
      />
    </g>

    <g className="sam-cozy-cat-body">
      {/* Body — the classic "loaf" silhouette. */}
      <path
        d="M14 56 Q14 36 40 31 Q60 26 80 31 Q106 36 106 56 L106 70 Q106 75 101 75 L19 75 Q14 75 14 70 Z"
        fill="#1c1c1c"
      />
      {/* White chest patch fading down through the front of the loaf. */}
      <path
        d="M44 56 Q60 51 76 56 L73 74 Q60 76 47 74 Z"
        fill="white"
      />

      {/* Head sitting on top-left of the body. */}
      <ellipse cx="50" cy="32" rx="18" ry="16" fill="#1c1c1c" />
      {/* White face mask — tuxedo down to the chin. */}
      <path
        d="M40 35 Q40 48 50 50 Q60 48 60 35 Q55 32 50 32 Q45 32 40 35 Z"
        fill="white"
      />

      {/* Ears (outer + pink inner). */}
      <path d="M37 22 L33 10 L46 20 Z" fill="#1c1c1c" />
      <path d="M63 22 L67 10 L54 20 Z" fill="#1c1c1c" />
      <path d="M38 20 L36 13 L43 19 Z" fill="#f4b8b0" />
      <path d="M62 20 L64 13 L57 19 Z" fill="#f4b8b0" />

      {/* Closed sleeping eyes. */}
      <path
        d="M42 36 Q44 33.5 46 36"
        stroke="#1c1c1c"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M54 36 Q56 33.5 58 36"
        stroke="#1c1c1c"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />

      {/* Pink nose + tiny mouth. */}
      <path d="M48 41 L52 41 L50 43.4 Z" fill="#e89a98" />
      <path
        d="M50 43.4 Q48 45.4 46 44.6 M50 43.4 Q52 45.4 54 44.6"
        stroke="#1c1c1c"
        strokeWidth="0.8"
        fill="none"
        strokeLinecap="round"
      />

      {/* Whiskers. */}
      <line x1="35" y1="40" x2="44" y2="41" stroke="#1c1c1c" strokeWidth="0.5" />
      <line x1="35" y1="42.5" x2="44" y2="42" stroke="#1c1c1c" strokeWidth="0.5" />
      <line x1="56" y1="41" x2="65" y2="40" stroke="#1c1c1c" strokeWidth="0.5" />
      <line x1="56" y1="42" x2="65" y2="42.5" stroke="#1c1c1c" strokeWidth="0.5" />

      {/* White paws tucked under the chin. */}
      <ellipse cx="36" cy="73" rx="6.5" ry="3" fill="white" />
      <ellipse cx="64" cy="73" rx="6.5" ry="3" fill="white" />
      <line x1="33.5" y1="71.5" x2="33.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
      <line x1="36" y1="71" x2="36" y2="74.5" stroke="#cfcfcf" strokeWidth="0.5" />
      <line x1="38.5" y1="71.5" x2="38.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
      <line x1="61.5" y1="71.5" x2="61.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
      <line x1="64" y1="71" x2="64" y2="74.5" stroke="#cfcfcf" strokeWidth="0.5" />
      <line x1="66.5" y1="71.5" x2="66.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
    </g>
  </svg>
);

export function StellaAppMock({
  interactive = false,
  toggles: controlledToggles,
  onToggleSection,
}: {
  interactive?: boolean;
  /** When provided, the component runs as a controlled component. */
  toggles?: SectionToggles;
  /** Required when `toggles` is controlled; otherwise internal state is used. */
  onToggleSection?: (section: SectionKey) => void;
}) {
  const [internalToggles, setInternalToggles] =
    useState<SectionToggles>(EMPTY_SECTION_TOGGLES);

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
    <>
      <style>{css}</style>
      <div
        className="sam-root"
        data-interactive={interactive || undefined}
        data-any-active={interactive ? String(anyActive) : undefined}
        data-cozy={toggles.composer || undefined}
      >
        {/* SIDEBAR ─────────────────────────────────────────────── */}
        <aside
          className="sam-sidebar"
          data-modern={toggles.sidebar || undefined}
        >
          <div className="sam-sidebar-default">
            <div className="sam-sidebar-header" />
            <div className="sam-sidebar-brand">
              <span className="sam-sidebar-brand-glyph" aria-hidden="true">
                {STELLA_GLYPH}
              </span>
              <span className="sam-sidebar-brand-text">Stella</span>
            </div>
            <nav className="sam-sidebar-nav">
              <button type="button" className="sam-nav-item active">
                <span className="sam-nav-icon">{ICON_HOUSE}</span>
                <span>Home</span>
              </button>
              <button type="button" className="sam-nav-item">
                <span className="sam-nav-icon">{ICON_USERS}</span>
                <span>Social</span>
              </button>
              <button type="button" className="sam-nav-item">
                <span className="sam-nav-icon">{ICON_PLUS_SQUARE}</span>
                <span>New App</span>
              </button>
            </nav>
            <div className="sam-sidebar-footer">
              <div className="sam-footer-icons">
                <button type="button" className="sam-icon-button" aria-label="Theme">
                  {ICON_PALETTE}
                </button>
                <button type="button" className="sam-icon-button" aria-label="Settings">
                  {ICON_SETTINGS}
                </button>
              </div>
              <button type="button" className="sam-nav-item">
                <span className="sam-nav-icon">{ICON_STORE}</span>
                <span>Store</span>
              </button>
              <button type="button" className="sam-nav-item">
                <span className="sam-nav-icon">{ICON_DEVICE}</span>
                <span>Connect</span>
              </button>
              <button type="button" className="sam-nav-item">
                <span className="sam-nav-icon">{ICON_LOGIN}</span>
                <span>Sign in</span>
              </button>
            </div>
          </div>

          <div className="sam-sidebar-modern">
            <div className="sam-modern-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <span>Search anything</span>
              <span className="sam-modern-search-kbd">{"\u2318K"}</span>
            </div>
            <div className="sam-modern-section">Workspace</div>
            <div className="sam-modern-item active">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10l9-7 9 7M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />
              </svg>
              <span>Home</span>
              <span className="sam-modern-item-badge">3</span>
            </div>
            <div className="sam-modern-item">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
              <span>Projects</span>
            </div>
            <div className="sam-modern-item">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M3 9h18M8 3v4M16 3v4" />
              </svg>
              <span>Calendar</span>
            </div>
            <div className="sam-modern-section">Memory</div>
            <div className="sam-modern-item">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>Recent</span>
            </div>
            <div className="sam-modern-item">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21l-1.4-1.3C5.4 15.4 2 12.3 2 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 10 3.5c0 3.8-3.4 6.9-8.6 11.2L12 21z" />
              </svg>
              <span>Pinned</span>
            </div>
            <div className="sam-modern-spacer" />
            <div className="sam-modern-item">
              <svg className="sam-modern-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
          <div
            className="sam-header"
            data-modern={toggles.header || undefined}
          >
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
              <button
                type="button"
                className="sam-tab-add"
                aria-label="New tab"
              >
                +
              </button>
            </div>
          </div>

          {/* BODY */}
          <div
            className="sam-body"
            data-modern={toggles.messages || undefined}
          >
            <div className="sam-body-default">
              <h1 className="sam-home-title">
                What can I do for you today?
              </h1>
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
    </>
  );
}
