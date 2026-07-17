// STELLA-GUARD: model-provider-config
// This file resolves model-provider credentials and headers from user-owned
// configuration. Do not log resolved values or weaken secret handling.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Api, Model } from "./types.js";

export type ModelsJsonModel = Partial<
  Omit<Model<Api>, "id" | "name" | "provider" | "baseUrl" | "api">
> & {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
};

export type ModelsJsonModelOverride = Partial<
  Pick<
    Model<Api>,
    | "name"
    | "reasoning"
    | "thinkingLevelMap"
    | "input"
    | "cost"
    | "contextWindow"
    | "maxTokens"
    | "headers"
    | "compat"
  >
>;

export type ModelsJsonProvider = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
  authHeader?: boolean;
  models?: ModelsJsonModel[];
  modelOverrides?: Record<string, ModelsJsonModelOverride>;
};

export type RemoteCatalogModel = Omit<Model<Api>, "provider"> & {
  provider?: string;
};

type ModelsJson = {
  providers: Record<string, ModelsJsonProvider>;
};

const nonEmptyString = Type.String({ minLength: 1 });
const stringRecord = Type.Record(Type.String(), Type.String());
const thinkingLevelMapSchema = Type.Object({
  off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const percentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});
const chatTemplateKwargSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Object({
    $var: Type.Union([
      Type.Literal("thinking.enabled"),
      Type.Literal("thinking.effort"),
    ]),
    omitWhenOff: Type.Optional(Type.Boolean()),
  }),
]);
const stringOrNumber = Type.Union([Type.String(), Type.Number()]);
const compatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(
    Type.Union([
      Type.Literal("max_completion_tokens"),
      Type.Literal("max_tokens"),
    ]),
  ),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
  replayReasoningContentField: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("deepseek"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("chat-template"),
      Type.Literal("qwen-chat-template"),
    ]),
  ),
  chatTemplateKwargs: Type.Optional(
    Type.Record(Type.String(), chatTemplateKwargSchema),
  ),
  openRouterRouting: Type.Optional(
    Type.Object({
      allow_fallbacks: Type.Optional(Type.Boolean()),
      require_parameters: Type.Optional(Type.Boolean()),
      data_collection: Type.Optional(
        Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
      ),
      zdr: Type.Optional(Type.Boolean()),
      enforce_distillable_text: Type.Optional(Type.Boolean()),
      order: Type.Optional(Type.Array(Type.String())),
      only: Type.Optional(Type.Array(Type.String())),
      ignore: Type.Optional(Type.Array(Type.String())),
      quantizations: Type.Optional(Type.Array(Type.String())),
      sort: Type.Optional(
        Type.Union([
          Type.String(),
          Type.Object({
            by: Type.Optional(Type.String()),
            partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
        ]),
      ),
      max_price: Type.Optional(
        Type.Object({
          prompt: Type.Optional(stringOrNumber),
          completion: Type.Optional(stringOrNumber),
          image: Type.Optional(stringOrNumber),
          audio: Type.Optional(stringOrNumber),
          request: Type.Optional(stringOrNumber),
        }),
      ),
      preferred_min_throughput: Type.Optional(
        Type.Union([Type.Number(), percentileCutoffsSchema]),
      ),
      preferred_max_latency: Type.Optional(
        Type.Union([Type.Number(), percentileCutoffsSchema]),
      ),
    }),
  ),
  vercelGatewayRouting: Type.Optional(
    Type.Object({
      only: Type.Optional(Type.Array(Type.String())),
      order: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  zaiToolStream: Type.Optional(Type.Boolean()),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
  sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
  sendSessionIdHeader: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
  supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
});
const costSchema = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
});
const remoteCatalogCostSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
});
const modelFields = {
  name: Type.Optional(nonEmptyString),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(thinkingLevelMapSchema),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  ),
  cost: Type.Optional(costSchema),
  contextWindow: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  headers: Type.Optional(stringRecord),
  compat: Type.Optional(compatSchema),
};
const modelDefinitionSchema = Type.Object({
  id: nonEmptyString,
  api: Type.Optional(nonEmptyString),
  baseUrl: Type.Optional(nonEmptyString),
  ...modelFields,
});
const modelOverrideSchema = Type.Object(modelFields);
const providerSchema = Type.Object({
  name: Type.Optional(nonEmptyString),
  baseUrl: Type.Optional(nonEmptyString),
  apiKey: Type.Optional(nonEmptyString),
  api: Type.Optional(nonEmptyString),
  headers: Type.Optional(stringRecord),
  compat: Type.Optional(compatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(modelDefinitionSchema)),
  modelOverrides: Type.Optional(
    Type.Record(Type.String(), modelOverrideSchema),
  ),
});
const modelsJsonSchema = Type.Object({
  providers: Type.Record(Type.String(), providerSchema),
});
const remoteCatalogModelSchema = Type.Object({
  id: nonEmptyString,
  name: nonEmptyString,
  api: nonEmptyString,
  provider: Type.Optional(nonEmptyString),
  baseUrl: nonEmptyString,
  reasoning: Type.Boolean(),
  thinkingLevelMap: Type.Optional(thinkingLevelMapSchema),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  cost: remoteCatalogCostSchema,
  contextWindow: Type.Number({ exclusiveMinimum: 0 }),
  maxTokens: Type.Number({ exclusiveMinimum: 0 }),
  headers: Type.Optional(stringRecord),
  compat: Type.Optional(compatSchema),
});

export const isRemoteCatalogModel = (
  value: unknown,
): value is RemoteCatalogModel => Value.Check(remoteCatalogModelSchema, value);

export const getRemoteCatalogModelValidationErrors = (
  value: unknown,
): string[] =>
  [...Value.Errors(remoteCatalogModelSchema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || "root"}: ${error.message}`);

/** Strip JSONC line comments and trailing commas without touching strings. */
const stripJsonComments = (value: string): string =>
  value
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) =>
      match[0] === '"' ? match : "",
    )
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu,
      (match, tail: string | undefined) =>
        tail ?? (match[0] === '"' ? match : ""),
    );

export class ModelConfig {
  private constructor(
    private readonly providers: ReadonlyMap<string, ModelsJsonProvider>,
    private readonly error?: string,
  ) {}

  static empty(): ModelConfig {
    return new ModelConfig(new Map());
  }

  static async load(filePath: string | undefined): Promise<ModelConfig> {
    if (!filePath) return new ModelConfig(new Map());
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ModelConfig(new Map());
      }
      return new ModelConfig(
        new Map(),
        `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${filePath}`,
      );
    }

    try {
      const parsed = JSON.parse(stripJsonComments(content)) as unknown;
      if (!Value.Check(modelsJsonSchema, parsed)) {
        const details = [...Value.Errors(modelsJsonSchema, parsed)]
          .slice(0, 8)
          .map((error) => `  - ${error.path || "root"}: ${error.message}`)
          .join("\n");
        throw new Error(`Invalid models.json schema:\n${details}`);
      }
      const providers = new Map<string, ModelsJsonProvider>();
      for (const [providerId, provider] of Object.entries(
        (parsed as ModelsJson).providers,
      )) {
        if (!providerId.trim()) {
          throw new Error(`Invalid provider configuration: ${providerId}`);
        }
        providers.set(providerId, structuredClone(provider));
      }
      return new ModelConfig(providers);
    } catch (error) {
      return new ModelConfig(
        new Map(),
        `Failed to parse models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${filePath}`,
      );
    }
  }

  getProvider(providerId: string): ModelsJsonProvider | undefined {
    return this.providers.get(providerId);
  }

  getProviderIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  getError(): string | undefined {
    return this.error;
  }
}

const ENV_REFERENCE =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;

export const getModelConfigCommandInvocation = (
  command: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): { executable: string; args: string[] } => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const comspec = Object.entries(env).find(
      ([name, value]) => name.toLowerCase() === "comspec" && Boolean(value),
    )?.[1];
    return {
      executable: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    executable: env.SHELL || "/bin/sh",
    args: ["-lc", command],
  };
};

export const resolveModelConfigValue = (
  config: string | undefined,
): string | undefined => {
  if (!config) return undefined;
  if (config.startsWith("!")) {
    try {
      const invocation = getModelConfigCommandInvocation(config.slice(1));
      const value = execFileSync(
        invocation.executable,
        invocation.args,
        {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  let missing = false;
  const escapedDollar = "\u0000stella-dollar\u0000";
  const escapedBang = "\u0000stella-bang\u0000";
  const resolved = config
    .replace(/\$\$/gu, escapedDollar)
    .replace(/\$!/gu, escapedBang)
    .replace(ENV_REFERENCE, (_match, braced: string, bare: string) => {
      const value = process.env[braced || bare];
      if (value === undefined) missing = true;
      return value ?? "";
    })
    .replaceAll(escapedDollar, "$")
    .replaceAll(escapedBang, "!");
  return missing ? undefined : resolved;
};

export const isModelConfigValueConfigured = (
  config: string | undefined,
): boolean => {
  if (!config) return false;
  if (config.startsWith("!")) return config.slice(1).trim().length > 0;
  let missing = false;
  config
    .replace(/\$\$/gu, "")
    .replace(/\$!/gu, "")
    .replace(ENV_REFERENCE, (_match, braced: string, bare: string) => {
      if (process.env[braced || bare] === undefined) missing = true;
      return "";
    });
  return !missing;
};

export const resolveModelConfigHeaders = (
  headers: Record<string, string> | undefined,
  context: string,
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, config] of Object.entries(headers)) {
    const value = resolveModelConfigValue(config);
    if (value === undefined) {
      throw new Error(
        `Required models.json header "${name}" for ${context} could not be resolved.`,
      );
    }
    resolved[name] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};
