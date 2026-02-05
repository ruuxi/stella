import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  isAnimating?: boolean;
}

export function Markdown({ text, className, isAnimating = false }: MarkdownProps) {
  return (
    <Streamdown
      isAnimating={isAnimating}
      className={cn("markdown", className)}
    >
      {text}
    </Streamdown>
  );
}
