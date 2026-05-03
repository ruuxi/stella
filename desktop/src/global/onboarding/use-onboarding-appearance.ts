import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useTheme, useThemeControl } from "@/context/theme-context";

type ExpressionStyle = "emotes" | "emoji" | "none";

type UseOnboardingAppearanceArgs = {
  isAuthenticated?: boolean;
};

export function useOnboardingAppearance({
  isAuthenticated,
}: UseOnboardingAppearanceArgs) {
  const [expressionStyle, setExpressionStyle] =
    useState<ExpressionStyle>("none");
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

  return {
    colorMode,
    expressionStyle,
    gradientColor,
    gradientMode,
    sortedThemes,
    themeId,
    cancelThemePreview,
    previewTheme,
    selectExpressionStyle,
    selectTheme,
    setColorMode,
    setGradientColor,
    setGradientMode,
  };
}
