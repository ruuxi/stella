import { parse as parseYaml } from "yaml";

export type FrontmatterParseResult = {
  metadata: Record<string, unknown>;
  body: string;
};

const FRONTMATTER_DELIM = "---";

export const extractFrontmatter = (content: string): FrontmatterParseResult => {
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, body: content };
  }

  const lines = content.split("\n");
  if (lines.length < 3) {
    return { metadata: {}, body: content };
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONTMATTER_DELIM) {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return { metadata: {}, body: content };
  }

  const frontmatterText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === "object") {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Fall through to empty metadata on parse errors.
  }

  return { metadata: {}, body };
};
