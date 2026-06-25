import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import {
  applyUserProfileOperation,
  type UserProfileAction,
} from "../../memory/user-profile-store.js";
import type { ToolDefinition } from "../types.js";

export type RememberToolOptions = {
  stellaDataDir: string;
};

const VALID_ACTIONS: readonly UserProfileAction[] = ["add", "replace", "remove"];

export const createRememberTool = (
  options: RememberToolOptions,
): ToolDefinition => ({
  name: "Remember",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description:
    "Persist a durable fact about the user into their always-resident profile " +
    "(name, location, stable preferences, ongoing situation). These facts are " +
    "injected into your context at the start of every session, so use this for " +
    'things the user would expect you to still know later — not transient task ' +
    "state. action=add stores a new fact; action=replace swaps an outdated fact " +
    "(provide old_content); action=remove forgets one. Keep each fact short and " +
    "high-signal; the profile has a size cap.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "replace", "remove"],
        description:
          "add = store a new durable fact. replace = update an existing fact (needs old_content). remove = forget a fact.",
      },
      content: {
        type: "string",
        description:
          'The durable fact, in a short self-contained sentence. e.g. "The user goes by Bob" or "The user lives in Berlin". Required for add/replace; for remove, the fact to forget.',
      },
      old_content: {
        type: "string",
        description:
          "replace only: the existing fact to overwrite (matched loosely against stored entries).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  execute: async (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    if (!VALID_ACTIONS.includes(action as UserProfileAction)) {
      return { error: "action must be 'add', 'replace', or 'remove'." };
    }
    const content =
      typeof args.content === "string" ? args.content.trim() : undefined;
    const oldContent =
      typeof args.old_content === "string"
        ? args.old_content.trim()
        : undefined;
    try {
      const result = await applyUserProfileOperation(options.stellaDataDir, {
        action: action as UserProfileAction,
        ...(content ? { content } : {}),
        ...(oldContent ? { oldContent } : {}),
      });
      return {
        result: JSON.stringify({
          success: result.ok,
          message: result.message,
          entryCount: result.entryCount,
        }),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
