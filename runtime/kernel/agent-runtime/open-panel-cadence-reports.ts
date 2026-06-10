/**
 * Background Open-panel cadence reports.
 *
 * Cadence reports (4h / Daily / Weekly) are generated as normal inline
 * chat HTML artifacts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileChange } from "../../contracts/file-changes.js";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
} from "../../ai/types.js";
import {
  collectBrowserActivityWindows,
  type BrowserActivityWindow,
} from "../../discovery/browser-data.js";
import type { BrowserType } from "../../contracts/index.js";
import { getCadenceReportsPreferences } from "../preferences/local-preferences.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  LocalChatAppendEventArgs,
  LocalChatRecentActivityRecord,
} from "../storage/shared.js";
import { eventTextFromPayload } from "../storage/shared.js";
import type { DreamInboxRow } from "../memory/dream-inbox-store.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { isUiHiddenChatMessagePayload } from "../../chat-event-visibility.js";

const logger = createRuntimeLogger("agent-runtime.open-panel-cadence-reports");

export type OpenPanelReportCadence = "4h" | "daily" | "weekly";

type CadenceConfig = {
  id: OpenPanelReportCadence;
  label: string;
  intervalMs: number;
  windowMs: number;
  title: string;
};

export type OpenPanelReportRecord = {
  cadence: OpenPanelReportCadence;
  label: string;
  title: string;
  filePath: string;
  generatedAt: number;
  slotAt?: number;
  windowStartAt: number;
  openedAt?: number;
};

type ReportIndex = {
  version: 1;
  reports: Partial<Record<OpenPanelReportCadence, OpenPanelReportRecord>>;
  checkedSlots?: Partial<Record<OpenPanelReportCadence, number>>;
};

const CADENCES: CadenceConfig[] = [
  {
    id: "4h",
    label: "4h",
    intervalMs: 4 * 60 * 60 * 1000,
    windowMs: 4 * 60 * 60 * 1000,
    title: "Report - 4h",
  },
  {
    id: "daily",
    label: "Daily",
    intervalMs: 24 * 60 * 60 * 1000,
    windowMs: 24 * 60 * 60 * 1000,
    title: "Report - Daily",
  },
  {
    id: "weekly",
    label: "Weekly",
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    windowMs: 7 * 24 * 60 * 60 * 1000,
    title: "Report - Weekly",
  },
];

const MAX_THREAD_SUMMARIES = 40;
const MAX_THREAD_SUMMARY_CHARS = 2_000;
const MAX_ACTIVITY_EVENTS = 80;
const MAX_ACTIVITY_TEXT_CHARS = 700;
const MIN_USER_TURNS_BY_CADENCE: Record<OpenPanelReportCadence, number> = {
  "4h": 20,
  daily: 40,
  weekly: 60,
};
const FOUR_HOUR_LOCAL_SLOTS = [8, 12, 16, 20] as const;
const DAILY_LOCAL_HOUR = 8;
const WEEKLY_LOCAL_DAY = 1;
const inFlightCadences = new Set<OpenPanelReportCadence>();

const SYSTEM_PROMPT = [
  "You generate compact, polished HTML reports for Stella.",
  "",
  "Use the supplied recent Stella activity, thread summaries, and browser activity for exactly the requested window.",
  "The report is not a diary and not a status summary. Its job is to surface useful ideas Stella could help with next.",
  "Only include something when it is actually worth suggesting. Prefer a short report over padding.",
  "Write for a normal non-technical user. Hide implementation details, commands, file paths, source modules, and internal tool names unless the user explicitly asked about them in the activity.",
  'Translate technical evidence into everyday outcomes. For example, say "save a checklist for code changes" instead of naming validation commands or source files.',
  "Look for real repeated patterns or durable needs. Do not promote one-off actions into patterns just because they happened once.",
  "Good outputs are suggestions for reusable workflows, Stella skills, small apps, reminders, schedules, or connected-app/browser workflows.",
  "Each idea should be phrased as something the user could ask Stella to do, in plain language.",
  "The output is rendered directly in Stella's trusted Canvas viewer. You may use inline scripts, external scripts, external stylesheets, CDN imports, charts, tables, and interactive controls when helpful.",
  'If an idea is a good next chat prompt, put it in a selectable/actionable element with data-stella-compose="the exact plain-language prompt Stella should place in chat". Stella will add the hover button; do not build your own chat button.',
  "",
  "You MUST deliver the report by calling the `emit_report` tool exactly once with the complete HTML document in the `html` parameter. Do NOT include the HTML in your text response. Do NOT skip the tool call.",
  "",
  "Rules:",
  "  1. Pass one complete <!doctype html> document in the `html` argument. No markdown fences. No commentary outside the tool call.",
  "  2. Ground every claim in the supplied activity. Do not invent private details.",
  "  3. Make it useful at a glance: a few sections, short cards, and direct next-step language.",
  "  4. For 4h reports, include only timely ideas from recent Stella use. For Daily reports, include only patterns or opportunities worth saving.",
  "  5. If there is little signal, say there is nothing standout yet and keep the report short. Do not fill space with generic ideas.",
  "  6. Keep the visual style quiet, native-feeling, and readable in a side panel. Cormorant for display type and Manrope for body when convenient.",
  "  7. Use friendly labels like Skill, Workflow, App idea, Reminder, or Schedule. Avoid developer vocabulary.",
  '  8. Avoid headings like "patterns worth making durable". Use plain headings such as "Ideas worth saving", "Useful reminders", or "Small apps Stella could make".',
].join("\n");

const EMIT_REPORT_TOOL: Tool = {
  name: "emit_report",
  description:
    "Deliver the finished HTML report. Call this exactly once with the complete <!doctype html> document in the `html` argument.",
  // Tool.parameters is typed as `TSchema` but providers consume the
  // underlying JSON-Schema-shaped object at runtime. Mirrors the same
  // cast used by `runtime/kernel/agent-runtime/memory-review.ts`.
  parameters: {
    type: "object",
    properties: {
      html: {
        type: "string",
        description:
          "The complete HTML document to render in the Canvas viewer. Must include a doctype and a <body> with the report content.",
      },
    },
    required: ["html"],
  } as unknown as Tool["parameters"],
};

const reportsDir = (stellaAppDir: string) =>
  path.join(stellaAppDir, "open-panel-reports");

const indexPath = (stellaAppDir: string) =>
  path.join(reportsDir(stellaAppDir), "index.json");

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...(truncated)`;

const emptyIndex = (): ReportIndex => ({
  version: 1,
  reports: {},
  checkedSlots: {},
});

const isCadence = (value: unknown): value is OpenPanelReportCadence =>
  value === "4h" || value === "daily" || value === "weekly";

const isRecord = (value: unknown): value is OpenPanelReportRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OpenPanelReportRecord>;
  return (
    isCadence(record.cadence) &&
    typeof record.label === "string" &&
    typeof record.title === "string" &&
    typeof record.filePath === "string" &&
    typeof record.generatedAt === "number" &&
    typeof record.windowStartAt === "number"
  );
};

export const listOpenPanelReportCadences = (): readonly CadenceConfig[] =>
  CADENCES;

export const readOpenPanelReportIndex = async (
  stellaAppDir: string,
): Promise<ReportIndex> => {
  try {
    const raw = await fs.readFile(indexPath(stellaAppDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyIndex();
    }
    const source = (parsed as { reports?: unknown }).reports;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return emptyIndex();
    }
    const reports: ReportIndex["reports"] = {};
    for (const [key, value] of Object.entries(source)) {
      if (isCadence(key) && isRecord(value)) {
        reports[key] = value;
      }
    }
    const checkedSlots: ReportIndex["checkedSlots"] = {};
    const rawCheckedSlots = (parsed as { checkedSlots?: unknown }).checkedSlots;
    if (
      rawCheckedSlots &&
      typeof rawCheckedSlots === "object" &&
      !Array.isArray(rawCheckedSlots)
    ) {
      for (const [key, value] of Object.entries(rawCheckedSlots)) {
        if (
          isCadence(key) &&
          typeof value === "number" &&
          Number.isFinite(value)
        ) {
          checkedSlots[key] = value;
        }
      }
    }
    return { version: 1, reports, checkedSlots };
  } catch {
    return emptyIndex();
  }
};

const writeOpenPanelReportIndex = async (
  stellaAppDir: string,
  index: ReportIndex,
): Promise<void> => {
  await fs.mkdir(reportsDir(stellaAppDir), { recursive: true });
  await fs.writeFile(
    indexPath(stellaAppDir),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
};

const startOfLocalDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

const localSlotMs = (date: Date, hour: number): number =>
  new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour,
    0,
    0,
    0,
  ).getTime();

const latestDailySlotAt = (nowMs: number): number => {
  const now = new Date(nowMs);
  const todayAt8 = localSlotMs(now, DAILY_LOCAL_HOUR);
  if (nowMs >= todayAt8) return todayAt8;
  const yesterday = startOfLocalDay(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return localSlotMs(yesterday, DAILY_LOCAL_HOUR);
};

const latestWeeklySlotAt = (nowMs: number): number => {
  const now = new Date(nowMs);
  const candidate = startOfLocalDay(now);
  const daysSinceMonday = (candidate.getDay() - WEEKLY_LOCAL_DAY + 7) % 7;
  candidate.setDate(candidate.getDate() - daysSinceMonday);
  candidate.setHours(DAILY_LOCAL_HOUR, 0, 0, 0);
  if (nowMs < candidate.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  return candidate.getTime();
};

const latestFourHourSlotAt = (nowMs: number): number => {
  const now = new Date(nowMs);
  for (let i = FOUR_HOUR_LOCAL_SLOTS.length - 1; i >= 0; i -= 1) {
    const slotAt = localSlotMs(now, FOUR_HOUR_LOCAL_SLOTS[i]!);
    if (nowMs >= slotAt) return slotAt;
  }
  const yesterday = startOfLocalDay(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return localSlotMs(
    yesterday,
    FOUR_HOUR_LOCAL_SLOTS[FOUR_HOUR_LOCAL_SLOTS.length - 1]!,
  );
};

export const latestOpenPanelReportSlotAt = (
  cadence: OpenPanelReportCadence,
  nowMs: number,
): number => {
  if (cadence === "4h") return latestFourHourSlotAt(nowMs);
  if (cadence === "daily") return latestDailySlotAt(nowMs);
  return latestWeeklySlotAt(nowMs);
};

const latestKnownSlotAt = (
  cadence: OpenPanelReportCadence,
  index: ReportIndex,
): number | null => {
  const checkedAt = index.checkedSlots?.[cadence];
  const generatedAt = index.reports[cadence]?.slotAt;
  const legacyGeneratedAt = index.reports[cadence]?.generatedAt;
  const candidates = [checkedAt, generatedAt, legacyGeneratedAt].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
};

const setCheckedSlot = (
  index: ReportIndex,
  cadence: OpenPanelReportCadence,
  slotAt: number,
): void => {
  index.checkedSlots = {
    ...(index.checkedSlots ?? {}),
    [cadence]: slotAt,
  };
};

export const listOpenPanelReports = async (
  stellaAppDir: string,
): Promise<OpenPanelReportRecord[]> => {
  const index = await readOpenPanelReportIndex(stellaAppDir);
  return CADENCES.map((cadence) => index.reports[cadence.id]).filter(
    (entry): entry is OpenPanelReportRecord => Boolean(entry),
  );
};

export const markOpenPanelReportOpened = async (
  stellaAppDir: string,
  cadence: OpenPanelReportCadence,
): Promise<OpenPanelReportRecord | null> => {
  const index = await readOpenPanelReportIndex(stellaAppDir);
  const report = index.reports[cadence];
  if (!report) return null;
  const next = { ...report, openedAt: Date.now() };
  index.reports[cadence] = next;
  await writeOpenPanelReportIndex(stellaAppDir, index);
  return next;
};

const stripFences = (text: string): string => {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
};

// Pulls usable HTML body content out of arbitrary text. Returns "" when
// nothing recognizable as HTML is present so the caller can refuse to
// overwrite a previously good report with a blank shell.
const extractHtmlFromText = (text: string): string => {
  const stripped = stripFences(text);
  if (stripped.length === 0) return "";
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(stripped)) return stripped;
  return "";
};

const extractHtmlFromToolCall = (response: AssistantMessage): string => {
  const call = response.content.find(
    (part): part is ToolCall =>
      part.type === "toolCall" && part.name === EMIT_REPORT_TOOL.name,
  );
  if (!call) return "";
  const raw = call.arguments?.html;
  return typeof raw === "string" ? raw.trim() : "";
};

const normalizeHtml = (rawHtml: string, title: string): string => {
  const trimmed = rawHtml.trim();
  if (trimmed.length === 0) return "";
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body>
${trimmed}
</body>
</html>
`;
};

const formatThreadSummaries = (
  summaries: DreamInboxRow[],
  sinceMs: number,
): string => {
  const matching = summaries
    .filter((row) => row.sourceUpdatedAt >= sinceMs)
    .slice(0, MAX_THREAD_SUMMARIES);
  if (matching.length === 0) return "(none)";
  return matching
    .map((row) => {
      const summary = truncate(
        row.content.trim(),
        MAX_THREAD_SUMMARY_CHARS,
      );
      return `- [${new Date(row.sourceUpdatedAt).toISOString()}] ${summary}`;
    })
    .join("\n");
};

const getRecentActivity = (
  store: RuntimeStore,
  sinceMs: number,
): LocalChatRecentActivityRecord[] =>
  store.listRecentActivitySince({
    sinceMs,
    limit: MAX_ACTIVITY_EVENTS,
  });

const formatRecentActivity = (
  events: LocalChatRecentActivityRecord[],
): string => {
  if (events.length === 0) return "(none)";
  return events
    .map((event) => {
      const text = truncate(
        eventTextFromPayload(event.payload).replace(/\s+/g, " "),
        MAX_ACTIVITY_TEXT_CHARS,
      );
      const suffix = text ? ` - ${text}` : "";
      return `- [${new Date(event.timestamp).toISOString()}] ${event.type}${suffix}`;
    })
    .join("\n");
};

const countVisibleUserTurns = (
  events: LocalChatRecentActivityRecord[],
): number =>
  events.filter(
    (event) =>
      event.type === "user_message" &&
      !isUiHiddenChatMessagePayload(event.payload ?? null),
  ).length;

export const hasEnoughOpenPanelReportActivity = (
  cadence: OpenPanelReportCadence,
  events: LocalChatRecentActivityRecord[],
): boolean =>
  countVisibleUserTurns(events) >= MIN_USER_TURNS_BY_CADENCE[cadence];

const formatDomainList = (
  domains: ReadonlyArray<{ domain: string; visits: number }>,
): string =>
  domains.map((domain) => `${domain.domain} (${domain.visits})`).join("\n");

const formatBrowserWindow = (window: BrowserActivityWindow | null): string => {
  if (!window?.data.browser) return "No browser data available.";
  const sections = [
    `## Browser Activity (${window.data.browser}, ${window.label})`,
  ];
  if (window.data.recentDomains.length > 0) {
    sections.push("\n### Active domains");
    sections.push(formatDomainList(window.data.recentDomains));
  }
  if (Object.keys(window.data.domainDetails).length > 0) {
    sections.push("\n### Pages");
    for (const [domain, titles] of Object.entries(window.data.domainDetails)) {
      sections.push(`\n**${domain}**`);
      sections.push(
        titles
          .slice(0, 8)
          .map((entry) => `- ${entry.title} (${entry.visitCount})`)
          .join("\n"),
      );
    }
  }
  if (window.data.clusterKeywords.length > 0) {
    sections.push("\n### Research topics");
    sections.push(
      window.data.clusterKeywords
        .slice(0, 12)
        .map((entry) => `- ${entry.keyword}`)
        .join("\n"),
    );
  }
  return sections.length === 1
    ? "No browser activity in this window."
    : sections.join("\n");
};

const buildUserPrompt = (args: {
  cadence: CadenceConfig;
  sinceMs: number;
  nowMs: number;
  summaries: DreamInboxRow[];
  activity: string;
  browserWindow: BrowserActivityWindow | null;
}): string => {
  const browserText = formatBrowserWindow(args.browserWindow);
  const reportGoal =
    args.cadence.id === "4h"
      ? "Suggest only timely next-step ideas from recent Stella use. Skip weak or one-off observations."
      : args.cadence.id === "daily"
        ? "Suggest only durable workflows, skills, app ideas, reminders, or schedules that seem genuinely useful from the day."
        : "Suggest only broader workflows, skills, app ideas, reminders, or schedules that seem genuinely useful from the week.";
  return [
    `Report cadence: ${args.cadence.label}`,
    `Report goal: ${reportGoal}`,
    `Window start: ${new Date(args.sinceMs).toISOString()}`,
    `Window end: ${new Date(args.nowMs).toISOString()}`,
    "",
    "Thread summaries:",
    formatThreadSummaries(args.summaries, args.sinceMs),
    "",
    "Recent Stella activity:",
    args.activity,
    "",
    "Browser activity:",
    browserText,
    "",
    "Generate the HTML report now.",
  ].join("\n");
};

const outputPathForCadence = (
  stellaAppDir: string,
  cadence: OpenPanelReportCadence,
): string => path.join(stellaAppDir, "outputs", "html", `report-${cadence}.html`);

const generateReport = async (args: {
  stellaAppDir: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  cadence: CadenceConfig;
  summaries: DreamInboxRow[];
  browserWindow: BrowserActivityWindow | null;
  nowMs: number;
  slotAt: number;
  activity: string;
}): Promise<OpenPanelReportRecord | null> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: args.stellaAppDir,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : (await args.resolvedLlm.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    logger.debug("open-panel-report.skipped.no-api-key", {
      cadence: args.cadence.id,
    });
    return null;
  }

  const sinceMs = args.nowMs - args.cadence.windowMs;
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildUserPrompt({
          cadence: args.cadence,
          sinceMs,
          nowMs: args.nowMs,
          summaries: args.summaries,
          activity: args.activity,
          browserWindow: args.browserWindow,
        }),
      },
    ],
    timestamp: Date.now(),
  };
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [userMessage],
    tools: [EMIT_REPORT_TOOL],
  };

  let rawHtml = "";
  try {
    if (useClaudeCode) {
      let captured = "";
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaAppDir,
        agentType: AGENT_IDS.OPEN_PANEL_REPORTS,
        stellaModel: args.resolvedLlm.model.id,
        context,
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          if (toolName !== EMIT_REPORT_TOOL.name) {
            return { error: `Tool ${toolName} is not available.` };
          }
          const html = toolArgs?.html;
          if (typeof html === "string") captured = html;
          return { result: "ok" };
        },
      });
      rawHtml = captured.trim() || extractHtmlFromText(finalText);
    } else {
      const response = await completeSimple(args.resolvedLlm.model, context, {
        apiKey,
        // Drop the default 32k cap (see `runtime/ai/providers/simple-options.ts`)
        // so reasoning models don't burn the entire token budget thinking
        // and return an empty assistant message. Use the model's full headroom
        // when known; let the provider decide otherwise.
        ...(args.resolvedLlm.model.maxTokens > 0
          ? { maxTokens: args.resolvedLlm.model.maxTokens }
          : {}),
      });
      rawHtml =
        extractHtmlFromToolCall(response) ||
        extractHtmlFromText(readAssistantText(response));
    }
  } catch (error) {
    logger.debug("open-panel-report.completeSimple.failed", {
      cadence: args.cadence.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const html = normalizeHtml(rawHtml, args.cadence.title);
  if (html.length === 0) {
    logger.debug("open-panel-report.skipped.empty-output", {
      cadence: args.cadence.id,
    });
    return null;
  }

  const filePath = outputPathForCadence(args.stellaAppDir, args.cadence.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, html, "utf-8");

  return {
    cadence: args.cadence.id,
    label: args.cadence.label,
    title: args.cadence.title,
    filePath,
    generatedAt: args.nowMs,
    slotAt: args.slotAt,
    windowStartAt: sinceMs,
  };
};

export const spawnOpenPanelCadenceReports = (deps: {
  conversationId: string;
  stellaAppDir: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  appendLocalChatEvent: (args: LocalChatAppendEventArgs) => void;
}): void => {
  void (async () => {
    const nowMs = Date.now();
    const config = getCadenceReportsPreferences(deps.stellaAppDir);
    const index = await readOpenPanelReportIndex(deps.stellaAppDir);
    const nextIndex = {
      ...index,
      checkedSlots: { ...(index.checkedSlots ?? {}) },
    };
    let shouldWriteBaseline = false;
    const due = CADENCES.map((cadence) => ({
      cadence,
      slotAt: latestOpenPanelReportSlotAt(cadence.id, nowMs),
    })).filter(({ cadence, slotAt }) => {
      // Reports are opt-in per cadence. A disabled cadence never generates.
      if (!config.schedules[cadence.id]) return false;
      if (inFlightCadences.has(cadence.id)) return false;
      const previousSlotAt = latestKnownSlotAt(cadence.id, index);
      if (previousSlotAt === null) {
        setCheckedSlot(nextIndex, cadence.id, slotAt);
        shouldWriteBaseline = true;
        return false;
      }
      return slotAt > previousSlotAt;
    });
    if (shouldWriteBaseline) {
      await writeOpenPanelReportIndex(deps.stellaAppDir, nextIndex);
    }
    if (due.length === 0) return;

    const dueWithActivity = due
      .map(({ cadence, slotAt }) => {
        const events = getRecentActivity(deps.store, nowMs - cadence.windowMs);
        return {
          cadence,
          slotAt,
          activity: formatRecentActivity(events),
          hasEnoughActivity: hasEnoughOpenPanelReportActivity(
            cadence.id,
            events,
          ),
        };
      })
      .filter(({ cadence, hasEnoughActivity }) => {
        if (hasEnoughActivity) return true;
        logger.debug("open-panel-report.skipped.low-stella-activity", {
          cadence: cadence.id,
        });
        return false;
      });
    if (dueWithActivity.length === 0) return;

    for (const { cadence } of dueWithActivity) inFlightCadences.add(cadence.id);
    try {
      const summaries = deps.store.dreamInboxStore.listRecentThreadSummaries({
        limit: MAX_THREAD_SUMMARIES,
      });
      const browserWindows = await collectBrowserActivityWindows(
        deps.stellaAppDir,
        dueWithActivity.map(({ cadence }) => ({
          id: cadence.id,
          label: cadence.label,
          sinceMs: nowMs - cadence.windowMs,
        })),
        {
          selectedBrowser: (config.browser as BrowserType | null) ?? null,
          selectedProfile: config.profile,
        },
      );
      const browserById = new Map(
        browserWindows.map((entry) => [entry.id, entry]),
      );

      for (const [
        reportIndex,
        { cadence, slotAt, activity },
      ] of dueWithActivity.entries()) {
        try {
          const report = await generateReport({
            ...deps,
            cadence,
            summaries,
            browserWindow: browserById.get(cadence.id) ?? null,
            nowMs,
            slotAt,
            activity,
          });
          if (!report) {
            const latestIndex = await readOpenPanelReportIndex(deps.stellaAppDir);
            setCheckedSlot(latestIndex, cadence.id, slotAt);
            await writeOpenPanelReportIndex(deps.stellaAppDir, latestIndex);
            continue;
          }
          const bytes = Buffer.byteLength(
            await fs.readFile(report.filePath, "utf-8"),
            "utf-8",
          );
          const slug = `report-${cadence.id}`;
          const rowTimestamp = report.generatedAt + reportIndex * 2;
          deps.appendLocalChatEvent({
            conversationId: deps.conversationId,
            type: "assistant_message",
            timestamp: rowTimestamp,
            payload: {
              text: report.title,
              agentType: AGENT_IDS.ORCHESTRATOR,
            },
          });
          deps.appendLocalChatEvent({
            conversationId: deps.conversationId,
            type: "tool_result",
            requestId: `open-panel-report-${cadence.id}-${report.generatedAt}`,
            timestamp: rowTimestamp + 1,
            payload: {
              toolName: "html",
              result: `Canvas "${report.title}" saved to ${report.filePath} and opened in the panel.`,
              resultPreview: `Canvas "${report.title}" saved to ${report.filePath} and opened in the panel.`,
              details: {
                filePath: report.filePath,
                slug,
                title: report.title,
                createdAt: report.generatedAt,
                bytes,
              },
              filePath: report.filePath,
              slug,
              title: report.title,
              createdAt: report.generatedAt,
              bytes,
              fileChanges: [fileChange(report.filePath, { type: "update" })],
              agentType: AGENT_IDS.ORCHESTRATOR,
            },
          });
          const latestIndex = await readOpenPanelReportIndex(deps.stellaAppDir);
          setCheckedSlot(latestIndex, cadence.id, slotAt);
          latestIndex.reports[cadence.id] = {
            ...report,
            openedAt: latestIndex.reports[cadence.id]?.openedAt,
          };
          await writeOpenPanelReportIndex(deps.stellaAppDir, latestIndex);
          logger.debug("open-panel-report.generated", {
            cadence: cadence.id,
            filePath: report.filePath,
          });
        } catch (error) {
          const latestIndex = await readOpenPanelReportIndex(deps.stellaAppDir);
          setCheckedSlot(latestIndex, cadence.id, slotAt);
          await writeOpenPanelReportIndex(deps.stellaAppDir, latestIndex);
          logger.debug("open-panel-report.failed", {
            cadence: cadence.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      for (const { cadence } of dueWithActivity)
        inFlightCadences.delete(cadence.id);
    }
  })().catch((error) => {
    logger.debug("open-panel-reports.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
