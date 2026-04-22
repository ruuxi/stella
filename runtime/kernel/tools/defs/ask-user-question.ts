/**
 * `AskUserQuestion` — modal multi-question UI prompt.
 *
 * Heavier-weight than `askQuestion` (full question/header/option-description
 * shape, multi-select support). Used by clarification flows that need
 * tagged headers and option descriptions, not just labels.
 */

import { handleAskUser } from "../user.js";
import type { ToolDefinition } from "../types.js";

export const askUserQuestionTool: ToolDefinition = {
  name: "AskUserQuestion",
  description:
    "Ask the user to choose between options via a UI prompt. Use for clarifications, decisions, or preferences.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask (end with ?).",
            },
            header: {
              type: "string",
              description: "Short label displayed as a tag (max 12 chars).",
            },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Option text (1-5 words).",
                  },
                  description: {
                    type: "string",
                    description:
                      "What this option means or what happens if chosen.",
                  },
                },
                required: ["label", "description"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "Allow selecting multiple options.",
            },
          },
          required: ["question", "header", "options", "multiSelect"],
        },
      },
    },
    required: ["questions"],
  },
  execute: (args) => handleAskUser(args),
};
