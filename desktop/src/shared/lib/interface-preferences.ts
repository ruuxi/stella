import { useEffect, useState } from "react";
import { uiState } from "@/platform/ui-state";

export type ReduceMotionPreference = "system" | "on" | "off";

const REDUCE_MOTION_KEY = "stella-reduce-motion";
const INTERFACE_PREFERENCES_CHANGED_EVENT =
  "stella:interface-preferences-changed";
const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion";

const isReduceMotionPreference = (
  value: string | null,
): value is ReduceMotionPreference =>
  value === "system" || value === "on" || value === "off";

const readReduceMotionPreference = (): ReduceMotionPreference => {
  if (typeof window === "undefined") return "system";
  const raw = uiState.getItem(REDUCE_MOTION_KEY);
  return isReduceMotionPreference(raw) ? raw : "system";
};

const systemPrefersReducedMotion = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
};

const resolveReduceMotion = (preference: ReduceMotionPreference): boolean => {
  if (preference === "on") return true;
  if (preference === "off") return false;
  return systemPrefersReducedMotion();
};

const applyToDocument = (reduceMotionPreference: ReduceMotionPreference) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(
    REDUCE_MOTION_ATTRIBUTE,
    resolveReduceMotion(reduceMotionPreference) ? "reduce" : "no-preference",
  );
};

const dispatchChanged = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(INTERFACE_PREFERENCES_CHANGED_EVENT));
};

if (typeof window !== "undefined") {
  applyToDocument(readReduceMotionPreference());

  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  media?.addEventListener?.("change", () => {
    if (readReduceMotionPreference() === "system") {
      applyToDocument("system");
      dispatchChanged();
    }
  });
}

export const getReduceMotionPreference = (): ReduceMotionPreference =>
  readReduceMotionPreference();

export const setReduceMotionPreference = (
  preference: ReduceMotionPreference,
) => {
  if (typeof window === "undefined") return;
  uiState.setItem(REDUCE_MOTION_KEY, preference);
  applyToDocument(preference);
  dispatchChanged();
};

export const useInterfacePreferences = () => {
  const [reduceMotion, setReduceMotionState] = useState(
    getReduceMotionPreference,
  );

  useEffect(() => {
    const sync = () => {
      setReduceMotionState(getReduceMotionPreference());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(INTERFACE_PREFERENCES_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(INTERFACE_PREFERENCES_CHANGED_EVENT, sync);
    };
  }, []);

  return { reduceMotion };
};
