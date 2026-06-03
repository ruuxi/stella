export interface ThemeColors {
  // Core semantic colors
  background: string;
  backgroundWeak: string;
  backgroundStrong: string;
  foreground: string;
  foregroundWeak: string;
  foregroundStrong: string;

  // Brand/accent colors
  primary: string;
  primaryForeground: string;

  // Status colors
  success: string;
  warning: string;
  error: string;
  info: string;

  // Interactive
  interactive: string;

  // UI elements
  border: string;
  borderWeak: string;
  borderStrong: string;

  // Cards/surfaces
  card: string;
  cardForeground: string;

  // Muted
  muted: string;
  mutedForeground: string;

  // Accent
  accent: string;
  accentForeground: string;

  // Optional: override the gradient blob base color.
  // When omitted, blobs derive from `primary`.
  // Set to a neutral value for monochrome gradient backgrounds.
  gradientAnchor?: string;
}

export interface Theme {
  id: string;
  name: string;
  /**
   * Pin this theme to a single appearance regardless of the user's
   * Light/Dark/System choice. When set, the theme is also rendered with
   * a flat (gradient-suppressed) background. Use for "standardized"
   * single-mode themes like Pearl (white) and Noir (near-black).
   */
  forcedMode?: "light" | "dark";
  /**
   * Overlay theme. When set, this theme inherits every color from the theme
   * with this id and then applies `overrides` on top. Used by the built-in
   * "Custom" theme that every user is on by default: redesigns and personal
   * tweaks are written here so they show immediately (the user is already on
   * it) and never touch the stock themes. While the overlay is empty it is an
   * invisible passthrough to its base.
   */
  base?: string;
  /** Per-mode color overrides merged onto the base theme (overlay themes only). */
  overrides?: { light?: Partial<ThemeColors>; dark?: Partial<ThemeColors> };
  /**
   * Overlay state. While `false` the overlay stays hidden from the theme
   * picker and renders identically to its base; flip to `true` once it carries
   * real changes so it surfaces as a selectable "Custom" entry.
   */
  populated?: boolean;
  light: ThemeColors;
  dark: ThemeColors;
}
