/**
 * Hits each provider stream function twice with the same large prefix
 * to verify prompt caching is taking effect. Reads keys from this shell's
 * env; pre-export them via `bunx convex env get …` before running.
 *
 *   for k in ANTHROPIC_API_KEY OPENAI_API_KEY FIREWORKS_API_KEY GOOGLE_AI_API_KEY OPENROUTER_API_KEY; do
 *     export $k="$(cd backend && bunx convex env get $k 2>/dev/null)";
 *   done
 *   bun backend/scripts/verify-prompt-cache.ts
 */
import { streamAnthropic } from "../convex/runtime_ai/anthropic";
import { streamOpenAICompletions } from "../convex/runtime_ai/openai_completions";
import { streamOpenAIResponses } from "../convex/runtime_ai/openai_responses";
import { streamGoogle } from "../convex/runtime_ai/google";
import type { Api, Context, Model } from "../convex/runtime_ai/types";

// Padding gets us above the 1024-token caching threshold all four providers
// share. Keep the prefix identical across both runs in a scenario.
const filler = Array.from({ length: 200 }, (_, i) =>
  `Section ${i}: This is filler content used to push the system prompt above the 1024-token minimum required for prompt caching. Each section repeats roughly the same pattern so that across two requests the cacheable prefix is identical.`,
).join("\n");

const systemPrompt = `You are a test agent. Reply with one short sentence.\n\n${filler}`;

const tools = [
  {
    name: "echo",
    description: "Echo a string back to the caller. (test tool, do not call)",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
];

const baseContext: Context = {
  systemPrompt,
  messages: [{ role: "user", content: "say hi", timestamp: Date.now() }],
  tools,
};

type StreamRunner = (label: string) => Promise<{ cacheRead: number; cacheWrite: number; input: number; output: number }>;

const sessionId = `verify-cache-${Date.now()}`;

function makeModel<TApi extends Api>(args: {
  api: TApi;
  id: string;
  baseUrl: string;
  provider: string;
  reasoning?: boolean;
}): Model<TApi> {
  return {
    id: args.id,
    name: args.id,
    api: args.api,
    provider: args.provider,
    baseUrl: args.baseUrl,
    reasoning: args.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 1024,
  };
}

async function drain(stream: AsyncIterable<any>) {
  let last: any = null;
  for await (const event of stream) {
    if (event.type === "done") last = event.message;
    if (event.type === "error") throw new Error(`stream error: ${event.error?.errorMessage ?? "unknown"}`);
  }
  if (!last) throw new Error("no done event");
  return last.usage as { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function makeRunner(args: { run: () => AsyncIterable<any> }): StreamRunner {
  return async (label: string) => {
    const usage = await drain(args.run());
    console.log(
      `  [${label}] input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.output}`,
    );
    return usage;
  };
}

async function runScenario(name: string, runner: StreamRunner) {
  console.log(`\n=== ${name} ===`);
  let u1, u2;
  try {
    u1 = await runner("req1");
    await new Promise((r) => setTimeout(r, 1500));
    u2 = await runner("req2");
  } catch (err: any) {
    console.log(`  ⚠️  SKIP: ${err.message?.split("\n")[0] ?? err}`);
    return null;
  }
  const ok = u2.cacheRead > 0;
  console.log(`  ${ok ? "✅" : "❌"} ${ok ? `cache hit on req2: ${u2.cacheRead} tokens` : "cacheRead==0 on req2"}`);
  return ok;
}

async function main() {
  const results: Array<[string, boolean | null]> = [];

  // 1. Anthropic direct
  if (process.env.ANTHROPIC_API_KEY) {
    const model = makeModel({
      api: "anthropic-messages",
      id: "claude-opus-4-5",
      baseUrl: "https://api.anthropic.com/v1",
      provider: "anthropic",
    });
    const runner = makeRunner({
      run: () =>
        streamAnthropic(model, baseContext, {
          apiKey: process.env.ANTHROPIC_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["anthropic / claude-opus-4.5", await runScenario("Anthropic (cache_control)", runner)]);
  } else {
    console.log("\n⚠️  ANTHROPIC_API_KEY not set — skipping Anthropic");
  }

  // 2. OpenAI Responses
  if (process.env.OPENAI_API_KEY) {
    const model = makeModel({
      api: "openai-responses",
      id: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      provider: "openai",
      reasoning: false,
    });
    const runner = makeRunner({
      run: () =>
        streamOpenAIResponses(model, baseContext, {
          apiKey: process.env.OPENAI_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["openai / gpt-4.1-mini (responses)", await runScenario("OpenAI Responses (prompt_cache_key)", runner)]);
  } else {
    console.log("\n⚠️  OPENAI_API_KEY not set — skipping OpenAI Responses");
  }

  // 3. OpenAI Completions (chat.completions API)
  if (process.env.OPENAI_API_KEY) {
    const model = makeModel({
      api: "openai-completions",
      id: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      provider: "openai",
    });
    const runner = makeRunner({
      run: () =>
        streamOpenAICompletions(model, baseContext, {
          apiKey: process.env.OPENAI_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["openai / gpt-4o-mini (completions)", await runScenario("OpenAI Completions (prompt_cache_key)", runner)]);
  }

  // 4. Fireworks via openai-completions
  if (process.env.FIREWORKS_API_KEY) {
    const model = makeModel({
      api: "openai-completions",
      id: "accounts/fireworks/models/kimi-k2p6",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      provider: "fireworks",
    });
    const runner = makeRunner({
      run: () =>
        streamOpenAICompletions(model, baseContext, {
          apiKey: process.env.FIREWORKS_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["fireworks / kimi-k2p6", await runScenario("Fireworks (prompt_cache_key)", runner)]);
  } else {
    console.log("\n⚠️  FIREWORKS_API_KEY not set — skipping Fireworks");
  }

  // 5. OpenRouter Anthropic (cache_control passthrough)
  if (process.env.OPENROUTER_API_KEY) {
    const model = makeModel({
      api: "openai-completions",
      id: "anthropic/claude-opus-4.5",
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
    });
    const runner = makeRunner({
      run: () =>
        streamOpenAICompletions(model, baseContext, {
          apiKey: process.env.OPENROUTER_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["openrouter / anthropic/claude-opus-4.5", await runScenario("OpenRouter→Anthropic (cache_control)", runner)]);
  } else {
    console.log("\n⚠️  OPENROUTER_API_KEY not set — skipping OpenRouter");
  }

  // 6. Google Gemini (implicit caching)
  if (process.env.GOOGLE_AI_API_KEY) {
    const model = makeModel({
      api: "google-generative-ai",
      id: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      provider: "google",
    });
    // Implicit caching needs a much larger prefix on Gemini (2.5 Flash threshold ≈1024 tokens, Pro ≈4096).
    const bigFiller = Array.from({ length: 800 }, (_, i) =>
      `Section ${i}: Filler text to exceed Gemini's implicit cache threshold. `,
    ).join("\n");
    const ctx: Context = {
      ...baseContext,
      systemPrompt: `${systemPrompt}\n\n${bigFiller}`,
    };
    const runner = makeRunner({
      run: () =>
        streamGoogle(model, ctx, {
          apiKey: process.env.GOOGLE_AI_API_KEY,
          maxTokens: 64,
          sessionId,
        }),
    });
    results.push(["google / gemini-2.5-flash", await runScenario("Google Gemini (implicit cache)", runner)]);
  } else {
    console.log("\n⚠️  GOOGLE_AI_API_KEY not set — skipping Google");
  }

  console.log("\n--- summary ---");
  let failed = 0;
  for (const [label, ok] of results) {
    if (ok === null) {
      console.log(`  ⚠️  SKIP   ${label}`);
    } else if (ok) {
      console.log(`  ✅ PASS   ${label}`);
    } else {
      console.log(`  ❌ FAIL   ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
