/**
 * Read-only Recall latency baseline against the user's existing Stella data.
 *
 * This intentionally bypasses the live desktop process. SQLite is opened
 * read-only with PRAGMA query_only, memory files are only read, and the active
 * utility engine/model route is resolved exactly as the runner resolves it.
 * Returned briefs are secret-redacted and included in BASELINE_RESULT so
 * correctness and fast-path classifications remain independently auditable.
 *
 * Run from the repo root (Bun does not expose node:sqlite):
 *   node node_modules/esbuild/bin/esbuild runtime/scripts/benchmark-recall-latency.ts --bundle --platform=node --format=esm --banner:js="import { createRequire as __stellaCreateRequire } from 'node:module'; const require = __stellaCreateRequire(import.meta.url);" --outfile=/tmp/stella-recall-latency.mjs
 *   node /tmp/stella-recall-latency.mjs [--limit N]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { AGENT_IDS } from "../contracts/agent-runtime.js";
import {
  routeRecallIntent,
  runRecall,
} from "../kernel/agent-runtime/context-lookup.js";
import {
  RECALL_CLAUDE_CODE_MODEL,
  type RecallModelRoute,
} from "../kernel/agent-runtime/recall-route.js";
import type {
  RecallTelemetryRecord,
  RecallTelemetrySourceTiming,
} from "../kernel/agent-runtime/recall-telemetry.js";
import { LOCAL_CONTEXT_EVENT_TYPES } from "../kernel/runner/shared.js";
import { resolveRunnerRecallLlmRoute } from "../kernel/runner/model-selection.js";
import type { RunnerContext } from "../kernel/runner/types.js";
import { SessionStore } from "../kernel/storage/session-store.js";
import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "../kernel/storage/recall-read-queries.js";
import type { LocalContextEvent } from "../kernel/local-history.js";
import { redactBenchmarkBrief } from "./recall-benchmark-redaction.js";

const REPO_ROOT = process.cwd();
const readArg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const DATA_DIR = path.resolve(
  readArg("--data-dir") ?? path.join(os.homedir(), ".stella"),
);
const DB_PATH = path.join(DATA_DIR, "stella.sqlite");
const ROUTE_MODE =
  readArg("--route") ??
  ("active" as "active" | "pinned-claude-haiku" | "pinned-claude-fable");
process.env.STELLA_RECALL_TRACE_VERBOSE = "0";

const QUERIES = [
  {
    id: "memory_system",
    prompt:
      "What did we determine about profile.md, memory_summary.md, MEMORY.md, and the sources Recall searches?",
    terms: ["profile.md", "memory_summary.md", "MEMORY.md", "Recall"],
  },
  {
    id: "carplay_thread",
    prompt:
      "Find the prior agent thread for the CarPlay blank-screen connect replay race and summarize its result with the resumable thread id.",
    terms: ["CarPlay", "blank-screen", "connect replay", "race"],
  },
  {
    id: "browser_cleanup_race",
    prompt:
      "What was found about browser tab reuse and stale cleanup acting on a newer kernel?",
    terms: ["browser", "tab reuse", "stale cleanup", "kernel"],
  },
  {
    id: "utility_model_policy",
    prompt:
      "What prior decision did we make about low reasoning for Recall, Chronicle, and progress summaries?",
    terms: ["Recall", "Chronicle", "progress summaries", "low reasoning"],
  },
  {
    id: "release_workflow",
    prompt:
      "What are the established repo-scope and verification rules for Stella release sweeps?",
    terms: ["release sweep", "repo scope", "verification", "Stella"],
  },
  {
    id: "prompt_contract",
    prompt:
      "What are the prior orchestrator prompt rules for Recall versus send_input and milestone status?",
    terms: ["orchestrator prompt", "Recall", "send_input", "milestone"],
  },
  {
    id: "radial_ui_decision",
    prompt:
      "What was the prior product decision about the radial dial versus a native context menu?",
    terms: ["radial dial", "native context menu", "product decision"],
  },
  {
    id: "episodic_drive",
    prompt:
      "When was Rahul's first destination drive in the blue Lotus Emira, and where did he actually go?",
    terms: ["blue Lotus Emira", "first destination drive", "actually go"],
  },
  {
    id: "billing_case",
    prompt:
      "What happened with the anomalous Vercel AI Gateway credit charges, and how was the dispute sent?",
    terms: ["Vercel AI Gateway", "credit charges", "dispute"],
  },
  {
    id: "no_match",
    prompt:
      "Find the decision where Project Zephyr approved an aquarium telemetry migration from Cassandra to CockroachDB.",
    terms: ["Project Zephyr", "aquarium telemetry", "Cassandra", "CockroachDB"],
  },
] as const;

const parseLimit = (): number => {
  const index = process.argv.indexOf("--limit");
  if (index === -1) return QUERIES.length;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return Math.min(parsed, QUERIES.length);
};

const snapshotHash = (dataDir: string): string => {
  const hash = createHash("sha256");
  const roots = [
    "preferences.json",
    "stella.sqlite",
    "memories",
    path.join("memories_extensions", "chronicle"),
  ];
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(dataDir, relativePath);
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      try {
        hash.update(relativePath);
        hash.update(readFileSync(absolutePath));
      } catch {
        // Missing optional snapshot inputs are represented by their absence.
      }
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        hash.update(child);
        hash.update(readFileSync(path.join(dataDir, child)));
      }
    }
  };
  for (const root of roots) visit(root);
  return hash.digest("hex");
};

const resolveBenchmarkRoute = async (): Promise<RecallModelRoute> => {
  if (ROUTE_MODE === "pinned-claude-haiku") {
    return {
      activeEngine: "claude_code_local",
      executionEngine: "claude-code",
      modelId: `claude-code/${RECALL_CLAUDE_CODE_MODEL}`,
      claudeCodeModel: RECALL_CLAUDE_CODE_MODEL,
    };
  }
  if (ROUTE_MODE === "pinned-claude-fable") {
    return {
      activeEngine: "claude_code_local",
      executionEngine: "claude-code",
      modelId: "claude-code/fable",
      claudeCodeModel: "fable",
    };
  }
  if (ROUTE_MODE !== "active") {
    throw new Error(`Unsupported --route value: ${ROUTE_MODE}`);
  }
  return await resolveRunnerRecallLlmRoute(
    runnerContext,
    AGENT_IDS.ORCHESTRATOR,
  );
};

const defaultConversationId = (db: DatabaseSync): string => {
  const configured = db
    .prepare("SELECT value FROM settings WHERE key = 'default_conversation_id'")
    .get() as { value?: string } | undefined;
  if (configured?.value?.trim()) return configured.value.trim();
  const fallback = db
    .prepare("SELECT id FROM session ORDER BY updated_at DESC LIMIT 1")
    .get() as { id?: string } | undefined;
  if (!fallback?.id) throw new Error("No conversation exists in the database");
  return fallback.id;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
};

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return ordered[index] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 1_000) / 1_000;

const summarizeSources = (
  records: RecallTelemetryRecord[],
): Record<
  string,
  {
    medianMs: number;
    p90Ms: number;
    medianCalls: number;
    medianChars: number;
  }
> => {
  const names = new Set(
    records.flatMap((record) => Object.keys(record.sourceTimings)),
  );
  return Object.fromEntries(
    [...names].sort().map((name) => {
      const timings = records.map(
        (record) =>
          record.sourceTimings[name] ??
          ({
            kind: "sql",
            calls: 0,
            ms: 0,
            chars: 0,
          } satisfies RecallTelemetrySourceTiming),
      );
      return [
        name,
        {
          medianMs: rounded(median(timings.map((timing) => timing.ms))),
          p90Ms: rounded(
            percentile(
              timings.map((timing) => timing.ms),
              0.9,
            ),
          ),
          medianCalls: rounded(median(timings.map((timing) => timing.calls))),
          medianChars: rounded(median(timings.map((timing) => timing.chars))),
        },
      ];
    }),
  );
};

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec("PRAGMA query_only = ON;");
const store = new SessionStore(db as never);
const conversationId = defaultConversationId(db);
const runnerContext = {
  deviceId: "recall-latency-baseline",
  stellaAppDir: REPO_ROOT,
  stellaDataDir: DATA_DIR,
  state: {
    convexSiteUrl: "https://cloud.stella.sh",
    authToken: "benchmark-route-only",
    hasConnectedAccount: true,
    modelCatalogUpdatedAt: null,
  },
} as unknown as RunnerContext;

const results: Array<{
  queryId: string;
  telemetry?: RecallTelemetryRecord;
  resultMetadata?: {
    intent: string;
    fastPath: boolean;
    sources: unknown[];
  };
  brief?: string;
  error?: string;
}> = [];

try {
  for (const query of QUERIES.slice(0, parseLimit())) {
    const startedAtMs = performance.now();
    const routeStartedAt = performance.now();
    const recallRoute = await resolveBenchmarkRoute();
    const routeMs = performance.now() - routeStartedAt;

    const hostStartedAt = performance.now();
    const intent = routeRecallIntent(query.prompt);
    const needsHostContext = intent === "live_context";
    const localEventsStartedAt = performance.now();
    const localEvents = needsHostContext
      ? (store.listEvents(conversationId, 5) as LocalContextEvent[]).filter(
          (event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type),
        )
      : [];
    const localEventsMs = performance.now() - localEventsStartedAt;
    const hostContextMs = performance.now() - hostStartedAt;

    let telemetry: RecallTelemetryRecord | undefined;
    let resultMetadata:
      | { intent: string; fastPath: boolean; sources: unknown[] }
      | undefined;
    try {
      const brief = await runRecall({
        conversationId,
        lookupPrompt: query.prompt,
        memorySearchTerms: query.terms,
        stellaAppDir: REPO_ROOT,
        stellaDataDir: DATA_DIR,
        store,
        localEvents,
        recallRoute,
        recallReadQueries: {
          getFtsHealth: () => readRecallFtsHealth(db as never),
          listTranscriptNeighborsBatch: (targets, options) =>
            listTranscriptNeighborsBatch(db as never, targets, options),
        },
        telemetry: {
          startedAtMs,
          routeMs,
          hostContextMs,
          sourceTimings: {
            "host.localEvents": {
              kind: "sql",
              calls: needsHostContext ? 1 : 0,
              ms: localEventsMs,
              chars: 0,
            },
            "host.appBrowserContext": {
              kind: "host",
              calls: 0,
              ms: 0,
              chars: 0,
            },
          },
        },
        onTelemetry: (record) => {
          telemetry = record;
        },
        onResultMetadata: (metadata) => {
          resultMetadata = metadata;
        },
        signal: AbortSignal.timeout(180_000),
      });
      results.push({
        queryId: query.id,
        telemetry,
        resultMetadata,
        brief: redactBenchmarkBrief(brief),
      });
      process.stdout.write(
        `${query.id}: ${telemetry ? `${(telemetry.totalMs / 1_000).toFixed(1)}s ${telemetry.modelId} calls=${telemetry.modelCalls} rounds=${telemetry.toolRounds}` : "missing telemetry"}\n`,
      );
    } catch (error) {
      results.push({
        queryId: query.id,
        ...(telemetry ? { telemetry } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      process.stdout.write(`${query.id}: ERROR\n`);
    }
  }
} finally {
  db.close();
}

const completed = results.flatMap((result) =>
  result.telemetry ? [result.telemetry] : [],
);
const values = (field: keyof RecallTelemetryRecord): number[] =>
  completed.flatMap((record) =>
    typeof record[field] === "number" ? [record[field] as number] : [],
  );
const countValues = (field: "modelCalls" | "toolRounds"): number[] =>
  completed.map((record) => record[field]);

const summary = {
  schemaVersion: 2,
  methodology: {
    routeMode: ROUTE_MODE,
    directRun: true,
    browserContext: false,
    queryOrder: QUERIES.slice(0, parseLimit()).map((query) => query.id),
  },
  snapshot: {
    dataDir: DATA_DIR,
    sha256: snapshotHash(DATA_DIR),
  },
  sampleCount: results.length,
  completedCount: completed.length,
  errorCount: results.filter((result) => result.error).length,
  engineModels: [
    ...new Set(completed.map((record) => `${record.engine}:${record.modelId}`)),
  ],
  totalMs: {
    median: rounded(median(values("totalMs"))),
    p90: rounded(percentile(values("totalMs"), 0.9)),
    min: rounded(Math.min(...values("totalMs"))),
    max: rounded(Math.max(...values("totalMs"))),
  },
  phaseMedianMs: {
    routeMs: rounded(median(values("routeMs"))),
    hostContextMs: rounded(median(values("hostContextMs"))),
    seedSearchMs: rounded(median(values("seedSearchMs"))),
    assemblyMs: rounded(median(values("assemblyMs"))),
    modelMs: rounded(median(values("modelMs"))),
  },
  phaseP90Ms: {
    routeMs: rounded(percentile(values("routeMs"), 0.9)),
    hostContextMs: rounded(percentile(values("hostContextMs"), 0.9)),
    seedSearchMs: rounded(percentile(values("seedSearchMs"), 0.9)),
    assemblyMs: rounded(percentile(values("assemblyMs"), 0.9)),
    modelMs: rounded(percentile(values("modelMs"), 0.9)),
  },
  seedChars: {
    median: rounded(median(values("seedChars"))),
    p90: rounded(percentile(values("seedChars"), 0.9)),
    min: rounded(Math.min(...values("seedChars"))),
    max: rounded(Math.max(...values("seedChars"))),
  },
  modelCalls: {
    median: rounded(median(countValues("modelCalls"))),
    p90: rounded(percentile(countValues("modelCalls"), 0.9)),
    max: Math.max(...countValues("modelCalls")),
  },
  toolRounds: {
    median: rounded(median(countValues("toolRounds"))),
    p90: rounded(percentile(countValues("toolRounds"), 0.9)),
    max: Math.max(...countValues("toolRounds")),
  },
  sourceTimings: summarizeSources(completed),
  runs: results.map((result, index) => ({
    query: QUERIES[index],
    ...(result.telemetry ? { telemetry: result.telemetry } : {}),
    ...(result.resultMetadata ? { resultMetadata: result.resultMetadata } : {}),
    ...(result.brief !== undefined ? { brief: result.brief } : {}),
    ...(result.error ? { error: result.error } : {}),
  })),
};

process.stdout.write(`BASELINE_RESULT ${JSON.stringify(summary)}\n`);
