/**
 * Shared SVG glyphs that mirror the real desktop sidebar icons (matches
 * `desktop/src/global/onboarding/panels/StellaAppMock.tsx`). Kept inline
 * so each demo renders identically without depending on icon libraries
 * for these specific shapes.
 */

import type { ReactNode } from "react";

const stroke = (d: string, extra?: ReactNode, size = 18): ReactNode => (
  <svg
    width={size}
    height={size}
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

export const STELLA_ICON_HOUSE = stroke(
  "M3 10l9-7 9 7M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10",
);

export const STELLA_ICON_USERS = (
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

export const STELLA_ICON_PLUS_SQUARE = (
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
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

export const STELLA_ICON_PALETTE = (
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
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.6 1.5-1.5 0-.4-.1-.7-.3-1-.2-.2-.3-.5-.3-.8 0-.8.7-1.5 1.5-1.5h1.2c3.2 0 5.8-2.6 5.8-5.8C21.8 6.2 17.4 2 12 2z" />
  </svg>
);

export const STELLA_ICON_SETTINGS = (
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

export const STELLA_ICON_STORE = (
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

export const STELLA_ICON_DEVICE = (
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
    <rect x="3" y="3" width="12" height="18" rx="2" ry="2" />
    <path d="M7 18h4" />
    <path d="M17 8.5a5 5 0 0 1 0 7" />
    <path d="M20 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const STELLA_ICON_LOGIN = (
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

export const STELLA_ICON_PLUS = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const STELLA_ICON_SEND = (
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

/**
 * Stella brand glyph — the small inline mark that sits at the back of
 * the sidebar brand row. Same drawing as the desktop StellaAppMock.
 */
export const STELLA_GLYPH = (
  <svg viewBox="0 0 32 32" width="100%" height="100%" fill="none">
    <path
      d="M16 2 L19 13 L30 16 L19 19 L16 30 L13 19 L2 16 L13 13 Z"
      fill="currentColor"
      opacity="0.85"
    />
  </svg>
);

/**
 * Renders the canonical 170px Stella sidebar (brand on right, Home /
 * Social / New App nav, footer with Palette+Settings icon row plus
 * Store / Connect / Sign in items). Used by every desktop-style mock
 * on the website so they all read as the same product.
 */
export function StellaSidebar({
  className = "",
}: {
  className?: string;
}): ReactNode {
  return (
    <aside className={`stella-sidebar ${className}`.trim()}>
      <div className="stella-sidebar__header" />
      <div className="stella-sidebar__brand">
        <span className="stella-sidebar__brand-glyph" aria-hidden="true">
          {STELLA_GLYPH}
        </span>
        <span className="stella-sidebar__brand-text">Stella</span>
      </div>
      <nav className="stella-sidebar__nav">
        <div className="stella-sidebar__nav-item active">
          <span className="stella-sidebar__nav-icon">{STELLA_ICON_HOUSE}</span>
          <span>Home</span>
        </div>
        <div className="stella-sidebar__nav-item">
          <span className="stella-sidebar__nav-icon">{STELLA_ICON_USERS}</span>
          <span>Social</span>
        </div>
        <div className="stella-sidebar__nav-item">
          <span className="stella-sidebar__nav-icon">
            {STELLA_ICON_PLUS_SQUARE}
          </span>
          <span>New App</span>
        </div>
      </nav>
      <div className="stella-sidebar__footer">
        <div className="stella-sidebar__footer-icons">
          <span className="stella-sidebar__icon-button" aria-hidden="true">
            {STELLA_ICON_PALETTE}
          </span>
          <span className="stella-sidebar__icon-button" aria-hidden="true">
            {STELLA_ICON_SETTINGS}
          </span>
        </div>
        <div className="stella-sidebar__nav-item">
          <span className="stella-sidebar__nav-icon">{STELLA_ICON_STORE}</span>
          <span>Store</span>
        </div>
        <div className="stella-sidebar__nav-item">
          <span className="stella-sidebar__nav-icon">{STELLA_ICON_DEVICE}</span>
          <span>Connect</span>
        </div>
        <div className="stella-sidebar__nav-item">
          <span className="stella-sidebar__nav-icon">{STELLA_ICON_LOGIN}</span>
          <span>Sign in</span>
        </div>
      </div>
    </aside>
  );
}
