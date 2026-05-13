import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  extractToolTitle,
  extractTasksFromEvents,
  isAssistantMessage,
  isToolRequest,
  type EventRecord,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";

/**
 * Per-active-task rolling list of normie-friendly progress phrases.
 *
 * The general agent already streams its reasoning into `task.reasoningText`,
 * but we deliberately do NOT show that raw text. Instead, every few seconds
 * we ship the latest tail of the reasoning (or, if the model emitted no
 * reasoning, the latest assistant text + tool-call titles) to a cheap
 * backend model that returns a 3-6 word description of what the agent is
 * currently doing. The chat home overview renders those phrases as a small
 * autoscrolling history under each running task.
 *
 * The store is module-scoped so the list survives ChatHomeOverview mount
 * cycles — if the user clicks away and back, the history is still there
 * for as long as the task is still on screen.
 */

type Summary = {
  id: string;
  text: string;
  createdAt: number;
};

type TaskState = {
  summaries: Summary[];
  lastSentSignal: string;
  lastSentAt: number;
  inFlight: boolean;
};

const MAX_SUMMARIES_PER_TASK = 30;
const TICK_INTERVAL_MS = 15_000;
const MIN_SIGNAL_DELTA_CHARS = 60;
const SIGNAL_TAIL_CHARS = 1_800;
const MAX_SIGNAL_CHARS = 3_000;
const MAX_SUMMARY_CHARS = 80;

const TASK_PROGRESS_SUMMARY_SYSTEM_PROMPT =
  `You watch what an AI assistant is currently working on and describe it in 3-6 plain English words a non-technical person would understand.

Rules:
- Output ONLY the phrase. No quotes, no period, no preamble.
- 3 to 6 words, present continuous when natural ("Reading the inbox", "Drafting a reply").
- Describe the current focus, not past steps. Avoid jargon (no tool names, file paths, IDs, code).
- If the input is empty or unclear, output "Working on it".`;

const cleanSummary = (raw: string): string => {
  let value = raw.trim();
  if (!value) return "";
  value = value.replace(/^(?:sure[,!.]?\s*|here(?:'s| is)\s*[:\-]?\s*)/i, "");
  value = value.replace(/^["'`*_\s]+|["'`*_\s.!?]+$/g, "");
  value = value.replace(/\s+/g, " ");
  if (value.length > MAX_SUMMARY_CHARS) {
    value = value.slice(0, MAX_SUMMARY_CHARS).trimEnd();
  }
  if (/^(i\s+(can(?:'t|not)|am unable))/i.test(value)) return "";
  return value;
};

const taskStates = new Map<string, TaskState>();
const subscribers = new Set<() => void>();

const getOrCreate = (agentId: string): TaskState => {
  let state = taskStates.get(agentId);
  if (!state) {
    state = { summaries: [], lastSentSignal: "", lastSentAt: 0, inFlight: false };
    taskStates.set(agentId, state);
  }
  return state;
};

const emit = () => {
  for (const sub of subscribers) sub();
};

const pushSummary = (agentId: string, text: string) => {
  const state = getOrCreate(agentId);
  const previous = state.summaries[state.summaries.length - 1]?.text;
  // Suppress consecutive duplicates so the list doesn't visibly stall when
  // the agent is doing the same thing across two ticks.
  if (previous && previous.toLowerCase() === text.toLowerCase()) return;
  const next: Summary = {
    id: `${agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: Date.now(),
  };
  state.summaries = [...state.summaries.slice(-(MAX_SUMMARIES_PER_TASK - 1)), next];
  emit();
};

const dropTask = (agentId: string) => {
  if (taskStates.delete(agentId)) emit();
};

const snapshot = (): Map<string, Summary[]> => {
  // Build a fresh Map keyed by agentId. useSyncExternalStore relies on
  // identity changes — we already swap the array on push, but the outer
  // Map needs its own identity each time so React sees the change.
  const out = new Map<string, Summary[]>();
  for (const [id, state] of taskStates) {
    out.set(id, state.summaries);
  }
  return out;
};

let cachedSnapshot: Map<string, Summary[]> = snapshot();
const refreshSnapshot = () => {
  cachedSnapshot = snapshot();
};
subscribers.add(refreshSnapshot);

const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

const getSnapshot = (): Map<string, Summary[]> => cachedSnapshot;

const buildFallbackSignal = (
  events: EventRecord[],
  startedAtMs: number,
): string => {
  // Walk recent events from the general agent (it's the only one we
  // summarize for). Concatenate the latest assistant text + tool titles
  // so the summarizer has something to work with even when reasoning is
  // empty (which happens for non-reasoning models).
  const collected: string[] = [];
  for (let i = events.length - 1; i >= 0 && collected.length < 8; i -= 1) {
    const event = events[i];
    if (event.timestamp < startedAtMs) break;
    if (isAssistantMessage(event)) {
      const payload = event.payload as { text?: string; agentType?: string } | undefined;
      if (payload?.agentType && payload.agentType !== AGENT_IDS.GENERAL) continue;
      const text = payload?.text?.trim();
      if (text) collected.push(text);
      continue;
    }
    if (isToolRequest(event)) {
      const payload = event.payload as { agentType?: string };
      if (payload.agentType && payload.agentType !== AGENT_IDS.GENERAL) continue;
      const title = extractToolTitle(event);
      if (title) collected.push(`Tool: ${event.payload.toolName} — ${title}`);
    }
  }
  return collected.reverse().join("\n");
};

const buildSignalForTask = (task: TaskItem, events: EventRecord[]): string => {
  const reasoning = task.reasoningText?.trim() ?? "";
  if (reasoning.length > 0) {
    return reasoning.length > SIGNAL_TAIL_CHARS
      ? reasoning.slice(-SIGNAL_TAIL_CHARS)
      : reasoning;
  }
  const fallback = buildFallbackSignal(events, task.startedAtMs);
  if (!fallback) return "";
  return fallback.length > SIGNAL_TAIL_CHARS
    ? fallback.slice(-SIGNAL_TAIL_CHARS)
    : fallback;
};

export type TaskProgressSummaries = ReadonlyMap<string, ReadonlyArray<Summary>>;

const summarizeViaRuntime = async (
  signal: string,
): Promise<string | null> => {
  const electron = window.electronAPI;
  if (!electron?.agent?.oneShotCompletion) return null;
  const trimmed = signal.trim();
  if (!trimmed) return null;
  const sliced =
    trimmed.length > MAX_SIGNAL_CHARS
      ? trimmed.slice(-MAX_SIGNAL_CHARS)
      : trimmed;
  try {
    const result = await electron.agent.oneShotCompletion({
      agentType: "task_summary",
      systemPrompt: TASK_PROGRESS_SUMMARY_SYSTEM_PROMPT,
      userText: sliced,
      // The user's Assistant-tab BYOK pick lives under `general` — fall
      // back there so task progress descriptions ride the same provider
      // as the agent that's producing the work being summarized.
      fallbackAgentTypes: ["general"],
      temperature: 0.2,
      maxOutputTokens: 64,
    });
    const summary = cleanSummary(result?.text ?? "");
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
};

export function useTaskProgressSummaries(args: {
  liveTasks: TaskItem[];
  events: EventRecord[];
}): TaskProgressSummaries {

  const eventsRef = useRef(args.events);
  eventsRef.current = args.events;

  const liveTasksRef = useRef(args.liveTasks);
  liveTasksRef.current = args.liveTasks;

  // Drop state only after a task has left both the live stream and the
  // conversation's persisted task history. Completed tasks leave the live
  // set quickly, but the overview may be opened later and should still show
  // the phrases collected while the task was running.
  const conversationAgentIds = useMemo(
    () => new Set([
      ...args.liveTasks.map((t) => t.id),
      ...extractTasksFromEvents(args.events).map((t) => t.id),
    ]),
    [args.events, args.liveTasks],
  );
  useEffect(() => {
    for (const agentId of [...taskStates.keys()]) {
      if (!conversationAgentIds.has(agentId)) {
        dropTask(agentId);
      }
    }
  }, [conversationAgentIds]);

  // Single shared interval drives summarization for every running general
  // task on this conversation. Avoids a per-task setInterval explosion.
  useEffect(() => {
    const tick = () => {
      const tasks = liveTasksRef.current;
      const events = eventsRef.current;
      const now = Date.now();
      for (const task of tasks) {
        if (task.status !== "running") continue;
        if (task.agentType !== AGENT_IDS.GENERAL) continue;
        const state = getOrCreate(task.id);
        if (state.inFlight) continue;
        if (now - state.lastSentAt < TICK_INTERVAL_MS) continue;
        const signal = buildSignalForTask(task, events);
        if (!signal) continue;
        // Only spend a request when the underlying activity has actually
        // moved on by a meaningful chunk; otherwise we'd just keep
        // re-describing the same thing.
        const delta = Math.abs(signal.length - state.lastSentSignal.length);
        const driftedTail =
          signal.slice(-200) !== state.lastSentSignal.slice(-200);
        if (state.lastSentSignal && delta < MIN_SIGNAL_DELTA_CHARS && !driftedTail) {
          continue;
        }
        state.inFlight = true;
        state.lastSentAt = now;
        state.lastSentSignal = signal;
        const agentId = task.id;
        void summarizeViaRuntime(signal)
          .then((summary) => {
            if (summary) pushSummary(agentId, summary);
          })
          .finally(() => {
            const current = taskStates.get(agentId);
            if (current) current.inFlight = false;
          });
      }
    };

    const intervalId = window.setInterval(tick, TICK_INTERVAL_MS);
    // Kick once shortly after mount so the user doesn't wait a full
    // interval for the first phrase to appear.
    const kickoffId = window.setTimeout(tick, 800);
    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(kickoffId);
    };
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
