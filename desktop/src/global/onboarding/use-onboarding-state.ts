import { useCallback, useEffect, useState } from "react";

export const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";

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
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== ONBOARDING_COMPLETE_KEY) return;
      setCompleted(event.newValue === "true");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}
