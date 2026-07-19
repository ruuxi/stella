import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the production compaction outage: `stella/max`
// remapped upstream to `claude-fable-5`, the summary call's
// `thinking.type=disabled` shape started returning 400, and
// `generateThreadSummary` swallowed the error — so the orchestrator thread
// grew to 260k+ stored tokens without a single [[THREAD_CHECKPOINT]] being
// written and with nothing in the logs.

const completeSimpleMock = vi.fn();

vi.mock("../../../../runtime/ai/stream.js", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
  readAssistantText: (message: {
    content: Array<{ type: string; text?: string }>;
  }): string =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
}));

import {
  formatThreadCheckpointMessage,
  maybeCompactRuntimeThread,
  resetThreadSummaryFailureTracking,
  validateThreadSummary,
} from "../../../../runtime/kernel/thread-runtime.js";
import { compactRuntimeThreadHistory } from "../../../../runtime/kernel/agent-runtime/thread-memory.js";
import type { RuntimeStore } from "../../../../runtime/kernel/storage/runtime-store.js";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";

// ~10k chars per message; 60 messages ≈ 150k estimated tokens — far past the
// 60k orchestrator trigger, and big enough that the raw formatted middle
// exceeds the summarizer's input budget.
const buildBigThreadMessages = () =>
  Array.from({ length: 60 }, (_, index) => ({
    entryId: `entry-${index + 1}`,
    timestamp: 1_000 + index,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1} ${"x".repeat(10_000)}`,
  }));

const createFakeStore = (
  messages: Array<Record<string, unknown>> = buildBigThreadMessages(),
) => {
  const compactCalls: Array<Record<string, unknown>> = [];
  const store = {
    loadThreadMessages: () => messages,
    compactThread: (args: Record<string, unknown>) => {
      compactCalls.push(args);
    },
    updateThreadSummary: () => undefined,
  } as unknown as RuntimeStore;
  return { store, compactCalls };
};

const createRoute = (
  apiKey: string | null,
  contextWindow = 80_000,
): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id: "stella/max", contextWindow },
    getApiKey: async () => apiKey,
  }) as unknown as ResolvedLlmRoute;

// A plausible structured checkpoint summary with enough distinct facts for a
// large folded span.
const VALID_SUMMARY = [
  "## Topic",
  "Condensed summary of the backlog covering the full compacted span.",
  "## Key Points",
  "All sixty backlog messages were reviewed and folded into this checkpoint,",
  "including the delegated workstreams and their thread ids.",
  "## Current State",
  "Work is ongoing; the latest turns remain uncompacted in the tail.",
  "## Open Items",
  "None outstanding beyond the active workstreams named above.",
].join("\n");

const CONCISE_INFORMATIVE_SUMMARY = [
  "## Topic",
  "Stella release audit.",
  "## Key Points",
  "Build, lint and tests passed; raw history remains safe.",
  "## Current State",
  "Ready for independent review.",
  "## Open Items",
  "Await approval; no edits pending.",
].join("\n");

const THREAD_SUMMARY_HEADINGS_FOR_TEST = [
  "Topic",
  "Key Points",
  "Current State",
  "Open Items",
];

// A previous checkpoint big enough that a VALID_SUMMARY-sized candidate falls
// under the 50% never-shrink floor. Distinct sentences avoid tripping the
// repetition heuristics when this text is carried forward.
const LONG_PREVIOUS_SUMMARY = [
  "## Topic",
  "Multi-week Stella runtime hardening effort spanning compaction, recall, and release workstreams.",
  "## Key Points",
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `- Workstream ${index + 1} landed a distinct verified change touching module number ${index + 101} with its own review notes and follow-up owners.`,
  ),
  "## Current State",
  "The release candidate is staged; verification agents are mid-flight across the remaining suites.",
  "## Open Items",
  "Awaiting the final review pass and the user's explicit activation approval.",
].join("\n");

const buildBigThreadMessagesWithCheckpoint = () => [
  {
    entryId: "entry-checkpoint",
    timestamp: 900,
    role: "assistant",
    content: formatThreadCheckpointMessage({ summary: LONG_PREVIOUS_SUMMARY }),
  },
  ...buildBigThreadMessages(),
];

describe("orchestrator thread compaction failure handling", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resetThreadSummaryFailureTracking();
  });

  it("propagates summary-LLM failures instead of silently skipping compaction", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockRejectedValue(
      new Error(
        'upstream anthropic returned 400: "thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive',
      ),
    );

    await expect(
      maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).rejects.toThrow(/thinking\.type\.disabled/);
    expect(compactCalls).toHaveLength(0);

    // The wrapper every caller uses converts the failure into a logged
    // `compacted: false` rather than crashing the turn.
    const wrapped = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(wrapped).toEqual({ compacted: false });
  });

  // Reproduce the partial-error branch capable of creating the live 55-char
  // stub checkpoint: `completeSimple` can RESOLVE (rather than reject) with a
  // partial AssistantMessage flagged `stopReason: "error"`. Before the guard,
  // the truncated fragment was accepted as a summary for a large span.
  it("refuses a partial summary when the stream dies mid-generation", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "## Topic\nStella v2 completion and notarization; removal",
        },
      ],
      stopReason: "error",
      errorMessage: "managed relay stream terminated: quota exceeded",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("refuses an aborted summary stream even when the partial text is long", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "aborted",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("refuses a length-limited summary even when it clears the size floor", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "length",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("refuses tool-use and legacy missing terminal outcomes", async () => {
    for (const stopReason of ["toolUse", undefined]) {
      const { store, compactCalls } = createFakeStore();
      completeSimpleMock.mockReset();
      // Each iteration is an independent scenario, not a repeated-failure
      // streak that should trip the hard-limit escalation.
      resetThreadSummaryFailureTracking();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: VALID_SUMMARY }],
        ...(stopReason ? { stopReason } : {}),
      });

      const result = await maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      });

      expect(result).toEqual({ compacted: false });
      expect(compactCalls).toHaveLength(0);
      expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    }
  });

  it("refuses a near-empty summary for a large span even on a clean stop", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [
        { type: "text", text: "## Topic\nEverything is already known." },
      ],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("falls back to generation when a hook override is invalid", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
      overrideSummary: "Compacted.",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({ summary: VALID_SUMMARY });
  });

  it("retries one invalid generated summary with a corrective prompt", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "## Topic\nTruncated." }],
        stopReason: "stop",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: VALID_SUMMARY }],
        stopReason: "stop",
      });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    const retryContext = completeSimpleMock.mock.calls[1]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(retryContext.messages[0]!.content[0]!.text).toContain(
      "RETRY CORRECTION",
    );
    expect(compactCalls).toHaveLength(1);
  });

  it("bounds invalid generation retries and keeps the original span", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "## Topic\nStill truncated." }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(0);
  });

  it("validates normalized visible content rather than UTF-16 length", () => {
    expect(CONCISE_INFORMATIVE_SUMMARY.length).toBeLessThan(200);
    expect(
      validateThreadSummary(CONCISE_INFORMATIVE_SUMMARY, 190_576),
    ).toMatchObject({ valid: true });

    const zeroWidth = "\u200b".repeat(400);
    expect(validateThreadSummary(zeroWidth, 190_576)).toMatchObject({
      valid: false,
      visibleCodePoints: 0,
    });

    const astralFragment = [
      "## Topic",
      "😀".repeat(100),
      "## Key Points",
      "😀".repeat(100),
      "## Current State",
      "😀".repeat(100),
      "## Open Items",
      "😀".repeat(100),
    ].join("\n");
    expect(astralFragment.length).toBeGreaterThan(400);
    expect(validateThreadSummary(astralFragment, 190_576)).toMatchObject({
      valid: false,
    });
  });

  it("rejects extreme repetition despite valid headings and size", () => {
    const repeated = THREAD_SUMMARY_HEADINGS_FOR_TEST.map(
      (heading) => `## ${heading}\n${"alpha ".repeat(80)}`,
    ).join("\n");
    expect(validateThreadSummary(repeated, 190_576)).toMatchObject({
      valid: false,
      reason: "extreme repetition",
    });
  });

  it("rejects structured-looking consonant gibberish", () => {
    const consonants = "bcdfghjklmnpqrstvwxz";
    const gibberishWord = (value: number) => {
      let remainder = value;
      let suffix = "";
      do {
        suffix = consonants[remainder % consonants.length] + suffix;
        remainder = Math.floor(remainder / consonants.length);
      } while (remainder > 0);
      return `qzx${suffix.padStart(4, "q")}`;
    };
    const gibberish = THREAD_SUMMARY_HEADINGS_FOR_TEST.map(
      (heading, sectionIndex) =>
        `## ${heading}\n${Array.from({ length: 16 }, (_, wordIndex) =>
          gibberishWord(sectionIndex * 16 + wordIndex),
        ).join(" ")}`,
    ).join("\n");
    expect(validateThreadSummary(gibberish, 190_576)).toMatchObject({
      valid: false,
      reason: "gibberish-like token distribution",
    });
  });

  it("rejects copied summary-template boilerplate", () => {
    const boilerplate = [
      "## Topic",
      "What the conversation is about, with generic filler copied unchanged.",
      "## Key Points",
      "Important information, decisions, and conclusions from the discussion.",
      "## Current State",
      "Where things stand now according to this placeholder summary.",
      "## Open Items",
      "Unresolved questions, pending tasks, or next steps discussed in the thread.",
    ].join("\n");
    expect(validateThreadSummary(boilerplate, 190_576)).toMatchObject({
      valid: false,
      reason: "template boilerplate",
    });
  });

  it("instructs the summarizer that a near-empty summary is never acceptable", async () => {
    const { store } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("Never return an empty or near-empty summary");
  });

  it("caps the summary input so an oversized backlog still compacts", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      threadKey: "conversation-1",
      summary: VALID_SUMMARY,
    });

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    // Input budget: (80k window - 16,384 reserve) tokens * 4 chars, plus the
    // prompt scaffold. The raw middle (~550k chars) must have been truncated.
    expect(prompt.length).toBeLessThan((80_000 - 16_384) * 4 + 5_000);
    expect(prompt).toContain("Compaction input truncated");
    // The most recent part of the compacted middle survives the cap (the
    // very last ~20k tokens are the keep-recent tail, excluded from the
    // middle entirely); the oldest middle messages are elided.
    expect(prompt).toContain("message 50");
    expect(prompt).not.toContain("message 3 ");
  });

  it("threads summary guidelines and the durable-memory reference into the prompt", async () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-compaction-memory-"),
    );
    fs.mkdirSync(path.join(stellaDataDir, "memories"), { recursive: true });
    fs.writeFileSync(
      path.join(stellaDataDir, "memories", "profile.md"),
      "Rahul's workshop address is 123 Elm Street.",
    );
    fs.writeFileSync(
      path.join(stellaDataDir, "memories", "memory_summary.md"),
      "Workflow tiers: tier-1 ships without review.",
    );
    try {
      const { store } = createFakeStore();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: "Summary." }],
      });

      await maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
        stellaDataDir,
      });

      const context = completeSimpleMock.mock.calls[0]![1] as {
        messages: Array<{ content: Array<{ type: string; text: string }> }>;
      };
      const prompt = context.messages[0]!.content[0]!.text;
      // Thread-id mapping + verbatim pending-decision guidelines.
      expect(prompt).toContain("thread_id");
      expect(prompt).toContain("quoted verbatim");
      // The always-loaded docs ride along as a do-not-repeat reference.
      expect(prompt).toContain("ALREADY KNOWN");
      expect(prompt).toContain("123 Elm Street");
      expect(prompt).toContain("tier-1 ships without review");
      expect(prompt).toContain("Do not restate durable memory");

      // Non-orchestrator agents don't get the docs injected per turn, so
      // their summaries must keep such facts: no reference, no omit rule.
      completeSimpleMock.mockClear();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: "Summary." }],
      });
      await maybeCompactRuntimeThread({
        store: createFakeStore().store,
        threadKey: "conversation-2",
        resolvedLlm: createRoute("auth-token"),
        agentType: "general",
        stellaDataDir,
      });
      const subagentContext = completeSimpleMock.mock.calls[0]![1] as {
        messages: Array<{ content: Array<{ type: string; text: string }> }>;
      };
      const subagentPrompt = subagentContext.messages[0]!.content[0]!.text;
      expect(subagentPrompt).toContain("thread_id");
      expect(subagentPrompt).not.toContain("ALREADY KNOWN");
      expect(subagentPrompt).not.toContain("123 Elm Street");
      expect(subagentPrompt).not.toContain("Do not restate durable memory");
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("skips without calling the model when no credential is available", async () => {
    const { store, compactCalls } = createFakeStore();

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute(null),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(0);
  });
  it("accepts natural prose and markdown dividers that echo no template placeholder", () => {
    const summary = [
      "## Topic",
      "Fixing the compaction retry ladder and the summary gate in the stella runtime.",
      "================",
      "## Key Points",
      "- Transient stream failures now land on the transport ladder and retry with jittered backoff.",
      "- Deterministic content aborts stay contained and never burn transport retries.",
      "--------------------",
      "## Current State",
      "Here is where things stand now: the classifier and the containment layer both have regression coverage.",
      "## Open Items",
      "- Verify the repair script against the staging database snapshot before the next release.",
    ].join("\n");
    expect(validateThreadSummary(summary, 190_576)).toMatchObject({
      valid: true,
    });
  });

  it("still rejects verbatim template placeholder echoes", () => {
    const echoed = [
      "## Topic",
      "[What the conversation is about]",
      "## Key Points",
      "Important information, decisions, and conclusions from the conversation",
      "## Current State",
      "Where things stand now \u2014 what has been done, what is in progress",
      "## Open Items",
      "Unresolved questions, pending tasks, or next steps discussed",
    ].join("\n");
    expect(validateThreadSummary(echoed, 190_576)).toMatchObject({
      valid: false,
      reason: "template boilerplate",
    });
  });

  it("rejects a structurally valid summary that halves the previous checkpoint", async () => {
    const { store, compactCalls } = createFakeStore(
      buildBigThreadMessagesWithCheckpoint(),
    );
    // VALID_SUMMARY passes every structural check but is far below 50% of
    // LONG_PREVIOUS_SUMMARY's visible size — under the recursive update form
    // that can only mean lost information.
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "never-shrink-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(0);
  });

  it("accepts a summary at or above the never-shrink floor", () => {
    expect(
      validateThreadSummary(VALID_SUMMARY, 150_000, VALID_SUMMARY),
    ).toMatchObject({ valid: true });
    expect(
      validateThreadSummary(VALID_SUMMARY, 150_000, LONG_PREVIOUS_SUMMARY),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("never-shrink"),
    });
    // The guard applies even below the small-span floor exemption: a tiny new
    // middle never justifies discarding half the accumulated checkpoint.
    expect(
      validateThreadSummary(VALID_SUMMARY, 500, LONG_PREVIOUS_SUMMARY),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("never-shrink"),
    });
  });

  it("escalates to a carry-forward checkpoint when repeated failures approach the hard limit", async () => {
    // ~150k estimated tokens against an 80k window: far past the 90%
    // escalation threshold. Every generation attempt returns an invalid stub.
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "## Topic\nStill truncated." }],
      stopReason: "stop",
    });

    const first = await maybeCompactRuntimeThread({
      store: createFakeStore(buildBigThreadMessagesWithCheckpoint()).store,
      threadKey: "escalate-carry-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(first).toEqual({ compacted: false });

    const { store, compactCalls } = createFakeStore(
      buildBigThreadMessagesWithCheckpoint(),
    );
    const second = await maybeCompactRuntimeThread({
      store,
      threadKey: "escalate-carry-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(second).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    const summary = String(compactCalls[0]!.summary);
    expect(summary).toMatch(
      /^\[compaction summary refresh failed \d{4}-\d{2}-\d{2}; state may lag\]/,
    );
    // The previous checkpoint is carried forward, not the invalid candidate.
    expect(summary).toContain("Awaiting the final review pass");
    expect(summary).not.toContain("Still truncated.");
  });

  it("escalates to a mechanical fallback when no previous checkpoint or candidate exists", async () => {
    // Stream dies with no text at all: no carry-forward source, no candidate.
    completeSimpleMock.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "stream terminated",
    });

    const first = await maybeCompactRuntimeThread({
      store: createFakeStore().store,
      threadKey: "escalate-mechanical-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(first).toEqual({ compacted: false });

    const { store, compactCalls } = createFakeStore();
    const second = await maybeCompactRuntimeThread({
      store,
      threadKey: "escalate-mechanical-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(second).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    const summary = String(compactCalls[0]!.summary);
    expect(summary).toContain("state may lag");
    expect(summary).toContain("## Topic");
    expect(summary).toContain("folded without narration");
  });

  it("keeps refusing to compact while the window is still far from the hard limit", async () => {
    // 200k window: trigger at 140k, escalation floor at 180k. The ~150k
    // thread is past the trigger but below the floor, so repeated failures
    // stay refuse-only.
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "## Topic\nStill truncated." }],
      stopReason: "stop",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { store, compactCalls } = createFakeStore();
      const result = await maybeCompactRuntimeThread({
        store,
        threadKey: "no-escalate-headroom-1",
        resolvedLlm: createRoute("auth-token", 200_000),
        agentType: "orchestrator",
      });
      expect(result).toEqual({ compacted: false });
      expect(compactCalls).toHaveLength(0);
    }
  });

  it("never escalates on repeated missing-credential skips", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { store, compactCalls } = createFakeStore();
      const result = await maybeCompactRuntimeThread({
        store,
        threadKey: "no-escalate-credential-1",
        resolvedLlm: createRoute(null),
        agentType: "orchestrator",
      });
      expect(result).toEqual({ compacted: false });
      expect(compactCalls).toHaveLength(0);
    }
    expect(completeSimpleMock).not.toHaveBeenCalled();
  });

  it("still rejects run-length repetition spam that is not a markdown divider", () => {
    const spam = THREAD_SUMMARY_HEADINGS_FOR_TEST.map(
      (heading) =>
        `## ${heading}\nProgress ${"x".repeat(40)} tracked with details, owners, and follow-up numbers.`,
    ).join("\n");
    expect(validateThreadSummary(spam, 190_576)).toMatchObject({
      valid: false,
      reason: "extreme repetition",
    });
  });
});
