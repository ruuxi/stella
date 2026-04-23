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
  it("returns null when there is nothing media-shaped in the stream", () => {
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

  it("does not auto-route Office previews any more (handled by the chat resource pill)", () => {
    const previewRef = {
      sessionId: "session-A",
      title: "deck.pptx",
      sourcePath: "/tmp/deck.pptx",
    };

    expect(
      findLatestDisplayCandidate([
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
      ]),
    ).toBeNull();
  });

  it("does not auto-route PDF Read results any more", () => {
    expect(
      findLatestDisplayCandidate([
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
      ]),
    ).toBeNull();
  });

  it("auto-routes image_gen results with local file paths", () => {
    const result = findLatestDisplayCandidate([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 42,
        payload: {
          toolName: "image_gen",
          result: {
            jobId: "job-abc",
            capability: "text_to_image",
            prompt: "A dog over Tokyo",
            filePaths: ["/state/media/outputs/job-abc_0.png"],
          },
        },
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.sourceId).toBe("ig-1");
    expect(result?.payload).toEqual({
      kind: "media",
      asset: { kind: "image", filePaths: ["/state/media/outputs/job-abc_0.png"] },
      jobId: "job-abc",
      capability: "text_to_image",
      prompt: "A dog over Tokyo",
      createdAt: 42,
    });
  });

  it("ignores image_gen results that errored", () => {
    expect(
      findLatestDisplayCandidate([
        event({
          _id: "ig-err",
          type: "tool_result",
          timestamp: 1,
          payload: {
            toolName: "image_gen",
            error: "timeout",
            result: {
              jobId: "job-x",
              filePaths: ["/state/media/outputs/x.png"],
            },
          },
        }),
      ]),
    ).toBeNull();
  });

  it("prefers the most recent image_gen candidate when several land in one tick", () => {
    const result = findLatestDisplayCandidate([
      event({
        _id: "ig-1",
        type: "tool_result",
        timestamp: 10,
        payload: {
          toolName: "image_gen",
          result: { jobId: "j1", filePaths: ["/a.png"] },
        },
      }),
      event({
        _id: "ig-2",
        type: "tool_result",
        timestamp: 20,
        payload: {
          toolName: "image_gen",
          result: { jobId: "j2", filePaths: ["/b.png"] },
        },
      }),
    ]);
    expect(result?.sourceId).toBe("ig-2");
  });
});
