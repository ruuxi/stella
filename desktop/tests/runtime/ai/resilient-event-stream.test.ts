import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resilientEventStream,
  StreamReconnectError,
  type StreamReconnectInfo,
} from "../../../../runtime/ai/utils/resilient-event-stream.js";

type TestEvent = {
  sequence: number;
  type: "delta" | "tool-result" | "done";
  runId?: string;
  value?: string;
};

const socketClosed = () =>
  new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  );

const source = async function* (
  entries: Array<TestEvent | Error>,
): AsyncGenerator<TestEvent> {
  for (const entry of entries) {
    if (entry instanceof Error) throw entry;
    yield entry;
  }
};

const collect = async (
  stream: AsyncIterable<TestEvent>,
): Promise<TestEvent[]> => {
  const events: TestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const makeStream = (
  overrides: Partial<Parameters<typeof resilientEventStream<TestEvent>>[0]> & {
    connect: () => AsyncIterable<TestEvent> | Promise<AsyncIterable<TestEvent>>;
  },
) =>
  resilientEventStream<TestEvent>({
    getRunId: (event) => event.runId,
    getSequence: (event) => event.sequence,
    isTerminal: (event) => event.type === "done",
    random: () => 0.5,
    ...overrides,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded event-stream connection recovery", () => {
  it("retries a close before headers and then succeeds", async () => {
    vi.useFakeTimers();
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce(source([{ sequence: 0, type: "done" }]));

    const result = collect(makeStream({ connect }));
    await vi.advanceTimersByTimeAsync(249);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual([{ sequence: 0, type: "done" }]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("survives repeated closes that recover inside the deadline", async () => {
    vi.useFakeTimers();
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValueOnce(socketClosed())
      .mockRejectedValueOnce(socketClosed())
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce(source([{ sequence: 0, type: "done" }]));

    const result = collect(makeStream({ connect }));
    await vi.advanceTimersByTimeAsync(1_750);

    await expect(result).resolves.toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("fails once when the strict reconnect deadline is exhausted", async () => {
    vi.useFakeTimers();
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValue(socketClosed());
    const result = collect(
      makeStream({
        connect,
        deadlineMs: 1_000,
        baseDelayMs: 250,
        maxDelayMs: 500,
      }),
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "StreamReconnectError",
      elapsedMs: 1_000,
      attempts: 2,
    });

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung reconnect at the strict total deadline", async () => {
    vi.useFakeTimers();
    const connect = vi
      .fn<(signal?: AbortSignal) => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValueOnce(socketClosed())
      .mockImplementationOnce(async (signal) => {
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(signal?.reason);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          yield { sequence: 0, type: "done" } as TestEvent;
        })();
      });
    const result = collect(
      makeStream({ connect, deadlineMs: 1_000, baseDelayMs: 250 }),
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "StreamReconnectError",
      elapsedMs: 1_000,
      attempts: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes a mid-stream disconnect from its durable run and cursor", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(() =>
      source([
        { sequence: 4, type: "delta", runId: "resp_123", value: "hel" },
        socketClosed(),
      ]),
    );
    const resume = vi.fn(
      ({ runId, cursor }: { runId: string; cursor: number }) => {
        expect({ runId, cursor }).toEqual({ runId: "resp_123", cursor: 4 });
        return source([
          { sequence: 5, type: "delta", runId, value: "lo" },
          { sequence: 6, type: "done", runId },
        ]);
      },
    );

    const result = collect(makeStream({ connect, resume }));
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toMatchObject([
      { sequence: 4, value: "hel" },
      { sequence: 5, value: "lo" },
      { sequence: 6, type: "done" },
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("resumes from a cursor learned during connect before the first event", async () => {
    vi.useFakeTimers();
    let initialState: { runId: string; cursor: number } | undefined;
    const connect = vi.fn(async () => {
      initialState = { runId: "relay_zero_event", cursor: 0 };
      return source([socketClosed()]);
    });
    const resume = vi.fn(() =>
      source([{ sequence: 1, type: "done", runId: "relay_zero_event" }]),
    );

    const result = collect(
      makeStream({
        connect,
        resume,
        getInitialResumeState: () => initialState,
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual([
      { sequence: 1, type: "done", runId: "relay_zero_event" },
    ]);
    expect(connect).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "relay_zero_event", cursor: 0 }),
    );
  });

  it("ends the reconnect deadline once a resumed stream delivers new data", async () => {
    vi.useFakeTimers();
    const result = collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 1, type: "delta", runId: "resp_long", value: "A" },
            socketClosed(),
          ]),
        resume: ({ runId }) =>
          (async function* () {
            yield {
              sequence: 2,
              type: "delta",
              runId,
              value: "B",
            } as TestEvent;
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            yield { sequence: 3, type: "done", runId } as TestEvent;
          })(),
        deadlineMs: 1_000,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_750);
    await expect(result).resolves.toMatchObject([
      { sequence: 1, value: "A" },
      { sequence: 2, value: "B" },
      { sequence: 3, type: "done" },
    ]);
  });

  it("deduplicates replayed events by stable sequence after reconnect", async () => {
    vi.useFakeTimers();
    const result = collect(
      makeStream({
        connect: () =>
          source([
            { sequence: 9, type: "delta", runId: "resp_dup", value: "A" },
            socketClosed(),
          ]),
        resume: ({ runId }) =>
          source([
            { sequence: 9, type: "delta", runId, value: "A" },
            { sequence: 10, type: "delta", runId, value: "B" },
            { sequence: 11, type: "done", runId },
          ]),
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    const events = await result;
    expect(events.map((event) => event.sequence)).toEqual([9, 10, 11]);
    expect(events.filter((event) => event.value === "A")).toHaveLength(1);
  });

  it("preserves partial state and never replays a non-resumable stream", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(() =>
      source([
        { sequence: 1, type: "delta", value: "partial" },
        socketClosed(),
      ]),
    );
    const result = collect(
      makeStream({
        connect,
        deadlineMs: 1_000,
        baseDelayMs: 250,
        maxDelayMs: 500,
      }),
    );
    const rejectionShape = expect(result).rejects.toMatchObject({
      partialResponse: true,
      resumable: false,
      attempts: 0,
    });
    const rejectionMessage = expect(result).rejects.toThrow(
      "request was not replayed",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await Promise.all([rejectionShape, rejectionMessage]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed tool result intact instead of re-executing it", async () => {
    vi.useFakeTimers();
    const executeTool = vi.fn();
    const completedToolResult: TestEvent = {
      sequence: 20,
      type: "tool-result",
      runId: "resp_tool",
      value: "write completed",
    };
    const result = collect(
      makeStream({
        connect: () => source([completedToolResult, socketClosed()]),
        resume: ({ runId }) =>
          source([completedToolResult, { sequence: 21, type: "done", runId }]),
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    const events = await result;
    expect(events.filter((event) => event.type === "tool-result")).toEqual([
      completedToolResult,
    ]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("stops immediately when canceled during backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValue(socketClosed());
    const result = collect(makeStream({ connect, signal: controller.signal }));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller.abort(new Error("Canceled by user"));
    await expect(result).rejects.toThrow("Canceled by user");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry deterministic or explicit provider errors", async () => {
    vi.useFakeTimers();
    const providerError = Object.assign(new Error("invalid_request_error"), {
      status: 400,
    });
    const connect = vi
      .fn<() => Promise<AsyncIterable<TestEvent>>>()
      .mockRejectedValue(providerError);

    await expect(collect(makeStream({ connect }))).rejects.toBe(providerError);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up retry timers and listeners on app shutdown", async () => {
    vi.useFakeTimers();
    const shutdown = new AbortController();
    const removeListener = vi.spyOn(shutdown.signal, "removeEventListener");
    const result = collect(
      makeStream({
        connect: async () => {
          throw socketClosed();
        },
        signal: shutdown.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const rejection = expect(result).rejects.toThrow("Runtime shutting down");

    shutdown.abort(new Error("Runtime shutting down"));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("reports reconnecting throughout the grace period and terminal failure only once", async () => {
    vi.useFakeTimers();
    const lifecycle: string[] = ["running"];
    const reconnects: StreamReconnectInfo[] = [];
    const result = collect(
      makeStream({
        connect: async () => {
          throw socketClosed();
        },
        deadlineMs: 1_000,
        baseDelayMs: 250,
        maxDelayMs: 500,
        onReconnect: (info) => {
          reconnects.push(info);
          lifecycle.push("reconnecting");
        },
      }),
    ).catch((error) => {
      lifecycle.push("failed");
      throw error;
    });
    const rejection =
      expect(result).rejects.toBeInstanceOf(StreamReconnectError);

    await vi.advanceTimersByTimeAsync(999);
    expect(lifecycle).not.toContain("failed");
    expect(reconnects.every((info) => info.phase === "connect")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(lifecycle.filter((state) => state === "failed")).toHaveLength(1);
    expect(lifecycle.at(-1)).toBe("failed");
  });
});
