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
});
