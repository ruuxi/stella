export const EMOTE_URL_MARKER = "#stella-emote";
const VARIATION_SELECTOR_16 = /\uFE0F/g;

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdastNode[];
};

const SKIP_PARENT_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "image",
  "html",
]);
const EMOTE_CORE_SPLIT_RE = /^([([{'"`]*)(.+?)([)\]}'"`,.!?;]*)$/;
const WHITESPACE_CAPTURE_RE = /(\s+)/;

const markEmoteUrl = (url: string) => {
  if (url.includes(EMOTE_URL_MARKER)) {
    return url;
  }
  return `${url}${EMOTE_URL_MARKER}`;
};

export const isMarkedEmoteUrl = (url: string) => url.includes(EMOTE_URL_MARKER);

export const stripEmoteUrlMarker = (url: string) =>
  url.replace(EMOTE_URL_MARKER, "");

const splitToken = (token: string) => {
  const match = token.match(EMOTE_CORE_SPLIT_RE);
  if (!match) {
    return { leading: "", core: token, trailing: "" };
  }
  return {
    leading: match[1] ?? "",
    core: match[2] ?? token,
    trailing: match[3] ?? "",
  };
};

const stripEmojiVariants = (value: string) =>
  value.replace(VARIATION_SELECTOR_16, "");

const resolveEmojiUrl = (
  value: string,
  emojiLookup: ReadonlyMap<string, string>,
) => {
  if (emojiLookup.has(value)) {
    return emojiLookup.get(value) ?? null;
  }
  const normalized = stripEmojiVariants(value);
  if (!normalized) {
    return null;
  }
  return emojiLookup.get(normalized) ?? null;
};

const imageNode = (url: string): MdastNode => ({
  type: "image",
  url: markEmoteUrl(url),
  alt: "",
});

export const transformTextWithEmotes = (
  text: string,
  emojiLookup: ReadonlyMap<string, string>,
): MdastNode[] => {
  if (!text || emojiLookup.size === 0) {
    return [{ type: "text", value: text }];
  }

  const nodes: MdastNode[] = [];
  const parts = text.split(WHITESPACE_CAPTURE_RE);

  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      nodes.push({ type: "text", value: part });
      continue;
    }

    const directUrl = resolveEmojiUrl(part, emojiLookup);
    if (directUrl) {
      nodes.push(imageNode(directUrl));
      continue;
    }

    const { leading, core, trailing } = splitToken(part);
    const wrappedUrl = resolveEmojiUrl(core, emojiLookup);
    if (wrappedUrl) {
      if (leading) {
        nodes.push({ type: "text", value: leading });
      }
      nodes.push(imageNode(wrappedUrl));
      if (trailing) {
        nodes.push({ type: "text", value: trailing });
      }
      continue;
    }

    nodes.push({ type: "text", value: part });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", value: text }];
};

const transformTree = (
  node: MdastNode,
  emojiLookup: ReadonlyMap<string, string>,
  parentType?: string,
) => {
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return;
  }

  if (parentType && SKIP_PARENT_TYPES.has(parentType)) {
    return;
  }

  const nextChildren: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...transformTextWithEmotes(child.value, emojiLookup));
      continue;
    }

    transformTree(child, emojiLookup, child.type);
    nextChildren.push(child);
  }

  node.children = nextChildren;
};

export const createTwitchEmoteRemarkPlugin = (
  emojiLookup: ReadonlyMap<string, string>,
) => {
  return () => {
    return (tree: MdastNode) => {
      transformTree(tree, emojiLookup);
    };
  };
};
