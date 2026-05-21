import { useEffect, useState } from "react";

const LONG_PROMPT_CHARS = 100;

export const HeroPrompt = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > LONG_PROMPT_CHARS;

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  return (
    <p
      className={[
        "media-tab__hero-prompt",
        expanded ? "media-tab__hero-prompt--expanded" : null,
        isLong ? "media-tab__hero-prompt--truncatable" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      title={!expanded && isLong ? text : undefined}
      onClick={
        isLong
          ? (event) => {
              event.stopPropagation();
              setExpanded((prev) => !prev);
            }
          : undefined
      }
    >
      {text}
    </p>
  );
};
