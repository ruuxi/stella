import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import type {
  SourceImportToolApi,
  SourceImportToolScope,
  SourceImportToolSource,
  SourceImportToolTrust,
  ToolDefinition,
} from "../types.js";

export type SourceImportToolOptions = {
  sourceImportApi?: SourceImportToolApi;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseTrust = (value: unknown): SourceImportToolTrust =>
  value === "trusted" ? "trusted" : "untrusted";

const parseScope = (value: unknown): SourceImportToolScope => {
  if (!isRecord(value)) return { kind: "all" };
  if (value.kind === "feature") {
    const label = typeof value.label === "string" ? value.label.trim() : "";
    return label ? { kind: "feature", label } : { kind: "all" };
  }
  return { kind: "all" };
};

const parseSource = (value: unknown): SourceImportToolSource | null => {
  if (!isRecord(value)) return null;
  if (value.kind === "local-path") {
    const sourcePath = typeof value.path === "string" ? value.path.trim() : "";
    if (!sourcePath) return null;
    const ref = typeof value.ref === "string" ? value.ref.trim() : "";
    return {
      kind: "local-path",
      path: sourcePath,
      ...(ref ? { ref } : {}),
    };
  }
  if (value.kind === "git") {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (!url) return null;
    const ref = typeof value.ref === "string" ? value.ref.trim() : "";
    return {
      kind: "git",
      url,
      ...(ref ? { ref } : {}),
    };
  }
  return null;
};

export const createSourceImportTool = (
  options: SourceImportToolOptions,
): ToolDefinition => ({
  name: "import_source",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description:
    "Import source from a local path or git URL into this Stella tree. Resolves the source, reviews untrusted material, tries a clean git fast path when possible, and otherwise delegates adaptation to the General agent.",
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "object",
        description:
          "The source to import. Use kind=local-path for a local repo/package/path, or kind=git for a git URL. Git refs may be passed as ref or in the URL suffix after #.",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["local-path"] },
              path: {
                type: "string",
                description:
                  "Absolute path, or a path relative to the current Stella repo.",
              },
              ref: {
                type: "string",
                description:
                  "Optional git ref when the path is a git repository.",
              },
            },
            required: ["kind", "path"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["git"] },
              url: {
                type: "string",
                description:
                  "Git URL, optionally with #ref suffix, such as https://github.com/org/repo.git#main.",
              },
              ref: {
                type: "string",
                description:
                  "Optional branch, tag, or commit. Overrides a #ref suffix.",
              },
            },
            required: ["kind", "url"],
            additionalProperties: false,
          },
        ],
      },
      scope: {
        type: "object",
        description:
          "Import the whole source, or ask the agent to extract a named feature/subset.",
        properties: {
          kind: { type: "string", enum: ["all", "feature"] },
          label: {
            type: "string",
            description:
              "Required when kind=feature. Example: command palette.",
          },
        },
        additionalProperties: false,
      },
      trust: {
        type: "string",
        enum: ["trusted", "untrusted"],
        default: "untrusted",
        description:
          "Use trusted only for Stella-owned upstream sources. Untrusted sources get a no-tool safety review before import.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  promptSnippet:
    "`import_source` imports a local path or git ref into this Stella tree with review, git fast path, and agent fallback.",
  execute: async (args, context, extras) => {
    if (!options.sourceImportApi) {
      return { error: "Source import is not available in this runtime." };
    }
    const source = parseSource(args.source);
    if (!source) {
      return {
        error:
          "source must be {kind:'local-path', path} or {kind:'git', url}.",
      };
    }

    try {
      const result = await options.sourceImportApi.importSource({
        source,
        scope: parseScope(args.scope),
        trust: parseTrust(args.trust),
        conversationId: context.conversationId,
        requestId: context.requestId,
        ...(extras?.signal ? { signal: extras.signal } : {}),
      });
      return { result };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});
