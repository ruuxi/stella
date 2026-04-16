import { loadParsedAgentsFromDir } from "../../../kernel/agents/markdown-agent-loader.js";
import type { ExtensionFactory } from "../../../kernel/extensions/types.js";

const AGENTS_DIR = new URL("./agents/", import.meta.url);

const subagentReferenceExtension: ExtensionFactory = (pi) => {
  for (const agent of loadParsedAgentsFromDir(AGENTS_DIR)) {
    pi.registerAgent(agent);
  }
};

export default subagentReferenceExtension;
