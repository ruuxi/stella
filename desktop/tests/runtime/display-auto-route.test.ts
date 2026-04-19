import { describe, expect, it } from "vitest";
import { findLatestDisplayCandidate } from "../../src/app/chat/use-display-auto-route";
import type { EventRecord } from "../../src/app/chat/lib/event-transforms";

const event = (
  partial: Partial<EventRecord> & Pick<EventRecord, "_id" | "type" | "timestamp">,
): EventRecord => ({
  payload: {},
  ...partial,
});

describe("findLatestDisplayCandidate", () => {
  it("returns null when there is nothing visual in the stream", () => {
    expect(findLatestDisplayCandidate([])).toBeNull();
    expect(
      findLatestDisplayCandidate([
        event({
          _id: "e1",
          type: "tool_result",
          timestamp: 1,
          payload: { toolName: "Bash", result: "hello" },
        }),
      ]),
    ).toBeNull();
  });

  it("routes office preview refs from tool results", () => {
    const previewRef = {
      sessionId: "session-A",
      title: "deck.pptx",
      sourcePath: "/tmp/deck.pptx",
    };

    const result = findLatestDisplayCandidate([
      event({
        _id: "e1",
        type: "tool_result",
        timestamp: 1,
        payload: {
          toolName: "Bash",
          result: "Started inline office preview.",
          officePreviewRef: previewRef,
        },
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.payload).toEqual({ kind: "office", previewRef });
    expect(result?.sourceId).toBe("e1");
  });

  it("routes Read tool calls against .pdf paths once the result arrives", () => {
    const events: EventRecord[] = [
      event({
        _id: "req-1",
        requestId: "req-1",
        type: "tool_request",
        timestamp: 1,
        payload: {
          toolName: "Read",
          args: { path: "/tmp/invoice.pdf" },
        },
      }),
      event({
        _id: "res-1",
        requestId: "req-1",
        type: "tool_result",
        timestamp: 2,
        payload: { toolName: "Read", result: "PDF contents" },
      }),
    ];

    const result = findLatestDisplayCandidate(events);
    expect(result?.payload).toEqual({
      kind: "pdf",
      filePath: "/tmp/invoice.pdf",
    });
  });

  it("ignores Read calls against non-PDF paths", () => {
    const events: EventRecord[] = [
      event({
        _id: "req-1",
        requestId: "req-1",
        type: "tool_request",
        timestamp: 1,
        payload: { toolName: "Read", args: { path: "/tmp/notes.md" } },
      }),
      event({
        _id: "res-1",
        requestId: "req-1",
        type: "tool_result",
        timestamp: 2,
        payload: { toolName: "Read", result: "..." },
      }),
    ];

    expect(findLatestDisplayCandidate(events)).toBeNull();
  });

  it("does not route a PDF Read whose result errored", () => {
    const events: EventRecord[] = [
      event({
        _id: "req-1",
        requestId: "req-1",
        type: "tool_request",
        timestamp: 1,
        payload: { toolName: "Read", args: { path: "/tmp/missing.pdf" } },
      }),
      event({
        _id: "res-1",
        requestId: "req-1",
        type: "tool_result",
        timestamp: 2,
        payload: { toolName: "Read", error: "ENOENT" },
      }),
    ];

    expect(findLatestDisplayCandidate(events)).toBeNull();
  });

  it("prefers the most recent visual candidate", () => {
    const previewRef = {
      sessionId: "session-A",
      title: "deck.pptx",
      sourcePath: "/tmp/deck.pptx",
    };

    const events: EventRecord[] = [
      event({
        _id: "e1",
        type: "tool_result",
        timestamp: 10,
        payload: { toolName: "Bash", officePreviewRef: previewRef },
      }),
      event({
        _id: "req-2",
        requestId: "req-2",
        type: "tool_request",
        timestamp: 20,
        payload: { toolName: "Read", args: { path: "/tmp/q4.pdf" } },
      }),
      event({
        _id: "res-2",
        requestId: "req-2",
        type: "tool_result",
        timestamp: 30,
        payload: { toolName: "Read", result: "..." },
      }),
    ];

    const result = findLatestDisplayCandidate(events);
    expect(result?.payload).toEqual({ kind: "pdf", filePath: "/tmp/q4.pdf" });
    expect(result?.sourceId).toBe("res-2");
  });
});
