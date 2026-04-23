import { useEffect, useState } from "react";

const readWindowFocused = () =>
  typeof document === "undefined" ? true : document.hasFocus();

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(readWindowFocused);

  useEffect(() => {
    const update = () => setFocused(readWindowFocused());

    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);

    update();

    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return focused;
}
