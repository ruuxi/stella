import { useCallback, useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

const NATIVE_FONT_SMOOTHING_KEY = "stella-native-font-smoothing";
const NATIVE_FONT_SMOOTHING_CHANGED_EVENT =
  "stella:native-font-smoothing-changed";
const NATIVE_FONT_SMOOTHING_ATTRIBUTE = "data-native-font-smoothing";

// Default on: matches what macOS native apps render (grayscale AA, as
// shipped since Mojave) and keeps Stella's text consistent with the
// surrounding system. Users can flip it off in Settings if they prefer
// Chromium's default subpixel rendering.
const DEFAULT_ENABLED = true;

const readStored = (): boolean => {
  if (typeof window === "undefined") return DEFAULT_ENABLED;
  const raw = uiState.getItem(NATIVE_FONT_SMOOTHING_KEY);
  if (raw === null) return DEFAULT_ENABLED;
  return raw === "true";
};

const applyToDocument = (enabled: boolean) => {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(
    NATIVE_FONT_SMOOTHING_ATTRIBUTE,
    enabled ? "on" : "off",
  );
};

// Apply at module load so the attribute is set before React mounts and
// we never flash a frame of un-smoothed text.
if (typeof window !== "undefined") {
  applyToDocument(readStored());
}

export const getNativeFontSmoothingEnabled = (): boolean => readStored();

export const setNativeFontSmoothingEnabled = (enabled: boolean) => {
  if (typeof window === "undefined") return;
  uiState.setItem(NATIVE_FONT_SMOOTHING_KEY, enabled ? "true" : "false");
  applyToDocument(enabled);
  window.dispatchEvent(
    new CustomEvent(NATIVE_FONT_SMOOTHING_CHANGED_EVENT, {
      detail: { enabled },
    }),
  );
};

export const useNativeFontSmoothingEnabled = (): boolean => {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener("storage", onStoreChange);
    window.addEventListener(NATIVE_FONT_SMOOTHING_CHANGED_EVENT, onStoreChange);
    return () => {
      window.removeEventListener("storage", onStoreChange);
      window.removeEventListener(
        NATIVE_FONT_SMOOTHING_CHANGED_EVENT,
        onStoreChange,
      );
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    getNativeFontSmoothingEnabled,
    () => true,
  );
};
