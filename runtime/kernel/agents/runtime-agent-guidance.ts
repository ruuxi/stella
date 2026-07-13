import fs from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";

/** Additive capability guidance shipped beside local agent metadata. */
export const loadRuntimeAgentGuidance = (
  agentType: string,
): string | undefined => {
  const filePath = path.join(
    resolveRuntimeSourceAsset(
      "runtime",
      "extensions",
      "stella-runtime",
      "agent-metadata",
    ),
    `${agentType}.md`,
  );
  try {
    const body = extractFrontmatter(
      fs.readFileSync(filePath, "utf-8"),
    ).body.trim();
    return body || undefined;
  } catch {
    return undefined;
  }
};
