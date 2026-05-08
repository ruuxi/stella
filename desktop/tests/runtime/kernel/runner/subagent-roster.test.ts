import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  getAgentDefinition,
} from "../../../../../runtime/contracts/agent-runtime.js";
import {
  collectSubagentRoster,
  renderSubagentRosterBlock,
} from "../../../../../runtime/kernel/runner/subagent-roster.js";
import type { ParsedAgentLike } from "../../../../../runtime/kernel/runner/types.js";

const makeAgent = (overrides: Partial<ParsedAgentLike>): ParsedAgentLike => ({
  id: overrides.id ?? "general",
  name: overrides.name ?? overrides.id ?? "General",
  description: overrides.description ?? "",
  systemPrompt: overrides.systemPrompt ?? "system",
  agentTypes: overrides.agentTypes ?? [overrides.id ?? "general"],
  ...(overrides.toolsAllowlist ? { toolsAllowlist: overrides.toolsAllowlist } : {}),
  ...(overrides.model ? { model: overrides.model } : {}),
  ...(typeof overrides.maxAgentDepth === "number"
    ? { maxAgentDepth: overrides.maxAgentDepth }
    : {}),
});

describe("collectSubagentRoster", () => {
  it("emits markdown descriptions for general plus extension agents", () => {
    const roster = collectSubagentRoster([
      makeAgent({
        id: AGENT_IDS.GENERAL,
        description: "Executes delegated work.",
      }),
      makeAgent({
        id: "research",
        description: "Finds and summarizes account setup options.",
      }),
    ]);

    expect(roster).toEqual([
      { type: AGENT_IDS.GENERAL, description: "Executes delegated work." },
      {
        type: "research",
        description: "Finds and summarizes account setup options.",
      },
    ]);
  });

  it("filters reserved built-ins so the orchestrator can't target them", () => {
    const roster = collectSubagentRoster([
      makeAgent({ id: AGENT_IDS.ORCHESTRATOR, description: "ignored" }),
      makeAgent({ id: AGENT_IDS.SCHEDULE, description: "ignored" }),
      makeAgent({
        id: AGENT_IDS.GENERAL,
        description: "Executes delegated work.",
      }),
    ]);

    expect(roster.map((entry) => entry.type)).toEqual([AGENT_IDS.GENERAL]);
  });

  it("falls back to the built-in general description when no markdown agent is loaded", () => {
    const roster = collectSubagentRoster([
      makeAgent({ id: "research", description: "Custom research agent." }),
    ]);

    const fallback = getAgentDefinition(AGENT_IDS.GENERAL)?.description ?? "";
    expect(roster).toEqual([
      { type: AGENT_IDS.GENERAL, description: fallback.trim() },
      { type: "research", description: "Custom research agent." },
    ]);
  });

  it("dedupes alias agentTypes to the first agent's description", () => {
    const roster = collectSubagentRoster([
      makeAgent({
        id: AGENT_IDS.GENERAL,
        description: "Executes delegated work.",
        agentTypes: [AGENT_IDS.GENERAL, "research"],
      }),
      makeAgent({
        id: "research",
        description: "A different research agent that should not win.",
      }),
    ]);

    expect(roster).toEqual([
      { type: AGENT_IDS.GENERAL, description: "Executes delegated work." },
      { type: "research", description: "Executes delegated work." },
    ]);
  });
});

describe("renderSubagentRosterBlock", () => {
  it("renders the orchestrator-facing block in stable order", () => {
    const block = renderSubagentRosterBlock([
      { type: AGENT_IDS.GENERAL, description: "Executes delegated work." },
      { type: "research", description: "Finds research." },
    ]);

    expect(block).toBe(
      [
        "## Subagents",
        "Use `spawn_agent` with one of these `agent_type` values to delegate work:",
        "- `general`: Executes delegated work.",
        "- `research`: Finds research.",
      ].join("\n"),
    );
  });

  it("omits the trailing colon when an agent has no description", () => {
    const block = renderSubagentRosterBlock([
      { type: AGENT_IDS.GENERAL, description: "" },
    ]);

    expect(block.trim().endsWith("- `general`")).toBe(true);
  });
});
