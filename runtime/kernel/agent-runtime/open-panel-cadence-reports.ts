/**
 * Background Open-panel cadence reports.
 *
 * The "Now" pill keeps using home_suggestions. The slower cadence pills
 * (4h / Daily / Weekly) are global per-user HTML reports persisted under
 * state/open-panel-reports so the renderer can show last-generated time
 * and an unseen dot until the user opens the latest report.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type { Context, Message } from "../../ai/types.js";
import {
  collectBrowserActivityWindows,
  type BrowserActivityWindow,
} from "../../discovery/browser-data.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { eventTextFromPayload } from "../storage/shared.js";
import type { ThreadSummaryRow } from "../memory/thread-summaries-store.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

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
  windowStartAt: number;
  openedAt?: number;
};

type ReportIndex = {
  version: 1;
  reports: Partial<Record<OpenPanelReportCadence, OpenPanelReportRecord>>;
};

const CADENCES: CadenceConfig[] = [
  {
    id: "4h",
    label: "4h",
    intervalMs: 4 * 60 * 60 * 1000,
    windowMs: 4 * 60 * 60 * 1000,
    title: "Last 4 Hours",
  },
  {
    id: "daily",
    label: "Daily",
    intervalMs: 24 * 60 * 60 * 1000,
    windowMs: 24 * 60 * 60 * 1000,
    title: "Daily Brief",
  },
  {
    id: "weekly",
    label: "Weekly",
    intervalMs: 7 * 24 * 60 * 60 * 1000,
    windowMs: 7 * 24 * 60 * 60 * 1000,
    title: "Weekly Review",
  },
];

const MAX_THREAD_SUMMARIES = 40;
const MAX_THREAD_SUMMARY_CHARS = 2_000;
const MAX_ACTIVITY_EVENTS = 80;
const MAX_ACTIVITY_TEXT_CHARS = 700;
const inFlightCadences = new Set<OpenPanelReportCadence>();

const SYSTEM_PROMPT = [
  "You generate a compact, polished HTML report for Stella's Open panel.",
  "",
  "Use the supplied recent Stella activity, thread summaries, and browser activity for exactly the requested window.",
  "The output is rendered directly in Stella's trusted Canvas viewer. You may use inline scripts, external scripts, external stylesheets, CDN imports, charts, tables, and interactive controls when helpful.",
  "",
  "Rules:",
  "  1. Output one complete HTML document only. No markdown fences or commentary.",
  "  2. Ground every claim in the supplied activity. Do not invent private details.",
  "  3. Make it useful at a glance: short sections, concrete links/domains/tasks, and next-step suggestions.",
  "  4. If there is little activity, say that plainly and still provide a clean status report.",
  "  5. Keep the visual style quiet, native-feeling, and readable in a side panel.",
].join("\n");

const reportsDir = (stellaRoot: string) =>
  path.join(stellaRoot, "state", "open-panel-reports");

const indexPath = (stellaRoot: string) => path.join(reportsDir(stellaRoot), "index.json");

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...(truncated)`;

const emptyIndex = (): ReportIndex => ({ version: 1, reports: {} });

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

export const listOpenPanelReportCadences = (): readonly CadenceConfig[] => CADENCES;

export const readOpenPanelReportIndex = async (
  stellaRoot: string,
): Promise<ReportIndex> => {
  try {
    const raw = await fs.readFile(indexPath(stellaRoot), "utf-8");
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
    return { version: 1, reports };
  } catch {
    return emptyIndex();
  }
};

const writeOpenPanelReportIndex = async (
  stellaRoot: string,
  index: ReportIndex,
): Promise<void> => {
  await fs.mkdir(reportsDir(stellaRoot), { recursive: true });
  await fs.writeFile(indexPath(stellaRoot), JSON.stringify(index, null, 2), "utf-8");
};

export const listOpenPanelReports = async (
  stellaRoot: string,
): Promise<OpenPanelReportRecord[]> => {
  const index = await readOpenPanelReportIndex(stellaRoot);
  return CADENCES.map((cadence) => index.reports[cadence.id]).filter(
    (entry): entry is OpenPanelReportRecord => Boolean(entry),
  );
};

export const markOpenPanelReportOpened = async (
  stellaRoot: string,
  cadence: OpenPanelReportCadence,
): Promise<OpenPanelReportRecord | null> => {
  const index = await readOpenPanelReportIndex(stellaRoot);
  const report = index.reports[cadence];
  if (!report) return null;
  const next = { ...report, openedAt: Date.now() };
  index.reports[cadence] = next;
  await writeOpenPanelReportIndex(stellaRoot, index);
  return next;
};

const stripFences = (text: string): string => {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
};

const normalizeHtml = (text: string, title: string): string => {
  const stripped = stripFences(text);
  if (/<html[\s>]/i.test(stripped)) return stripped;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
</head>
<body>
${stripped}
</body>
</html>
`;
};

const formatThreadSummaries = (
  summaries: ThreadSummaryRow[],
  sinceMs: number,
): string => {
  const matching = summaries
    .filter((row) => row.sourceUpdatedAt >= sinceMs)
    .slice(0, MAX_THREAD_SUMMARIES);
  if (matching.length === 0) return "(none)";
  return matching
    .map((row) => {
      const summary = truncate(row.rolloutSummary.trim(), MAX_THREAD_SUMMARY_CHARS);
      return `- [${new Date(row.sourceUpdatedAt).toISOString()}] ${summary}`;
    })
    .join("\n");
};

const formatRecentActivity = (
  store: RuntimeStore,
  sinceMs: number,
): string => {
  const events = store.listRecentActivitySince({
    sinceMs,
    limit: MAX_ACTIVITY_EVENTS,
  });
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

const formatDomainList = (
  domains: ReadonlyArray<{ domain: string; visits: number }>,
): string => domains.map((domain) => `${domain.domain} (${domain.visits})`).join("\n");

const formatBrowserWindow = (window: BrowserActivityWindow | null): string => {
  if (!window?.data.browser) return "No browser data available.";
  const sections = [`## Browser Activity (${window.data.browser}, ${window.label})`];
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
  return sections.length === 1 ? "No browser activity in this window." : sections.join("\n");
};

const buildUserPrompt = (args: {
  cadence: CadenceConfig;
  sinceMs: number;
  nowMs: number;
  summaries: ThreadSummaryRow[];
  activity: string;
  browserWindow: BrowserActivityWindow | null;
}): string => {
  const browserText = formatBrowserWindow(args.browserWindow);
  return [
    `Report cadence: ${args.cadence.label}`,
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
  stellaRoot: string,
  cadence: OpenPanelReportCadence,
): string => path.join(reportsDir(stellaRoot), `${cadence}.html`);

const generateReport = async (args: {
  stellaRoot: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  cadence: CadenceConfig;
  summaries: ThreadSummaryRow[];
  browserWindow: BrowserActivityWindow | null;
  nowMs: number;
}): Promise<OpenPanelReportRecord | null> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaRoot,
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
  const activity = formatRecentActivity(args.store, sinceMs);
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildUserPrompt({
              cadence: args.cadence,
              sinceMs,
              nowMs: args.nowMs,
              summaries: args.summaries,
              activity,
              browserWindow: args.browserWindow,
            }),
          },
        ],
        timestamp: Date.now(),
      } satisfies Message,
    ],
  };

  let responseText: string;
  try {
    if (useClaudeCode) {
      responseText = await runClaudeCodeAgentTextCompletion({
        stellaRoot: args.stellaRoot,
        agentType: AGENT_IDS.OPEN_PANEL_REPORTS,
        context,
      });
    } else {
      const response = await completeSimple(args.resolvedLlm.model, context, {
        apiKey,
      });
      responseText = readAssistantText(response);
    }
  } catch (error) {
    logger.debug("open-panel-report.completeSimple.failed", {
      cadence: args.cadence.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const filePath = outputPathForCadence(args.stellaRoot, args.cadence.id);
  const html = normalizeHtml(responseText, args.cadence.title);
  await fs.mkdir(reportsDir(args.stellaRoot), { recursive: true });
  await fs.writeFile(filePath, html, "utf-8");

  return {
    cadence: args.cadence.id,
    label: args.cadence.label,
    title: args.cadence.title,
    filePath,
    generatedAt: args.nowMs,
    windowStartAt: sinceMs,
  };
};

export const spawnOpenPanelCadenceReports = (deps: {
  stellaRoot: string;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
}): void => {
  void (async () => {
    const nowMs = Date.now();
    const index = await readOpenPanelReportIndex(deps.stellaRoot);
    const due = CADENCES.filter((cadence) => {
      if (inFlightCadences.has(cadence.id)) return false;
      const existing = index.reports[cadence.id];
      return !existing || nowMs - existing.generatedAt >= cadence.intervalMs;
    });
    if (due.length === 0) return;

    for (const cadence of due) inFlightCadences.add(cadence.id);
    try {
      const summaries = deps.store.threadSummariesStore.listRecent({
        limit: MAX_THREAD_SUMMARIES,
      });
      const browserWindows = await collectBrowserActivityWindows(
        deps.stellaRoot,
        due.map((cadence) => ({
          id: cadence.id,
          label: cadence.label,
          sinceMs: nowMs - cadence.windowMs,
        })),
      );
      const browserById = new Map(browserWindows.map((entry) => [entry.id, entry]));

      for (const cadence of due) {
        try {
          const report = await generateReport({
            ...deps,
            cadence,
            summaries,
            browserWindow: browserById.get(cadence.id) ?? null,
            nowMs,
          });
          if (!report) continue;
          const latestIndex = await readOpenPanelReportIndex(deps.stellaRoot);
          latestIndex.reports[cadence.id] = {
            ...report,
            openedAt: latestIndex.reports[cadence.id]?.openedAt,
          };
          await writeOpenPanelReportIndex(deps.stellaRoot, latestIndex);
          logger.debug("open-panel-report.generated", {
            cadence: cadence.id,
            filePath: report.filePath,
          });
        } catch (error) {
          logger.debug("open-panel-report.failed", {
            cadence: cadence.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      for (const cadence of due) inFlightCadences.delete(cadence.id);
    }
  })().catch((error) => {
    logger.debug("open-panel-reports.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
