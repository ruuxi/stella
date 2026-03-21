import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  CapabilityStateEventRecord,
  CapabilityStateValue,
  RuntimeCommandRunParams,
  RuntimeCommandRunResult,
  RuntimeCommandSummary,
} from "../../stella-runtime-protocol/src/index.js";
import { loadMarkdownCommands } from "./markdown-commands.js";
import { stellaUiCommand } from "./commands/stella-ui.js";
import type {
  CapabilityCommandContext,
  CapabilityCommandDefinition,
  CapabilityEventName,
  CapabilityModuleRegistrationApi,
  CapabilityStateApi,
} from "./types.js";

type CapabilityRuntimeOptions = {
  frontendRoot: string;
  stellaHomePath: string;
  host: CapabilityCommandContext["host"];
  getProxy: CapabilityCommandContext["getProxy"];
  state: CapabilityStateApi;
};

export class CapabilityRuntime {
  private readonly commands = new Map<string, CapabilityCommandDefinition>();
  private readonly resources = {
    skills: new Set<string>(),
    prompts: new Set<string>(),
    agents: new Set<string>(),
    capabilities: new Set<string>(),
  };
  private readonly events = new EventEmitter();
  private loadedSourcePaths: string[] = [];

  constructor(private readonly options: CapabilityRuntimeOptions) {}

  async load() {
    this.commands.clear();
    for (const key of Object.keys(this.resources) as Array<
      keyof typeof this.resources
    >) {
      this.resources[key].clear();
    }

    const api: CapabilityModuleRegistrationApi = {
      registerCommand: (definition) => {
        this.commands.set(definition.id, definition);
      },
      registerResourceRoots: (definition) => {
        for (const entry of definition.skills ?? []) this.resources.skills.add(entry);
        for (const entry of definition.prompts ?? []) this.resources.prompts.add(entry);
        for (const entry of definition.agents ?? []) this.resources.agents.add(entry);
        for (const entry of definition.capabilities ?? []) {
          this.resources.capabilities.add(entry);
        }
      },
      events: {
        on: (eventName, handler) => {
          this.events.on(eventName, handler as (...args: unknown[]) => void);
        },
        emit: async (eventName, payload) => {
          const listeners = this.events.listeners(eventName);
          for (const listener of listeners) {
            await Promise.resolve(listener(payload));
          }
        },
      },
      state: this.options.state,
    };

    api.registerCommand(stellaUiCommand);

    const markdownRoots = [
      path.join(this.options.frontendRoot, "resources", "bundled-commands"),
      path.join(this.options.stellaHomePath, "commands"),
    ];
    const markdownCommands = await loadMarkdownCommands(markdownRoots);
    for (const command of markdownCommands) {
      api.registerCommand(command);
    }

    this.loadedSourcePaths = [
      stellaUiCommand.sourcePath,
      ...markdownCommands.map((entry) => entry.sourcePath),
    ];
  }

  listCommands(): RuntimeCommandSummary[] {
    return [...this.commands.values()]
      .map((entry) => ({
        id: entry.id,
        description: entry.description,
        sourcePath: entry.sourcePath,
        ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
        ...(entry.capabilityRequirements
          ? { capabilityRequirements: entry.capabilityRequirements }
          : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getLoadedSourcePaths() {
    return [...this.loadedSourcePaths];
  }

  async runCommand(params: RuntimeCommandRunParams): Promise<RuntimeCommandRunResult> {
    const command = this.commands.get(params.id);
    if (!command) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown command: ${params.id}`,
      };
    }
    return await command.execute({
      argv: params.argv,
      stdinText: params.stdinText,
      frontendRoot: this.options.frontendRoot,
      stellaHomePath: this.options.stellaHomePath,
      getProxy: this.options.getProxy,
      host: this.options.host,
      state: this.options.state,
    });
  }
}
