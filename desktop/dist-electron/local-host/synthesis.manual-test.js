#!/usr/bin/env bun
/**
 * Manual Test Script for Core Memory Synthesis
 *
 * Tests the full flow:
 * 1. Collect user signals
 * 2. Format for LLM
 * 3. Call LLM with synthesis prompt
 * 4. Output synthesized CORE_MEMORY profile
 *
 * Run with: bun electron/local-host/synthesis.manual-test.ts
 *
 * Requires: AI_GATEWAY_API_KEY environment variable
 */
import path from "path";
import os from "os";
import { generateText, createGateway } from "ai";
import { collectAllUserSignals, formatAllSignalsForSynthesis } from "./collect-all.js";
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// API Key - hardcode here for testing, or use env var
const API_KEY = process.env.AI_GATEWAY_API_KEY || "YOUR_KEY_HERE";
// Use Vercel AI Gateway (built into ai package)
const gateway = createGateway({
    apiKey: API_KEY,
});
// Model to use for synthesis (cheap but capable)
const SYNTHESIS_MODEL = "openai/gpt-5.2";
// Temperature for synthesis (lower = more consistent, higher = more creative)
const TEMPERATURE = 1.0;
// Provider routing options (uncomment to use)
const PROVIDER_OPTIONS = {
    gateway: {
        order: ["cerebras"], // Prefer specific providers in order
        // only: ["cerebras"], // Restrict to specific providers only
    },
};
// ---------------------------------------------------------------------------
// Prompts (copied from backend/convex/prompts.ts)
// ---------------------------------------------------------------------------
const CORE_MEMORY_SYNTHESIS_PROMPT = `You are distilling discovery data into a compact CORE MEMORY for an AI assistant. This is NOT a comprehensive profile - it's the essential understanding needed to truly know this person.

## Goal
Capture WHO this person is in 300-400 tokens. An AI reading this should immediately understand:
- What they do and care about most
- How to be genuinely helpful to them
- What makes them tick

## Output Format

\`\`\`
[who]
<2-3 sentences: What do they do? What are they building/working on? What's their expertise level?>

[stack]
<1-2 sentences: Core technologies they actually use daily. Only the important ones.>

[interests]
<2-3 sentences: Beyond work - what do they enjoy? Gaming, content they consume, communities they're part of.>

[personality]
<2-3 sentences: Work style, values, quirks. What patterns emerge from the data?>

[how_to_help]
<2-3 sentences: Based on all the above, what would actually be useful to them? What context should inform responses?>
\`\`\`

## Rules

1. **DISTILL, DON'T LIST**: Find the 3-5 most important things, not every detail.
   - BAD: "Uses npm, pnpm, bun, yarn, node, npx..."
   - GOOD: "JS/TS developer who experiments with different runtimes"

2. **NO REPETITION**: If something appears in one section, it doesn't appear in another.

3. **PATTERNS OVER ITEMS**: Describe what the data reveals about them, not the data itself.
   - BAD: "Visits Convex dashboard, Railway, Vercel, Stripe..."
   - GOOD: "Runs production apps and actively monitors their infrastructure"

4. **ACTIONABLE**: Every sentence should help an AI be more useful to them.

## What to SKIP
- Exhaustive lists of tools/sites/creators
- Anything that could apply to most developers
- Raw statistics or visit counts
- Obvious inferences ("uses GitHub" for a developer)

## Length
300-400 tokens maximum. Quality over quantity.`;
const buildCoreSynthesisUserMessage = (rawOutputs) => {
    return `Distill this discovery data into a compact CORE MEMORY.

Remember: 300-400 tokens max. Find the essence, not the exhaustive list.

${rawOutputs}

Output ONLY the structured profile. No preamble.`;
};
// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------
const estimateTokens = (text) => {
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    const charBased = Math.ceil(chars / 4);
    const wordBased = Math.ceil(words * 1.3);
    const technicalBased = Math.ceil(chars / 3.5);
    return Math.ceil((charBased + wordBased + technicalBased * 2) / 4);
};
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const main = async () => {
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║        Core Memory Synthesis - Manual Test                 ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");
    // Check for API key
    if (!API_KEY || API_KEY === "YOUR_KEY_HERE") {
        console.error("❌ Missing API key. Either:");
        console.error("   1. Set AI_GATEWAY_API_KEY environment variable");
        console.error("   2. Hardcode API_KEY in the script (line 22)");
        process.exit(1);
    }
    console.log("✓ AI Gateway API key configured");
    console.log(`✓ Using model: ${SYNTHESIS_MODEL}\n`);
    // Use a temp directory for testing
    const testHome = path.join(os.tmpdir(), `stella-synthesis-test-${Date.now()}`);
    // ---------------------------------------------------------------------------
    // Step 1: Collect signals
    // ---------------------------------------------------------------------------
    console.log("─".repeat(60));
    console.log("📡 STEP 1: Collecting user signals...\n");
    const collectStart = Date.now();
    const data = await collectAllUserSignals(testHome);
    const collectTime = Date.now() - collectStart;
    console.log(`   ✓ Browser: ${data.browser.browser || "none"} (${data.browser.recentDomains.length} domains)`);
    console.log(`   ✓ Projects: ${data.devProjects.length} active`);
    console.log(`   ✓ Shell: ${data.shell.toolsUsed.length} dev tools, ${data.shell.topCommands.length} commands`);
    console.log(`   ✓ Apps: ${data.apps.length} discovered`);
    console.log(`   ⏱️  Collection took ${collectTime}ms\n`);
    // ---------------------------------------------------------------------------
    // Step 2: Format for LLM
    // ---------------------------------------------------------------------------
    console.log("─".repeat(60));
    console.log("📝 STEP 2: Formatting for LLM synthesis...\n");
    const formatted = formatAllSignalsForSynthesis(data);
    const inputTokens = estimateTokens(formatted);
    console.log(`   ✓ Formatted output: ${formatted.length} chars`);
    console.log(`   ✓ Estimated input tokens: ~${inputTokens}\n`);
    // Show preview
    console.log("   Preview (first 500 chars):");
    console.log("   " + "─".repeat(50));
    console.log(formatted.slice(0, 500).split("\n").map(l => "   " + l).join("\n"));
    console.log("   ...\n");
    // ---------------------------------------------------------------------------
    // Step 3: Call LLM for synthesis
    // ---------------------------------------------------------------------------
    console.log("─".repeat(60));
    console.log("🧠 STEP 3: Calling LLM for synthesis...\n");
    const userMessage = buildCoreSynthesisUserMessage(formatted);
    console.log(`   System prompt: ${estimateTokens(CORE_MEMORY_SYNTHESIS_PROMPT)} tokens`);
    console.log(`   User message: ${estimateTokens(userMessage)} tokens`);
    console.log(`   Model: ${SYNTHESIS_MODEL}`);
    console.log(`   Temperature: ${TEMPERATURE}`);
    console.log("\n   ⏳ Generating...\n");
    const synthesisStart = Date.now();
    try {
        const { text, usage } = await generateText({
            model: gateway(SYNTHESIS_MODEL),
            system: CORE_MEMORY_SYNTHESIS_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            maxOutputTokens: 1000,
            temperature: TEMPERATURE,
            providerOptions: PROVIDER_OPTIONS,
        });
        const synthesisTime = Date.now() - synthesisStart;
        console.log("─".repeat(60));
        console.log("✨ SYNTHESIZED CORE_MEMORY PROFILE");
        console.log("─".repeat(60) + "\n");
        console.log(text);
        console.log("\n" + "─".repeat(60));
        console.log("📊 STATS");
        console.log("─".repeat(60));
        console.log(`   Input tokens:  ${usage?.inputTokens ?? "?"}`);
        console.log(`   Output tokens: ${usage?.outputTokens ?? "?"}`);
        console.log(`   Total tokens:  ${usage?.totalTokens ?? "?"}`);
        console.log(`   Synthesis time: ${synthesisTime}ms`);
        console.log(`   Output length: ${text.length} chars\n`);
    }
    catch (error) {
        console.error("❌ Synthesis failed:", error);
        process.exit(1);
    }
    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------
    try {
        const { promises: fs } = await import("fs");
        await fs.rm(testHome, { recursive: true, force: true });
        console.log("🧹 Cleaned up temp directory");
    }
    catch {
        // Ignore cleanup errors
    }
    console.log("\n✅ Test complete!\n");
};
main().catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
});
