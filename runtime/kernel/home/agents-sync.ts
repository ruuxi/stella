/**
 * Hash-history reconciliation of bundled agent prompts into Stella home.
 *
 * Stella ships default agent prompts at
 * `${stellaAppDir}/runtime/extensions/stella-runtime/agents/<id>.md`. Users carry
 * their own copy at `${stellaDataDir}/agents/<id>.md`, which is what the runtime
 * actually loads. Each prompt file is reconciled as a unit (via the shared
 * `bundled-sync.ts` engine, same as skills) so shipped prompt updates reach
 * users who haven't edited that prompt, while local edits are preserved.
 */

import {
  createFileEntryAdapter,
  reconcileBundledEntries,
  summarizeBundledSync,
  type BundledSyncReport,
  type BundledSyncOptions,
} from "./bundled-sync.js";

export type AgentsSyncReport = BundledSyncReport;

const AGENT_PROMPT_EXTENSION = ".md";

export const reconcileBundledAgents = async (
  bundledAgentsDir: string,
  homeAgentsDir: string,
  options: BundledSyncOptions = {},
): Promise<AgentsSyncReport> =>
  reconcileBundledEntries(
    bundledAgentsDir,
    homeAgentsDir,
    createFileEntryAdapter(AGENT_PROMPT_EXTENSION),
    options,
  );

export const summarizeAgentsSync = summarizeBundledSync;
