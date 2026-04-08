import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type Colors, lightColors, darkColors } from "./colors";
import { themes, defaultThemeId, getThemeById, type StellaTheme } from "./themes";

export type ThemePreference = "light" | "dark" | "system";

type ThemeContextValue = {
  /** Light / Dark / System preference. */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** Currently active theme definition. */
  theme: StellaTheme;
  setThemeId: (id: string) => void;
  /** All available themes. */
  themes: StellaTheme[];
  /** Whether the resolved appearance is dark. */
  isDark: boolean;
  /** Resolved color palette. */
  colors: Colors;
};

const MODE_KEY = "stella-color-mode";
const THEME_KEY = "stella-theme-id";

const fallbackTheme: StellaTheme = {
  id: "__fallback",
  name: "Stella",
  light: lightColors,
  dark: darkColors,
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  setPreference: () => {},
  theme: fallbackTheme,
  setThemeId: () => {},
  themes,
  isDark: false,
  colors: lightColors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [themeId, setThemeIdState] = useState(defaultThemeId);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([
      AsyncStorage.getItem(MODE_KEY),
      AsyncStorage.getItem(THEME_KEY),
    ]).then(([storedMode, storedTheme]) => {
      if (storedMode === "light" || storedMode === "dark" || storedMode === "system") {
        setPreferenceState(storedMode);
      }
      if (storedTheme && getThemeById(storedTheme)) {
        setThemeIdState(storedTheme);
      }
      setLoaded(true);
    });
  }, []);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    void AsyncStorage.setItem(MODE_KEY, p);
  };

  const setThemeId = (id: string) => {
    if (getThemeById(id)) {
      setThemeIdState(id);
      void AsyncStorage.setItem(THEME_KEY, id);
    }
  };

  const isDark =
    preference === "system" ? systemScheme === "dark" : preference === "dark";

  const theme = getThemeById(themeId) ?? fallbackTheme;
  const colors = isDark ? theme.dark : theme.light;

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, setPreference, theme, setThemeId, themes, isDark, colors }),
    [preference, themeId, isDark],
  );

  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).colors;
}
