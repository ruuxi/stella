import { useCallback, useEffect, useState } from "react";

export const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";
const ONBOARDING_COMPLETE_EVENT = "stella:onboarding-complete-changed";

const readOnboardingCompleted = () => {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
};

export function useOnboardingState() {
  const [completed, setCompleted] = useState(() => {
    return readOnboardingCompleted();
  });

  useEffect(() => {
    const syncFromStorage = () => {
      setCompleted(readOnboardingCompleted());
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== ONBOARDING_COMPLETE_KEY) return;
      syncFromStorage();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(ONBOARDING_COMPLETE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(ONBOARDING_COMPLETE_EVENT, syncFromStorage);
    };
  }, []);

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setCompleted(true);
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setCompleted(false);
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
  }, []);

  return { completed, complete, reset };
}
