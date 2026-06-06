import { describe, expect, it } from "vitest";

import { createPiTools } from "../../../../../runtime/kernel/agent-runtime/tool-adapters.js";
import type { ToolMetadata } from "../../../../../runtime/kernel/tools/types.js";
import { buildLocalHistoryFromEvents } from "../../../../../runtime/kernel/local-history.js";

const firstText = (content: { type: string; text?: string }[]) =>
  content[0]?.text ?? "";

const toolCatalog: ToolMetadata[] = [
  {
    name: "tool_search",
    label: "Search tools",
    workingText: "Searching tools",
    description: "Search deferred tools",
    parameters: { type: "object" },
  },
  {
    name: "linq_react_to_message",
    label: "React in iMessage",
    workingText: "Sending iMessage reaction",
    description: "Add or remove an iMessage tapback reaction on a Linq message.",
    parameters: { type: "object" },
    deferred: {
      requiredConnectorProvider: "linq",
      searchTerms: ["linq", "imessage", "reaction", "tapback"],
    },
  },
];

const makeTools = (provider?: string) =>
  createPiTools({
    runId: "run-1",
    conversationId: "conv-1",
    agentType: "orchestrator",
    deviceId: "device-1",
    ...(provider
      ? {
          connectorDeliveryTarget: {
            requestId: "remote-1",
            conversationId: "backend-conv-1",
            provider,
          },
        }
      : {}),
    toolsAllowlist: ["tool_search"],
    toolCatalog,
    store: {} as never,
    toolExecutor: async () => ({ error: "should not execute host tools" }),
  });

describe("deferred tool search", () => {
  it("exposes matching Linq tools during a Linq connector turn", async () => {
    const tools = makeTools("linq");

    expect(tools.map((tool) => tool.name)).toEqual(["tool_search"]);
    expect(tools[0]?.label).toBe("Search tools");
    expect(tools[0]?.workingText).toBe("Searching tools");
    const updates: Array<{ details?: unknown }> = [];
    const result = await tools[0]!.execute("call-1", {
      query: "iMessage reactions and rich media",
    }, undefined, (update) => updates.push(update));

    expect(result.content[0]).toMatchObject({
      type: "text",
    });
    expect(firstText(result.content)).toContain("linq_react_to_message");
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(["tool_search", "linq_react_to_message"]),
    );
    expect(
      updates.some(
        (update) =>
          (update.details as { statusText?: string } | undefined)
            ?.statusText === "Found 1 matching tool",
      ),
    ).toBe(true);
    const reactionTool = tools.find(
      (tool) => tool.name === "linq_react_to_message",
    );
    expect(reactionTool?.label).toBe("React in iMessage");
    expect(reactionTool?.workingText).toBe("Sending iMessage reaction");
  });

  it("does not expose Linq tools outside a Linq connector turn", async () => {
    const tools = makeTools();

    const result = await tools[0]!.execute("call-1", {
      query: "iMessage reactions",
    });

    expect(firstText(result.content)).toContain("No deferred tools");
    expect(tools.map((tool) => tool.name)).toEqual(["tool_search"]);
  });
});

describe("Linq local history metadata", () => {
  it("renders Linq message IDs without transcript database storage", () => {
    const messages = buildLocalHistoryFromEvents({
      events: [
        {
          _id: "event-1",
          timestamp: Date.UTC(2026, 0, 1, 12),
          type: "user_message",
          payload: {
            text: "Loved this",
            source: "connector",
            provider: "linq",
            linqMessageId: "msg_123",
          },
        },
      ],
    });

    expect(messages[0]?.content).toContain("Loved this");
    expect(messages[0]?.content).toContain("[linq_message_id: msg_123]");
  });
});
