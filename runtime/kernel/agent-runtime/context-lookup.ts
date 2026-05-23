import path from "node:path";

import type { AssistantMessage, Context, Message } from "../../ai/types.js";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { HostAppBrowserContextSnapshot } from "../../protocol/index.js";
import type { LocalContextEvent } from "../local-history.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

const MAX_CONTEXT_OUTPUT_TOKENS = 900;
const CHRONICLE_DIR_SEGMENTS = [
  "memories_extensions",
  "chronicle",
] as const;

type ContextLookupStore = Pick<
  RuntimeStore,
  "memoryStore" | "listActiveThreads"
>;

const CONTEXT_LOOKUP_SYSTEM_PROMPT = [
  "Provide relevant matching information for the lookup request.",
  "",
  "Use the available context sources to return only information that directly helps answer or route the request.",
  "",
  "Return a concise markdown brief. Include relevant memory, likely referenced apps/tabs, URLs, and active agent threads only when they help.",
  'If nothing is relevant, respond exactly "Nothing relevant found."',
].join("\n");

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n...[truncated]`;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const formatLatestLocalContext = (events: LocalContextEvent[]): string => {
  const rows: string[] = [];
  for (
    let index = events.length - 1;
    index >= 0 && rows.length < 5;
    index -= 1
  ) {
    const payload = asObject(events[index]?.payload);
    const metadata = asObject(payload.metadata);
    const context = asObject(metadata.context);
    const parts: string[] = [];
    const windowLabel = context.windowLabel;
    const appSelectionLabel = context.appSelectionLabel;
    const windowPreviewImageUrl = context.windowPreviewImageUrl;
    const browserUrl = context.browserUrl;
    if (typeof windowLabel === "string" && windowLabel.trim()) {
      parts.push(`active window: ${windowLabel.trim()}`);
    }
    if (typeof appSelectionLabel === "string" && appSelectionLabel.trim()) {
      parts.push(`selected area: ${appSelectionLabel.trim()}`);
    }
    if (
      typeof windowPreviewImageUrl === "string" &&
      windowPreviewImageUrl.trim()
    ) {
      parts.push("active-window screenshot was attached");
    }
    if (typeof browserUrl === "string" && browserUrl.trim()) {
      parts.push(`browser URL: ${browserUrl.trim()}`);
    }
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.length
      : 0;
    if (attachments > 0) {
      parts.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
    }
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No app, browser, selection, or attachment metadata is available.";
};

const formatLiveAppBrowserContext = (
  snapshot: HostAppBrowserContextSnapshot | undefined,
): string => {
  const rows: string[] = [];
  const tab = snapshot?.activeBrowserTab;
  if (tab) {
    rows.push(
      [
        "- active browser tab:",
        `  browser: ${tab.browser}`,
        ...(tab.title?.trim() ? [`  title: ${tab.title.trim()}`] : []),
        `  url: ${tab.url}`,
      ].join("\n"),
    );
  }
  for (const app of snapshot?.apps ?? []) {
    const parts = [
      app.isActive ? "frontmost" : "recent",
      app.name,
      app.windowTitle?.trim() ? `window: ${app.windowTitle.trim()}` : "",
      app.bundleId?.trim() ? `bundle: ${app.bundleId.trim()}` : "",
    ].filter(Boolean);
    if (parts.length > 0) rows.push(`- ${parts.join("; ")}`);
  }
  return rows.length > 0
    ? rows.join("\n")
    : "No live app or browser-tab snapshot is available.";
};

const formatMemorySnapshot = (
  store: Pick<ContextLookupStore, "memoryStore">,
): string => {
  store.memoryStore.loadSnapshot();
  const user = store.memoryStore.formatForSystemPrompt("user")?.trim();
  const memory = store.memoryStore.formatForSystemPrompt("memory")?.trim();
  const parts = [
    user ? `<memory_snapshot target="user">\n${user}\n</memory_snapshot>` : "",
    memory
      ? `<memory_snapshot target="memory">\n${memory}\n</memory_snapshot>`
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "No durable memory entries.";
};

const readMemoryFiles = async (stellaHome: string): Promise<string> => {
  const files = [
    {
      displayPath: "~/.stella/memories/memory_summary.md",
      path: path.join(stellaHome, "memories", "memory_summary.md"),
    },
    {
      displayPath: "~/.stella/memories/MEMORY.md",
      path: path.join(stellaHome, "memories", "MEMORY.md"),
    },
  ];
  const blocks: string[] = [];
  for (const file of files) {
    const content = await readOptionalTextFile(file.path);
    if (!content) continue;
    blocks.push(
      `<memory_file path="${file.displayPath}">\n${content}\n</memory_file>`,
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "No memory files found.";
};

const readChronicleFiles = async (stellaHome: string): Promise<string> => {
  const files = [
    { name: "10m-current.md", label: "last ~10 minutes" },
    { name: "6h-current.md", label: "last ~6 hours" },
  ];
  const blocks: string[] = [];
  for (const file of files) {
    const displayPath = path.posix.join(...CHRONICLE_DIR_SEGMENTS, file.name);
    const content = await readOptionalTextFile(
      path.join(stellaHome, ...CHRONICLE_DIR_SEGMENTS, file.name),
    );
    if (!content) continue;
    blocks.push(
      `<chronicle_snapshot window="${file.label}" path="${displayPath}">\n${content}\n</chronicle_snapshot>`,
    );
  }
  return blocks.length > 0
    ? blocks.join("\n\n")
    : "No Chronicle summaries found.";
};

const formatActiveThreads = (
  store: Pick<ContextLookupStore, "listActiveThreads">,
  conversationId: string,
): string => {
  const threads = store.listActiveThreads(conversationId).slice(0, 16);
  if (threads.length === 0) return "No resumable agent threads.";
  return threads
    .map((thread) => {
      const summary = thread.summary?.trim();
      return [
        `- ${thread.threadId}`,
        `  description: ${thread.description?.trim() || "No description recorded"}`,
        ...(summary ? [`  summary: ${summary}`] : []),
      ].join("\n");
    })
    .join("\n");
};

export const buildContextLookupUserPrompt = async (args: {
  conversationId: string;
  lookupPrompt: string;
  stellaHome: string;
  store: ContextLookupStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
}): Promise<string> => {
  const [memoryFiles, chronicleFiles] = await Promise.all([
    readMemoryFiles(args.stellaHome),
    readChronicleFiles(args.stellaHome),
  ]);

  return [
    "# Lookup Request",
    truncate(args.lookupPrompt.trim(), 2_000),
    "",
    "# Durable Memory",
    formatMemorySnapshot(args.store),
    "",
    "# Memory Files",
    memoryFiles,
    "",
    "# Local App And Browser Context",
    formatLiveAppBrowserContext(args.appBrowserContext),
    "",
    "# Message-Attached App And Browser Context",
    formatLatestLocalContext(args.localEvents),
    "",
    "# Active Agent Threads",
    formatActiveThreads(args.store, args.conversationId),
    "",
    "# Chronicle Context",
    chronicleFiles,
  ].join("\n");
};

export const runContextLookup = async (args: {
  conversationId: string;
  lookupPrompt: string;
  stellaRoot: string;
  stellaHome: string;
  store: RuntimeStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
  resolvedLlm: ResolvedLlmRoute;
  signal?: AbortSignal;
}): Promise<string> => {
  const userText = await buildContextLookupUserPrompt(args);
  const context: Context = {
    systemPrompt: CONTEXT_LOOKUP_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: Date.now(),
      } satisfies Message,
    ],
  };

  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaRoot,
    modelId: args.resolvedLlm.model.id,
  });
  if (useClaudeCode) {
    const text = await runClaudeCodeAgentTextCompletion({
      stellaRoot: args.stellaRoot,
      agentType: AGENT_IDS.ORCHESTRATOR,
      context,
      abortSignal: args.signal,
    });
    return text.trim() || "Nothing relevant found.";
  }

  const apiKey = (await args.resolvedLlm.getApiKey())?.trim();
  if (!apiKey) {
    return "Context lookup is unavailable because no model credential is configured.";
  }

  const response: AssistantMessage = await completeSimple(
    args.resolvedLlm.model,
    context,
    {
      apiKey,
      ...(args.resolvedLlm.refreshApiKey
        ? { refreshApiKey: args.resolvedLlm.refreshApiKey }
        : {}),
      maxTokens: MAX_CONTEXT_OUTPUT_TOKENS,
      temperature: 0,
      ...(args.signal ? { signal: args.signal } : {}),
    },
  );

  return readAssistantText(response).trim() || "Nothing relevant found.";
};
