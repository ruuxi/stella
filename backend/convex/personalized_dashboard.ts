import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireConversationOwnerAction, requireUserId } from "./auth";
import {
  buildPersonalizedDashboardPageUserMessage,
  type PersonalizedDashboardPageAssignment,
} from "./prompts/personalized_dashboard";
import {
  buildDashboardPlanUserMessage,
  DASHBOARD_PLAN_SYSTEM_PROMPT,
} from "./prompts/dashboard_plan";
import { planDashboardPagesWithLlm } from "./lib/dashboard_plan_llm";
import { normalizeText, cleanSources, slugify } from "./lib/text_utils";

/** Max dashboard pages to generate (0 = disabled). */
const MAX_DASHBOARD_PAGES_TO_GENERATE = 3;

// --- Types ---

type PlannedPage = {
  pageId: string;
  panelName: string;
  title: string;
  topic: string;
  focus: string;
  dataSources: string[];
  personalOrEntertainment: boolean;
  order: number;
};

// --- Utilities ---

const toPanelName = (pageId: string) => {
  const base = slugify(pageId) || `page_${Date.now()}`;
  const panel = `pd_${base}`.slice(0, 64);
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(panel) ? panel : "pd_dashboard_page";
};

const buildAssignmentsFromInput = (
  input: Array<{
    pageId?: string;
    title: string;
    topic: string;
    focus: string;
    dataSources?: string[];
  }>,
): PlannedPage[] => {
  const unique = new Map<string, PlannedPage>();

  for (const raw of input.slice(0, 4)) {
    const title = normalizeText(raw.title, 80);
    const topic = normalizeText(raw.topic, 180);
    const focus = normalizeText(raw.focus, 400);
    const baseId = normalizeText(raw.pageId ?? "", 64) || slugify(title);
    const pageId = slugify(baseId || title || topic || "page") || `page_${unique.size + 1}`;
    if (!title || !topic || !focus || unique.has(pageId)) continue;

    unique.set(pageId, {
      pageId,
      panelName: toPanelName(pageId),
      title,
      topic,
      focus,
      dataSources: cleanSources(raw.dataSources),
      personalOrEntertainment: false,
      order: unique.size,
    });
  }

  return Array.from(unique.values()).slice(0, 4);
};

const toAssignment = (page: PlannedPage): PersonalizedDashboardPageAssignment => ({
  pageId: page.pageId,
  panelName: page.panelName,
  title: page.title,
  topic: page.topic,
  focus: page.focus,
  dataSources: page.dataSources,
  personalOrEntertainment: page.personalOrEntertainment,
});

// --- Validators ---

const pageAssignmentInputValidator = v.object({
  pageId: v.optional(v.string()),
  title: v.string(),
  topic: v.string(),
  focus: v.string(),
  dataSources: v.optional(v.array(v.string())),
});

const startGenerationResultValidator = v.object({
  started: v.boolean(),
  pageIds: v.array(v.string()),
  skippedReason: v.optional(v.string()),
});

// --- Public API ---

export const startGeneration = action({
  args: {
    conversationId: v.id("conversations"),
    userProfile: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    pageAssignments: v.optional(v.array(pageAssignmentInputValidator)),
    force: v.optional(v.boolean()),
    systemPrompt: v.optional(v.string()),
    userPromptTemplate: v.optional(v.string()),
  },
  returns: startGenerationResultValidator,
  handler: async (ctx, args): Promise<{
    started: boolean;
    pageIds: string[];
    skippedReason?: string;
  }> => {
    const ownerId = await requireUserId(ctx);
    await requireConversationOwnerAction(ctx, args.conversationId);

    const manualAssignments = args.pageAssignments
      ? buildAssignmentsFromInput(args.pageAssignments)
      : [];

    const normalizedUserProfile = normalizeText(args.userProfile ?? "", 12_000);

    if (!normalizedUserProfile && manualAssignments.length < 2) {
      return {
        started: false,
        pageIds: [],
        skippedReason: "missing_user_profile",
      };
    }

    const identity = await ctx.auth.getUserIdentity();
    const isAnonymousUser =
      (identity as Record<string, unknown> | null)?.isAnonymous === true;

    let planned: PlannedPage[];
    if (manualAssignments.length >= 2) {
      planned = manualAssignments.slice(0, 4);
    } else {
      try {
        const rawPages = await planDashboardPagesWithLlm({
          ctx,
          caller: {
            kind: "owner",
            ownerId,
            isAnonymousUser,
          },
          coreMemory: normalizedUserProfile,
          systemPrompt: DASHBOARD_PLAN_SYSTEM_PROMPT,
          userMessage: buildDashboardPlanUserMessage(normalizedUserProfile),
        });
        planned = rawPages.map((page, index) => ({
          pageId: page.pageId,
          panelName: toPanelName(page.pageId),
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          personalOrEntertainment: page.personalOrEntertainment,
          order: index,
        }));
      } catch {
        return {
          started: false,
          pageIds: [],
          skippedReason: "dashboard_plan_failed",
        };
      }
    }

    const systemPrompt = args.systemPrompt?.trim();
    const userPromptTemplate = args.userPromptTemplate?.trim();

    const executionTarget = await ctx.runQuery(internal.agent.device_resolver.resolveExecutionTarget, {
      ownerId,
    });

    const hintedTargetDeviceId = normalizeText(args.targetDeviceId ?? "", 256);
    const latestConversationDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: args.conversationId,
    });

    let resolvedTargetDeviceId: string | null = executionTarget.targetDeviceId;
    if (!resolvedTargetDeviceId && hintedTargetDeviceId) {
      resolvedTargetDeviceId = hintedTargetDeviceId;
    }
    if (!resolvedTargetDeviceId && latestConversationDeviceId) {
      resolvedTargetDeviceId = latestConversationDeviceId;
    }

    if (!resolvedTargetDeviceId) {
      return {
        started: false,
        pageIds: [],
        skippedReason: "device_offline",
      };
    }

    const toDispatch = planned.slice(0, MAX_DASHBOARD_PAGES_TO_GENERATE);
    if (toDispatch.length > 0 && (!systemPrompt || !userPromptTemplate)) {
      return {
        started: false,
        pageIds: [],
        skippedReason: "missing_prompt_config",
      };
    }

    for (const page of toDispatch) {
      const assignment = toAssignment(page);
      const userPrompt = buildPersonalizedDashboardPageUserMessage({
        userProfile: normalizedUserProfile,
        assignment,
        promptTemplate: userPromptTemplate!,
      });

      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "dashboard_generation_request",
        targetDeviceId: resolvedTargetDeviceId,
        payload: {
          pageId: page.pageId,
          ownerId,
          panelName: page.panelName,
          title: page.title,
          topic: page.topic,
          focus: page.focus,
          dataSources: page.dataSources,
          systemPrompt: systemPrompt!,
          userPrompt,
        },
      });
    }

    return {
      started: true,
      pageIds: toDispatch.map((page) => page.pageId),
    };
  },
});
