import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { useTheme, useThemeControl } from "@/context/theme-context";
import {
  DEFAULT_PERSONALITY_VOICE_ID,
  PERSONALITY_VOICES,
  type PersonalityVoice,
} from "../../../../runtime/extensions/stella-runtime/personality/voices.js";

type ExpressionStyle = "emoji" | "none";

type UseOnboardingAppearanceArgs = {
  isAuthenticated?: boolean;
};

export function useOnboardingAppearance({
  isAuthenticated,
}: UseOnboardingAppearanceArgs) {
  const [expressionStyle, setExpressionStyle] =
    useState<ExpressionStyle>("none");
  const [personalityVoiceId, setPersonalityVoiceIdState] = useState<
    string | null
  >(null);
  const saveExpressionStyle = useMutation(
    api.data.preferences.setExpressionStyle,
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const current =
          (await window.electronAPI?.system?.getPersonalityVoice?.()) ?? null;
        if (!cancelled) {
          setPersonalityVoiceIdState(current);
        }
      } catch {
        // Preference load is best-effort; fall back to null (no selection yet).
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const { theme: activeTheme, themeId, themes, colorMode, gradientMode, gradientColor } =
    useTheme();
  const isForcedTheme = activeTheme.forcedMode !== undefined;
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
      if (isAuthenticated) {
        void saveExpressionStyle({ style }).catch(() => {
          // Expression style sync is best-effort only.
        });
      }
    },
    [isAuthenticated, saveExpressionStyle],
  );

  const selectPersonalityVoice = useCallback((voiceId: string) => {
    setPersonalityVoiceIdState(voiceId);
    const api = window.electronAPI?.system;
    if (!api?.setPersonalityVoice) return;
    void api.setPersonalityVoice(voiceId).catch(() => {
      // Swallow — preference save is best-effort; the next orchestrator turn
      // will re-seed from whatever is on disk.
    });
  }, []);

  const personalityVoices =
    useMemo<readonly PersonalityVoice[]>(() => PERSONALITY_VOICES, []);

  return {
    colorMode,
    expressionStyle,
    gradientColor,
    gradientMode,
    isForcedTheme,
    personalityVoiceId,
    personalityVoices,
    defaultPersonalityVoiceId: DEFAULT_PERSONALITY_VOICE_ID,
    sortedThemes,
    themeId,
    cancelThemePreview,
    previewTheme,
    selectExpressionStyle,
    selectPersonalityVoice,
    selectTheme,
    setColorMode,
    setGradientColor,
    setGradientMode,
  };
}
