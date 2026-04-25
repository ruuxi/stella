/**
 * Store subagent surface — list local commits + publish a commit-based release.
 *
 * Two sibling tools that mutate or read the local self-mod store directly.
 * Used exclusively by the Store subagent (the orchestrator delegates plain-
 * language publish requests to it via the `Store` tool).
 */

import { AGENT_IDS } from "../../../../desktop/src/shared/contracts/agent-runtime.js";
import {
  handleStoreGetPackage,
  handleStoreListLocalCommits,
  handleStoreListPackageReleases,
  handleStoreListPackages,
  handleStorePublishCommits,
} from "../store.js";
import type {
  StoreToolApi,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../types.js";

export type StoreControlOptions = {
  storeApi?: StoreToolApi;
};

const requireStoreAgent = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.STORE
    ? null
    : { error: `${toolName} is only available to the Store agent.` };

export const createStoreControlTools = (
  options: StoreControlOptions,
): ToolDefinition[] => [
  {
    name: "StoreListLocalCommits",
    description:
      "List recent self-mod commits from the local git history (oldest of the slice last). Returns commit hash, subject, body, files changed, and conversation id when known.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of commits to return (defaults to 50, max 500).",
        },
      },
    },
    execute: async (args, context) => {
      const denied = requireStoreAgent("StoreListLocalCommits", context);
      if (denied) return denied;
      try {
        return await handleStoreListLocalCommits(options.storeApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "StoreListPackages",
    description:
      "List existing Store packages owned by the user. Use this when deciding whether a publish request is a new mod or an update.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (args, context) => {
      const denied = requireStoreAgent("StoreListPackages", context);
      if (denied) return denied;
      try {
        return await handleStoreListPackages(options.storeApi);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "StoreGetPackage",
    description:
      "Load one existing Store package by package id. Returns null if it does not exist.",
    parameters: {
      type: "object",
      properties: {
        packageId: {
          type: "string",
          description: "Stable package id to inspect.",
        },
      },
      required: ["packageId"],
    },
    execute: async (args, context) => {
      const denied = requireStoreAgent("StoreGetPackage", context);
      if (denied) return denied;
      try {
        return await handleStoreGetPackage(options.storeApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "StoreListPackageReleases",
    description:
      "List the release history for an existing Store package, newest first. Use this before publishing updates.",
    parameters: {
      type: "object",
      properties: {
        packageId: {
          type: "string",
          description: "Stable package id whose release history should be inspected.",
        },
      },
      required: ["packageId"],
    },
    execute: async (args, context) => {
      const denied = requireStoreAgent("StoreListPackageReleases", context);
      if (denied) return denied;
      try {
        return await handleStoreListPackageReleases(options.storeApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "StorePublishCommits",
    description:
      "Publish a Store release built from a hand-picked set of local commit hashes. Always confirm the package id, display name, description, and selected commits with the user before calling.",
    parameters: {
      type: "object",
      properties: {
        packageId: {
          type: "string",
          description:
            "Stable identifier for this Store mod (e.g. 'notes-page'). The first publish creates the package; subsequent publishes for the same id are treated as new releases.",
        },
        commitHashes: {
          type: "array",
          description:
            "Self-mod commit hashes that compose this release. Order doesn't matter — they're sorted chronologically before being applied.",
          items: { type: "string" },
        },
        displayName: {
          type: "string",
          description: "User-facing display name for the mod.",
        },
        description: {
          type: "string",
          description:
            "Short, user-facing description of what the mod does. Plain language, no internal terminology.",
        },
        releaseNotes: {
          type: "string",
          description:
            "Optional release notes summarizing what changed in this release.",
        },
      },
      required: ["packageId", "commitHashes", "displayName", "description"],
    },
    execute: async (args, context) => {
      const denied = requireStoreAgent("StorePublishCommits", context);
      if (denied) return denied;
      try {
        return await handleStorePublishCommits(options.storeApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
];
