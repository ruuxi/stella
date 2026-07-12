import { useCallback, useSyncExternalStore } from "react";

const readWindowFocused = () =>
  typeof document === "undefined" ? true : document.hasFocus();

export function useWindowFocus(): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener("focus", onStoreChange);
    window.addEventListener("blur", onStoreChange);
    document.addEventListener("visibilitychange", onStoreChange);
    return () => {
      window.removeEventListener("focus", onStoreChange);
      window.removeEventListener("blur", onStoreChange);
      document.removeEventListener("visibilitychange", onStoreChange);
    };
  }, []);

  return useSyncExternalStore(subscribe, readWindowFocused, () => true);
}
