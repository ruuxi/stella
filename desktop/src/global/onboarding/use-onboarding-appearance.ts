import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useTheme, useThemeControl } from "@/context/theme-context";
import {
  readVisualPrefs,
  writeVisualPrefs,
} from "@/shared/contracts/visual-prefs";

type ExpressionStyle = "emotes" | "emoji" | "none";

type UseOnboardingAppearanceArgs = {
  isAuthenticated?: boolean;
};

export function useOnboardingAppearance({
  isAuthenticated,
}: UseOnboardingAppearanceArgs) {
  const [expressionStyle, setExpressionStyle] =
    useState<ExpressionStyle>("none");
  const [visualPrefs, setVisualPrefs] = useState(() => readVisualPrefs());
  const saveExpressionStyle = useMutation(
    api.data.preferences.setExpressionStyle,
  );

  const { themeId, themes, colorMode, gradientMode, gradientColor } =
    useTheme();
  const {
    setTheme,
    setColorMode,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
    setGradientMode,
    setGradientColor,
  } = useThemeControl();

  const sortedThemes = useMemo(
    () => [...themes].sort((a, b) => a.name.localeCompare(b.name)),
    [themes],
  );

  const selectTheme = useCallback(
    (id: string) => {
      setTheme(id);
      cancelPreview();
    },
    [cancelPreview, setTheme],
  );

  const selectExpressionStyle = useCallback(
    (style: ExpressionStyle) => {
      setExpressionStyle(style);
      const backendStyle = style === "none" ? "none" : "emoji";
      if (isAuthenticated) {
        void saveExpressionStyle({ style: backendStyle }).catch(() => {
          // Expression style sync is best-effort only.
        });
      }
    },
    [isAuthenticated, saveExpressionStyle],
  );

  // Side-effects belong outside the state updater (which React may invoke
  // twice in StrictMode / dev). Read the current snapshot, derive the
  // next value, persist, then commit — so localStorage is written exactly
  // once per toggle.
  const toggleEyes = useCallback(() => {
    setVisualPrefs((current) => {
      const next = { ...current, showEyes: !current.showEyes };
      queueMicrotask(() => writeVisualPrefs(next));
      return next;
    });
  }, []);

  const toggleMouth = useCallback(() => {
    setVisualPrefs((current) => {
      const next = { ...current, showMouth: !current.showMouth };
      queueMicrotask(() => writeVisualPrefs(next));
      return next;
    });
  }, []);

  return {
    colorMode,
    expressionStyle,
    gradientColor,
    gradientMode,
    showEyes: visualPrefs.showEyes,
    showMouth: visualPrefs.showMouth,
    sortedThemes,
    themeId,
    cancelThemePreview,
    previewTheme,
    selectExpressionStyle,
    selectTheme,
    setColorMode,
    setGradientColor,
    setGradientMode,
    toggleEyes,
    toggleMouth,
  };
}
