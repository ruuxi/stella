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
  light: ThemeColors;
  dark: ThemeColors;
}
