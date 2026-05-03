import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/shared/lib/utils";
import { useActiveEmojiPack } from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
import {
  cellToRowCol,
  parseEmojiSpriteUrl,
} from "./emoji-sprites/sprite-map";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  isAnimating?: boolean;
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  node?: unknown;
};

const REMARK_PLUGINS = [remarkEmojiSprites];
const EMPTY_REMARK_PLUGINS: [] = [];

const areMarkdownPropsEqual = (
  prev: MarkdownProps,
  next: MarkdownProps,
): boolean =>
  prev.text === next.text &&
  prev.cacheKey === next.cacheKey &&
  prev.className === next.className &&
  Boolean(prev.isAnimating) === Boolean(next.isAnimating);

/**
 * `<img>` override: if the URL is one of our emoji-sprite sentinels,
 * render a CSS-sprite `<span>` instead. Anything else passes through
 * as a normal image. Hoisted so identity is stable across renders —
 * Streamdown's `components` map is otherwise a re-render trigger for
 * every memoized child.
 */
const COMPONENTS = {
  img: ({ src, alt, className, ...rest }: MarkdownImageProps) => {
    const cell =
      typeof src === "string" ? parseEmojiSpriteUrl(src) : null;
    if (!cell) {
      return <img {...rest} src={src} alt={alt} className={className} />;
    }
    const { row, col } = cellToRowCol(cell.cell);
    return (
      <span
        className={cn("ai-emoji", className)}
        style={
          {
            "--ai-emoji-row": String(row),
            "--ai-emoji-col": String(col),
            backgroundImage: `var(--ai-emoji-sheet-${cell.sheet}-url)`,
          } as CSSProperties
        }
        role="img"
        aria-label={alt ?? ""}
      />
    );
  },
};

export const Markdown = memo(function Markdown({
  text,
  className,
  isAnimating = false,
}: MarkdownProps) {
  const [activeEmojiPack] = useActiveEmojiPack();
  const emojiVars = activeEmojiPack
    ? ({
        "--ai-emoji-sheet-0-url": `url("${activeEmojiPack.sheet1Url}")`,
        "--ai-emoji-sheet-1-url": `url("${activeEmojiPack.sheet2Url}")`,
      } as CSSProperties)
    : undefined;
  return (
    <div style={emojiVars}>
      <Streamdown
        isAnimating={isAnimating}
        className={cn("markdown", className)}
        remarkPlugins={activeEmojiPack ? REMARK_PLUGINS : EMPTY_REMARK_PLUGINS}
        components={COMPONENTS}
      >
        {text}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
