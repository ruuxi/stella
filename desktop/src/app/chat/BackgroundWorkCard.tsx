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
 * Presence/identity and the captured descriptions come from the spawning
 * turn's tool events (`useEventRows`).
 */
import { Send } from "@/ui/icons";
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
  label?: string;
}) {
  if (threadIds.length === 0) return null;

  const resolved = resolveDescriptions(threadIds, descriptions ?? {});
  const multi = threadIds.length > 1;

  // Several threads in one turn collapse to a plain count instead of cycling
  // through descriptions — a single task shows its own description.
  const title = multi
    ? label?.trim() || resolved[0] || `${threadIds.length} tasks`
    : resolved[0] || label?.trim() || "Background work";

  return (
    <div className="background-work-card" data-state="started">
      <span className="background-work-card__glyph" aria-hidden="true">
        <Send size={16} strokeWidth={1.75} />
      </span>
      <span className="background-work-card__text">
        <span className="background-work-card__title">{title}</span>
        <span className="background-work-card__subtitle">
          Started in background
        </span>
      </span>
    </div>
  );
}
