/**
 * Local Discovery Service
 * 
 * Runs discovery agents locally with AI inference proxied through backend.
 * Tools are executed locally - no personal data stored in database.
 * Only the final welcome message is saved to the backend.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";

const log = (...args: unknown[]) => console.log("[discovery]", ...args);
const logError = (...args: unknown[]) => console.error("[discovery]", ...args);

type ToolHost = {
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: { conversationId: string; deviceId: string; requestId: string; agentType?: string }
  ) => Promise<{ result?: unknown; error?: string }>;
};

type DiscoveryOptions = {
  convexUrl: string;
  authToken: string;
  conversationId: string;
  deviceId: string;
  platform: "win32" | "darwin";
  trustLevel: "basic" | "full";
  stellarHome: string;
  toolHost: ToolHost;
  onProgress?: (status: string, agentType?: string) => void;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type DiscoveryChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  error?: string;
};

type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
};

const DISCOVERY_AGENTS = ["browser", "dev", "apps"] as const;
type DiscoveryAgentType = (typeof DISCOVERY_AGENTS)[number];

const MAX_STEPS = 30; // Safety limit for agentic loop

/**
 * Call the backend AI proxy for discovery inference
 */
async function callDiscoveryChat(
  convexUrl: string,
  authToken: string,
  agentType: DiscoveryAgentType,
  platform: "win32" | "darwin",
  trustLevel: "basic" | "full",
  messages: Message[]
): Promise<DiscoveryChatResponse> {
  const url = `${convexUrl}/api/discovery/chat`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      agentType,
      platform,
      trustLevel,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discovery chat failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * Call the backend to synthesize raw outputs into core memory
 */
async function callDiscoverySynthesize(
  convexUrl: string,
  authToken: string,
  rawOutputs: string,
  platform: "win32" | "darwin"
): Promise<string> {
  const url = `${convexUrl}/api/discovery/synthesize`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ rawOutputs, platform }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discovery synthesize failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.coreMemory;
}

/**
 * Call the backend to generate and save the welcome message
 */
async function callDiscoveryComplete(
  convexUrl: string,
  authToken: string,
  conversationId: string,
  coreMemory: string
): Promise<string> {
  const url = `${convexUrl}/api/discovery/complete`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ conversationId, coreMemory }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discovery complete failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.welcomeMessage;
}

/**
 * Run a single discovery agent with local tool execution
 */
async function runDiscoveryAgent(
  options: DiscoveryOptions,
  agentType: DiscoveryAgentType
): Promise<string> {
  const { convexUrl, authToken, conversationId, deviceId, platform, trustLevel, toolHost, onProgress } = options;
  
  log(`Starting ${agentType} agent`);
  onProgress?.(`Discovering ${agentType}...`, agentType);

  const messages: Message[] = [
    {
      role: "user",
      content: `Discover this user's ${agentType} context and write a detailed analytical profile.`,
    },
  ];

  let steps = 0;
  let finalText = "";

  while (steps < MAX_STEPS) {
    steps++;
    
    // Call backend AI proxy
    const response = await callDiscoveryChat(
      convexUrl,
      authToken,
      agentType,
      platform,
      trustLevel,
      messages
    );

    if (response.error) {
      throw new Error(response.error);
    }

    // If there are tool calls, execute them locally
    if (response.toolCalls && response.toolCalls.length > 0) {
      // Add assistant message with tool calls indicator
      messages.push({
        role: "assistant",
        content: response.text || `[Calling ${response.toolCalls.length} tool(s)]`,
      });

      // Execute each tool locally and add results
      for (const toolCall of response.toolCalls) {
        log(`Executing tool: ${toolCall.name}`, toolCall.arguments);
        
        const toolResult = await toolHost.executeTool(
          toolCall.name,
          toolCall.arguments,
          {
            conversationId,
            deviceId,
            requestId: toolCall.id,
            agentType: `discovery_${agentType}`,
          }
        );

        const resultContent = toolResult.error
          ? `Error: ${toolResult.error}`
          : typeof toolResult.result === "string"
            ? toolResult.result
            : JSON.stringify(toolResult.result);

        messages.push({
          role: "tool",
          content: resultContent,
          tool_call_id: toolCall.id,
          tool_name: toolCall.name,
        });
      }
    } else {
      // No tool calls - we're done
      finalText = response.text;
      break;
    }

    // Check if AI is done (no more tool calls and has text)
    if (response.finishReason === "stop" || response.finishReason === "end-turn") {
      finalText = response.text;
      break;
    }
  }

  if (steps >= MAX_STEPS) {
    logError(`${agentType} agent hit step limit`);
  }

  log(`${agentType} agent completed in ${steps} steps`);
  return finalText;
}

/**
 * Run full discovery process locally
 */
export async function runLocalDiscovery(options: DiscoveryOptions): Promise<{
  success: boolean;
  coreMemory?: string;
  welcomeMessage?: string;
  error?: string;
}> {
  const { convexUrl, authToken, conversationId, platform, stellarHome, onProgress } = options;

  try {
    log("Starting local discovery");
    onProgress?.("Starting discovery...");

    // Run all discovery agents in parallel
    const results = await Promise.allSettled(
      DISCOVERY_AGENTS.map((agentType) => runDiscoveryAgent(options, agentType))
    );

    // Combine outputs
    const outputs: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const agentType = DISCOVERY_AGENTS[i];
      
      outputs.push(`=== ${agentType.toUpperCase()} DISCOVERY ===`);
      if (result.status === "fulfilled") {
        outputs.push(result.value || "No data collected");
      } else {
        outputs.push(`Error: ${result.reason?.message ?? "Agent failed"}`);
      }
      outputs.push("");
    }

    const rawOutputs = outputs.join("\n");
    log("Raw discovery outputs collected");

    // Synthesize into core memory via backend
    onProgress?.("Synthesizing profile...");
    const coreMemory = await callDiscoverySynthesize(
      convexUrl,
      authToken,
      rawOutputs,
      platform
    );

    // Write CORE_MEMORY.MD locally
    const stateDir = path.join(os.homedir(), ".stellar", "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "CORE_MEMORY.MD"), coreMemory, "utf-8");
    log("CORE_MEMORY.MD written locally");

    // Generate and save welcome message via backend (only DB write)
    onProgress?.("Generating welcome message...");
    const welcomeMessage = await callDiscoveryComplete(
      convexUrl,
      authToken,
      conversationId,
      coreMemory
    );

    log("Discovery complete");
    onProgress?.("Discovery complete");

    return {
      success: true,
      coreMemory,
      welcomeMessage,
    };
  } catch (error) {
    logError("Discovery failed:", error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

export type { DiscoveryOptions };
