import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { cn } from "@/shared/lib/utils";
import { useActiveEmojiPack } from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
import {
  cellToRowCol,
  getEmojiSpriteGridSize,
  parseEmojiSpriteUrl,
} from "./emoji-sprites/sprite-map";
import { useEmojiGridManifest } from "./emoji-sprites/use-emoji-grid-manifest";
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

/*
 * Streamdown's `remarkPlugins` prop *replaces* its defaults (which
 * include `remark-gfm` for tables/strikethrough/task lists), so we
 * have to spread its defaults back in alongside our additions.
 * `defaultRemarkPlugins` is exported as a `Record<string, Pluggable>`
 * map; the prop wants an array, so unwrap with `Object.values`.
 */
const DEFAULT_REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const REMARK_PLUGINS = [...DEFAULT_REMARK_PLUGINS, remarkEmojiSprites];

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
    const gridSize = getEmojiSpriteGridSize();
    const last = Math.max(1, gridSize - 1);
    return (
      <span
        className={cn("ai-emoji", className)}
        style={
          {
            "--ai-emoji-row": String(row),
            "--ai-emoji-col": String(col),
            backgroundImage: `var(--ai-emoji-sheet-${cell.sheet}-url)`,
            backgroundSize: `${gridSize * 100}% ${gridSize * 100}%`,
            backgroundPosition: `${(col / last) * 100}% ${(row / last) * 100}%`,
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
  const emojiGrid = useEmojiGridManifest();
  const emojiVars = activeEmojiPack && emojiGrid
    ? (Object.fromEntries(
        activeEmojiPack.sheetUrls.map((url, index) => [
          `--ai-emoji-sheet-${index}-url`,
          `url("${url}")`,
        ]),
      ) as CSSProperties)
    : undefined;
  return (
    <div style={emojiVars}>
      <Streamdown
        isAnimating={isAnimating}
        className={cn("markdown", className)}
        remarkPlugins={
          activeEmojiPack && emojiGrid
            ? REMARK_PLUGINS
            : DEFAULT_REMARK_PLUGINS
        }
        components={COMPONENTS}
      >
        {text}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
