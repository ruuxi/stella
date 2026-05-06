/**
 * Remark plugin: replace known emojis in text nodes with image nodes
 * pointing at the AI sprite-sheet cell that should render in their
 * place.
 *
 * Runs as part of Streamdown's normal parse, so the swap happens before
 * the markdown AST becomes hast/HTML — there's no post-render DOM walk
 * and no extra rerender path. Streamdown's parse cache reuses the
 * unchanged spans from previous chunks during streaming.
 *
 * The injected nodes are real `image` mdast nodes with a sentinel URL
 * (see `buildEmojiSpriteUrl`); the markdown `img` component override
 * detects that URL shape and renders a CSS-sprite `<span>` instead of
 * an `<img>`. Falling back to `<img>` if the override is bypassed
 * still yields a valid (if oversized) image, since the URL points at
 * the real sprite asset.
 */

import type { Plugin } from "unified";
import type { Image, Parent, Root, RootContent, Text } from "mdast";
import {
  buildEmojiSpriteUrl,
  cloneEmojiRegex,
  getEmojiSpriteCell,
} from "./sprite-map";

const isText = (node: RootContent): node is Text => node.type === "text";

const buildImageNode = (emoji: string): Image | null => {
  const cell = getEmojiSpriteCell(emoji);
  if (!cell) return null;
  return {
    type: "image",
    url: buildEmojiSpriteUrl(cell),
    alt: emoji,
    title: null,
  };
};

const splitTextNode = (node: Text): RootContent[] | null => {
  const value = node.value;
  if (!value) return null;
  const re = cloneEmojiRegex();
  let match: RegExpExecArray | null;
  let cursor = 0;
  const out: RootContent[] = [];
  let touched = false;
  while ((match = re.exec(value)) !== null) {
    const image = buildImageNode(match[0]);
    if (!image) continue;
    if (match.index > cursor) {
      out.push({
        type: "text",
        value: value.slice(cursor, match.index),
      } satisfies Text);
    }
    out.push(image);
    cursor = match.index + match[0].length;
    touched = true;
  }
  if (!touched) return null;
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) } satisfies Text);
  }
  return out;
};

const transformChildren = (parent: Parent): void => {
  // Walk in reverse so splice indices stay correct as we replace nodes.
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!;
    if (isText(child as RootContent)) {
      const replacements = splitTextNode(child as Text);
      if (replacements) {
        parent.children.splice(index, 1, ...(replacements as Parent["children"]));
      }
      continue;
    }
    // Don't recurse into nodes whose textual children should remain
    // literal (code, inline code, math, html). For everything else,
    // walk the subtree.
    const type = String((child as RootContent).type);
    if (
      type === "code" ||
      type === "inlineCode" ||
      type === "html" ||
      type === "math" ||
      type === "inlineMath"
    ) {
      continue;
    }
    if ("children" in child && Array.isArray((child as Parent).children)) {
      transformChildren(child as Parent);
    }
  }
};

export const remarkEmojiSprites: Plugin<[], Root> = () => {
  return (tree) => {
    transformChildren(tree as Parent);
  };
};
