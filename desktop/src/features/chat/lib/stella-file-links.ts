/**
 * `stella://file/<absolute-path>` — the assistant-facing scheme for
 * referencing a local file inside chat text.
 *
 * The assistant writes either a markdown link
 * (`[report.pdf](stella://file/Users/me/report.pdf)`) or the bare URI in
 * prose. `remarkStellaFileLinks` rewrites both forms during Streamdown's
 * normal parse (mirroring `remarkEmojiSprites`) into a custom
 * `<stella-file path label>` element, which the chat markdown renderer maps
 * to the inline `StellaFileLink` anchor. Rewriting at the mdast stage keeps
 * the reference out of the `<a href>` pipeline entirely, so
 * rehype-sanitize's protocol allow-list never sees a non-http URL.
 *
 * Kept render-free so tests and the markdown surface share one parser.
 */

import type { Plugin } from "unified";
import type { Link, Parent, Root, RootContent, Text } from "mdast";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import {
  basenameOf,
  extensionOf,
} from "@/features/workspace-display/path-to-viewer";
import { buildPayloadFromBarePath } from "./derive-turn-resource";

export const STELLA_FILE_URL_PREFIX = "stella://file";

/** Custom hast tag the remark plugin emits; the chat markdown renderer
 *  maps it to `StellaFileLink` and allow-lists it through sanitize via
 *  Streamdown's `allowedTags`. */
export const STELLA_FILE_TAG = "stella-file";
export const STELLA_FILE_TAG_ATTRIBUTES = ["path", "label"] as const;

const isWindowsAbsolutePath = (candidate: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(candidate);

const isAbsoluteLocalPath = (candidate: string): boolean =>
  candidate.startsWith("/") || isWindowsAbsolutePath(candidate);

/**
 * Extract the absolute local path from a `stella://file/...` URL, or
 * `null` when the URL isn't a well-formed stella file reference.
 *
 * Accepted spellings (the model won't be perfectly consistent):
 *   - `stella://file/Users/me/report.pdf`   (path appended directly)
 *   - `stella://file//Users/me/report.pdf`  (extra slash before the path)
 *   - percent-encoded paths (`My%20File.pdf`)
 */
export const parseStellaFileUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(STELLA_FILE_URL_PREFIX)) return null;
  let rest = trimmed.slice(STELLA_FILE_URL_PREFIX.length);
  if (rest.startsWith("/")) {
    // Collapse `file//Users/...` and `file/Users/...` to one form.
    rest = rest.replace(/^\/+/, "");
  } else if (rest.length > 0) {
    // `stella://filesomething` — a different (or malformed) deep link.
    return null;
  }
  if (!rest) return null;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Keep the raw spelling when percent-decoding fails.
  }
  const path = isWindowsAbsolutePath(decoded) ? decoded : `/${decoded}`;
  if (!isAbsoluteLocalPath(path)) return null;
  // A bare `stella://file/` with no path is not a usable reference.
  if (path === "/") return null;
  return path;
};

/**
 * Map a clicked stella-file path to the `DisplayPayload` that opens the
 * right in-app viewer tab, or `null` when no in-app viewer fits (the
 * caller then falls back to the OS-default opener).
 *
 * HTML gets special-cased: `buildPayloadFromBarePath` only treats
 * outputs-tree HTML as a canvas (elsewhere HTML classifies as developer
 * source), but a file the assistant explicitly linked for viewing should
 * always open in the Canvas tab.
 */
export const displayPayloadForStellaFile = (
  filePath: string,
  createdAt: number,
): DisplayPayload | null => {
  const ext = extensionOf(filePath);
  if (ext === "html" || ext === "htm") {
    const fromOutputs = buildPayloadFromBarePath(filePath, createdAt, {
      produced: true,
    });
    if (fromOutputs?.kind === "canvas-html") return fromOutputs;
    return {
      kind: "canvas-html",
      filePath,
      title: basenameOf(filePath),
      createdAt,
    };
  }
  const payload = buildPayloadFromBarePath(filePath, createdAt, {
    produced: true,
  });
  // Source-diff payloads must flow through the batches store, not a
  // direct tab open; treat them as "no in-app viewer" here. (Only
  // reachable if `buildPayloadFromBarePath` ever routes there.)
  return payload && payload.kind !== "source-diff" ? payload : null;
};

/** Bare-URI matcher for prose. Stops at whitespace and markdown/link
 *  delimiters; trailing sentence punctuation is trimmed afterwards. */
const BARE_STELLA_FILE_RE = /stella:\/\/file\/[^\s<>()"'`]+/gi;

const trimTrailingPunctuation = (raw: string): string =>
  raw.replace(/[.,;:!?]+$/, "");

type StellaFileNode = RootContent & {
  data: {
    hName: string;
    hProperties: { path: string; label: string };
    hChildren: Array<{ type: "text"; value: string }>;
  };
};

const buildStellaFileNode = (path: string, label: string): StellaFileNode => {
  const displayLabel = label.trim() || basenameOf(path);
  return {
    // mdast-util-to-hast renders unknown nodes via `data.hName` /
    // `data.hProperties`; the text child keeps the label readable if the
    // component mapping is ever bypassed.
    type: "text",
    value: displayLabel,
    data: {
      hName: STELLA_FILE_TAG,
      hProperties: { path, label: displayLabel },
      hChildren: [{ type: "text", value: displayLabel }],
    },
  } as unknown as StellaFileNode;
};

const isText = (node: RootContent): node is Text => node.type === "text";
const isLink = (node: RootContent): node is Link => node.type === "link";

const textOfChildren = (parent: Parent): string => {
  let out = "";
  for (const child of parent.children) {
    if (isText(child as RootContent)) {
      out += (child as Text).value;
    } else if ("children" in child && Array.isArray((child as Parent).children)) {
      out += textOfChildren(child as Parent);
    }
  }
  return out;
};

const splitTextNode = (node: Text): RootContent[] | null => {
  const value = node.value;
  if (!value || !value.toLowerCase().includes(STELLA_FILE_URL_PREFIX)) {
    return null;
  }
  BARE_STELLA_FILE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let cursor = 0;
  const out: RootContent[] = [];
  let touched = false;
  while ((match = BARE_STELLA_FILE_RE.exec(value)) !== null) {
    const raw = trimTrailingPunctuation(match[0]);
    const path = parseStellaFileUrl(raw);
    if (!path) continue;
    if (match.index > cursor) {
      out.push({
        type: "text",
        value: value.slice(cursor, match.index),
      } satisfies Text);
    }
    out.push(buildStellaFileNode(path, basenameOf(path)));
    cursor = match.index + raw.length;
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
    if (isLink(child as RootContent)) {
      const path = parseStellaFileUrl((child as Link).url ?? "");
      if (path) {
        const label = textOfChildren(child as Parent);
        parent.children.splice(index, 1, buildStellaFileNode(path, label));
        continue;
      }
    }
    if (isText(child as RootContent)) {
      const replacements = splitTextNode(child as Text);
      if (replacements) {
        parent.children.splice(
          index,
          1,
          ...(replacements as Parent["children"]),
        );
      }
      continue;
    }
    // Leave literal-text containers alone, same as the emoji plugin.
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

export const remarkStellaFileLinks: Plugin<[], Root> = () => {
  return (tree) => {
    transformChildren(tree as Parent);
  };
};
