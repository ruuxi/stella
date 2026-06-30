/**
 * Tool-activity trace derivation.
 *
 * Each assistant row owns the run of tool calls that fired after its text
 * (the storage layer attaches tools between two assistant messages to the
 * most recent one — see `assembleMessageWindow`). This module folds that
 * run into one collapsible summary line, Claude-Code-style:
 *
 *   "Read 3 files and searched code"   "Searched the web and ran 2 commands"
 *
 * Only *settled* calls (completed/errored) are counted, and the group is
 * `undefined` until the first one settles. So the trace appears once the
 * first tool returns and its count ticks up in place as each subsequent call
 * finishes (the still-in-flight call stays owned by the live footer
 * `WorkingIndicator`) — which is what lets the summary animate 1 → 2 → 3
 * rather than popping in already-final.
 *
 * Mapping is keyed off Stella's *actual* tool names (see
 * `runtime/kernel/tools/defs/`), not generic Claude-Code names — the common
 * dev tools aggregate by category (read / edit / search / web / command) and
 * the domain tools (memory, scheduling, messaging, media…) get their own
 * phrases. Anything unrecognized falls back to a humanized name so a new
 * tool still reads sensibly ("used fashion search products") instead of
 * being dropped.
 *
 * `running` gates the renderer: while a step is in flight the live footer
 * `WorkingIndicator` owns the display; the inline trace mounts only once the
 * run settles. Delegation tools (`spawn_agent` / `send_input` / …) and the
 * `multi_tool_use_parallel` wrapper are excluded — the former surface through
 * `BackgroundWorkCard`, the latter is fan-out plumbing, not a real call.
 */
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  isToolRequest,
  isToolResult,
} from "@/features/chat/lib/event-transforms";
import {
  AGENT_IDS,
  isOrchestratorAgentType,
} from "../../../../../runtime/contracts/agent-runtime.js";

/** Coarse tool family the leading icon + summary phrasing key off. */
export type ToolActivityCategory =
  | "read"
  | "edit"
  | "search"
  | "web"
  | "command"
  | "create"
  | "memory"
  | "schedule"
  | "message"
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
  /** Settled steps only (completed/errored), in call order. */
  steps: ToolActivityStep[];
  /** Settled summary, e.g. "Read 3 files and searched code". */
  summary: string;
  /** Leading-icon category (the run's dominant family). */
  icon: ToolActivityCategory;
};

// Owned by other surfaces / not real calls — never shown in the trace.
//   - delegation → BackgroundWorkCard
//   - multi_tool_use_parallel → fan-out wrapper; its children emit their own
//     tool_request events, so the wrapper itself would just be noise.
const EXCLUDED_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
  "resume_agent",
  "search_threads",
  "run_workflow",
  "task",
  "multi_tool_use_parallel",
]);

type PhraseFn = (count: number) => string;

const plural = (one: string, many: (n: number) => string): PhraseFn => (n) =>
  n === 1 ? one : many(n);

/**
 * Per-tool descriptor keyed by lowercased tool name. `category` drives the
 * icon; `phrase` is the settled summary clause. Tools sharing a category but
 * NOT a phrase (e.g. a future second "command" tool) still aggregate into one
 * clause via `aggregateKey` below.
 */
type ToolDescriptor = { category: ToolActivityCategory; phrase: PhraseFn };

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  // — read —
  read: { category: "read", phrase: plural("read a file", (n) => `read ${n} files`) },
  view_image: {
    category: "read",
    phrase: plural("viewed an image", (n) => `viewed ${n} images`),
  },
  // — edit —
  edit: { category: "edit", phrase: plural("edited a file", (n) => `edited ${n} files`) },
  write: { category: "edit", phrase: plural("wrote a file", (n) => `wrote ${n} files`) },
  strreplace: {
    category: "edit",
    phrase: plural("edited a file", (n) => `edited ${n} files`),
  },
  apply_patch: {
    category: "edit",
    phrase: plural("applied a patch", (n) => `applied ${n} patches`),
  },
  scriptdraft: {
    category: "edit",
    phrase: plural("drafted a script", (n) => `drafted ${n} scripts`),
  },
  // — search —
  grep: { category: "search", phrase: () => "searched code" },
  tool_search: {
    category: "search",
    phrase: plural("looked up a tool", (n) => `looked up ${n} tools`),
  },
  // — web —
  web: { category: "web", phrase: () => "searched the web" },
  import_source: {
    category: "web",
    phrase: plural("imported a source", (n) => `imported ${n} sources`),
  },
  // — command —
  exec_command: {
    category: "command",
    phrase: plural("ran a command", (n) => `ran ${n} commands`),
  },
  write_stdin: {
    category: "command",
    phrase: plural("sent input to a command", (n) => `sent input ${n} times`),
  },
  // — create / media —
  image_gen: {
    category: "create",
    phrase: plural("generated an image", (n) => `generated ${n} images`),
  },
  html: {
    category: "create",
    phrase: plural("built a page", (n) => `built ${n} pages`),
  },
  dream: {
    category: "create",
    phrase: plural("generated a vision", (n) => `generated ${n} visions`),
  },
  // — memory —
  recall: { category: "memory", phrase: () => "checked memory" },
  remember: {
    category: "memory",
    phrase: plural("saved a note", (n) => `saved ${n} notes`),
  },
  // — scheduling —
  schedule: { category: "schedule", phrase: () => "updated scheduling" },
  cronadd: { category: "schedule", phrase: () => "updated schedules" },
  cronupdate: { category: "schedule", phrase: () => "updated schedules" },
  cronremove: { category: "schedule", phrase: () => "updated schedules" },
  cronrun: { category: "schedule", phrase: () => "ran a schedule" },
  cronlist: { category: "schedule", phrase: () => "checked schedules" },
  heartbeatget: { category: "schedule", phrase: () => "checked heartbeats" },
  heartbeatrun: { category: "schedule", phrase: () => "ran a heartbeat" },
  heartbeatupsert: { category: "schedule", phrase: () => "updated heartbeats" },
  // — messaging —
  linq_send_message: {
    category: "message",
    phrase: plural("sent a message", (n) => `sent ${n} messages`),
  },
  linq_send_voice_memo: {
    category: "message",
    phrase: plural("sent a voice memo", (n) => `sent ${n} voice memos`),
  },
  linq_react_to_message: { category: "message", phrase: () => "reacted to a message" },
  linq_share_contact_card: { category: "message", phrase: () => "shared a contact" },
  // — misc known —
  request_credential: { category: "other", phrase: () => "requested access" },
  requestcredential: { category: "other", phrase: () => "requested access" },
};

/** snake_case / CamelCase → "lower spaced words" for the generic fallback. */
const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();

const descriptorFor = (toolName: string): ToolDescriptor => {
  const known = TOOL_DESCRIPTORS[toolName.toLowerCase()];
  if (known) return known;
  const human = humanizeToolName(toolName);
  return {
    category: "other",
    phrase: plural(`used ${human}`, (n) => `used ${human} ×${n}`),
  };
};

/**
 * Aggregation key for the summary. Dev categories collapse all their tools
 * into one clause (Edit + Write + StrReplace → one "edited N files"); domain
 * tools group per tool name so distinct ones stay separate but repeats tally.
 */
const DEV_CATEGORIES = new Set<ToolActivityCategory>([
  "read",
  "edit",
  "search",
  "web",
  "command",
]);

const aggregateKey = (step: ToolActivityStep): string =>
  DEV_CATEGORIES.has(step.category)
    ? `cat:${step.category}`
    : `tool:${step.toolName.toLowerCase()}`;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

const clamp = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Per-call title shown in the expanded step list. */
const titleForCall = (
  toolName: string,
  args: Record<string, unknown> | undefined,
): string => {
  const a = args ?? {};
  switch (toolName.toLowerCase()) {
    case "read":
    case "view_image": {
      const path = str(a.path) ?? str(a.file_path);
      return path ? basename(path) : "file";
    }
    case "edit":
    case "write":
    case "strreplace": {
      const path = str(a.file_path) ?? str(a.path);
      return path ? basename(path) : "file";
    }
    case "apply_patch":
      return "patch";
    case "grep":
      return str(a.pattern) ? `"${clamp(str(a.pattern)!, 32)}"` : "code";
    case "web": {
      const query = str(a.query);
      if (query) return `"${clamp(query, 40)}"`;
      const url = str(a.url);
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      }
      return "the web";
    }
    case "exec_command": {
      const cmd = str(a.cmd) ?? str(a.command);
      return cmd ? clamp(cmd, 48) : "command";
    }
    case "image_gen":
    case "dream":
      return str(a.prompt) ? clamp(str(a.prompt)!, 48) : "image";
    case "html":
      return str(a.title) ?? "page";
    case "remember":
      return str(a.title) ?? str(a.name) ?? "note";
    case "recall":
      return str(a.query) ? `"${clamp(str(a.query)!, 40)}"` : "memory";
    default:
      return humanizeToolName(toolName);
  }
};

const requestIdOf = (event: EventRecord): string | undefined => {
  if (event.requestId) return event.requestId;
  const payload = event.payload as { requestId?: string } | undefined;
  return payload?.requestId;
};

const capitalize = (text: string): string =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);

/**
 * Join clauses in first-appearance order: "A", "A and B", "A, B and C" —
 * then capitalize the leading word.
 */
const joinPhrases = (phrases: string[]): string => {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return capitalize(phrases[0]);
  const head = phrases.slice(0, -1).join(", ");
  return capitalize(`${head} and ${phrases[phrases.length - 1]}`);
};

/**
 * Fold a turn's tool events into one trace group, or `undefined` when the
 * turn ran no traceable (non-excluded) tools.
 */
export function deriveToolActivity(
  events: readonly EventRecord[],
): ToolActivityGroup | undefined {
  if (events.length === 0) return undefined;

  // Pair tool_request → tool_result by requestId, preserving request order.
  const steps: ToolActivityStep[] = [];
  const indexByRequestId = new Map<string, number>();

  for (const event of events) {
    // Scope the trace to the orchestrator's own tool calls. Tool events from
    // spawned sub-agents (the general agent and any other delegated run) carry
    // their originating `agentType` on the payload; the orchestrator's own
    // calls persist with no `agentType` (see `onToolStart`/`onToolEnd` in
    // `runtime/worker/server.ts`), so an absent value resolves to the
    // orchestrator — matching the `(agentType ?? ORCHESTRATOR)` convention
    // used across the worker. Anything else is a sub-agent and is dropped.
    const agentType =
      (event.payload as { agentType?: string } | undefined)?.agentType ??
      AGENT_IDS.ORCHESTRATOR;
    if (!isOrchestratorAgentType(agentType)) continue;
    if (isToolRequest(event)) {
      const toolName = event.payload.toolName;
      if (EXCLUDED_TOOLS.has(toolName.toLowerCase())) continue;
      const id = requestIdOf(event) ?? event._id;
      const { category } = descriptorFor(toolName);
      indexByRequestId.set(id, steps.length);
      steps.push({
        id,
        toolName,
        category,
        title: titleForCall(
          toolName,
          event.payload.args as Record<string, unknown> | undefined,
        ),
        status: "running",
      });
      continue;
    }
    if (isToolResult(event)) {
      const id = requestIdOf(event);
      if (!id) continue;
      const index = indexByRequestId.get(id);
      if (index === undefined) continue;
      const errored = Boolean((event.payload as { error?: unknown }).error);
      steps[index] = {
        ...steps[index],
        status: errored ? "error" : "completed",
      };
    }
  }

  // Count only settled calls — the in-flight one stays owned by the live
  // WorkingIndicator. This is what lets the summary appear after the first
  // result and tick up in place as each subsequent call returns.
  const settled = steps.filter((step) => step.status !== "running");
  if (settled.length === 0) return undefined;

  // Aggregate clauses by key, in first-appearance order.
  const order: string[] = [];
  const groupCount = new Map<string, number>();
  const groupSample = new Map<string, ToolActivityStep>();
  for (const step of settled) {
    const key = aggregateKey(step);
    if (!groupCount.has(key)) {
      order.push(key);
      groupSample.set(key, step);
    }
    groupCount.set(key, (groupCount.get(key) ?? 0) + 1);
  }

  const summary = joinPhrases(
    order.map((key) => {
      const sample = groupSample.get(key)!;
      return descriptorFor(sample.toolName).phrase(groupCount.get(key) ?? 0);
    }),
  );

  // Leading icon: dominant aggregation group (most calls; ties keep
  // first-appearance order).
  let iconKey = order[0];
  let best = -1;
  for (const key of order) {
    const count = groupCount.get(key) ?? 0;
    if (count > best) {
      best = count;
      iconKey = key;
    }
  }
  const icon = groupSample.get(iconKey)!.category;

  return { steps: settled, summary, icon };
}

/**
 * Shallow structural equality for the memo/stable-rows comparator. Compares
 * the summary and each settled step's identity+status so a newly-settled call
 * (count tick-up) re-renders, but stable re-projections don't.
 */
export function toolActivityEqual(
  a: ToolActivityGroup | undefined,
  b: ToolActivityGroup | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.summary !== b.summary) return false;
  if (a.icon !== b.icon) return false;
  if (a.steps.length !== b.steps.length) return false;
  for (let i = 0; i < a.steps.length; i += 1) {
    if (a.steps[i].id !== b.steps[i].id) return false;
    if (a.steps[i].status !== b.steps[i].status) return false;
    if (a.steps[i].title !== b.steps[i].title) return false;
  }
  return true;
}
