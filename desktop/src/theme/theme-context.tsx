/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { themes, getThemeById, defaultTheme, registerTheme, type Theme, type ThemeColors } from "./themes";
import { generateGradientTokens } from "./color";

type ColorMode = "light" | "dark" | "system";
type GradientMode = "soft" | "crisp";
type GradientColor = "relative" | "strong";

// ─── Stable read-only context (rarely changes) ────────────────────────────

interface ThemeReadValue {
  theme: Theme;
  themeId: string;
  colorMode: ColorMode;
  resolvedColorMode: "light" | "dark";
  gradientMode: GradientMode;
  gradientColor: GradientColor;
  colors: ThemeColors;
  themes: Theme[];
}

// ─── Control context (mutators + preview, only used by ThemePicker/Onboarding) ─

interface ThemeControlValue {
  setTheme: (id: string) => void;
  setColorMode: (mode: ColorMode) => void;
  setGradientMode: (mode: GradientMode) => void;
  setGradientColor: (color: GradientColor) => void;
  previewTheme: (id: string) => void;
  cancelThemePreview: () => void;
  previewGradientMode: (mode: GradientMode) => void;
  cancelGradientModePreview: () => void;
  previewGradientColor: (color: GradientColor) => void;
  cancelGradientColorPreview: () => void;
  cancelPreview: () => void;
}

const ThemeReadContext = createContext<ThemeReadValue | null>(null);
const ThemeControlContext = createContext<ThemeControlValue | null>(null);

const THEME_STORAGE_KEY = "stella-theme-id";
const COLOR_MODE_STORAGE_KEY = "stella-color-mode";
const GRADIENT_MODE_STORAGE_KEY = "stella-gradient-mode";
const GRADIENT_COLOR_STORAGE_KEY = "stella-gradient-color";

function getSystemColorMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(colors: ThemeColors, isDark: boolean) {
  const root = document.documentElement;

  root.classList.toggle("dark", isDark);
  root.style.setProperty("color-scheme", isDark ? "dark" : "light");
  root.style.setProperty("--text-mix-blend-mode", isDark ? "plus-lighter" : "multiply");

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

  root.style.setProperty("--spinner-color-1", colors.interactive);
  root.style.setProperty("--spinner-color-2", colors.success);
  root.style.setProperty("--spinner-color-3", colors.warning);
  root.style.setProperty("--spinner-color-4", colors.info);

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

  root.style.setProperty("--text-interactive-base", gradientTokens.textInteractive);
  root.style.setProperty("--surface-info-strong", gradientTokens.surfaceInfoStrong);
  root.style.setProperty("--surface-success-strong", gradientTokens.surfaceSuccessStrong);
  root.style.setProperty("--surface-warning-strong", gradientTokens.surfaceWarningStrong);
  root.style.setProperty("--surface-brand-base", gradientTokens.surfaceBrandBase);
  root.style.setProperty("--background-base", colors.background);
}

// ─── Persistence helpers ─────────────────────────────────────────────────

function readStorage<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T) ?? fallback;
}

function persistAndBroadcast(key: string, value: string) {
  localStorage.setItem(key, value);
  if (window.electronAPI) {
    window.electronAPI.theme.broadcast(key, value);
  }
}

// ─── useThemePersistence — localStorage + IPC sync ───────────────────────

interface PersistedThemeState {
  themeId: string;
  colorMode: ColorMode;
  gradientMode: GradientMode;
  gradientColor: GradientColor;
  systemMode: "light" | "dark";
  setThemeId: (id: string) => void;
  setColorMode: (mode: ColorMode) => void;
  setGradientMode: (mode: GradientMode) => void;
  setGradientColor: (color: GradientColor) => void;
}

function useThemePersistence(
  clearPreviews: () => void,
): PersistedThemeState {
  const [themeId, setThemeIdRaw] = useState(() => readStorage(THEME_STORAGE_KEY, defaultTheme.id));
  const [colorMode, setColorModeRaw] = useState(() => readStorage<ColorMode>(COLOR_MODE_STORAGE_KEY, "light"));
  const [gradientMode, setGradientModeRaw] = useState(() => readStorage<GradientMode>(GRADIENT_MODE_STORAGE_KEY, "soft"));
  const [gradientColor, setGradientColorRaw] = useState(() => readStorage<GradientColor>(GRADIENT_COLOR_STORAGE_KEY, "strong"));
  const [systemMode, setSystemMode] = useState<"light" | "dark">(getSystemColorMode);

  useEffect(() => {
    if (!window.electronAPI) return;
    if (!window.electronAPI.theme.listInstalled) return;
    window.electronAPI.theme.listInstalled().then((installed) => {
      if (Array.isArray(installed)) {
        for (const t of installed) registerTheme(t);
      }
    }).catch((err) => {
      console.debug('[theme] Failed to load installed themes:', (err as Error).message);
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemMode(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.theme.onChange((_event, data) => {
      if (data.key === THEME_STORAGE_KEY) { setThemeIdRaw(data.value); clearPreviews(); }
      else if (data.key === COLOR_MODE_STORAGE_KEY) setColorModeRaw(data.value as ColorMode);
      else if (data.key === GRADIENT_MODE_STORAGE_KEY) { setGradientModeRaw(data.value as GradientMode); clearPreviews(); }
      else if (data.key === GRADIENT_COLOR_STORAGE_KEY) { setGradientColorRaw(data.value as GradientColor); clearPreviews(); }
    });
  }, [clearPreviews]);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && e.newValue) { setThemeIdRaw(e.newValue); clearPreviews(); }
      else if (e.key === COLOR_MODE_STORAGE_KEY && e.newValue) setColorModeRaw(e.newValue as ColorMode);
      else if (e.key === GRADIENT_MODE_STORAGE_KEY && e.newValue) { setGradientModeRaw(e.newValue as GradientMode); clearPreviews(); }
      else if (e.key === GRADIENT_COLOR_STORAGE_KEY && e.newValue) { setGradientColorRaw(e.newValue as GradientColor); clearPreviews(); }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [clearPreviews]);

  const setThemeId = useCallback((id: string) => { setThemeIdRaw(id); persistAndBroadcast(THEME_STORAGE_KEY, id); }, []);
  const setColorMode = useCallback((mode: ColorMode) => { setColorModeRaw(mode); persistAndBroadcast(COLOR_MODE_STORAGE_KEY, mode); }, []);
  const setGradientMode = useCallback((mode: GradientMode) => { setGradientModeRaw(mode); persistAndBroadcast(GRADIENT_MODE_STORAGE_KEY, mode); }, []);
  const setGradientColor = useCallback((color: GradientColor) => { setGradientColorRaw(color); persistAndBroadcast(GRADIENT_COLOR_STORAGE_KEY, color); }, []);

  return { themeId, colorMode, gradientMode, gradientColor, systemMode, setThemeId, setColorMode, setGradientMode, setGradientColor };
}

// ─── useThemePreview — temporary preview state ───────────────────────────

interface ThemePreviewState {
  previewThemeId: string | null;
  previewGradientMode: GradientMode | null;
  previewGradientColor: GradientColor | null;
  setPreviewTheme: (id: string) => void;
  cancelThemePreview: () => void;
  setPreviewGradientMode: (mode: GradientMode) => void;
  cancelGradientModePreview: () => void;
  setPreviewGradientColor: (color: GradientColor) => void;
  cancelGradientColorPreview: () => void;
  clearAll: () => void;
}

function useThemePreview(): ThemePreviewState {
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
  const [previewGradientMode, setPreviewGradientModeRaw] = useState<GradientMode | null>(null);
  const [previewGradientColor, setPreviewGradientColorRaw] = useState<GradientColor | null>(null);

  const setPreviewTheme = useCallback((id: string) => { if (getThemeById(id)) setPreviewThemeId(id); }, []);
  const cancelThemePreview = useCallback(() => setPreviewThemeId(null), []);
  const setPreviewGradientMode = useCallback((mode: GradientMode) => setPreviewGradientModeRaw(mode), []);
  const cancelGradientModePreview = useCallback(() => setPreviewGradientModeRaw(null), []);
  const setPreviewGradientColor = useCallback((color: GradientColor) => setPreviewGradientColorRaw(color), []);
  const cancelGradientColorPreview = useCallback(() => setPreviewGradientColorRaw(null), []);
  const clearAll = useCallback(() => {
    setPreviewThemeId(null);
    setPreviewGradientModeRaw(null);
    setPreviewGradientColorRaw(null);
  }, []);

  return {
    previewThemeId, previewGradientMode, previewGradientColor,
    setPreviewTheme, cancelThemePreview,
    setPreviewGradientMode, cancelGradientModePreview,
    setPreviewGradientColor, cancelGradientColorPreview,
    clearAll,
  };
}

// ─── ThemeProvider ───────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preview = useThemePreview();
  const persisted = useThemePersistence(preview.clearAll);

  const activeThemeId = preview.previewThemeId ?? persisted.themeId;
  const theme = getThemeById(activeThemeId) ?? defaultTheme;
  const resolvedColorMode = persisted.colorMode === "system" ? persisted.systemMode : persisted.colorMode;
  const colors = resolvedColorMode === "dark" ? theme.dark : theme.light;
  const effectiveGradientMode = preview.previewGradientMode ?? persisted.gradientMode;
  const effectiveGradientColor = preview.previewGradientColor ?? persisted.gradientColor;

  useEffect(() => {
    applyThemeToDocument(colors, resolvedColorMode === "dark");
  }, [colors, resolvedColorMode]);

  const readValue = useMemo<ThemeReadValue>(
    () => ({
      theme, themeId: persisted.themeId, colorMode: persisted.colorMode, resolvedColorMode,
      gradientMode: effectiveGradientMode, gradientColor: effectiveGradientColor, colors, themes,
    }),
    [theme, persisted.themeId, persisted.colorMode, resolvedColorMode, effectiveGradientMode, effectiveGradientColor, colors],
  );

  const controlValue = useMemo<ThemeControlValue>(
    () => ({
      setTheme: (id: string) => { persisted.setThemeId(id); preview.cancelThemePreview(); },
      setColorMode: persisted.setColorMode,
      setGradientMode: (mode: GradientMode) => { persisted.setGradientMode(mode); preview.cancelGradientModePreview(); },
      setGradientColor: (color: GradientColor) => { persisted.setGradientColor(color); preview.cancelGradientColorPreview(); },
      previewTheme: preview.setPreviewTheme,
      cancelThemePreview: preview.cancelThemePreview,
      previewGradientMode: preview.setPreviewGradientMode,
      cancelGradientModePreview: preview.cancelGradientModePreview,
      previewGradientColor: preview.setPreviewGradientColor,
      cancelGradientColorPreview: preview.cancelGradientColorPreview,
      cancelPreview: preview.clearAll,
    }),
    [persisted, preview],
  );

  return (
    <ThemeReadContext.Provider value={readValue}>
      <ThemeControlContext.Provider value={controlValue}>
        {children}
      </ThemeControlContext.Provider>
    </ThemeReadContext.Provider>
  );
}

/** Read-only theme values. Most components should use this. */
export function useTheme(): ThemeReadValue {
  const context = useContext(ThemeReadContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

/** Theme mutation and preview controls. Only used by theme pickers. */
export function useThemeControl(): ThemeControlValue {
  const context = useContext(ThemeControlContext);
  if (!context) {
    throw new Error("useThemeControl must be used within a ThemeProvider");
  }
  return context;
}
