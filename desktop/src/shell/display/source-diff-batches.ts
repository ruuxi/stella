/**
 * Ring-buffer store backing the singleton "Code changes" tab.
 *
 * Each batch corresponds to one assistant turn's set of developer file
 * changes. The store keeps the most recent N batches (capped via
 * `MAX_BATCHES`) and exposes a `useSourceDiffBatches()` hook for the
 * tab content + a side-effecting `pushAndOpenSourceDiffBatch()` helper
 * for chat-side click handlers.
 *
 * Mounted as a module-scoped singleton (not React context) because
 * batches are pushed from `EndResourceCard` / inline link click
 * handlers, the Settings preview demo button, and could later be
 * pushed by the runtime IPC — all of which sit outside the tab
 * content's React tree.
 */

import { useSyncExternalStore } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { displayTabs } from "./tab-store";

export type SourceDiffBatch = {
  /**
   * Stable id for the batch. The chat surface uses the assistant
   * row's stable key (so re-renders of the same turn replace the
   * existing batch in place instead of stacking duplicates).
   */
  id: string;
  /**
   * Display label for the sticky footer chip. Falls back to "N
   * files" when omitted.
   */
  label?: string;
  /**
   * Wall-clock time the batch was produced. Drives the relative-time
   * suffix on the footer chip ("just now" / "2m" / "1h"). The store
   * also re-renders periodically to keep this fresh.
   */
  createdAt: number;
  /**
   * Source-diff payloads for the batch, in edit order. Each payload
   * is rendered as one file section inside the tab.
   */
  payloads: DisplayPayload[];
};

const MAX_BATCHES = 3;

export const SOURCE_DIFF_TAB_ID = "source-diff";

type Snapshot = {
  batches: ReadonlyArray<SourceDiffBatch>;
  activeBatchId: string | null;
};

const EMPTY: Snapshot = { batches: [], activeBatchId: null };

let state: Snapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Snapshot) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): Snapshot => state;

export const useSourceDiffBatches = (): Snapshot =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

/**
 * Read the current store snapshot. Exported for tests and for any
 * non-React caller that needs a one-shot view of the ring (e.g.
 * tooling that wants to introspect last-batch state).
 */
export const peekSourceDiffBatches = (): Snapshot => state;

export const sourceDiffBatches = {
  /**
   * Push a batch into the ring. Replaces an existing batch with the
   * same id in place (preserves footer ordering when the same turn
   * re-fires) and leaves `activeBatchId` untouched in that case so
   * the user isn't yanked off a chip they were reading. Newly added
   * batches become active.
   */
  push(batch: SourceDiffBatch): void {
    if (batch.payloads.length === 0) return;
    const existing = state.batches.findIndex((entry) => entry.id === batch.id);
    if (existing >= 0) {
      const nextBatches = state.batches.slice();
      nextBatches[existing] = batch;
      emit({ batches: nextBatches, activeBatchId: state.activeBatchId });
      return;
    }
    const nextBatches = [batch, ...state.batches].slice(0, MAX_BATCHES);
    emit({ batches: nextBatches, activeBatchId: batch.id });
  },
  /**
   * Push a batch and activate it. Use this from explicit user
   * interactions (clicking a turn's inline link / summary card) so
   * the panel jumps to the just-clicked turn even when its batch was
   * already in the ring.
   */
  pushAndActivate(batch: SourceDiffBatch): void {
    if (batch.payloads.length === 0) return;
    const existing = state.batches.findIndex((entry) => entry.id === batch.id);
    if (existing >= 0) {
      const nextBatches = state.batches.slice();
      nextBatches[existing] = batch;
      emit({ batches: nextBatches, activeBatchId: batch.id });
      return;
    }
    const nextBatches = [batch, ...state.batches].slice(0, MAX_BATCHES);
    emit({ batches: nextBatches, activeBatchId: batch.id });
  },
  /**
   * Activate an already-present batch (used by sticky footer chips).
   * No-op if the id isn't in the ring.
   */
  select(batchId: string): void {
    if (state.activeBatchId === batchId) return;
    if (!state.batches.some((entry) => entry.id === batchId)) return;
    emit({ batches: state.batches, activeBatchId: batchId });
  },
  clear(): void {
    if (state.batches.length === 0 && state.activeBatchId === null) return;
    emit(EMPTY);
  },
};

/**
 * Push a batch and open (or activate) the singleton tab. The tab
 * spec itself comes from the caller so we don't pull `tab-content`
 * into this module (which would create a cycle —
 * `tab-content.tsx` already imports from this file).
 */
/**
 * Push a batch, activate it, and open (or focus) the singleton tab.
 * Always activates because this helper is the click-handler entry
 * point — the user just asked to see this batch.
 */
export const pushAndOpenSourceDiffBatch = (
  batch: SourceDiffBatch,
  spec: Parameters<typeof displayTabs.openTab>[0],
): void => {
  sourceDiffBatches.pushAndActivate(batch);
  displayTabs.openTab(spec);
};
