/**
 * `RequestCredential` tool — secure credential elicitation.
 *
 * Returns a `secretId` handle that other tools/integrations can pass through
 * without the secret value ever entering model context.
 */

import { handleRequestCredential, type UserToolsConfig } from "../user.js";
import type { ToolDefinition } from "../types.js";

export type RequestCredentialOptions = {
  requestCredential?: UserToolsConfig["requestCredential"];
};

export const createRequestCredentialTool = (
  options: RequestCredentialOptions,
): ToolDefinition => ({
  name: "RequestCredential",
  description:
    "Request an API key or secret via a secure UI prompt. Returns a `secretId` handle that can be passed to other tools/integrations.",
  promptSnippet: "Securely request a credential from the user",
  parameters: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: 'Unique key for this secret (e.g. "github_token").',
      },
      label: {
        type: "string",
        description: 'Display name shown to the user (e.g. "GitHub Token").',
      },
      description: {
        type: "string",
        description: "Why this credential is needed.",
      },
      placeholder: {
        type: "string",
        description: "Input placeholder text.",
      },
    },
    required: ["provider"],
  },
  execute: (args) =>
    handleRequestCredential(
      { requestCredential: options.requestCredential },
      args,
    ),
});
