import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
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

const REMARK_PLUGINS = [remarkEmojiSprites];
const EMPTY_REMARK_PLUGINS: [] = [];

/**
 * GFM tables strictly require each row on its own line, but models
 * occasionally emit a table inline (header + `|---|---|` separator +
 * body rows all on one line). Detect that exact shape and re-break it
 * so Streamdown's GFM parser can render an actual table. Idempotent —
 * a correctly-line-broken table is untouched because the separator
 * already sits on its own line and the leading anchor won't match.
 */
const INLINE_GFM_TABLE_RE =
  /(\|[^\n|]+(?:\|[^\n|]+)+\|)[ \t]+(\|[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|)((?:[ \t]+\|[^\n|]+(?:\|[^\n|]+)+\|)+)/g;

const normalizeInlineGfmTables = (text: string): string => {
  if (!text.includes("|---") && !text.includes("| ---")) return text;
  return text.replace(
    INLINE_GFM_TABLE_RE,
    (_match, header: string, separator: string, body: string) => {
      const rows = body
        .trim()
        .split(/[ \t]+(?=\|)/g)
        .map((row) => row.trim())
        .filter(Boolean);
      return `\n\n${header}\n${separator}\n${rows.join("\n")}\n`;
    },
  );
};

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
  const normalizedText = useMemo(() => normalizeInlineGfmTables(text), [text]);
  return (
    <div style={emojiVars}>
      <Streamdown
        isAnimating={isAnimating}
        className={cn("markdown", className)}
        remarkPlugins={
          activeEmojiPack && emojiGrid ? REMARK_PLUGINS : EMPTY_REMARK_PLUGINS
        }
        components={COMPONENTS}
      >
        {normalizedText}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
