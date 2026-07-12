import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { streamOpenAIResponses } from "../../../../runtime/ai/providers/openai-responses.js";
import type { Context, Model } from "../../../../runtime/ai/types.js";

const servers = new Set<http.Server>();

const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const completedResponse = (id: string, text = "") => ({
  id,
  status: "completed",
  output: [],
  usage: {
    input_tokens: 1,
    output_tokens: text ? 1 : 0,
    total_tokens: text ? 2 : 1,
    input_tokens_details: { cached_tokens: 0 },
  },
});

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("OpenAI Responses socket fault injection", () => {
  it("reproduces a pre-header socket close and recovers on the idempotent retry", async () => {
    let requestCount = 0;
    const idempotencyKeys: Array<string | undefined> = [];
    const requestBodies: string[] = [];
    const server = http.createServer(async (request, response) => {
      requestCount += 1;
      idempotencyKeys.push(request.headers["idempotency-key"]);
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requestBodies.push(body);
      if (requestCount === 1) {
        request.socket.destroy();
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.end(
        sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_fault_injection" },
          },
          {
            type: "response.completed",
            sequence_number: 1,
            response: completedResponse("resp_fault_injection"),
          },
        ]) + "data: [DONE]\n\n",
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    const model: Model<"openai-responses"> = {
      id: "test-model",
      name: "Fault injection model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };
    const context: Context = {
      messages: [
        { role: "user", content: "write the file", timestamp: 0 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_completed|item_completed",
              name: "apply_patch",
              arguments: { patch: "done" },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_completed|item_completed",
          toolName: "apply_patch",
          content: [{ type: "text", text: "file write completed" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.responseId).toBe("resp_fault_injection");
    expect(requestCount).toBe(2);
    expect(idempotencyKeys[0]).toMatch(/^stella-response-/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    const retriedInput = JSON.parse(requestBodies[1]!) as {
      input: Array<{ type?: string; output?: string }>;
    };
    expect(
      retriedInput.input.filter(
        (item) =>
          item.type === "function_call_output" &&
          item.output?.includes("file write completed"),
      ),
    ).toHaveLength(1);
  });

  it("resumes a durable mid-stream response by id and cursor without duplicating deltas", async () => {
    const responseId = "resp_resume_fault";
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.method === "POST") {
        for await (const _chunk of request) {
          // Drain the create body before faulting the response stream.
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              response: { id: responseId },
            },
            {
              type: "response.output_item.added",
              sequence_number: 1,
              output_index: 0,
              item: {
                type: "message",
                id: "msg_resume",
                role: "assistant",
                content: [],
                status: "in_progress",
              },
            },
            {
              type: "response.output_text.delta",
              sequence_number: 2,
              output_index: 0,
              item_id: "msg_resume",
              content_index: 0,
              delta: "hel",
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.end(
        sse([
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "msg_resume",
            content_index: 0,
            delta: "hel",
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: "msg_resume",
            content_index: 0,
            delta: "lo",
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 0,
            item: {
              type: "message",
              id: "msg_resume",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "hello",
                  annotations: [],
                },
              ],
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            response: completedResponse(responseId, "hello"),
          },
        ]) + "data: [DONE]\n\n",
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const model: Model<"openai-responses"> = {
      id: "test-model",
      name: "Resumable fault model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };

    const stream = streamOpenAIResponses(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: "test",
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          background: true,
          store: true,
        }),
      },
    );
    const textDeltas: string[] = [];
    const eventsDone = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") textDeltas.push(event.delta);
      }
    })();
    const result = await stream.result();
    await eventsDone;

    expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
    expect(textDeltas.join("")).toBe("hello");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/responses" });
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toContain(
      `/v1/responses/${responseId}?stream=true&starting_after=2`,
    );
  });

  it("resumes an unexpected relay EOF from the advertised relay cursor without replaying the POST or tool call", async () => {
    const relayRequestId = "relay_resume_fault";
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === "POST") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": relayRequestId,
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              stella_relay_sequence: 1,
              response: { id: "resp_provider" },
            },
            {
              type: "response.output_item.added",
              sequence_number: 1,
              stella_relay_sequence: 2,
              output_index: 0,
              item: {
                type: "function_call",
                id: "item_tool",
                call_id: "call_tool",
                name: "read_file",
                arguments: "",
                status: "in_progress",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              sequence_number: 2,
              stella_relay_sequence: 3,
              output_index: 0,
              item_id: "item_tool",
              delta: '{"path":"/tmp/',
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-stella-relay-resume": "1",
        "x-stella-relay-request-id": relayRequestId,
        connection: "close",
      });
      response.end(
        sse([
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 2,
            stella_relay_sequence: 3,
            output_index: 0,
            item_id: "item_tool",
            delta: '{"path":"/tmp/',
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 3,
            stella_relay_sequence: 4,
            output_index: 0,
            item_id: "item_tool",
            delta: 'evidence.txt"}',
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            stella_relay_sequence: 5,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item_tool",
              call_id: "call_tool",
              name: "read_file",
              arguments: '{"path":"/tmp/evidence.txt"}',
              status: "completed",
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            stella_relay_sequence: 6,
            response: completedResponse("resp_provider"),
          },
        ]) + "data: [DONE]\n\n",
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const model: Model<"openai-responses"> = {
      id: "stella/openai/test-model",
      name: "Relay resumable model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };

    const result = await streamOpenAIResponses(
      model,
      { messages: [{ role: "user", content: "read it", timestamp: 0 }] },
      { apiKey: "test" },
    ).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call_tool|item_tool",
        name: "read_file",
        arguments: { path: "/tmp/evidence.txt" },
      },
    ]);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[1]?.url).toContain(
      `/v1/responses/${relayRequestId}?stream=true&starting_after=3`,
    );
    expect(JSON.parse(requests[0]!.body).store).toBe(false);
  });

  it("surfaces an expired relay cursor without replaying the original POST", async () => {
    let posts = 0;
    let gets = 0;
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain request bodies.
      }
      if (request.method === "POST") {
        posts += 1;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": "relay_expired",
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              stella_relay_sequence: 1,
              response: { id: "resp_expired" },
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }
      gets += 1;
      response.writeHead(410, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Relay resume cursor expired" } }),
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const model: Model<"openai-responses"> = {
      id: "stella/openai/test-model",
      name: "Expired relay cursor model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };

    const result = await streamOpenAIResponses(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "test" },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Relay resume cursor expired");
    expect(posts).toBe(1);
    expect(gets).toBe(1);
  });

  it("sends an owner-authenticated relay cancel signal on explicit abort", async () => {
    const methods: string[] = [];
    let resolveDelete!: () => void;
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const server = http.createServer(async (request, response) => {
      methods.push(request.method ?? "");
      for await (const _chunk of request) {
        // Drain request bodies.
      }
      if (request.method === "DELETE") {
        expect(request.url).toBe("/v1/responses/relay_cancel");
        response.writeHead(204);
        response.end();
        resolveDelete();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-stella-relay-resume": "1",
        "x-stella-relay-request-id": "relay_cancel",
      });
      response.write(
        sse([
          {
            type: "response.created",
            sequence_number: 0,
            stella_relay_sequence: 1,
            response: { id: "resp_cancel" },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            stella_relay_sequence: 2,
            output_index: 0,
            item: {
              type: "message",
              id: "msg_cancel",
              role: "assistant",
              content: [],
              status: "in_progress",
            },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            stella_relay_sequence: 3,
            output_index: 0,
            item_id: "msg_cancel",
            content_index: 0,
            delta: "partial",
          },
        ]),
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const model: Model<"openai-responses"> = {
      id: "stella/openai/test-model",
      name: "Relay cancellation model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };
    const stream = streamOpenAIResponses(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "test", signal: controller.signal },
    );
    const eventsDone = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") controller.abort("user canceled");
      }
    })();

    const result = await stream.result();
    await eventsDone;
    await deleted;
    expect(result.stopReason).toBe("aborted");
    expect(methods).toEqual(["POST", "DELETE"]);
  });
});
