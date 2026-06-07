/**
 * Live read of a user-editable agent system prompt from `~/.stella/agents/`.
 *
 * Agent prompts are reconciled into `${stellaDataDir}/agents/<id>.md` at startup
 * (see `home/agents-sync.ts`) and that's what the extension loader registers.
 * But the registered prompt is captured once at load time, so a later edit to
 * the markdown wouldn't take effect until a reload. `buildAgentContext` calls
 * this per turn to pick up edits live — gated by an mtime+size signature so an
 * unchanged file is never re-read or re-parsed (the body is served from a
 * module-level cache). Returns `undefined` when there's no home prompt for the
 * agent type, so callers fall back to the registered/bundled prompt.
 *
 * Only the prompt *body* is read live. Frontmatter (tools, model,
 * maxAgentDepth) still comes from the registered agent and takes effect on the
 * next extension reload — the prompt text is the thing users iterate on.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { statSignature } from "../shared/fs-signature.js";

const AGENTS_DIR_NAME = "agents";
const AGENT_PROMPT_EXTENSION = ".md";

type CachedPrompt = { sig: string; body: string | undefined };

const promptCache = new Map<string, CachedPrompt>();

export const loadHomeAgentSystemPrompt = async (
  stellaDataDir: string,
  agentType: string,
): Promise<string | undefined> => {
  const filePath = path.join(
    stellaDataDir,
    AGENTS_DIR_NAME,
    `${agentType}${AGENT_PROMPT_EXTENSION}`,
  );

  const sig = await statSignature(filePath);
  if (sig === null) {
    promptCache.delete(filePath);
    return undefined;
  }

  const cached = promptCache.get(filePath);
  if (cached && cached.sig === sig) {
    return cached.body;
  }

  let body: string | undefined;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = extractFrontmatter(raw).body.trim();
    body = parsed.length > 0 ? parsed : undefined;
  } catch {
    body = undefined;
  }

  promptCache.set(filePath, { sig, body });
  return body;
};
