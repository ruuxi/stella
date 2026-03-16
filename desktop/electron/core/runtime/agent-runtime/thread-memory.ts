import type { ResolvedLlmRoute } from "../model-routing.js";
import { estimateRuntimeTokens } from "../runtime-threads.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import type { RuntimeStore } from "../../../storage/runtime-store.js";
import { now } from "./shared.js";

export const buildRunThreadKey = ({
  conversationId,
  agentType,
  runId,
  threadId,
}: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string =>
  buildRuntimeThreadKey({
    conversationId,
    agentType,
    runId,
    threadId,
  });

export const buildHistorySource = (
  context: LocalTaskManagerAgentContext,
): Array<{ role: "user" | "assistant"; content: string }> =>
  context.threadHistory
    ?.filter(
      (entry): entry is { role: "user" | "assistant"; content: string } =>
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string",
    )
    .map((entry) => ({ role: entry.role, content: entry.content })) ?? [];

const getPlatformShellPrompt = (): string | null => {
  if (process.platform === "win32") {
    return "On Windows, Bash runs in Git Bash. Prefer POSIX commands and /c/... style paths over C:\\ paths when using Bash.";
  }
  if (process.platform === "darwin") {
    return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
  }
  return null;
};

const hasShellToolGuidance = (
  context: LocalTaskManagerAgentContext,
): boolean => {
  const toolsAllowlist = context.toolsAllowlist;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return true;
  }
  return (
    toolsAllowlist.includes("Bash") || toolsAllowlist.includes("SkillBash")
  );
};

const resolveMediaSdkDocsUrl = (): string | null => {
  const raw =
    process.env.STELLA_CONVEX_URL?.trim() ||
    process.env.STELLA_LLM_PROXY_URL?.trim() ||
    null;
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/\/+$/, "");
  if (normalized.includes("/api/stella/v1")) {
    return `${normalized.replace(/\/api\/stella\/v1$/i, "")}/api/media/v1/sdk.md`;
  }
  if (normalized.includes(".convex.cloud")) {
    return `${normalized.replace(".convex.cloud", ".convex.site")}/api/media/v1/sdk.md`;
  }
  return `${normalized}/api/media/v1/sdk.md`;
};

export const buildSystemPrompt = (
  context: LocalTaskManagerAgentContext,
): string => {
  const sections = [context.systemPrompt.trim()];

  if (context.dynamicContext?.trim()) {
    sections.push(context.dynamicContext.trim());
  }

  if (context.coreMemory?.trim()) {
    sections.push(`Core memory:\n${context.coreMemory.trim()}`);
  }

  const platformShellPrompt = getPlatformShellPrompt();
  if (platformShellPrompt && hasShellToolGuidance(context)) {
    sections.push(platformShellPrompt);
  }

  const defaultSkills = Array.from(
    new Set(context.defaultSkills.filter((value) => value.trim().length > 0)),
  );
  const skillIds = Array.from(
    new Set(context.skillIds.filter((value) => value.trim().length > 0)),
  );
  if (defaultSkills.length > 0 || skillIds.length > 0) {
    const lines = ["Skills available in this runtime:"];
    if (defaultSkills.length > 0) {
      lines.push(`Default skills: ${defaultSkills.join(", ")}`);
    }
    if (skillIds.length > 0) {
      lines.push(`Enabled installed skill IDs: ${skillIds.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.filter(Boolean).join("\n\n");
};

export const buildSelfModDocumentationPrompt = (
  frontendRoot?: string,
): string => {
  if (!frontendRoot?.trim()) return "";

  const lines = [
    "Documentation:",
    "- If you are working on renderer structure, file placement, or ownership boundaries, read `src/STELLA.md` first.",
  ];

  const mediaSdkDocsUrl = resolveMediaSdkDocsUrl();
  if (mediaSdkDocsUrl) {
    lines.push(
      `- Media SDK reference is always available at \`${mediaSdkDocsUrl}\`. Fetch the latest version before building or changing media features: \`curl -L \"${mediaSdkDocsUrl}\"\`.`,
    );
  }

  return lines.join("\n");
};

export const buildOrchestratorUserPrompt = (
  context: LocalTaskManagerAgentContext,
  userPrompt: string,
): string => {
  const reminder = context.orchestratorReminderText?.trim();
  if (!context.shouldInjectDynamicReminder || !reminder) {
    return userPrompt;
  }
  return `${userPrompt}\n\n<system-context>\n${reminder}\n</system-context>`;
};

export const updateOrchestratorReminderState = (
  store: RuntimeStore,
  args: {
    conversationId: string;
    shouldInjectDynamicReminder?: boolean;
    finalText: string;
  },
): void => {
  const updateCounter = (
    store as RuntimeStore & {
      updateOrchestratorReminderCounter?: (args: {
        conversationId: string;
        resetTo?: number;
        incrementBy?: number;
      }) => void;
    }
  ).updateOrchestratorReminderCounter;
  if (typeof updateCounter !== "function") {
    return;
  }
  if (args.shouldInjectDynamicReminder) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      resetTo: 0,
    });
    return;
  }
  const outputTokens = estimateRuntimeTokens(args.finalText);
  if (outputTokens > 0) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      incrementBy: outputTokens,
    });
  }
};

export const appendThreadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
  },
): void => {
  store.appendThreadMessage({
    timestamp: now(),
    threadKey: args.threadKey,
    role: args.role,
    content: args.content,
  });
};

export const compactRuntimeThreadHistory = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
}): Promise<void> => {
  await maybeCompactRuntimeThread({
    store: args.store,
    threadKey: args.threadKey,
    resolvedLlm: args.resolvedLlm,
    agentType: args.agentType,
  }).catch(() => undefined);
};

export const persistAssistantReply = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  content: string;
}): Promise<void> => {
  if (!args.content.trim()) {
    return;
  }
  appendThreadMessage(args.store, {
    threadKey: args.threadKey,
    role: "assistant",
    content: args.content,
  });
  await compactRuntimeThreadHistory(args);
};
