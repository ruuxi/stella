/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as agents from "../agents.js";
import type * as attachments from "../attachments.js";
import type * as conversations from "../conversations.js";
import type * as device_tools from "../device_tools.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as model from "../model.js";
import type * as plugins from "../plugins.js";
import type * as prompt_builder from "../prompt_builder.js";
import type * as prompts from "../prompts.js";
import type * as skills from "../skills.js";
import type * as tasks from "../tasks.js";
import type * as tools from "../tools.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  agents: typeof agents;
  attachments: typeof attachments;
  conversations: typeof conversations;
  device_tools: typeof device_tools;
  events: typeof events;
  http: typeof http;
  model: typeof model;
  plugins: typeof plugins;
  prompt_builder: typeof prompt_builder;
  prompts: typeof prompts;
  skills: typeof skills;
  tasks: typeof tasks;
  tools: typeof tools;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
