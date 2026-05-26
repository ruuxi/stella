import type { CSSProperties, ImgHTMLAttributes } from "react";
import { memo, useMemo, useRef } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import { cn } from "@/shared/lib/utils";
import {
  hasCompleteEmojiSpritePack,
  useActiveEmojiPack,
} from "./emoji-sprites/active-emoji-pack";
import { remarkEmojiSprites } from "./emoji-sprites/remark-emoji-sprites";
import {
  cellToRowCol,
  getEmojiSpriteGridSize,
  parseEmojiSpriteUrl,
} from "./emoji-sprites/sprite-map";
import "./markdown.css";

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
  /** Suppress GFM horizontal rules (`---`). Used in chat bubbles where
   *  models often append a trailing rule that reads as a message divider. */
  hideHorizontalRules?: boolean;
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
 *
 * `BASE_REMARK_PLUGINS` is the default Streamdown set. The emoji sprite
 * plugin is added only when a complete active pack is present; otherwise
 * native Unicode emoji must remain visible.
 */
const DEFAULT_REMARK_PLUGINS = Object.values(defaultRemarkPlugins);
const BASE_REMARK_PLUGINS = [...DEFAULT_REMARK_PLUGINS];

/*
 * Streamdown's `rehypePlugins` prop, like `remarkPlugins`, *replaces*
 * its defaults — re-spread them so harden / sanitize / raw stay in
 * place. The word-fade plugin appends after them so it observes the
 * post-sanitize HAST (and inherits the same allow-list).
 */
const DEFAULT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins);

/*
 * Disable Streamdown's built-in "Open external link?" confirmation modal.
 *
 * We don't need it because the Electron main process already gates every
 * external open through `ExternalLinkService.setupExternalLinkHandlers`
 * (`setWindowOpenHandler` + `will-navigate` → `shell.openExternal`), so
 * a chat link click is already routed safely to the OS browser without
 * any in-renderer confirmation.
 *
 * Leaving it enabled caused three regressions in the chat surface:
 *   1. Streamdown rendered each link as a `<button>` and called
 *      `preventDefault()`, which made the surrounding message bubble pick
 *      up button focus / active styling on click ("the message gets
 *      highlighted").
 *   2. Streamdown's modal uses `position: fixed`, but our chat list is
 *      virtualized by `@legendapp/list` which applies `transform` to row
 *      containers — a transformed ancestor traps `position: fixed`, so
 *      the modal would render centered on the clicked *message* instead
 *      of the viewport.
 *   3. The modal carried Streamdown's own card chrome, not the
 *      Connect-dialog aesthetic the rest of the app uses.
 *
 * With `enabled: false`, links render as plain `<a target="_blank">` and
 * Electron's main-process handlers take over.
 */
const LINK_SAFETY = { enabled: false } as const;

const areMarkdownPropsEqual = (
  prev: MarkdownProps,
  next: MarkdownProps,
): boolean =>
  prev.text === next.text &&
  prev.cacheKey === next.cacheKey &&
  prev.className === next.className &&
  Boolean(prev.hideHorizontalRules) === Boolean(next.hideHorizontalRules);

const MarkdownImage = ({
  src,
  alt,
  className,
  ...rest
}: MarkdownImageProps) => {
  const cell = typeof src === "string" ? parseEmojiSpriteUrl(src) : null;
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
};

const buildComponents = (hideHorizontalRules: boolean) => ({
  ...(hideHorizontalRules ? { hr: () => null } : {}),
  img: MarkdownImage,
});

let nextAnonCacheKey = 0;

export const Markdown = memo(function Markdown({
  text,
  cacheKey,
  className,
  hideHorizontalRules = false,
}: MarkdownProps) {
  /*
   * Stable per-instance fallback when the caller didn't supply one,
   * matching Streamdown's per-row parse/cache expectations. Bumped
   * lazily so server-side / first-render parity stays intact.
   */
  const anonCacheKeyRef = useRef<string | null>(null);
  if (anonCacheKeyRef.current === null) {
    anonCacheKeyRef.current = `markdown-anon-${nextAnonCacheKey++}`;
  }
  const effectiveCacheKey = cacheKey ?? anonCacheKeyRef.current;
  const components = useMemo(
    () => buildComponents(hideHorizontalRules),
    [hideHorizontalRules],
  );
  const [activeEmojiPack] = useActiveEmojiPack();
  const emojiSpritesEnabled = hasCompleteEmojiSpritePack(activeEmojiPack);
  const remarkPlugins = useMemo(
    () =>
      emojiSpritesEnabled
        ? [...BASE_REMARK_PLUGINS, remarkEmojiSprites]
        : BASE_REMARK_PLUGINS,
    [emojiSpritesEnabled],
  );
  /*
   * `emojiVars` is memoized so the outer `<div>`'s `style` reference is
   * stable across renders when the active emoji pack hasn't changed.
   * Otherwise React would diff the style object identity every commit
   * and write the same custom-property declarations back to the DOM —
   * harmless but pointless work that can mask other identity issues
   * during debugging.
   */
  const emojiVars = useMemo<CSSProperties | undefined>(() => {
    if (!emojiSpritesEnabled || !activeEmojiPack) return undefined;
    return Object.fromEntries(
      activeEmojiPack.sheetUrls.map((url, index) => [
        `--ai-emoji-sheet-${index}-url`,
        `url("${url}")`,
      ]),
    ) as CSSProperties;
  }, [activeEmojiPack, emojiSpritesEnabled]);
  const streamdownKey = `${effectiveCacheKey}:${emojiSpritesEnabled ? "emoji" : "plain"}`;
  return (
    <div style={emojiVars}>
      <Streamdown
        key={streamdownKey}
        className={cn("markdown", className)}
        remarkPlugins={remarkPlugins}
        rehypePlugins={DEFAULT_REHYPE_PLUGINS}
        components={components}
        linkSafety={LINK_SAFETY}
      >
        {text}
      </Streamdown>
    </div>
  );
}, areMarkdownPropsEqual);
