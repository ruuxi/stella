// Reproduces the field failure: sub-agents on an OpenRouter OpenAI reasoning
// model (gpt-5.5) hit "Provider returned error" a few tool-loop turns in.
//
// Root cause: the openai-completions stream parser tags reasoning with its
// SOURCE FIELD NAME as a pseudo-`thinkingSignature` ("reasoning"), and the
// request builder echoed that reasoning text back onto the outgoing assistant
// message under that field name (`assistantMsg.reasoning = "..."`). Cloud
// reasoning models (OpenAI/OpenRouter) manage reasoning server-side and reject
// a replayed plaintext `reasoning` field — so replaying it corrupts every
// subsequent request in a multi-turn (esp. parallel-tool) loop.
//
// The fix gates that echo behind `compat.replayReasoningContentField`, which is
// only auto-enabled for local self-hosted endpoints (llama.cpp / gpt-oss) that
// actually need reasoning replayed. These tests assert the outgoing request is
// provider-valid for OpenRouter (no placeholder reasoning field) while the
// local behavior is preserved.

import { describe, expect, it } from "vitest";
import {
  convertMessages,
  getCompat,
} from "../../../../runtime/ai/providers/openai-completions.js";
import type {
  AssistantMessage,
  Context,
  Model,
  ToolResultMessage,
} from "../../../../runtime/ai/types.js";

const makeModel = (
  provider: string,
  id: string,
  baseUrl: string,
): Model<"openai-completions"> => ({
  id,
  name: id,
  api: "openai-completions",
  provider: provider as never,
  baseUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

// An assistant turn shaped like the one that preceded the field failure:
// a reasoning (thinking) block carrying the placeholder signature "reasoning"
// plus two parallel tool calls. `provider`/`api`/`model` match the request
// model so the cross-model transform keeps the thinking block (same-model
// reasoning is retained), which is exactly what reaches the request builder.
const reasoningAssistantTurn = (
  provider: string,
  model: string,
): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "thinking",
      thinking: "**Inspecting pi-mono** I need to keep going and inspect it.",
      thinkingSignature: "reasoning",
    },
    {
      type: "toolCall",
      id: "call_0vJ4wdByAAfxKnYgNyfEWhZz",
      name: "exec_command",
      arguments: { cmd: "git status --short" },
    },
    {
      type: "toolCall",
      id: "call_hZK6s3sX7fICtwTRWgph3ct1",
      name: "exec_command",
      arguments: { cmd: "rg --files -g '*model*'" },
    },
  ],
  api: "openai-completions",
  provider: provider as never,
  model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 0,
});

const toolResult = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "exec_command",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 0,
});

const buildContext = (provider: string, model: string): Context => ({
  systemPrompt: "You are a Stella sub-agent.",
  messages: [
    { role: "user", content: "Investigate pi-mono.", timestamp: 0 },
    reasoningAssistantTurn(provider, model),
    toolResult("call_0vJ4wdByAAfxKnYgNyfEWhZz"),
    toolResult("call_hZK6s3sX7fICtwTRWgph3ct1"),
    { role: "user", content: "Continue.", timestamp: 0 },
  ],
});

const assistantParams = (messages: ReturnType<typeof convertMessages>) =>
  messages.filter(
    (m): m is Extract<typeof m, { role: "assistant" }> =>
      m.role === "assistant",
  );

describe("openai-completions reasoning replay across a provider switch", () => {
  it("does NOT echo the placeholder reasoning field for an OpenRouter OpenAI model", () => {
    const model = makeModel(
      "openrouter",
      "openai/gpt-5.5",
      "https://openrouter.ai/api/v1",
    );
    const context = buildContext("openrouter", "openai/gpt-5.5");

    const messages = convertMessages(model, context, getCompat(model));
    const assistants = assistantParams(messages);
    expect(assistants.length).toBe(1);
    const assistant = assistants[0] as Record<string, unknown>;

    // The bug: assistant.reasoning === "<plaintext reasoning>" — rejected by
    // the provider. After the fix it must be absent.
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.reasoning_content).toBeUndefined();
    // The turn must still carry its (parallel) tool calls, i.e. it's a valid
    // assistant message, not dropped.
    expect(Array.isArray(assistant.tool_calls)).toBe(true);
    expect((assistant.tool_calls as unknown[]).length).toBe(2);
  });

  it("still echoes reasoning back for a local self-hosted endpoint (llama.cpp/gpt-oss)", () => {
    const model = makeModel("local", "gpt-oss", "http://127.0.0.1:11434/v1");
    const context = buildContext("local", "gpt-oss");

    const messages = convertMessages(model, context, getCompat(model));
    const assistant = assistantParams(messages)[0] as Record<string, unknown>;

    // Local replay behavior is preserved: the reasoning is echoed under the
    // field it arrived on.
    expect(assistant.reasoning).toBe(
      "**Inspecting pi-mono** I need to keep going and inspect it.",
    );
  });

  it("gates purely on the compat flag (no reliance on model.reasoning)", () => {
    const model = makeModel(
      "openrouter",
      "openai/gpt-5.5",
      "https://openrouter.ai/api/v1",
    );
    expect(getCompat(model).replayReasoningContentField).toBe(false);

    const localModel = makeModel(
      "local",
      "gpt-oss",
      "http://127.0.0.1:11434/v1",
    );
    expect(getCompat(localModel).replayReasoningContentField).toBe(true);
  });
});
