import path from "node:path";

import type { AssistantMessage, Context, Message } from "../../ai/types.js";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { HostAppBrowserContextSnapshot } from "../../protocol/index.js";
import type { LocalContextEvent } from "../local-history.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import {
  sanitizePromptContext,
  sanitizeToolVisibleText,
} from "../tools/safety.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

const MAX_CONTEXT_OUTPUT_TOKENS = 900;
const MAX_MEMORY_SEARCH_TERMS = 12;
const MAX_MEMORY_SEARCH_TERM_CHARS = 120;
const MAX_MEMORY_SEARCH_MATCHES = 40;
const MAX_MEMORY_SEARCH_CONTEXT_LINES = 1;
const MAX_MEMORY_SEARCH_RESULTS_CHARS = 16_000;
const CHRONICLE_DIR_SEGMENTS = ["memories_extensions", "chronicle"] as const;

type ContextLookupStore = Pick<RuntimeStore, "listActiveThreads">;

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

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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

const normalizeMemorySearchTerms = (terms?: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const term of terms ?? []) {
    const trimmed = term.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const capped = trimmed.slice(0, MAX_MEMORY_SEARCH_TERM_CHARS);
    const key = capped.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(capped);
    if (normalized.length >= MAX_MEMORY_SEARCH_TERMS) break;
  }
  return normalized;
};

type MemoryFileSource = {
  displayPath: string;
  path: string;
  includeByDefault: boolean;
};

const MEMORY_FILE_SOURCES = (stellaHome: string): MemoryFileSource[] => [
  {
    displayPath: "~/.stella/memories/memory_summary.md",
    path: path.join(stellaHome, "memories", "memory_summary.md"),
    includeByDefault: true,
  },
  {
    displayPath: "~/.stella/memories/MEMORY.md",
    path: path.join(stellaHome, "memories", "MEMORY.md"),
    includeByDefault: true,
  },
  {
    displayPath: "~/.stella/memories/raw_memories.md",
    path: path.join(stellaHome, "memories", "raw_memories.md"),
    includeByDefault: false,
  },
];

const readMemoryFiles = async (
  stellaHome: string,
  opts?: { hasSearchTerms?: boolean },
): Promise<string> => {
  const files = [
    ...MEMORY_FILE_SOURCES(stellaHome).filter(
      (file) =>
        file.includeByDefault &&
        (!opts?.hasSearchTerms ||
          file.displayPath !== "~/.stella/memories/MEMORY.md"),
    ),
  ];
  const blocks: string[] = [];
  for (const file of files) {
    const content = await readOptionalTextFile(file.path);
    if (!content) continue;
    blocks.push(
      `<memory_file path="${file.displayPath}">\n${sanitizePromptContext(content, file.displayPath)}\n</memory_file>`,
    );
  }
  if (blocks.length === 0) return "No memory files found.";
  if (opts?.hasSearchTerms) {
    blocks.push(
      "Full ~/.stella/memories/MEMORY.md omitted because memorySearchTerms were provided. Use # Memory Search Results for matched lines.",
    );
  }
  return blocks.join("\n\n");
};

const lineMatchesTerms = (
  line: string,
  normalizedTerms: string[],
): string[] => {
  const lower = line.toLocaleLowerCase();
  return normalizedTerms.filter((term) =>
    lower.includes(term.toLocaleLowerCase()),
  );
};

const formatLineRange = (start: number, end: number): string =>
  start === end ? String(start) : `${start}-${end}`;

const readMemorySearchResults = async (
  stellaHome: string,
  searchTerms?: readonly string[],
): Promise<string> => {
  const terms = normalizeMemorySearchTerms(searchTerms);
  if (terms.length === 0) {
    return "No memory search terms provided.";
  }

  const blocks: string[] = [
    `<memory_search terms="${escapeAttribute(terms.join(", "))}">`,
  ];
  let matchCount = 0;
  let truncated = false;

  for (const file of MEMORY_FILE_SOURCES(stellaHome)) {
    const content = await readOptionalTextFile(file.path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const usedRanges: Array<{ start: number; end: number }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const matchedTerms = lineMatchesTerms(lines[index] ?? "", terms);
      if (matchedTerms.length === 0) continue;

      const start = Math.max(0, index - MAX_MEMORY_SEARCH_CONTEXT_LINES);
      const end = Math.min(
        lines.length - 1,
        index + MAX_MEMORY_SEARCH_CONTEXT_LINES,
      );
      const previous = usedRanges[usedRanges.length - 1];
      if (previous && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
        continue;
      }
      usedRanges.push({ start, end });
    }

    for (const range of usedRanges) {
      if (matchCount >= MAX_MEMORY_SEARCH_MATCHES) {
        truncated = true;
        break;
      }
      const numbered = lines
        .slice(range.start, range.end + 1)
        .map((line, offset) => `${range.start + offset + 1}: ${line}`)
        .join("\n");
      const rangeText = formatLineRange(range.start + 1, range.end + 1);
      blocks.push(
        [
          `<match path="${escapeAttribute(file.displayPath)}" lines="${rangeText}">`,
          sanitizeToolVisibleText(numbered),
          "</match>",
        ].join("\n"),
      );
      matchCount += 1;
      if (blocks.join("\n\n").length > MAX_MEMORY_SEARCH_RESULTS_CHARS) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (matchCount === 0) {
    blocks.push("No matching memory lines found.");
  }
  if (truncated) {
    blocks.push(
      `[truncated after ${matchCount} matches; narrow or change memorySearchTerms for more precise recall]`,
    );
  }
  blocks.push("</memory_search>");
  return blocks.join("\n\n");
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
  memorySearchTerms?: readonly string[];
  stellaHome: string;
  store: ContextLookupStore;
  localEvents: LocalContextEvent[];
  appBrowserContext?: HostAppBrowserContextSnapshot;
}): Promise<string> => {
  const normalizedSearchTerms = normalizeMemorySearchTerms(
    args.memorySearchTerms,
  );
  const hasSearchTerms = normalizedSearchTerms.length > 0;
  const [memoryFiles, memorySearchResults, chronicleFiles] = await Promise.all([
    readMemoryFiles(args.stellaHome, {
      hasSearchTerms,
    }),
    hasSearchTerms
      ? readMemorySearchResults(args.stellaHome, normalizedSearchTerms)
      : Promise.resolve(""),
    readChronicleFiles(args.stellaHome),
  ]);

  const sections = [
    "# Lookup Request",
    truncate(args.lookupPrompt.trim(), 2_000),
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
  ];
  if (hasSearchTerms) {
    sections.push("", "# Memory Search Results", memorySearchResults);
  }
  return sections.join("\n");
};

export const runContextLookup = async (args: {
  conversationId: string;
  lookupPrompt: string;
  memorySearchTerms?: readonly string[];
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
      stellaModel: args.resolvedLlm.model.id,
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
