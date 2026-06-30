/**
 * Inline "background work" card — a static receipt.
 *
 * Marks, in the chat flow itself, the spot where Stella kicked something
 * off in the background. It is a frozen breadcrumb: it records "this task
 * was triggered here" at spawn time and never mutates afterwards.
 *
 * Live status and the finished state are surfaced separately (the bottom
 * "task in progress" pill and the dedicated finished card), so this inline
 * card deliberately stays put as a historical anchor — no shimmer, and no
 * flip to a finished state. Several pieces of work started in the same turn
 * collapse into this one card (it just tallies them as a count) rather than
 * stacking a card per thread.
 *
 * Two variants share the same surface:
 *   - spawn ("started X" — `spawn_agent` kicked off new background work)
 *   - follow-up ("update sent to X" — `send_input` advanced an already-
 *     spawned thread). A follow-up reuses the thread's original description,
 *     so the runtime carries the follow-up's own message on `statusText`;
 *     the card surfaces THAT (not the stale spawn description) and reads as a
 *     distinct update breadcrumb. See `getBackgroundWork`.
 *
 * Presence/identity and the captured descriptions come from the spawning
 * turn's tool events (`useEventRows`).
 */
import { MessageSquarePlus, Send } from "@/ui/icons";
import "./background-work-card.css";

/** Per-thread descriptions in spawn order, from the reload-safe
 *  descriptions captured on the spawning row at spawn time. */
function resolveDescriptions(
  threadIds: string[],
  descriptions: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const id of threadIds) {
    const captured = descriptions[id];
    if (captured) out.push(captured);
  }
  return out;
}

export function BackgroundWorkCard({
  threadIds,
  descriptions,
  statusTexts,
  followUpThreadIds,
  label,
}: {
  threadIds: string[];
  // Live-status inputs are accepted for call-site compatibility but
  // intentionally unused: this card is a static "started here" receipt
  // and never reflects completion/cancellation.
  completedThreadIds?: string[];
  supersededThreadIds?: string[];
  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;
  /** Per-thread follow-up text for `send_input` re-activations. */
  statusTexts?: Record<string, string>;
  /** Threads on this card that are `send_input` follow-ups, not fresh spawns. */
  followUpThreadIds?: string[];
  label?: string;
}) {
  if (threadIds.length === 0) return null;

  const resolved = resolveDescriptions(threadIds, descriptions ?? {});
  const multi = threadIds.length > 1;

  // A single-thread card whose one thread was re-activated via `send_input`
  // renders as a follow-up: its own message (the spawn description is stale
  // for an update). Multi-thread cards stay a plain spawn tally — that
  // collapse is about volume, not the spawn/update distinction.
  const followUpId =
    !multi && followUpThreadIds?.includes(threadIds[0])
      ? threadIds[0]
      : undefined;
  const isFollowUp = followUpId !== undefined;

  // Several threads in one turn collapse to a plain count instead of cycling
  // through descriptions — a single task shows its own description.
  const title = isFollowUp
    ? statusTexts?.[followUpId] || resolved[0] || label?.trim() || "Follow-up"
    : multi
      ? label?.trim() || resolved[0] || `${threadIds.length} tasks`
      : resolved[0] || label?.trim() || "Background work";

  return (
    <div
      className="background-work-card"
      data-state={isFollowUp ? "follow-up" : "started"}
    >
      <span className="background-work-card__glyph" aria-hidden="true">
        {isFollowUp ? (
          <MessageSquarePlus size={16} strokeWidth={1.75} />
        ) : (
          <Send size={16} strokeWidth={1.75} />
        )}
      </span>
      <span className="background-work-card__text">
        <span className="background-work-card__title">{title}</span>
        <span className="background-work-card__subtitle">
          {isFollowUp ? "Follow-up sent" : "Started in background"}
        </span>
      </span>
    </div>
  );
}
