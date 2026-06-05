---
name: stella-llm
description: Call language models through Stella's managed LLM relay using the user's Stella auth. Use when a Stella-created app, runtime helper, script, or integration needs LLM capabilities without direct provider API keys.
---

# Stella Managed LLM Calls

Stella ships a managed language-model helper. Use it when you need LLM
capabilities inside Stella, a Stella-created app, a local script, or an
integration and the request should use Stella auth, billing, model access, and
backend-held provider keys.

Do not call provider APIs directly unless the user explicitly asks for a direct
provider integration. Direct calls bypass Stella's auth, quotas, billing, model
catalog, logging, and key isolation.

## Use the Helper

For desktop renderer code and Stella-created apps, import the helper:

```ts
import { callStellaLlmText } from "@/platform/ai/llm";

const title = await callStellaLlmText("Name this note in five words.", {
  systemPrompt: "Return only the title text.",
});
```

For structured calls:

```ts
import { callStellaLlm, extractChatText } from "@/platform/ai/llm";

const response = await callStellaLlm({
  agentType: "my-app",
  model: "stella/light",
  systemPrompt: "Return valid compact JSON.",
  prompt: "Return a short JSON label for this task.",
  body: { response_format: { type: "json_object" } },
});

const text = extractChatText(response);
```

The helper handles the Stella endpoint, bearer auth, device header, and default
model. Callers should pass only `prompt`, optional `systemPrompt`, or explicit
`messages`, plus small options such as `agentType`, `model`, `maxTokens`,
`temperature`, or extra request-body fields.

## Prompt, System Prompt, and Context

Use `prompt` for the immediate user/app request and `systemPrompt` for behavior
instructions:

```ts
await callStellaLlmText("Suggest a filename.", {
  systemPrompt: "Return one kebab-case filename without an extension.",
});
```

Use `messages` only when the integration wants to provide its own chat history,
examples, or context. These are OpenAI-style chat messages owned by the caller;
they are not Stella's saved conversation transcript.

```ts
const response = await callStellaLlm({
  systemPrompt: "Continue the user's planning context.",
  messages: [
    { role: "user", content: "I have ten minutes before a meeting." },
    { role: "assistant", content: "Prioritize one small task." },
  ],
  prompt: "What should I do now?",
});
```

If both `messages` and `prompt` are provided, the helper sends:
`systemPrompt`, then `messages`, then the final `prompt`.

## Model and Streaming

The model is optional. Omit it for Stella's default managed model, or pass a
Stella alias when the task needs a specific behavior:

```ts
await callStellaLlmText("Explain this bug in one sentence.", {
  model: "stella/builder",
});
```

Streaming is optional. Omit `stream` for a parsed JSON response. Set
`stream: true` when the caller wants the raw streamed HTTP response and will
consume it itself:

```ts
const response = await callStellaLlm({
  prompt: "Draft a long outline.",
  stream: true,
});

for await (const chunk of response.body ?? []) {
  // Consume the provider-compatible stream.
}
```

## Runtime and Script Code

If you are in lower-level runtime code that already uses Stella's model router,
prefer that route instead of hand-written HTTP:

- `resolveLlmRoute(...)` for provider-aware runtime execution.
- `runOneShotCompletion(...)` for short internal text completions.

If you truly need raw HTTP in a Node script, use the canonical runtime env names
only: `STELLA_LLM_PROXY_URL` and `STELLA_LLM_PROXY_TOKEN`. Do not introduce
new env var names or provider API keys.

## Models

The helper defaults to Stella's standard model. Only pass `model` when the task
really needs a different Stella model. Prefer Stella aliases such as
`stella/default`, `stella/light`, or `stella/builder` over provider-native IDs.

## Usage Rules

- Keep prompts and outputs scoped to the user task. Do not send secrets,
private files, or large unrelated context.
- Use `callStellaLlmText` for plain text and `callStellaLlm` for structured
responses or streaming.
- Treat `messages` as caller-owned context, not Stella chat persistence.
- Do not manually build `/api/stella` URLs in app code when the helper can do it.
- Handle `401` as signed out and ask the user to sign in to Stella.
- Handle `429` as model quota/subscription/rate-limit state and surface the
backend message.
- Handle `503` as backend provider configuration unavailable; do not ask the
user for a provider key.

## Backlinks

- [stella-media](../stella-media/SKILL.md)
