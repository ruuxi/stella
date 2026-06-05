import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
} from "../../../src/shared/stella-api.js";

const postServiceJson = vi.fn();
const createServiceRequest = vi.fn();

vi.mock("@/platform/http/service-request", () => ({
  createServiceRequest,
  postServiceJson,
}));

describe("Stella LLM helper", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    postServiceJson.mockReset();
    createServiceRequest.mockReset();
    globalThis.fetch = originalFetch;
  });

  it("uses Stella managed chat completions with default auth-bearing service request", async () => {
    postServiceJson.mockResolvedValue({
      choices: [{ message: { content: "done" } }],
    });

    const { callStellaLlmText } = await import(
      "../../../src/platform/ai/llm.js"
    );

    await expect(callStellaLlmText("Summarize this.")).resolves.toBe("done");

    expect(postServiceJson).toHaveBeenCalledWith(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        model: STELLA_DEFAULT_MODEL,
        messages: [{ role: "user", content: "Summarize this." }],
        stream: false,
      },
      {
        headers: {
          "X-Stella-Agent-Type": "app",
        },
        errorMessage: expect.any(Function),
      },
    );
  });

  it("passes explicit options without exposing auth variables to callers", async () => {
    postServiceJson.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    const { callStellaLlm } = await import("../../../src/platform/ai/llm.js");

    await callStellaLlm({
      agentType: "widget",
      model: "stella/light",
      maxTokens: 128,
      temperature: 0.2,
      messages: [{ role: "user", content: "Name this." }],
      body: { response_format: { type: "json_object" } },
    });

    expect(postServiceJson).toHaveBeenCalledWith(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        response_format: { type: "json_object" },
        model: "stella/light",
        messages: [{ role: "user", content: "Name this." }],
        max_tokens: 128,
        temperature: 0.2,
        stream: false,
      },
      {
        headers: {
          "X-Stella-Agent-Type": "widget",
        },
        errorMessage: expect.any(Function),
      },
    );
  });

  it("accepts prompt and system prompt directly", async () => {
    postServiceJson.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    const { callStellaLlm } = await import("../../../src/platform/ai/llm.js");

    await callStellaLlm({
      agentType: "widget",
      prompt: "Name this note.",
      systemPrompt: "Return only plain text.",
    });

    expect(postServiceJson).toHaveBeenCalledWith(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        model: STELLA_DEFAULT_MODEL,
        messages: [
          { role: "system", content: "Return only plain text." },
          { role: "user", content: "Name this note." },
        ],
        stream: false,
      },
      {
        headers: {
          "X-Stella-Agent-Type": "widget",
        },
        errorMessage: expect.any(Function),
      },
    );
  });

  it("can include caller-provided message history before the prompt", async () => {
    postServiceJson.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    const { callStellaLlm } = await import("../../../src/platform/ai/llm.js");

    await callStellaLlm({
      prompt: "What should I do next?",
      systemPrompt: "You are concise.",
      messages: [
        { role: "user", content: "I have three tasks." },
        { role: "assistant", content: "List them by urgency." },
      ],
    });

    expect(postServiceJson).toHaveBeenCalledWith(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        model: STELLA_DEFAULT_MODEL,
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "I have three tasks." },
          { role: "assistant", content: "List them by urgency." },
          { role: "user", content: "What should I do next?" },
        ],
        stream: false,
      },
      {
        headers: {
          "X-Stella-Agent-Type": "app",
        },
        errorMessage: expect.any(Function),
      },
    );
  });

  it("returns the raw response for streamed output", async () => {
    const response = new Response("data: {}\n\n", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock;
    createServiceRequest.mockResolvedValue({
      endpoint: "https://stella.example/api/stella/relay/chat/completions",
      headers: {
        Authorization: "Bearer stella-token",
        "X-Device-ID": "device-id",
        "Content-Type": "application/json",
        "X-Stella-Agent-Type": "streamer",
      },
    });

    const { callStellaLlm } = await import("../../../src/platform/ai/llm.js");

    await expect(
      callStellaLlm({
        agentType: "streamer",
        model: "stella/builder",
        prompt: "Stream this.",
        stream: true,
      }),
    ).resolves.toBe(response);

    expect(createServiceRequest).toHaveBeenCalledWith(
      STELLA_CHAT_COMPLETIONS_PATH,
      {
        "X-Stella-Agent-Type": "streamer",
        "Content-Type": "application/json",
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://stella.example/api/stella/relay/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer stella-token",
          "X-Device-ID": "device-id",
          "Content-Type": "application/json",
          "X-Stella-Agent-Type": "streamer",
        },
        body: JSON.stringify({
          model: "stella/builder",
          messages: [{ role: "user", content: "Stream this." }],
          stream: true,
        }),
      },
    );
  });
});
