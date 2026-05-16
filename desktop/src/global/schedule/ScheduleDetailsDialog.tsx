/**
 * Shared dialog reused by:
 *
 *   - The inline "Scheduled" receipt chip that lands on an assistant turn
 *     after the orchestrator's `Schedule` tool returns. The chip carries
 *     the structured `ScheduleToolDetails` straight from the tool result
 *     (see `runtime/kernel/tools/schedule.ts`).
 *   - The "Up next" rows in `ChatHomeOverview`. Those rows pass a single
 *     live `ScheduleEntry` (already enriched with `nextRunAtMs`) so the
 *     dialog reads as the same thing whether you opened it from the
 *     receipt chip or from the sidebar.
 *
 * The dialog is purely a manage surface: per-row Run now / Pause / Resume /
 * Delete pills wired to the renderer's `electronAPI.schedule` mutation
 * IPC. No edit affordance — the schedule subagent is the canonical edit
 * path; an "Edit" button would just nudge the user back to the composer
 * and is intentionally omitted to keep the dialog focused on the
 * "did-it / undo / pause" flow people actually want immediately after a
 * schedule lands.
 */

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduleToolAffectedRef,
} from "../../../../runtime/kernel/shared/scheduling";
import { formatNextRun, summarizeSchedule } from "./format-schedule";
import "./schedule-details-dialog.css";

const NEXT_RUN_TICK_MS = 30_000;

/**
 * Generic "row" the dialog renders. Either a fresh affected ref straight
 * from the tool result, or a synthesized record we resolved live from
 * `scheduleApi.listCronJobs / listHeartbeats`.
 */
type DialogRow = {
  kind: "cron" | "heartbeat";
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs: number;
  /** Recurrence summary line (e.g. "Daily 9:00", "Every 30 min"). */
  recurrence: string;
  /** Conversation that owns the heartbeat (heartbeats only). */
  conversationId?: string;
};

const cronToRow = (record: LocalCronJobRecord): DialogRow => ({
  kind: "cron",
  id: record.id,
  name: record.name?.trim() || "Scheduled task",
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
  recurrence: summarizeSchedule(record.schedule),
  conversationId: record.conversationId,
});

const heartbeatToRow = (record: LocalHeartbeatConfigRecord): DialogRow => ({
  kind: "heartbeat",
  id: record.id,
  name: (() => {
    const prompt = record.prompt?.trim();
    if (!prompt) return "Check-in";
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  })(),
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
  recurrence: summarizeSchedule(null, record.intervalMs),
  conversationId: record.conversationId,
});

/**
 * Resolve the dialog rows live from `scheduleApi`. `affectedRefs` is the
 * authoritative list of "what's in this dialog" — we look each ref up in
 * the live cron/heartbeat snapshot so we always render current state
 * (e.g. a paused entry shows as paused even if the receipt chip was
 * created when it was enabled).
 */
function useResolvedRows(
  affectedRefs: ReadonlyArray<ScheduleToolAffectedRef>,
  open: boolean,
): { rows: DialogRow[]; refreshTick: number; bumpRefresh: () => void } {
  const [rows, setRows] = useState<DialogRow[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!open || affectedRefs.length === 0 || !window.electronAPI?.schedule) {
      setRows([]);
      return;
    }
    const api = window.electronAPI.schedule;
    let cancelled = false;
    const run = async () => {
      try {
        const [crons, heartbeats] = await Promise.all([
          api.listCronJobs(),
          api.listHeartbeats(),
        ]);
        if (cancelled) return;
        const cronById = new Map(crons.map((cron) => [cron.id, cron]));
        const heartbeatById = new Map(
          heartbeats.map((heartbeat) => [heartbeat.id, heartbeat]),
        );
        const next: DialogRow[] = [];
        for (const ref of affectedRefs) {
          if (ref.kind === "cron") {
            const found = cronById.get(ref.id);
            if (found) next.push(cronToRow(found));
            continue;
          }
          const found = heartbeatById.get(ref.id);
          if (found) next.push(heartbeatToRow(found));
        }
        setRows(next);
      } catch {
        if (cancelled) return;
        setRows([]);
      }
    };
    void run();
    const unsubscribe = api.onUpdated(() => {
      void run();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, affectedRefs, refreshTick]);

  const bumpRefresh = () => setRefreshTick((tick) => tick + 1);
  return { rows, refreshTick, bumpRefresh };
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), NEXT_RUN_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

type RowActionsState = {
  busy: "none" | "run" | "pause" | "resume" | "delete";
  error?: string;
};

const initialActionState: RowActionsState = { busy: "none" };

function ScheduleDialogRow({
  row,
  nowMs,
  onMutation,
}: {
  row: DialogRow;
  nowMs: number;
  onMutation: () => void;
}) {
  const [state, setState] = useState<RowActionsState>(initialActionState);
  const api = window.electronAPI?.schedule;

  const callMutation = async (
    busy: RowActionsState["busy"],
    fn: () => Promise<unknown>,
  ) => {
    if (!api) return;
    setState({ busy });
    try {
      await fn();
      setState(initialActionState);
      onMutation();
    } catch (error) {
      setState({
        busy: "none",
        error: error instanceof Error ? error.message : "Action failed.",
      });
    }
  };

  const onRunNow = () => {
    if (!api) return;
    void callMutation("run", () =>
      row.kind === "cron"
        ? api.runCronJob({ jobId: row.id })
        : row.conversationId
          ? api.runHeartbeat({ conversationId: row.conversationId })
          : Promise.resolve(),
    );
  };

  const onTogglePause = () => {
    if (!api) return;
    const next = !row.enabled;
    const busy: RowActionsState["busy"] = next ? "resume" : "pause";
    void callMutation(busy, () =>
      row.kind === "cron"
        ? api.updateCronJob({ jobId: row.id, patch: { enabled: next } })
        : row.conversationId
          ? api.upsertHeartbeat({
              conversationId: row.conversationId,
              enabled: next,
            })
          : Promise.resolve(),
    );
  };

  const onDelete = () => {
    if (!api) return;
    if (row.kind === "cron") {
      void callMutation("delete", () => api.removeCronJob({ jobId: row.id }));
    } else if (row.conversationId) {
      // Heartbeats can't be deleted outright — disabling is the closest
      // affordance (`upsertHeartbeat({ enabled: false })`). We frame the
      // action as Delete in the UI for parity with crons; the user can
      // re-enable from the same dialog later.
      void callMutation("delete", () =>
        api.upsertHeartbeat({
          conversationId: row.conversationId!,
          enabled: false,
        }),
      );
    }
  };

  const badge = row.enabled
    ? formatNextRun(row.nextRunAtMs, nowMs)
    : "Paused";

  return (
    <li className="schedule-details-dialog__row" data-enabled={row.enabled}>
      <div className="schedule-details-dialog__row-main">
        <span className="schedule-details-dialog__row-name">{row.name}</span>
        <span className="schedule-details-dialog__row-meta">
          {row.recurrence ? (
            <>
              <span>{row.recurrence}</span>
              <span className="schedule-details-dialog__row-meta-sep">·</span>
            </>
          ) : null}
          <span>{badge}</span>
        </span>
      </div>
      <div className="schedule-details-dialog__row-actions">
        <Button
          type="button"
          className="pill-btn"
          disabled={state.busy !== "none" || !row.enabled}
          onClick={onRunNow}
        >
          {state.busy === "run" ? "Running…" : "Run now"}
        </Button>
        <Button
          type="button"
          className="pill-btn"
          disabled={state.busy !== "none"}
          onClick={onTogglePause}
        >
          {state.busy === "pause"
            ? "Pausing…"
            : state.busy === "resume"
              ? "Resuming…"
              : row.enabled
                ? "Pause"
                : "Resume"}
        </Button>
        <Button
          type="button"
          className="pill-btn pill-btn--danger"
          disabled={state.busy !== "none"}
          onClick={onDelete}
        >
          {state.busy === "delete" ? "Removing…" : "Delete"}
        </Button>
      </div>
      {state.error && (
        <p className="schedule-details-dialog__row-error" role="alert">
          {state.error}
        </p>
      )}
    </li>
  );
}

export type ScheduleDetailsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refs to render. Order is preserved. */
  affected: ReadonlyArray<ScheduleToolAffectedRef>;
  /** Optional one-line summary shown above the row list. */
  summary?: string;
};

export function ScheduleDetailsDialog({
  open,
  onOpenChange,
  affected,
  summary,
}: ScheduleDetailsDialogProps) {
  const { rows, bumpRefresh } = useResolvedRows(affected, open);
  const nowMs = useNowTick(open && rows.length > 0);

  const title = useMemo(() => {
    if (rows.length === 0) return "Schedule";
    if (rows.length === 1) return rows[0].name;
    return `${rows.length} schedules`;
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="md" fit className="schedule-details-dialog">
        <Dialog.Header>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Header>
        {summary && (
          <Dialog.Description>{summary}</Dialog.Description>
        )}
        <Dialog.Body>
          {rows.length === 0 ? (
            <p className="schedule-details-dialog__empty">
              This schedule no longer exists.
            </p>
          ) : (
            <ul className="schedule-details-dialog__rows">
              {rows.map((row) => (
                <ScheduleDialogRow
                  key={`${row.kind}:${row.id}`}
                  row={row}
                  nowMs={nowMs}
                  onMutation={bumpRefresh}
                />
              ))}
            </ul>
          )}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
