/**
 * Tool-activity trace derivation.
 *
 * Each assistant row owns the run of tool calls that fired after its text
 * (the storage layer attaches tools between two assistant messages to the
 * most recent one — see `assembleMessageWindow`). This module folds that
 * run into one collapsible summary line, Claude-Code-style:
 *
 *   "Read 3 files and searched code"   "Searched code, ran 2 commands"
 *
 * While the turn is still live the group reports a `running` step (a
 * `tool_request` with no matching `tool_result` yet) so the trace can show
 * a live label; once every step resolves it settles into the static summary
 * — that settle IS the "collapse when finalized" behavior.
 *
 * Delegation tools (`spawn_agent` / `send_input` / …) are intentionally
 * excluded: those surface through `BackgroundWorkCard`, not the trace.
 */
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  extractStepsFromEvents,
  isToolRequest,
} from "@/features/chat/lib/event-transforms";

/** Coarse tool family the summary phrasing + icon key off. */
export type ToolActivityCategory =
  | "read"
  | "edit"
  | "search"
  | "web"
  | "command"
  | "code"
  | "other";

export type ToolActivityStatus = "running" | "completed" | "error";

export type ToolActivityStep = {
  id: string;
  toolName: string;
  category: ToolActivityCategory;
  /** Friendly per-call title (filename, pattern, command snippet, …). */
  title: string;
  status: ToolActivityStatus;
};

export type ToolActivityGroup = {
  steps: ToolActivityStep[];
  /** Settled summary, e.g. "Read 3 files and searched code". */
  summary: string;
  /** Leading-icon category (the run's dominant family). */
  icon: ToolActivityCategory;
  /** A step is still in flight (request without result). */
  running: boolean;
  /** Live label for the running step, e.g. "Reading MessageRow.tsx". */
  runningLabel?: string;
};

// Delegation tools own the BackgroundWorkCard surface; keep them out of the
// inline tool trace so a turn that spawns an agent doesn't double-report it.
const DELEGATION_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
  "resume_agent",
  "search_threads",
  "run_workflow",
  "task",
]);

const categoryForTool = (toolName: string): ToolActivityCategory => {
  switch (toolName.toLowerCase()) {
    case "read":
      return "read";
    case "edit":
    case "multiedit":
    case "write":
      return "edit";
    case "grep":
    case "glob":
      return "search";
    case "web":
    case "webfetch":
    case "websearch":
      return "web";
    case "bash":
      return "command";
    case "executetypescript":
      return "code";
    default:
      return "other";
  }
};

/** Settled phrase for a category given how many of its calls ran. */
const phraseForCategory = (
  category: ToolActivityCategory,
  count: number,
  sampleToolName: string,
): string => {
  const plural = (singular: string, pluralForm: string) =>
    count === 1 ? `${singular}` : `${pluralForm}`;
  switch (category) {
    case "read":
      return plural("read a file", `read ${count} files`);
    case "edit":
      return plural("edited a file", `edited ${count} files`);
    case "search":
      return "searched code";
    case "web":
      return "searched the web";
    case "command":
      return plural("ran a command", `ran ${count} commands`);
    case "code":
      return "ran code";
    default:
      return count === 1 ? `ran ${sampleToolName}` : `ran ${sampleToolName} ×${count}`;
  }
};

/** Present-progressive label for the in-flight step. */
const gerundForCategory = (category: ToolActivityCategory): string => {
  switch (category) {
    case "read":
      return "Reading";
    case "edit":
      return "Editing";
    case "search":
      return "Searching";
    case "web":
      return "Searching the web";
    case "command":
      return "Running";
    case "code":
      return "Running code";
    default:
      return "Working";
  }
};

const capitalize = (text: string): string =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);

/**
 * Join category phrases in first-appearance order: "A", "A and B",
 * "A, B and C" — then capitalize the leading word. Mirrors the natural
 * phrasing in the reference transcript ("Read 3 files and searched code").
 */
const joinPhrases = (phrases: string[]): string => {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return capitalize(phrases[0]);
  const head = phrases.slice(0, -1).join(", ");
  const joined = `${head} and ${phrases[phrases.length - 1]}`;
  return capitalize(joined);
};

/**
 * Fold a turn's tool events into one trace group, or `undefined` when the
 * turn ran no traceable (non-delegation) tools.
 */
export function deriveToolActivity(
  events: readonly EventRecord[],
): ToolActivityGroup | undefined {
  if (events.length === 0) return undefined;

  // Index requests so we can map each derived step back to its tool name
  // (extractStepsFromEvents preserves request order and carries `tool`).
  const traceable: EventRecord[] = events.filter((event) => {
    if (isToolRequest(event)) {
      return !DELEGATION_TOOLS.has(event.payload.toolName.toLowerCase());
    }
    // Keep tool_result rows so step pairing (running → completed) works;
    // results for filtered-out delegation tools simply pair with nothing.
    return event.type === "tool_result";
  });

  const rawSteps = extractStepsFromEvents(traceable);
  if (rawSteps.length === 0) return undefined;

  const steps: ToolActivityStep[] = rawSteps.map((step) => {
    const category = categoryForTool(step.tool);
    return {
      id: step.id,
      toolName: step.tool,
      category,
      title: step.title ?? step.tool,
      status:
        step.status === "pending"
          ? "running"
          : (step.status as ToolActivityStatus),
    };
  });

  // Category tallies in first-appearance order for the summary phrasing.
  const order: ToolActivityCategory[] = [];
  const counts = new Map<ToolActivityCategory, number>();
  const sampleTool = new Map<ToolActivityCategory, string>();
  for (const step of steps) {
    if (!counts.has(step.category)) {
      order.push(step.category);
      sampleTool.set(step.category, step.toolName);
    }
    counts.set(step.category, (counts.get(step.category) ?? 0) + 1);
  }

  const summary = joinPhrases(
    order.map((category) =>
      phraseForCategory(
        category,
        counts.get(category) ?? 0,
        sampleTool.get(category) ?? category,
      ),
    ),
  );

  // Dominant category (most calls; ties keep first-appearance) drives the
  // leading icon.
  let icon: ToolActivityCategory = order[0];
  let best = -1;
  for (const category of order) {
    const count = counts.get(category) ?? 0;
    if (count > best) {
      best = count;
      icon = category;
    }
  }

  const runningStep = steps.find((step) => step.status === "running");
  const runningLabel = runningStep
    ? (() => {
        const gerund = gerundForCategory(runningStep.category);
        const title = runningStep.title.trim();
        // Avoid "Searching the web Searching the web"-style doubling when the
        // gerund already carries the object.
        if (!title || gerund.toLowerCase().endsWith(title.toLowerCase())) {
          return gerund;
        }
        return `${gerund} ${title}`;
      })()
    : undefined;

  return {
    steps,
    summary,
    icon,
    running: Boolean(runningStep),
    ...(runningLabel ? { runningLabel } : {}),
  };
}

/**
 * Shallow structural equality for the memo/stable-rows comparator. Compares
 * the running flag, summary, and each step's identity+status so a streaming
 * status flip (running → completed) re-renders, but stable re-projections
 * don't.
 */
export function toolActivityEqual(
  a: ToolActivityGroup | undefined,
  b: ToolActivityGroup | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.running !== b.running) return false;
  if (a.summary !== b.summary) return false;
  if ((a.runningLabel ?? null) !== (b.runningLabel ?? null)) return false;
  if (a.icon !== b.icon) return false;
  if (a.steps.length !== b.steps.length) return false;
  for (let i = 0; i < a.steps.length; i += 1) {
    if (a.steps[i].id !== b.steps[i].id) return false;
    if (a.steps[i].status !== b.steps[i].status) return false;
    if (a.steps[i].title !== b.steps[i].title) return false;
  }
  return true;
}
