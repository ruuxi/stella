/**
 * Drives the rolling 3-7 word progress summaries shown under each active
 * sub-agent. Mounted once at the chat-runtime level so summaries keep
 * accruing even when the activity tray is closed.
 *
 * For every running agent it fires a cheap `stella/light` completion 10s
 * after the agent appears, then every 30s after that. Each tick builds a
 * change signature from the agent's reasoning + status; if nothing has
 * changed since the last summary it skips the LLM call entirely and waits
 * for the next tick. Results land in `agent-progress-summary-store`.
 *
 * Model routing: we pin `stella/light` explicitly so non-Stella engines map
 * it to their own light tier (Claude Code -> Haiku, Codex -> mini) and Stella
 * users hit deepseek-v4-flash via the locked backend `progress_summary` agent
 * type, instead of an expensive default.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  isActivityFeedTask,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { agentProgressSummaryStore } from "@/features/chat/agent-progress-summary-store";

const FIRST_DELAY_MS = 10_000;
const INTERVAL_MS = 30_000;

const REASONING_CONTEXT_CHARS = 1200;
const SIGNATURE_TAIL_CHARS = 200;
const MAX_SUMMARY_WORDS = 7;
const MAX_SUMMARY_CHARS = 64;

const SUMMARY_SYSTEM_PROMPT = [
  "You narrate, in real time, what a background AI agent is currently doing.",
  "Given the agent's task and its latest activity, reply with ONLY a short",
  "present-continuous phrase of 3 to 7 words describing what it is doing right",
  'now (for example: "searching documentation for rate limits").',
  "No punctuation, no quotes, no trailing period, lowercase unless a proper",
  "noun. Do not repeat any of the previous phrases.",
].join(" ");

type TimerState = {
  timeout: ReturnType<typeof setTimeout> | null;
  lastSignature: string | null;
  inFlight: boolean;
};

const buildSignature = (task: TaskItem): string => {
  const reasoning = task.reasoningText ?? "";
  return [
    reasoning.length,
    reasoning.slice(-SIGNATURE_TAIL_CHARS),
    task.statusText ?? "",
    task.status,
  ].join("\u0000");
};

const sanitizeSummary = (raw: string): string => {
  let text = raw.split(/\r?\n/)[0] ?? "";
  text = text
    .replace(/^["'`*\s]+/, "")
    .replace(/["'`*.\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0) return "";
  if (words.length > MAX_SUMMARY_WORDS) {
    text = words.slice(0, MAX_SUMMARY_WORDS).join(" ");
  }
  // A well-behaved 3-7 word phrase is short; anything longer is the model
  // ignoring the format (refusal, explanation), so drop it rather than show it.
  if (text.length > MAX_SUMMARY_CHARS) return "";
  return text;
};

const buildUserText = (task: TaskItem, priorPhrases: string[]): string => {
  const reasoning = (task.reasoningText ?? "").slice(-REASONING_CONTEXT_CHARS).trim();
  const lines = [
    `Task: ${task.description?.trim() || "(background task)"}`,
    `Current activity: ${task.statusText?.trim() || "working"}`,
  ];
  if (reasoning) {
    lines.push("", "Latest reasoning:", reasoning);
  }
  lines.push(
    "",
    `Previous phrases: ${priorPhrases.length > 0 ? priorPhrases.join("; ") : "(none yet)"}`,
  );
  return lines.join("\n");
};

const requestSummary = async (
  task: TaskItem,
  priorPhrases: string[],
): Promise<string> => {
  const agentApi = window.electronAPI?.agent;
  if (!agentApi?.oneShotCompletion) return "";
  const result = await agentApi.oneShotCompletion({
    agentType: "progress_summary",
    model: "stella/light",
    // If a pure-BYOK user has no Stella access, ride their general pick.
    fallbackAgentTypes: ["general"],
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userText: buildUserText(task, priorPhrases),
    maxOutputTokens: 24,
    temperature: 0.4,
  });
  return sanitizeSummary(result?.text ?? "");
};

export function useAgentProgressSummaryEngine(
  liveTasks: ReadonlyArray<TaskItem>,
): void {
  const tasksRef = useRef<Map<string, TaskItem>>(new Map());
  const timersRef = useRef<Map<string, TimerState>>(new Map());
  const runRef = useRef<(agentId: string) => void>(() => {});
  const scheduleRef = useRef<(agentId: string, delayMs: number) => void>(
    () => {},
  );

  // Keep a by-id snapshot the timer callbacks can read at fire time.
  const taskMap = useMemo(() => {
    const map = new Map<string, TaskItem>();
    for (const task of liveTasks) map.set(task.id, task);
    return map;
  }, [liveTasks]);
  tasksRef.current = taskMap;

  scheduleRef.current = (agentId, delayMs) => {
    const state = timersRef.current.get(agentId);
    if (!state) return;
    if (state.timeout) clearTimeout(state.timeout);
    const task = tasksRef.current.get(agentId);
    if (!task || task.status !== "running") return;
    state.timeout = setTimeout(() => runRef.current(agentId), delayMs);
  };

  runRef.current = (agentId) => {
    const state = timersRef.current.get(agentId);
    if (!state) return;
    const task = tasksRef.current.get(agentId);
    if (!task || task.status !== "running") return;
    if (state.inFlight) {
      scheduleRef.current(agentId, INTERVAL_MS);
      return;
    }

    const signature = buildSignature(task);
    if (signature === state.lastSignature) {
      // Nothing new since the last summary — skip the call until next tick.
      scheduleRef.current(agentId, INTERVAL_MS);
      return;
    }

    state.inFlight = true;
    const prior = agentProgressSummaryStore
      .getSummaries(agentId)
      .map((entry) => entry.text);

    void requestSummary(task, prior)
      .then((text) => {
        state.lastSignature = signature;
        // The agent may have finished while the call was in flight; only keep
        // the summary if it's still an active, running agent. tasksRef is
        // updated synchronously every render, so this never lags behind the
        // reconcile effect that prunes stopped agents.
        const current = tasksRef.current.get(agentId);
        if (text && current?.status === "running") {
          agentProgressSummaryStore.addSummary(agentId, text);
        }
      })
      .catch(() => {
        // Swallow — a failed tick just retries on the next interval.
      })
      .finally(() => {
        state.inFlight = false;
        scheduleRef.current(agentId, INTERVAL_MS);
      });
  };

  const runningIdsKey = useMemo(
    () =>
      liveTasks
        // Belt-and-braces: only user-facing activity rows earn summary
        // ticks; internal helper agents must never burn LLM calls here
        // even if a caller passes an unfiltered task list.
        .filter(
          (task) => task.status === "running" && isActivityFeedTask(task),
        )
        .map((task) => task.id)
        .sort()
        .join("\u0000"),
    [liveTasks],
  );

  useEffect(() => {
    const running = new Set(
      runningIdsKey ? runningIdsKey.split("\u0000") : [],
    );
    // Deliberately NO store pruning here. This used to call
    // `retainOnly(running)`, which deleted an agent's summaries the moment
    // it left the running set — so a completed agent's activity row lost
    // its reasoning history right when the user wants to review the work
    // (and a `send_input` follow-up started from a blank list instead of
    // accumulating). Summaries now persist for the session; the store
    // bounds its own memory (`MAX_TRACKED_AGENTS` LRU). Only the TIMERS
    // below are torn down for non-running agents, so no summary LLM call
    // ever fires for a finished agent.
    const timers = timersRef.current;
    for (const agentId of running) {
      if (timers.has(agentId)) continue;
      timers.set(agentId, {
        timeout: null,
        lastSignature: null,
        inFlight: false,
      });
      scheduleRef.current(agentId, FIRST_DELAY_MS);
    }
    for (const [agentId, state] of timers) {
      if (running.has(agentId)) continue;
      if (state.timeout) clearTimeout(state.timeout);
      timers.delete(agentId);
    }
  }, [runningIdsKey]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const state of timers.values()) {
        if (state.timeout) clearTimeout(state.timeout);
      }
      timers.clear();
    };
  }, []);

  // Mirror the generated summaries to the electron main process so the
  // desktop→mobile sync bridge can attach them to each task's
  // `reasoningSummaries` (mobile renders the SAME phrases). This is a plain
  // snapshot push — no LLM call crosses the bridge — published on every store
  // change, deduped against the last serialized snapshot so collapse toggles
  // and back-to-back identical states don't spam IPC.
  const lastPublishedRef = useRef<string>("");
  useEffect(() => {
    const publish = () => {
      const api = window.electronAPI?.localChat;
      if (!api?.publishReasoningSummaries) return;
      const snapshot = agentProgressSummaryStore.snapshotTexts();
      const entries = agentProgressSummaryStore.snapshotEntries();
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastPublishedRef.current) return;
      lastPublishedRef.current = serialized;
      void api.publishReasoningSummaries({
        summariesByAgentId: snapshot,
        // Timestamped copies are persisted runtime-side so Recall can report
        // what a running agent was doing as of a specific moment.
        entriesByAgentId: entries,
      });
    };
    publish();
    return agentProgressSummaryStore.subscribe(publish);
  }, []);
}
