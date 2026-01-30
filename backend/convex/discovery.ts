import { action, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { streamText, stepCountIs } from "ai";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "./tools";
import { getModelConfig } from "./model";
import { executeDeviceTool, type DeviceToolContext } from "./device_tools";
import { requireConversationOwner } from "./auth";
import {
  buildDiscoveryBrowserPrompt,
  buildDiscoveryDevPrompt,
  buildDiscoveryCommsPrompt,
  buildDiscoveryAppsPrompt,
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
} from "./prompts";

// All discovery agents enabled
const DISCOVERY_AGENTS = [
  { id: "discovery_browser", buildPrompt: buildDiscoveryBrowserPrompt, label: "Browser" },
  { id: "discovery_dev", buildPrompt: buildDiscoveryDevPrompt, label: "Development" },
  { id: "discovery_comms", buildPrompt: buildDiscoveryCommsPrompt, label: "Communication" },
  { id: "discovery_apps", buildPrompt: buildDiscoveryAppsPrompt, label: "Apps & Media" },
] as const;

type DiscoveryResult = {
  agentId: string;
  label: string;
  output: string;
  error?: string;
};

// Combine raw discovery outputs for synthesis
const combineRawOutputs = (results: DiscoveryResult[]): string => {
  const sections: string[] = [];

  for (const result of results) {
    sections.push(`=== ${result.label.toUpperCase()} DISCOVERY ===`);
    if (result.error) {
      sections.push(`Error: ${result.error}`);
    } else if (result.output) {
      sections.push(result.output);
    } else {
      sections.push("No data collected");
    }
    sections.push("");
  }

  return sections.join("\n");
};

// Synthesize raw discovery outputs into compact CORE_MEMORY
const synthesizeCoreMemory = async (
  rawOutputs: string,
  platform: string,
): Promise<string> => {
  const modelConfig = getModelConfig("discovery_synthesis");

  const result = await streamText({
    ...modelConfig,
    system: CORE_MEMORY_SYNTHESIS_PROMPT,
    messages: [
      {
        role: "user",
        content: buildCoreSynthesisUserMessage(rawOutputs),
      },
    ],
  });

  const synthesized = await result.text;

  // Add metadata header
  return `# CORE_MEMORY
> Generated: ${new Date().toISOString()}
> Platform: ${platform === "win32" ? "Windows" : "macOS"}

${synthesized}`;
};

const runSingleDiscoveryAgent = async (
  ctx: ActionCtx,
  agentDef: (typeof DISCOVERY_AGENTS)[number],
  platform: "win32" | "darwin",
  trustLevel: "basic" | "full",
  toolContext: DeviceToolContext,
): Promise<DiscoveryResult> => {
  try {
    const systemPrompt = agentDef.buildPrompt({ platform, trustLevel });
    const modelConfig = getModelConfig(agentDef.id);

    const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as Array<{
      pluginId: string;
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;

    const tools = createTools(
      ctx,
      { ...toolContext, agentType: agentDef.id },
      {
        agentType: agentDef.id,
        toolsAllowlist: ["Bash", "Read", "Glob", "Grep", "SqliteQuery"],
        maxTaskDepth: 0,
        pluginTools,
      },
    );

    const result = await streamText({
      ...modelConfig,
      system: systemPrompt,
      tools,
      stopWhen: stepCountIs(50),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Discover this user's ${agentDef.label.toLowerCase()} context and write a detailed analytical profile.`,
            },
          ],
        },
      ],
    });

    const text = await result.text;

    return { agentId: agentDef.id, label: agentDef.label, output: text };
  } catch (error) {
    return {
      agentId: agentDef.id,
      label: agentDef.label,
      output: "",
      error: (error as Error).message,
    };
  }
};

export const runContextDiscovery = action({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    platform: v.string(),
    trustLevel: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    const platform = args.platform === "darwin" ? "darwin" : "win32";
    const trustLevel = args.trustLevel === "full" ? "full" : "basic";

    const toolContext: DeviceToolContext = {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      agentType: "discovery",
      sourceDeviceId: args.targetDeviceId,
    };

    // Emit discovery_started event
    await ctx.runMutation(api.events.appendEvent, {
      conversationId: args.conversationId,
      type: "discovery_started",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: { platform, trustLevel, agents: DISCOVERY_AGENTS.map((a) => a.id) },
    });

    // Run all 4 agents in parallel
    const results = await Promise.allSettled(
      DISCOVERY_AGENTS.map((agentDef) =>
        runSingleDiscoveryAgent(ctx, agentDef, platform, trustLevel, toolContext),
      ),
    );

    const discoveryResults: DiscoveryResult[] = results.map((result, i) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      return {
        agentId: DISCOVERY_AGENTS[i].id,
        label: DISCOVERY_AGENTS[i].label,
        output: "",
        error: result.reason?.message ?? "Agent failed",
      };
    });

    // Combine raw outputs and synthesize into compact CORE_MEMORY
    const rawOutputs = combineRawOutputs(discoveryResults);
    const coreMemory = await synthesizeCoreMemory(rawOutputs, platform);

    // Write CORE_MEMORY.MD via Bash (supports ~ expansion in Git Bash)
    await executeDeviceTool(ctx, toolContext, "Bash", {
      command: `mkdir -p ~/.stellar/state && cat > ~/.stellar/state/CORE_MEMORY.MD << 'CORE_MEMORY_EOF'\n${coreMemory}\nCORE_MEMORY_EOF`,
      description: "Write CORE_MEMORY.MD",
      timeout: 10000,
    });

    // Emit discovery_completed event
    await ctx.runMutation(api.events.appendEvent, {
      conversationId: args.conversationId,
      type: "discovery_completed",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        agents: discoveryResults.map((r) => ({
          id: r.agentId,
          label: r.label,
          hasOutput: r.output.length > 0,
          error: r.error,
        })),
      },
    });

    // Invoke the general agent to send a personalized welcome message
    try {
      const generalPromptBuild = await buildSystemPrompt(ctx, "general");
      const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as Array<{
        pluginId: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;

      const conversation = await requireConversationOwner(ctx, args.conversationId);

      const generalTools = createTools(
        ctx,
        { ...toolContext, agentType: "general" },
        {
          agentType: "general",
          toolsAllowlist: generalPromptBuild.toolsAllowlist,
          maxTaskDepth: generalPromptBuild.maxTaskDepth,
          pluginTools,
          ownerId: conversation.ownerId,
        },
      );

      const welcomeResult = await streamText({
        ...getModelConfig("general"),
        system: generalPromptBuild.systemPrompt,
        tools: generalTools,
        stopWhen: stepCountIs(5),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Read ~/.stellar/state/CORE_MEMORY.MD and compose a personalized welcome message for the user. Reference specific things you learned about them. Be warm but concise. This is the first message they'll see after onboarding.`,
              },
            ],
          },
        ],
      });

      const welcomeText = await welcomeResult.text;

      if (welcomeText.trim()) {
        await ctx.runMutation(internal.events.saveAssistantMessage, {
          conversationId: args.conversationId,
          text: welcomeText,
          userMessageId: args.userMessageId,
        });
      }
    } catch (error) {
      console.error("Failed to generate welcome message:", error);
    }

    return null;
  },
});
