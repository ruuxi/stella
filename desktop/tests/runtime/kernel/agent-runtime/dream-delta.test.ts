import { describe, expect, it } from "vitest";

import {
  appendToShadowLog,
  buildDreamDeltaTranscript,
  buildDreamDeltaUserMessage,
  buildDreamShadowSystemPrompt,
  buildDreamShadowUserPrompt,
  formatDeltaEntry,
  formatShadowLogEntry,
  SHADOW_LOG_ENTRY_MARKER,
  SHADOW_LOG_MAX_CHARS,
  type DreamDeltaSourceMessage,
} from "../../../../../runtime/kernel/agent-runtime/dream-delta.js";

const userMsg = (ts: number, text: string): DreamDeltaSourceMessage => ({
  timestamp: ts,
  role: "user",
  content: text,
  payload: { role: "user", content: text, timestamp: ts },
});

const assistantMsg = (ts: number, text: string): DreamDeltaSourceMessage => ({
  timestamp: ts,
  role: "assistant",
  content: text,
  payload: {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: ts,
  } as DreamDeltaSourceMessage["payload"],
});

const taskReport = (ts: number, text: string): DreamDeltaSourceMessage => ({
  timestamp: ts,
  role: "runtimeInternal",
  content: text,
  customMessage: {
    customType: "runtime.task_lifecycle",
    content: text,
    display: false,
  },
});

const toolResultMsg = (ts: number): DreamDeltaSourceMessage => ({
  timestamp: ts,
  role: "toolResult",
  content: "[Tool result] Read\nsome file content",
});

describe("formatDeltaEntry", () => {
  it("keeps user turns, assistant replies, and task lifecycle/update reports", () => {
    expect(formatDeltaEntry(userMsg(1, "hello"))).toBe("[User]\nhello");
    expect(formatDeltaEntry(assistantMsg(2, "hi there"))).toBe(
      "[Assistant]\nhi there",
    );
    expect(formatDeltaEntry(taskReport(3, "task done"))).toBe(
      "[Task report]\ntask done",
    );
    expect(
      formatDeltaEntry({
        timestamp: 4,
        role: "runtimeInternal",
        content: "progress",
        customMessage: {
          customType: "runtime.task_update",
          content: "progress",
          display: false,
        },
      }),
    ).toBe("[Task update]\nprogress");
  });

  it("excludes tool results, unrelated custom messages, and empty turns", () => {
    expect(formatDeltaEntry(toolResultMsg(1))).toBeNull();
    expect(
      formatDeltaEntry({
        timestamp: 2,
        role: "runtimeInternal",
        content: "reminder",
        customMessage: {
          customType: "runtime.some_reminder",
          content: "reminder",
          display: true,
        },
      }),
    ).toBeNull();
    expect(formatDeltaEntry(userMsg(3, "   "))).toBeNull();
  });

  it("extracts only authored text from assistant payloads with tool calls", () => {
    const msg: DreamDeltaSourceMessage = {
      timestamp: 5,
      role: "assistant",
      content: "[Tool call] Read\nargs: {}",
      payload: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "toolCall",
            id: "t1",
            name: "Read",
            arguments: {},
          },
        ],
        timestamp: 5,
      } as DreamDeltaSourceMessage["payload"],
    };
    expect(formatDeltaEntry(msg)).toBe("[Assistant]\nLet me check.");
  });

  it("never lets a compaction checkpoint read as fresh assistant signal", () => {
    const checkpoint = ["[[THREAD_CHECKPOINT]]", "", "## Topic", "Old work."].join(
      "\n",
    );
    expect(formatDeltaEntry(assistantMsg(6, checkpoint))).toBeNull();
  });

  it("redacts secrets before they can enter a transcript", () => {
    const entry = formatDeltaEntry(
      userMsg(7, "my key is sk-ant-api03-abcdefghijklmnop1234567890"),
    );
    expect(entry).not.toBeNull();
    expect(entry).not.toContain("sk-ant-api03-abcdefghijklmnop1234567890");
  });
});

describe("buildDreamDeltaTranscript", () => {
  it("slices strictly after the watermark and interleaves in order", () => {
    const result = buildDreamDeltaTranscript(
      [
        userMsg(100, "old turn"),
        userMsg(200, "ship the fix"),
        toolResultMsg(250),
        taskReport(300, "child finished"),
        assistantMsg(400, "done"),
      ],
      100,
    );
    expect(result.transcript).toBe(
      "[User]\nship the fix\n\n[Task report]\nchild finished\n\n[Assistant]\ndone",
    );
    expect(result.includedMessages).toBe(3);
    expect(result.coveredThroughTs).toBe(400);
    expect(result.newestMessageTs).toBe(400);
    expect(result.truncated).toBe(false);
  });

  it("watermark 0 selects everything delta-relevant", () => {
    const result = buildDreamDeltaTranscript(
      [userMsg(1, "a"), assistantMsg(2, "b")],
      0,
    );
    expect(result.includedMessages).toBe(2);
  });

  it("chunks loss-free: budget cut keeps oldest and reports covered-through accordingly", () => {
    const big = "x".repeat(90);
    const result = buildDreamDeltaTranscript(
      [userMsg(10, big), userMsg(20, big), userMsg(30, big)],
      0,
      { maxChars: 220 },
    );
    // Two entries fit; the third is left for the next pass.
    expect(result.includedMessages).toBe(2);
    expect(result.coveredThroughTs).toBe(20);
    expect(result.newestMessageTs).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it("never strands an equal-timestamp message on the far side of a budget cut", () => {
    const big = "x".repeat(90);
    // Second and third messages share one millisecond; the budget admits
    // only two entries, cutting between the ties.
    const first = buildDreamDeltaTranscript(
      [userMsg(10, big), userMsg(20, `${big}-included-tie`), userMsg(20, `${big}-excluded-tie`)],
      0,
      { maxChars: 220 },
    );
    expect(first.includedMessages).toBe(2);
    expect(first.truncated).toBe(true);
    // Coverage rolls back below the tie: a strict > filter must be able to
    // see the excluded message again.
    expect(first.coveredThroughTs).toBeLessThan(20);

    const second = buildDreamDeltaTranscript(
      [userMsg(10, big), userMsg(20, `${big}-included-tie`), userMsg(20, `${big}-excluded-tie`)],
      first.coveredThroughTs,
    );
    expect(second.transcript).toContain("excluded-tie");
  });

  it("caps a runaway single message without dropping it", () => {
    const result = buildDreamDeltaTranscript(
      [taskReport(10, "y".repeat(10_000))],
      0,
      { messageMaxChars: 100 },
    );
    expect(result.includedMessages).toBe(1);
    expect(result.transcript).toContain("…[truncated]");
    expect(result.transcript.length).toBeLessThan(200);
  });
});

describe("shadow prompts", () => {
  it("shadow system prompt demands proposal-only output with the fixed sections", () => {
    const prompt = buildDreamShadowSystemPrompt();
    expect(prompt).toContain("SHADOW mode");
    expect(prompt).toContain("## Proposed MEMORY.md blocks");
    expect(prompt).toContain("## Proposed memory_map updates");
    expect(prompt).toContain("## Derived constraints");
    expect(prompt).toContain("Nothing to consolidate.");
  });

  it("user prompt carries the already-known dedup context ahead of the delta", () => {
    const prompt = buildDreamShadowUserPrompt({
      transcript: "[User]\nhello",
      sinceIso: "2026-07-19T00:00:00.000Z",
      alreadyKnown: "### User profile\n- lives in Tempe",
    });
    expect(prompt.indexOf("ALREADY KNOWN")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("ALREADY KNOWN")).toBeLessThan(
      prompt.indexOf("ORCHESTRATOR DELTA"),
    );
    expect(prompt).toContain("2026-07-19T00:00:00.000Z");
  });

  it("delta cutover message embeds the transcript and keeps chronicle listing", () => {
    const msg = buildDreamDeltaUserMessage("[User]\nship it");
    expect(msg).toContain("[User]\nship it");
    expect(msg).toContain('action="list"');
    expect(msg).toContain("chronicle");
  });
});

describe("shadow log", () => {
  const entry = (iso: string, proposal: string): string =>
    formatShadowLogEntry({
      nowIso: iso,
      conversationId: "conv-1",
      sinceTs: 1_700_000_000_000,
      coveredThroughTs: 1_700_000_100_000,
      includedMessages: 3,
      transcriptChars: 120,
      truncated: false,
      liveMemoryChanged: true,
      liveMapChanged: false,
      proposal,
    });

  it("entries carry the comparison header for diffing against the live pass", () => {
    const text = entry("2026-07-19T01:00:00.000Z", "## Proposed MEMORY.md blocks\n- None.");
    expect(text).toContain(SHADOW_LOG_ENTRY_MARKER);
    expect(text).toContain("MEMORY.md changed");
    expect(text).toContain("memory_map.md unchanged");
    expect(text).toContain("conv-1");
  });

  it("appends with a header and drops oldest entries past the budget", () => {
    let log: string | null = null;
    log = appendToShadowLog(log, entry("2026-07-19T01:00:00.000Z", "first"));
    expect(log).toContain("memory_shadow.md — Dream delta-derivation shadow log");
    log = appendToShadowLog(
      log,
      entry("2026-07-19T02:00:00.000Z", "z".repeat(SHADOW_LOG_MAX_CHARS)),
    );
    expect(log.length).toBeLessThanOrEqual(SHADOW_LOG_MAX_CHARS);
    // The newest entry survives; the oldest was dropped.
    expect(log).not.toContain("first");
    log = appendToShadowLog(log, entry("2026-07-19T03:00:00.000Z", "third"));
    expect(log).toContain("third");
    expect(log.length).toBeLessThanOrEqual(SHADOW_LOG_MAX_CHARS);
  });
});
