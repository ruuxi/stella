/**
 * Persistence semantics of the per-agent progress-summary store.
 *
 * Regression focus (prod 0.0.389): summaries used to be wiped via
 * `retainOnly(runningIds)` the moment an agent left the running set, which
 * reset a `send_input` follow-up to an empty list. Summaries now persist in
 * the store for the session (display is separately gated to active tasks by
 * `shouldShowTaskReasoningSummaries` — a finished row shows files only, and
 * a re-activated run resumes from the accumulated list) and the store bounds
 * its own memory with an LRU agent cap.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  agentProgressSummaryStore,
  MAX_SUMMARIES_PER_AGENT,
  MAX_TRACKED_AGENTS,
} from "@/features/chat/agent-progress-summary-store";

afterEach(() => {
  agentProgressSummaryStore.reset();
});

describe("agentProgressSummaryStore persistence", () => {
  it("keeps an agent's summaries after it stops running (no completion wipe)", () => {
    agentProgressSummaryStore.addSummary("a1", "reading the config");
    agentProgressSummaryStore.addSummary("a1", "writing the report");
    // The engine no longer prunes on completion — there is simply no wipe
    // call anymore. Summaries must still be readable afterwards.
    expect(
      agentProgressSummaryStore.getSummaries("a1").map((s) => s.text),
    ).toEqual(["reading the config", "writing the report"]);
  });

  it("accumulates across send_input re-runs on the same thread, capped per agent", () => {
    // First run.
    agentProgressSummaryStore.addSummary("a1", "phrase 1");
    agentProgressSummaryStore.addSummary("a1", "phrase 2");
    // Follow-up run appends to the same agent id.
    for (let i = 3; i <= 8; i += 1) {
      agentProgressSummaryStore.addSummary("a1", `phrase ${i}`);
    }
    const texts = agentProgressSummaryStore
      .getSummaries("a1")
      .map((s) => s.text);
    expect(texts).toHaveLength(MAX_SUMMARIES_PER_AGENT);
    // Newest survive; the oldest scrolled out.
    expect(texts[texts.length - 1]).toBe("phrase 8");
    expect(texts[0]).toBe(`phrase ${8 - MAX_SUMMARIES_PER_AGENT + 1}`);
  });

  it("evicts the least-recently-updated agent beyond MAX_TRACKED_AGENTS", () => {
    for (let i = 0; i < MAX_TRACKED_AGENTS; i += 1) {
      agentProgressSummaryStore.addSummary(`agent-${i}`, `working ${i}`);
    }
    // Touch agent-0 so it becomes most-recent; agent-1 is now the LRU.
    agentProgressSummaryStore.addSummary("agent-0", "still working");
    agentProgressSummaryStore.addSummary("fresh-agent", "new work");
    expect(agentProgressSummaryStore.getSummaries("agent-1")).toHaveLength(0);
    expect(
      agentProgressSummaryStore.getSummaries("agent-0").length,
    ).toBeGreaterThan(0);
    expect(
      agentProgressSummaryStore.getSummaries("fresh-agent"),
    ).toHaveLength(1);
    expect(
      Object.keys(agentProgressSummaryStore.snapshotTexts()),
    ).toHaveLength(MAX_TRACKED_AGENTS);
  });

  it("drops the evicted agent's collapse flag alongside its summaries", () => {
    agentProgressSummaryStore.addSummary("victim", "about to be evicted");
    agentProgressSummaryStore.toggleCollapsed("victim");
    expect(agentProgressSummaryStore.isCollapsed("victim")).toBe(true);
    for (let i = 0; i < MAX_TRACKED_AGENTS; i += 1) {
      agentProgressSummaryStore.addSummary(`filler-${i}`, `working ${i}`);
    }
    expect(agentProgressSummaryStore.getSummaries("victim")).toHaveLength(0);
    expect(agentProgressSummaryStore.isCollapsed("victim")).toBe(false);
  });

  it("skips back-to-back duplicate phrases", () => {
    agentProgressSummaryStore.addSummary("a1", "same phrase");
    agentProgressSummaryStore.addSummary("a1", "same phrase");
    expect(agentProgressSummaryStore.getSummaries("a1")).toHaveLength(1);
  });
});
