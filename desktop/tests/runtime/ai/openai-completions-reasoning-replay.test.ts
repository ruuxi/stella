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

// A cloud DeepSeek-style reasoning model streams reasoning under
// `reasoning_content`, so the parser tags the thinking block with that field
// name as its pseudo-signature. DeepSeek is cloud (not local), so after the
// a21e37f50 fix the placeholder must NOT be echoed back; instead the outgoing
// assistant message carries an empty `reasoning_content` (required by
// `requiresReasoningContentOnAssistantMessages`). Replaying the plaintext
// reasoning here would make a multi-turn / parallel-tool loop get rejected.
const deepseekReasoningTurn = (): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "thinking",
      thinking: "**Planning** I should inspect the repo before editing.",
      thinkingSignature: "reasoning_content",
    },
    {
      type: "toolCall",
      id: "call_ds_0",
      name: "exec_command",
      arguments: { cmd: "git status --short" },
    },
    {
      type: "toolCall",
      id: "call_ds_1",
      name: "exec_command",
      arguments: { cmd: "rg --files -g '*model*'" },
    },
  ],
  api: "openai-completions",
  provider: "deepseek" as never,
  model: "deepseek-reasoner",
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

describe("openai-completions reasoning replay for a cloud DeepSeek model", () => {
  it("emits an empty reasoning_content, not the echoed plaintext reasoning", () => {
    const model = makeModel(
      "deepseek",
      "deepseek-reasoner",
      "https://api.deepseek.com/v1",
    );
    // Cloud DeepSeek: required reasoning_content is on, replay is off.
    const compat = getCompat(model);
    expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(compat.replayReasoningContentField).toBe(false);

    const context: Context = {
      systemPrompt: "You are a Stella sub-agent.",
      messages: [
        { role: "user", content: "Investigate the repo.", timestamp: 0 },
        deepseekReasoningTurn(),
        toolResult("call_ds_0"),
        toolResult("call_ds_1"),
        { role: "user", content: "Continue.", timestamp: 0 },
      ],
    };

    const messages = convertMessages(model, context, compat);
    const assistant = assistantParams(messages)[0] as Record<string, unknown>;

    // The bug would set reasoning_content to the plaintext reasoning; the fix
    // leaves it empty so the request stays provider-valid across turns.
    expect(assistant.reasoning_content).toBe("");
    expect(assistant.reasoning).toBeUndefined();
    // The parallel tool calls are preserved.
    expect(Array.isArray(assistant.tool_calls)).toBe(true);
    expect((assistant.tool_calls as unknown[]).length).toBe(2);
  });
});

// Fix #2: local-endpoint detection must recognize IPv6 loopback, the wildcard
// bind address, and mDNS `*.local` hosts (a self-hosted model reached via a
// non-`local` provider on such an address) while never misreading a cloud
// endpoint as local.
describe("openai-completions local-endpoint detection", () => {
  const replayFor = (baseUrl: string) =>
    getCompat(makeModel("openai", "self-hosted", baseUrl))
      .replayReasoningContentField;

  it("treats loopback / self-hosted URLs as local", () => {
    for (const baseUrl of [
      "http://127.0.0.1:11434/v1",
      "http://127.1.2.3:8080/v1",
      "http://localhost:8080/v1",
      "http://[::1]:8080/v1",
      "http://0.0.0.0:8080/v1",
      "http://my-box.local:8080/v1",
    ]) {
      expect(replayFor(baseUrl), baseUrl).toBe(true);
    }
  });

  it("never misclassifies a cloud endpoint as local", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1",
      "https://openrouter.ai/api/v1",
      "https://api.deepseek.com/v1",
      "https://api.x.ai/v1",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
    ]) {
      expect(replayFor(baseUrl), baseUrl).toBe(false);
    }
  });

  it("falls back safely on a malformed URL", () => {
    expect(replayFor("not a url")).toBe(false);
    expect(replayFor("http://127.0.0.1 bad url")).toBe(true);
  });
});
