import { useState } from "react";

const LONG_PROMPT_CHARS = 100;

export const HeroPrompt = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > LONG_PROMPT_CHARS;


  if (!isLong) {
    return <p className="media-tab__hero-prompt">{text}</p>;
  }

  return (
    <p
      className={`media-tab__hero-prompt media-tab__hero-prompt--truncatable${
        expanded ? " media-tab__hero-prompt--expanded" : ""
      }`}
      title={expanded ? undefined : text}
      onClick={(event) => {
        event.stopPropagation();
        setExpanded((prev) => !prev);
      }}
    >
      {text}
    </p>
  );
};
