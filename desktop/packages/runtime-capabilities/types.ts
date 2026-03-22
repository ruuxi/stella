import type {
  CapabilityStateEventRecord,
  CapabilityStateScope,
  CapabilityStateValue,
  HostUiActParams,
  RuntimeCommandRunResult,
  RuntimeCommandSummary,
} from "../runtime-protocol/index.js";

export type CapabilityEventName =
  | "runtime_start"
  | "runtime_shutdown"
  | "resources_discover"
  | "conversation_start"
  | "before_run"
  | "before_agent_start"
  | "before_provider_request"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "command_start"
  | "command_end"
  | "before_compact";

export type CapabilityStateApi = {
  get: (args: {
    moduleId: string;
    scope: CapabilityStateScope;
    entityId?: string;
    key: string;
  }) => Promise<CapabilityStateValue | null>;
  set: (args: {
    moduleId: string;
    scope: CapabilityStateScope;
    entityId?: string;
    key: string;
    jsonValue: unknown;
  }) => Promise<CapabilityStateValue>;
  appendEvent: (args: {
    moduleId: string;
    scope: CapabilityStateScope;
    entityId?: string;
    eventType: string;
    jsonValue: unknown;
  }) => Promise<CapabilityStateEventRecord>;
};

export type CapabilityCommandContext = {
  argv: string[];
  stdinText?: string | null;
  frontendRoot: string;
  stellaHomePath: string;
  getProxy: () => { baseUrl: string; authToken: string } | null;
  host: {
    ui: {
      snapshot: () => Promise<string>;
      act: (params: HostUiActParams) => Promise<string>;
    };
  };
  state: CapabilityStateApi;
};

export type CapabilityCommandDefinition = RuntimeCommandSummary & {
  execute: (context: CapabilityCommandContext) => Promise<RuntimeCommandRunResult>;
};

export type CapabilityModuleRegistrationApi = {
  registerCommand: (definition: CapabilityCommandDefinition) => void;
  registerResourceRoots: (definition: {
    skills?: string[];
    prompts?: string[];
    agents?: string[];
    capabilities?: string[];
  }) => void;
  events: {
    on: (
      eventName: CapabilityEventName,
      handler: (payload: unknown) => Promise<void> | void,
    ) => void;
    emit: (eventName: CapabilityEventName, payload: unknown) => Promise<void>;
  };
  state: CapabilityStateApi;
};

export type CapabilityModule = {
  id: string;
  register: (api: CapabilityModuleRegistrationApi) => Promise<void> | void;
};
