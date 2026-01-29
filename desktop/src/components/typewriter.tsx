import * as React from "react";
import { cn } from "@/lib/utils";

export interface TypewriterProps {
  text?: string;
  className?: string;
  as?: React.ElementType;
}

export function Typewriter({ text, className, as: Component = "p" }: TypewriterProps) {
  const [displayed, setDisplayed] = React.useState("");
  const [cursor, setCursor] = React.useState(false);
  const [typing, setTyping] = React.useState(false);

  React.useEffect(() => {
    if (!text) {
      setTyping(false);
      setDisplayed("");
      setCursor(false);
      return;
    }

    let i = 0;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    setTyping(true);
    setDisplayed("");
    setCursor(true);

    const getTypingDelay = () => {
      const random = Math.random();
      if (random < 0.05) return 150 + Math.random() * 100;
      if (random < 0.15) return 80 + Math.random() * 60;
      return 30 + Math.random() * 50;
    };

    const type = () => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
        timeouts.push(setTimeout(type, getTypingDelay()));
      } else {
        setTyping(false);
        timeouts.push(setTimeout(() => setCursor(false), 2000));
      }
    };

    timeouts.push(setTimeout(type, 200));

    return () => {
      for (const timeout of timeouts) clearTimeout(timeout);
    };
  }, [text]);

  return React.createElement(
    Component,
    { className: cn("typewriter", className) },
    <>
      {displayed}
      {cursor && (
        <span className={typing ? "" : "blinking-cursor"}>│</span>
      )}
    </>
  );
}
