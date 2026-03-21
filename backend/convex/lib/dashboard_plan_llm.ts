import { MANAGED_GATEWAY } from "../agent/model";
import { resolveModelConfig } from "../agent/model_resolver";
import { AGENT_IDS } from "./agent_constants";
import { extractJsonBlock } from "./json";
import {
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "./managed_billing";
import { normalizeText, cleanSources, slugify } from "./text_utils";
import type { ActionCtx } from "../_generated/server";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

export type DashboardPlanPage = {
  pageId: string;
  title: string;
  topic: string;
  focus: string;
  personalOrEntertainment: boolean;
  dataSources: string[];
};

type DashboardPlanCaller =
  | {
      kind: "owner";
      ownerId: string;
      isAnonymousUser: boolean;
    }
  | {
      kind: "anonymous";
    };

type PlanCtx = Pick<ActionCtx, "runQuery" | "runMutation" | "scheduler">;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const readString = (value: unknown, maxLength: number): string =>
  normalizeText(value, maxLength);

const readDataSources = (value: unknown): string[] => cleanSources(value);

const parseDashboardPlanPage = (
  value: unknown,
  seenPageIds: Set<string>,
): DashboardPlanPage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const page = value as Record<string, unknown>;
  const title = readString(page.title, 80);
  const topic = readString(page.topic, 220);
  const focus = readString(page.focus, 600);
  if (!title || !topic || !focus) {
    return null;
  }

  const basePageId = slugify(readString(page.pageId, 64) || title, 40);
  if (!basePageId) {
    return null;
  }

  let pageId = basePageId;
  let suffix = 1;
  while (seenPageIds.has(pageId)) {
    pageId = `${basePageId}_${suffix++}`.slice(0, 40);
  }
  seenPageIds.add(pageId);

  return {
    pageId,
    title,
    topic,
    focus,
    personalOrEntertainment: page.personalOrEntertainment === true,
    dataSources: readDataSources(page.dataSources),
  };
};

export const parseDashboardPlanPages = (text: string): DashboardPlanPage[] => {
  const jsonText = extractJsonBlock(text);
  assert(jsonText, "Model output did not contain a JSON array");

  const parsed: unknown = JSON.parse(jsonText);
  assert(Array.isArray(parsed), "Expected JSON array of pages");

  const seenPageIds = new Set<string>();
  const pages: DashboardPlanPage[] = [];
  for (const value of parsed) {
    if (pages.length === 3) {
      break;
    }
    const page = parseDashboardPlanPage(value, seenPageIds);
    if (!page) {
      continue;
    }
    pages.push(page);
  }

  assert(pages.length === 3, `Expected 3 pages, got ${pages.length}`);

  assert(
    pages.some((page) => page.personalOrEntertainment),
    "Dashboard plan must include at least one page with personalOrEntertainment: true",
  );

  return pages;
};

export async function planDashboardPagesWithLlm(args: {
  ctx: PlanCtx;
  caller: DashboardPlanCaller;
  coreMemory: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<DashboardPlanPage[]> {
  const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
  if (!apiKey?.trim()) {
    throw new Error(`Missing ${MANAGED_GATEWAY.apiKeyEnvVar}`);
  }

  const systemPrompt = args.systemPrompt.trim();
  if (!systemPrompt) {
    throw new Error("Missing dashboard plan system prompt");
  }

  const modelAccess = args.caller.kind === "owner"
    ? await resolveManagedModelAccess(args.ctx, args.caller.ownerId, {
        isAnonymous: args.caller.isAnonymousUser,
      })
    : undefined;
  if (modelAccess && !modelAccess.allowed) {
    throw new Error(modelAccess.message);
  }

  const config = await resolveModelConfig(
    args.ctx,
    AGENT_IDS.DASHBOARD_GENERATION,
    args.caller.kind === "owner" ? args.caller.ownerId : undefined,
    {
      access: modelAccess,
      audience: args.caller.kind === "anonymous" ? "anonymous" : undefined,
    },
  );

  const startedAt = Date.now();
  const message = await completeManagedChat({
    config: {
      ...config,
      maxOutputTokens: Math.min(config.maxOutputTokens ?? 4096, 8192),
    },
    context: {
      systemPrompt,
      messages: [{
        role: "user",
        content: [{ type: "text", text: args.userMessage }],
        timestamp: Date.now(),
      }],
    },
  });

  if (args.caller.kind === "owner") {
    await scheduleManagedUsage(args.ctx, {
      ownerId: args.caller.ownerId,
      agentType: "service:dashboard_plan",
      model: config.model,
      durationMs: Date.now() - startedAt,
      success: true,
      usage: usageSummaryFromAssistant(message),
    });
  }

  return parseDashboardPlanPages(assistantText(message));
}
