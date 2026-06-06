import { anyApi } from "convex/server";

import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

const LINQ_DEFERRED = {
  requiredConnectorProvider: "linq",
  searchTerms: [
    "linq",
    "imessage",
    "iphone",
    "sms",
    "rcs",
    "reaction",
    "tapback",
    "rich media",
    "rich link",
    "voice memo",
    "contact card",
    "message effect",
  ],
} as const;

type ConvexAction = (
  ref: unknown,
  args: Record<string, unknown>,
) => Promise<unknown>;

const requireLinqContext = (
  context: ToolContext,
):
  | { ok: true; requestId: string; conversationId: string }
  | { ok: false; result: ToolResult } => {
  const target = context.connectorDeliveryTarget;
  if (
    !target?.requestId ||
    !target.conversationId ||
    target.provider !== "linq"
  ) {
    return {
      ok: false,
      result: {
        error:
          "This tool is only available while replying to a current Linq/iMessage connector conversation.",
      },
    };
  }
  return {
    ok: true,
    requestId: target.requestId,
    conversationId: target.conversationId,
  };
};

const executeLinqOperation = async (
  actionConvex: ConvexAction | undefined,
  context: ToolContext,
  operation: string,
  payload: Record<string, unknown>,
): Promise<ToolResult> => {
  if (!actionConvex) {
    return { error: "Convex action bridge is not available." };
  }
  const target = requireLinqContext(context);
  if (!target.ok) return target.result;
  const result = await actionConvex(
    anyApi.channels.linq.executeLinqConnectorTool,
    {
      requestId: target.requestId,
      conversationId: target.conversationId,
      operation,
      payload,
    },
  );
  return {
    result,
    details: result,
  };
};

const linqTool = (
  actionConvex: ConvexAction | undefined,
  tool: Omit<ToolDefinition, "agentTypes" | "deferred" | "execute"> & {
    operation: string;
  },
): ToolDefinition => ({
  name: tool.name,
  ...(tool.label ? { label: tool.label } : {}),
  ...(tool.workingText ? { workingText: tool.workingText } : {}),
  description: tool.description,
  parameters: tool.parameters,
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  deferred: LINQ_DEFERRED,
  execute: async (args, context) =>
    executeLinqOperation(actionConvex, context, tool.operation, args),
});

export const createLinqImessageTools = (opts: {
  actionConvex?: ConvexAction;
}): ToolDefinition[] => [
  linqTool(opts.actionConvex, {
    name: "linq_send_message",
    label: "Send iMessage",
    workingText: "Sending iMessage",
    operation: "send_message",
    description:
      "Send a Linq/iMessage message with text, media URLs, rich link previews, reply threading, preferred service, and optional iMessage effects.",
    parameters: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          description:
            "Message parts. Use text parts for copy, media parts for HTTPS media or attachment IDs, and a single link part for a rich preview.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text", "media", "link"] },
              value: {
                type: "string",
                description: "Text value or rich-link URL.",
              },
              url: {
                type: "string",
                description: "Public HTTPS media URL for media parts.",
              },
              attachment_id: {
                type: "string",
                description: "Pre-uploaded Linq attachment ID for media parts.",
              },
              text_decorations: {
                type: "array",
                description:
                  "Optional iMessage text decorations for text parts.",
                items: {
                  type: "object",
                  properties: {
                    range: {
                      type: "array",
                      minItems: 2,
                      maxItems: 2,
                      items: { type: "number" },
                    },
                    style: {
                      type: "string",
                      enum: [
                        "bold",
                        "italic",
                        "strikethrough",
                        "underline",
                      ],
                    },
                    animation: {
                      type: "string",
                      enum: [
                        "big",
                        "small",
                        "shake",
                        "nod",
                        "explode",
                        "ripple",
                        "bloom",
                        "jitter",
                      ],
                    },
                  },
                  required: ["range"],
                  additionalProperties: false,
                },
              },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        effect: {
          type: "object",
          description: "Optional iMessage screen or bubble effect.",
          properties: {
            type: { type: "string", enum: ["screen", "bubble"] },
            name: {
              type: "string",
              enum: [
                "confetti",
                "fireworks",
                "lasers",
                "sparkles",
                "celebration",
                "hearts",
                "love",
                "balloons",
                "happy_birthday",
                "echo",
                "spotlight",
                "slam",
                "loud",
                "gentle",
                "invisible",
              ],
            },
          },
          required: ["type", "name"],
          additionalProperties: false,
        },
        preferred_service: {
          type: "string",
          enum: ["iMessage", "RCS", "SMS"],
          description:
            "Optional protocol preference. Omit unless the user specifically needs a protocol.",
        },
        reply_to: {
          type: "string",
          description: "Optional Linq message ID to reply to in-thread.",
        },
        idempotency_key: {
          type: "string",
          description: "Optional duplicate-send guard for retries.",
        },
      },
      required: ["parts"],
      additionalProperties: false,
    },
  }),
  linqTool(opts.actionConvex, {
    name: "linq_share_contact_card",
    label: "Share contact card",
    workingText: "Sharing contact card",
    operation: "share_contact_card",
    description:
      "Share Stella's configured Linq contact card into the current iMessage chat.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  }),
  linqTool(opts.actionConvex, {
    name: "linq_send_voice_memo",
    label: "Send voice memo",
    workingText: "Sending voice memo",
    operation: "voice_memo",
    description:
      "Send audio to the current Linq chat using the iMessage voice memo affordance when available.",
    parameters: {
      type: "object",
      properties: {
        voice_memo_url: {
          type: "string",
          description: "Public HTTPS URL for the audio file.",
        },
        attachment_id: {
          type: "string",
          description: "Pre-uploaded Linq attachment ID for the audio file.",
        },
      },
      additionalProperties: false,
    },
  }),
  linqTool(opts.actionConvex, {
    name: "linq_react_to_message",
    label: "React in iMessage",
    workingText: "Sending iMessage reaction",
    operation: "reaction",
    description:
      "Add or remove an iMessage tapback/custom emoji reaction on a Linq message by message ID.",
    parameters: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description:
            "Optional Linq message UUID to react to. Omit this when reacting to the current inbound Linq/iMessage text.",
        },
        operation: { type: "string", enum: ["add", "remove"] },
        type: {
          type: "string",
          enum: [
            "love",
            "like",
            "dislike",
            "laugh",
            "emphasize",
            "question",
            "custom",
          ],
        },
        custom_emoji: {
          type: "string",
          description: "Unicode emoji when type is custom.",
        },
        part_index: {
          type: "number",
          description:
            "Optional zero-based part index for multipart messages. Omit for the first part.",
        },
      },
      required: ["operation", "type"],
      additionalProperties: false,
    },
  }),
];
