/**
 * Inline "Scheduled" receipt chip rendered on the assistant turn that
 * delegated to the orchestrator's `Schedule` tool. Shows a compact
 * summary inline; clicking opens the shared `ScheduleDetailsDialog` so
 * the user can Run now / Pause / Delete the affected entries without
 * leaving the chat surface.
 *
 * Data is pulled from the structured side-channel that the `Schedule`
 * tool now returns (see `runtime/kernel/tools/schedule.ts` →
 * `ScheduleToolDetails`). The detail dialog re-resolves each ref
 * against the live scheduler snapshot when it opens, so the chip
 * stays accurate even when the tool result was persisted minutes ago.
 */

import { useMemo, useState } from "react";
import type { ScheduleToolAffectedRef } from "../../../../runtime/kernel/shared/scheduling";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import "./schedule-receipt-chip.css";

const labelFor = (
  affected: ReadonlyArray<ScheduleToolAffectedRef>,
  nowMs: number,
): { primary: string; meta: string } => {
  if (affected.length === 1) {
    const entry = affected[0];
    return {
      primary: entry.name,
      meta: formatNextRun(entry.nextRunAtMs, nowMs),
    };
  }
  // Multi-entry chips happen when one Schedule run touched several jobs.
  // Show the count and the soonest next-run badge so the chip stays a
  // single-line summary.
  const next = affected.reduce(
    (min, entry) => Math.min(min, entry.nextRunAtMs),
    Number.POSITIVE_INFINITY,
  );
  return {
    primary: `${affected.length} schedules`,
    meta: Number.isFinite(next) ? `next ${formatNextRun(next, nowMs)}` : "",
  };
};

export function ScheduleReceiptChip({
  affected,
  summary,
}: {
  affected: ReadonlyArray<ScheduleToolAffectedRef>;
  summary?: string;
}) {
  const [open, setOpen] = useState(false);
  // Computed once on mount + on `open` toggles only — no ticker. The chip
  // is a static receipt; the live next-run countdown lives in the dialog.
  const nowMs = useMemo(() => Date.now(), [open]);
  const { primary, meta } = useMemo(
    () => labelFor(affected, nowMs),
    [affected, nowMs],
  );

  if (affected.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="schedule-receipt-chip"
        onClick={() => setOpen(true)}
      >
        <span className="schedule-receipt-chip__icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M12 7v5l3 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="schedule-receipt-chip__primary">{primary}</span>
        {meta && <span className="schedule-receipt-chip__meta">{meta}</span>}
      </button>
      <ScheduleDetailsDialog
        open={open}
        onOpenChange={setOpen}
        affected={affected}
        summary={summary}
      />
    </>
  );
}
