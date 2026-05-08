/**
 * Orchestrator-visible subagent roster.
 *
 * Single source of truth for which `agent_type` values the orchestrator
 * may pass to `spawn_agent`. The same list drives:
 *
 *   - the `spawn_agent` schema enum (via `getSubagentTypes`)
 *   - the `## Subagents` block injected into the orchestrator's
 *     dynamic context each turn
 *
 * Descriptions come straight from each agent's markdown frontmatter, so
 * users extend the roster by dropping `state/agents/<id>.md`, not by
 * editing runtime code.
 */

import {
  AGENT_IDS,
  getAgentDefinition,
  isOrchestratorReservedBuiltinAgentId,
} from "../../contracts/agent-runtime.js";
import type { ParsedAgentLike } from "./types.js";

export type SubagentRosterEntry = {
  type: string;
  description: string;
};

/**
 * Walks `loadedAgents` and produces the orchestrator-visible subagent
 * roster. Reserved built-ins (orchestrator, schedule, fashion, …) are
 * filtered out so the orchestrator never spawns them via `spawn_agent`,
 * `general` is guaranteed to be present (with its built-in fallback
 * description if no markdown agent is loaded), and aliases declared via
 * `agentTypes` resolve to the agent's own description.
 */
export const collectSubagentRoster = (
  loadedAgents: readonly ParsedAgentLike[],
): SubagentRosterEntry[] => {
  const seen = new Map<string, string>();
  for (const agent of loadedAgents) {
    const candidateTypes =
      agent.agentTypes.length > 0 ? agent.agentTypes : [agent.id];
    for (const agentType of candidateTypes) {
      if (
        isOrchestratorReservedBuiltinAgentId(agentType) ||
        seen.has(agentType)
      ) {
        continue;
      }
      seen.set(agentType, agent.description.trim());
    }
  }
  if (!seen.has(AGENT_IDS.GENERAL)) {
    const fallback =
      getAgentDefinition(AGENT_IDS.GENERAL)?.description?.trim() ?? "";
    const ordered: SubagentRosterEntry[] = [
      { type: AGENT_IDS.GENERAL, description: fallback },
    ];
    for (const [type, description] of seen) {
      ordered.push({ type, description });
    }
    return ordered;
  }
  return Array.from(seen, ([type, description]) => ({ type, description }));
};

/**
 * Renders the roster as a `## Subagents` markdown block for the
 * orchestrator's dynamic context.
 */
export const renderSubagentRosterBlock = (
  roster: readonly SubagentRosterEntry[],
): string => {
  const lines = roster.map((entry) =>
    entry.description.length > 0
      ? `- \`${entry.type}\`: ${entry.description}`
      : `- \`${entry.type}\``,
  );
  return [
    "## Subagents",
    "Use `spawn_agent` with one of these `agent_type` values to delegate work:",
    ...lines,
  ].join("\n");
};
