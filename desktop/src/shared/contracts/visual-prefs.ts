/**
 * Visual prefs for the ASCII creature: which features render.
 *
 * Stored in localStorage so they're available synchronously to the renderer
 * before any Convex round-trip. A custom event lets in-process listeners
 * (e.g. the on-screen creature) react live when the user toggles in
 * onboarding without needing storage events (which only fire cross-tab).
 */

export const VISUAL_PREFS_KEY = "stella-visual-prefs";
export const VISUAL_PREFS_CHANGED_EVENT = "stella:visual-prefs-changed";

export type VisualPrefs = {
  showEyes: boolean;
  showMouth: boolean;
};

export const DEFAULT_VISUAL_PREFS: VisualPrefs = {
  showEyes: true,
  showMouth: false,
};

const isVisualPrefs = (value: unknown): value is VisualPrefs =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as VisualPrefs).showEyes === "boolean" &&
  typeof (value as VisualPrefs).showMouth === "boolean";

export const readVisualPrefs = (): VisualPrefs => {
  if (typeof window === "undefined") return { ...DEFAULT_VISUAL_PREFS };
  try {
    const raw = window.localStorage.getItem(VISUAL_PREFS_KEY);
    if (!raw) return { ...DEFAULT_VISUAL_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!isVisualPrefs(parsed)) return { ...DEFAULT_VISUAL_PREFS };
    return parsed;
  } catch {
    return { ...DEFAULT_VISUAL_PREFS };
  }
};

export const writeVisualPrefs = (prefs: VisualPrefs): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISUAL_PREFS_KEY, JSON.stringify(prefs));
    window.dispatchEvent(
      new CustomEvent<VisualPrefs>(VISUAL_PREFS_CHANGED_EVENT, {
        detail: prefs,
      }),
    );
  } catch {
    // localStorage unavailable (private mode, quota): the renderer keeps its
    // current uniforms; nothing else relies on persistence here.
  }
};
