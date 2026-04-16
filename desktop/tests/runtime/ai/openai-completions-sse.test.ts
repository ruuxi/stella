import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../../../runtime/ai/utils/event-stream.js";
import {
  createAssistantMessageShell,
  pumpOpenAICompatibleChatCompletionsResponse,
} from "../../../../runtime/ai/utils/openai-completions-sse.js";

const collectEventTypes = async (stream: AssistantMessageEventStream) => {
  const eventTypes: string[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
  }
  return eventTypes;
};

describe("pumpOpenAICompatibleChatCompletionsResponse", () => {
  it("turns reasoning_content SSE chunks into thinking blocks", async () => {
    const response = new Response(
      [
        'data: {"model":"openai/gpt-5.4","choices":[{"delta":{"reasoning_content":"Need to inspect the task."}}]}',
        "",
        'data: {"model":"openai/gpt-5.4","choices":[{"delta":{"reasoning_signature":"{\\"type\\":\\"reasoning\\",\\"id\\":\\"rs_123\\",\\"summary\\":[{\\"type\\":\\"summary_text\\",\\"text\\":\\"Need to inspect the task.\\"}]}"}}]}',
        "",
        'data: {"model":"openai/gpt-5.4","choices":[{"delta":{"content":"Done."}}]}',
        "",
        'data: {"model":"openai/gpt-5.4","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"completion_tokens_details":{"reasoning_tokens":3}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        headers: {
          "Content-Type": "text/event-stream",
        },
      },
    );

    const stream = new AssistantMessageEventStream();
    const output = createAssistantMessageShell({
      api: "openai-completions",
      provider: "stella",
      id: "stella/default",
    });

    await pumpOpenAICompatibleChatCompletionsResponse({
      response,
      stream,
      output,
    });

    const eventTypes = await collectEventTypes(stream);
    expect(eventTypes).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);

    expect(output.content).toEqual([
      {
        type: "thinking",
        thinking: "Need to inspect the task.",
        thinkingSignature: '{"type":"reasoning","id":"rs_123","summary":[{"type":"summary_text","text":"Need to inspect the task."}]}',
      },
      {
        type: "text",
        text: "Done.",
      },
    ]);
    expect(output.usage).toMatchObject({
      input: 12,
      output: 5,
      totalTokens: 17,
    });
  });
});
