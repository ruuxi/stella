/**
 * The rolling 3-7 word progress summaries rendered under an active agent in
 * the activity list. Newest first; the list is height-capped and scrolls.
 * New lines grow/fade in at the top and dropped (oldest) lines animate out at
 * the bottom, so the list reads as a live ticker. Generation lives in
 * `use-agent-progress-summary-engine`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAgentProgressSummaries,
  useAgentProgressSummariesCollapsed,
  type ProgressSummary,
} from "@/features/chat/agent-progress-summary-store";

const EXIT_ANIMATION_MS = 260;

export function AgentProgressSummaries({
  agentId,
  max,
}: {
  agentId: string;
  /** Cap the rendered list to the N most-recent summaries. When set, the
   *  drop-out animation is skipped so the list never exceeds the cap. */
  max?: number;
}) {
  const summaries = useAgentProgressSummaries(agentId);
  const collapsed = useAgentProgressSummariesCollapsed(agentId);

  // Briefly keep just-dropped (oldest) entries mounted so they can animate out.
  const [leaving, setLeaving] = useState<ProgressSummary[]>([]);
  const prevRef = useRef<ReadonlyArray<ProgressSummary>>(summaries);
  const removalTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = summaries;
    const currentIds = new Set(summaries.map((entry) => entry.id));
    const removed = prev.filter((entry) => !currentIds.has(entry.id));
    if (removed.length === 0) return;
    setLeaving((current) => {
      const ids = new Set(current.map((entry) => entry.id));
      return [...current, ...removed.filter((entry) => !ids.has(entry.id))];
    });
    for (const entry of removed) {
      if (removalTimersRef.current.has(entry.id)) continue;
      const timer = setTimeout(() => {
        removalTimersRef.current.delete(entry.id);
        setLeaving((current) => current.filter((item) => item.id !== entry.id));
      }, EXIT_ANIMATION_MS);
      removalTimersRef.current.set(entry.id, timer);
    }
  }, [summaries]);

  useEffect(() => () => {
    for (const timer of removalTimersRef.current.values()) clearTimeout(timer);
    removalTimersRef.current.clear();
  }, []);

  // Newest at the top so the latest status is always in view; capped to the
  // N most-recent when `max` is set.
  const ordered = useMemo(() => {
    const newestFirst = [...summaries].reverse();
    return typeof max === "number" ? newestFirst.slice(0, max) : newestFirst;
  }, [summaries, max]);

  // With a hard cap, dropping the trailing fade-out keeps the rendered count
  // from briefly exceeding the cap.
  const leavingVisible = typeof max === "number" ? [] : leaving;

  if (collapsed) return null;
  if (ordered.length === 0 && leavingVisible.length === 0) return null;

  return (
    <ul
      className="chat-workspace-strip__task-progress"
      aria-live="polite"
      aria-label="Recent progress"
    >
      {ordered.map((summary, index) => (
        <li
          key={summary.id}
          className="chat-workspace-strip__task-progress-item"
          data-newest={index === 0 ? "true" : undefined}
        >
          {summary.text}
        </li>
      ))}
      {leavingVisible.map((summary) => (
        <li
          key={summary.id}
          className="chat-workspace-strip__task-progress-item chat-workspace-strip__task-progress-item--leaving"
        >
          {summary.text}
        </li>
      ))}
    </ul>
  );
}
