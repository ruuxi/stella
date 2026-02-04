/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { themes, getThemeById, defaultTheme, type Theme, type ThemeColors } from "./themes";
import { generateGradientTokens } from "./color";

type ColorMode = "light" | "dark" | "system";
type GradientMode = "soft" | "crisp";
type GradientColor = "relative" | "strong";

interface ThemeContextValue {
  // Current theme
  theme: Theme;
  themeId: string;
  setTheme: (id: string) => void;

  // Color mode
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  resolvedColorMode: "light" | "dark";

  // Gradient settings
  gradientMode: GradientMode;
  setGradientMode: (mode: GradientMode) => void;
  gradientColor: GradientColor;
  setGradientColor: (color: GradientColor) => void;

  // Current colors (resolved based on color mode)
  colors: ThemeColors;

  // All available themes
  themes: Theme[];

  // Preview functions (for hover preview like Aura)
  previewTheme: (id: string) => void;
  cancelThemePreview: () => void;
  previewGradientMode: (mode: GradientMode) => void;
  cancelGradientModePreview: () => void;
  previewGradientColor: (color: GradientColor) => void;
  cancelGradientColorPreview: () => void;
  cancelPreview: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = "stella-theme-id";
const COLOR_MODE_STORAGE_KEY = "stella-color-mode";
const GRADIENT_MODE_STORAGE_KEY = "stella-gradient-mode";
const GRADIENT_COLOR_STORAGE_KEY = "stella-gradient-color";

function getSystemColorMode(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(colors: ThemeColors, isDark: boolean) {
  const root = document.documentElement;

  // Apply color mode class
  root.classList.toggle("dark", isDark);

  // Set color scheme and text blend mode (Aura-style)
  root.style.setProperty("color-scheme", isDark ? "dark" : "light");
  root.style.setProperty("--text-mix-blend-mode", isDark ? "plus-lighter" : "multiply");

  // Apply theme colors as CSS custom properties
  root.style.setProperty("--background", colors.background);
  root.style.setProperty("--foreground", colors.foreground);
  root.style.setProperty("--card", colors.card);
  root.style.setProperty("--card-foreground", colors.cardForeground);
  root.style.setProperty("--popover", colors.card);
  root.style.setProperty("--popover-foreground", colors.cardForeground);
  root.style.setProperty("--surface-raised-stronger-non-alpha", colors.card);
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-foreground", colors.primaryForeground);
  root.style.setProperty("--secondary", colors.muted);
  root.style.setProperty("--secondary-foreground", colors.foreground);
  root.style.setProperty("--muted", colors.muted);
  root.style.setProperty("--muted-foreground", colors.mutedForeground);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-foreground", colors.accentForeground);
  root.style.setProperty("--destructive", colors.error);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--input", colors.border);
  root.style.setProperty("--ring", colors.interactive);

  // Spinner colors based on theme status colors
  root.style.setProperty("--spinner-color-1", colors.interactive);
  root.style.setProperty("--spinner-color-2", colors.success);
  root.style.setProperty("--spinner-color-3", colors.warning);
  root.style.setProperty("--spinner-color-4", colors.info);

  // Generate derived gradient tokens using OKLCH color scales (matching Aura)
  const gradientTokens = generateGradientTokens(
    {
      primary: colors.primary,
      success: colors.success,
      warning: colors.warning,
      info: colors.info,
      interactive: colors.interactive,
    },
    isDark
  );

  // Apply gradient tokens matching Aura's naming for consistent appearance
  root.style.setProperty("--text-interactive-base", gradientTokens.textInteractive);
  root.style.setProperty("--surface-info-strong", gradientTokens.surfaceInfoStrong);
  root.style.setProperty("--surface-success-strong", gradientTokens.surfaceSuccessStrong);
  root.style.setProperty("--surface-warning-strong", gradientTokens.surfaceWarningStrong);
  root.style.setProperty("--surface-brand-base", gradientTokens.surfaceBrandBase);

  // Also set background-base for Aura compatibility
  root.style.setProperty("--background-base", colors.background);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<string>(() => {
    if (typeof window === "undefined") return defaultTheme.id;
    return localStorage.getItem(THEME_STORAGE_KEY) ?? defaultTheme.id;
  });

  const [colorMode, setColorModeState] = useState<ColorMode>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(COLOR_MODE_STORAGE_KEY) as ColorMode) ?? "system";
  });

  const [gradientMode, setGradientModeState] = useState<GradientMode>(() => {
    if (typeof window === "undefined") return "soft";
    return (localStorage.getItem(GRADIENT_MODE_STORAGE_KEY) as GradientMode) ?? "soft";
  });

  const [gradientColor, setGradientColorState] = useState<GradientColor>(() => {
    if (typeof window === "undefined") return "relative";
    return (localStorage.getItem(GRADIENT_COLOR_STORAGE_KEY) as GradientColor) ?? "relative";
  });

  const [systemMode, setSystemMode] = useState<"light" | "dark">(getSystemColorMode);

  // Preview state (for hover preview like Aura)
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
  const [previewGradientModeState, setPreviewGradientModeState] = useState<GradientMode | null>(null);
  const [previewGradientColorState, setPreviewGradientColorState] = useState<GradientColor | null>(null);

  // Use preview values if set, otherwise use actual values
  const activeThemeId = previewThemeId ?? themeId;
  const theme = getThemeById(activeThemeId) ?? defaultTheme;

  const resolvedColorMode = colorMode === "system" ? systemMode : colorMode;

  const colors = resolvedColorMode === "dark" ? theme.dark : theme.light;

  // Listen for system color scheme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemMode(e.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Listen for theme changes from other windows via IPC (Electron multi-window sync)
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI) {
      return;
    }
    const unsubscribe = window.electronAPI.onThemeChange((_event, data) => {
      if (data.key === THEME_STORAGE_KEY) {
        setThemeId(data.value);
        setPreviewThemeId(null);
      } else if (data.key === COLOR_MODE_STORAGE_KEY) {
        setColorModeState(data.value as ColorMode);
      } else if (data.key === GRADIENT_MODE_STORAGE_KEY) {
        setGradientModeState(data.value as GradientMode);
        setPreviewGradientModeState(null);
      } else if (data.key === GRADIENT_COLOR_STORAGE_KEY) {
        setGradientColorState(data.value as GradientColor);
        setPreviewGradientColorState(null);
      }
    });
    return unsubscribe;
  }, []);

  // Also listen for localStorage changes (for browser compatibility)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && e.newValue) {
        setThemeId(e.newValue);
        setPreviewThemeId(null);
      } else if (e.key === COLOR_MODE_STORAGE_KEY && e.newValue) {
        setColorModeState(e.newValue as ColorMode);
      } else if (e.key === GRADIENT_MODE_STORAGE_KEY && e.newValue) {
        setGradientModeState(e.newValue as GradientMode);
        setPreviewGradientModeState(null);
      } else if (e.key === GRADIENT_COLOR_STORAGE_KEY && e.newValue) {
        setGradientColorState(e.newValue as GradientColor);
        setPreviewGradientColorState(null);
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Apply theme to document (responds to both actual and preview changes)
  useEffect(() => {
    applyThemeToDocument(colors, resolvedColorMode === "dark");
  }, [colors, resolvedColorMode]);

  const setTheme = useCallback((id: string) => {
    setThemeId(id);
    setPreviewThemeId(null);
    localStorage.setItem(THEME_STORAGE_KEY, id);
    // Broadcast to other windows via IPC (Electron)
    if (typeof window !== "undefined" && window.electronAPI) {
      window.electronAPI.broadcastThemeChange(THEME_STORAGE_KEY, id);
    }
  }, []);

  const setColorMode = useCallback((mode: ColorMode) => {
    setColorModeState(mode);
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
    // Broadcast to other windows via IPC (Electron)
    if (typeof window !== "undefined" && window.electronAPI) {
      window.electronAPI.broadcastThemeChange(COLOR_MODE_STORAGE_KEY, mode);
    }
  }, []);

  const setGradientMode = useCallback((mode: GradientMode) => {
    setGradientModeState(mode);
    setPreviewGradientModeState(null);
    localStorage.setItem(GRADIENT_MODE_STORAGE_KEY, mode);
    // Broadcast to other windows via IPC (Electron)
    if (typeof window !== "undefined" && window.electronAPI) {
      window.electronAPI.broadcastThemeChange(GRADIENT_MODE_STORAGE_KEY, mode);
    }
  }, []);

  const setGradientColor = useCallback((color: GradientColor) => {
    setGradientColorState(color);
    setPreviewGradientColorState(null);
    localStorage.setItem(GRADIENT_COLOR_STORAGE_KEY, color);
    // Broadcast to other windows via IPC (Electron)
    if (typeof window !== "undefined" && window.electronAPI) {
      window.electronAPI.broadcastThemeChange(GRADIENT_COLOR_STORAGE_KEY, color);
    }
  }, []);

  // Preview functions (like Aura)
  const previewTheme = useCallback((id: string) => {
    const previewThemeObj = getThemeById(id);
    if (previewThemeObj) {
      setPreviewThemeId(id);
    }
  }, []);

  const cancelThemePreview = useCallback(() => {
    setPreviewThemeId(null);
  }, []);

  const previewGradientMode = useCallback((mode: GradientMode) => {
    setPreviewGradientModeState(mode);
  }, []);

  const cancelGradientModePreview = useCallback(() => {
    setPreviewGradientModeState(null);
  }, []);

  const previewGradientColor = useCallback((color: GradientColor) => {
    setPreviewGradientColorState(color);
  }, []);

  const cancelGradientColorPreview = useCallback(() => {
    setPreviewGradientColorState(null);
  }, []);

  const cancelPreview = useCallback(() => {
    setPreviewThemeId(null);
    setPreviewGradientModeState(null);
    setPreviewGradientColorState(null);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themeId,
        setTheme,
        colorMode,
        setColorMode,
        resolvedColorMode,
        gradientMode: previewGradientModeState ?? gradientMode,
        setGradientMode,
        gradientColor: previewGradientColorState ?? gradientColor,
        setGradientColor,
        colors,
        themes,
        previewTheme,
        cancelThemePreview,
        previewGradientMode,
        cancelGradientModePreview,
        previewGradientColor,
        cancelGradientColorPreview,
        cancelPreview,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
