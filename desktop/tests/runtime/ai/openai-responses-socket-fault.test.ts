// RUNTIME NOTE: run this suite under real Node (e.g. /opt/homebrew/bin/node).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { streamOpenAIResponses } from "../../../../runtime/ai/providers/openai-responses.js";
import type { Context, Model } from "../../../../runtime/ai/types.js";

const servers = new Set<http.Server>();

const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const modelFor = (port: number): Model<"openai-responses"> => ({
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
});

const context: Context = {
  messages: [{ role: "user", content: "say hello", timestamp: 0 }],
};

const listen = async (server: http.Server): Promise<number> => {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("OpenAI Responses socket fault handling", () => {
  it("surfaces a pre-header close as one failed model round", async () => {
    let requestCount = 0;
    const server = http.createServer((_request, _response) => {
      requestCount += 1;
      _request.socket.destroy();
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "test",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/connection|fetch|socket|closed/i);
    expect(requestCount).toBe(1);
  });

  it("does not reconnect or resume after a mid-stream close", async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({ method: request.method, url: request.url });
      for await (const _chunk of request) {
        // Drain the request body before faulting the response stream.
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
            response: { id: "resp_socket_fault" },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              type: "message",
              id: "msg_socket_fault",
              role: "assistant",
              content: [],
              status: "in_progress",
            },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "msg_socket_fault",
            content_index: 0,
            delta: "hel",
          },
        ]),
      );
      setImmediate(() => response.destroy());
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "test",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /connection|stream|socket|closed|terminated/i,
    );
    expect(requests).toEqual([{ method: "POST", url: "/v1/responses" }]);
  });
});
