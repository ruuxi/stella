/**
 * Stella App Mock — Shows the default Stella interface during onboarding.
 *
 * When `interactive` is true, the user sees floating "transformation" pills
 * positioned over each section of the mock (sidebar, header, messages,
 * composer). Clicking a pill swaps the entire section for a dramatically
 * different paradigm — letting the user feel how completely Stella can
 * remake itself.
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
    label: "Command rail",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="3" width="6" height="18" rx="1.5" />
        <path d="M13 7h8M13 12h8M13 17h5" />
      </svg>
    ),
  },
  {
    key: "header",
    label: "Mission control",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="8" height="6" rx="1.5" />
        <rect x="13" y="14" width="8" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "messages",
    label: "Card view",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "composer",
    label: "Voice mode",
    icon: (
      <svg {...ICON_SVG_PROPS}>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    ),
  },
];

const css = `
  .sam-root {
    width: 100%;
    height: 100%;
    display: flex;
    position: relative;
    font-family: var(--font-family-sans, "Manrope", sans-serif);
    color: var(--foreground);
    background: transparent;
    overflow: hidden;
    user-select: none;
  }
  .sam-root[data-interactive="true"] { overflow: visible; }
  .sam-root * { box-sizing: border-box; }

  /* ──────────────────────────────────────────
     SIDEBAR — default: thin icon rail
     ────────────────────────────────────────── */
  .sam-sidebar {
    width: 52px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 14px 0;
    gap: 4px;
    background: color-mix(in oklch, var(--foreground) 2%, transparent);
    border-right: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    overflow: hidden;
  }
  .sam-sidebar-icon {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in oklch, var(--foreground) 30%, transparent);
  }
  .sam-sidebar-icon.active {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: color-mix(in oklch, var(--foreground) 55%, transparent);
  }
  .sam-sidebar-divider {
    width: 22px;
    height: 1px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    margin: 4px 0;
  }
  .sam-sidebar-spacer { flex: 1; }

  /* SIDEBAR — modern: full "command rail" with labels, search, sections */
  .sam-sidebar[data-modern="true"] {
    width: 220px;
    align-items: stretch;
    padding: 16px 12px;
    gap: 4px;
    background: linear-gradient(
      180deg,
      color-mix(in oklch, oklch(0.55 0.18 250) 6%, transparent) 0%,
      color-mix(in oklch, var(--foreground) 4%, transparent) 100%
    );
    backdrop-filter: blur(20px);
    border-right: 1px solid color-mix(in oklch, oklch(0.55 0.18 250) 18%, transparent);
  }
  .sam-sidebar[data-modern="true"] .sam-sidebar-default { display: none; }
  .sam-sidebar-rail {
    display: none;
    flex-direction: column;
    gap: 2px;
    height: 100%;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-sidebar[data-modern="true"] .sam-sidebar-rail { display: flex; }

  .sam-rail-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    font-size: 12px;
    color: color-mix(in oklch, var(--foreground) 50%, transparent);
    margin-bottom: 8px;
  }
  .sam-rail-search-kbd {
    margin-left: auto;
    padding: 1px 5px;
    font-size: 9px;
    border-radius: 3px;
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    opacity: 0.6;
  }
  .sam-rail-section {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: color-mix(in oklch, var(--foreground) 45%, transparent);
    padding: 10px 10px 4px;
  }
  .sam-rail-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    color: color-mix(in oklch, var(--foreground) 70%, transparent);
  }
  .sam-rail-item-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    opacity: 0.7;
  }
  .sam-rail-item-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 9.5px;
    font-weight: 600;
    background: oklch(0.55 0.18 250 / 0.18);
    color: oklch(0.55 0.18 250);
  }
  .sam-rail-item.active {
    background: linear-gradient(
      90deg,
      oklch(0.55 0.18 250 / 0.18),
      oklch(0.55 0.18 250 / 0.04)
    );
    color: oklch(0.62 0.18 250);
    box-shadow: inset 2px 0 0 oklch(0.55 0.18 250);
  }

  /* ──────────────────────────────────────────
     CHAT — wraps header + body + composer
     ────────────────────────────────────────── */
  .sam-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* HEADER — default: simple avatar + name */
  .sam-chat-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    flex-shrink: 0;
  }
  .sam-chat-header-default {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
  }
  .sam-avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: color-mix(in oklch, var(--foreground) 10%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in oklch, var(--foreground) 40%, transparent);
    flex-shrink: 0;
  }
  .sam-chat-name { font-size: 13px; font-weight: 600; }
  .sam-chat-status { font-size: 10px; opacity: 0.4; }

  /* HEADER — modern: full mission-control bar with stats */
  .sam-chat-header[data-modern="true"] {
    padding: 14px 20px;
    background: linear-gradient(
      180deg,
      color-mix(in oklch, oklch(0.55 0.18 250) 8%, transparent),
      transparent 110%
    );
    backdrop-filter: blur(14px);
    border-bottom: 1px solid color-mix(in oklch, oklch(0.55 0.18 250) 18%, transparent);
  }
  .sam-chat-header[data-modern="true"] .sam-chat-header-default { display: none; }
  .sam-mission-control {
    display: none;
    align-items: center;
    gap: 14px;
    width: 100%;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-chat-header[data-modern="true"] .sam-mission-control { display: flex; }

  .sam-mc-orb {
    position: relative;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: conic-gradient(
      from 90deg,
      oklch(0.6 0.2 250),
      oklch(0.65 0.2 320),
      oklch(0.7 0.2 200),
      oklch(0.6 0.2 250)
    );
    box-shadow:
      0 0 24px oklch(0.55 0.18 250 / 0.45),
      inset 0 0 10px oklch(0.95 0 0 / 0.3);
    flex-shrink: 0;
    animation: samOrbSpin 8s linear infinite;
  }
  .sam-mc-orb::after {
    content: "";
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    background: var(--background);
  }
  .sam-mc-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .sam-mc-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
    color: var(--foreground);
  }
  .sam-mc-sub {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: oklch(0.62 0.18 250);
    opacity: 0.85;
  }
  .sam-mc-stats {
    margin-left: auto;
    display: flex;
    gap: 16px;
  }
  .sam-mc-stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }
  .sam-mc-stat-value {
    font-size: 13px;
    font-weight: 700;
    color: var(--foreground);
    font-variant-numeric: tabular-nums;
  }
  .sam-mc-stat-label {
    font-size: 8.5px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.55;
  }

  /* ──────────────────────────────────────────
     MESSAGES — default: chat bubbles
     ────────────────────────────────────────── */
  .sam-messages {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .sam-messages::-webkit-scrollbar { display: none; }
  .sam-msg { display: flex; max-width: 80%; }
  .sam-msg--stella { align-self: flex-start; }
  .sam-msg--user { align-self: flex-end; }
  .sam-bubble {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: 0.01em;
  }
  .sam-msg--stella .sam-bubble {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    border-radius: 2px 12px 12px 12px;
    opacity: 0.8;
  }
  .sam-msg--user .sam-bubble {
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    border-radius: 12px 2px 12px 12px;
    opacity: 0.9;
  }

  /* MESSAGES — modern: cards-as-tools dashboard */
  .sam-messages[data-modern="true"] {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-auto-rows: min-content;
    gap: 14px;
    padding: 20px 24px;
    overflow: hidden;
    align-content: start;
  }
  .sam-messages[data-modern="true"] .sam-msg-default { display: none; }
  .sam-cards {
    display: none;
    grid-column: 1 / -1;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-messages[data-modern="true"] .sam-cards { display: grid; }

  .sam-card {
    position: relative;
    padding: 14px 16px;
    border-radius: 14px;
    background: linear-gradient(
      150deg,
      color-mix(in oklch, var(--foreground) 4%, transparent),
      color-mix(in oklch, var(--foreground) 1%, transparent)
    );
    border: 1px solid color-mix(in oklch, var(--foreground) 8%, transparent);
    backdrop-filter: blur(12px);
    box-shadow: 0 2px 10px color-mix(in oklch, var(--foreground) 4%, transparent);
    overflow: hidden;
  }
  .sam-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0;
    width: 36px; height: 2px;
    background: var(--card-accent, oklch(0.55 0.18 250));
    border-radius: 0 0 2px 0;
  }
  .sam-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .sam-card-head-icon {
    width: 14px;
    height: 14px;
    color: var(--card-accent, oklch(0.55 0.18 250));
    opacity: 0.9;
  }
  .sam-card-head-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--card-accent, oklch(0.55 0.18 250));
    opacity: 0.85;
  }
  .sam-card-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--foreground);
    line-height: 1.4;
    margin-bottom: 4px;
  }
  .sam-card-meta {
    font-size: 11px;
    opacity: 0.55;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sam-card-bar {
    margin-top: 10px;
    height: 4px;
    border-radius: 999px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    overflow: hidden;
  }
  .sam-card-bar-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--card-accent, oklch(0.55 0.18 250));
    opacity: 0.8;
  }

  /* ──────────────────────────────────────────
     COMPOSER — default: text input
     ────────────────────────────────────────── */
  .sam-composer {
    display: flex;
    align-items: center;
    margin: 0 16px 16px;
    padding: 4px 4px 4px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    flex-shrink: 0;
    min-height: 38px;
  }
  .sam-composer-default {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 4px;
  }
  .sam-composer-placeholder {
    flex: 1;
    font-size: 13px;
    font-weight: 300;
    opacity: 0.35;
  }
  .sam-composer-send {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: none;
    background: var(--foreground);
    color: var(--background);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.25;
    cursor: pointer;
    flex-shrink: 0;
  }

  /* COMPOSER — modern: full voice/wave mode */
  .sam-composer[data-modern="true"] {
    margin: 0 20px 20px;
    padding: 14px 16px;
    border-radius: 18px;
    min-height: 88px;
    background: linear-gradient(
      135deg,
      oklch(0.55 0.18 250 / 0.18),
      oklch(0.55 0.2 320 / 0.1)
    );
    border: 1px solid oklch(0.55 0.18 250 / 0.3);
    backdrop-filter: blur(20px);
    box-shadow:
      0 4px 24px oklch(0.55 0.18 250 / 0.2),
      inset 0 1px 0 oklch(0.95 0 0 / 0.04);
  }
  .sam-composer[data-modern="true"] .sam-composer-default { display: none; }

  .sam-voice {
    display: none;
    align-items: center;
    width: 100%;
    gap: 14px;
    animation: samFadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sam-composer[data-modern="true"] .sam-voice { display: flex; }

  .sam-voice-mic {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: oklch(0.6 0.22 25);
    color: oklch(0.99 0 0);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow:
      0 0 0 4px oklch(0.6 0.22 25 / 0.18),
      0 4px 16px oklch(0.6 0.22 25 / 0.4);
    animation: samMicPulse 1.6s ease-in-out infinite;
  }

  .sam-voice-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex-shrink: 0;
  }
  .sam-voice-state {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: oklch(0.6 0.22 25);
  }
  .sam-voice-transcript {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--foreground);
    opacity: 0.92;
    white-space: nowrap;
  }

  .sam-voice-wave {
    flex: 1;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    overflow: hidden;
  }
  .sam-voice-wave span {
    display: inline-block;
    width: 3px;
    border-radius: 2px;
    background: linear-gradient(
      180deg,
      oklch(0.7 0.2 250),
      oklch(0.55 0.2 280)
    );
    animation: samWave 1.05s ease-in-out infinite;
  }
  .sam-voice-wave span:nth-child(1)  { animation-delay: 0.00s; }
  .sam-voice-wave span:nth-child(2)  { animation-delay: 0.06s; }
  .sam-voice-wave span:nth-child(3)  { animation-delay: 0.12s; }
  .sam-voice-wave span:nth-child(4)  { animation-delay: 0.18s; }
  .sam-voice-wave span:nth-child(5)  { animation-delay: 0.24s; }
  .sam-voice-wave span:nth-child(6)  { animation-delay: 0.30s; }
  .sam-voice-wave span:nth-child(7)  { animation-delay: 0.36s; }
  .sam-voice-wave span:nth-child(8)  { animation-delay: 0.42s; }
  .sam-voice-wave span:nth-child(9)  { animation-delay: 0.48s; }
  .sam-voice-wave span:nth-child(10) { animation-delay: 0.54s; }
  .sam-voice-wave span:nth-child(11) { animation-delay: 0.60s; }
  .sam-voice-wave span:nth-child(12) { animation-delay: 0.66s; }
  .sam-voice-wave span:nth-child(13) { animation-delay: 0.72s; }
  .sam-voice-wave span:nth-child(14) { animation-delay: 0.78s; }
  .sam-voice-wave span:nth-child(15) { animation-delay: 0.84s; }
  .sam-voice-wave span:nth-child(16) { animation-delay: 0.90s; }

  .sam-voice-stop {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: 1px solid oklch(0.6 0.22 25 / 0.4);
    background: oklch(0.6 0.22 25 / 0.16);
    color: oklch(0.6 0.22 25);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
  }

  /* ══════════════════════════════════════════
     PILL OVERLAY (interactive mode)
     ══════════════════════════════════════════ */
  .sam-pill {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    padding: 10px 18px 10px 14px;
    border-radius: 999px;
    border: 1px solid color-mix(in oklch, var(--foreground) 14%, transparent);
    background: color-mix(in oklch, var(--background) 82%, transparent);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.005em;
    color: var(--foreground);
    opacity: 0.95;
    cursor: pointer;
    user-select: none;
    z-index: 30;
    box-shadow:
      0 4px 16px color-mix(in oklch, var(--foreground) 10%, transparent),
      0 1px 0 color-mix(in oklch, oklch(0.99 0 0) 12%, transparent) inset;
    animation: samPillIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
    transition:
      background 0.25s ease,
      color 0.25s ease,
      border-color 0.25s ease,
      box-shadow 0.25s ease,
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  .sam-pill:hover {
    opacity: 1;
    border-color: color-mix(in oklch, var(--foreground) 26%, transparent);
    box-shadow:
      0 6px 22px color-mix(in oklch, var(--foreground) 14%, transparent),
      0 1px 0 color-mix(in oklch, oklch(0.99 0 0) 12%, transparent) inset;
    transform: translateY(-1px);
  }
  .sam-pill[data-active="true"] {
    background: oklch(0.55 0.18 250);
    color: oklch(0.99 0.005 250);
    border-color: oklch(0.55 0.18 250);
    box-shadow:
      0 4px 22px oklch(0.55 0.18 250 / 0.45),
      0 0 0 5px oklch(0.55 0.18 250 / 0.14);
    opacity: 1;
  }
  .sam-pill-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.85;
  }
  .sam-pill[data-active="true"] .sam-pill-icon { opacity: 1; }
  .sam-pill-label { line-height: 1; white-space: nowrap; }
  .sam-pill-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 0;
    overflow: hidden;
    transition: width 0.25s ease, margin 0.25s ease;
  }
  .sam-pill[data-active="true"] .sam-pill-check {
    width: 14px;
    margin-left: 2px;
  }

  /* Pill positions */
  .sam-pill[data-section="sidebar"]  { top: 14px; left: 64px;  animation-delay: 0.05s; }
  .sam-pill[data-section="header"]   { top: 14px; right: 16px; animation-delay: 0.12s; }
  .sam-pill[data-section="messages"] { top: calc(50% - 18px); right: 18px; animation-delay: 0.18s; }
  .sam-pill[data-section="composer"] { bottom: 28px; left: 30px; animation-delay: 0.24s; }

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
        0 0 0 0 oklch(0.55 0.18 250 / 0);
    }
    50% {
      box-shadow:
        0 4px 16px color-mix(in oklch, var(--foreground) 10%, transparent),
        0 0 0 8px oklch(0.55 0.18 250 / 0.1);
    }
  }
  @keyframes samMicPulse {
    0%, 100% { box-shadow: 0 0 0 4px oklch(0.6 0.22 25 / 0.18), 0 4px 16px oklch(0.6 0.22 25 / 0.4); }
    50%      { box-shadow: 0 0 0 10px oklch(0.6 0.22 25 / 0.05), 0 4px 22px oklch(0.6 0.22 25 / 0.5); }
  }
  @keyframes samWave {
    0%, 100% { height: 6px; opacity: 0.55; }
    50%      { height: 28px; opacity: 1; }
  }
  @keyframes samOrbSpin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sam-mc-orb,
    .sam-voice-mic,
    .sam-voice-wave span { animation: none; }
    .sam-pill,
    .sam-cards,
    .sam-mission-control,
    .sam-sidebar-rail,
    .sam-voice { animation: none; }
    .sam-root[data-any-active="false"] .sam-pill[data-section="sidebar"] { animation: none; }
  }
`;

/** Default chat bubble messages (rendered when `messages` toggle is OFF). */
const MESSAGES: { role: "stella" | "user"; text: string }[] = [
  { role: "stella", text: "Good morning! You have a clear schedule today." },
  { role: "user", text: "Great, can you check my email?" },
  {
    role: "stella",
    text: "You have 3 new emails. One from Alex about the project update, one shipping notification, and a newsletter.",
  },
  { role: "user", text: "Summarize Alex\u2019s email for me" },
  {
    role: "stella",
    text: "Alex says the design review is moved to Thursday at 2pm. They want your feedback on the new mockups before then.",
  },
];

/** Cards rendered when `messages` toggle is ON. */
const CARDS = [
  {
    label: "Inbox",
    title: "3 unread, 1 needs reply",
    meta: "Alex \u00b7 design review moved",
    accent: "oklch(0.6 0.18 250)",
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
      >
        {/* SIDEBAR */}
        <div
          className="sam-sidebar"
          data-modern={toggles.sidebar || undefined}
        >
          <div className="sam-sidebar-default" style={{ display: "contents" }}>
            <div className="sam-sidebar-icon active">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="sam-sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M9 22V12h6v10" />
              </svg>
            </div>
            <div className="sam-sidebar-divider" />
            <div className="sam-sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
            </div>
            <div className="sam-sidebar-spacer" />
            <div className="sam-sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
              </svg>
            </div>
          </div>

          <div className="sam-sidebar-rail">
            <div className="sam-rail-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <span>Search anything</span>
              <span className="sam-rail-search-kbd">{"\u2318K"}</span>
            </div>
            <div className="sam-rail-section">Workspace</div>
            <div className="sam-rail-item active">
              <svg className="sam-rail-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>Conversation</span>
              <span className="sam-rail-item-badge">3</span>
            </div>
            <div className="sam-rail-item">
              <svg className="sam-rail-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
              <span>Projects</span>
            </div>
            <div className="sam-rail-item">
              <svg className="sam-rail-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M3 9h18M8 3v4M16 3v4" />
              </svg>
              <span>Calendar</span>
            </div>
            <div className="sam-rail-section">Memory</div>
            <div className="sam-rail-item">
              <svg className="sam-rail-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>Recent</span>
            </div>
            <div className="sam-rail-item">
              <svg className="sam-rail-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21l-1.4-1.3C5.4 15.4 2 12.3 2 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 10 3.5c0 3.8-3.4 6.9-8.6 11.2L12 21z" />
              </svg>
              <span>Pinned</span>
            </div>
          </div>
        </div>

        {/* CHAT */}
        <div className="sam-chat">
          {/* HEADER */}
          <div
            className="sam-chat-header"
            data-modern={toggles.header || undefined}
          >
            <div className="sam-chat-header-default">
              <div className="sam-avatar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="10" r="3" />
                  <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />
                </svg>
              </div>
              <div>
                <div className="sam-chat-name">Stella</div>
                <div className="sam-chat-status">always here</div>
              </div>
            </div>

            <div className="sam-mission-control">
              <div className="sam-mc-orb" aria-hidden="true" />
              <div className="sam-mc-meta">
                <div className="sam-mc-title">Mission control</div>
                <div className="sam-mc-sub">{"listening \u00b7 4 streams"}</div>
              </div>
              <div className="sam-mc-stats">
                <div className="sam-mc-stat">
                  <div className="sam-mc-stat-value">12</div>
                  <div className="sam-mc-stat-label">tasks</div>
                </div>
                <div className="sam-mc-stat">
                  <div className="sam-mc-stat-value">3</div>
                  <div className="sam-mc-stat-label">flows</div>
                </div>
                <div className="sam-mc-stat">
                  <div className="sam-mc-stat-value">98%</div>
                  <div className="sam-mc-stat-label">ready</div>
                </div>
              </div>
            </div>
          </div>

          {/* MESSAGES */}
          <div
            className="sam-messages"
            data-modern={toggles.messages || undefined}
          >
            {MESSAGES.map((msg, i) => (
              <div
                key={i}
                className={`sam-msg sam-msg-default sam-msg--${msg.role}`}
              >
                <span className="sam-bubble">{msg.text}</span>
              </div>
            ))}

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
          </div>

          {/* COMPOSER */}
          <div
            className="sam-composer"
            data-modern={toggles.composer || undefined}
          >
            <div className="sam-composer-default">
              <span className="sam-composer-placeholder">Ask me anything...</span>
              <button className="sam-composer-send" aria-label="Send">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>

            <div className="sam-voice">
              <div className="sam-voice-mic" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </div>
              <div className="sam-voice-meta">
                <div className="sam-voice-state">Listening</div>
                <div className="sam-voice-transcript">
                  &ldquo;Schedule deep work for tomorrow at nine&hellip;&rdquo;
                </div>
              </div>
              <div className="sam-voice-wave" aria-hidden="true">
                {Array.from({ length: 16 }).map((_, i) => (
                  <span key={i} />
                ))}
              </div>
              <button className="sam-voice-stop" aria-label="Stop listening">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            </div>
          </div>
        </div>

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
