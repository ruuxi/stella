/**
 * `askQuestion` — inline multiple-choice question tray.
 *
 * Renders a fade-in tray bubble in the chat. Questions are presented one at
 * a time; the user picks an option for each. Use this instead of an
 * open-ended question when the answer space is small.
 *
 * Available to user-facing agents that drive the main chat surface
 * (orchestrator + store). Subagents that don't talk to the user
 * directly (general/research-style runs) are denied so they don't try
 * to render bubbles in chats they don't own.
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

const ASK_QUESTION_ALLOWED_AGENTS = new Set<string>([
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.STORE,
]);

const requireUserFacingAgent = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType && ASK_QUESTION_ALLOWED_AGENTS.has(context.agentType)
    ? null
    : {
        error: `${toolName} is only available to user-facing agents (orchestrator, store).`,
      };

export const askQuestionTool: ToolDefinition = {
  name: "askQuestion",
  description:
    "Ask the user one or more multiple-choice questions inline in the chat. Use when you need a quick decision the user can make by tapping an option. Renders a fade-in questions tray bubble.",
  parameters: {
    type: "object",
    description:
      "Ask the user one or more multiple-choice questions inside the chat. Renders an inline tray bubble. Questions are presented one at a time; the user picks an option for each.",
    properties: {
      questions: {
        type: "array",
        description: "Ordered list of multiple-choice questions to present.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask. End with a question mark.",
            },
            options: {
              type: "array",
              description:
                "Up to 4 short options the user can choose between (1-5 words each).",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Option text shown next to the badge letter.",
                  },
                },
                required: ["label"],
              },
            },
            allowOther: {
              type: "boolean",
              description:
                "When true, append a free-text 'Other...' option so the user can type a custom answer.",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  execute: async (args, context) => {
    const denied = requireUserFacingAgent("askQuestion", context);
    if (denied) return denied;

    const rawQuestions = Array.isArray(args.questions) ? args.questions : null;
    if (!rawQuestions || rawQuestions.length === 0) {
      return {
        error: "questions array is required (at least one question).",
      };
    }

    const summary = rawQuestions
      .map((entry, qIndex) => {
        if (!entry || typeof entry !== "object") {
          return `Question ${qIndex + 1}: (invalid)`;
        }
        const record = entry as {
          question?: unknown;
          options?: unknown;
          allowOther?: unknown;
        };
        const question =
          typeof record.question === "string" ? record.question.trim() : "";
        if (!question) {
          return `Question ${qIndex + 1}: (missing question text)`;
        }
        const options = Array.isArray(record.options) ? record.options : [];
        const renderedOptions = options
          .map((option, oIndex) => {
            const label =
              option &&
              typeof option === "object" &&
              typeof (option as { label?: unknown }).label === "string"
                ? (option as { label: string }).label.trim() || "Option"
                : "Option";
            const letter = String.fromCharCode(65 + oIndex);
            return `  ${letter}. ${label}`;
          })
          .join("\n");
        const otherLine = record.allowOther
          ? `\n  ${String.fromCharCode(65 + options.length)}. Other... (free text)`
          : "";
        return `Question ${qIndex + 1}: ${question}\n${renderedOptions}${otherLine}`;
      })
      .join("\n\n");

    const followUpInstruction =
      context.agentType === AGENT_IDS.STORE
        ? "Question tray rendered in chat. Stop here and wait. The user's answer will be delivered back to this same Store thread as new input; do not publish or continue until then."
        : "Question tray rendered in chat. Wait for the user to answer before continuing.";
    return {
      result: `${followUpInstruction}\n\n${summary}`,
    };
  },
};
