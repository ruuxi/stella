import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/shared/lib/utils";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  isAnimating?: boolean;
}

const areMarkdownPropsEqual = (
  prev: MarkdownProps,
  next: MarkdownProps,
): boolean => (
  prev.text === next.text &&
  prev.cacheKey === next.cacheKey &&
  prev.className === next.className &&
  Boolean(prev.isAnimating) === Boolean(next.isAnimating)
);

export const Markdown = memo(function Markdown({
  text,
  className,
  isAnimating = false,
}: MarkdownProps) {
  return (
    <Streamdown
      isAnimating={isAnimating}
      className={cn("markdown", className)}
    >
      {text}
    </Streamdown>
  );
}, areMarkdownPropsEqual);
