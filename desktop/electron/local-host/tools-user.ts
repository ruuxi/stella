/**
 * User interaction tools: AskUser, RequestCredential handlers.
 */

import type { ToolResult } from "./tools-types.js";
import { truncate } from "./tools-utils.js";

export type UserToolsConfig = {
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
};

export const handleAskUser = async (args: Record<string, unknown>): Promise<ToolResult> => {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (questions.length === 0) {
    return { error: "questions array is required." };
  }
  const summary = questions
    .map((question, index) => {
      if (!question || typeof question !== "object") {
        return `Question ${index + 1}: (invalid)`;
      }
      const record = question as {
        question?: string;
        options?: Array<{ label?: string; description?: string }>;
      };
      const options = (record.options ?? [])
        .map((option, optionIndex) => {
          return `  ${optionIndex + 1}. ${option.label ?? "Option"} - ${
            option.description ?? ""
          }`;
        })
        .join("\n");
      return `Question ${index + 1}: ${record.question ?? ""}\n${options}`;
    })
    .join("\n\n");
  return {
    result:
      "User input is required. Ask the user directly in chat.\n\n" + truncate(summary, 8000),
  };
};

export const handleRequestCredential = async (
  config: UserToolsConfig,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  if (!config.requestCredential) {
    return { error: "Credential requests are not supported on this device." };
  }
  const provider = String(args.provider ?? "").trim();
  if (!provider) {
    return { error: "provider is required." };
  }
  const label = args.label ? String(args.label) : undefined;
  const description = args.description ? String(args.description) : undefined;
  const placeholder = args.placeholder ? String(args.placeholder) : undefined;

  try {
    const response = await config.requestCredential({
      provider,
      label,
      description,
      placeholder,
    });
    return { result: response };
  } catch (error) {
    return { error: (error as Error).message || "Credential request failed." };
  }
};
