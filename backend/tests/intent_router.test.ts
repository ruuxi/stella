import { describe, expect, test } from "bun:test";
import {
  buildRuntimeRouteContext,
  classifyOrchestratorIntent,
} from "../convex/agent/intent_router";

describe("orchestrator intent router", () => {
  test("routes execution requests to general", () => {
    const decision = classifyOrchestratorIntent({
      text: "Open Microsoft Word",
    });

    expect(decision.primaryRoute).toBe("general");
    expect(decision.mustDelegate).toBe(true);
    expect(decision.delegateSubagent).toBe("general");
    expect(decision.mustUseTools).toBe(true);
  });

  test("routes read-only code discovery to explore", () => {
    const decision = classifyOrchestratorIntent({
      text: "Where is the auth component in the codebase?",
    });

    expect(decision.primaryRoute).toBe("explore");
    expect(decision.delegateSubagent).toBe("explore");
    expect(decision.mustDelegate).toBe(true);
  });

  test("routes scheduling requests to scheduling tools", () => {
    const decision = classifyOrchestratorIntent({
      text: "Remind me every morning at 8am",
    });

    expect(decision.primaryRoute).toBe("scheduling");
    expect(decision.mustUseTools).toBe(true);
    expect(decision.mustDelegate).toBe(false);
  });

  test("routes prior-conversation questions to memory", () => {
    const decision = classifyOrchestratorIntent({
      text: "What did we discuss yesterday about the API?",
    });

    expect(decision.primaryRoute).toBe("memory");
    expect(decision.mustUseTools).toBe(true);
    expect(decision.mustDelegate).toBe(false);
  });

  test("routes stella ui changes to self_mod", () => {
    const decision = classifyOrchestratorIntent({
      text: "Change Stella UI theme to dark",
    });

    expect(decision.primaryRoute).toBe("self_mod");
    expect(decision.delegateSubagent).toBe("self_mod");
    expect(decision.mustDelegate).toBe(true);
  });

  test("routes web interaction tasks to browser", () => {
    const decision = classifyOrchestratorIntent({
      text: "Use the browser to log in and fill out the signup form on https://example.com",
    });

    expect(decision.primaryRoute).toBe("browser");
    expect(decision.delegateSubagent).toBe("browser");
    expect(decision.mustDelegate).toBe(true);
  });

  test("keeps small talk conversational", () => {
    const decision = classifyOrchestratorIntent({
      text: "hey stella, thanks",
    });

    expect(decision.primaryRoute).toBe("conversational");
    expect(decision.mustUseTools).toBe(false);
    expect(decision.mustDelegate).toBe(false);
  });

  test("sets recall_memory modifier for prior-context execution", () => {
    const decision = classifyOrchestratorIntent({
      text: "Refactor the sidebar using the pattern we discussed last week",
    });

    expect(decision.primaryRoute).toBe("general");
    expect(decision.useRecallMemory).toBe(true);
  });

  test("sets pre_explore modifier for general tasks that need discovery", () => {
    const decision = classifyOrchestratorIntent({
      text: "Find the sidebar files in the repo and update them to be collapsible",
    });

    expect(decision.primaryRoute).toBe("general");
    expect(decision.usePreExplore).toBe(true);
  });

  test("builds stable runtime route context block", () => {
    const decision = classifyOrchestratorIntent({
      text: "Open Microsoft Word",
    });
    const context = buildRuntimeRouteContext(decision);

    expect(context).toContain("# Runtime Route");
    expect(context).toContain("primary_route: general");
    expect(context).toContain("must_delegate: true");
    expect(context).toContain("delegate_subagent: general");
  });
});
